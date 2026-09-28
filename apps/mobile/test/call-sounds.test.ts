import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { IOSConfig } = require('expo/config-plugins');
const { addIosSounds } = require('../plugins/with-call-sounds.cjs');

test('iOS tones are bundled as build resources and prebuild is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'onoff-sounds-'));
  try {
    mkdirSync(join(root, 'ios/Onoff.xcodeproj'), { recursive: true });
    mkdirSync(join(root, 'ios/Onoff'), { recursive: true });
    mkdirSync(join(root, 'assets/sounds'), { recursive: true });
    copyFileSync(new URL('../ios/Onoff.xcodeproj/project.pbxproj', import.meta.url), join(root, 'ios/Onoff.xcodeproj/project.pbxproj'));
    for (const name of ['incoming.wav', 'ringtone.wav']) copyFileSync(new URL(`../assets/sounds/${name}`, import.meta.url), join(root, 'assets/sounds', name));
    const project = IOSConfig.XcodeUtils.getPbxproj(root);
    addIosSounds(project, root, join(root, 'ios'), 'Onoff');
    const first = project.writeSync();
    addIosSounds(project, root, join(root, 'ios'), 'Onoff');
    assert.equal(project.writeSync(), first);
    for (const name of ['incoming.wav', 'ringtone.wav']) {
      const references = Object.entries(project.pbxFileReferenceSection()).filter(([key, value]: [string, any]) => !key.endsWith('_comment') && value.path?.includes(name));
      assert.equal(references.length, 1);
      const resource = Object.values(project.pbxBuildFileSection()).find((value: any) => value.fileRef === references[0]![0]);
      assert.ok(resource, `${name} must be copied to the application bundle`);
      assert.deepEqual(readFileSync(join(root, 'ios/Onoff', name)), readFileSync(join(root, 'assets/sounds', name)));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
