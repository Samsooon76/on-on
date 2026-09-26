import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInbox, buildTimeline, type CallRecord, type Conversation } from '@onoff/api-client';
import { filterInbox, mergeRecords } from '../src/conversation-model.ts';

const call: CallRecord = { id: 'call-1', direction: 'inbound', remote_number: '+32470123456', remoteContactName: 'Camille', status: 'no-answer', created_at: '2026-09-26T10:00:00Z', duration_seconds: null };
const sms: Conversation = { id: 'sms-1', lineId: 'line-a', remoteNumber: '+32 470 12 34 56', remoteContactName: 'Camille', lastMessageAt: '2026-09-26T09:00:00Z', unread: true, lastMessage: { id: 'message-1', body: 'Bonjour, à demain', direction: 'outbound', status: 'sent', created_at: '2026-09-26T09:00:00Z' } };

test('mobile keeps the same thread when a call-only correspondent receives their first SMS', () => {
  const before = buildInbox('line-a', [], [call])[0]!;
  const after = buildInbox('line-a', [sms], [call])[0]!;
  assert.equal(before.key, after.key);
  assert.equal(before.smsConversationId, null);
  assert.equal(after.smsConversationId, sms.id);
  assert.equal(after.unread, true);
  assert.equal(after.preview, 'Appel manqué');
});

test('conversation filters combine unread or missed calls with names and formatted number searches', () => {
  const inbox = buildInbox('line-a', [sms], [call, { ...call, id: 'other', remote_number: '+33612345678', remoteContactName: 'Alex', direction: 'outbound' }]);
  assert.equal(filterInbox(inbox, ' CAMILLE ', 'unread').length, 1);
  assert.equal(filterInbox(inbox, '470 12-34', 'missed').length, 1);
  assert.equal(filterInbox(inbox, 'Alex', 'missed').length, 0);
  assert.equal(filterInbox(inbox, '', 'all').length, 2);
  assert.equal(filterInbox(buildInbox('line-a', [sms], []), 'à demain', 'all').length, 1);
});

test('fresh delivery states replace stale records without losing loaded history or duplicating events', () => {
  const current = [{ id: 'old', status: 'received' }, { id: 'new', status: 'sent' }];
  const merged = mergeRecords(current, [{ id: 'new', status: 'delivered' }, { id: 'incoming', status: 'received' }]);
  assert.deepEqual(merged, [{ id: 'old', status: 'received' }, { id: 'new', status: 'delivered' }, { id: 'incoming', status: 'received' }]);
  assert.equal(current[1]!.status, 'sent');
});

test('older pages do not overwrite fresher statuses and overlapping calls appear once in chronological order', () => {
  const calls = mergeRecords([{ ...call, status: 'ringing' }, { ...call, id: 'old', created_at: '2026-09-25T10:00:00Z' }], [call]);
  const events = buildTimeline([], calls);
  assert.deepEqual(events.map((event) => event.id), ['call:old', 'call:call-1']);
  assert.equal(calls.find((item) => item.id === call.id)?.status, 'no-answer');
});

test('the same number on another line has an independent conversation and unread state', () => {
  const inbox = buildInbox('line-b', [sms, { ...sms, lineId: 'line-b', id: 'sms-2', unread: false }], []);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]!.smsConversationId, 'sms-2');
  assert.equal(filterInbox(inbox, '', 'unread').length, 0);
});
