import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot, type CallRecord, type Conversation } from '@onoff/api-client';

const keychain = new Map<string, string>();
const keychainWrites: { key: string; options: unknown }[] = [];
mock.module('expo-secure-store', {
  exports: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: async (key: string) => keychain.get(key) ?? null,
    setItemAsync: async (key: string, value: string, options: unknown) => { keychainWrites.push({ key, options }); keychain.set(key, value); },
    deleteItemAsync: async (key: string) => { keychain.delete(key); },
  },
});
const { CHUNK_SIZE, splitChunks, joinChunks, loadSnapshot, saveSnapshot, clearSnapshot, snapshotSignature } = await import('../src/workspace-snapshot.ts');

const now = Date.parse('2026-09-28T12:00:00Z');
const organizations = [{ organization_id: 'org', role: 'admin', organizations: { id: 'org', name: 'Onoff' } }];
const lines = [{ can_voice: true, can_sms: true, lines: { id: 'line', organization_id: 'org', phone_number: '+32470000000', voice_enabled: true, sms_enabled: true } }];
const conversation = (index: number, body: string): Conversation => ({
  id: `sms-${index}`, lineId: 'line', remoteNumber: `+3247000${String(index).padStart(4, '0')}`, remoteContactName: `Contact é ${index}`, lastMessageAt: new Date(now - index * 60_000).toISOString(),
  lastMessage: { id: `message-${index}`, body, direction: 'inbound', status: 'received', created_at: new Date(now - index * 60_000).toISOString() }, unread: index % 2 === 0,
});
const call = (index: number): CallRecord => ({ id: `call-${index}`, direction: 'inbound', remote_number: `+3247000${String(index).padStart(4, '0')}`, remoteContactName: null, status: 'completed', created_at: new Date(now - index * 60_000).toISOString(), duration_seconds: 30 });
const snapshotOf = (userId: string, conversationCount: number, body = 'Bonjour 👋 à demain') => createSnapshot({
  userId, organizationId: 'org', lineId: 'line', organizations, lines,
  conversations: Array.from({ length: conversationCount }, (_, index) => conversation(index, body)),
  calls: Array.from({ length: Math.min(conversationCount, 5) }, (_, index) => call(index)),
}, now);

function memoryStorage(broken: Array<'getItem' | 'setItem' | 'deleteItem'> = []) {
  const items = new Map<string, string>();
  const guard = (operation: 'getItem' | 'setItem' | 'deleteItem') => { if (broken.includes(operation)) throw new Error(`keychain ${operation} failed`); };
  return {
    items,
    storage: {
      getItem: async (key: string) => { guard('getItem'); return items.get(key) ?? null; },
      setItem: async (key: string, value: string) => { guard('setItem'); items.set(key, value); },
      deleteItem: async (key: string) => { guard('deleteItem'); items.delete(key); },
    },
  };
}

test('chunks are bounded, keep emoji whole and join back to the original text', () => {
  const text = `${'a'.repeat(CHUNK_SIZE - 1)}👋${'é'.repeat(3000)}`;
  const chunks = splitChunks(text);
  assert.ok(chunks.length > 1 && chunks.every((chunk) => chunk.length <= CHUNK_SIZE));
  assert.ok(chunks.every((chunk) => !/[\ud800-\udbff]$/.test(chunk) && !/^[\udc00-\udfff]/.test(chunk)));
  assert.equal(joinChunks(chunks), text);
  assert.deepEqual(splitChunks(''), []);
});

test('a saved snapshot loads back unchanged, in bounded keychain values with valid key names', async () => {
  const { storage, items } = memoryStorage();
  const snapshot = snapshotOf('user-1', 40);
  assert.equal(await saveSnapshot(snapshot, storage), true);
  assert.ok(items.size > 2, 'a 40 conversation snapshot spans several chunks');
  assert.ok([...items].every(([key, value]) => /^[\w.-]+$/.test(key) && value.length < CHUNK_SIZE + 40));
  assert.deepEqual(await loadSnapshot('user-1', storage, now), snapshot);
});

test('a partially written snapshot is ignored and removed', async () => {
  const { storage, items } = memoryStorage();
  await saveSnapshot(snapshotOf('user-1', 40), storage, 'first');
  const chunkKey = [...items.keys()].find((key) => key.endsWith('.1'))!;
  items.set(chunkKey, `other:${items.get(chunkKey)!.split(':').slice(1).join(':')}`);
  assert.equal(await loadSnapshot('user-1', storage, now), null);
  assert.equal(items.size, 0);
  await saveSnapshot(snapshotOf('user-1', 40), storage, 'second');
  items.delete(chunkKey);
  assert.equal(await loadSnapshot('user-1', storage, now), null);
  assert.equal(items.size, 0);
});

test('a write interrupted after its meta entry reads as no snapshot, and the next write repairs it', async () => {
  const { storage, items } = memoryStorage();
  await saveSnapshot(snapshotOf('user-1', 40), storage, 'old');
  let writes = 0;
  const interrupted = { ...storage, setItem: async (key: string, value: string) => { if (writes++ > 0) throw new Error('killed'); await storage.setItem(key, value); } };
  assert.equal(await saveSnapshot(snapshotOf('user-1', 40, 'Nouveau message'), interrupted, 'new'), false);
  assert.equal(await loadSnapshot('user-1', storage, now), null);
  assert.equal(items.size, 0);
  const snapshot = snapshotOf('user-1', 40, 'Nouveau message');
  assert.equal(await saveSnapshot(snapshot, storage), true);
  assert.deepEqual(await loadSnapshot('user-1', storage, now), snapshot);
});

test('a shorter snapshot deletes the chunks beyond its new count', async () => {
  const { storage, items } = memoryStorage();
  await saveSnapshot(snapshotOf('user-1', 40), storage);
  const long = items.size;
  const short = snapshotOf('user-1', 1);
  await saveSnapshot(short, storage);
  assert.ok(items.size < long);
  assert.equal(items.size, 1 + Number(JSON.parse(items.get([...items.keys()].find((key) => key.endsWith('.meta'))!)!).count));
  assert.deepEqual(await loadSnapshot('user-1', storage, now), short);
});

test('another user never reads a snapshot, even copied under their own keys', async () => {
  const { storage, items } = memoryStorage();
  await saveSnapshot(snapshotOf('user-1', 5), storage);
  assert.equal(await loadSnapshot('user-2', storage, now), null);
  for (const [key, value] of [...items]) items.set(key.replace('user-1', 'user-2'), value);
  assert.equal(await loadSnapshot('user-2', storage, now), null);
  assert.ok(await loadSnapshot('user-1', storage, now));
});

test('clearing removes the meta entry and every chunk of that user only', async () => {
  const { storage, items } = memoryStorage();
  await saveSnapshot(snapshotOf('user-1', 40), storage);
  await saveSnapshot(snapshotOf('user-2', 3), storage);
  await clearSnapshot('user-1', storage);
  assert.ok([...items.keys()].every((key) => key.includes('user-2')));
  assert.equal(await loadSnapshot('user-1', storage, now), null);
  assert.ok(await loadSnapshot('user-2', storage, now));
  await clearSnapshot('user-2', storage);
  assert.equal(items.size, 0);
});

test('a clear requested while a write is running wins over that write', async () => {
  const { storage, items } = memoryStorage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = { ...storage, setItem: async (key: string, value: string) => { await gate; await storage.setItem(key, value); } };
  const saving = saveSnapshot(snapshotOf('user-1', 40), slow);
  const clearing = clearSnapshot('user-1', slow);
  release();
  await Promise.all([saving, clearing]);
  assert.equal(items.size, 0);
});

test('a keychain that fails never makes these functions throw', async () => {
  for (const broken of [['getItem'], ['setItem'], ['deleteItem'], ['getItem', 'setItem', 'deleteItem']] as const) {
    const { storage } = memoryStorage([...broken]);
    const saved = await saveSnapshot(snapshotOf('user-1', 3), storage);
    assert.equal(saved, !broken.includes('setItem') && !broken.includes('getItem'));
    const loaded = await loadSnapshot('user-1', storage, now);
    if (broken.includes('getItem') || broken.includes('setItem')) assert.equal(loaded, null);
    await clearSnapshot('user-1', storage);
  }
});

test('the device keychain is the default storage and keeps snapshots on this device', async () => {
  const snapshot = snapshotOf('user-1', 3);
  assert.equal(await saveSnapshot(snapshot), true);
  assert.ok(keychainWrites.length > 0 && keychainWrites.every(({ key, options }) => /^[\w.-]+$/.test(key) && (options as { keychainAccessible: number }).keychainAccessible === 6));
  assert.deepEqual(await loadSnapshot('user-1', undefined, now), snapshot);
  await clearSnapshot('user-1');
  assert.equal(keychain.size, 0);
});

test('an expired snapshot is not used, and the content signature ignores when it was written', async () => {
  const { storage, items } = memoryStorage();
  await saveSnapshot(snapshotOf('user-1', 3), storage);
  assert.equal(await loadSnapshot('user-1', storage, now + 8 * 24 * 60 * 60 * 1000), null);
  assert.equal(items.size, 0);
  const later = createSnapshot({ userId: 'user-1', organizationId: 'org', lineId: 'line', organizations, lines, conversations: [], calls: [] }, now + 1000);
  const earlier = createSnapshot({ userId: 'user-1', organizationId: 'org', lineId: 'line', organizations, lines, conversations: [], calls: [] }, now);
  assert.equal(snapshotSignature(later), snapshotSignature(earlier));
  assert.notEqual(snapshotSignature(later), snapshotSignature(snapshotOf('user-1', 3)));
});
