'use strict';

function normalizeUid(input) {
  if (typeof input !== 'string') return null;
  const uid = input.replace(/[\s:-]/g, '').toUpperCase();
  return uid.length >= 8 && uid.length <= 20 && uid.length % 2 === 0 && /^[A-F0-9]+$/.test(uid) ? uid : null;
}

function philippineToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(({type, value}) => [type, value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function dayRangeUtc(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString || '')) return null;
  const day = new Date(`${dateString}T00:00:00+08:00`);
  if (!Number.isFinite(day.getTime()) || philippineToday(day) !== dateString) return null;
  const sqlDate = date => date.toISOString().slice(0, 23).replace('T', ' ');
  return [sqlDate(day), sqlDate(new Date(day.getTime() + 86400000))];
}

function nextAttendanceEvent(lastRow, todayStartUtc) {
  if (!lastRow || String(lastRow.scanned_at) < todayStartUtc) return 'ENTRY';
  return lastRow.event_type === 'EXIT' ? 'ENTRY' : 'EXIT';
}

function csvCell(value) {
  const s = String(value ?? '');
  // Prefix spreadsheet formulas to avoid CSV formula injection when opened in Excel.
  const safe = /^[\s]*[=+@-]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

module.exports = {normalizeUid, philippineToday, dayRangeUtc, nextAttendanceEvent, csvCell};
