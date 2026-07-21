import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(dirname, '..', 'data');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
}

export function getRoutes() {
  return readJson('routes.json').routes;
}

export function getRoute(routeId) {
  return getRoutes().find((route) => route.id === routeId);
}

export function routesForJourney(pickupId, dropoffId) {
  return getRoutes().filter((route) => {
    const pickupIndex = route.stops.findIndex((stop) => stop.id === pickupId);
    const dropoffIndex = route.stops.findIndex((stop) => stop.id === dropoffId);
    return pickupIndex >= 0 && dropoffIndex > pickupIndex;
  });
}

export function schedulesFor(routeId, date) {
  const schedules = readJson('schedules.json').schedules;
  const dated = schedules.filter((item) => item.routeId === routeId && item.date === date && item.active);
  // หากตั้งรอบเฉพาะวันนั้นไว้ ให้ใช้รอบเฉพาะวันแทนตารางปกติ
  const selected = dated.length ? dated : schedules.filter((item) => item.routeId === routeId && item.date === null && item.active);
  return selected.sort((a, b) => a.departureTime.localeCompare(b.departureTime));
}

export function hasSchedulesOnDate(date) {
  return readJson('schedules.json').schedules.some((item) => item.date === date && item.active);
}
