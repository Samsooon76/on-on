import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editDialNumber, isDialableNumber, isMissedCall, normalizePhone } from '../src/phone.ts';

test('keeps international destinations and the existing Belgian local-number convention', () => {
  assert.equal(normalizePhone('+33 6 12 34 56 78'), '+33612345678');
  assert.equal(normalizePhone('0032 470 00 00 00'), '+32470000000');
  assert.equal(normalizePhone('0470 00 00 00'), '+32470000000');
});

test('does not silently turn a service code or malformed input into a phone call', () => {
  for (const invalid of ['', '+', '123', '*32470000000#', '+32+470000000', 'call +32470000000', '+0123456789', '+1234567890123456']) {
    assert.equal(isDialableNumber(invalid), false, invalid);
  }
  assert.equal(isDialableNumber(' +33 (6) 12-34-56-78 '), true);
  assert.equal(isDialableNumber('0470 00 00 00'), true);
});

test('edits the selected digits without replacing the rest of the destination', () => {
  assert.deepEqual(editDialNumber('+32470', { start: 3, end: 5 }, '9'), { value: '+3290', selection: { start: 4, end: 4 } });
  assert.deepEqual(editDialNumber('+32470', { start: 3, end: 3 }, '1'), { value: '+321470', selection: { start: 4, end: 4 } });
});

test('backspace deletes before the cursor, handles selection and leaves an empty input stable', () => {
  assert.equal(editDialNumber('+32470', { start: 6, end: 6 }, null).value, '+3247');
  assert.equal(editDialNumber('+32470', { start: 1, end: 3 }, null).value, '+470');
  assert.deepEqual(editDialNumber('', { start: 0, end: 0 }, null), { value: '', selection: { start: 0, end: 0 } });
  assert.equal(editDialNumber('+32470', { start: 0, end: 0 }, null).value, '+32470');
});

test('supports international prefix from the zero key and caps pasted/typed numbers', () => {
  assert.equal(editDialNumber('', { start: 0, end: 0 }, '+').value, '+');
  const number = '1'.repeat(32);
  assert.deepEqual(editDialNumber(number, { start: 32, end: 32 }, '2'), { value: number, selection: { start: 32, end: 32 } });
});

test('missed calls exclude outgoing attempts and answered calls', () => {
  assert.equal(isMissedCall({ direction: 'inbound', status: 'no-answer' }), true);
  assert.equal(isMissedCall({ direction: 'inbound', status: 'canceled' }), true);
  assert.equal(isMissedCall({ direction: 'outbound', status: 'no-answer' }), false);
  assert.equal(isMissedCall({ direction: 'inbound', status: 'completed' }), false);
});
