import test from 'node:test';
import assert from 'node:assert/strict';
import { dialerReducer as reduce, initialDialerState, settingsError, withinCallingHours, nextDialerEntry } from '../src/powerdialer-model.ts';
import { parseDialerCsv, suggestCsvMapping, prepareCsvImport, csvText } from '../src/powerdialer-csv.ts';
import { restoreDialer, serializeDialer, dialerStorageKey } from '../src/powerdialer-storage.ts';

const at = '2026-09-28T10:00:00.000Z';
const later = '2026-09-28T11:00:00.000Z';
const contact = (number = '+33612345678') => ({ id: number, contactId: null, name: 'Camille', number, email: null, phoneLabel: '', initialNotes: 'Contexte CSV' });
const settings = (extra = {}) => ({ ...structuredClone(initialDialerState.settings), retryEnabled: true, ...extra });
const queue = (contacts = [contact()], extra = {}) => reduce(reduce(initialDialerState, { type: 'settings', settings: settings(extra), at }), { type: 'add', contacts, at });
const start = (state, date = at) => reduce(reduce(state, { type: 'start', at: date }), { type: 'started', id: state.activeId, intentId: 'intent-' + date, at: date });
const finish = (state, outcome = 'no-answer', date = at, callbackAt) => reduce(reduce(state, { type: 'qualify', outcome, at: date, delay: 5, callbackAt }), { type: 'ended', at: date, delay: 5 });
const parse = (text, extra = {}) => { const data = parseDialerCsv(text); return prepareCsvImport(data, suggestCsvMapping(data.headers), extra.existing ?? [], extra.excluded ?? [], extra.format ?? 'FR', 'leads.csv'); };

test('CSV supports BOM, French separators, CRLF, escaped quotes and multiline notes', () => {
  const result = parse('\uFEFFnom;prénom;téléphone;entreprise;email;notes\r\nMartin;Camille;06 12 34 56 78;"ACME; France";camille@example.com;"Ligne 1\r\nDit ""oui"""\r\n');
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].name, 'Camille Martin');
  assert.equal(result.contacts[0].number, '+33612345678');
  assert.equal(result.contacts[0].company, 'ACME; France');
  assert.equal(result.contacts[0].initialNotes, 'Ligne 1\r\nDit "oui"');
  assert.equal(result.contacts[0].contactId, null);
});
test('CSV delimiter detection ignores separators inside quoted headers', () => {
  const data = parseDialerCsv('"name, surname, full";telephone\nMartin;+33612345678');
  assert.equal(data.delimiter, ';'); assert.equal(data.headers.length, 2);
});
test('CSV supports commas, tabs, Excel separator directive and no header', () => {
  for (const delimiter of [',', '\t', ';']) assert.equal(parse(`name${delimiter}phone\nCamille${delimiter}+33612345678`).contacts.length, 1);
  assert.equal(parse('sep=;\nname;phone\nCamille;+33612345678').contacts.length, 1);
  const data = parseDialerCsv('Camille;+33612345678\nLéa;+33687654321', false);
  assert.equal(data.rows.length, 2); assert.equal(data.rows[0].line, 1);
});
test('CSV reports duplicates, exclusions, invalid numbers and malformed rows separately', () => {
  const result = parse('nom;telephone\nCamille;0612345678\nDoublon;+33612345678\nExistant;+33687654321\nExclu;+33610203040\nInvalide;#123\nTrop;de;colonnes', { existing: ['+33687654321'], excluded: ['+33610203040'] });
  assert.equal(result.contacts.length, 1); assert.equal(result.duplicates, 2); assert.equal(result.excluded, 1); assert.equal(result.invalid, 2);
  assert.deepEqual(result.issues.map((issue) => issue.line), [3, 4, 5, 6, 7]);
});
test('CSV international-only mode never silently treats a national number as French', () => {
  const result = parse('phone\n0612345678\n00442079460000\n+14155552671\n612345678\n1.2345E+11', { format: 'international' });
  assert.deepEqual(result.contacts.map((item) => item.number), ['+442079460000', '+14155552671']); assert.equal(result.invalid, 3);
});
test('CSV malformed quoting, encoding, empty files and limits produce actionable errors', () => {
  assert.throws(() => parseDialerCsv(''), /vide/);
  assert.throws(() => parseDialerCsv('phone'), /en-têtes/);
  assert.throws(() => parseDialerCsv('phone\n"+33612345678'), /non fermés/);
  assert.throws(() => parseDialerCsv('phone\n"+33612345678"x'), /invalides/);
  assert.throws(() => parseDialerCsv('ph\0one\n1'), /UTF-8/);
  assert.throws(() => parseDialerCsv('a'.repeat(2097153)), /2 Mo/);
  assert.throws(() => parseDialerCsv('phone\n' + Array(1001).fill('+33612345678').join('\n')), /1000/);
  assert.equal(parseDialerCsv('phone\n' + Array(1000).fill('+33612345678').join('\n')).rows.length, 1000);
});
test('CSV reports actual physical row numbers after multiline quoted fields', () => {
  const result = parse('phone,notes\n+33612345678,"one\ntwo"\ninvalid,text');
  assert.equal(result.issues[0].line, 4);
});
test('CSV has no import before telephone mapping and neutralizes spreadsheet formula cells', () => {
  const data = parseDialerCsv('Custom\n+33612345678');
  assert.equal(prepareCsvImport(data, suggestCsvMapping(data.headers), [], [], 'FR', 'file').contacts.length, 0);
  const output = csvText([[' =HYPERLINK("x")', '+33612345678', '@SUM(1)', '-10', 'normal;"quoted"\nnew line']]);
  assert.ok(output.includes('"\' =HYPERLINK')); assert.ok(output.includes('"\'+336')); assert.ok(output.includes('"\'@SUM')); assert.ok(output.includes('"\'-10')); assert.ok(output.includes('"normal;""quoted""\nnew line"'));
});
test('retries wait until due, preserve history and stop at maximum total attempts', () => {
  let state = queue([contact()], { maxAttempts: 2 });
  state = finish(start(state));
  assert.equal(state.phase, 'waiting'); assert.equal(state.running, false); assert.equal(state.entries[0].nextAttemptAt, later);
  assert.equal(state.entries[0].attempts.length, 1); assert.equal(state.entries[0].attempts[0].intentId, 'intent-' + at);
  assert.equal(state.entries[0].attempts[0].notes, 'Contexte CSV');
  assert.equal(reduce(state, { type: 'start', at }).phase, 'waiting');
  state = reduce(state, { type: 'refresh', at: later }); assert.equal(state.phase, 'ready'); assert.equal(state.running, false);
  state = finish(start(state, later), 'no-answer', later);
  assert.equal(state.phase, 'complete'); assert.equal(state.entries[0].attempts.length, 2); assert.equal(state.entries[0].nextAttemptAt, null);
  assert.equal(state.entries[0].attempts[0].attemptedAt, at);
});
test('retry disposition rules are independent and terminal outcomes never retry', () => {
  for (const outcome of ['interested', 'not-interested', 'wrong-number', 'do-not-call', 'voicemail']) assert.equal(finish(start(queue()), outcome).phase, 'complete');
  assert.equal(finish(start(queue()), 'busy').entries[0].nextAttemptAt, '2026-09-28T10:15:00.000Z');
  assert.equal(finish(start(queue([contact()], { retryEnabled: false }))).phase, 'complete');
});
test('callbacks require a future date and work independently of automatic retry limits', () => {
  let state = start(queue([contact()], { maxAttempts: 1, retryEnabled: false }));
  state = reduce(state, { type: 'qualify', outcome: 'callback', delay: 5, at, callbackAt: at });
  assert.equal(state.phase, 'calling'); assert.match(state.error, /futur/);
  state = finish(state, 'callback', at, later);
  assert.equal(state.entries[0].scheduleKind, 'callback'); assert.equal(state.entries[0].nextAttemptAt, later);
  const renewed = reduce(state, { type: 'reschedule', id: contact().id, at, scheduledAt: '2026-09-29T10:00:00Z' });
  assert.equal(renewed.entries[0].nextAttemptAt, '2026-09-29T10:00:00Z');
  assert.equal(reduce(renewed, { type: 'reschedule', id: contact().id, at, scheduledAt: null }).phase, 'complete');
});
test('due callbacks precede new contacts and retry priority is configurable', () => {
  const second = contact('+33687654321');
  let state = finish(start(queue([contact(), second])));
  assert.equal(nextDialerEntry(state, later).id, second.id);
  state = { ...state, settings: settings({ priority: 'retries-first' }) };
  assert.equal(nextDialerEntry(state, later).id, contact().id);
  const callback = finish(start(queue([contact(), second])), 'callback', at, later);
  assert.equal(nextDialerEntry(callback, later).id, contact().id);
});
test('lowering attempt cap or disabling a rule cancels pending automatic retries, preserving callbacks', () => {
  const state = finish(start(queue()));
  for (const patch of [{ retryEnabled: false }, { maxAttempts: 1 }, { retryMinutes: { 'no-answer': null, busy: 15, voicemail: null } }]) {
    const updated = reduce(state, { type: 'settings', settings: settings(patch), at });
    assert.equal(updated.entries[0].status, 'done'); assert.equal(updated.entries[0].attempts.length, 1);
  }
  const callback = finish(start(queue()), 'callback', at, later);
  assert.equal(reduce(callback, { type: 'settings', settings: settings({ retryEnabled: false }), at }).entries[0].status, 'scheduled');
});
test('DNC exclusion survives reset and rejects both directory and CSV additions', () => {
  let state = finish(start(queue()), 'do-not-call');
  state = reduce(state, { type: 'reset' });
  assert.deepEqual(state.excludedNumbers, [contact().number]);
  state = reduce(state, { type: 'add', contacts: [contact()], at });
  assert.equal(state.entries.length, 0);
});
test('calling windows use chosen time zone, weekdays and DST; end time is exclusive', () => {
  const config = settings({ hours: { enabled: true, timeZone: 'Europe/Paris', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' } });
  assert.equal(withinCallingHours(config, '2026-09-28T07:00:00Z'), true);
  assert.equal(withinCallingHours(config, '2026-09-28T16:00:00Z'), false);
  assert.equal(withinCallingHours(config, '2026-09-26T10:00:00Z'), false);
  assert.equal(withinCallingHours(config, '2026-11-02T07:30:00Z'), false);
  assert.equal(withinCallingHours(config, '2026-11-02T08:00:00Z'), true);
  const state = queue([contact()], config);
  assert.equal(reduce(state, { type: 'start', at: '2026-09-28T17:00:00Z' }).phase, 'waiting');
});
test('window closure stops countdown, does not cut a live call and never auto-resumes', () => {
  const config = settings({ hours: { enabled: true, timeZone: 'UTC', days: [1], start: '10:00', end: '11:00' } });
  const calling = start(queue([contact(), contact('+33687654321')], config));
  assert.equal(reduce(calling, { type: 'refresh', at: later }), calling);
  const between = finish(calling, 'interested');
  const waiting = reduce(between, { type: 'refresh', at: later });
  assert.equal(waiting.phase, 'waiting'); assert.equal(waiting.running, false);
  const ready = reduce(waiting, { type: 'refresh', at: '2026-10-05T10:00:00Z' });
  assert.equal(ready.phase, 'ready'); assert.equal(ready.running, false);
});
test('invalid retry settings and timezone cannot alter an existing campaign', () => {
  for (const extra of [{ maxAttempts: 0 }, { maxAttempts: 11 }, { delay: 0 }, { retryMinutes: { busy: -1 } }, { hours: { enabled: true, timeZone: 'invalid', days: [1], start: '09:00', end: '18:00' } }]) assert.ok(settingsError(settings(extra)));
});
test('preparation failure does not consume the next attempt or erase previous attempt history', () => {
  let state = finish(start(queue()));
  state = reduce(state, { type: 'refresh', at: later });
  state = reduce(state, { type: 'start', at: later });
  state = reduce(state, { type: 'failed', message: 'Microphone bloqué' });
  assert.equal(state.entries[0].attempts.length, 1); assert.equal(state.running, false);
  assert.equal(state.entries[0].attempts[0].outcome, 'no-answer');
});
test('late start correlation updates the finished attempt without changing active contact', () => {
  let state = reduce(queue([contact(), contact('+33687654321')]), { type: 'start', at });
  state = reduce(state, { type: 'ended', at, delay: 5 });
  state = reduce(state, { type: 'qualify', outcome: 'interested', at, delay: 5 });
  state = reduce(state, { type: 'started', id: contact().id, intentId: 'late', at });
  assert.equal(state.entries[0].attempts[0].intentId, 'late'); assert.equal(state.activeId, '+33687654321');
});
test('persistence restores paused, keeps scheduled callbacks, exclusions and settings', () => {
  const state = finish(start(queue()), 'callback', at, later);
  const restored = restoreDialer(serializeDialer(state), at);
  assert.equal(restored.phase, 'waiting'); assert.equal(restored.running, false); assert.equal(restored.settings.retryEnabled, true);
  assert.equal(restored.entries[0].nextAttemptAt, later);
  const due = restoreDialer(serializeDialer(state), later);
  assert.equal(due.phase, 'ready'); assert.equal(due.running, false);
  const excluded = finish(start(queue()), 'do-not-call');
  assert.deepEqual(restoreDialer(serializeDialer(excluded), at).excludedNumbers, [contact().number]);
});
test('interrupted calls restore to explicit qualification, never to an automatic redial', () => {
  const restored = restoreDialer(serializeDialer(start(queue())), later);
  assert.equal(restored.phase, 'wrapup'); assert.equal(restored.running, false); assert.equal(restored.entries[0].attempts.length, 1);
  assert.equal(reduce(restored, { type: 'start', at: later }), restored);
});
test('storage separates all three context identifiers and refuses corrupt data', () => {
  const scope = { userId: 'u', organizationId: 'o', lineId: 'l' };
  for (const property of Object.keys(scope)) assert.notEqual(dialerStorageKey(scope), dialerStorageKey({ ...scope, [property]: 'other' }));
  assert.throws(() => restoreDialer('{broken', at));
  assert.throws(() => restoreDialer(JSON.stringify({ version: 1, state: queue() }), at));
  const corrupt = queue(); corrupt.entries[0].number = 'invalid';
  assert.throws(() => restoreDialer(serializeDialer(corrupt), at));
});
test('capacity limits reject the whole addition without silently dropping contacts', () => {
  const contacts = Array.from({ length: 1001 }, (_, index) => contact('+336' + String(index).padStart(8, '0')));
  const state = queue(contacts);
  assert.equal(state.entries.length, 0); assert.match(state.error, /1000/);
});
