// Framework-free harness for the Redis connection layer (redisClient.js).
// Covers the pure, network-free logic that makes the bot Heroku-ready:
// which env var supplies the URL, and how a TLS (rediss://) URL is wired.
//
//   node test/redis.test.js
//
// Exit code 0 = all pass, 1 = any failure.

const assert = require('assert');

const redisClient = require('../utils/redisClient');
const { resolveRedisUrl, buildClientOptions, reconnectStrategy, REDIS_ENV_VARS } =
    redisClient._internals;

// ---- Runner ----------------------------------------------------------------
let pass = 0;
let fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Cases: URL resolution (Heroku add-on flexibility) ---------------------

test('resolveRedisUrl prefers REDIS_URL (Heroku Data for Redis) first', () => {
    const env = {
        REDIS_URL: 'rediss://heroku',
        REDISCLOUD_URL: 'redis://rediscloud',
        REDIS_TLS_URL: 'rediss://tls'
    };
    assert.strictEqual(resolveRedisUrl(env), 'rediss://heroku');
});

test('resolveRedisUrl falls back to REDISCLOUD_URL (Redis Cloud add-on)', () => {
    const env = { REDISCLOUD_URL: 'redis://rediscloud' };
    assert.strictEqual(resolveRedisUrl(env), 'redis://rediscloud');
});

test('resolveRedisUrl falls back to REDIS_TLS_URL last', () => {
    const env = { REDIS_TLS_URL: 'rediss://tls' };
    assert.strictEqual(resolveRedisUrl(env), 'rediss://tls');
});

test('resolveRedisUrl returns null when no Redis var is set (cache disabled)', () => {
    assert.strictEqual(resolveRedisUrl({}), null);
});

test('REDIS_ENV_VARS lists the supported vars in priority order', () => {
    assert.deepStrictEqual(REDIS_ENV_VARS, ['REDIS_URL', 'REDISCLOUD_URL', 'REDIS_TLS_URL']);
});

// ---- Cases: TLS wiring (Heroku self-signed cert handling) ------------------

test('buildClientOptions enables TLS + skips CA verify for a rediss:// URL', () => {
    const opts = buildClientOptions('rediss://user:pass@host:6380');
    assert.strictEqual(opts.url, 'rediss://user:pass@host:6380');
    assert.strictEqual(opts.socket.tls, true);
    assert.strictEqual(opts.socket.rejectUnauthorized, false);
});

test('buildClientOptions leaves a plain redis:// URL non-TLS', () => {
    const opts = buildClientOptions('redis://user:pass@host:6379');
    assert.strictEqual(opts.url, 'redis://user:pass@host:6379');
    assert.strictEqual(opts.socket.tls, undefined);
    assert.strictEqual(opts.socket.rejectUnauthorized, undefined);
});

test('buildClientOptions always attaches a reconnect strategy', () => {
    const opts = buildClientOptions('redis://host:6379');
    assert.strictEqual(typeof opts.socket.reconnectStrategy, 'function');
});

// ---- Cases: reconnect backoff (bounded, self-healing) ----------------------

test('reconnectStrategy backs off linearly then caps at 5000ms', () => {
    assert.strictEqual(reconnectStrategy(0), 0);
    assert.strictEqual(reconnectStrategy(1), 200);
    assert.strictEqual(reconnectStrategy(10), 2000);
    assert.strictEqual(reconnectStrategy(100), 5000); // capped
});

// ---- Cases: readiness guard defaults ---------------------------------------

test('isReady() is false before any connection (drives Sheets fallback)', () => {
    assert.strictEqual(redisClient.isReady(), false);
});

// ---- Run -------------------------------------------------------------------
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
