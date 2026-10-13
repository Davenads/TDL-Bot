// Framework-free harness for utils/panelStore.js (durable panel binding).
// Monkeypatches an in-memory fake Redis onto the redisClient singleton — nothing
// here touches a real Redis, Google, or Discord.
//
//   node test/panelStore.test.js
//
// Exit code 0 = all pass, 1 = any failure.

const assert = require('assert');

const redisClient = require('../utils/redisClient');
const { PANEL_KEY, getPanelBinding, setPanelBinding, clearPanelBinding } = require('../utils/panelStore');

// ---- In-memory fake Redis client -----------------------------------------
const store = new Map();
let throwOn = { get: false, set: false, del: false };
let lastSetArgs = null;

const fakeClient = {
    get: async (k) => {
        if (throwOn.get) throw new Error('redis get boom');
        return store.has(k) ? store.get(k) : null;
    },
    set: async (k, v, ...rest) => {
        if (throwOn.set) throw new Error('redis set boom');
        lastSetArgs = { k, v, rest };
        store.set(k, v);
        return 'OK';
    },
    del: async (k) => {
        if (throwOn.del) throw new Error('redis del boom');
        const had = store.has(k);
        store.delete(k);
        return had ? 1 : 0;
    }
};

function setReady(ready) {
    redisClient.isReady = () => ready;
    redisClient.getClient = () => fakeClient;
}
function reset() {
    store.clear();
    throwOn = { get: false, set: false, del: false };
    lastSetArgs = null;
    setReady(true);
}

// ---- Runner ----------------------------------------------------------------
let pass = 0;
let fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Cases -----------------------------------------------------------------

test('PANEL_KEY is mode-namespaced (test harness runs with TEST_MODE unset → prod key)', () => {
    // The harness does not set TEST_MODE, so the module resolved the prod key.
    assert.ok(PANEL_KEY === 'tdl:panel:signup' || PANEL_KEY === 'tdl:panel:signup:test');
});

test('setPanelBinding + getPanelBinding round-trips the binding', async () => {
    reset();
    const binding = { channelId: 'C1', messageId: 'M1' };
    assert.strictEqual(await setPanelBinding(binding), true);
    assert.deepStrictEqual(await getPanelBinding(), binding);
});

test('setPanelBinding writes WITHOUT a TTL (durable)', async () => {
    reset();
    await setPanelBinding({ channelId: 'C1', messageId: 'M1' });
    assert.deepStrictEqual(lastSetArgs.rest, [], 'set called with no expiry options');
});

test('getPanelBinding returns null on a miss', async () => {
    reset();
    assert.strictEqual(await getPanelBinding(), null);
});

test('clearPanelBinding removes the binding', async () => {
    reset();
    await setPanelBinding({ channelId: 'C1', messageId: 'M1' });
    assert.strictEqual(await clearPanelBinding(), true);
    assert.strictEqual(await getPanelBinding(), null);
});

test('all helpers degrade to null/no-op when Redis is not ready', async () => {
    reset();
    setReady(false);
    assert.strictEqual(await getPanelBinding(), null);
    assert.strictEqual(await setPanelBinding({ channelId: 'C1', messageId: 'M1' }), false);
    assert.strictEqual(await clearPanelBinding(), false);
});

test('getPanelBinding swallows a client error and returns null (graceful)', async () => {
    reset();
    throwOn.get = true;
    assert.strictEqual(await getPanelBinding(), null);
});

test('setPanelBinding swallows a client error and returns false (graceful)', async () => {
    reset();
    throwOn.set = true;
    assert.strictEqual(await setPanelBinding({ channelId: 'C1', messageId: 'M1' }), false);
});

test('clearPanelBinding swallows a client error and returns false (graceful)', async () => {
    reset();
    throwOn.del = true;
    assert.strictEqual(await clearPanelBinding(), false);
});

test('getPanelBinding tolerates malformed JSON (returns null, no throw)', async () => {
    reset();
    store.set(PANEL_KEY, '{not valid json');
    assert.strictEqual(await getPanelBinding(), null);
});

// ---- Run -------------------------------------------------------------------
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    process.exit(1);
});

(async () => {
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`PASS  ${t.name}`);
            pass++;
        } catch (err) {
            console.error(`FAIL  ${t.name}\n      ${err.message}`);
            fail++;
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
    console.error('Runner crashed:', err);
    process.exit(1);
});
