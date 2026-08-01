import 'dotenv/config';
import express from 'express';
import { middleware } from '@line/bot-sdk';
import { availableScheduleDates, dropoffStops, fareForJourney, getRoute, hasSchedulesOnDate, pickupStops, routesForJourney, schedulesFor } from './data.js';
import { appendPaidBooking, backendSheetConfigured, fareForBookingFromSheet } from './googleSheets.js';
import { slipAmount, slipDate, slipOkConfigured, slipReceiver, verifySlipImage } from './slipok.js';
import { bangkokDate, bangkokHour, thaiDate } from './time.js';

const required = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'];
for (const key of required) if (!process.env[key]) console.warn(`คำเตือน: ยังไม่ได้ตั้งค่า ${key}`);

const config = { channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, channelSecret: process.env.LINE_CHANNEL_SECRET };
const app = express();
const state = new Map();
const processedSlipMessageIds = new Set();
const BOOKING_OPEN_HOUR = 7;
const BOOKING_CLOSE_HOUR = 22;
app.use(express.static('public'));

const button = (label, data, displayText = label) => ({ type: 'action', action: { type: 'postback', label, data, displayText } });
const quick = (text, items) => ({ type: 'text', text, quickReply: { items } });

function chunk(items, size = 13) { return items.slice(0, size); }
function userState(userId) { return state.get(userId) ?? {}; }
function setState(userId, patch) { state.set(userId, { ...userState(userId), ...patch }); }
function closeBookingAfterHours(userId) {
  setState(userId, { afterHoursNoticeSent: true, handoffToAdmin: false, booking: null });
  return afterHoursBooking();
}
function afterHoursTestUserIds() {
  return String(process.env.LINE_TEST_USER_IDS || process.env.LINE_TEST_USER_ID || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}
function canUseAfterHours(userId) {
  return afterHoursTestUserIds().includes(userId);
}
function isTesterUser(userId) {
  return canUseAfterHours(userId);
}
function isBookingOpenFor(userId) {
  return isBookingOpen() || canUseAfterHours(userId);
}
function botEnabled() {
  return !['false', '0', 'off', 'no'].includes(String(process.env.BOT_ENABLED ?? 'true').trim().toLowerCase());
}
function handoffToAdmin(userId) {
  if (!isBookingOpenFor(userId)) return closeBookingAfterHours(userId);
  setState(userId, { handoffToAdmin: true, booking: null });
  return adminContact();
}
function unclearHandoffToAdmin(userId) {
  setState(userId, { handoffToAdmin: true, booking: null });
  return {
    type: 'text',
    text: 'ขออภัยค่ะ ระบบยังไม่เข้าใจข้อความที่พิมพ์มา 🙏\n\nเดี๋ยวให้แอดมินมาตอบต่อนะคะ\nหากต้องการให้บอทเริ่มตอบใหม่ ให้พิมพ์ว่า เริ่มใหม่ หรือ จองตั๋ว ค่ะ'
  };
}
function shouldResumeFromHandoff(text) {
  return /เริ่มใหม่|จองตั๋ว|จองตัว|เช็กรอบ|ตรวจรอบ|ดูรอบ|restart/i.test(cleanCustomerText(text));
}
function isWaitingForCustomerChoice(userId) {
  const current = userState(userId);
  if (current.booking?.step) return true;
  return ['pickup', 'dropoff', 'schedule'].includes(current.flowStep);
}
function cleanCustomerText(text) {
  return normaliseThaiDigits(String(text ?? '').toLowerCase())
    .replace(/[🙏😊😄😃🙂🥰😍❤️💯✅👌👍✨⭐️]/g, '')
    .replace(/(ค่ะ|คะ|คร้าบ|ครับ|คับ|ค้าบ|จ้า|จ๊ะ|จ๋า|ฮะ|ฮ้ะ|นะ|น้า|น่ะ|เด้อ|จ้าา|ค่ะะ|ค่า|คร่า|งับ|งับบ|ฮับ)+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function normalizePlaceText(text) {
  return cleanCustomerText(text)
    .replace(/อยาก|ต้องการ|สอบถาม|รบกวน|จอง|ซื้อตั๋ว|ตั๋ว|ขอ|ไป|ลง|ขึ้น|รถ|ที่|ตรง|จาก|ปลายทาง|ต้นทาง|รอบ|เวลา|กี่โมง/g, '')
    .replace(/นครราชสีมา|โคราข|โคราด|โคราชช/g, 'โคราช')
    .replace(/ระยองง/g, 'ระยอง')
    .replace(/ชลบรี|ชลฯ/g, 'ชลบุรี')
    .replace(/กบินทร์?บุรี|กบินฯ|กระบิน|กบิน/g, 'กบินทร์บุรี')
    .replace(/บขส\.?ชลบุรี|บขสชล/g, 'ชลบุรี')
    .replace(/ก\.?ม\.?79/g, 'กม79')
    .replace(/ก\.?ม\.?10/g, 'กม10')
    .replace(/บ่อวินน์|บ่อวินน/g, 'บ่อวิน')
    .replace(/\s+/g, '')
    .replace(/\./g, '')
    .trim();
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function normaliseThaiDigits(text) {
  const thaiDigits = { '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4', '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9' };
  return text.replace(/[๐-๙]/g, (digit) => thaiDigits[digit]);
}

function yearFromInput(value, fallback) {
  if (!value) return fallback;
  let year = Number(value);
  if (year < 100) year += 2000;
  if (year > 2400) year -= 543;
  return year;
}

function dateFromDay(day, text) {
  const today = bangkokDate();
  const [currentYear, currentMonth, currentDay] = today.split('-').map(Number);
  const wantsNextMonth = /เดือนหน้า|เดือนถัดไป|เดือนหน้าเลย/.test(text);
  const month = wantsNextMonth || day < currentDay ? currentMonth + 1 : currentMonth;
  const year = month <= 12 ? currentYear : currentYear + 1;
  return isoDate(year, month <= 12 ? month : 1, day);
}

function relativeDate(days) {
  const date = new Date(`${bangkokDate()}T12:00:00+07:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseTypedTime(text) {
  const value = cleanCustomerText(text);
  const format = (hour, minute = '00') => {
    const h = Number(hour);
    const m = Number(minute);
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };
  let match = value.match(/(\d{1,2})\s*[:.]\s*(\d{2})/);
  if (match) return format(match[1], match[2]);
  match = value.match(/(\d{1,2})\s*โมง\s*(\d{1,2})?/);
  if (match) return format(match[1], match[2] ?? '00');
  if (/วันที่|วันที|วันทึ่/.test(value)) return null;
  match = value.match(/(?:รอบ|เวลา)?\s*(\d{1,2})(?:\s*น\.?)?$/);
  if (match) return format(match[1]);
  return null;
}

function parseTypedDate(text) {
  const value = cleanCustomerText(text);
  const today = bangkokDate();
  const [currentYear] = today.split('-').map(Number);

  if (/(^|[^ก-ฮa-z0-9])(วันนี้|วันนี่|วนนี่)(?=$|[^ก-ฮa-z0-9])/.test(value)) return relativeDate(0);
  if (/(^|[^ก-ฮa-z0-9])(พรุ่งนี้|พรุ้งนี้|พน\.?|พรุ่งนี้เช้า|พรุ่งนี้บ่าย|พรุ่งนี้เย็น)(?=$|[^ก-ฮa-z0-9])/.test(value)) return relativeDate(1);
  if (/(^|[^ก-ฮa-z0-9])(มะรืน|มะรืนนี้|มรืน)(?=$|[^ก-ฮa-z0-9])/.test(value)) return relativeDate(2);

  let match = value.match(/(\d{4})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})/);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = value.match(/(\d{1,2})\s*[/-]\s*(\d{1,2})(?:\s*[/-]\s*(\d{2,4}))?/);
  if (match) {
    const year = yearFromInput(match[3], currentYear);
    return isoDate(year, Number(match[2]), Number(match[1]));
  }

  const months = [
    ['มกราคม', 'ม.ค.', 'มค', 'jan'], ['กุมภาพันธ์', 'ก.พ.', 'กพ', 'feb'],
    ['มีนาคม', 'มี.ค.', 'มีค', 'mar'], ['เมษายน', 'เม.ย.', 'เมย', 'apr'],
    ['พฤษภาคม', 'พ.ค.', 'พค', 'may'], ['มิถุนายน', 'มิ.ย.', 'มิย', 'jun'],
    ['กรกฎาคม', 'ก.ค.', 'กค', 'jul'], ['สิงหาคม', 'ส.ค.', 'สค', 'aug'],
    ['กันยายน', 'ก.ย.', 'กย', 'sep'], ['ตุลาคม', 'ต.ค.', 'ตค', 'oct'],
    ['พฤศจิกายน', 'พ.ย.', 'พย', 'nov'], ['ธันวาคม', 'ธ.ค.', 'ธค', 'dec']
  ];
  for (const [index, names] of months.entries()) {
    if (names.some((name) => value.includes(name))) {
      match = value.match(/(?:วันที่|วันที|วัน)?\s*(\d{1,2})/);
      if (match) return isoDate(currentYear, index + 1, Number(match[1]));
    }
  }

  match = value.match(/(?:วันที่|วันที|วันเดินทาง|เดินทางวันที่|ไปวันที่|จองวันที่)\s*(\d{1,2})/);
  if (match) return dateFromDay(Number(match[1]), value);

  match = value.match(/^(\d{1,2})$/);
  if (match) return dateFromDay(Number(match[1]), value);

  match = value.match(/(?:^|[^\dA-Za-zก-ฮ])(\d{1,2})(?:$|[^\dA-Za-zก-ฮ])/);
  if (match) {
    const day = Number(match[1]);
    return dateFromDay(day, value);
  }

  return null;
}

function isInBookingWindow(date, days = 7) {
  return date >= bangkokDate() && date <= bangkokDate(days - 1);
}

function sourceIdMessage(event, text) {
  const value = text.trim();
  if (value === 'ขอไอดีกลุ่ม') {
    if (event.source.type !== 'group') {
      return { type: 'text', text: 'คำสั่งนี้ต้องพิมพ์ในกลุ่ม LINE ที่มีบอทอยู่ค่ะ' };
    }
    return { type: 'text', text: `groupId ของกลุ่มนี้:\n${event.source.groupId}` };
  }
  if (value === 'ขอไอดีแอดมิน') {
    return { type: 'text', text: `userId ของแชทนี้:\n${event.source.userId}` };
  }
  return null;
}

async function testerCommandMessage(event, text) {
  const userId = event.source.userId;
  if (!userId || !isTesterUser(userId)) return null;
  const value = cleanCustomerText(text);

  if (['คำสั่งเทส', 'คำสั่งทดสอบ', 'tester', '/test', 'เทสเตอร์'].includes(value)) {
    return {
      type: 'text',
      text: `🧪 คำสั่งสำหรับ Tester

พิมพ์ได้เฉพาะบัญชีที่อยู่ใน LINE_TEST_USER_IDS เท่านั้น

• คำสั่งเทส = ดูคำสั่งทั้งหมด
• สถานะเทส = ดูสถานะบอทและสถานะแชทนี้
• รีเซ็ตเทส = ล้างสถานะแชท แล้วเริ่มใหม่
• เริ่มเทส = เปิดข้อความต้อนรับใหม่
• กลับบอท = ให้บอทกลับมาตอบ หลังจากส่งต่อแอดมิน
• ขอไอดีกลุ่ม = ดู groupId ในกลุ่ม
• ขอไอดีแอดมิน = ดู userId ของแชทนี้`
    };
  }

  if (['สถานะเทส', 'สถานะทดสอบ', '/state'].includes(value)) {
    const current = userState(userId);
    return {
      type: 'text',
      text: `🧪 สถานะระบบทดสอบ

BOT_ENABLED: ${botEnabled() ? 'true' : 'false'}
เวลาจองปกติเปิดอยู่: ${isBookingOpen() ? 'ใช่' : 'ไม่ใช่'}
Tester ข้ามเวลาได้: ${canUseAfterHours(userId) ? 'ใช่' : 'ไม่ใช่'}
SIMULATE_SLIP_OK: ${String(process.env.SIMULATE_SLIP_OK ?? 'false')}
SAVE_SLIP_TO_DRIVE: ${String(process.env.SAVE_SLIP_TO_DRIVE ?? 'false')}
Google Sheet: ${backendSheetConfigured() ? 'เชื่อมแล้ว' : 'ยังไม่เชื่อม'}

สถานะแชทนี้:
${JSON.stringify(current, null, 2).slice(0, 1200) || '{}'}`
    };
  }

  if (['รีเซ็ตเทส', 'ล้างสถานะ', 'reset', '/reset'].includes(value)) {
    state.set(userId, {});
    return {
      type: 'text',
      text: 'รีเซ็ตสถานะเทสของแชทนี้แล้วค่ะ ✅\n\nพิมพ์ เริ่มเทส หรือ จองตั๋ว เพื่อเริ่มใหม่ได้เลยค่ะ'
    };
  }

  if (['เริ่มเทส', 'เริ่มทดสอบ', '/start'].includes(value)) {
    return start(userId);
  }

  if (['กลับบอท', 'ให้บอทตอบ', 'บอทตอบต่อ'].includes(value)) {
    setState(userId, { handoffToAdmin: false });
    return {
      type: 'text',
      text: 'เปิดให้บอทกลับมาตอบแชทนี้แล้วค่ะ ✅\n\nพิมพ์ จองตั๋ว หรือ เช็กรอบรถ เพื่อเริ่มต่อได้เลยค่ะ'
    };
  }

  return null;
}

async function selectedTripBooking(userId) {
  const { date, pickupId, dropoffId, selectedRouteId, selectedDepartureTime } = userState(userId);
  if (!date || !pickupId || !dropoffId || !selectedRouteId || !selectedDepartureTime) return null;

  const route = await getRoute(selectedRouteId);
  const schedule = (await schedulesFor(selectedRouteId, date)).find((item) => item.departureTime === selectedDepartureTime);
  const pickup = route?.stops.find((stop) => stop.id === pickupId);
  const dropoff = route?.stops.find((stop) => stop.id === dropoffId);
  if (!route || !schedule || !pickup || !dropoff) return null;

  return {
    step: 'pickupSpecial',
    date,
    originProvince: route.origin,
    destinationProvince: dropoff.name,
    departureTime: selectedDepartureTime,
    pickupPoint: pickup.name,
    dropoffPoint: dropoff.name,
    routeId: selectedRouteId,
    pickupId,
    dropoffId,
    busNumber: schedule.busNumber || '',
    driverPhone: schedule.driverPhone || ''
  };
}

async function askBookingDate(userId) {
  if (!isBookingOpenFor(userId)) {
    return closeBookingAfterHours(userId);
  }

  const selectedBooking = await selectedTripBooking(userId);
  if (selectedBooking) {
    setState(userId, { booking: selectedBooking });
    return {
      type: 'text',
      text: '📌 กรุณาแจ้งจุดขึ้นพิเศษค่ะ\n\nพิมพ์ได้ เช่น หน้าบิ๊กซี, สะพานลอย, จุดนัดรับใกล้เคียง\nถ้าขึ้นที่จุดหลัก ให้พิมพ์ - หรือ บขส ได้เลยค่ะ'
    };
  }

  const { date } = userState(userId);
  if (date) {
    setState(userId, { booking: { step: 'originProvince', date } });
    return { type: 'text', text: `📅 ใช้วันที่ ${thaiDate(date)} ค่ะ\n\n🚍 เดินทางจากจังหวัดไหนคะ\nพิมพ์ได้ เช่น โคราช, ระยอง, ชลบุรี` };
  }
  setState(userId, { booking: { step: 'date' } });
  return quick('📅 เดินทางวันที่เท่าไหร่คะ\n\n🔴 ตัวอย่างการพิมพ์: 2 หรือ 2/8 หรือ วันที่ 2\n👇 กดเลขวันที่ด้านล่างได้เลยค่ะ\n\nกรุณาเลือกเฉพาะวันที่ระบบมีรอบรถค่ะ', [
    ...await dateButtons(),
    button('ติดต่อแอดมิน', 'action=contact_admin')
  ]);
}

function bookingAsk(text) {
  return { type: 'text', text };
}

function parseSeats(text) {
  const value = cleanCustomerText(text);
  const match = value.match(/\d+/);
  if (match) return Number(match[0]);
  const wordNumbers = [
    ['หนึ่ง', 1], ['นึง', 1], ['คนเดียว', 1],
    ['สอง', 2], ['สาม', 3], ['สี่', 4], ['ห้า', 5],
    ['หก', 6], ['เจ็ด', 7], ['แปด', 8], ['เก้า', 9], ['สิบ', 10]
  ];
  return wordNumbers.find(([word]) => value.includes(word))?.[1] ?? null;
}

function parseContact(text) {
  const cleaned = cleanCustomerText(text);
  const phoneMatch = cleaned.match(/0[\d\s-]{8,}/);
  const phone = phoneMatch ? phoneMatch[0].replace(/\s+/g, ' ').trim() : '';
  const name = cleaned
    .replace(/ชื่อผู้จอง|ผู้จอง|ชื่อ|เบอร์โทร|เบอร์|โทร|[:：]/g, '')
    .replace(phoneMatch?.[0] ?? '', '')
    .trim();
  return { name, phone };
}

function contactPrompt() {
  return `👤 ขอชื่อผู้จองและเบอร์โทรค่ะ

พิมพ์รวมกันได้ เช่น
คุณกมลพร 094-172-4569

หรือส่งแยกก็ได้ค่ะ เช่น
คุณกมลพร
แล้วค่อยส่งเบอร์โทรในข้อความถัดไป`;
}

function normalizePickupSpecial(text, fallback) {
  const value = cleanCustomerText(text).replace(/\s+/g, '');
  if (!value || ['-', 'บขส', 'บขส.', 'ไม่มี', 'ไม่', 'จุดหลัก', 'ขึ้นจุดหลัก'].includes(value)) return fallback;
  return text.trim();
}

function moneyText(amount) {
  const value = Number(amount);
  return Number.isFinite(value) ? `${value.toLocaleString('th-TH')} บาท` : null;
}

function lockedPaymentAmount(booking) {
  const value = Number(booking?.totalAmount ?? booking?.amount);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function testPricePerSeat() {
  const value = Number(process.env.BOOKING_TEST_PRICE_PER_SEAT);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function bookingTermsText() {
  return `📌 เงื่อนไขการจองตั๋วออนไลน์
จองแล้วไม่สามารถเลื่อนวันเดินทางหรือเลื่อนรอบรถได้ค่ะ
กรณีมาไม่ทันเวลานัดหมาย จะถือว่าสละสิทธิ์การเดินทาง
ทางเพจรถร่วมวิศวกรเสนาขอขอบคุณที่ใช้บริการค่ะ`;
}

async function withLockedPrice(booking) {
  let fare = null;
  try {
    fare = await fareForBookingFromSheet(booking);
  } catch (error) {
    console.error(error);
  }
  if (fare == null && booking.routeId && booking.pickupId && booking.dropoffId) {
    fare = await fareForJourney(booking.routeId, booking.pickupId, booking.dropoffId);
  }
  const pricePerSeat = fare ?? testPricePerSeat();
  if (!pricePerSeat || !booking.seats) return booking;
  return { ...booking, pricePerSeat, totalAmount: pricePerSeat * booking.seats };
}

function bookingSummary(booking) {
  const lockedAmount = lockedPaymentAmount(booking);
  return `กรุณาตรวจสอบข้อมูลค่ะ

📅 วันที่: ${thaiDate(booking.date)}
🚍 ต้นทาง: ${booking.originProvince}
🏁 ปลายทาง: ${booking.destinationProvince}
⏰ รอบ: ${booking.departureTime}
📍 จุดขึ้น: ${booking.pickupPoint}
📌 จุดขึ้นพิเศษ: ${booking.pickupSpecial || '-'}
🎟️ จำนวน: ${booking.seats} ที่นั่ง
👤 ผู้จอง: ${booking.customerName}
📞 เบอร์: ${booking.phone || '-'}
💰 ยอดชำระ: ${moneyText(lockedAmount) || 'รอแอดมินยืนยัน'}

${bookingTermsText()}

${lockedAmount ? 'กรุณาโอนตามยอดนี้เท่านั้น แล้วส่งสลิปในแชทนี้ค่ะ' : 'หากถูกต้อง กรุณาโอนเงินแล้วส่งสลิปในแชทนี้ค่ะ'}`;
}

function adminBookingText(booking, paidText = '') {
  return `✅ ชำระเงินสำเร็จ / รอออกตั๋ว

📅 วันที่: ${thaiDate(booking.date)}
🚍 จังหวัดต้นทาง: ${booking.originProvince}
🏁 จังหวัดปลายทาง: ${booking.destinationProvince}
⏰ เวลา: ${booking.departureTime}
📍 จุดขึ้น: ${booking.pickupPoint}
📌 จุดขึ้นพิเศษ: ${booking.pickupSpecial || '-'}

👤 ผู้จอง: ${booking.customerName}
📞 เบอร์โทร: ${booking.phone || '-'}

🚌 เบอร์รถ: ${booking.busNumber || 'รอแจ้ง'}
🎟️ จำนวนที่นั่ง: ${booking.seats} ที่นั่ง
💰 ยอดโอนเงิน: ${paidText || 'ตรวจผ่าน SlipOK'}

☎️ เบอร์คนขับ: ${booking.driverPhone || 'รอแจ้ง'}
☎️ เบอร์แอดมิน: 092-774-4341

โอนบัญชีเพจรถร่วมวิศวกรเสนา`;
}

function customerTicketText(booking, paidText = '') {
  return `🎫 ตั๋วโดยสาร

📅 วันที่: ${thaiDate(booking.date)}
📍 จุดขึ้น: ${booking.pickupSpecial || booking.pickupPoint}
⏰ เวลา: ${booking.departureTime}
🏁 จุดลง: ${booking.dropoffPoint || booking.destinationProvince}

👤 ผู้จอง: ${booking.customerName}
📞 เบอร์โทร: ${booking.phone || '-'}
🚌 เบอร์รถ: ${booking.busNumber || 'รอแจ้ง'}
🎟️ จำนวนที่นั่ง: ${booking.seats} ที่นั่ง
💰 ชำระเงิน: ${paidText || moneyText(lockedPaymentAmount(booking)) || 'ตรวจผ่าน SlipOK'}

☎️ เบอร์คนขับ: ${booking.driverPhone || 'รอแจ้ง'}
☎️ เบอร์แอดมิน: 092-774-4341

โอนบัญชีเพจรถร่วมวิศวกรเสนา`;
}

async function handleBookingText(userId, text) {
  const current = userState(userId).booking;
  if (!current?.step) return null;

  if (!isBookingOpenFor(userId)) {
    return closeBookingAfterHours(userId);
  }

  const value = cleanCustomerText(text);
  if (['ยกเลิก', 'เริ่มใหม่', 'cancel'].includes(value.toLowerCase())) {
    setState(userId, { booking: null });
    return { type: 'text', text: 'ยกเลิกการจองแล้วค่ะ หากต้องการเริ่มใหม่พิมพ์ว่า จองตั๋ว ได้เลยค่ะ' };
  }

  if (current.step === 'date') {
    const date = parseTypedDate(value);
    if (!date) return unclearHandoffToAdmin(userId);
    setState(userId, { booking: { ...current, step: 'originProvince', date } });
    return bookingAsk('🚍 เดินทางจากจังหวัดไหนคะ\nพิมพ์ได้ เช่น โคราช, ระยอง, ชลบุรี');
  }

  if (current.step === 'originProvince') {
    setState(userId, { booking: { ...current, step: 'destinationProvince', originProvince: value || text.trim() } });
    return bookingAsk('🏁 ต้องการไปลงจังหวัดไหนคะ\nพิมพ์ได้ เช่น โคราช, ระยอง, ชลบุรี');
  }

  if (current.step === 'destinationProvince') {
    setState(userId, { booking: { ...current, step: 'departureTime', destinationProvince: value || text.trim() } });
    return bookingAsk('⏰ ต้องการรอบกี่โมงคะ\nพิมพ์ได้ เช่น 06:00, 7:30, ระยอง 06:00');
  }

  if (current.step === 'departureTime') {
    setState(userId, { booking: { ...current, step: 'pickupPoint', departureTime: value || text.trim() } });
    return bookingAsk('📍 ขึ้นรถตรงจุดไหนคะ\nพิมพ์ชื่อจุดขึ้นได้เลย เช่น โคราช, ระยอง, กบินทร์บุรี');
  }

  if (current.step === 'pickupPoint') {
    setState(userId, { booking: { ...current, step: 'seats', pickupPoint: value || text.trim() } });
    return bookingAsk('🎟️ จองกี่ที่นั่งคะ\nพิมพ์ได้ เช่น 1, 2 คน, 1 ที่นั่ง');
  }

  if (current.step === 'pickupSpecial') {
    setState(userId, { booking: { ...current, step: 'seats', pickupSpecial: normalizePickupSpecial(text, current.pickupPoint) } });
    return bookingAsk('🎟️ จองกี่ที่นั่งคะ\nพิมพ์ได้ เช่น 1, 2 คน, 1 ที่นั่ง');
  }

  if (current.step === 'seats') {
    const seats = parseSeats(value);
    if (!seats) return bookingAsk('🎟️ ขอจำนวนที่นั่งอีกครั้งค่ะ\nพิมพ์ได้ เช่น 1, 2 คน, 1 ที่นั่ง');
    setState(userId, { booking: await withLockedPrice({ ...current, step: 'contact', seats }) });
    return bookingAsk(contactPrompt());
  }

  if (current.step === 'contact') {
    const contact = parseContact(value);
    const customerName = contact.name || current.customerName || '';
    const phone = contact.phone || current.phone || '';
    if (!customerName || !phone) {
      setState(userId, { booking: { ...current, step: 'contact', customerName, phone } });
      if (!customerName) return bookingAsk('👤 ขอชื่อผู้จองค่ะ เช่น คุณกมลพร');
      return bookingAsk('📞 ขอเบอร์โทรผู้จองค่ะ เช่น 094-172-4569');
    }
    const booking = await withLockedPrice({ ...current, step: 'awaiting_slip', customerName, phone });
    setState(userId, { booking });
    const summary = { type: 'text', text: bookingSummary(booking) };
    return withPaymentQr(summary);
  }

  return null;
}

async function dateMessage(userId, text) {
  const booking = await handleBookingText(userId, text);
  if (booking) return booking;
  const typedSchedule = await typedScheduleChoice(userId, text);
  if (typedSchedule) return typedSchedule;
  const typedChoice = await typedStopChoice(userId, text);
  if (typedChoice) return typedChoice;
  if (/เริ่มใหม่|restart|เช็กรอบ|ตรวจรอบ|ดูรอบ/.test(cleanCustomerText(text))) return start(userId);
  if (/จอง|ซื้อตั๋ว/.test(text)) return bookingModePrompt();
  if (/จองล่วงหน้า|เดือนหน้า|เดือนถัดไป|เทศกาล|ติดต่อแอดมิน|หาแอดมิน|โทร/.test(text)) return handoffToAdmin(userId);
  const date = parseTypedDate(text);
  if (!date) {
    if (isWaitingForCustomerChoice(userId)) return unclearHandoffToAdmin(userId);
    return unclearDateMessage();
  }
  if (await hasSchedulesOnDate(date) || (!backendSheetConfigured() && isInBookingWindow(date))) {
    setState(userId, { date, flowStep: 'pickup' });
    return pickupChoices(userId);
  }
  return bookingContact(userId);
}

async function inferJourneyFromText(userId, text) {
  const current = userState(userId);
  const date = parseTypedDate(text) ?? current.date;
  const pickupStopsList = await pickupStops();
  const directedPickup = await directionalStop(pickupStopsList, text, 'pickup');
  const pickupCandidates = extractStopMentions(await pickupStops(), text);
  let pickup = current.pickupId
    ? (await pickupStops()).find((stop) => stop.id === current.pickupId)
    : directedPickup ?? pickupCandidates[0];
  if (!pickup && current.pendingPickupId) {
    pickup = (await pickupStops()).find((stop) => stop.id === current.pendingPickupId);
  }

  if (!date || !pickup) return null;

  const dropoffStopsList = await dropoffStops(pickup.id);
  const directedDropoff = await directionalStop(dropoffStopsList, text, 'dropoff');
  const dropoffCandidates = extractStopMentions(dropoffStopsList, text)
    .filter((stop) => stop.id !== pickup.id);
  const dropoff = current.dropoffId
    ? dropoffStopsList.find((stop) => stop.id === current.dropoffId)
    : directedDropoff ?? dropoffCandidates[0];

  if (dropoff && (await hasSchedulesOnDate(date) || (!backendSheetConfigured() && isInBookingWindow(date)))) {
    setState(userId, { date, pickupId: pickup.id, dropoffId: dropoff.id, pendingPickupId: null, flowStep: 'schedule' });
    return scheduleChoices(userId);
  }

  if (!current.date && pickupCandidates.length) {
    setState(userId, { date, pickupId: pickup.id, pendingPickupId: null, flowStep: 'dropoff' });
    return dropoffChoices(userId);
  }

  return null;
}

async function typedScheduleChoice(userId, text) {
  const current = userState(userId);
  if (!current.date || !current.pickupId || !current.dropoffId || current.flowStep !== 'schedule') return null;
  const typedTime = parseTypedTime(text);
  if (!typedTime) {
    const value = cleanCustomerText(text);
    if (/รอบ|กี่โมง|มี.*บ้าง|มี.*ไหม|มี.*มั้ย|เช้า|บ่าย|เย็น/.test(value)) {
      return scheduleChoices(userId, 'ระบบยังต้องให้เลือกรอบเป็นเวลาแน่นอนค่ะ\nกรุณาเลือกรอบจากรายการด้านล่าง หรือพิมพ์ตามตัวอย่างได้เลยค่ะ\n\n');
    }
    return null;
  }
  const routes = await routesForJourney(current.pickupId, current.dropoffId);
  for (const route of routes) {
    const schedules = await schedulesFor(route.id, current.date);
    const schedule = schedules.find((item) => item.departureTime === typedTime);
    if (schedule) {
      setState(userId, { flowStep: 'result' });
      return result(userId, route.id, schedule.departureTime);
    }
  }
  return scheduleChoices(userId, `ไม่พบรอบ ${typedTime} น. สำหรับเส้นทางนี้ค่ะ\nกรุณาเลือกรอบจากรายการด้านล่าง หรือพิมพ์เวลาใหม่อีกครั้งค่ะ\n\n`);
}

async function typedStopChoice(userId, text) {
  const current = userState(userId);
  if (current.date && (!current.pickupId || current.flowStep === 'pickup')) {
    const pickup = await matchStop(await pickupStops(), text);
    if (!pickup) return null;
    setState(userId, { pickupId: pickup.id, flowStep: 'dropoff' });
    return dropoffChoices(userId);
  }
  if (current.date && current.pickupId && (!current.dropoffId || current.flowStep === 'dropoff')) {
    const dropoff = await matchStop(await dropoffStops(current.pickupId), text);
    if (!dropoff) return null;
    setState(userId, { dropoffId: dropoff.id, flowStep: 'schedule' });
    return scheduleChoices(userId);
  }
  return null;
}

async function matchStop(stops, text) {
  const matches = extractStopMentions(stops, text);
  return matches.length === 1 ? matches[0] : null;
}

async function directionalStop(stops, text, mode) {
  const value = cleanCustomerText(text);
  const pattern = mode === 'pickup'
    ? /(?:จาก|ขึ้น|ต้นทาง)\s*([^,，\n]+?)(?=ไป|ลง|ปลายทาง|$)/
    : /(?:ไป|ลง|ปลายทาง)\s*([^,，\n]+?)(?=จาก|ขึ้น|ต้นทาง|$)/;
  const match = value.match(pattern);
  if (!match) return null;
  return matchStop(stops, match[1]);
}

function extractStopMentions(stops, text) {
  const value = normalizePlaceText(text);
  if (!value) return [];
  const scored = [];
  for (const stop of stops) {
    const name = normalizePlaceText(stop.name);
    if (!name) continue;
    if (value === name) {
      scored.push({ stop, index: 0, score: 1000 + name.length });
      continue;
    }
    const index = value.indexOf(name);
    if (index >= 0) {
      scored.push({ stop, index, score: 800 + name.length });
      continue;
    }
    if (name.includes(value) && value.length >= 3) {
      scored.push({ stop, index: 0, score: 500 + value.length });
      continue;
    }
    if (value.length >= 3 && name.length >= 3 && editDistance(value, name) <= 1) {
      scored.push({ stop, index: 0, score: 350 });
    }
  }
  const seen = new Set();
  return scored
    .sort((a, b) => a.index - b.index || b.score - a.score)
    .filter(({ stop }) => {
      if (seen.has(stop.id)) return false;
      seen.add(stop.id);
      return true;
    })
    .map(({ stop }) => stop);
}

async function unclearDateMessage() {
  const dates = await availableScheduleDates();
  const dateList = dates.length
    ? dates.map((date) => thaiDate(date)).join('\n')
    : 'ตอนนี้ยังไม่มีวันที่เปิดให้จองในระบบค่ะ';
  return quick(`🤖 นี่คือระบบตอบข้อความอัตโนมัตินะคะ

📅 ตอนนี้ระบบสามารถจองได้เฉพาะวันที่มีข้อมูลรอบรถในระบบเท่านั้นค่ะ

วันที่ที่จองได้ตอนนี้:
${dateList}

🔴 ตัวอย่างการพิมพ์: 2 หรือ 2/8 หรือ วันที่ 2
👇 กดเลขวันที่ด้านล่างได้เลยค่ะ

ℹ️ หากไม่มีวันที่ผู้โดยสารต้องการ กรุณากด ติดต่อแอดมิน ค่ะ`, [
    ...await dateButtons(),
    button('ติดต่อแอดมิน', 'action=contact_admin')
  ]);
}

async function dateButtons() {
  const dates = await availableScheduleDates();
  return dates.map((date) => {
    const day = String(Number(date.slice(8, 10)));
    return button(day, `action=date&value=${date}`, day);
  });
}

function bookingModePrompt() {
  return quick(`ต้องการจองแบบไหนคะ 🎫

🤖 จองตั๋วอัตโนมัติ
ระบบจะพาเลือกวันที่ จุดขึ้น จุดลง รอบรถ และชำระเงินในแชทนี้ค่ะ

👤 จองกับแอดมิน
แอดมินจะเข้ามาดูแลและตอบในแชทนี้ค่ะ`, [
    button('จองอัตโนมัติ', 'action=auto_booking'),
    button('จองกับแอดมิน', 'action=contact_admin')
  ]);
}

async function start(userId) {
  state.set(userId, {});
  return [
    {
      type: 'text',
      text: 'สวัสดีค่ะ ยินดีต้อนรับสู่บัญชีทางการของรถร่วมวิศวกรเสนา\n\nระบบนี้เป็นระบบอัตโนมัติสำหรับตรวจสอบรอบรถโดยสาร สาย 267 โคราช-ระยอง และสาย 265 โคราช-ชลบุรี\n\nสามารถตรวจสอบเวลารถถึงจุดขึ้นและจุดลงโดยประมาณได้จากเมนูด้านล่าง\n\nหากต้องการจองที่นั่ง สอบถามเพิ่มเติม หรือให้แอดมินดูแลจนได้เดินทาง กรุณาทักแชทแอดมิน หรือโทร 092-774-4341\n\nเปิดรับจองและตอบแชทเวลา 07.00-21.00 น.\n\nกรณีทักไลน์ตอบล่าช้า\nสามารถโทรได้ที่👇\n☎️092-774-4341🥰'
    },
    bookingModePrompt()
  ];
}

function adminContact() {
  return {
    type: 'text',
    text: 'สำหรับการจองล่วงหน้า หรือวันที่ที่อยู่นอกช่วงที่ระบบอัตโนมัติเปิดให้ตรวจสอบ\nกรุณาติดต่อแอดมินเพื่อตรวจสอบรอบรถและที่นั่งโดยตรงค่ะ\n\nทักแชทแอดมิน หรือโทร 092-774-4341\nเวลาตอบแชทและรับจอง 07.00-21.00 น.'
  };
}

function isBookingOpen() {
  const hour = bangkokHour();
  return hour >= BOOKING_OPEN_HOUR && hour < BOOKING_CLOSE_HOUR;
}

function afterHoursBooking() {
  return {
    type: 'text',
    text: 'ขณะนี้ปิดรับการจองอัตโนมัติแล้วค่ะ 🙏\n\nระบบรับจองอัตโนมัติได้ตั้งแต่เวลา 07.00-22.00 น. ของทุกวัน\nกรุณาเริ่มจองใหม่พรุ่งนี้ตอนเช้าค่ะ\n\nหากเป็นเรื่องเร่งด่วน สามารถโทร 092-774-4341 ได้ค่ะ'
  };
}

function paymentQrMessage() {
  const baseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) return null;
  const imageUrl = `${baseUrl}/payment-qr.png`;
  return {
    type: 'image',
    originalContentUrl: imageUrl,
    previewImageUrl: imageUrl
  };
}

function withPaymentQr(message) {
  const qr = paymentQrMessage();
  return qr ? [message, qr] : message;
}

function bookingContact(userId = null) {
  if (isBookingOpenFor(userId)) return withPaymentQr(adminContact());
  return userId ? closeBookingAfterHours(userId) : afterHoursBooking();
}

async function downloadLineContent(messageId) {
  const response = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
  });
  if (!response.ok) throw new Error(`LINE content download failed: ${response.status}`);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'image/jpeg'
  };
}

async function pushAdminText(text) {
  const to = process.env.ADMIN_LINE_TARGET_ID || process.env.ADMIN_LINE_GROUP_ID || process.env.ADMIN_LINE_USER_ID;
  if (!to) return;
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] })
  });
}

function slipOkErrorText(result) {
  const known = {
    1007: 'รูปนี้ไม่พบ QR Code ในสลิปค่ะ กรุณาส่งรูปสลิปใหม่อีกครั้ง',
    1008: 'QR ในรูปนี้ไม่ใช่ QR สำหรับตรวจสอบการชำระเงินค่ะ',
    1012: 'สลิปนี้เคยถูกส่งตรวจแล้วค่ะ กรุณาติดต่อแอดมินเพื่อตรวจสอบ',
    1013: 'ยอดเงินในสลิปไม่ตรงกับยอดที่ต้องชำระค่ะ',
    1014: 'บัญชีผู้รับในสลิปไม่ตรงกับบัญชีร้านค่ะ กรุณาติดต่อแอดมิน'
  };
  return known[result.code] ?? `ตรวจสลิปไม่ผ่านค่ะ กรุณาส่งสลิปใหม่ หรือติดต่อแอดมิน\nรหัส: ${result.code ?? '-'} ${result.message ?? ''}`;
}

function slipOkUnavailableText() {
  return 'ได้รับสลิปแล้วค่ะ\n\nขณะนี้ระบบตรวจเช็คเงินอัตโนมัติมีปัญหา หรือโควต้าการตรวจสลิปหมดชั่วคราว\nโปรดรอแอดมินตรวจสอบและออกตั๋วให้นะคะ';
}

function isSlipOkSystemIssue(result) {
  const message = String(result.message ?? '').toLowerCase();
  return [401, 402, 403, 429].includes(result.status)
    || result.status >= 500
    || /quota|limit|credit|balance|package|หมด|โควต|เครดิต|แพ็กเกจ/.test(message);
}

function simulateSlipOk() {
  return ['1', 'true', 'yes', 'ใช่'].includes(String(process.env.SIMULATE_SLIP_OK ?? '').trim().toLowerCase());
}

async function paidBookingReply(userId, booking, amount, notePrefix = 'ตรวจผ่าน SlipOK', options = {}) {
  const paidText = amount == null ? '' : `\nยอดชำระ: ${amount.toLocaleString('th-TH')} บาท`;
  const adminPaidText = amount == null ? 'ตรวจผ่าน SlipOK' : `${amount.toLocaleString('th-TH')} บาท`;
  const paidBooking = { ...booking, status: 'ออกตั๋วแล้ว' };
  await pushAdminText(adminBookingText(paidBooking, adminPaidText));
  try {
    const sheetResult = await appendPaidBooking({
      booking: paidBooking,
      paidAmount: amount,
      note: `${notePrefix}${amount == null ? '' : ` / ยอดชำระ ${amount.toLocaleString('th-TH')} บาท`}`,
      slipFile: options.slipFile ?? null
    });
    if (sheetResult.skipped) {
      await pushAdminText('หมายเหตุ: ยังไม่ได้บันทึกรายการลง Google Sheet เพราะยังไม่ได้ตั้งค่า Google Sheets env');
    }
  } catch (sheetError) {
    console.error(sheetError);
    await pushAdminText(`บันทึกรายการลง Google Sheet ไม่สำเร็จ\nกรุณาจดรายการนี้เองก่อนค่ะ\n${sheetError.message ?? sheetError}`);
  }
  setState(userId, { booking: { ...paidBooking, step: 'paid' } });
  return [
    {
      type: 'text',
      text: `ได้รับสลิปแล้วค่ะ\nระบบตรวจสอบสลิปเบื้องต้นผ่านแล้ว ✅${paidText}\n\nระบบออกตั๋วให้เรียบร้อยแล้วค่ะ`
    },
    {
      type: 'text',
      text: customerTicketText(paidBooking, adminPaidText)
    }
  ];
}

async function slipMessage(event) {
  const booking = userState(event.source.userId).booking;
  if (booking?.step === 'awaiting_slip' && !isBookingOpenFor(event.source.userId)) {
    return closeBookingAfterHours(event.source.userId);
  }
  if (processedSlipMessageIds.has(event.message.id)) {
    return { type: 'text', text: 'ได้รับสลิปนี้แล้วค่ะ ระบบกำลังดำเนินการจากรูปเดิมอยู่ ไม่ต้องส่งซ้ำค่ะ' };
  }
  if (booking?.step === 'paid') {
    return { type: 'text', text: 'รายการนี้ชำระเงินและออกตั๋วแล้วค่ะ หากต้องการแก้ไขกรุณาติดต่อแอดมินนะคะ' };
  }
  if (simulateSlipOk()) {
    if (booking?.step === 'awaiting_slip') {
      processedSlipMessageIds.add(event.message.id);
      return paidBookingReply(event.source.userId, booking, lockedPaymentAmount(booking), 'โหมดทดลอง: จำลองตรวจสลิปผ่าน');
    }
    await pushAdminText('มีลูกค้าส่งรูปเข้ามาในโหมดทดลองสลิป แต่ไม่พบรายการจองที่รอชำระในแชทนี้ค่ะ');
    return { type: 'text', text: 'ได้รับรูปแล้วค่ะ\n\nตอนนี้เปิดโหมดทดลองสลิปอยู่ แต่ยังไม่พบรายการจองที่รอชำระในแชทนี้ค่ะ\nกรุณาเริ่มจองตั๋วก่อนส่งสลิปนะคะ' };
  }

  if (!slipOkConfigured()) {
    return { type: 'text', text: slipOkUnavailableText() };
  }

  try {
    const file = await downloadLineContent(event.message.id);
    const lockedAmount = booking?.step === 'awaiting_slip' ? lockedPaymentAmount(booking) : null;
    const result = await verifySlipImage(file.buffer, { contentType: file.contentType, amount: lockedAmount });
    if (!result.ok) {
      if (isSlipOkSystemIssue(result)) {
        await pushAdminText(`มีลูกค้าส่งสลิป แต่ระบบตรวจเช็คเงินอัตโนมัติมีปัญหา/โควต้าอาจหมด\nกรุณาตรวจสลิปและออกตั๋วให้ลูกค้าด้วยค่ะ\nสถานะ SlipOK: ${result.status ?? '-'} ${result.code ?? '-'} ${result.message ?? ''}`);
        return { type: 'text', text: slipOkUnavailableText() };
      }
      return { type: 'text', text: slipOkErrorText(result) };
    }

    const amount = slipAmount(result.data);
    const paidText = amount == null ? '' : `\nยอดชำระ: ${amount.toLocaleString('th-TH')} บาท`;
    const receiverText = slipReceiver(result.data) ? `\nผู้รับเงิน: ${slipReceiver(result.data)}` : '';
    const dateText = slipDate(result.data) ? `\nเวลาตามสลิป: ${slipDate(result.data)}` : '';

    if (booking?.step === 'awaiting_slip') {
      processedSlipMessageIds.add(event.message.id);
      return paidBookingReply(event.source.userId, booking, amount, 'ตรวจผ่าน SlipOK', { slipFile: file });
    } else {
      await pushAdminText(`มีลูกค้าส่งสลิปและตรวจผ่าน SlipOK แล้ว\nสถานะ: รอตรวจรายการจอง/ออกตั๋ว${paidText}${receiverText}${dateText}`);
    }

    return {
      type: 'text',
      text: `ได้รับสลิปแล้วค่ะ\nระบบตรวจสอบสลิปเบื้องต้นผ่านแล้ว ✅${paidText}\n\nแอดมินจะตรวจรายการจองและออกตั๋วให้ต่อค่ะ`
    };
  } catch (error) {
    console.error(error);
    await pushAdminText(`มีลูกค้าส่งสลิป แต่ระบบตรวจเช็คเงินอัตโนมัติเกิดข้อผิดพลาด\nกรุณาตรวจสลิปและออกตั๋วให้ลูกค้าด้วยค่ะ\n${error.message ?? error}`);
    return { type: 'text', text: slipOkUnavailableText() };
  }
}

async function pickupChoices(userId, page = 0) {
  const stops = await pickupStops();
  const pageSize = 11;
  const totalPages = Math.max(1, Math.ceil(stops.length / pageSize));
  const currentPage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const start = currentPage * pageSize;
  const stopList = stops.map(({ name }) => `- ${name}`).join('\n');
  const options = stops
    .slice(start, start + pageSize)
    .map(({ id, name }) => button(name, `action=pickup&value=${id}`));
  if (currentPage > 0) options.push(button('ย้อนกลับ', `action=pickup_page&page=${currentPage - 1}`, 'ย้อนกลับ'));
  if (currentPage < totalPages - 1) options.push(button('ถัดไป', `action=pickup_page&page=${currentPage + 1}`, 'ถัดไป'));
  return quick(`เลือกจุดขึ้นรถค่ะ 🚍

🔴 ตัวอย่างการพิมพ์: โคราช หรือ ระยอง
👇 กดเลือกจุดขึ้นด้านล่างได้เลยค่ะ

ℹ️ ระบบรับจองเฉพาะการเดินทางไกลตามสายรถเท่านั้นค่ะ
⚠️ ไม่รับจองระยะใกล้ เช่น บ่อวินไประยอง

จุดขึ้นที่เลือกได้:
${stopList}`, options);
}

async function dropoffChoices(userId, page = 0) {
  const { pickupId } = userState(userId);
  const stops = await dropoffStops(pickupId);
  const pageSize = 11;
  const totalPages = Math.max(1, Math.ceil(stops.length / pageSize));
  const currentPage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const start = currentPage * pageSize;
  const stopList = stops.map(({ name }) => `- ${name}`).join('\n');
  const options = stops
    .slice(start, start + pageSize)
    .map(({ id, name }) => button(name, `action=dropoff&value=${id}`));
  if (currentPage > 0) options.push(button('ย้อนกลับ', `action=dropoff_page&page=${currentPage - 1}`, 'ย้อนกลับ'));
  if (currentPage < totalPages - 1) options.push(button('ดูปลายทางเพิ่ม', `action=dropoff_page&page=${currentPage + 1}`, 'ดูปลายทางเพิ่ม'));
  return quick(`เลือกปลายทางที่ต้องการเดินทางค่ะ 🏁

🔴 ตัวอย่างการพิมพ์: โคราช หรือ ระยอง
👇 กดเลือกจุดลงด้านล่างได้เลยค่ะ

จุดลงที่เลือกได้:
${stopList}`, options);
}

async function scheduleChoices(userId, note = '') {
  const { date, pickupId, dropoffId } = userState(userId);
  const routes = await routesForJourney(pickupId, dropoffId);
  const nested = await Promise.all(routes.map(async (route) => {
    const schedules = await schedulesFor(route.id, date);
    return schedules.map((schedule) => ({
      label: `${route.origin} ${schedule.departureTime}`,
      button: button(
        `${route.origin} ${schedule.departureTime}`,
        `action=schedule&route=${route.id}&time=${schedule.departureTime}`,
        `${route.name} รอบ ${schedule.departureTime}`
      )
    }));
  }));
  const choices = nested.flat();
  const options = choices.map((choice) => choice.button);
  if (!options.length) {
    return quick(`ขออภัยค่ะ ไม่พบรอบรถที่ตรงกับเส้นทางนี้ในวันที่ ${thaiDate(date)} 🙏

สามารถลองเช็กรอบอื่น หรือกดติดต่อแอดมินเพื่อให้ช่วยตรวจสอบเพิ่มเติมได้เลยค่ะ`, [
      button('เช็กรอบอื่น', 'action=restart'),
      button('ติดต่อแอดมิน', 'action=contact_admin')
    ]);
  }
  const scheduleList = choices.map((choice) => `- ${choice.label}`).join('\n');
  return quick(`${note}เลือกรอบรถ
วันที่ ${thaiDate(date)}

🔴 ตัวอย่างการพิมพ์: ${choices[0].label}
👇 กดเลือกรอบรถด้านล่างได้เลยค่ะ

รอบที่มีตามเงื่อนไขนี้:
${scheduleList}`, chunk(options));
}

async function result(userId, routeId, departureTime) {
  const { date, pickupId, dropoffId } = userState(userId);
  const route = await getRoute(routeId);
  if (!route) return { type: 'text', text: 'ข้อมูลไม่ครบ กรุณาเริ่มเช็กรอบรถใหม่ค่ะ' };
  const pickup = route.stops.find((stop) => stop.id === pickupId);
  const dropoff = route.stops.find((stop) => stop.id === dropoffId);
  if (!pickup || !dropoff) return { type: 'text', text: 'ข้อมูลไม่ครบ กรุณาเริ่มเช็กรอบรถใหม่ค่ะ' };
  setState(userId, { selectedRouteId: routeId, selectedDepartureTime: departureTime });
  return {
    type: 'text',
    text: `🚌 ${route.name}\n📅 ${thaiDate(date)}\n\n⏰ รอบออกจาก${route.origin}: ${departureTime} น.\n📍 จุดขึ้น: ${pickup.name}\n🏁 จุดลง: ${dropoff.name}`,
    quickReply: { items: [button('จองตั๋ว', 'action=start_booking'), button('ติดต่อแอดมิน', 'action=contact_admin'), button('เช็กรอบรถอีกครั้ง', 'action=restart')] }
  };
}

function fallbackMessage() {
  return quick(`ขออภัยค่ะ ระบบยังไม่เข้าใจข้อความที่พิมพ์มา 🙏

กรุณากด เริ่มใหม่ เพื่อเลือกข้อมูลอีกครั้ง
หรือกด ติดต่อแอดมิน หากไม่สะดวกใช้งานระบบอัตโนมัติค่ะ`, [
    button('เริ่มใหม่', 'action=restart'),
    button('ติดต่อแอดมิน', 'action=contact_admin')
  ]);
}

async function handleEvent(event) {
  if (!event.replyToken) return;
  if (!botEnabled()) return;
  const userId = event.source.userId;
  if (userState(userId).afterHoursNoticeSent && !isBookingOpenFor(userId)) return;
  if (userState(userId).afterHoursNoticeSent && isBookingOpenFor(userId)) setState(userId, { afterHoursNoticeSent: false });
  let message;
  if (!isBookingOpenFor(userId)) message = closeBookingAfterHours(userId);
  else if (event.type === 'follow') message = await start(userId);
  else if (event.type === 'message' && event.message.type === 'text') {
    message = await testerCommandMessage(event, event.message.text);
    if (!message && userState(userId).handoffToAdmin && !shouldResumeFromHandoff(event.message.text)) return;
    if (userState(userId).handoffToAdmin && shouldResumeFromHandoff(event.message.text)) {
      const value = cleanCustomerText(event.message.text);
      state.set(userId, {});
      message = /จอง/.test(value) ? bookingModePrompt() : await start(userId);
    } else if (!message) {
      message = sourceIdMessage(event, event.message.text) ?? await dateMessage(userId, event.message.text);
    }
  } else if (event.type === 'message' && event.message.type === 'image') {
    if (userState(userId).handoffToAdmin) return;
    message = await slipMessage(event);
  } else if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');
    if (action === 'restart') message = await start(userId);
    if (action === 'start_booking') message = bookingModePrompt();
    if (action === 'auto_booking') message = await askBookingDate(userId);
    if (action === 'advance_booking' || action === 'contact_admin') message = handoffToAdmin(userId);
    if (action === 'date') {
      setState(userId, { date: params.get('value'), flowStep: 'pickup' });
      message = await pickupChoices(userId);
    }
    if (action === 'pickup_page') message = await pickupChoices(userId, params.get('page'));
    if (action === 'pickup') { setState(userId, { pickupId: params.get('value'), flowStep: 'dropoff' }); message = await dropoffChoices(userId); }
    if (action === 'dropoff_page') message = await dropoffChoices(userId, params.get('page'));
    if (action === 'dropoff') { setState(userId, { dropoffId: params.get('value'), flowStep: 'schedule' }); message = await scheduleChoices(userId); }
    if (action === 'schedule') { setState(userId, { flowStep: 'result' }); message = await result(userId, params.get('route'), params.get('time')); }
  }
  if (!message) message = fallbackMessage();
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken: event.replyToken, messages: Array.isArray(message) ? message : [message] })
  });
}

app.get('/', (_req, res) => res.send('LINE Bus Time Bot is running.'));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/webhook', middleware(config), (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  Promise.all(events.map(handleEvent)).catch((error) => console.error(error));
  res.sendStatus(200);
});
app.use((error, req, res, next) => {
  if (req.path === '/webhook') {
    console.error('LINE webhook error:', error.message ?? error);
    return res.status(error.statusCode || 500).send('LINE webhook error');
  }
  return next(error);
});

app.listen(process.env.PORT || 3000, () => console.log(`Bot ready on port ${process.env.PORT || 3000}`));
