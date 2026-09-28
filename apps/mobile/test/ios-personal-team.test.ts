import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../scripts/ios-personal-team.mjs', import.meta.url);
const plist = (entries: string) => `<?xml version="1.0"?><plist version="1.0"><dict>${entries}</dict></plist>`;

async function runPreview(original: string, exitCode = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'onoff-ios-personal-'));
  try {
    await Promise.all(['scripts', 'ios/Onoff', 'bin'].map((path) => mkdir(join(directory, path), { recursive: true })));
    const entitlements = join(directory, 'ios/Onoff/Onoff.entitlements');
    await copyFile(script, join(directory, 'scripts/ios-personal-team.mjs'));
    await writeFile(entitlements, original);
    const pnpm = join(directory, 'bin/pnpm');
    await writeFile(pnpm, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync('build-observation.json', JSON.stringify({
  args: process.argv.slice(2),
  noPush: process.env.EXPO_PUBLIC_IOS_LOCAL_NO_PUSH,
  entitlements: fs.readFileSync('ios/Onoff/Onoff.entitlements', 'utf8'),
}));
process.exit(${exitCode});
`);
    await chmod(pnpm, 0o755);
    const result = spawnSync(process.execPath, [join(directory, 'scripts/ios-personal-team.mjs'), 'Test iPhone'], {
      env: { ...process.env, PATH: `${join(directory, 'bin')}:${process.env.PATH ?? ''}` },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    const observation = await readFile(join(directory, 'build-observation.json'), 'utf8').then(JSON.parse).catch(() => null);
    return { ...result, observation, restored: await readFile(entitlements, 'utf8') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a personal-team build starts when APNs is already absent', async () => {
  const original = plist('');
  const result = await runPreview(original);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.observation, {
    args: ['ios', '--device', 'Test iPhone', '--configuration', 'Release', '--no-bundler'],
    noPush: '1', entitlements: original,
  });
  assert.equal(result.restored, original);
});

test('APNs is removed during the build and the exact original is restored even after failure', async () => {
  for (const exitCode of [0, 1]) {
    const other = '<key>com.apple.developer.associated-domains</key><array><string>applinks:example.com</string></array>';
    const original = plist(`<key>aps-environment</key><string>development</string>${other}`);
    const result = await runPreview(original, exitCode);
    assert.equal(result.status, exitCode, result.stderr);
    assert.equal(result.observation.entitlements, plist(other));
    assert.equal(result.restored, original);
  }
});

test('an unrecognized APNs value fails before starting the build and preserves the file', async () => {
  const original = plist('<key>aps-environment</key><string>unexpected</string>');
  const result = await runPreview(original);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Format de l'autorisation APNs non reconnu/);
  assert.equal(result.observation, null);
  assert.equal(result.restored, original);
});
