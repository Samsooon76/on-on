import test from 'node:test';
import assert from 'node:assert/strict';
import { dialerContacts, dialerReducer as reduce, initialDialerState } from '../src/powerdialer-model.ts';
const at = '2026-09-26T10:00:00Z';
const contacts = ['+33612345678', '+33687654321', '+33610203040'].map((number, i) => ({ id: number, contactId: `contact-${i}`, name: `Contact ${i}`, number, email: null, phoneLabel: 'Mobile' }));
const queue = () => reduce(initialDialerState, { type: 'add', contacts });
const start = (state = queue()) => reduce(reduce(state, { type: 'start', at }), { type: 'started', id: state.activeId, intentId: 'intent-1' });
const end = (state, extra = {}) => reduce(state, { type: 'ended', at, delay: 5, ...extra });
const qualify = (state, extra = {}) => reduce(state, { type: 'qualify', outcome: 'interested', at, delay: 5, ...extra });

test('queue normalizes numbers, excludes invalid numbers and deduplicates across contacts and batches', () => {
  const candidates = dialerContacts([{ id: 'a', display_name: 'Camille', email: null, contact_phones: [{ phone_number: '06 12 34 56 78', label: 'Mobile' }, { phone_number: 'invalid' }] }, { id: 'b', display_name: 'Duplicate', contact_phones: [{ phone_number: '+33612345678' }] }]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].number, '+33612345678');
  const state = reduce(queue(), { type: 'add', contacts: [...contacts, ...candidates] });
  assert.equal(state.entries.length, 3);
});

test('one-click qualification waits for confirmed hangup before scheduling another call', () => {
  const calling = start();
  const ending = qualify(calling);
  assert.equal(ending.phase, 'ending');
  assert.equal(ending.activeId, contacts[0].id);
  assert.equal(reduce(ending, { type: 'start', at }), ending);
  const next = end(ending);
  assert.equal(next.phase, 'between');
  assert.equal(next.remaining, 5);
  assert.equal(next.activeId, contacts[1].id);
  assert.equal(next.entries[0].status, 'done');
  assert.equal(next.entries[0].qualificationSource, 'manual');
  assert.equal(next.entries[0].intentId, 'intent-1');
});

test('an ended call requires explicit classification and never infers an argued or interested call', () => {
  const state = end(start());
  assert.equal(state.phase, 'wrapup');
  assert.equal(state.entries[0].outcome, null);
  assert.equal(state.activeId, contacts[0].id);
  assert.equal(reduce(state, { type: 'tick' }), state);
  assert.equal(reduce(state, { type: 'skip' }), state);
  assert.equal(qualify(state, { outcome: 'no-answer' }).entries[0].outcome, 'no-answer');
});

test('double start, repeated qualification, and duplicate end events do not advance twice', () => {
  const calling = start();
  assert.equal(reduce(calling, { type: 'start', at }), calling);
  const ending = qualify(calling);
  assert.equal(qualify(ending, { outcome: 'callback' }), ending);
  const next = end(ending);
  assert.equal(end(next), next);
  assert.equal(next.entries.filter((entry) => entry.status === 'done').length, 1);
});

test('pause during a call preserves notes and classification, prevents automatic next call', () => {
  let state = reduce(start(), { type: 'notes', id: contacts[0].id, notes: 'Rappeler jeudi' });
  state = reduce(state, { type: 'pause' });
  state = end(qualify(state, { outcome: 'callback' }));
  assert.equal(state.phase, 'ready');
  assert.equal(state.running, false);
  assert.equal(state.entries[0].notes, 'Rappeler jeudi');
  assert.equal(state.entries[0].outcome, 'callback');
});

test('pause cancels the countdown and timer ticks cannot restart it', () => {
  const state = reduce(end(qualify(start())), { type: 'pause' });
  assert.equal(state.phase, 'ready');
  assert.equal(state.remaining, 0);
  assert.equal(reduce(state, { type: 'tick' }), state);
});

test('manual mode prepares the next contact without starting a countdown', () => {
  const state = qualify(end(start()), { delay: 0 });
  assert.equal(state.phase, 'ready');
  assert.equal(state.remaining, 0);
  assert.equal(state.running, false);
});

test('failed connection keeps the same contact available for an explicit retry', () => {
  const state = reduce(start(), { type: 'failed', message: 'Microphone bloqué' });
  assert.equal(state.phase, 'ready');
  assert.equal(state.running, false);
  assert.equal(state.activeId, contacts[0].id);
  assert.equal(state.entries[0].status, 'pending');
  assert.equal(state.error, 'Microphone bloqué');
});

test('call failure pauses the session even if the salesperson already chose an outcome', () => {
  const state = end(qualify(start()), { failed: true });
  assert.equal(state.running, false);
  assert.equal(state.phase, 'ready');
});

test('skip does not create a call attempt and the last result completes the session', () => {
  let state = reduce(queue(), { type: 'skip' });
  assert.equal(state.entries[0].attemptedAt, null);
  state = reduce(state, { type: 'skip' });
  state = end(qualify(start(state)));
  assert.equal(state.phase, 'complete');
  assert.equal(state.activeId, null);
  assert.equal(state.running, false);
});

test('a fast hangup still retains the intent when start resolves afterwards', () => {
  let state = reduce(queue(), { type: 'start', at });
  state = end(state);
  state = reduce(state, { type: 'started', id: contacts[0].id, intentId: 'late-intent' });
  assert.equal(state.phase, 'wrapup');
  assert.equal(state.entries[0].intentId, 'late-intent');
});

test('queue edits and reset cannot remove an active or unclassified call', () => {
  for (const state of [start(), end(start())]) {
    assert.equal(reduce(state, { type: 'remove', id: contacts[0].id }), state);
    assert.equal(reduce(state, { type: 'reset' }), state);
  }
});
