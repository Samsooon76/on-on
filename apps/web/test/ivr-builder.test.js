import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultVoiceFlow, voiceFlowSchema } from '@onoff/contracts';
import { addSubmenu, clearDestination, isEmptyDestination, nextDigit, pruneMenus, referencedQueueIds, removeBranch, removeMenu, replaceDestination } from '../src/ivr-builder-model.ts';

test('adding a submenu preserves the destination and leaves the previous draft untouched', () => {
  const flow = defaultVoiceFlow();
  const next = addSubmenu(flow, { kind: 'branch', menuId: 'accueil', index: 0 }, 'support');
  assert.equal(flow.menus.length, 1);
  assert.deepEqual(flow.menus[0].options[0].destination, { type: 'voicemail' });
  assert.deepEqual(next.menus[0].options[0].destination, { type: 'menu', menuId: 'support' });
  assert.deepEqual(next.menus[1].options[0].destination, { type: 'voicemail' });
  assert.equal(voiceFlowSchema.safeParse(next).success, true);
});

test('a direct transfer can become an IVR without losing the phone number', () => {
  const flow = { ...defaultVoiceFlow(), entry: { type: 'number', number: '+33123456789' }, menus: [] };
  const next = addSubmenu(flow, { kind: 'entry' }, 'accueil');
  assert.deepEqual(next.entry, { type: 'menu', menuId: 'accueil' });
  assert.deepEqual(next.menus[0].options[0].destination, flow.entry);
  assert.equal(voiceFlowSchema.safeParse(next).success, true);
});

test('deleting a branch removes its subtree but retains a menu shared by another branch', () => {
  let flow = addSubmenu(defaultVoiceFlow(), { kind: 'branch', menuId: 'accueil', index: 0 }, 'shared');
  flow.menus[0].options.push({ digit: '2', label: 'support', destination: { type: 'menu', menuId: 'shared' } });
  const shared = removeBranch(flow, 'accueil', 0);
  assert.deepEqual(shared.menus.map(menu => menu.id), ['accueil', 'shared']);
  const detached = replaceDestination(shared, { kind: 'branch', menuId: 'accueil', index: 0 }, { type: 'hangup' });
  assert.deepEqual(detached.menus.map(menu => menu.id), ['accueil']);
  assert.equal(flow.menus[0].options.length, 2);
});

test('back-links are finite and menus used only outside opening hours are retained', () => {
  let flow = addSubmenu(defaultVoiceFlow(), { kind: 'branch', menuId: 'accueil', index: 0 }, 'support');
  flow.menus[1].fallback = { type: 'menu', menuId: 'accueil' };
  flow = addSubmenu(flow, { kind: 'closed' }, 'night');
  assert.deepEqual(pruneMenus(flow).menus.map(menu => menu.id), ['accueil', 'support', 'night']);
  const direct = replaceDestination(flow, { kind: 'entry' }, { type: 'voicemail' });
  assert.deepEqual(direct.menus.map(menu => menu.id), ['night']);
  assert.equal(voiceFlowSchema.safeParse(direct).success, true);
});

test('removing the final branch requires a new branch before publishing', () => {
  const next = removeBranch(defaultVoiceFlow(), 'accueil', 0);
  assert.equal(next.menus[0].options.length, 0);
  assert.equal(voiceFlowSchema.safeParse(next).success, false);
  assert.equal(nextDigit(next.menus[0]), '1');
});

test('digit allocation includes zero, stops at ten choices and reuses deleted digits', () => {
  const menu = defaultVoiceFlow().menus[0];
  menu.options = Array.from({ length: 9 }, (_, index) => ({ digit: String(index + 1), label: 'destination', destination: { type: 'voicemail' } }));
  assert.equal(nextDigit(menu), '0');
  menu.options.push({ digit: '0', label: 'destination', destination: { type: 'voicemail' } });
  assert.equal(nextDigit(menu), undefined);
  menu.options = menu.options.filter(option => option.digit !== '4');
  assert.equal(nextDigit(menu), '4');
});

test('provisioning collects only queues used in reachable routes, including fallbacks', () => {
  let flow = defaultVoiceFlow();
  flow.menus[0].fallback = { type: 'queue', queueId: 'fallback' };
  flow = addSubmenu(flow, { kind: 'closed' }, 'night');
  flow.menus[1].options[0].destination = { type: 'queue', queueId: 'night' };
  flow.menus.push({ ...structuredClone(flow.menus[0]), id: 'unused', fallback: { type: 'queue', queueId: 'unused' } });
  assert.deepEqual([...referencedQueueIds(flow)].sort(), ['fallback', 'night']);
});

test('wrapping a shared menu preserves every route to it', () => {
  let flow = addSubmenu(defaultVoiceFlow(), { kind: 'branch', menuId: 'accueil', index: 0 }, 'support');
  flow = addSubmenu(flow, { kind: 'entry' }, 'root');
  assert.deepEqual(flow.entry, { type: 'menu', menuId: 'root' });
  assert.equal(flow.menus.length, 3);
  assert.deepEqual(flow.menus.find(menu => menu.id === 'root').options[0].destination, { type: 'menu', menuId: 'accueil' });
  assert.equal(voiceFlowSchema.safeParse(flow).success, true);
});

test('deleting the root menu reconnects to its fallback and preserves the original draft', () => {
  const flow = addSubmenu(defaultVoiceFlow(), { kind: 'branch', menuId: 'accueil', index: 0 }, 'child');
  flow.menus[0].fallback = { type: 'number', number: '+33123456789' };
  const next = removeMenu(flow, 'accueil');
  assert.deepEqual(next.entry, flow.menus[0].fallback);
  assert.deepEqual(next.menus, []);
  assert.equal(flow.menus.length, 2);
  assert.deepEqual(flow.entry, { type: 'menu', menuId: 'accueil' });
  assert.equal(voiceFlowSchema.safeParse(next).success, true);
});

test('deleting a shared menu reconnects branches, fallbacks and the closed route', () => {
  const flow = addSubmenu(defaultVoiceFlow(), { kind: 'branch', menuId: 'accueil', index: 0 }, 'shared');
  flow.menus[0].options.push({ digit: '2', label: 'autre choix', destination: { type: 'menu', menuId: 'shared' } });
  flow.menus[0].fallback = { type: 'menu', menuId: 'shared' };
  flow.schedule.closed = { type: 'menu', menuId: 'shared' };
  const next = removeMenu(flow, 'shared');
  assert.equal(next.menus.length, 1);
  assert.ok(next.menus[0].options.every(option => option.destination.type === 'voicemail'));
  assert.deepEqual(next.menus[0].fallback, { type: 'voicemail' });
  assert.deepEqual(next.schedule.closed, { type: 'voicemail' });
  assert.equal(voiceFlowSchema.safeParse(next).success, true);
});

test('deleting a menu preserves its fallback subtree and menus still used elsewhere', () => {
  let flow = addSubmenu(defaultVoiceFlow(), { kind: 'branch', menuId: 'accueil', index: 0 }, 'shared');
  flow = addSubmenu(flow, { kind: 'fallback', menuId: 'accueil' }, 'fallback');
  flow.schedule.closed = { type: 'menu', menuId: 'shared' };
  const next = removeMenu(flow, 'accueil');
  assert.deepEqual(next.entry, { type: 'menu', menuId: 'fallback' });
  assert.deepEqual(next.menus.map(menu => menu.id), ['shared', 'fallback']);
  assert.equal(voiceFlowSchema.safeParse(next).success, true);
});

test('deleting a menu with a self-reference never leaves a dangling destination', () => {
  const flow = defaultVoiceFlow();
  flow.menus[0].fallback = { type: 'menu', menuId: 'accueil' };
  const next = removeMenu(flow, 'accueil');
  assert.deepEqual(next.entry, { type: 'voicemail' });
  assert.equal(voiceFlowSchema.safeParse(next).success, true);
  assert.equal(removeMenu(flow, 'missing'), flow);
});

test('clearing an action preserves its key and requires a replacement before saving', () => {
  const flow = defaultVoiceFlow();
  const target = { kind: 'branch', menuId: 'accueil', index: 0 };
  const next = clearDestination(flow, target);
  assert.equal(next.menus[0].options[0].digit, '1');
  assert.equal(next.menus[0].options[0].label, 'laisser un message');
  assert.equal(isEmptyDestination(next.menus[0].options[0].destination), true);
  assert.equal(voiceFlowSchema.safeParse(next).success, false);
  assert.equal(voiceFlowSchema.safeParse(replaceDestination(next, target, { type: 'hangup' })).success, true);
  assert.deepEqual(flow.menus[0].options[0].destination, { type: 'voicemail' });
});

test('adding a menu to an empty action starts with a usable voicemail destination', () => {
  const target = { kind: 'branch', menuId: 'accueil', index: 0 };
  const flow = clearDestination(defaultVoiceFlow(), target);
  const next = addSubmenu(flow, target, 'new');
  assert.deepEqual(next.menus.find(menu => menu.id === 'new').options[0].destination, { type: 'voicemail' });
  assert.equal(voiceFlowSchema.safeParse(next).success, true);
});
