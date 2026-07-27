const BACKEND_SHEET_ID = '1TUzBqCb2muazvHsSN-jYzSOhI_a1Cp7fWauphluo7Zo';
const BOOKING_SHEET_ID = '12lh0jNthN7X5_-mmO1RG1bTdWe4JkskIsP9Av4q2fDA';
const BOOKING_SHEET_NAME = 'รายการจอง';
const SLIP_FOLDER_ID = '';

function doGet(e) {
  const action = e.parameter.action || '';
  if (action === 'backend') return jsonOutput(getBackendData());
  return jsonOutput({ ok: true, message: 'Bus sheet API ready' });
}

function doPost(e) {
  const payload = JSON.parse(e.postData.contents || '{}');
  if (payload.action === 'appendPaidBooking') {
    return jsonOutput(appendPaidBooking(payload));
  }
  return jsonOutput({ ok: false, error: 'Unknown action' });
}

function getBackendData() {
  return {
    routes: sheetValues(BACKEND_SHEET_ID, 'รายการเส้นทาง'),
    schedules: sheetValues(BACKEND_SHEET_ID, 'รอบรถ'),
    dayOpen: sheetValues(BACKEND_SHEET_ID, 'เปิดปิดรายวัน'),
    stopTimes: sheetValues(BACKEND_SHEET_ID, 'เวลาถึงจุดจอด'),
    fares: {
      'ราคา ระยอง-โคราช': sheetValues(BACKEND_SHEET_ID, 'ราคา ระยอง-โคราช'),
      'ราคา โคราช-ระยอง': sheetValues(BACKEND_SHEET_ID, 'ราคา โคราช-ระยอง'),
      'ราคา โคราช-ชลบุรี': sheetValues(BACKEND_SHEET_ID, 'ราคา โคราช-ชลบุรี'),
      'ราคา ชลบุรี-โคราช': sheetValues(BACKEND_SHEET_ID, 'ราคา ชลบุรี-โคราช')
    }
  };
}

function appendPaidBooking(payload) {
  const booking = payload.booking || {};
  const paidAmount = payload.paidAmount || '';
  const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const pricePerSeat = booking.pricePerSeat || '';
  const totalAmount = booking.totalAmount || paidAmount || '';
  const slipLink = booking.slipLink || saveSlipFile(payload.slip, booking, now);

  const row = [
    now,
    booking.date || '',
    `${booking.originProvince || ''}-${booking.destinationProvince || ''}`,
    booking.departureTime || '',
    booking.busNumber || 'รอแจ้ง',
    booking.driverPhone || 'รอแจ้ง',
    booking.pickupPoint || '',
    booking.dropoffPoint || booking.destinationProvince || '',
    booking.seats || '',
    pricePerSeat,
    totalAmount,
    booking.customerName || '',
    booking.phone || '',
    booking.pickupSpecial || '',
    booking.status || 'ออกตั๋วแล้ว',
    slipLink,
    payload.note || '',
    payload.checkedBy || 'ระบบอัตโนมัติ',
    now
  ];

  SpreadsheetApp.openById(BOOKING_SHEET_ID).getSheetByName(BOOKING_SHEET_NAME).appendRow(row);
  return { ok: true };
}

function saveSlipFile(slip, booking, timestamp) {
  if (!SLIP_FOLDER_ID || !slip || !slip.base64) return '';
  const bytes = Utilities.base64Decode(slip.base64);
  const contentType = slip.contentType || 'image/jpeg';
  const fileName = [
    'slip',
    booking.date || '',
    booking.departureTime || '',
    booking.customerName || '',
    timestamp
  ].join('-').replace(/[\\/:*?"<>|]/g, '_') + '.jpg';
  const blob = Utilities.newBlob(bytes, contentType, fileName);
  const file = DriveApp.getFolderById(SLIP_FOLDER_ID).createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

function sheetValues(spreadsheetId, sheetName) {
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(sheetName);
  if (!sheet) return [];
  return sheet.getDataRange().getDisplayValues();
}

function jsonOutput(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
