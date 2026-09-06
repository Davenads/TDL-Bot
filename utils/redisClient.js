const { createClient } = require('redis');

/**
 * Optional Redis connection for read caching (roster map, current-week signups).
 * The bot runs fully without it — every cached read degrades to a live Sheets read.
 *
 * Heroku posture: the connection URL comes from whichever Redis add-on is attached,
 * resolved in priority order:
 *   REDIS_URL       - Heroku Data for Redis (Heroku's first-party add-on)
 *   REDISCLOUD_URL  - Redis Cloud add-on (Redis Ltd)
 *   REDIS_TLS_URL   - explicit TLS endpoint some plans also expose
 *
 * TLS caveat: Heroku Data for Redis serves TLS (`rediss://`) with a SELF-SIGNED
 * certificate, so the handshake fails under Node's default CA verification. When
 * the resolved URL is `rediss://` we set `socket.tls` with `rejectUnauthorized:
 * false` — the traffic is still encrypted, we just skip CA-chain validation (the
 * documented approach for Heroku Redis). Non-TLS `redis://` URLs (typical Redis
 * Cloud free tier) connect as-is.
 */

const REDIS_ENV_VARS = ['REDIS_URL', 'REDISCLOUD_URL', 'REDIS_TLS_URL'];

function resolveRedisUrl(env = process.env) {
    for (const key of REDIS_ENV_VARS) {
        if (env[key]) return env[key];
    }
    return null;
}

// Retry indefinitely with capped backoff so a transient Redis outage self-heals
// (cache is optional; isReady() gates every read to a live-Sheets fallback meanwhile).
function reconnectStrategy(retries) {
    return Math.min(retries * 200, 5000);
}

function buildClientOptions(url) {
    const socket = { reconnectStrategy };
    if (typeof url === 'string' && url.startsWith('rediss://')) {
        // Heroku Redis uses self-signed certs; encrypt but skip CA verification.
        socket.tls = true;
        socket.rejectUnauthorized = false;
    }
    return { url, socket };
}

class RedisClient {
    constructor() {
        this.client = null;
        this.isConnected = false;
    }

    async connect() {
        if (this.isConnected && this.client) return this.client;

        const url = resolveRedisUrl();
        if (!url) {
            console.log('No Redis URL configured — running without cache.');
            return null;
        }

        this.client = createClient(buildClientOptions(url));

        // An 'error' listener MUST exist or node-redis throws unhandled and crashes
        // the process — this is what keeps a Redis outage from taking the bot down.
        this.client.on('error', (err) => {
            console.error('Redis client error:', err.message);
            this.isConnected = false;
        });
        this.client.on('ready', () => {
            console.log('Redis ready');
            this.isConnected = true;
        });
        this.client.on('end', () => {
            console.log('Redis connection closed');
            this.isConnected = false;
        });
        this.client.on('reconnecting', () => {
            console.log('Redis reconnecting...');
        });

        await this.client.connect();
        return this.client;
    }

    // Graceful teardown for dyno cycling (Heroku SIGTERM). v5: close() replaces quit().
    async close() {
        if (!this.client) return;
        try {
            await this.client.close();
        } catch (err) {
            console.warn('Redis close failed:', err.message);
        } finally {
            this.isConnected = false;
        }
    }

    getClient() {
        return this.client;
    }

    isReady() {
        return this.isConnected && !!this.client;
    }
}

const instance = new RedisClient();
// Exposed for unit tests (pure URL/option resolution — no network).
instance._internals = { resolveRedisUrl, buildClientOptions, reconnectStrategy, REDIS_ENV_VARS };
module.exports = instance;
