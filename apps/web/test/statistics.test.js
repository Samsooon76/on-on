import test from 'node:test';
import assert from 'node:assert/strict';
import { csv, defaultFilters, filterCalls, heatmap, outcome, previousPeriod, queryWindow, summarize, timedCalls, validateFilters } from '../src/statistics-model.ts';

const base = { id: 'one', lineId: 'line', remoteNumber: '+33123456789', createdAt: '2026-09-20T09:00:00Z', direction: 'inbound', status: 'completed', ended: true, resultCode: null, connected: true, durationSeconds: 60, userIds: ['alice'], routing: 'direct', transfers: 0, voicemailCount: 0, voicemailSeconds: 0 };
const defaults = () => ({ ...defaultFilters(new Date('2026-09-26T12:00:00Z')), from: '2026-09-01', to: '2026-09-30' });
test('unknown measurements and zero measurements have different denominators', () => {
  const result = summarize([base, { ...base, durationSeconds: null }, { ...base, durationSeconds: 0 }, { ...base, connected: false, ended: false, durationSeconds: null }]);
  assert.equal(result.averageDuration, 30);
  assert.equal(result.totalDuration, 60);
  assert.equal(result.durationSamples, 2);
  assert.equal(result.connectionRate, 100);
  assert.equal(summarize([]).connectionRate, null);
  assert.equal(summarize([{ ...base, durationSeconds: null }]).averageDuration, null);
});
test('combined user, team, direction, duration, weekday and time filters intersect', () => {
  const calls = timedCalls([base, { ...base, id: 'other', userIds: ['bob'] }, { ...base, id: 'null-duration', durationSeconds: null }], 'Europe/Paris');
  const filters = { ...defaults(), teamIds: ['team'], userIds: ['alice'], lineIds: ['line'], minDuration: '0', maxDuration: '60', weekdays: [6], startHour: 11, endHour: 12, search: '+33 1 23', direction: 'inbound' };
  const teams = [{ id: 'team', name: 'Support', userIds: ['alice'] }];
  assert.deepEqual(filterCalls(calls, filters, teams).map(call => call.id), ['one']);
  assert.equal(filterCalls(calls, { ...filters, direction: 'outbound' }, teams).length, 0);
  assert.equal(filterCalls(calls, { ...filters, userIds: ['bob'] }, teams).length, 0);
});
test('local dates and repeated DST hours are handled in the selected timezone', () => {
  const calls = timedCalls([{ ...base, createdAt: '2026-10-25T00:30:00Z' }, { ...base, createdAt: '2026-10-25T01:30:00Z' }, { ...base, createdAt: '2026-10-24T22:30:00Z' }], 'Europe/Paris');
  assert.deepEqual(calls.map(call => [call.date, call.hour]), [['2026-10-25', 2], ['2026-10-25', 2], ['2026-10-25', 0]]);
  assert.equal(heatmap(calls, 'volume').find(cell => cell.weekday === 6 && cell.hour === 2).value, 2);
  const filters = { ...defaults(), from: '2026-10-25', to: '2026-10-25' };
  assert.equal(filterCalls(calls, filters, []).length, 3);
  assert.deepEqual(previousPeriod(filters), { from: '2026-10-24', to: '2026-10-24' });
  assert.ok(queryWindow(filters).from < calls[0].createdAt);
});
test('period comparison keeps the same number of calendar days across month boundaries', () => {
  const filters = { ...defaults(), from: '2026-03-01', to: '2026-03-30' };
  assert.deepEqual(previousPeriod(filters), { from: '2026-01-30', to: '2026-02-28' });
  assert.match(validateFilters({ ...filters, from: '' }), /période/);
  assert.match(validateFilters({ ...filters, to: '2026-02-01' }), /période/);
  assert.match(validateFilters({ ...filters, to: '2026-12-01' }), /période/);
  assert.match(validateFilters({ ...filters, minDuration: '70', maxDuration: '60' }), /durées/);
  assert.match(validateFilters({ ...filters, startHour: 12, endHour: 12 }), /heure/);
});
test('heatmap and detail filters represent the exact same set of calls', () => {
  const calls = timedCalls([base, { ...base, status: 'missed', connected: false, durationSeconds: null }], 'Europe/Paris');
  const cell = heatmap(calls, 'missed').find(cell => cell.weekday === 6 && cell.hour === 11);
  assert.equal(cell.value, 1);
  assert.equal(cell.count, 2);
  assert.equal(filterCalls(calls, { ...defaults(), weekdays: [cell.weekday], startHour: cell.hour, endHour: cell.hour + 1 }, []).length, cell.count);
  assert.equal(heatmap([], 'connection')[0].value, null);
});
test('voicemail and unanswered completed calls are not classified as human connections', () => {
  assert.equal(outcome({ ...base, connected: false }), 'unconfirmed');
  assert.equal(outcome({ ...base, connected: false, resultCode: 'voicemail' }), 'voicemail');
  assert.equal(summarize([{ ...base, connected: false, resultCode: 'voicemail', durationSeconds: null }]).connectionRate, 0);
});
test('CSV preserves quotes, unknown durations and protects formula-like cells', () => {
  const result = csv([{ ...base, durationSeconds: null }], { users: [{ id: 'alice', name: '=HYPERLINK("bad")' }], lines: [] }, 'Europe/Paris');
  assert.ok(result.startsWith('\uFEFF'));
  assert.ok(result.includes('"\'+33123456789"'));
  assert.ok(result.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(result.includes(';"";"direct"'));
});
