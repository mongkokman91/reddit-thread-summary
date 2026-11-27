const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');

const script = readFileSync(join(__dirname, '..', 'reddit-thread-summary.user.js'), 'utf8');
const slot = 'rts.apiKey';

function load(storage, { entered = null, confirm = false, canWrite = true } = {}) {
  const prompts = [], alerts = [];
  const context = {
    __RTS_TEST__: true,
    GM_getValue: (key, fallback) => storage.get(key) ?? fallback,
    GM_setValue: (key, value) => { if (canWrite) storage.set(key, value); },
    GM_deleteValue: key => { if (canWrite) storage.delete(key); },
    window: { prompt: (...args) => (prompts.push(args), entered), confirm: () => confirm, alert: value => alerts.push(value) }
  };
  vm.runInNewContext(script, context);
  return { ...context.__RTS__, prompts, alerts };
}

test('one entry persists in a fresh userscript context, including in-place upgrades', () => {
  const storage = new Map();
  let script = load(storage, { entered: ' test-key ' });
  assert.equal(script.askForKey(), true);
  assert.equal(storage.get(slot), 'test-key');
  for (let i = 0; i < 2; i++) {
    script = load(storage);
    assert.equal(script.getKey(), 'test-key');
    assert.deepEqual(script.prompts, []);
  }
});

test('existing key is never prefilled; blank and cancel leave it intact', () => {
  const storage = new Map([[slot, 'test-key']]);
  const blank = load(storage, { entered: ' ' });
  assert.equal(blank.askForKey(), true);
  assert.equal(blank.prompts[0][1], '');
  assert.ok(!blank.prompts[0][0].includes('test-key'));
  assert.equal(load(storage).askForKey(), false);
  assert.equal(storage.get(slot), 'test-key');
});

test('replacement and confirmed removal work without affecting other settings', () => {
  const storage = new Map([[slot, 'old-key'], ['rts.model', 'unchanged']]);
  const script = load(storage, { entered: 'new-key', confirm: true });
  assert.equal(script.askForKey(), true);
  assert.equal(script.getKey(), 'new-key');
  assert.equal(load(storage).forgetKey(), false);
  assert.equal(script.forgetKey(), true);
  assert.equal(load(storage).getKey(), '');
  assert.equal(storage.get('rts.model'), 'unchanged');
});

test('failed storage writes are reported without printing keys', () => {
  const storage = new Map([[slot, 'test-key']]);
  const script = load(storage, { entered: 'new-key', confirm: true, canWrite: false });
  assert.equal(script.askForKey(), false);
  assert.equal(script.forgetKey(), false);
  assert.equal(script.getKey(), 'test-key');
  assert.equal(script.alerts.length, 2);
  assert.ok(!script.alerts.join(' ').includes('new-key'));
});
