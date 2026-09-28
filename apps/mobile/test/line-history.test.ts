import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiPage, CallRecord, Conversation } from '@onoff/api-client';
import { loadLineHistory } from '../src/line-history.ts';

const callPage: ApiPage<CallRecord> = {
  items: [{ id: 'call-1', direction: 'outbound', remote_number: '+33612345678', remoteContactName: null, status: 'completed', duration_seconds: 30, created_at: '2026-09-28T09:00:00Z' }],
  nextCursor: 'older-calls',
};
const conversationPage: ApiPage<Conversation> = {
  items: [{ id: 'sms-1', lineId: 'line', remoteNumber: '+33612345678', remoteContactName: null, lastMessage: null, lastMessageAt: '2026-09-28T09:00:00Z', unread: false }],
  nextCursor: 'older-conversations',
};
const emptyPage = { items: [], nextCursor: null };

test('selecting a French voice-only line loads calls without requesting forbidden SMS history', async () => {
  const requested: string[] = [];
  const api = async <T>(path: string): Promise<T> => {
    requested.push(path);
    if (path.includes('/conversations')) throw new Error('Ligne introuvable.');
    return callPage as T;
  };

  const history = await loadLineHistory(api, 'french-line', { can_voice: true, can_sms: false });
  assert.deepEqual(requested, ['/v1/lines/french-line/calls?limit=50']);
  assert.deepEqual(history, { calls: callPage, conversations: emptyPage });
});

test('an SMS-only assignment loads conversations without requesting forbidden calls', async () => {
  const api = async <T>(path: string): Promise<T> => {
    assert.equal(path, '/v1/lines/line/conversations?limit=50');
    return conversationPage as T;
  };
  assert.deepEqual(await loadLineHistory(api, 'line', { can_voice: false, can_sms: true }), {
    calls: emptyPage, conversations: conversationPage,
  });
});

test('a line with both permissions preserves both histories and pagination cursors', async () => {
  const api = async <T>(path: string): Promise<T> => (path.includes('/calls?') ? callPage : conversationPage) as T;
  assert.deepEqual(await loadLineHistory(api, 'line', { can_voice: true, can_sms: true }), {
    calls: callPage, conversations: conversationPage,
  });
});

test('a refresh after both permissions are removed returns empty histories without requests', async () => {
  const api = async <T>(): Promise<T> => assert.fail('history is no longer authorized');
  assert.deepEqual(await loadLineHistory(api, 'line', { can_voice: false, can_sms: false }), {
    calls: emptyPage, conversations: emptyPage,
  });
});

test('failures for an authorized history are still reported', async () => {
  const api = async <T>(): Promise<T> => { throw new Error('Ligne introuvable.'); };
  await assert.rejects(loadLineHistory(api, 'line', { can_voice: true, can_sms: false }), /Ligne introuvable/);
});
