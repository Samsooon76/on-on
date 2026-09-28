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

test('each list is reported as soon as its page arrives, without waiting for the other one', async () => {
  const requests = new Map<string, (page: unknown) => void>();
  const api = <T>(path: string): Promise<T> => new Promise((resolve) => requests.set(path, resolve as (page: unknown) => void));
  const seen: string[] = [];
  const loading = loadLineHistory(api, 'line', { can_voice: true, can_sms: true }, {
    onConversations: (page) => seen.push(`conversations:${page.items[0]!.id}`),
    onCalls: (page) => seen.push(`calls:${page.items[0]!.id}`),
  });
  requests.get('/v1/lines/line/conversations?limit=50')!(conversationPage);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['conversations:sms-1']);
  requests.get('/v1/lines/line/calls?limit=50')!(callPage);
  assert.deepEqual(await loading, { calls: callPage, conversations: conversationPage });
  assert.deepEqual(seen, ['conversations:sms-1', 'calls:call-1']);
});

test('a list without permission is reported empty without a request, and a failing list rejects after the other was reported', async () => {
  const reported: unknown[] = [];
  await loadLineHistory(async () => assert.fail('history is not authorized'), 'line', { can_voice: false, can_sms: false }, {
    onConversations: (page) => reported.push(page), onCalls: (page) => reported.push(page),
  });
  assert.deepEqual(reported, [emptyPage, emptyPage]);
  const api = async <T>(path: string): Promise<T> => { if (path.includes('/calls?')) throw new Error('Ligne introuvable.'); return conversationPage as T; };
  const seen: string[] = [];
  await assert.rejects(loadLineHistory(api, 'line', { can_voice: true, can_sms: true }, { onConversations: () => seen.push('conversations'), onCalls: () => seen.push('calls') }), /Ligne introuvable/);
  assert.deepEqual(seen, ['conversations']);
});
