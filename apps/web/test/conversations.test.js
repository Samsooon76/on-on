import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInbox, buildTimeline, formatPhone, isMissedCall } from '../src/conversation-model.ts';

const sms = (overrides = {}) => ({ id: 'sms-1', lineId: 'line-a', remoteNumber: '+33612345678', remoteContactName: 'Camille', lastMessageAt: '2026-09-25T10:00:00Z', lastMessage: { id: 'message-1', body: 'À demain', direction: 'inbound', status: 'received', created_at: '2026-09-25T10:00:00Z' }, unread: true, ...overrides });
const call = (overrides = {}) => ({ id: 'call-1', direction: 'inbound', remote_number: '+33612345678', remoteContactName: 'Camille', status: 'completed', created_at: '2026-09-25T11:00:00Z', duration_seconds: 80, ...overrides });

test('calls and SMS for the same number share one thread while preserving SMS identity and unread state', () => {
  const inbox = buildInbox('line-a', [sms()], [call()]);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].smsConversationId, 'sms-1');
  assert.equal(inbox[0].unread, true);
  assert.equal(inbox[0].lastKind, 'call');
  assert.equal(inbox[0].updatedAt, '2026-09-25T11:00:00Z');
  assert.equal(inbox[0].calls.length, 1);
});

test('call-only correspondents appear without a fictitious SMS resource and retain their key after the first SMS', () => {
  const before = buildInbox('line-a', [], [call()])[0];
  const after = buildInbox('line-a', [sms()], [call()])[0];
  assert.equal(before.smsConversationId, null);
  assert.equal(before.key, after.key);
});

test('conversation identity is scoped to the active line, including identical remote numbers', () => {
  const inbox = buildInbox('line-a', [sms(), sms({ id: 'other', lineId: 'line-b' })], []);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].smsConversationId, 'sms-1');
  assert.notEqual(inbox[0].key, buildInbox('line-b', [sms({ lineId: 'line-b' })], [])[0].key);
});

test('latest activity orders the inbox and formatted telephone numbers group correctly', () => {
  const inbox = buildInbox('line-a', [sms({ remoteNumber: '+33 6 12 34 56 78' })], [call(), call({ id: 'second', remote_number: '+33687654321', created_at: '2026-09-25T12:00:00Z' })]);
  assert.equal(inbox.length, 2);
  assert.equal(inbox[0].remoteNumber, '+33687654321');
  assert.equal(inbox[1].smsConversationId, 'sms-1');
});

test('missed-call filter includes missed inbound calls but not unanswered outbound calls', () => {
  assert.equal(isMissedCall(call({ status: 'no-answer' })), true);
  assert.equal(isMissedCall(call({ direction: 'outbound', status: 'no-answer' })), false);
  assert.equal(buildInbox('line-a', [], [call({ status: 'missed' })])[0].hasMissedCall, true);
});

test('the timeline interleaves calls and messages chronologically without ID collisions', () => {
  const events = buildTimeline([{ id: 'call-1', created_at: '2026-09-25T12:00:00Z' }, { id: 'message-2', created_at: '2026-09-25T09:00:00Z' }], [call()]);
  assert.deepEqual(events.map((event) => event.kind), ['message', 'call', 'message']);
  assert.equal(new Set(events.map((event) => event.id)).size, 3);
});

test('phone display preserves international numbers and does not change the stored value', () => {
  assert.equal(formatPhone('+33612345678'), '+33 6 12 34 56 78');
  assert.equal(formatPhone('+32470123456'), '+32470123456');
});
