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
app.use(express.static('public'));

const button = (label, data, displayText = label) => ({ type: 'action', action: { type: 'postback', label, data, displayText } });
const quick = (text, items) => ({ type: 'text', text, quickReply: { items } });

function chunk(items, size = 13) { return items.slice(0, size); }
function userState(userId) { return state.get(userId) ?? {}; }
function setState(userId, patch) { state.set(userId, { ...userState(userId), ...patch }); }

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

function parseTypedDate(text) {
  const value = normaliseThaiDigits(text).trim().toLowerCase();
  const today = bangkokDate();
  const [currentYear] = today.split('-').map(Number);

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

  match = value.match(/^(\d{1,2})\s*(?:ค่ะ|คะ|ครับ|จ้า|จ๊ะ|นะ|น้า)$/);
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

async function selectedTripBooking(userId) {
  const { date, pickupId, dropoffId, selectedRouteId, selectedDepartureTime } = userState(userId);
  if (!date || !pickupId || !dropoffId || !selectedRouteId || !selectedDepartureTime) return null;

  const route = await getRoute(selectedRouteId);
  const pickup = route?.stops.find((stop) => stop.id === pickupId);
  const dropoff = route?.stops.find((stop) => stop.id === dropoffId);
  if (!route || !pickup || !dropoff) return null;

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
    dropoffId
  };
}

async function askBookingDate(userId) {
  const selectedBooking = await selectedTripBooking(userId);
  if (selectedBooking) {
    setState(userId, { booking: selectedBooking });
    return {
      type: 'text',
      text: `📅 ใช้วันที่ ${thaiDate(selectedBooking.date)} ค่ะ\n🚍 เส้นทาง: ${selectedBooking.originProvince} ไป ${selectedBooking.destinationProvince}\n⏰ รอบ: ${selectedBooking.departureTime} น.\n📍 จุดขึ้นหลัก: ${selectedBooking.pickupPoint}\n\n📌 ขอจุดขึ้นพิเศษหน่อยค่ะ เช่น หน้าบิ๊กซี / สะพานลอย / จุดนัดรับใกล้เคียง`
    };
  }

  const { date } = userState(userId);
  if (date) {
    setState(userId, { booking: { step: 'originProvince', date } });
    return { type: 'text', text: `📅 ใช้วันที่ ${thaiDate(date)} ค่ะ\n\n🚍 เดินทางจากจังหวัดไหนคะ` };
  }
  setState(userId, { booking: { step: 'date' } });
  return quick('📅 เดินทางวันที่เท่าไหร่คะ\nกรุณากดเลือกเฉพาะวันที่ระบบมีรอบรถค่ะ', [
    ...await dateButtons(),
    button('จองล่วงหน้า', 'action=advance_booking'),
    button('ติดต่อแอดมิน', 'action=contact_admin')
  ]);
}

function bookingAsk(text) {
  return { type: 'text', text };
}

function parseSeats(text) {
  const match = normaliseThaiDigits(text).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function parseContact(text) {
  const phoneMatch = normaliseThaiDigits(text).match(/0[\d\s-]{8,}/);
  const phone = phoneMatch ? phoneMatch[0].replace(/\s+/g, ' ').trim() : '';
  const name = text
    .replace(/ชื่อผู้จอง|ผู้จอง|ชื่อ|เบอร์โทร|เบอร์|โทร|[:：]/g, '')
    .replace(phoneMatch?.[0] ?? '', '')
    .trim();
  return { name: name || text.trim(), phone };
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

🚌 เบอร์รถ: รอแจ้ง
🎟️ จำนวนที่นั่ง: ${booking.seats} ที่นั่ง
💰 ยอดโอนเงิน: ${paidText || 'ตรวจผ่าน SlipOK'}

☎️ เบอร์คนขับ: รอแจ้ง
☎️ เบอร์แอดมิน: 092-774-4341

โอนบัญชีเพจรถร่วมวิศวกรเสนา`;
}

async function handleBookingText(userId, text) {
  const current = userState(userId).booking;
  if (!current?.step) return null;

  const value = text.trim();
  if (['ยกเลิก', 'เริ่มใหม่', 'cancel'].includes(value.toLowerCase())) {
    setState(userId, { booking: null });
    return { type: 'text', text: 'ยกเลิกการจองแล้วค่ะ หากต้องการเริ่มใหม่พิมพ์ว่า จองตั๋ว ได้เลยค่ะ' };
  }

  if (current.step === 'date') {
    const date = parseTypedDate(value);
    if (!date) return bookingAsk('📅 ขอวันที่เดินทางอีกครั้งค่ะ เช่น 25 หรือ 25/07/69');
    setState(userId, { booking: { ...current, step: 'originProvince', date } });
    return bookingAsk('🚍 เดินทางจากจังหวัดไหนคะ');
  }

  if (current.step === 'originProvince') {
    setState(userId, { booking: { ...current, step: 'destinationProvince', originProvince: value } });
    return bookingAsk('🏁 ต้องการไปลงจังหวัดไหนคะ');
  }

  if (current.step === 'destinationProvince') {
    setState(userId, { booking: { ...current, step: 'departureTime', destinationProvince: value } });
    return bookingAsk('⏰ ต้องการรอบกี่โมงคะ');
  }

  if (current.step === 'departureTime') {
    setState(userId, { booking: { ...current, step: 'pickupPoint', departureTime: value } });
    return bookingAsk('📍 ขึ้นรถตรงจุดไหนคะ');
  }

  if (current.step === 'pickupPoint') {
    setState(userId, { booking: { ...current, step: 'seats', pickupPoint: value } });
    return bookingAsk('🎟️ จองกี่ที่นั่งคะ');
  }

  if (current.step === 'pickupSpecial') {
    setState(userId, { booking: { ...current, step: 'seats', pickupSpecial: value } });
    return bookingAsk('🎟️ จองกี่ที่นั่งคะ');
  }

  if (current.step === 'seats') {
    const seats = parseSeats(value);
    if (!seats) return bookingAsk('🎟️ ขอจำนวนที่นั่งเป็นตัวเลขค่ะ เช่น 1 หรือ 2');
    setState(userId, { booking: await withLockedPrice({ ...current, step: 'contact', seats }) });
    return bookingAsk('👤 ขอชื่อผู้จองและเบอร์โทรค่ะ');
  }

  if (current.step === 'contact') {
    const contact = parseContact(value);
    const booking = await withLockedPrice({ ...current, step: 'awaiting_slip', customerName: contact.name, phone: contact.phone });
    setState(userId, { booking });
    const summary = { type: 'text', text: bookingSummary(booking) };
    return withPaymentQr(summary);
  }

  return null;
}

async function dateMessage(userId, text) {
  const booking = await handleBookingText(userId, text);
  if (booking) return booking;
  if (/จอง|ซื้อตั๋ว/.test(text)) return askBookingDate(userId);
  if (/จองล่วงหน้า|เดือนหน้า|เดือนถัดไป|เทศกาล|ติดต่อแอดมิน|หาแอดมิน|โทร/.test(text)) return bookingContact();
  const date = parseTypedDate(text);
  if (!date) return unclearDateMessage();
  if (await hasSchedulesOnDate(date) || (!backendSheetConfigured() && isInBookingWindow(date))) {
    setState(userId, { date });
    return pickupChoices(userId);
  }
  return bookingContact();
}

async function unclearDateMessage() {
  return quick('ขออภัยค่ะ ระบบยังอ่านวันที่เดินทางไม่ชัดเจน\n\nกรุณากดเลือกเลขวันที่ด้านล่าง หรือพิมพ์เป็นตัวอย่างเช่น 28, 28/7, วันที่ 28 ค่ะ', [
    ...await dateButtons(),
    button('จองล่วงหน้า', 'action=advance_booking'),
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

async function start(userId) {
  state.set(userId, {});
  const buttons = await dateButtons();
  return [
    {
      type: 'text',
      text: 'สวัสดีค่ะ ยินดีต้อนรับสู่บัญชีทางการของรถร่วมวิศวกรเสนา\n\nระบบนี้เป็นระบบอัตโนมัติสำหรับตรวจสอบรอบรถโดยสาร สาย 267 โคราช-ระยอง และสาย 265 โคราช-ชลบุรี\n\nสามารถตรวจสอบเวลารถถึงจุดขึ้นและจุดลงโดยประมาณได้จากเมนูด้านล่าง\n\nหากต้องการจองที่นั่ง สอบถามเพิ่มเติม หรือให้แอดมินดูแลจนได้เดินทาง กรุณาทักแชทแอดมิน หรือโทร 092-774-4341\n\nเปิดรับจองและตอบแชทเวลา 07.00-21.00 น.\n\nกรณีทักไลน์ตอบล่าช้า\nสามารถโทรได้ที่👇\n☎️092-774-4341🥰'
    },
    quick('📅 กรุณากดเลือก หรือพิมพ์วันที่เดินทางได้เลยค่ะ\n\nหากต้องการจองช่วงเทศกาล หรือจองล่วงหน้าเดือนถัดไป\nสามารถกดปุ่ม "จองล่วงหน้า" หรือ "ติดต่อแอดมิน" ได้เลยค่ะ 😊', [
      ...buttons,
      button('จองล่วงหน้า', 'action=advance_booking'),
      button('ติดต่อแอดมิน', 'action=contact_admin')
    ])
  ];
}

function adminContact() {
  return {
    type: 'text',
    text: 'สำหรับการจองล่วงหน้า หรือวันที่ที่อยู่นอกช่วงที่ระบบอัตโนมัติเปิดให้ตรวจสอบ\nกรุณาติดต่อแอดมินเพื่อตรวจสอบรอบรถและที่นั่งโดยตรงค่ะ\n\nทักแชทแอดมิน หรือโทร 092-774-4341\nเวลาตอบแชทและรับจอง 07.00-21.00 น.'
  };
}

function isBookingOpen() {
  return true;
}

function afterHoursBooking() {
  return {
    type: 'text',
    text: 'ขณะนี้อยู่นอกเวลารับจองค่ะ\n\nระบบตอบกลับอัตโนมัติยังสามารถช่วยตรวจสอบรอบรถเบื้องต้นได้\nแต่การจองที่นั่งและการยืนยันตั๋ว แอดมินจะดูแลในเวลา 07.00-21.00 น.\n\nหากเป็นเรื่องเร่งด่วน สามารถโทร 092-774-4341 ได้ค่ะ'
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

function bookingContact() {
  return isBookingOpen() ? withPaymentQr(adminContact()) : afterHoursBooking();
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

async function slipMessage(event) {
  if (!slipOkConfigured()) {
    return { type: 'text', text: slipOkUnavailableText() };
  }

  try {
    const file = await downloadLineContent(event.message.id);
    const booking = userState(event.source.userId).booking;
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
      const adminPaidText = amount == null ? 'ตรวจผ่าน SlipOK' : `${amount.toLocaleString('th-TH')} บาท`;
      await pushAdminText(adminBookingText(booking, adminPaidText));
      try {
        const sheetResult = await appendPaidBooking({
          booking,
          paidAmount: amount,
          note: `ตรวจผ่าน SlipOK${amount == null ? '' : ` / ยอดชำระ ${amount.toLocaleString('th-TH')} บาท`}`
        });
        if (sheetResult.skipped) {
          await pushAdminText('หมายเหตุ: ยังไม่ได้บันทึกรายการลง Google Sheet เพราะยังไม่ได้ตั้งค่า Google Sheets env');
        }
      } catch (sheetError) {
        console.error(sheetError);
        await pushAdminText(`บันทึกรายการลง Google Sheet ไม่สำเร็จ\nกรุณาจดรายการนี้เองก่อนค่ะ\n${sheetError.message ?? sheetError}`);
      }
      setState(event.source.userId, { booking: { ...booking, step: 'paid' } });
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
  const options = stops
    .slice(start, start + pageSize)
    .map(({ id, name }) => button(name, `action=pickup&value=${id}`));
  if (currentPage > 0) options.push(button('ย้อนกลับ', `action=pickup_page&page=${currentPage - 1}`, 'ย้อนกลับ'));
  if (currentPage < totalPages - 1) options.push(button('ถัดไป', `action=pickup_page&page=${currentPage + 1}`, 'ถัดไป'));
  return quick(`เลือกจุดขึ้นรถ (${currentPage + 1}/${totalPages})

ระบบรับจองเฉพาะการเดินทางไกลตามสายรถเท่านั้นค่ะ
จุดกลางทาง เขาหินซ้อน / คลองรั้ง / กบินทร์บุรี ราคา 250 บาท
ไม่รับจองระยะใกล้ เช่น บ่อวินไประยอง`, options);
}

async function dropoffChoices(userId, page = 0) {
  const { pickupId } = userState(userId);
  const stops = await dropoffStops(pickupId);
  const pageSize = 11;
  const totalPages = Math.max(1, Math.ceil(stops.length / pageSize));
  const currentPage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const start = currentPage * pageSize;
  const options = stops
    .slice(start, start + pageSize)
    .map(({ id, name }) => button(name, `action=dropoff&value=${id}`));
  if (currentPage > 0) options.push(button('ย้อนกลับ', `action=dropoff_page&page=${currentPage - 1}`, 'ย้อนกลับ'));
  if (currentPage < totalPages - 1) options.push(button('ถัดไป', `action=dropoff_page&page=${currentPage + 1}`, 'ถัดไป'));
  return quick(`เลือกปลายทางที่ต้องการเดินทางค่ะ (${currentPage + 1}/${totalPages})

ระบบรับจองเฉพาะเดินทางไกลตามสายรถ ไม่รับจองระยะใกล้ค่ะ`, options);
}

async function scheduleChoices(userId) {
  const { date, pickupId, dropoffId } = userState(userId);
  const routes = await routesForJourney(pickupId, dropoffId);
  const nested = await Promise.all(routes.map(async (route) => {
    const schedules = await schedulesFor(route.id, date);
    return schedules.map((schedule) => button(
      `${route.origin} ${schedule.departureTime}`,
      `action=schedule&route=${route.id}&time=${schedule.departureTime}`,
      `${route.name} รอบ ${schedule.departureTime}`
    ));
  }));
  const options = nested.flat();
  if (!options.length) return { type: 'text', text: `ไม่พบรอบรถในวันที่ ${thaiDate(date)} สำหรับเส้นทางนี้ค่ะ\nกรุณาติดต่อแอดมินเพื่อสอบถามเพิ่มเติม` };
  return quick(`เลือกรอบรถ\nวันที่ ${thaiDate(date)}`, chunk(options));
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
    text: `🚌 ${route.name}\n📅 ${thaiDate(date)}\n\n⏰ รอบออกจาก${route.origin}: ${departureTime} น.\n📍 จุดขึ้น: ${pickup.name}\n🏁 จุดลง: ${dropoff.name}\n\nหมายเหตุ: เวลาถึงจุดขึ้น/จุดลงอาจคลาดเคลื่อนตามสภาพถนนค่ะ\nกรุณามารอรถก่อนเวลา และติดต่อแอดมินเพื่อยืนยันจุดขึ้นอีกครั้ง`,
    quickReply: { items: [button('จองตั๋ว', 'action=start_booking'), button('เช็กรอบรถอีกครั้ง', 'action=restart')] }
  };
}

async function handleEvent(event) {
  if (!event.replyToken) return;
  const userId = event.source.userId;
  let message;
  if (event.type === 'follow') message = await start(userId);
  else if (event.type === 'message' && event.message.type === 'text') {
    message = sourceIdMessage(event, event.message.text) ?? await dateMessage(userId, event.message.text);
  } else if (event.type === 'message' && event.message.type === 'image') {
    message = await slipMessage(event);
  } else if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');
    if (action === 'restart') message = await start(userId);
    if (action === 'start_booking') message = await askBookingDate(userId);
    if (action === 'advance_booking' || action === 'contact_admin') message = bookingContact();
    if (action === 'date') { setState(userId, { date: params.get('value') }); message = await pickupChoices(userId); }
    if (action === 'pickup_page') message = await pickupChoices(userId, params.get('page'));
    if (action === 'pickup') { setState(userId, { pickupId: params.get('value') }); message = await dropoffChoices(userId); }
    if (action === 'dropoff_page') message = await dropoffChoices(userId, params.get('page'));
    if (action === 'dropoff') { setState(userId, { dropoffId: params.get('value') }); message = await scheduleChoices(userId); }
    if (action === 'schedule') message = await result(userId, params.get('route'), params.get('time'));
  }
  if (!message) message = { type: 'text', text: 'พิมพ์ข้อความใด ๆ เพื่อเริ่มเช็กรอบรถค่ะ' };
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken: event.replyToken, messages: Array.isArray(message) ? message : [message] })
  });
}

app.get('/', (_req, res) => res.send('LINE Bus Time Bot is running.'));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/webhook', middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).catch((error) => console.error(error));
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => console.log(`Bot ready on port ${process.env.PORT || 3000}`));
