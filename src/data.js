import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBackendSheetValues } from './googleSheets.js';
import { bangkokDate } from './time.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(dirname, '..', 'data');
const CACHE_MS = 60_000;

let cache = { expiresAt: 0, value: null };
let refreshPromise = null;

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
}

function normalizeActive(value) {
  return String(value ?? 'ใช่').trim() !== 'ไม่';
}

function normalizeScheduleStatus(value) {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function scheduleConfirmed(value) {
  return normalizeScheduleStatus(value) === 'ออกแน่นอน';
}

function columnIndex(headers, names, fallback) {
  const normalized = headers.map((header) => String(header ?? '').replace(/\s+/g, '').trim());
  for (const name of names) {
    const index = normalized.indexOf(String(name).replace(/\s+/g, '').trim());
    if (index >= 0) return index;
  }
  return fallback;
}

function normalizePlace(value) {
  const normalized = String(value ?? '').replace(/\s+/g, '').replace(/\./g, '').trim();
  const aliases = new Map([
    ['กม79', 'กม79'],
    ['กม10', 'กม10'],
    ['กม๑๐', 'กม10'],
    ['มาบตะพุด', 'มาบตาพุด'],
    ['กบินบุรี', 'กบินทร์บุรี'],
    ['เขาหินซ้อน', 'ตลาดเขาหินซ้อน'],
    ['เนินหิน', 'เนินโมก'],
    ['เฉลิมไทย', 'แยกเฉลิมไทย'],
    ['ดอนหัวฬ่อ', 'แยกดอนหัวฬ่อ'],
    ['วัดหนองตำลึง', 'หน้าวัดหนองตำลึง'],
    ['พนัสนิคม', 'แยกพนัสนิคม'],
    ['แปดริ้ว', 'บขสแปดริ้วฉะเชิงเทรา'],
    ['ฉะเชิงเทรา', 'บขสแปดริ้วฉะเชิงเทรา'],
    ['บขสแปดริ้ว', 'บขสแปดริ้วฉะเชิงเทรา'],
    ['พนมสารคาม', 'บขสพนมสารคาม'],
    ['ชลบุรี', 'บขสชลบุรี'],
    ['บขสชลบุรี', 'บขสชลบุรี']
  ]);
  return aliases.get(normalized) ?? normalized;
}

function parseNumber(value) {
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  const parsed = Number(String(value ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTime(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return text.slice(0, 5);
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function normalizeBusNumber(value) {
  return String(value ?? '').replace(/\s+/g, '').trim();
}

function uniqueSchedules(schedules) {
  return [...new Map(schedules.map((schedule) => [schedule.id, schedule])).values()];
}

function localRoutesById() {
  return new Map(readJson('routes.json').routes.map((route) => [route.id, route]));
}

function routeStopIndex(route, stopId) {
  return route.stops.findIndex((stop) => stop.id === stopId);
}

function routeAllowsJourney(route, pickupId, dropoffId) {
  const pickupIndex = routeStopIndex(route, pickupId);
  const dropoffIndex = routeStopIndex(route, dropoffId);
  return pickupIndex >= 0 && dropoffIndex >= 0 && dropoffIndex > pickupIndex;
}

function busPhoneMap(rows) {
  const phonesByBus = new Map();
  for (const row of rows) {
    const busNumber = normalizeBusNumber(row[1]);
    const phone = String(row[2] ?? '').trim();
    if (!busNumber || !phone) continue;
    if (!phonesByBus.has(busNumber)) phonesByBus.set(busNumber, phone);
  }
  return phonesByBus;
}

function cleanDriverPhone(value) {
  const text = String(value ?? '').trim();
  if (/เลขรถซ้ำ|กรอก.*เอง|ไม่พบ/.test(text)) return '';
  return text;
}

function isDailySchedule(value) {
  return ['ทุกวัน', 'รายวัน', 'ประจำวัน', 'daily'].includes(String(value ?? '').replace(/\s+/g, '').trim().toLowerCase());
}

function nextDates(days = 30) {
  const start = new Date(`${bangkokDate()}T12:00:00+07:00`);
  return Array.from({ length: days }, (_item, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

function scheduleDates(value) {
  if (isDailySchedule(value)) return nextDates().map((date) => ({ date, generatedFromDaily: true }));
  const date = String(value ?? '').slice(0, 10);
  return date ? [{ date, generatedFromDaily: false }] : [];
}

function routeTab(routeId) {
  if (routeId === 'RY-KOR') return 'ราคา ระยอง-โคราช';
  if (routeId === 'KOR-RY') return 'ราคา โคราช-ระยอง';
  if (routeId === 'KOR-CB' || routeId === 'KOR-CBI') return 'ราคา โคราช-ชลบุรี';
  if (routeId === 'CB-KOR' || routeId === 'CBI-KOR') return 'ราคา ชลบุรี-โคราช';
  return null;
}

async function sheetRows(tabName, range) {
  return (await getBackendSheetValues(tabName, range)) ?? null;
}

function fallbackData() {
  const routes = readJson('routes.json').routes;
  const schedules = readJson('schedules.json').schedules;
  const fares = readJson('fares.json').fares.map((fare) => ({
    ...fare,
    active: true,
    pickupName: routes.find((route) => route.id === fare.routeId)?.stops.find((stop) => stop.id === fare.pickupId)?.name,
    dropoffName: routes.find((route) => route.id === fare.routeId)?.stops.find((stop) => stop.id === fare.dropoffId)?.name
  }));
  return { routes, schedules, fares, dayOpen: new Map(), stopTimes: [], source: 'local' };
}

async function loadSheetData() {
  const routeRows = await sheetRows('รายการเส้นทาง', 'A3:D200');
  if (!routeRows) return fallbackData();
  const localRoutes = localRoutesById();

  const routeDefs = routeRows
    .filter((row) => row[0] && row[1])
    .map(([sheetName, id, origin, destination]) => ({
      id: String(id).trim(),
      name: String(sheetName).trim(),
      sheetName: String(sheetName).trim(),
      origin: String(origin || '').trim(),
      destination: String(destination || '').trim()
    }));

  const fareGroups = await Promise.all(routeDefs.map(async (route) => {
    const tabName = routeTab(route.id);
    if (!tabName) return [];
    const rows = await sheetRows(tabName, 'A3:E200') ?? [];
    return rows
      .filter((row) => row[0] && row[1] && row[2] !== '' && normalizeActive(row[3]))
      .map(([pickupName, dropoffName, rawPrice]) => ({
        routeId: route.id,
        pickupId: normalizePlace(pickupName),
        dropoffId: normalizePlace(dropoffName),
        pickupName: String(pickupName).trim(),
        dropoffName: String(dropoffName).trim(),
        price: parseNumber(rawPrice),
        active: true
      }))
      .filter((fare) => Number.isFinite(fare.price) && fare.price > 0);
  }));
  const fares = fareGroups.flat();

  const routes = routeDefs.map((route) => {
    const localStops = localRoutes.get(route.id)?.stops ?? [];
    const routeFares = fares.filter((fare) => fare.routeId === route.id);
    const stops = [];
    const seen = new Set();
    for (const name of [
      route.origin,
      ...localStops.map((stop) => stop.name),
      ...routeFares.map((fare) => fare.pickupName),
      ...routeFares.map((fare) => fare.dropoffName),
      route.destination
    ]) {
      const id = normalizePlace(name);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      stops.push({ id, name, minutesFromOrigin: stops.length });
    }
    return { ...route, stops };
  });

  const scheduleHeaders = (await sheetRows('รอบรถ', 'A2:K2') ?? [])[0] ?? [];
  const scheduleRows = await sheetRows('รอบรถ', 'A3:K500') ?? [];
  const driverPhonesByBus = busPhoneMap(await sheetRows('เบอร์รถ', 'A3:D300') ?? []);
  const dateIndex = columnIndex(scheduleHeaders, ['วันที่'], 0);
  const routeIndex = columnIndex(scheduleHeaders, ['เส้นทาง'], 1);
  const departureIndex = columnIndex(scheduleHeaders, ['เวลาออกจากต้นทาง'], 2);
  const statusIndex = columnIndex(scheduleHeaders, ['สถานะรอบ'], 5);
  const seatsIndex = columnIndex(scheduleHeaders, ['จำนวนที่นั่ง'], 6);
  const noteIndex = columnIndex(scheduleHeaders, ['หมายเหตุ'], 7);
  const busNumberIndex = columnIndex(scheduleHeaders, ['เลขรถ/เบอร์รถ', 'เบอร์รถ', 'เลขรถ'], 8);
  const driverPhoneIndex = columnIndex(scheduleHeaders, ['เบอร์คนขับ', 'โทรคนขับ', 'เบอร์โทรคนขับ'], 9);
  const schedules = uniqueSchedules(scheduleRows
    .filter((row) => scheduleDates(row[dateIndex]).length && row[routeIndex] && row[departureIndex] && scheduleConfirmed(row[statusIndex]))
    .flatMap((row) => {
      const routeName = row[routeIndex];
      const departureTime = row[departureIndex];
      const status = row[statusIndex];
      const seats = row[seatsIndex];
      const note = row[noteIndex];
      const busNumber = normalizeBusNumber(row[busNumberIndex]);
      const driverPhone = cleanDriverPhone(row[driverPhoneIndex]) || driverPhonesByBus.get(busNumber);
      const route = routeDefs.find((item) => item.sheetName === String(routeName).trim());
      if (!route) return [];
      return scheduleDates(row[dateIndex]).map(({ date, generatedFromDaily }) => ({
        id: `${date}-${route.id}-${normalizeTime(departureTime)}`,
        date: String(date).slice(0, 10),
        routeId: route.id,
        departureTime: normalizeTime(departureTime),
        arrivalTime: '',
        status: String(status || '').trim(),
        seats: parseNumber(seats) || null,
        note: String(note || '').trim(),
        busNumber,
        driverPhone: String(driverPhone || '').trim(),
        generatedFromDaily,
        active: true
      }));
    })
    .filter(Boolean));

  const dayRows = await sheetRows('เปิดปิดรายวัน', 'A3:C500') ?? [];
  const dayOpen = new Map(dayRows.filter((row) => row[0]).map((row) => [String(row[0]).slice(0, 10), normalizeActive(row[1])]));

  const stopRows = await sheetRows('เวลาถึงจุดจอด', 'A3:F1000') ?? [];
  const stopTimes = stopRows
    .filter((row) => row[0] && row[1] && row[3] && row[4])
    .map(([routeName, departureTime, _order, stopName, arrivalTime]) => ({
      routeName: String(routeName).trim(),
      departureTime: normalizeTime(departureTime),
      stopName: String(stopName).trim(),
      arrivalTime: normalizeTime(arrivalTime)
    }));

  return { routes, schedules, fares, dayOpen, stopTimes, source: 'sheet' };
}

async function refreshBusData({ keepStaleOnError = false } = {}) {
  const now = Date.now();
  try {
    cache = { expiresAt: now + CACHE_MS, value: await loadSheetData() };
  } catch (error) {
    console.error('Sheet data load failed, using local fallback data:', error);
    if (keepStaleOnError && cache.value) {
      cache = { expiresAt: now + CACHE_MS, value: cache.value };
      return cache.value;
    }
    cache = { expiresAt: now + CACHE_MS, value: fallbackData() };
  }
  return cache.value;
}

export async function busData() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;
  if (cache.value) {
    if (!refreshPromise) {
      refreshPromise = refreshBusData({ keepStaleOnError: true }).finally(() => {
        refreshPromise = null;
      });
    }
    return cache.value;
  }
  if (!refreshPromise) {
    refreshPromise = refreshBusData().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export function warmBusData() {
  if (!refreshPromise) {
    refreshPromise = refreshBusData({ keepStaleOnError: true }).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function getRoutes() {
  return (await busData()).routes;
}

export async function getRoute(routeId) {
  return (await getRoutes()).find((route) => route.id === routeId);
}

export async function routesForJourney(pickupId, dropoffId) {
  const { routes, fares } = await busData();
  const routeIds = new Set(fares
    .filter((fare) => fare.pickupId === pickupId && fare.dropoffId === dropoffId && fare.active)
    .map((fare) => fare.routeId));
  return routes.filter((route) => routeIds.has(route.id) || routeAllowsJourney(route, pickupId, dropoffId));
}

export async function schedulesFor(routeId, date) {
  const { schedules, dayOpen, source } = await busData();
  if (dayOpen.get(date) === false) return [];
  const dated = schedules
    .filter((item) => item.routeId === routeId && item.date === date && item.active)
    .sort((a, b) => a.departureTime.localeCompare(b.departureTime));
  if (dated.length || source === 'sheet') return dated;
  return schedules
    .filter((item) => item.routeId === routeId && item.date === null && item.active)
    .sort((a, b) => a.departureTime.localeCompare(b.departureTime));
}

export async function hasSchedulesOnDate(date) {
  const { schedules, dayOpen } = await busData();
  if (dayOpen.get(date) === false) return false;
  return schedules.some((item) => item.date === date && item.active && !item.generatedFromDaily);
}

export async function availableScheduleDates(limit = 11) {
  const { schedules, dayOpen } = await busData();
  const today = bangkokDate();
  return [...new Set(schedules
    .filter((item) => item.active && !item.generatedFromDaily && item.date && item.date >= today && dayOpen.get(item.date) !== false)
    .map((item) => item.date))]
    .sort()
    .slice(0, limit);
}

export async function fareForJourney(routeId, pickupId, dropoffId) {
  const { fares, routes } = await busData();
  const fare = fares.find((item) => item.routeId === routeId && item.pickupId === pickupId && item.dropoffId === dropoffId);
  if (fare?.price != null) return fare.price;
  const route = routes.find((item) => item.id === routeId);
  return route && routeAllowsJourney(route, pickupId, dropoffId) ? 250 : null;
}

export async function pickupStops() {
  const { fares, routes } = await busData();
  const seen = new Map();
  for (const route of routes) {
    for (const stop of route.stops) seen.set(stop.id, stop.name);
  }
  for (const fare of fares) {
    if (!seen.has(fare.pickupId)) seen.set(fare.pickupId, fare.pickupName);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

export async function dropoffStops(pickupId) {
  const { fares, routes } = await busData();
  const seen = new Map();
  for (const route of routes) {
    const pickupIndex = routeStopIndex(route, pickupId);
    if (pickupIndex < 0) continue;
    for (const stop of route.stops.slice(pickupIndex + 1)) seen.set(stop.id, stop.name);
  }
  for (const fare of fares.filter((item) => item.pickupId === pickupId)) {
    if (!seen.has(fare.dropoffId)) seen.set(fare.dropoffId, fare.dropoffName);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

export async function stopArrivalTime(routeId, departureTime, stopName) {
  const { routes, stopTimes } = await busData();
  const route = routes.find((item) => item.id === routeId);
  const exact = stopTimes.find((item) =>
    item.routeName === route?.sheetName
    && item.departureTime === departureTime
    && normalizePlace(item.stopName) === normalizePlace(stopName)
  );
  return exact?.arrivalTime ?? null;
}
