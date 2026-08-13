import 'dotenv/config';
import { readFileSync } from 'fs';
import express from 'express';
import { middleware } from '@line/bot-sdk';
import opentype from 'opentype.js';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { availableScheduleDates, dropoffStops, fareForJourney, getRoute, getRoutes, hasSchedulesOnDate, pickupStops, routesForJourney, schedulesFor, warmBusData } from './data.js';
import { appendPaidBooking, backendSheetConfigured, fareForBookingFromSheet } from './googleSheets.js';
import { slipAmount, slipDate, slipOkConfigured, slipReceiver, verifySlipImage } from './slipok.js';
import { bangkokDate, bangkokHour, thaiDate } from './time.js';

const required = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'];
for (const key of required) if (!process.env[key]) console.warn(`คำเตือน: ยังไม่ได้ตั้งค่า ${key}`);

const config = { channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, channelSecret: process.env.LINE_CHANNEL_SECRET };
const app = express();
const APP_VERSION = 'rich-menu-schedule-help-v3';
const state = new Map();
const processedSlipMessageIds = new Set();
const BOOKING_OPEN_HOUR = 7;
const BOOKING_CLOSE_HOUR = 22;
const DEFAULT_PAYMENT_QR_PAYLOAD = '00020101021130750016A00000067701011201150994000164891300220070969100160000905120308MHG1000053037645802TH6304A560';
const thaiFontBuffer = readFileSync(new URL('../node_modules/@fontsource/noto-sans-thai/files/noto-sans-thai-thai-700-normal.woff', import.meta.url));
const THAI_FONT = opentype.parse(thaiFontBuffer.buffer.slice(
  thaiFontBuffer.byteOffset,
  thaiFontBuffer.byteOffset + thaiFontBuffer.byteLength
));
const latinFontBuffer = readFileSync(new URL('../node_modules/@fontsource/noto-sans-thai/files/noto-sans-thai-latin-700-normal.woff', import.meta.url));
const LATIN_FONT = opentype.parse(latinFontBuffer.buffer.slice(
  latinFontBuffer.byteOffset,
  latinFontBuffer.byteOffset + latinFontBuffer.byteLength
));
app.use(express.static('public'));
app.use('/api/liff', express.json({ limit: '2mb' }));

const button = (label, data, displayText = label) => ({ type: 'action', action: { type: 'postback', label, data, displayText } });
const uriButton = (label, uri) => ({ type: 'action', action: { type: 'uri', label, uri } });
const quick = (text, items) => ({ type: 'text', text, quickReply: { items } });

function chunk(items, size = 13) { return items.slice(0, size); }
function envList(...keys) {
  return keys
    .flatMap((key) => String(process.env[key] || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}
function userState(userId) { return state.get(userId) ?? {}; }
function setState(userId, patch) { state.set(userId, { ...userState(userId), ...patch }); }
function shouldSendDailyGuide(userId) {
  return userState(userId).chatGuideSentDate !== bangkokDate();
}
function closeBookingAfterHours(userId) {
  setState(userId, { afterHoursNoticeSent: true, handoffToAdmin: false, booking: null });
  return afterHoursBooking();
}
function afterHoursTestUserIds() {
  return envList('LINE_TEST_USER_IDS', 'LINE_TEST_USER_ID');
}
function afterHoursTestGroupIds() {
  return envList('LINE_TEST_GROUP_IDS', 'LINE_TEST_GROUP_ID', 'ADMIN_LINE_TARGET_ID');
}
function canUseAfterHours(userId, source = null) {
  return afterHoursTestUserIds().includes(userId)
    || (source?.groupId && afterHoursTestGroupIds().includes(source.groupId))
    || (source?.roomId && afterHoursTestGroupIds().includes(source.roomId));
}
function isTesterUser(userId, source = null) {
  return canUseAfterHours(userId, source);
}
function isAdminChat(source = null) {
  const adminChatIds = afterHoursTestGroupIds();
  return (source?.groupId && adminChatIds.includes(source.groupId))
    || (source?.roomId && adminChatIds.includes(source.roomId));
}
function bookingTimeLimitDisabled() {
  return ['1', 'true', 'yes', 'ใช่'].includes(String(process.env.DISABLE_BOOKING_TIME_LIMIT ?? '').trim().toLowerCase());
}
function isBookingOpenFor(userId, source = null) {
  return isBookingOpen() || canUseAfterHours(userId, source);
}
function botEnabled() {
  return !['false', '0', 'off', 'no'].includes(String(process.env.BOT_ENABLED ?? 'true').trim().toLowerCase());
}
function logLineEvent(event, status, extra = {}) {
  if (String(process.env.LOG_LINE_EVENTS ?? 'true').trim().toLowerCase() === 'false') return;
  const text = event.message?.type === 'text' ? cleanCustomerText(event.message.text).slice(0, 80) : undefined;
  console.log('LINE event', JSON.stringify({
    status,
    type: event.type,
    messageType: event.message?.type,
    sourceType: event.source?.type,
    hasUserId: Boolean(event.source?.userId),
    hasGroupId: Boolean(event.source?.groupId),
    text,
    ...extra
  }));
}
function handoffToAdmin(userId, source = null) {
  if (!isBookingOpenFor(userId, source)) return closeBookingAfterHours(userId);
  setState(userId, { handoffToAdmin: true, handoffToAdminDate: bangkokDate(), booking: null });
  return adminContact();
}
function unclearHandoffToAdmin(userId) {
  setState(userId, { handoffToAdmin: true, handoffToAdminDate: bangkokDate(), booking: null });
  return {
    type: 'text',
    text: 'ขออภัยค่ะ ระบบยังไม่เข้าใจข้อความที่พิมพ์มา 🙏\n\nเดี๋ยวให้แอดมินมาตอบต่อนะคะ\nหากต้องการให้บอทเริ่มถามใหม่ ให้พิมพ์ว่า เริ่มถามใหม่ หรือ จองตั๋ว ค่ะ'
  };
}
function shouldResumeFromHandoff(text) {
  return /เริ่มถามใหม่|ถามใหม่|เริ่มใหม่|จองใหม่|จองตั๋ว|จองตัว|เช็กรอบ|ตรวจรอบ|ดูรอบ|reset|restart/i.test(cleanCustomerText(text));
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
  if (year < 100) year += year >= 50 ? 2500 : 2000;
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

const THAI_MONTH_ALIASES = [
  { month: 1, names: ['มกราคม', 'มกรา', 'ม.ค.', 'มค', 'jan', 'january'] },
  { month: 2, names: ['กุมภาพันธ์', 'กุมภา', 'ก.พ.', 'กพ', 'feb', 'february'] },
  { month: 3, names: ['มีนาคม', 'มีนา', 'มี.ค.', 'มีค', 'mar', 'march'] },
  { month: 4, names: ['เมษายน', 'เมษา', 'เม.ย.', 'เมย', 'apr', 'april'] },
  { month: 5, names: ['พฤษภาคม', 'พฤษภา', 'พ.ค.', 'พค', 'may'] },
  { month: 6, names: ['มิถุนายน', 'มิถุนา', 'มิ.ย.', 'มิย', 'jun', 'june'] },
  { month: 7, names: ['กรกฎาคม', 'กรกฎา', 'ก.ค.', 'กค', 'jul', 'july'] },
  { month: 8, names: ['สิงหาคม', 'สิงหา', 'ส.ค.', 'สค', 'aug', 'august'] },
  { month: 9, names: ['กันยายน', 'กันยา', 'ก.ย.', 'กย', 'sep', 'september'] },
  { month: 10, names: ['ตุลาคม', 'ตุลา', 'ต.ค.', 'ตค', 'oct', 'october'] },
  { month: 11, names: ['พฤศจิกายน', 'พฤศจิกา', 'พ.ย.', 'พย', 'nov', 'november'] },
  { month: 12, names: ['ธันวาคม', 'ธันวา', 'ธ.ค.', 'ธค', 'dec', 'december'] }
];

function compactDateText(text) {
  return normaliseThaiDigits(String(text ?? '').toLowerCase())
    .replace(/\./g, '')
    .replace(/\s+/g, '')
    .replace(/วันที่|วันที|วันเดินทาง|เดินทางวันที่|ไปวันที่|จองวันที่|เดือน/g, '');
}

function parseMonthNameDate(text, fallbackYear) {
  const compact = compactDateText(text);
  const aliases = THAI_MONTH_ALIASES
    .flatMap(({ month, names }) => names.map((name) => ({ month, name: compactDateText(name) })))
    .sort((a, b) => b.name.length - a.name.length);

  for (const { month, name } of aliases) {
    const index = compact.indexOf(name);
    if (index === -1) continue;

    const beforeNumbers = compact.slice(0, index).match(/\d+/g) ?? [];
    const afterNumbers = compact.slice(index + name.length).match(/\d+/g) ?? [];
    let day = beforeNumbers.length ? beforeNumbers[beforeNumbers.length - 1] : null;
    let year = beforeNumbers.length ? afterNumbers[0] : afterNumbers[1];
    if (!day && afterNumbers.length) {
      day = afterNumbers[0];
      year = afterNumbers[1];
    }

    if (!day) continue;
    return isoDate(yearFromInput(year, fallbackYear), month, Number(day));
  }

  return null;
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

  const monthNameDate = parseMonthNameDate(value, currentYear);
  if (monthNameDate) return monthNameDate;

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
  if (!isTesterUser(userId, event.source)) return null;
  const value = cleanCustomerText(text);

  if (['คำสั่งเทส', 'คำสั่งทดสอบ', 'tester', '/test', 'เทสเตอร์'].includes(value)) {
    return {
      type: 'text',
      text: `🧪 คำสั่งสำหรับ Tester

พิมพ์ได้เฉพาะบัญชีที่อยู่ใน LINE_TEST_USER_IDS
หรือพิมพ์จากกลุ่มที่อยู่ใน LINE_TEST_GROUP_IDS เท่านั้น

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
DISABLE_BOOKING_TIME_LIMIT: ${bookingTimeLimitDisabled() ? 'true' : 'false'}
เวลาจองปกติเปิดอยู่: ${isBookingOpen() ? 'ใช่' : 'ไม่ใช่'}
Tester ข้ามเวลาได้: ${canUseAfterHours(userId, event.source) ? 'ใช่' : 'ไม่ใช่'}
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

async function askBookingDate(userId, source = null) {
  if (!isBookingOpenFor(userId, source)) {
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

ตัวอย่าง
- คุณกมลพร 094-172-4569`;
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
📍 จุดขึ้น: ${booking.pickupPoint}
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

async function handleBookingText(userId, text, source = null) {
  const current = userState(userId).booking;
  if (!current?.step) return null;

  if (!isBookingOpenFor(userId, source)) {
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

async function dateMessage(userId, text, source = null) {
  const booking = await handleBookingText(userId, text, source);
  if (booking) return booking;
  const typedSchedule = await typedScheduleChoice(userId, text);
  if (typedSchedule) return typedSchedule;
  const typedChoice = await typedStopChoice(userId, text);
  if (typedChoice) return typedChoice;
  const current = userState(userId);
  if (current.flowStep === 'check_date') {
    const date = parseTypedDate(text);
    if (!date) return askScheduleDate(userId);
    return scheduleSummaryForDate(userId, date);
  }
  if (wantsScheduleCheck(text)) {
    const date = parseTypedDate(text);
    if (date) return scheduleSummaryForDate(userId, date);
    return askScheduleDate(userId);
  }
  if (/เริ่มถามใหม่|ถามใหม่|เริ่มใหม่|จองใหม่|reset|restart/.test(cleanCustomerText(text))) return start(userId);
  if (/จอง|ซื้อตั๋ว/.test(text)) return bookingModePrompt();
  if (/จองล่วงหน้า|เดือนหน้า|เดือนถัดไป|เทศกาล|ติดต่อแอดมิน|หาแอดมิน|โทร/.test(text)) return handoffToAdmin(userId, source);
  const date = parseTypedDate(text);
  if (!date) {
    if (isWaitingForCustomerChoice(userId)) return unclearHandoffToAdmin(userId);
    return unclearDateMessage();
  }
  if (await hasSchedulesOnDate(date) || (!backendSheetConfigured() && isInBookingWindow(date))) {
    setState(userId, { date, flowStep: 'pickup' });
    return pickupChoices(userId);
  }
  return bookingContact(userId, source);
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

async function dateButtons(action = 'date') {
  const dates = await availableScheduleDates();
  return buttonsForDates(dates, action);
}

function buttonsForDates(dates, action = 'date') {
  return dates.map((date) => {
    const day = String(Number(date.slice(8, 10)));
    return button(day, `action=${action}&value=${date}`, day);
  });
}

function liffBookingUrl() {
  const liffId = String(process.env.LIFF_ID || '').trim();
  if (liffId) return `https://liff.line.me/${liffId}`;
  const baseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  return baseUrl ? `${baseUrl}/liff` : 'https://bus-test-wsena.onrender.com/liff';
}

function wantsScheduleCheck(text) {
  return /เช็กรอบ|เช็ครอบ|ตรวจรอบ|ดูรอบ|รอบรถ|มีรอบ|รอบไหน|กี่โมง/.test(cleanCustomerText(text));
}

function isRichMenuScheduleText(text) {
  const compact = cleanCustomerText(text).replace(/\s+/g, '');
  return [
    'เช็กรอบ',
    'เช็ครอบ',
    'เช็กรอบรถ',
    'เช็ครอบรถ',
    'ตรวจรอบ',
    'ตรวจรอบรถ',
    'ดูรอบ',
    'ดูรอบรถ'
  ].includes(compact);
}

async function askScheduleDate(userId) {
  setState(userId, { flowStep: 'check_date', booking: null });
  const dates = await availableScheduleDates();
  return askScheduleDateFromDates(userId, dates);
}

function askScheduleDateFromDates(userId, dates) {
  const dateList = dates.length
    ? dates.map((date) => `- ${thaiDate(date)}`).join('\n')
    : '- ตอนนี้ยังไม่มีวันที่เปิดให้เช็กในระบบ';

  return quick(`📅 ต้องการเช็กรอบรถของวันไหนคะ

ตอนนี้เช็กได้เฉพาะวันที่มีข้อมูลในระบบ:
${dateList}

👇 กดเลขวันที่ด้านล่าง หรือพิมพ์วันที่ได้เลยค่ะ
เช่น 12, 12/8, วันที่ 12`, [
    ...buttonsForDates(dates, 'check_date'),
    button('ติดต่อแอดมิน', 'action=contact_admin')
  ]);
}

function loadingScheduleMessage() {
  return {
    type: 'text',
    text: '🔎 กำลังโหลดข้อมูลรอบรถให้นะคะ\nกรุณารอสักครู่ค่ะ...'
  };
}

async function scheduleSummaryForDate(userId, date) {
  if (!(await hasSchedulesOnDate(date))) {
    setState(userId, { handoffToAdmin: true, handoffToAdminDate: bangkokDate(), booking: null, flowStep: null });
    return {
      type: 'text',
      text: `ขออภัยค่ะ วันที่ ${thaiDate(date)} ยังไม่มีข้อมูลรอบรถในระบบ 🙏

เดี๋ยวให้แอดมินเข้ามาช่วยตรวจสอบและตอบต่อในแชทนี้นะคะ

หากเป็นเรื่องเร่งด่วน โทร 092-774-4341 ได้ค่ะ`
    };
  }

  const routes = await getRoutes();
  const routeGroups = [];
  for (const route of routes) {
    const schedules = await schedulesFor(route.id, date);
    if (!schedules.length) continue;
    routeGroups.push({
      route,
      schedules
    });
  }

  if (!routeGroups.length) {
    setState(userId, { handoffToAdmin: true, handoffToAdminDate: bangkokDate(), booking: null, flowStep: null });
    return {
      type: 'text',
      text: `ขออภัยค่ะ วันที่ ${thaiDate(date)} ยังไม่มีข้อมูลรอบรถในระบบ 🙏

เดี๋ยวให้แอดมินเข้ามาช่วยตรวจสอบและตอบต่อในแชทนี้นะคะ

หากเป็นเรื่องเร่งด่วน โทร 092-774-4341 ได้ค่ะ`
    };
  }

  const groupsText = routeGroups.map(({ route, schedules }) => {
    const lines = schedules.map((schedule) => {
      const busText = schedule.busNumber ? ` รถ ${schedule.busNumber}` : '';
      return `- ${route.origin} ${schedule.departureTime}${busText}`;
    }).join('\n');
    return `🚌 ${route.name}\n${lines}`;
  }).join('\n\n');

  setState(userId, { date, flowStep: 'check_result' });
  return quick(`📅 รอบรถวันที่ ${thaiDate(date)}

${groupsText}

ต้องการดำเนินการต่อแบบไหนคะ`, [
    uriButton('จองผ่านเว็บ', liffBookingUrl()),
    button('จองกับแอดมิน', 'action=contact_admin'),
    button('เช็กรอบวันอื่น', 'action=check_schedule')
  ]);
}

function bookingModePrompt() {
  return quick(`ต้องการจองแบบไหนคะ 🎫

🔎 เช็กรอบรถ
ระบบจะแสดงรอบรถตามวันที่ที่มีข้อมูลในระบบค่ะ

🤖 จองตั๋วอัตโนมัติ
ระบบจะพาเลือกวันที่ จุดขึ้น จุดลง รอบรถ และชำระเงินในแชทนี้ค่ะ

👤 จองกับแอดมิน
แอดมินจะเข้ามาดูแลและตอบในแชทนี้ค่ะ`, [
    button('เช็กรอบรถ', 'action=check_schedule'),
    button('จองอัตโนมัติ', 'action=auto_booking'),
    button('จองกับแอดมิน', 'action=contact_admin')
  ]);
}

function webBookingOnlyPrompt() {
  return quick(`🤖 นี่คือระบบตอบข้อความอัตโนมัตินะคะ

🎫 หากต้องการจองตั๋ว กรุณากดปุ่ม "จองผ่านเว็บ" หรือกดเมนู "จองตั๋วออนไลน์" ด้านล่างแชทค่ะ
ระบบจะพาเลือกวันที่ จุดขึ้น จุดลง รอบรถ และกรอกข้อมูลทีละขั้นตอน

ℹ️ เลือกวันที่ จุดขึ้น จุดลง และรอบรถตามป้ายที่มีในระบบค่ะ
💰 หากเป็นระยะใกล้ ระบบคิดราคา 250 บาทค่ะ

👤 หากต้องการให้แอดมินช่วยดูแล กด "ติดต่อแอดมิน" ได้เลยค่ะ`, [
    uriButton('จองผ่านเว็บ', liffBookingUrl()),
    button('ติดต่อแอดมิน', 'action=contact_admin')
  ]);
}

async function start(userId) {
  state.set(userId, {});
  return [
    {
      type: 'text',
      text: 'สวัสดีค่ะ ยินดีต้อนรับสู่บัญชีทางการของรถร่วมวิศวกรเสนา 🚌\n\n🤖 นี่คือระบบตอบข้อความอัตโนมัตินะคะ\n\nระบบนี้ใช้สำหรับตรวจสอบรอบรถและจองตั๋วออนไลน์\n🚌 สาย 267 โคราช-ระยอง\n🚌 สาย 265 โคราช-ชลบุรี\n\nℹ️ เลือกวันที่ จุดขึ้น จุดลง และรอบรถตามป้ายที่มีในระบบค่ะ\n\n🎫 หากต้องการจองตั๋ว กรุณากดเมนู “จองตั๋วออนไลน์” ด้านล่างค่ะ\n\n👤 หากต้องการให้แอดมินช่วยดูแล กรุณากด “ติดต่อแอดมิน”\nหรือโทร 092-774-4341\n\n⏰ เวลาตอบแชทและรับจอง 07.00-22.00 น. ค่ะ'
    },
    webBookingOnlyPrompt()
  ];
}

function adminContact() {
  return {
    type: 'text',
    text: 'สำหรับการจองล่วงหน้า หรือวันที่ที่อยู่นอกช่วงที่ระบบอัตโนมัติเปิดให้ตรวจสอบ\nกรุณาติดต่อแอดมินเพื่อตรวจสอบรอบรถและที่นั่งโดยตรงค่ะ\n\nทักแชทแอดมิน หรือโทร 092-774-4341\nเวลาตอบแชทและรับจอง 07.00-22.00 น.'
  };
}

function isBookingOpen() {
  if (bookingTimeLimitDisabled()) return true;
  return isBookingOpenByTime();
}

function isBookingOpenByTime() {
  const hour = bangkokHour();
  return hour >= BOOKING_OPEN_HOUR && hour < BOOKING_CLOSE_HOUR;
}

function afterHoursBooking() {
  return {
    type: 'text',
    text: '⏰ ขณะนี้ปิดรับการจองอัตโนมัติแล้วค่ะ 🙏\n\n🚌 ระบบรับจองอัตโนมัติได้ตั้งแต่เวลา 07.00-22.00 น. ของทุกวัน\n🌅 หลังเวลา 22.00 น. กรุณารอเริ่มจองใหม่ตอนเช้าค่ะ\n\n☎️ กรณีเร่งด่วนมาก สามารถโทร 092-774-4341 ได้ค่ะ\n⚠️ หมายเหตุ: แอดมินอาจรับสายหรือไม่สะดวกรับสายในช่วงนอกเวลาทำการค่ะ'
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

function qrPayloadTemplate() {
  return String(process.env.PAYMENT_QR_PAYLOAD || DEFAULT_PAYMENT_QR_PAYLOAD).trim();
}

function parseEmvPayload(payload) {
  const tags = [];
  let index = 0;
  while (index + 4 <= payload.length) {
    const id = payload.slice(index, index + 2);
    const length = Number(payload.slice(index + 2, index + 4));
    if (!Number.isFinite(length) || length < 0) break;
    const value = payload.slice(index + 4, index + 4 + length);
    if (value.length !== length) break;
    tags.push({ id, value });
    index += 4 + length;
  }
  return tags;
}

function formatEmvTag(id, value) {
  const text = String(value);
  return `${id}${String(text.length).padStart(2, '0')}${text}`;
}

function crc16CcittFalse(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= text.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function svgText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function svgTextPath(text, { x, y, size, fill }) {
  const path = new opentype.Path();
  let cursorX = 0;

  for (const char of Array.from(String(text ?? ''))) {
    const font = char.charCodeAt(0) <= 0x7f ? LATIN_FONT : THAI_FONT;
    const glyph = font.charToGlyph(char);
    const glyphPath = glyph.getPath(cursorX, 0, size);
    path.commands.push(...glyphPath.commands);
    cursorX += ((glyph.advanceWidth || 0) / font.unitsPerEm) * size;
  }

  const box = path.getBoundingBox();
  const dx = x - ((box.x2 - box.x1) / 2) - box.x1;
  return `<path d="${path.toPathData(2)}" transform="translate(${dx.toFixed(2)} ${y})" fill="${fill}"/>`;
}

function dynamicPaymentQrPayload(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  const amountText = value.toFixed(2);
  const sourceTags = parseEmvPayload(qrPayloadTemplate())
    .filter((tag) => tag.id !== '54' && tag.id !== '63')
    .map((tag) => (tag.id === '01' ? { ...tag, value: '12' } : tag));
  const amountTag = { id: '54', value: amountText };
  const tagById = new Map(sourceTags.map((tag) => [tag.id, tag]));
  const preferredOrder = ['00', '01', '30', '52', '53', '54', '58', '59', '60', '62'];
  tagById.set('54', amountTag);
  const used = new Set();
  const tags = preferredOrder
    .filter((id) => tagById.has(id))
    .map((id) => {
      used.add(id);
      return tagById.get(id);
    });
  for (const tag of sourceTags) {
    if (!used.has(tag.id)) tags.push(tag);
  }
  const withoutCrc = tags.map((tag) => formatEmvTag(tag.id, tag.value)).join('') + '6304';
  return `${withoutCrc}${crc16CcittFalse(withoutCrc)}`;
}

async function decoratedPaymentQrBuffer(amount, payload) {
  const amountValue = Number(amount);
  const amountText = amountValue.toLocaleString('th-TH', {
    minimumFractionDigits: amountValue % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  });
  const qrDataUrl = await QRCode.toDataURL(payload, {
    type: 'image/png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 620
  });
  const svg = `
<svg width="900" height="1300" viewBox="0 0 900 1300" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#f2fff6"/>
      <stop offset="52%" stop-color="#fff8dc"/>
      <stop offset="100%" stop-color="#e5f7ff"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#0f3d2e" flood-opacity="0.18"/>
    </filter>
  </defs>
  <rect width="900" height="1300" rx="44" fill="url(#bg)"/>
  <circle cx="96" cy="105" r="58" fill="#8bd58f" opacity="0.45"/>
  <circle cx="812" cy="110" r="78" fill="#ffd16a" opacity="0.45"/>
  <circle cx="810" cy="1190" r="110" fill="#ffb38a" opacity="0.28"/>
  ${svgTextPath('ช่องทางชำระเงินจองตั๋ว', { x: 450, y: 130, size: 50, fill: '#102f24' })}
  ${svgTextPath('รถร่วมวิศวกรเสนา', { x: 450, y: 194, size: 34, fill: '#08764d' })}
  <rect x="90" y="245" width="720" height="720" rx="34" fill="#ffffff" filter="url(#shadow)"/>
  <image x="140" y="295" width="620" height="620" href="${qrDataUrl}"/>
  <rect x="95" y="1005" width="710" height="150" rx="34" fill="#ffffff" stroke="#bfe6d1" stroke-width="4"/>
  ${svgTextPath(`${svgText(amountText)} บาท`, { x: 450, y: 1116, size: 72, fill: '#078653' })}
  ${svgTextPath('หลังโอนเสร็จ ส่งรูปสลิปในแชท LINE เดิมค่ะ', { x: 450, y: 1236, size: 28, fill: '#596d66' })}
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function paymentQrUrl(amount = null) {
  const baseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) return null;
  const value = Number(amount);
  if (Number.isFinite(value) && value > 0) return `${baseUrl}/payment-qr-dynamic.png?amount=${encodeURIComponent(value.toFixed(2))}`;
  return `${baseUrl}/payment-qr.png`;
}

function liffBookingText(booking) {
  return `🧾 รายการจองจากหน้า LIFF / รอชำระเงิน

📅 วันที่: ${thaiDate(booking.date)}
🚍 จังหวัดต้นทาง: ${booking.originProvince}
🏁 จังหวัดปลายทาง: ${booking.destinationProvince}
⏰ รอบ: ${booking.departureTime}
📍 จุดขึ้น: ${booking.pickupPoint}

👤 ผู้จอง: ${booking.customerName}
📞 เบอร์โทร: ${booking.phone || '-'}
🎟️ จำนวนที่นั่ง: ${booking.seats} ที่นั่ง
💰 ยอดที่ต้องชำระ: ${moneyText(lockedPaymentAmount(booking)) || 'รอแอดมินยืนยัน'}

🚌 เบอร์รถ: ${booking.busNumber || 'รอแจ้ง'}
☎️ เบอร์คนขับ: ${booking.driverPhone || 'รอแจ้ง'}`;
}

function apiError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}

async function liffBookingFromPayload(payload) {
  const date = String(payload?.date || '').slice(0, 10);
  const pickupId = String(payload?.pickupId || '').trim();
  const dropoffId = String(payload?.dropoffId || '').trim();
  const routeId = String(payload?.routeId || '').trim();
  const departureTime = String(payload?.departureTime || '').trim();
  const seats = parseSeats(String(payload?.seats || ''));
  const customerName = String(payload?.customerName || '').trim();
  const phone = String(payload?.phone || '').trim();

  if (!date || !(await hasSchedulesOnDate(date))) throw new Error('วันที่นี้ยังไม่มีรอบรถในระบบ');
  if (!pickupId || !dropoffId) throw new Error('กรุณาเลือกจุดขึ้นและจุดลง');
  if (!routeId || !departureTime) throw new Error('กรุณาเลือกรอบรถ');
  if (!seats || seats < 1) throw new Error('กรุณากรอกจำนวนที่นั่ง');
  if (!customerName) throw new Error('กรุณากรอกชื่อผู้จอง');
  if (!/^0[\d\s-]{8,}$/.test(phone)) throw new Error('กรุณากรอกเบอร์โทรให้ถูกต้อง');

  const allowedRoutes = await routesForJourney(pickupId, dropoffId);
  const route = allowedRoutes.find((item) => item.id === routeId);
  if (!route) throw new Error('เส้นทางนี้ยังไม่เปิดให้จอง');

  const schedule = (await schedulesFor(routeId, date)).find((item) => item.departureTime === departureTime);
  if (!schedule) throw new Error('ไม่พบรอบรถนี้ หรือรอบยังไม่ยืนยัน');

  const pickup = route.stops.find((stop) => stop.id === pickupId);
  const dropoff = route.stops.find((stop) => stop.id === dropoffId);
  if (!pickup || !dropoff) throw new Error('จุดขึ้นหรือจุดลงไม่ตรงกับสายรถ');

  return withLockedPrice({
    date,
    originProvince: route.origin,
    destinationProvince: dropoff.name,
    departureTime,
    pickupPoint: pickup.name,
    dropoffPoint: dropoff.name,
    pickupSpecial: '',
    routeId,
    pickupId,
    dropoffId,
    busNumber: schedule.busNumber || '',
    driverPhone: schedule.driverPhone || '',
    seats,
    customerName,
    phone,
    status: 'รอชำระเงิน'
  });
}

function bookingContact(userId = null, source = null) {
  if (isBookingOpenFor(userId, source)) return withPaymentQr(adminContact());
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
  await pushLineMessages(to, [{ type: 'text', text }]);
}

function sourceTargetId(source) {
  if (source?.type === 'group') return source.groupId;
  if (source?.type === 'room') return source.roomId;
  return source?.userId;
}

async function pushLineMessages(to, messages) {
  if (!to || !Array.isArray(messages) || messages.length === 0) return false;
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ to, messages })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE push failed: ${response.status} ${body}`);
  }
  return true;
}

async function pushScheduleFollowup(source, userId, date = null) {
  const to = sourceTargetId(source);
  if (!to) return;
  const stateId = userId || to;
  const followup = date ? await scheduleSummaryForDate(stateId, date) : await askScheduleDate(stateId);
  await pushLineMessages(to, Array.isArray(followup) ? followup : [followup]);
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
  if (booking?.step === 'awaiting_slip' && !isBookingOpenFor(event.source.userId, event.source)) {
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

ℹ️ เลือกจุดขึ้นตามป้ายที่มีในระบบค่ะ

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

กรุณากด เริ่มถามใหม่ เพื่อเลือกข้อมูลอีกครั้ง
หรือกด ติดต่อแอดมิน หากไม่สะดวกใช้งานระบบอัตโนมัติค่ะ`, [
    button('เริ่มถามใหม่', 'action=restart'),
    button('ติดต่อแอดมิน', 'action=contact_admin')
  ]);
}

async function typedBookingModeMessage(userId, text, source = null) {
  const value = cleanCustomerText(text);
  if (/จอง.*(อัตโนมัติ|ออโต้|auto|bot|บอท)|อัตโนมัติ|ออโต้/.test(value)) {
    return askBookingDate(userId, source);
  }
  if (/(จอง|คุย|ติดต่อ|คุยกับ).*(แอดมิน|admin)|แอดมิน/.test(value)) {
    return handoffToAdmin(userId, source);
  }
  return null;
}

async function handleEvent(event) {
  if (!event.replyToken) {
    logLineEvent(event, 'skip:no_reply_token');
    return;
  }
  if (!botEnabled()) {
    logLineEvent(event, 'skip:bot_disabled');
    return;
  }
  if (isAdminChat(event.source)) {
    logLineEvent(event, 'skip:admin_chat');
    return;
  }
  const userId = event.source.userId;
  logLineEvent(event, 'received', { handoffToAdmin: Boolean(userState(userId).handoffToAdmin) });

  if (event.type === 'message' && event.message.type === 'text') {
    const commandMessage = sourceIdMessage(event, event.message.text)
      ?? await testerCommandMessage(event, event.message.text);
    if (commandMessage) {
      logLineEvent(event, 'reply:command');
      await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
        body: JSON.stringify({ replyToken: event.replyToken, messages: Array.isArray(commandMessage) ? commandMessage : [commandMessage] })
      });
      return;
    }
  }

  if (userState(userId).afterHoursNoticeSent && !isBookingOpenFor(userId, event.source)) return;
  if (userState(userId).afterHoursNoticeSent && isBookingOpenFor(userId, event.source)) setState(userId, { afterHoursNoticeSent: false });
  if (userState(userId).handoffToAdmin && userState(userId).handoffToAdminDate !== bangkokDate()) {
    setState(userId, { handoffToAdmin: false, handoffToAdminDate: null });
  }
  let message;
  let afterReply = null;
  if (event.type === 'follow') message = await start(userId);
  else if (event.type === 'message' && event.message.type === 'text') {
    const value = cleanCustomerText(event.message.text);
    if (isRichMenuScheduleText(event.message.text)) {
      setState(userId, { booking: null, flowStep: null });
      message = webBookingOnlyPrompt();
      logLineEvent(event, 'reply:rich_menu_schedule_help');
    } else if (userState(userId).handoffToAdmin) {
      logLineEvent(event, 'skip:handoff_to_admin');
      return;
    } else if (/(ติดต่อ|คุย|หา|เรียก).*(แอดมิน|admin)|แอดมิน/.test(value)) {
      message = handoffToAdmin(userId, event.source);
    } else if (wantsScheduleCheck(event.message.text)) {
      const date = parseTypedDate(event.message.text);
      setState(userId, { flowStep: 'check_date', booking: null });
      afterReply = () => pushScheduleFollowup(event.source, userId, date);
      message = loadingScheduleMessage();
    } else if (shouldSendDailyGuide(userId) || shouldResumeFromHandoff(event.message.text)) {
      setState(userId, { chatGuideSent: true, chatGuideSentDate: bangkokDate(), booking: null, flowStep: null });
      message = webBookingOnlyPrompt();
    } else {
      logLineEvent(event, 'skip:no_match');
      return;
    }
  } else if (event.type === 'message' && event.message.type === 'image') {
    if (userState(userId).handoffToAdmin) {
      logLineEvent(event, 'skip:image_handoff_to_admin');
      return;
    }
    message = await slipMessage(event);
  } else if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');
    if (action === 'check_schedule') {
      setState(userId, { flowStep: 'check_date', booking: null });
      afterReply = () => pushScheduleFollowup(event.source, userId);
      message = loadingScheduleMessage();
    }
    if (action === 'check_date') {
      const date = params.get('value');
      if (date) {
        afterReply = () => pushScheduleFollowup(event.source, userId, date);
        message = loadingScheduleMessage();
      } else {
        setState(userId, { flowStep: 'check_date', booking: null });
        afterReply = () => pushScheduleFollowup(event.source, userId);
        message = loadingScheduleMessage();
      }
    }
    if (action === 'restart' || action === 'start_booking' || action === 'auto_booking') {
      message = webBookingOnlyPrompt();
    }
    if (action === 'advance_booking' || action === 'contact_admin') message = handoffToAdmin(userId, event.source);
    if (action === 'date' || action === 'pickup_page' || action === 'pickup' || action === 'dropoff_page' || action === 'dropoff' || action === 'schedule') {
      message = webBookingOnlyPrompt();
    }
  }
  if (!message) {
    logLineEvent(event, 'skip:no_message');
    return;
  }
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
    body: JSON.stringify({ replyToken: event.replyToken, messages: Array.isArray(message) ? message : [message] })
  });
  if (afterReply) {
    setTimeout(() => {
      afterReply().catch((error) => console.error(error));
    }, 0);
  }
}

app.get('/', (_req, res) => res.send('LINE Bus Time Bot is running.'));
app.get('/health', (_req, res) => res.json({
  ok: true,
  version: APP_VERSION,
  botEnabled: botEnabled(),
  bookingOpen: isBookingOpen(),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  liffConfigured: Boolean(String(process.env.LIFF_ID || '').trim())
}));
app.get('/liff', (_req, res) => res.sendFile('index.html', { root: 'public/liff' }));
app.get('/payment-qr-dynamic.png', async (req, res) => {
  try {
    const payload = dynamicPaymentQrPayload(req.query.amount);
    if (!payload) return res.redirect('/payment-qr.png');
    const buffer = await decoratedPaymentQrBuffer(req.query.amount, payload);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  } catch (error) {
    console.error(error);
    return res.redirect('/payment-qr.png');
  }
});
app.get('/api/liff/config', (_req, res) => {
  const liffId = process.env.LIFF_ID || '';
  res.json({
    ok: true,
    liffId,
    liffUrl: liffId ? `https://liff.line.me/${liffId}` : '',
    bookingOpen: isBookingOpen(),
    bookingOpenByTime: isBookingOpenByTime(),
    paymentQrUrl: paymentQrUrl()
  });
});
app.get('/api/liff/options', async (_req, res) => {
  try {
    res.json({
      ok: true,
      dates: (await availableScheduleDates(30)).map((date) => ({ value: date, label: thaiDate(date) })),
      pickups: await pickupStops()
    });
  } catch (error) {
    console.error(error);
    apiError(res, 500, 'โหลดข้อมูลเริ่มต้นไม่สำเร็จ');
  }
});
app.get('/api/liff/dropoffs', async (req, res) => {
  try {
    const pickupId = String(req.query.pickupId || '');
    if (!pickupId) return apiError(res, 400, 'กรุณาเลือกจุดขึ้น');
    res.json({ ok: true, dropoffs: await dropoffStops(pickupId) });
  } catch (error) {
    console.error(error);
    apiError(res, 500, 'โหลดจุดลงไม่สำเร็จ');
  }
});
app.get('/api/liff/schedules', async (req, res) => {
  try {
    const date = String(req.query.date || '').slice(0, 10);
    const pickupId = String(req.query.pickupId || '');
    const dropoffId = String(req.query.dropoffId || '');
    if (!date || !pickupId || !dropoffId) return apiError(res, 400, 'กรุณาเลือกวันที่ จุดขึ้น และจุดลง');

    const routes = await routesForJourney(pickupId, dropoffId);
    const groups = await Promise.all(routes.map(async (route) => {
      const fare = await fareForJourney(route.id, pickupId, dropoffId);
      return {
        routeId: route.id,
        routeName: route.name,
        origin: route.origin,
        schedules: (await schedulesFor(route.id, date)).map((schedule) => ({
          routeId: route.id,
          routeName: route.name,
          origin: route.origin,
          departureTime: schedule.departureTime,
          busNumber: schedule.busNumber || '',
          driverPhone: schedule.driverPhone || '',
          seats: schedule.seats,
          fare
        }))
      };
    }));
    res.json({ ok: true, schedules: groups.flatMap((group) => group.schedules) });
  } catch (error) {
    console.error(error);
    apiError(res, 500, 'โหลดรอบรถไม่สำเร็จ');
  }
});
app.post('/api/liff/bookings', async (req, res) => {
  try {
    if (!isBookingOpen()) return apiError(res, 403, '⏰ ขณะนี้ปิดรับการจองอัตโนมัติแล้วค่ะ กรุณารอเริ่มจองใหม่ตอนเช้าเวลา 07.00-22.00 น. 🌅 หากเร่งด่วนมาก โทร 092-774-4341 ได้ค่ะ ☎️ แต่อาจไม่สะดวกรับสายในช่วงนอกเวลาทำการ ⚠️');
    const booking = await liffBookingFromPayload(req.body);
    const lineUserId = String(req.body?.lineUserId || '').trim();
    let lineMessageSent = false;
    if (lineUserId) {
      setState(lineUserId, {
        booking: { ...booking, step: 'awaiting_slip' },
        handoffToAdmin: false,
        flowStep: null
      });
      const summaryMessage = {
        type: 'text',
        text: `กรุณาตรวจสอบรายการจองค่ะ ✅\n\n${bookingSummary(booking)}\n\n📎 หลังโอนเสร็จ กรุณาส่งรูปสลิปในแชทนี้ค่ะ`
      };
      const qrUrl = paymentQrUrl(lockedPaymentAmount(booking));
      try {
        lineMessageSent = await pushLineMessages(lineUserId, [summaryMessage]);
        if (qrUrl) {
          await pushLineMessages(lineUserId, [{
            type: 'image',
            originalContentUrl: qrUrl,
            previewImageUrl: qrUrl
          }]).catch((pushQrError) => console.error(pushQrError));
        }
      } catch (pushError) {
        console.error(pushError);
      }
    }
    try {
      await pushAdminText(liffBookingText(booking));
    } catch (adminPushError) {
      console.error(adminPushError);
    }
    res.json({
      ok: true,
      booking,
      summary: bookingSummary(booking),
      paymentQrUrl: paymentQrUrl(lockedPaymentAmount(booking)),
      lineMessageSent
    });
  } catch (error) {
    console.error(error);
    apiError(res, 400, error.message || 'ยืนยันรายการไม่สำเร็จ');
  }
});
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

app.listen(process.env.PORT || 3000, () => {
  console.log(`Bot ready on port ${process.env.PORT || 3000}`);
  warmBusData().catch((error) => console.error('Initial bus data warmup failed:', error));
});
