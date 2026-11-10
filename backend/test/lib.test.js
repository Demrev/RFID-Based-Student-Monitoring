const {test} = require('node:test');
const assert = require('node:assert/strict');
const {normalizeUid, philippineToday, dayRangeUtc, nextAttendanceEvent, csvCell} = require('../lib');

test('normalize valid card UIDs with separators', () => {
  assert.equal(normalizeUid('e4 3e 41 01'), 'E43E4101');
  assert.equal(normalizeUid('04:aa:bb:cc:dd:ee:ff'), '04AABBCCDDEEFF');
  assert.equal(normalizeUid('zzzz'), null);
  assert.equal(normalizeUid('123'), null);
});

test('Philippine local date independent of UTC day', () => {
  assert.equal(philippineToday(new Date('2026-11-09T17:15:00Z')), '2026-11-10');
  assert.deepEqual(dayRangeUtc('2026-11-10'), ['2026-11-09 16:00:00.000', '2026-11-10 16:00:00.000']);
  assert.equal(dayRangeUtc('2026-02-30'), null);
});

test('CSV escapes dangerous formula values', () => {
  assert.equal(csvCell('=1+2'), '"\'=1+2"');
  assert.equal(csvCell('Doe, "Jane"'), '"Doe, ""Jane"""');
});

test('ENTRY/EXIT alternates, and starts each Philippine day with ENTRY', () => {
  const start = '2026-11-09 16:00:00.000';
  assert.equal(nextAttendanceEvent(null, start), 'ENTRY');
  assert.equal(nextAttendanceEvent({event_type:'ENTRY',scanned_at:'2026-11-10 03:00:00.000'}, start), 'EXIT');
  assert.equal(nextAttendanceEvent({event_type:'EXIT',scanned_at:'2026-11-10 03:00:00.000'}, start), 'ENTRY');
  assert.equal(nextAttendanceEvent({event_type:'ENTRY',scanned_at:'2026-11-09 15:59:59.000'}, start), 'ENTRY');
});
