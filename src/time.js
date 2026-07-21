export function addMinutes(time, minutes) {
  const [hours, mins] = time.split(':').map(Number);
  const total = hours * 60 + mins + minutes;
  const dayOffset = Math.floor(total / 1440);
  const normalised = ((total % 1440) + 1440) % 1440;
  const hh = String(Math.floor(normalised / 60)).padStart(2, '0');
  const mm = String(normalised % 60).padStart(2, '0');
  return `${hh}:${mm}${dayOffset > 0 ? ' (วันถัดไป)' : ''}`;
}

export function durationText(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder} นาที`;
  return remainder ? `${hours} ชม. ${remainder} นาที` : `${hours} ชม.`;
}

export function bangkokDate(offset = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const date = new Date(`${value.year}-${value.month}-${value.day}T12:00:00+07:00`);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function thaiDate(iso) {
  return new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${iso}T12:00:00+07:00`));
}
