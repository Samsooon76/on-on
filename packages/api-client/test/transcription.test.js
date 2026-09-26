import assert from 'node:assert/strict';
import test from 'node:test';
import { transcriptRows, transcriptText, watchTranscript } from '../dist/index.js';
const transcript = { id: '10000000-0000-4000-8000-000000000001', status: 'live', startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', segments: [{ id: 'b', speaker: 'local', text: 'Bonjour.', offsetMs: 1200 }], partials: { local: null, remote: { id: 'a', speaker: 'remote', text: 'Bonsoir', offsetMs: 1000 } }, error: null };
test('timeline orders both speakers, exports only committed text', () => {
  assert.deepEqual(transcriptRows(transcript).map(row => row.id), ['a', 'b']);
  assert.equal(transcriptText(transcript), '[00:01] Vous : Bonjour.');
});
test('unmount aborts the request and discards a late response', async () => {
  let resolve, signal, delivered = 0;
  const stop = watchTranscript((_path, init) => { signal = init.signal; return new Promise(done => { resolve = done; }); }, { callId: transcript.id }, { onData: () => delivered++, onError: () => delivered++ });
  stop();
  resolve({ available: true, callId: transcript.id, callActive: true, transcript });
  await new Promise(done => setImmediate(done));
  assert.equal(signal.aborted, true); assert.equal(delivered, 0);
});
test('revoked access clears visible text and does not retry', async () => {
  let calls = 0;
  const result = await new Promise(resolve => {
    watchTranscript(async () => { calls++; throw Object.assign(new Error('Accès révoqué'), { status: 403 }); }, { callId: transcript.id }, { onData: () => assert.fail(), onError: (message, lost) => resolve({ message, lost }) }, 1);
  });
  assert.equal(result.lost, true); assert.equal(calls, 1);
});
