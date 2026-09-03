/**
 * Thin caching layer over the optional Redis connection (`redisClient.js`).
 *
 * Design contract (see plan/07-redis-caching.md):
 *  - Redis is a CACHE, never the source of truth. Every helper degrades
 *    gracefully: if Redis is down/unready or a call throws, reads return
 *    `null` (forcing a live fallback) and writes/evicts become silent no-ops.
 *    A cache failure must NEVER fail or slow a user-facing command.
 *  - Values are stored as JSON strings.
 *
 * node-redis v5 keeps the object-form expiration on SET —
 * `client.set(key, value, { EX: seconds })` — and leaves GET/DEL unchanged.
 * (redis/node-redis docs/v4-to-v5.md)
 */

const redis = require('./redisClient');

// Namespace every key with `tdl:` so a shared Redis instance (e.g. alongside
// the DFC bot, which uses `dfc-data:`) can't collide.
const KEYS = {
    ROSTER: 'tdl:roster'
};

// TTLs in seconds. The roster is short so an out-of-band manual sheet edit
// self-heals within ~10 min even without an explicit eviction.
const TTL = {
    ROSTER_SEC: 600 // 10 minutes
};

/**
 * Get and JSON-parse a cached value.
 * @returns {Promise<any|null>} parsed value, or null on miss/error/unready.
 */
async function cacheGet(key) {
    if (!redis.isReady()) return null;
    try {
        const raw = await redis.getClient().get(key);
        return raw ? JSON.parse(raw) : null;
    } catch (err) {
        console.warn(`cacheGet(${key}) failed (non-fatal):`, err.message);
        return null;
    }
}

/**
 * JSON-stringify and store a value with a TTL. Silent no-op on error/unready.
 * @returns {Promise<boolean>} true if a write was issued, false otherwise.
 */
async function cacheSet(key, value, ttlSec) {
    if (!redis.isReady()) return false;
    try {
        await redis.getClient().set(key, JSON.stringify(value), { EX: ttlSec });
        return true;
    } catch (err) {
        console.warn(`cacheSet(${key}) failed (non-fatal):`, err.message);
        return false;
    }
}

/**
 * Delete (evict) a key. Silent no-op on error/unready.
 * @returns {Promise<boolean>} true if a delete was issued, false otherwise.
 */
async function cacheDel(key) {
    if (!redis.isReady()) return false;
    try {
        await redis.getClient().del(key);
        return true;
    } catch (err) {
        console.warn(`cacheDel(${key}) failed (non-fatal):`, err.message);
        return false;
    }
}

module.exports = { KEYS, TTL, cacheGet, cacheSet, cacheDel };
