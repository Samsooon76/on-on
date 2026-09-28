import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../dist/app.js";

// The real API routes against the real SQL functions (all migrations applied to an in-memory
// Postgres, row level security active): what the database returns must be exactly what the
// route parsers and response schemas accept, page after page.
const uuid = (prefix, n) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = uuid("0", 1), OUTSIDER = uuid("0", 2), ORG = uuid("1", 1), OTHER_ORG = uuid("1", 2);
const LINE = uuid("2", 1), OTHER_LINE = uuid("2", 2);
const conversation = (n) => uuid("3", n), message = (n) => uuid("4", n);
const config = {
  APP_ENV: "dev", API_HOST: "127.0.0.1", API_PORT: 4100, API_PUBLIC_URL: "http://localhost:4100", WEB_PUBLIC_URL: "http://localhost:5173",
  ALLOWED_ORIGINS: "http://localhost:5173", SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_key",
  SUPABASE_SECRET_KEY: undefined, VOICE_ENABLED: false, SMS_ENABLED: false, TWILIO_ALLOWED_DESTINATIONS: "+33", SMS_ALLOWED_RECIPIENTS: "",
  MAX_ACTIVE_CALL_SECONDS: 900, MAX_RINGING_DEVICES: 4, allowedOrigins: new Set(["http://localhost:5173"]),
};

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls; create role authenticator; create role supabase_auth_admin;
    create schema auth; create schema extensions; create schema realtime;
    create table auth.users(id uuid primary key, email text, aud text, role text, encrypted_password text, email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''), (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid $$;
    create table realtime.messages(extension text);
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
    create function realtime.send(jsonb,text,text,boolean) returns void language sql as $$ select $$;
    grant usage on schema auth to authenticated,service_role; grant all on auth.users to service_role;
  `);
  const directory = new URL("../../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) await db.exec(await readFile(new URL(file, directory), "utf8"));
  await db.exec(`
    insert into auth.users(id,email) values ('${USER}','a@test.invalid'),('${OUTSIDER}','b@test.invalid');
    insert into public.organizations(id,name) values ('${ORG}','Org'),('${OTHER_ORG}','Other');
    insert into public.memberships(organization_id,user_id) values ('${ORG}','${USER}'),('${OTHER_ORG}','${OUTSIDER}');
    insert into public.lines(id,organization_id,phone_number,voice_enabled,sms_enabled) values ('${LINE}','${ORG}','+33102030405',true,true),('${OTHER_LINE}','${OTHER_ORG}','+33102030406',true,true);
    insert into public.line_assignments(organization_id,line_id,user_id,can_voice,can_sms) values ('${ORG}','${LINE}','${USER}',true,true),('${OTHER_ORG}','${OTHER_LINE}','${OUTSIDER}',true,true);
    -- Five conversations; 3 and 4 fall within the same millisecond but differ in microseconds.
    insert into public.conversations(id,organization_id,line_id,remote_number,last_message_at) values
      ('${conversation(1)}','${ORG}','${LINE}','+33600000001','2026-09-28 10:00:00.123456+00'),
      ('${conversation(2)}','${ORG}','${LINE}','+33600000002','2026-09-28 09:00:00.500000+00'),
      ('${conversation(3)}','${ORG}','${LINE}','+33600000003','2026-09-28 08:00:00.250900+00'),
      ('${conversation(4)}','${ORG}','${LINE}','+33600000004','2026-09-28 08:00:00.250100+00'),
      ('${conversation(5)}','${ORG}','${LINE}','+33600000005','2026-09-28 07:00:00.000001+00'),
      ('${conversation(9)}','${OTHER_ORG}','${OTHER_LINE}','+33600000001','2026-09-28 11:00:00+00');
    insert into public.messages(id,organization_id,conversation_id,direction,body,status,created_at) values
      ('${message(1)}','${ORG}','${conversation(1)}','inbound','first','received','2026-09-28 09:00:00+00'),
      ('${message(2)}','${ORG}','${conversation(1)}','outbound','reply','delivered','2026-09-28 09:30:00+00'),
      ('${message(3)}','${ORG}','${conversation(1)}','inbound','latest','received','2026-09-28 10:00:00.123456+00'),
      ('${message(4)}','${ORG}','${conversation(2)}','inbound','two','received','2026-09-28 09:00:00.500000+00'),
      ('${message(5)}','${ORG}','${conversation(3)}','inbound','three','received','2026-09-28 08:00:00.250900+00'),
      ('${message(6)}','${ORG}','${conversation(4)}','outbound','four','sent','2026-09-28 08:00:00.250100+00'),
      ('${message(7)}','${ORG}','${conversation(5)}','inbound','five','received','2026-09-28 07:00:00.000001+00'),
      ('${message(9)}','${OTHER_ORG}','${conversation(9)}','inbound','secret','received','2026-09-28 11:00:00+00');
    insert into public.contacts(id,organization_id,display_name) values ('${uuid("5", 1)}','${ORG}','Alice');
    insert into public.contact_phones(organization_id,contact_id,phone_number) values ('${ORG}','${uuid("5", 1)}','+33600000001');
    insert into public.calls(id,organization_id,line_id,direction,remote_number,status,created_at,duration_seconds) values
      ('${uuid("6", 1)}','${ORG}','${LINE}','inbound','+33600000001','completed','2026-09-28 10:00:00.111111+00',42),
      ('${uuid("6", 2)}','${ORG}','${LINE}','outbound','+33600000002','missed','2026-09-28 09:00:00.222222+00',null),
      ('${uuid("6", 3)}','${ORG}','${LINE}','inbound','+33600000003','completed','2026-09-28 09:00:00.222222+00',7),
      ('${uuid("6", 9)}','${OTHER_ORG}','${OTHER_LINE}','inbound','+33600000001','completed','2026-09-28 12:00:00+00',1);
  `);
  return db;
}

// A Supabase stand-in whose RPCs run in Postgres as the `authenticated` role of the token's user.
function createDependencies(db, userId) {
  const client = {
    auth: { getClaims: async () => ({ data: { claims: { sub: userId, role: "authenticated", aud: "authenticated", is_anonymous: false } }, error: null }),
            getUser: async () => ({ data: { user: { id: userId, is_anonymous: false } }, error: null }) },
    rpc: async (name, args = {}) => {
      const keys = Object.keys(args);
      const call = `select public.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(", ")}) as result`;
      try {
        await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false);`);
        const { rows } = await db.query(call, keys.map((key) => args[key]));
        return { data: rows[0].result, error: null };
      } catch (error) {
        return { data: null, error: { code: error.code ?? "XX000", message: error.message } };
      } finally { await db.exec("reset role;"); }
    },
    from: () => { throw new Error("these routes must not read tables directly"); },
  };
  return { createSupabaseClient: () => client };
}

const headers = { authorization: "Bearer session" };
const get = (app, url) => app.inject({ method: "GET", url, headers });

test("inbox pages chain through the cursor without gaps, repeats or lost precision", async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  const app = createApp(config, createDependencies(db, USER));
  t.after(() => app.close());

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    // Three per page puts the cut right after conversation 3, whose successor is 0.8 ms later.
    const response = await get(app, `/v1/lines/${LINE}/conversations?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    seen.push(...body.items.map((item) => item.id));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5].map(conversation), "newest first, and conversation 4 is not lost at the page boundary");

  const first = (await get(app, `/v1/lines/${LINE}/conversations`)).json().items[0];
  assert.deepEqual({ ...first, lastMessage: undefined }, {
    id: conversation(1), lineId: LINE, remoteNumber: "+33600000001", remoteContactName: "Alice", lastMessageAt: first.lastMessageAt, lastMessage: undefined, unread: true,
  });
  assert.match(first.lastMessageAt, /^2026-09-28T10:00:00\.123456\+00:00$/, "microseconds survive the round trip");
  assert.deepEqual(first.lastMessage, { id: message(3), conversation_id: conversation(1), body: "latest", direction: "inbound", status: "received", created_at: first.lastMessage.created_at });
});

test("a line the caller cannot use is not found and never leaks another tenant's rows", async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  const app = createApp(config, createDependencies(db, USER));
  t.after(() => app.close());
  const outsider = createApp(config, createDependencies(db, OUTSIDER));
  t.after(() => outsider.close());

  assert.equal((await get(app, `/v1/lines/${OTHER_LINE}/conversations`)).statusCode, 404);
  assert.equal((await get(app, `/v1/lines/${OTHER_LINE}/calls`)).statusCode, 404);
  assert.equal((await get(app, `/v1/conversations/${conversation(9)}/messages`)).statusCode, 404);
  assert.equal((await get(outsider, `/v1/lines/${LINE}/conversations`)).statusCode, 404);
  assert.equal((await get(outsider, `/v1/conversations/${conversation(1)}/messages`)).statusCode, 404);
  const own = (await get(outsider, `/v1/lines/${OTHER_LINE}/conversations`)).json();
  assert.deepEqual(own.items.map((item) => item.remoteContactName), [null], "the other tenant's contact 'Alice' does not label their number");
});

test("call history pages with contact labels", async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  const app = createApp(config, createDependencies(db, USER));
  t.after(() => app.close());

  const first = (await get(app, `/v1/lines/${LINE}/calls?limit=2`)).json();
  assert.deepEqual(first.items.map((item) => item.id), [uuid("6", 1), uuid("6", 3)]);
  assert.equal(first.items[0].remoteContactName, "Alice");
  assert.equal(first.items[0].duration_seconds, 42);
  const second = (await get(app, `/v1/lines/${LINE}/calls?limit=2&cursor=${first.nextCursor}`)).json();
  assert.deepEqual(second.items.map((item) => item.id), [uuid("6", 2)]);
  assert.equal(second.nextCursor, null);
});

test("a thread is served oldest first, pages backwards, and reading it clears the unread flag", async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  const app = createApp(config, createDependencies(db, USER));
  t.after(() => app.close());

  const newest = (await get(app, `/v1/conversations/${conversation(1)}/messages?limit=2`)).json();
  assert.deepEqual(newest.items.map((item) => item.body), ["reply", "latest"]);
  assert.deepEqual(newest.conversation, { id: conversation(1), organization_id: ORG, line_id: LINE, remote_number: "+33600000001" });
  const older = (await get(app, `/v1/conversations/${conversation(1)}/messages?limit=2&cursor=${newest.nextCursor}`)).json();
  assert.deepEqual(older.items.map((item) => item.body), ["first"]);
  assert.equal(older.nextCursor, null);

  const unread = async () => (await get(app, `/v1/lines/${LINE}/conversations`)).json().items.find((item) => item.id === conversation(1)).unread;
  assert.equal(await unread(), true);
  const marked = await app.inject({ method: "PUT", url: `/v1/conversations/${conversation(1)}/read`, headers, payload: { lastReadMessageId: message(3) } });
  assert.equal(marked.statusCode, 204);
  assert.equal(await unread(), false);
  const foreign = await app.inject({ method: "PUT", url: `/v1/conversations/${conversation(1)}/read`, headers, payload: { lastReadMessageId: message(9) } });
  assert.equal(foreign.statusCode, 400);
  const missing = await app.inject({ method: "PUT", url: `/v1/conversations/${conversation(9)}/read`, headers, payload: {} });
  assert.equal(missing.statusCode, 404);
});
