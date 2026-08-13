import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const APPS_SCRIPT_CACHE_MS = 60_000;
const DEFAULT_APPS_SCRIPT_TIMEOUT_MS = 12000;

let appsScriptCache = { expiresAt: 0, data: null };

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function serviceAccountKey() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!email || !privateKey) return null;
  return { email, privateKey };
}

export function bookingSheetConfigured() {
  return Boolean(appsScriptUrl() || (process.env.BOOKING_SHEET_ID && serviceAccountKey()));
}

function backendSheetId() {
  return process.env.BACKEND_SHEET_ID || process.env.DATA_SHEET_ID || process.env.SCHEDULE_SHEET_ID;
}

function appsScriptUrl() {
  return process.env.APPS_SCRIPT_URL || process.env.GOOGLE_APPS_SCRIPT_URL || process.env.SHEET_API_URL;
}

function appsScriptTimeoutMs() {
  const value = Number(process.env.APPS_SCRIPT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_APPS_SCRIPT_TIMEOUT_MS;
}

export function backendSheetConfigured() {
  return Boolean(appsScriptUrl() || (backendSheetId() && serviceAccountKey()));
}

async function googleAccessToken() {
  const key = serviceAccountKey();
  if (!key) throw new Error('Google service account is not configured');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: key.email,
    scope: SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now
  };

  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.privateKey);
  const assertion = `${unsigned}.${base64Url(signature)}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google token failed: ${response.status} ${result.error_description ?? result.error ?? ''}`);
  return result.access_token;
}

async function getSheetValues(spreadsheetId, tabName, rangeA1) {
  const token = await googleAccessToken();
  const range = encodeURIComponent(`'${tabName}'!${rangeA1}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google Sheets read failed: ${response.status} ${result.error?.message ?? ''}`);
  return result.values ?? [];
}

function rowsFromRange(values, rangeA1) {
  const startRow = Number(rangeA1.match(/\d+/)?.[0] ?? 1);
  return values.slice(Math.max(0, startRow - 1));
}

function appsScriptTab(data, tabName) {
  if (tabName === 'รายการเส้นทาง') return data.routes ?? [];
  if (tabName === 'รอบรถ') return data.schedules ?? [];
  if (tabName === 'เปิดปิดรายวัน') return data.dayOpen ?? [];
  if (tabName === 'เวลาถึงจุดจอด') return data.stopTimes ?? [];
  if (tabName === 'เบอร์รถ') return data.busPhones ?? [];
  return data.fares?.[tabName] ?? [];
}

async function getAppsScriptBackendData() {
  const url = appsScriptUrl();
  if (!url) return null;
  const now = Date.now();
  if (appsScriptCache.data && appsScriptCache.expiresAt > now) return appsScriptCache.data;

  const endpoint = new URL(url);
  endpoint.searchParams.set('action', 'backend');
  const timeoutMs = appsScriptTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Apps Script read failed: ${response.status}`);
    appsScriptCache = { expiresAt: now + APPS_SCRIPT_CACHE_MS, data: result };
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Apps Script read timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getBackendSheetValues(tabName, rangeA1) {
  const appsData = await getAppsScriptBackendData();
  if (appsData) return rowsFromRange(appsScriptTab(appsData, tabName), rangeA1);
  if (!backendSheetConfigured()) return null;
  return getSheetValues(backendSheetId(), tabName, rangeA1);
}

function fareTabForRoute(routeId) {
  if (routeId === 'RY-KOR') return 'ราคา ระยอง-โคราช';
  if (routeId === 'KOR-RY') return 'ราคา โคราช-ระยอง';
  if (routeId === 'KOR-CB' || routeId === 'KOR-CBI') return 'ราคา โคราช-ชลบุรี';
  if (routeId === 'CB-KOR' || routeId === 'CBI-KOR') return 'ราคา ชลบุรี-โคราช';
  return null;
}

function normalizePlace(value) {
  return String(value ?? '').replace(/\s+/g, '').replace(/\./g, '').trim();
}

export async function fareForBookingFromSheet(booking) {
  if (!backendSheetConfigured()) return null;
  const tabName = fareTabForRoute(booking?.routeId);
  if (!tabName) return null;

  const rows = await getBackendSheetValues(tabName, 'A3:E200');
  const pickup = normalizePlace(booking.pickupPoint);
  const dropoff = normalizePlace(booking.dropoffPoint ?? booking.destinationProvince);

  for (const row of rows) {
    const [rowPickup, rowDropoff, rawPrice, active] = row;
    if (normalizePlace(active || 'ใช่') === 'ไม่') continue;
    if (normalizePlace(rowPickup) !== pickup || normalizePlace(rowDropoff) !== dropoff) continue;
    const price = Number(rawPrice) || Number(String(rawPrice ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  return null;
}

function bangkokTimestamp() {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date());
}

export async function appendPaidBooking({ booking, paidAmount, note = '', checkedBy = 'ระบบอัตโนมัติ', slipFile = null }) {
  if (!bookingSheetConfigured()) return { skipped: true };

  const appUrl = appsScriptUrl();
  if (appUrl) {
    const shouldUploadSlip = ['1', 'true', 'yes', 'ใช่'].includes(String(process.env.SAVE_SLIP_TO_DRIVE ?? '').trim().toLowerCase());
    const response = await fetch(appUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'appendPaidBooking',
        booking,
        paidAmount,
        note,
        checkedBy,
        slip: shouldUploadSlip && slipFile ? {
          base64: slipFile.buffer.toString('base64'),
          contentType: slipFile.contentType,
          fileName: `slip-${Date.now()}.jpg`
        } : null
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(`Apps Script append failed: ${response.status} ${result.error ?? ''}`);
    return { skipped: false, result };
  }

  const token = await googleAccessToken();
  const sheetId = process.env.BOOKING_SHEET_ID;
  const tabName = process.env.BOOKING_SHEET_TAB || 'รายการจอง';
  const range = encodeURIComponent(`'${tabName}'!A:S`);
  const now = bangkokTimestamp();
  const pricePerSeat = booking.pricePerSeat ?? '';
  const totalAmount = booking.totalAmount ?? paidAmount ?? '';

  const row = [
    now,
    booking.date ?? '',
    `${booking.originProvince ?? ''}-${booking.destinationProvince ?? ''}`,
    booking.departureTime ?? '',
    booking.busNumber ?? 'รอแจ้ง',
    booking.driverPhone ?? 'รอแจ้ง',
    booking.pickupPoint ?? '',
    booking.dropoffPoint ?? booking.destinationProvince ?? '',
    booking.seats ?? '',
    pricePerSeat,
    totalAmount,
    booking.customerName ?? '',
    booking.phone ?? '',
    booking.pickupSpecial ?? '',
    booking.status ?? 'ออกตั๋วแล้ว',
    booking.slipLink ?? '',
    note,
    checkedBy,
    now
  ];

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values: [row] })
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Google Sheets append failed: ${response.status} ${result.error?.message ?? ''}`);
  return { skipped: false, result };
}
