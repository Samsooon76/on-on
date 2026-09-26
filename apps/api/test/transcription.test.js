import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import Fastify from 'fastify';
import twilio from 'twilio';
import WebSocket from 'ws';
import { loadConfig } from '../dist/config.js';
import { registerTranscription } from '../dist/transcription.js';

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
function setup(t) {
  const state = { allowed: true, starts: [], stops: [], rows: [], sockets: [], call: { id: callId, status: 'answered', ended_at: null, started_at: new Date().toISOString(), created_at: new Date().toISOString() } };
  function client(user = false) { return { from(table) {
    const filters = []; let one = false, mutation, values;
    const q = { select() { return q; }, eq(k, v) { filters.push(row => row[k] === v); return q; }, is(k, v) { return q.eq(k, v); }, in(k, values) { filters.push(row => values.includes(row[k])); return q; }, maybeSingle() { one = true; return q; }, single() { one = true; return q; }, insert(v) { mutation = 'insert'; values = v; return q; }, update(v) { mutation = 'update'; values = v; return q; }, then(resolve, reject) {
      let rows = table === 'calls' ? user && !state.allowed ? [] : [state.call] : table === 'call_legs' ? user ? [] : [{ provider_call_sid: sid('CA'), call_id: callId }] : state.rows;
      if (mutation === 'insert') {
        if (rows.some(row => row.call_id === values.call_id)) return Promise.resolve({ data: null, error: { code: '23505' } }).then(resolve, reject);
        const row = { id: randomUUID(), ...values, stream_sid: null, stream_connected: false, status: 'starting', started_at: new Date().toISOString(), updated_at: new Date().toISOString(), snapshot: { segments: [], partials: { local: null, remote: null } }, error: null };
        state.rows.push(row); rows = [row];
      } else { rows = rows.filter(row => filters.every(filter => filter(row))); if (mutation === 'update') rows.forEach(row => Object.assign(row, values)); }
      return Promise.resolve({ data: structuredClone(one ? rows[0] ?? null : rows), error: null }).then(resolve, reject);
    } }; return q;
  } }; }
  const service = client(), userClient = client(true);
  const app = Fastify();
  app.decorateRequest('context', null);
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    if (!request.headers.authorization) return reply.code(401).send();
    request.context = { userId, supabase: userClient };
  });
  const provider = { calls(callSid) { const streams = name => ({ update: async value => { state.stops.push({ callSid, name, ...value }); } }); streams.create = async value => { state.starts.push({ callSid, ...value }); return { sid: sid('MZ') }; }; return { streams }; } };
  registerTranscription(app, config, service, provider, request => twilio.validateRequest(config.TWILIO_AUTH_TOKEN, request.headers['x-twilio-signature'] ?? '', config.API_PUBLIC_URL + request.url, request.body ?? {}), () => { const socket = new ScribeSocket(); state.sockets.push(socket); return socket; });
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
test('signed WebSocket relays actual media, saves final text and rejects unsigned upgrades', async t => {
  const { app, state, request } = setup(t);
  await request('POST');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const path = `/webhooks/twilio/transcription/${state.rows[0].id}`;
  const rejected = new WebSocket(address.replace('http:', 'ws:') + path);
  const [error] = await once(rejected, 'error'); assert.match(error.message, /403/);
  const socket = new WebSocket(address.replace('http:', 'ws:') + path, { headers: { 'x-twilio-signature': twilio.getExpectedTwilioSignature(config.TWILIO_AUTH_TOKEN, config.API_PUBLIC_URL + path, {}) } });
  await once(socket, 'open');
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
  socket.terminate();
});
