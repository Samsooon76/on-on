import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import twilio from 'twilio';
import WebSocket from 'ws';
import { loadConfig } from '../dist/config.js';
import { createApp } from '../dist/app.js';

const callId = '10000000-0000-4000-8000-000000000001', userId = '20000000-0000-4000-8000-000000000001';
const sid = prefix => prefix + '1'.repeat(32);
const base = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'publishable-test', SUPABASE_SECRET_KEY: 'server-secret', VOICE_ENABLED: 'true', TWILIO_ACCOUNT_SID: sid('AC'), TWILIO_API_KEY_SID: sid('SK'), TWILIO_API_KEY_SECRET: 'test-secret', TWILIO_AUTH_TOKEN: 'test-token', TWILIO_TWIML_APP_SID: sid('AP'), API_PUBLIC_URL: 'https://api.example.com', TRANSCRIPTION_ENABLED: 'true', ELEVENLABS_API_KEY: 'private-key' };
const config = loadConfig(base);
class ScribeSocket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.emit('close'); }
  receive(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}
function setup(t, recordingEnabled = false) {
  const state = { allowed: true, starts: [], stops: [], rows: [], sockets: [], recordingStarts: [], recordingStops: [], recordingStatus: 'in-progress', recordingFails: false, call: { id: callId, status: 'answered', ended_at: null, started_at: new Date().toISOString(), created_at: new Date().toISOString() } };
  function client(user = false) { return { auth: { getUser: async () => ({ data: { user: { id: userId, is_anonymous: false } }, error: null }) }, from(table) {
    const filters = []; let one = false, mutation, values;
    const q = { select() { return q; }, eq(k, v) { filters.push(row => row[k] === v); return q; }, is(k, v) { return q.eq(k, v); }, in(k, values) { filters.push(row => values.includes(row[k])); return q; }, maybeSingle() { one = true; return q; }, single() { one = true; return q; }, insert(v) { mutation = 'insert'; values = v; return q; }, update(v) { mutation = 'update'; values = v; return q; }, then(resolve, reject) {
      let rows = table === 'calls' ? user && !state.allowed ? [] : [state.call] : table === 'call_legs' ? user ? [] : [{ provider_call_sid: sid('CA'), call_id: callId }] : state.rows;
      if (mutation === 'insert') {
        if (rows.some(row => row.call_id === values.call_id)) return Promise.resolve({ data: null, error: { code: '23505' } }).then(resolve, reject);
        const row = { id: randomUUID(), recording_sid: null, recording_status: null, recording_stop_requested: false, ...values, stream_sid: null, stream_connected: false, status: 'starting', started_at: new Date().toISOString(), updated_at: new Date().toISOString(), snapshot: { segments: [], partials: { local: null, remote: null } }, error: null };
        state.rows.push(row); rows = [row];
      } else { rows = rows.filter(row => filters.every(filter => filter(row))); if (mutation === 'update') rows.forEach(row => Object.assign(row, values)); }
      return Promise.resolve({ data: structuredClone(one ? rows[0] ?? null : rows), error: null }).then(resolve, reject);
    } }; return q;
  } }; }
  const service = client(), userClient = client(true);
  const provider = { calls(callSid) {
    const streams = name => ({ update: async value => { state.stops.push({ callSid, name, ...value }); } });
    streams.create = async value => { state.starts.push({ callSid, ...value }); return { sid: sid('MZ') }; };
    const recordings = recordingSid => ({ update: async value => { state.recordingStops.push({ callSid, recordingSid, ...value }); state.recordingStatus = 'processing'; }, fetch: async () => ({ status: state.recordingStatus, duration: '12' }) });
    recordings.create = async value => { state.recordingStarts.push({ callSid, ...value }); if (state.recordingGate) await state.recordingGate; if (state.recordingFails) throw new Error('Provider rejected'); return { sid: sid('RE'), status: state.recordingStatus }; };
    return { streams, recordings };
  } };
  // Use the production app, including its real signature validation and proxy handling.
  const app = createApp(loadConfig({ ...base, CALL_RECORDING_ENABLED: String(recordingEnabled) }), {
    createSupabaseClient: (_url, key) => key === config.SUPABASE_SECRET_KEY ? service : userClient,
    centerProvider: provider,
    scribeSocketFactory: () => { const socket = new ScribeSocket(); state.sockets.push(socket); return socket; },
  });
  t.after(() => app.close());
  const request = (method = 'GET', path = `/v1/voice/calls/${sid('CA')}/transcription`) => app.inject({ method, url: path, headers: { authorization: 'Bearer session' } });
  return { app, state, request };
}
const eventually = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail('condition did not become true'); };

test('configuration requires ElevenLabs, voice and HTTPS, with no browser key', () => {
  assert.throws(() => loadConfig({ ...base, ELEVENLABS_API_KEY: undefined }));
  assert.throws(() => loadConfig({ ...base, VOICE_ENABLED: 'false' }));
  assert.throws(() => loadConfig({ ...base, API_PUBLIC_URL: 'http://localhost:4100' }));
});
test('API denies missing auth and foreign/revoked line access before starting paid streams', async t => {
  const { app, state, request } = setup(t);
  assert.equal((await app.inject({ url: `/v1/calls/${callId}/transcription` })).statusCode, 401);
  state.allowed = false;
  assert.equal((await request('POST')).statusCode, 404);
  assert.equal((await request()).statusCode, 404);
  assert.equal(state.starts.length, 0);
});
test('starting is idempotent across retries, streams both SDK-leg tracks and never returns secrets', async t => {
  const { state, request } = setup(t);
  const [first, second] = await Promise.all([request('POST'), request('POST')]);
  assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200);
  assert.equal(state.starts.length, 1); assert.equal(state.starts[0].track, 'both_tracks');
  assert.equal(state.starts[0].callSid, sid('CA'));
  assert.equal(first.json().transcript.id, second.json().transcript.id);
  assert.ok(!first.body.includes('private-key')); assert.ok(!first.body.includes('provider_call_sid'));
  state.allowed = false; assert.equal((await request()).statusCode, 404);
});
test('ended calls cannot start transcription; a crashed worker becomes an explicit saved error', async t => {
  const { state, request } = setup(t);
  state.call.ended_at = new Date().toISOString(); assert.equal((await request('POST')).statusCode, 409);
  state.call.ended_at = null; await request('POST');
  state.rows[0].updated_at = '2020-01-01T00:00:00Z';
  assert.equal((await request()).json().transcript.status, 'error');
});
test('stopping before the stream connects completes cleanly without changing the call', async t => {
  const { state, request } = setup(t);
  await request('POST');
  const result = await request('POST', `/v1/calls/${callId}/transcription/stop`);
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().transcript.status, 'completed');
  assert.equal(state.call.status, 'answered');
  assert.equal(state.stops.length, 1);
  assert.equal(state.stops[0].status, 'stopped');
});
for (const suffix of ['', '/']) test(`production app accepts WSS signatures${suffix ? ' with Twilio trailing slash' : ''} and saves live text for post-call history`, async t => {
  const { app, state, request } = setup(t);
  await request('POST');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const path = `/webhooks/twilio/transcription/${state.rows[0].id}`;
  for (const signature of [null, 'invalid', twilio.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN, config.API_PUBLIC_URL + path, {}), twilio.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN, 'wss://attacker.example' + path, {})]) {
    const rejected = new WebSocket(address.replace('http:', 'ws:') + path, { headers: { ...(signature ? { 'x-twilio-signature': signature } : {}), 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'wss' } });
    try {
      const [error] = await once(rejected, 'error', { signal: AbortSignal.timeout(2000) }); assert.match(error.message, /403/);
    } finally { rejected.terminate(); }
  }
  assert.equal(state.sockets.length, 0);
  const socket = new WebSocket(address.replace('http:', 'ws:') + path, { headers: { 'x-twilio-signature': twilio.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN, state.starts[0].url + suffix, {}), 'x-forwarded-proto': 'https' } });
  t.after(() => socket.terminate());
  await once(socket, 'open', { signal: AbortSignal.timeout(2000) });
  socket.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  socket.send(JSON.stringify({ event: 'start', start: { accountSid: sid('AC'), callSid: sid('CA'), streamSid: sid('MZ'), mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));
  // Media arrives before the asynchronous database claim resolves.
  socket.send(JSON.stringify({ event: 'media', streamSid: sid('MZ'), media: { track: 'inbound', timestamp: '10', chunk: '1', payload: '////' } }));
  await eventually(() => state.sockets.length === 2);
  state.sockets.forEach(s => s.receive({ message_type: 'session_started' }));
  await eventually(() => state.sockets[0].sent.length === 1);
  state.sockets[0].receive({ message_type: 'partial_transcript', text: 'Bonjour' });
  await eventually(() => state.rows[0].snapshot.partials.local?.text === 'Bonjour');
  socket.send(JSON.stringify({ event: 'stop', streamSid: sid('MZ') }));
  await eventually(() => state.sockets[0].sent.some(message => message.commit));
  state.sockets[0].receive({ message_type: 'committed_transcript', text: 'Bonjour à tous.' });
  await eventually(() => state.rows[0].status === 'completed');
  const result = (await request()).json();
  assert.equal(result.transcript.segments[0].text, 'Bonjour à tous.');
  assert.equal(result.transcript.partials.local, null);
  assert.equal(result.transcript.status, 'completed');
  state.call.ended_at = new Date().toISOString();
  state.call.status = 'completed';
  const history = (await request('GET', `/v1/calls/${callId}/transcription`)).json();
  assert.equal(history.callActive, false);
  assert.equal(history.transcript.segments[0].text, 'Bonjour à tous.');
  socket.terminate();
});

test('HTTPS stream callbacks still verify their form body and preserve the failure in history', async t => {
  const { app, state, request } = setup(t);
  await request('POST');
  const path = `/webhooks/twilio/transcription/${state.rows[0].id}/status`;
  const body = { AccountSid: sid('AC'), CallSid: sid('CA'), StreamSid: sid('MZ'), StreamEvent: 'stream-error', StreamError: '31920: WebSocket handshake error' };
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilio.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN, config.API_PUBLIC_URL + path, body) };
  const tampered = await app.inject({ method: 'POST', url: path, headers, payload: new URLSearchParams({ ...body, StreamError: 'tampered' }).toString() });
  assert.equal(tampered.statusCode, 403);
  assert.equal(state.rows[0].status, 'starting');
  const accepted = await app.inject({ method: 'POST', url: path, headers, payload: new URLSearchParams(body).toString() });
  assert.equal(accepted.statusCode, 204);
  assert.equal((await request()).json().transcript.status, 'error');
});

function recordingCallback(app, state, changes = {}) {
  const path = `/webhooks/twilio/transcription/${state.rows[0].id}/recording`;
  const body = { AccountSid: sid('AC'), CallSid: sid('CA'), RecordingSid: sid('RE'), RecordingStatus: 'completed', RecordingDuration: '12', RecordingUrl: 'https://attacker.invalid/audio.mp3', ...changes };
  return app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilio.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN, config.API_PUBLIC_URL + path, body) }, payload: new URLSearchParams(body).toString() });
}

test('recording starts once with both channels and does not expose provider metadata', async t => {
  const { state, request } = setup(t, true);
  const results = await Promise.all([request('POST'), request('POST')]);
  assert.equal(state.recordingStarts.length, 1);
  assert.equal(state.recordingStarts[0].recordingChannels, 'dual');
  assert.equal(state.recordingStarts[0].recordingTrack, 'both');
  assert.deepEqual(state.recordingStarts[0].recordingStatusCallbackEvent, ['in-progress', 'completed', 'absent']);
  assert.equal(results[0].json().recordingEnabled, true);
  const response = await request();
  assert.equal(response.json().transcript.recording.status, 'recording');
  assert.ok(!response.body.includes(sid('RE')));
  assert.ok(!response.body.includes('recording_sid'));
});

test('recording failure does not prevent Scribe transcription from starting', async t => {
  const { state, request } = setup(t, true);
  state.recordingFails = true;
  const response = await request('POST');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().transcript.recording.status, 'failed');
  assert.equal(state.starts.length, 1);
});

test('recording callbacks bind the call and SID, survive transcript errors, and never downgrade ready audio', async t => {
  const { app, state, request } = setup(t, true);
  await request('POST');
  state.rows[0].status = 'error';
  assert.equal((await recordingCallback(app, state, { CallSid: 'CA' + '2'.repeat(32) })).statusCode, 404);
  assert.equal((await recordingCallback(app, state, { RecordingSid: 'RE' + '2'.repeat(32) })).statusCode, 404);
  assert.equal((await recordingCallback(app, state, { AccountSid: 'AC' + '2'.repeat(32) })).statusCode, 403);
  assert.equal((await recordingCallback(app, state)).statusCode, 204);
  assert.equal((await recordingCallback(app, state, { RecordingStatus: 'in-progress' })).statusCode, 204);
  assert.equal((await request()).json().transcript.recording.status, 'ready');
  assert.equal(state.rows[0].recording_duration_seconds, 12);
});

test('audio playback checks user access before fetching private media and forwards byte ranges', async t => {
  const { app, state, request } = setup(t, true);
  await request('POST'); await recordingCallback(app, state);
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    downloads++;
    assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${sid('AC')}/Recordings/${sid('RE')}.mp3?RequestedChannels=1`);
    assert.equal(init.headers.range, 'bytes=0-3');
    assert.ok(init.headers.authorization.startsWith('Basic '));
    return new Response(Buffer.from([1, 2, 3, 4]), { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-3/123', 'accept-ranges': 'bytes', 'content-length': '4' } });
  });
  const path = `/v1/calls/${callId}/recording/audio`;
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  state.allowed = false;
  assert.equal((await request('GET', path)).statusCode, 404);
  assert.equal(downloads, 0);
  state.allowed = true;
  assert.equal((await app.inject({ url: path, headers: { authorization: 'Bearer session', range: 'bytes=0-1,3-4' } })).statusCode, 416);
  const response = await app.inject({ url: path, headers: { authorization: 'Bearer session', range: 'bytes=0-3' } });
  assert.equal(response.statusCode, 206);
  assert.equal(response.headers['content-range'], 'bytes 0-3/123');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['content-type'], 'audio/mpeg');
  assert.deepEqual(response.rawPayload, Buffer.from([1, 2, 3, 4]));
  assert.equal(response.headers.location, undefined);
});

test('stop also stops recording when transcription failed; missing callback is reconciled', async t => {
  const { state, request } = setup(t, true);
  await request('POST'); state.rows[0].status = 'error';
  const stopped = await request('POST', `/v1/calls/${callId}/transcription/stop`);
  assert.equal(stopped.json().transcript.recording.status, 'processing');
  assert.equal(state.recordingStops.length, 1);
  assert.equal(state.call.status, 'answered');
  state.recordingStatus = 'completed';
  state.rows[0].recording_updated_at = '2020-01-01T00:00:00Z';
  const saved = (await request()).json().transcript;
  assert.equal(saved.status, 'error');
  assert.equal(saved.recording.status, 'ready');
});

test('stop racing the recording creation is honored after its provider SID arrives', async t => {
  const { state, request } = setup(t, true);
  let release;
  state.recordingGate = new Promise(resolve => { release = resolve; });
  const start = request('POST');
  await eventually(() => state.recordingStarts.length === 1);
  await request('POST', `/v1/calls/${callId}/transcription/stop`);
  assert.equal(state.rows[0].recording_stop_requested, true);
  release(); await start;
  assert.equal(state.recordingStops.length, 1);
  assert.equal(state.rows[0].recording_status, 'processing');
  assert.equal(state.starts.length, 0);
});
