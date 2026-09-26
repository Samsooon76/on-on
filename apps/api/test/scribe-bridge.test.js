import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { ScribeBridge, scribeUrl } from '../dist/scribe-bridge.js';

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = []; closed = false;
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.emit('close'); }
  receive(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}
function fixture(t) {
  const sockets = [], errors = [], changes = [];
  let ready = 0;
  const bridge = new ScribeBridge({ key: 'server-secret', offsetMs: 5000, language: 'fr', openSocket: (url, key) => {
    assert.equal(key, 'server-secret'); assert.ok(!url.includes(key));
    const socket = new Socket(); sockets.push(socket); return socket;
  }, onReady: () => ready++, onChange: (snapshot) => changes.push(structuredClone(snapshot)), onError: (error) => errors.push(error) });
  t.after(() => bridge.dispose());
  return { bridge, sockets, errors, changes, ready: () => ready };
}
test('Scribe uses telephony audio, VAD, auto-language by default and server-only auth', () => {
  const url = new URL(scribeUrl());
  assert.equal(url.searchParams.get('audio_format'), 'ulaw_8000');
  assert.equal(url.searchParams.get('model_id'), 'scribe_v2_realtime');
  assert.equal(url.searchParams.get('commit_strategy'), 'vad');
  assert.equal(url.searchParams.has('language_code'), false);
});
test('buffers until session_started, splits speakers and drops duplicate media chunks', t => {
  const { bridge, sockets, ready } = fixture(t);
  bridge.audio('inbound', '////', 120, 1);
  bridge.audio('inbound', '////', 120, 1);
  bridge.audio('outbound', 'AAAA', 150, 1);
  assert.equal(sockets[0].sent.length, 0);
  sockets[0].receive({ message_type: 'session_started' }); assert.equal(ready(), 0);
  sockets[1].receive({ message_type: 'session_started' }); assert.equal(ready(), 1);
  assert.equal(sockets[0].sent.length, 1); assert.equal(sockets[1].sent.length, 1);
  assert.equal(sockets[0].sent[0].audio_base_64, '////');
  assert.equal(sockets[1].sent[0].audio_base_64, 'AAAA');
});
test('partials replace each other; commits persist once and ignore the additional timestamp event', t => {
  const { bridge, sockets } = fixture(t);
  sockets.forEach(socket => socket.receive({ message_type: 'session_started' }));
  bridge.audio('inbound', '////', 100, 1);
  sockets[0].receive({ message_type: 'partial_transcript', text: 'Bon' });
  const id = bridge.snapshot.partials.local.id;
  sockets[0].receive({ message_type: 'partial_transcript', text: 'Bonjour' });
  assert.equal(bridge.snapshot.partials.local.id, id);
  assert.equal(bridge.snapshot.segments.length, 0);
  sockets[0].receive({ message_type: 'committed_transcript', text: 'Bonjour.' });
  sockets[0].receive({ message_type: 'committed_transcript_with_timestamps', text: 'Bonjour.', words: [] });
  sockets[1].receive({ message_type: 'committed_transcript', text: 'Bonsoir.' });
  assert.equal(bridge.snapshot.segments.length, 2);
  assert.equal(bridge.snapshot.segments[0].id, id);
  assert.equal(bridge.snapshot.segments[0].offsetMs, 5100);
  assert.deepEqual(bridge.snapshot.segments.map(row => row.speaker), ['local', 'remote']);
  assert.equal(bridge.snapshot.partials.local, null);
});
test('stop flushes a final short phrase and waits for the provider commit before closing', async t => {
  const { bridge, sockets } = fixture(t);
  sockets.forEach(socket => socket.receive({ message_type: 'session_started' }));
  bridge.audio('outbound', 'AAAA', 250, 1);
  sockets[1].receive({ message_type: 'partial_transcript', text: 'Au revoir' });
  const finishing = bridge.finish();
  assert.equal(sockets[1].sent.at(-1).commit, true);
  assert.equal(sockets[1].closed, false);
  sockets[1].receive({ message_type: 'committed_transcript', text: 'Au revoir.' });
  await finishing;
  assert.equal(bridge.snapshot.segments[0].text, 'Au revoir.');
  assert.ok(sockets.every(socket => socket.closed));
});
test('quota errors close both sessions once and do not expose provider input', t => {
  const { sockets, errors } = fixture(t);
  sockets[0].receive({ message_type: 'quota_exceeded', error: 'private phrase and secret' });
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes('private'));
  assert.ok(sockets.every(socket => socket.closed));
});
test('bounded startup buffering fails explicitly rather than silently losing speech', t => {
  const { bridge, errors, sockets } = fixture(t);
  for (let chunk = 1; chunk <= 251; chunk++) bridge.audio('inbound', '////', chunk * 20, chunk);
  assert.equal(errors.length, 1);
  assert.ok(sockets.every(socket => socket.closed));
});
