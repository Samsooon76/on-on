import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';

// Real Postgres in memory, with minimal Supabase-owned schemas. Auth issuance and
// Realtime delivery are tested separately; their network services are not emulated.
const db = new PGlite();
try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create schema extensions;
    create schema realtime;
    create table auth.users(id uuid primary key, email text, aud text, role text, encrypted_password text, email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''), (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid
    $$;
    create table realtime.messages(extension text);
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
    create function realtime.send(jsonb,text,text,boolean) returns void language sql as $$ select $$;
    grant usage on schema auth to authenticated,service_role;
    grant all on auth.users to service_role;
  `);
  const directory = new URL('../supabase/migrations/', import.meta.url);
  const migrations = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  for (const migration of migrations) {
    try { await db.exec(await readFile(new URL(migration, directory), 'utf8')); }
    catch (error) { throw new Error(`Migration ${migration}: ${error.message}`, { cause: error }); }
  }
  const results = await db.exec(await readFile(new URL('../supabase/tests/admin_and_ivr.test.sql', import.meta.url), 'utf8'));
  console.log(`${migrations.length} migrations applied to isolated PostgreSQL.`);
  for (const result of results) for (const row of result.rows) console.log(Object.values(row).join(' '));
} catch (error) {
  console.error(error.message);
  if (error.where) console.error(error.where);
  process.exitCode = 1;
} finally { await db.close(); }
