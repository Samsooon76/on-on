import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const appState = { currentState: 'active' };
mock.module('react-native', { exports: { AppState: appState } });
const { useConversationHistory } = await import('../src/useConversationHistory.ts');

const message = (id: string, status = 'received') => ({ id, direction: 'inbound' as const, body: id, status, provider_error_code: null, created_at: '2026-09-26T09:00:00Z', sent_at: null, delivered_at: null });
const page = (id: string, cursor: string | null = null) => ({ items: [message(id)], nextCursor: cursor });
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('late messages from another conversation or line never replace the open history or mark it read', async () => {
  const pending = new Map<string, ReturnType<typeof deferred>>();
  const reads: string[] = [];
  const api = (path: string) => {
    if (path.endsWith('/read')) { reads.push(path); return Promise.resolve(null); }
    const request = deferred(); pending.set(path, request); return request.promise;
  };
  const onRead = () => {};
  let history: ReturnType<typeof useConversationHistory>;
  const Probe = ({ line, id }: { line: string; id: string }) => { history = useConversationHistory(api, line, id, true, onRead); return null; };
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(createElement(Probe, { line: 'line-a', id: 'a' })); });
  await act(async () => { root.update(createElement(Probe, { line: 'line-b', id: 'b' })); });
  assert.deepEqual(history!.messages, []);
  await act(async () => { pending.get('/v1/conversations/b/messages?limit=50')!.resolve(page('b-message')); });
  await act(async () => { pending.get('/v1/conversations/a/messages?limit=50')!.resolve(page('a-message')); });
  assert.deepEqual(history!.messages.map((item) => item.id), ['b-message']);
  assert.deepEqual(reads, ['/v1/conversations/b/read']);
  await act(async () => root.unmount());
});

test('closing a thread while loading prevents marking hidden messages as read', async () => {
  const request = deferred();
  const reads: string[] = [];
  const api = (path: string) => { if (path.endsWith('/read')) { reads.push(path); return Promise.resolve(null); } return request.promise; };
  const onRead = () => {};
  let history: ReturnType<typeof useConversationHistory>;
  const Probe = ({ visible }: { visible: boolean }) => { history = useConversationHistory(api, 'line-a', 'a', visible, onRead); return null; };
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(createElement(Probe, { visible: true })); });
  await act(async () => { root.update(createElement(Probe, { visible: false })); });
  await act(async () => request.resolve(page('hidden')));
  assert.deepEqual(history!.messages, []);
  assert.deepEqual(reads, []);
  await act(async () => root.unmount());
});

test('paging retains old messages through a refresh and keeps fresh delivery status on overlap', async () => {
  let refreshCount = 0;
  const api = async (path: string) => {
    if (path.endsWith('/read')) return null;
    if (path.includes('cursor=')) return { items: [message('old'), message('recent', 'sent')], nextCursor: null };
    refreshCount += 1;
    return { items: [message('recent', 'delivered'), ...(refreshCount > 1 ? [message('new')] : [])], nextCursor: 'older' };
  };
  const onRead = () => {};
  let history: ReturnType<typeof useConversationHistory>;
  const Probe = () => { history = useConversationHistory(api, 'line', 'a', true, onRead); return null; };
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(createElement(Probe)); });
  assert.equal(history!.hasOlder, true);
  await act(async () => history!.loadOlder());
  await act(async () => history!.refresh());
  assert.deepEqual(history!.messages.map((item) => item.id), ['old', 'recent', 'new']);
  assert.equal(history!.messages.find((item) => item.id === 'recent')!.status, 'delivered');
  assert.equal(history!.hasOlder, false);
  await act(async () => root.unmount());
});

test('message fetch failures are recoverable and a read receipt failure keeps visible messages', async () => {
  let fail = true;
  const api = async (path: string) => { if (fail || path.endsWith('/read')) throw new Error('offline'); return page('recovered'); };
  const onRead = () => assert.fail('read receipt failed');
  let history: ReturnType<typeof useConversationHistory>;
  const Probe = () => { history = useConversationHistory(api, 'line', 'a', true, onRead); return null; };
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(createElement(Probe)); });
  assert.equal(history!.state, 'error');
  fail = false;
  await act(async () => history!.refresh());
  assert.equal(history!.state, 'ready');
  assert.equal(history!.messages[0]!.id, 'recovered');
  await act(async () => root.unmount());
});

test('call-only threads never request a fabricated SMS conversation', async () => {
  const api = async () => assert.fail('no SMS resource exists');
  const onRead = () => assert.fail('no SMS to mark read');
  let history: ReturnType<typeof useConversationHistory>;
  const Probe = () => { history = useConversationHistory(api, 'line', '', true, onRead); return null; };
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(createElement(Probe)); });
  assert.equal(history!.state, 'ready');
  assert.deepEqual(history!.messages, []);
  await act(async () => root.unmount());
});

const noRead = () => {};
// A thread backed by a network that answers only when the test says so.
function heldThreads() {
  const pending = new Map<string, ReturnType<typeof deferred>>();
  const reads: string[] = [];
  const api = (path: string) => {
    if (path.endsWith('/read')) { reads.push(path); return Promise.resolve(null); }
    const request = deferred(); pending.set(path, request); return request.promise;
  };
  const answer = (id: string, result: unknown) => pending.get(`/v1/conversations/${id}/messages?limit=50`)!.resolve(result);
  return { api, answer, reads };
}

test('a reopened thread shows its cached messages at once, merges the fresh ones and keeps them when the refresh fails', async () => {
  const { api, answer } = heldThreads();
  let failing = false;
  const request = ((path: string, init?: RequestInit) => failing ? Promise.reject(new Error('offline')) : api(path)) as Parameters<typeof useConversationHistory>[0];
  let history: ReturnType<typeof useConversationHistory>;
  const Probe = ({ id }: { id: string }) => { history = useConversationHistory(request, 'line', id, true, noRead); return null; };
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(createElement(Probe, { id: 'a' })); });
  await act(async () => answer('a', page('a1', 'older-a')));
  await act(async () => { root.update(createElement(Probe, { id: 'b' })); });
  assert.equal(history!.state, 'loading');
  assert.deepEqual(history!.messages, []);
  await act(async () => answer('b', page('b1')));
  await act(async () => { root.update(createElement(Probe, { id: 'a' })); });
  assert.deepEqual(history!.messages.map((item) => item.id), ['a1']);
  assert.equal(history!.state, 'ready');
  await act(async () => answer('a', { items: [message('a1', 'delivered'), message('a2')], nextCursor: 'ignored' }));
  assert.deepEqual(history!.messages.map((item) => item.id), ['a1', 'a2']);
  assert.equal(history!.messages[0]!.status, 'delivered');
  assert.equal(history!.hasOlder, true);
  failing = true;
  await act(async () => history!.refresh());
  assert.equal(history!.state, 'error');
  assert.deepEqual(history!.messages.map((item) => item.id), ['a1', 'a2']);
  await act(async () => root.unmount());
});

test('a late answer for another conversation is still ignored when the open thread comes from the cache', async () => {
  const { api, answer, reads } = heldThreads();
  let history: ReturnType<typeof useConversationHistory>;
  const Probe = ({ id }: { id: string }) => { history = useConversationHistory(api, 'line', id, true, noRead); return null; };
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(createElement(Probe, { id: 'a' })); });
  await act(async () => answer('a', page('a1')));
  await act(async () => { root.update(createElement(Probe, { id: 'b' })); });
  await act(async () => answer('b', page('b1')));
  await act(async () => { root.update(createElement(Probe, { id: 'a' })); });
  await act(async () => { root.update(createElement(Probe, { id: 'b' })); });
  assert.deepEqual(history!.messages.map((item) => item.id), ['b1']);
  const readsBefore = reads.length;
  await act(async () => answer('a', page('a-late')));
  assert.deepEqual(history!.messages.map((item) => item.id), ['b1']);
  assert.equal(reads.length, readsBefore);
  await act(async () => answer('b', { items: [message('b2')], nextCursor: null }));
  assert.deepEqual(history!.messages.map((item) => item.id), ['b1', 'b2']);
  await act(async () => root.unmount());
});

test('only the 20 most recently used threads are remembered', async () => {
  let held: ReturnType<typeof deferred> | null = null;
  const api = async (path: string) => {
    if (path.endsWith('/read')) return null;
    if (held) return held.promise;
    return page(`${path.split('/')[3]}-message`);
  };
  let history: ReturnType<typeof useConversationHistory>;
  const Probe = ({ id }: { id: string }) => { history = useConversationHistory(api, 'line', id, true, noRead); return null; };
  const open = (id: string) => act(async () => { root.update(createElement(Probe, { id })); });
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(createElement(Probe, { id: 'c1' })); });
  for (let index = 2; index <= 20; index += 1) await open(`c${index}`);
  await open('c1');
  await open('c21');
  held = deferred();
  await open('c2');
  assert.equal(history!.state, 'loading');
  assert.deepEqual(history!.messages, []);
  await open('c1');
  assert.equal(history!.state, 'ready');
  assert.deepEqual(history!.messages.map((item) => item.id), ['c1-message']);
  await open('c21');
  assert.deepEqual(history!.messages.map((item) => item.id), ['c21-message']);
  held.resolve(page('late'));
  await act(async () => root.unmount());
});

test('the cache is dropped when the signed-in user changes', async () => {
  const { api, answer } = heldThreads();
  let history: ReturnType<typeof useConversationHistory>;
  const Probe = ({ user, visible }: { user: string; visible: boolean }) => { history = useConversationHistory(api, 'line', 'a', visible, noRead, user); return null; };
  let root: ReturnType<typeof create>;
  await act(async () => { root = create(createElement(Probe, { user: 'u1', visible: true })); });
  await act(async () => answer('a', page('a1')));
  await act(async () => { root.update(createElement(Probe, { user: 'u1', visible: false })); });
  await act(async () => { root.update(createElement(Probe, { user: 'u1', visible: true })); });
  assert.deepEqual(history!.messages.map((item) => item.id), ['a1']);
  await act(async () => { root.update(createElement(Probe, { user: 'u1', visible: false })); });
  await act(async () => { root.update(createElement(Probe, { user: 'u2', visible: false })); });
  await act(async () => { root.update(createElement(Probe, { user: 'u2', visible: true })); });
  assert.equal(history!.state, 'loading');
  assert.deepEqual(history!.messages, []);
  await act(async () => root.unmount());
});
