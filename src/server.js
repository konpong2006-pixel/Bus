import 'dotenv/config';
import express from 'express';
import { middleware } from '@line/bot-sdk';
import { getRoutes, getRoute, routesForJourney, schedulesFor } from './data.js';
import { addMinutes, bangkokDate, durationText, thaiDate } from './time.js';

const required = ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'];
for (const key of required) if (!process.env[key]) console.warn(`คำเตือน: ยังไม่ได้ตั้งค่า ${key}`);

const config = { channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN, channelSecret: process.env.LINE_CHANNEL_SECRET };
const app = express();
const state = new Map();

const button = (label, data, displayText = label) => ({ type: 'action', action: { type: 'postback', label, data, displayText } });
const quick = (text, items) => ({ type: 'text', text, quickReply: { items } });

function chunk(items, size = 13) { return items.slice(0, size); }
function userState(userId) { return state.get(userId) ?? {}; }
function setState(userId, patch) { state.set(userId, { ...userState(userId), ...patch }); }

function start(userId) {
  state.set(userId, {});
  return [
    {
      type: 'text',
      text: 'สวัสดีค่ะ ยินดีต้อนรับสู่บัญชีทางการของรถร่วมวิศวกรเสนา\n\nระบบนี้เป็นระบบอัตโนมัติสำหรับตรวจสอบรอบรถโดยสาร สาย 267 โคราช-ระยอง และสาย 265 โคราช-ชลบุรี\n\nสามารถตรวจสอบเวลารถถึงจุดขึ้นและจุดลงโดยประมาณได้จากเมนูด้านล่าง\n\nหากต้องการจองที่นั่ง สอบถามเพิ่มเติม หรือให้แอดมินดูแลจนได้เดินทาง กรุณาทักแชทแอดมิน หรือโทร 092-774-4341\n\nเปิดรับจองและตอบแชทเวลา 07.00-21.00 น.\n\nกรณีทักไลน์ตอบล่าช้า\nสามารถโทรได้ที่👇\n☎️092-774-4341🥰'
    },
    quick('📅 กรุณากดเลือก หรือพิมพ์วันที่เดินทางได้เลยค่ะ\n\nหากต้องการจองช่วงเทศกาล หรือจองล่วงหน้าเดือนถัดไป\nสามารถกดปุ่ม "จองล่วงหน้า" หรือ "ติดต่อแอดมิน" ได้เลยค่ะ 😊', [
      button('วันนี้', 'action=date&value=today'),
      button('พรุ่งนี้', 'action=date&value=tomorrow'),
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
    message = start(userId);
  } else if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');
    if (action === 'restart') message = start(userId);
    if (action === 'advance_booking' || action === 'contact_admin') message = adminContact();
    if (action === 'date') { setState(userId, { date: bangkokDate(params.get('value') === 'tomorrow' ? 1 : 0) }); message = pickupChoices(userId); }
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
