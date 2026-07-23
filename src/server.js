import 'dotenv/config';
import express from 'express';
import { middleware } from '@line/bot-sdk';
import { getRoutes, getRoute, routesForJourney, schedulesFor, hasSchedulesOnDate } from './data.js';
import { slipAmount, slipDate, slipOkConfigured, slipReceiver, verifySlipImage } from './slipok.js';
import { addMinutes, bangkokDate, bangkokHour, durationText, thaiDate } from './time.js';

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

function dateMessage(userId, text) {
  if (/จอง|ซื้อตั๋ว|จองล่วงหน้า|เดือนหน้า|เดือนถัดไป|เทศกาล|ติดต่อแอดมิน|หาแอดมิน|โทร/.test(text)) return bookingContact();
  const date = parseTypedDate(text);
  if (!date) return unclearDateMessage();
  if (isInBookingWindow(date) || hasSchedulesOnDate(date)) {
    setState(userId, { date });
    return pickupChoices(userId);
  }
  return bookingContact();
}

function unclearDateMessage() {
  return quick('ขออภัยค่ะ ระบบยังอ่านวันที่เดินทางไม่ชัดเจน\n\nกรุณากดเลือกเลขวันที่ด้านล่าง หรือพิมพ์เป็นตัวอย่างเช่น 28, 28/7, วันที่ 28 ค่ะ', [
    ...dateButtons(),
    button('จองล่วงหน้า', 'action=advance_booking'),
    button('ติดต่อแอดมิน', 'action=contact_admin')
  ]);
}

function dateButtons(days = 7) {
  return Array.from({ length: days }, (_, index) => {
    const date = bangkokDate(index);
    const day = String(Number(date.slice(8, 10)));
    return button(day, `action=date&value=${date}`, day);
  });
}

function start(userId) {
  state.set(userId, {});
  return [
    {
      type: 'text',
      text: 'สวัสดีค่ะ ยินดีต้อนรับสู่บัญชีทางการของรถร่วมวิศวกรเสนา\n\nระบบนี้เป็นระบบอัตโนมัติสำหรับตรวจสอบรอบรถโดยสาร สาย 267 โคราช-ระยอง และสาย 265 โคราช-ชลบุรี\n\nสามารถตรวจสอบเวลารถถึงจุดขึ้นและจุดลงโดยประมาณได้จากเมนูด้านล่าง\n\nหากต้องการจองที่นั่ง สอบถามเพิ่มเติม หรือให้แอดมินดูแลจนได้เดินทาง กรุณาทักแชทแอดมิน หรือโทร 092-774-4341\n\nเปิดรับจองและตอบแชทเวลา 07.00-21.00 น.\n\nกรณีทักไลน์ตอบล่าช้า\nสามารถโทรได้ที่👇\n☎️092-774-4341🥰'
    },
    quick('📅 กรุณากดเลือก หรือพิมพ์วันที่เดินทางได้เลยค่ะ\n\nหากต้องการจองช่วงเทศกาล หรือจองล่วงหน้าเดือนถัดไป\nสามารถกดปุ่ม "จองล่วงหน้า" หรือ "ติดต่อแอดมิน" ได้เลยค่ะ 😊', [
      ...dateButtons(),
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

async function slipMessage(event) {
  if (!slipOkConfigured()) {
    return { type: 'text', text: 'ได้รับรูปสลิปแล้วค่ะ แต่ระบบตรวจสลิปอัตโนมัติยังไม่ได้ตั้งค่า กรุณารอแอดมินตรวจสอบให้นะคะ' };
  }

  try {
    const file = await downloadLineContent(event.message.id);
    const result = await verifySlipImage(file.buffer, { contentType: file.contentType });
    if (!result.ok) return { type: 'text', text: slipOkErrorText(result) };

    const amount = slipAmount(result.data);
    const paidText = amount == null ? '' : `\nยอดชำระ: ${amount.toLocaleString('th-TH')} บาท`;
    const receiverText = slipReceiver(result.data) ? `\nผู้รับเงิน: ${slipReceiver(result.data)}` : '';
    const dateText = slipDate(result.data) ? `\nเวลาตามสลิป: ${slipDate(result.data)}` : '';

    await pushAdminText(`มีลูกค้าส่งสลิปและตรวจผ่าน SlipOK แล้ว\nสถานะ: รอตรวจรายการจอง/ออกตั๋ว${paidText}${receiverText}${dateText}`);

    return {
      type: 'text',
      text: `ได้รับสลิปแล้วค่ะ\nระบบตรวจสอบสลิปเบื้องต้นผ่านแล้ว ✅${paidText}\n\nแอดมินจะตรวจรายการจองและออกตั๋วให้ต่อค่ะ`
    };
  } catch (error) {
    console.error(error);
    return { type: 'text', text: 'ขออภัยค่ะ ระบบตรวจสลิปมีปัญหาชั่วคราว กรุณาลองส่งสลิปใหม่อีกครั้ง หรือติดต่อแอดมินค่ะ' };
  }
}

function pickupChoices(userId) {
  const seen = new Map();
  for (const route of getRoutes()) for (const stop of route.stops) seen.set(stop.id, stop.name);
  return quick('เลือกจุดขึ้นรถ', chunk([...seen].map(([id, name]) => button(name, `action=pickup&value=${id}`))));
}

function dropoffChoices(userId) {
  const { pickupId } = userState(userId);
  const stops = new Map();
  for (const route of getRoutes()) {
    const at = route.stops.findIndex((stop) => stop.id === pickupId);
    if (at >= 0) for (const stop of route.stops.slice(at + 1)) stops.set(stop.id, stop.name);
  }
  return quick('เลือกจุดลงรถ', chunk([...stops].map(([id, name]) => button(name, `action=dropoff&value=${id}`))));
}

function scheduleChoices(userId) {
  const { date, pickupId, dropoffId } = userState(userId);
  const routes = routesForJourney(pickupId, dropoffId);
  const options = routes.flatMap((route) => schedulesFor(route.id, date).map((schedule) => button(
    `${route.origin} ${schedule.departureTime}`,
    `action=schedule&route=${route.id}&time=${schedule.departureTime}`,
    `${route.name} รอบ ${schedule.departureTime}`
  )));
  if (!options.length) return { type: 'text', text: `ไม่พบรอบรถในวันที่ ${thaiDate(date)} สำหรับเส้นทางนี้ค่ะ\nกรุณาติดต่อแอดมินเพื่อสอบถามเพิ่มเติม` };
  return quick(`เลือกรอบรถ\nวันที่ ${thaiDate(date)}`, chunk(options));
}

function result(userId, routeId, departureTime) {
  const { date, pickupId, dropoffId } = userState(userId);
  const route = getRoute(routeId);
  const pickup = route.stops.find((stop) => stop.id === pickupId);
  const dropoff = route.stops.find((stop) => stop.id === dropoffId);
  if (!route || !pickup || !dropoff) return { type: 'text', text: 'ข้อมูลไม่ครบ กรุณาเริ่มเช็กรอบรถใหม่ค่ะ' };
  const rideMinutes = dropoff.minutesFromOrigin - pickup.minutesFromOrigin;
  return {
    type: 'text',
    text: `🚌 ${route.name}\n📅 ${thaiDate(date)}\n\nรอบออกจาก${route.origin}: ${departureTime} น.\n📍 รถจะถึง ${pickup.name} ประมาณ ${addMinutes(departureTime, pickup.minutesFromOrigin)} น.\n🏁 ถึง ${dropoff.name} ประมาณ ${addMinutes(departureTime, dropoff.minutesFromOrigin)} น.\n⏱️ ใช้เวลาเดินทางประมาณ ${durationText(rideMinutes)}\n\nกรุณามารอรถก่อนเวลา 10–15 นาที\nต้องการจองที่นั่ง/สอบถามเพิ่มเติม กรุณาติดต่อแอดมิน`,
    quickReply: { items: [button('เช็กรอบรถอีกครั้ง', 'action=restart')] }
  };
}

async function handleEvent(event) {
  if (!event.replyToken) return;
  const userId = event.source.userId;
  let message;
  if (event.type === 'follow') message = start(userId);
  else if (event.type === 'message' && event.message.type === 'text') {
    message = dateMessage(userId, event.message.text);
  } else if (event.type === 'message' && event.message.type === 'image') {
    message = await slipMessage(event);
  } else if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');
    if (action === 'restart') message = start(userId);
    if (action === 'advance_booking' || action === 'contact_admin') message = bookingContact();
    if (action === 'date') { setState(userId, { date: params.get('value') }); message = pickupChoices(userId); }
    if (action === 'pickup') { setState(userId, { pickupId: params.get('value') }); message = dropoffChoices(userId); }
    if (action === 'dropoff') { setState(userId, { dropoffId: params.get('value') }); message = scheduleChoices(userId); }
    if (action === 'schedule') message = result(userId, params.get('route'), params.get('time'));
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
