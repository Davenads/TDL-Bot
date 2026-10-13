/**
 * Durable binding for the persistent signup panel: which message in which
 * channel the bot keeps editing with the live roster.
 *
 * Unlike the caches in `cache.js`, this key has NO TTL — it must survive across
 * restarts so the bot can re-find and refresh its panel on boot. Stored in Redis
 * because that is the only durable store the bot has; if Redis is wiped the
 * binding is lost and an admin re-runs `/tdlpanel` (the buttons still work —
 * their customIds are static). Mode-namespaced so test/prod never collide.
 *
 * Every helper degrades gracefully (Redis down/unready or a throw → null/no-op)
 * so panel bookkeeping can never fail or slow a user-facing interaction.
 */

const redis = require('./redisClient');

const PANEL_KEY = process.env.TEST_MODE === 'true'
    ? 'tdl:panel:signup:test'
    : 'tdl:panel:signup';

/**
 * @returns {Promise<{channelId:string, messageId:string}|null>}
 */
async function getPanelBinding() {
    if (!redis.isReady()) return null;
    try {
        const raw = await redis.getClient().get(PANEL_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (err) {
        console.warn(`getPanelBinding failed (non-fatal):`, err.message);
        return null;
    }
}

/**
 * Persist the panel binding (no expiry).
 * @param {{channelId:string, messageId:string}} binding
 * @returns {Promise<boolean>} true if written.
 */
async function setPanelBinding(binding) {
    if (!redis.isReady()) return false;
    try {
        await redis.getClient().set(PANEL_KEY, JSON.stringify(binding));
        return true;
    } catch (err) {
        console.warn(`setPanelBinding failed (non-fatal):`, err.message);
        return false;
    }
}

/**
 * Drop the binding (e.g. the panel message was deleted).
 * @returns {Promise<boolean>} true if a delete was issued.
 */
async function clearPanelBinding() {
    if (!redis.isReady()) return false;
    try {
        await redis.getClient().del(PANEL_KEY);
        return true;
    } catch (err) {
        console.warn(`clearPanelBinding failed (non-fatal):`, err.message);
        return false;
    }
}

module.exports = { PANEL_KEY, getPanelBinding, setPanelBinding, clearPanelBinding };
