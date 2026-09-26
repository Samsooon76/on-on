import test from 'node:test';
import assert from 'node:assert/strict';
import { readStatisticsPages, statisticsCall } from '../dist/statistics.js';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';

const orgId = '10000000-0000-4000-8000-000000000001', actorId = '00000000-0000-4000-8000-000000000001';
const headers = { authorization: 'Bearer test-session' }, url = `/v1/organizations/${orgId}/statistics?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z`;
const row = { id: 'call', line_id: 'line', remote_number: '+33123456789', created_at: '2026-09-20T10:00:00Z', direction: 'inbound', status: 'completed', ended_at: '2026-09-20T10:05:00Z', result_code: null, duration_seconds: 60, ivr_state: { engine: 'taskrouter', epoch: 2 } };
test('automatic IVR pickup does not prove human connection and ringing losers get no attribution', () => {
  const root = { id: 'root', call_id: 'call', device_id: null, parent_call_sid: null, answered_at: '2026-09-20T10:00:00Z' };
  const loser = { ...root, id: 'loser', device_id: 'bob-device', parent_call_sid: 'root', answered_at: null };
  const devices = new Map([['bob-device', 'bob'], ['alice-device', 'alice']]);
  const unanswered = statisticsCall(row, [root, loser], devices, []);
  assert.equal(unanswered.connected, false); assert.equal(unanswered.durationSeconds, null); assert.deepEqual(unanswered.userIds, []);
  const winner = { ...loser, id: 'winner', device_id: 'alice-device', answered_at: '2026-09-20T10:01:00Z' };
  const answered = statisticsCall(row, [root, loser, winner, winner], devices, [{ duration: 12 }]);
  assert.equal(answered.connected, true); assert.deepEqual(answered.userIds, ['alice']); assert.equal(answered.voicemailCount, 1); assert.equal(answered.transfers, 2);
  assert.equal(statisticsCall({ ...row, result_code: 'queue_bridged' }, [root], devices, []).connected, true);
});
test('outbound attribution uses the originating device even on a failed call', () => {
  const result = statisticsCall({ ...row, direction: 'outbound', status: 'failed', ivr_state: null }, [{ id: 'root', device_id: 'device', parent_call_sid: null, answered_at: '2026-09-20T10:00:00Z' }], new Map([['device', 'alice']]), []);
  assert.deepEqual(result.userIds, ['alice']); assert.equal(result.connected, false); assert.equal(result.routing, 'direct');
});
test('pagination continues after a short server page and rejects partial overflow or failure', async () => {
  const pages = new Map([[null, [{ id: 'a' }]], ['a', [{ id: 'b' }]], ['b', []]]);
  assert.deepEqual(await readStatisticsPages(async after => ({ data: pages.get(after), error: null })), [{ id: 'a' }, { id: 'b' }]);
  await assert.rejects(readStatisticsPages(async after => ({ data: pages.get(after), error: null }), 1), { statusCode: 422 });
  await assert.rejects(readStatisticsPages(async () => ({ data: null, error: { code: 'XX000' } })), { statusCode: 503 });
});
function setup(t, overrides = {}) {
  const state = { role: 'admin', reads: [], rpcError: null, tables: {}, ...overrides };
  const config = loadConfig({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'test-publishable', SUPABASE_SECRET_KEY: 'test-secret' });
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: actorId } }, error: null }) },
    from(table) {
      const filters = []; let after = null; state.reads.push({ table, filters });
      const query = { select: () => query, order: () => query, limit: () => query,
        eq: (key, value) => { filters.push([key, value]); return query; },
        gt: (_key, value) => { after = value; return query; }, gte: () => query, lt: () => query, lte: () => query, in: () => query,
        maybeSingle: async () => ({ data: state.role ? { role: state.role } : null, error: null }),
        then: (resolve, reject) => Promise.resolve({ data: (state.tables[table] ?? []).filter(row => !after || row.id > after), error: null }).then(resolve, reject),
      }; return query;
    },
    rpc: async (name, args) => { state.rpc = { name, args }; return { data: { users: [], members: [], lines: [] }, error: state.rpcError }; },
  };
  const app = createApp(config, { createSupabaseClient: () => client }); t.after(() => app.close()); return { app, state };
}
test('analytics requires authentication and active administrator membership before privileged reads', async t => {
  const { app, state } = setup(t);
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
  for (const role of ['member', null]) { state.role = role; assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 403); }
  assert.ok(state.reads.every(read => read.table === 'memberships'));
});
test('query scopes every read to the organization and refuses inactive organization or excessive range', async t => {
  const { app, state } = setup(t);
  const response = await app.inject({ method: 'GET', url, headers });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json().calls, []); assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(state.reads.every(read => read.filters.some(([key, value]) => key === 'organization_id' && value === orgId)));
  assert.deepEqual(state.rpc, { name: 'admin_snapshot', args: { p_org_id: orgId, p_actor_id: actorId } });
  state.rpcError = { code: '42501' };
  assert.equal((await app.inject({ method: 'GET', url, headers })).statusCode, 403);
  state.rpcError = null;
  assert.equal((await app.inject({ method: 'GET', url: url.replace('2026-10-01', '2027-10-01'), headers })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: url.replace('2026-09-01T00:00:00Z', 'bad'), headers })).statusCode, 400);
});
test('nonempty snapshots include related data without exposing provider or IVR configuration', async t => {
  const { app, state } = setup(t, { tables: {
    calls: [row],
    call_legs: [{ id: 'leg', call_id: 'call', device_id: 'device', parent_call_sid: 'provider-sid', answered_at: row.created_at }],
    devices: [{ id: 'device', user_id: actorId }],
    voice_voicemails: [{ id: 'message', call_id: 'call', duration: 25 }],
    voice_queues: [{ id: 'queue', config: { name: 'Support', memberIds: [actorId] } }],
  } });
  const response = await app.inject({ method: 'GET', url, headers });
  assert.equal(response.statusCode, 200);
  const snapshot = response.json();
  assert.equal(snapshot.calls.length, 1); assert.equal(snapshot.calls[0].connected, true);
  assert.equal(snapshot.calls[0].voicemailSeconds, 25); assert.deepEqual(snapshot.calls[0].userIds, [actorId]);
  assert.deepEqual(snapshot.teams, [{ id: 'queue', name: 'Support', userIds: [actorId] }]);
  assert.ok(!response.body.includes('provider-sid')); assert.ok(!response.body.includes('ivr_state'));
  assert.ok(state.reads.every(read => read.filters.some(([key, value]) => key === 'organization_id' && value === orgId)));
});
