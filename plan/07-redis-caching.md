# 07 — Redis Caching Strategy (Planning)

> **Status:** Planning only. Redis is wired as an **optional** connection
> (`utils/redisClient.js`) but nothing caches through it yet. This doc defines
> *what* to cache, *how*, and *when to invalidate* so we can add it deliberately.

## Why

Every `/signup` currently hits Google Sheets **twice** for the Roster alone (the
up-front gate read in `execute`, then a re-read in `handleModal` for the Data Name),
plus the Registration read for the upsert. As read-style commands land
(`/recentsignups`, `/standings`, `/elo`), Sheets reads dominate. Redis lets us serve
hot, rarely-changing data from memory and only fall back to Sheets on a miss.

## Guiding principles

1. **Redis is a cache, never the source of truth.** The sheet is authoritative.
   Every cached read must degrade gracefully to a live Sheets read if Redis is
   down or empty — mirror the existing `redisClient.isReady()` guard and DFC's
   fallback pattern.
2. **Correctness beats freshness for gates.** The roster **gate** must not wrongly
   block a just-registered player because of a stale cache (see Invalidation).
3. **Write-through on our own writes.** `/register` and `/signup` know exactly what
   changed — update/evict the relevant key inline instead of waiting for TTL.
4. **Fire-and-forget cache writes.** A cache set/evict failure must never fail or
   slow the user-facing command; `.catch(log)` it.

## What to cache (priority order)

| Priority | Data | Key | Value | TTL | Invalidate on |
|---|---|---|---|---|---|
| 1 | **Roster map** (whole tab) | `tdl:roster` | JSON: `{ uuid: { dataName, discordName, rowIndex } }` | ~10 min | `/register` write (evict or rewrite) |
| 2 | Current-week signups | `tdl:signups:current` | JSON array of rows | ~1–3 h | `/signup` write (evict) |
| 3 | Standings / ELO (future) | `tdl:standings`, `tdl:elo:*` | JSON | ~1–3 h | cron refresh around event |

> Namespacing: prefix everything `tdl:` (DFC uses `dfc-data:`) to avoid collisions
> if the two bots ever share a Redis instance.

### 1. Roster map — the highest-value target

- **Read path:** a `getRosterMap()` helper tries Redis first; on miss, reads
  `Roster!A:C`, builds the `uuid → {…}` map, `SET` with TTL, returns it.
  `/signup`'s gate + Data Name resolution both consume this one map (collapses the
  two current Sheets reads into at most one, often zero).
- **rowIndex caveat:** the cached `rowIndex` is only valid until the tab is edited.
  The col-B username refresh and `/register` update use `rowIndex` — if a cached
  index could be stale after an out-of-band manual sheet edit, prefer re-resolving
  the row from a fresh read *inside the write path*, or accept that manual edits
  evict via TTL. Keep writes reading fresh; let only the **gate/display** read use
  cache. (Simplest safe split: cache the *membership + Data Name*, not write targets.)

### 2. Current-week signups

- Port DFC's `signupsCache.js` shape. Used by a future `/recentsignups` and for
  dedupe reads. Evict `tdl:signups:current` after any `/signup` upsert.

## Invalidation — the part that matters

- **`/register` write → roster cache:** after a successful `registerRosterEntry`,
  **evict `tdl:roster`** (or rewrite it). This guarantees the next `/signup` gate
  sees the new member. Without this, a player could register and still be blocked
  from signing up until the TTL lapsed — unacceptable. Eviction is the safe default;
  rewrite is an optimization.
- **Manual sheet edits (admin edits Roster directly):** not observable by the bot,
  so these rely on **TTL** (hence the short ~10 min roster TTL). Document that admins
  may wait up to one TTL for a hand-edit to take effect, or add an admin
  `/refreshcache` command later.
- **`/signup` write → signups cache:** evict `tdl:signups:current` after the upsert
  (fire-and-forget).

## Wiring pattern

```js
const redis = require('./utils/redisClient');

async function cacheGet(key) {
    if (!redis.isReady()) return null;
    try { const v = await redis.getClient().get(key); return v ? JSON.parse(v) : null; }
    catch (e) { console.warn(`cache get ${key} failed:`, e.message); return null; }
}
async function cacheSet(key, val, ttlSec) {
    if (!redis.isReady()) return;
    try { await redis.getClient().set(key, JSON.stringify(val), { EX: ttlSec }); }
    catch (e) { console.warn(`cache set ${key} failed:`, e.message); }
}
async function cacheDel(key) {
    if (!redis.isReady()) return;
    try { await redis.getClient().del(key); } catch (e) { console.warn(`cache del ${key} failed:`, e.message); }
}
```

Put these in a small `utils/cache.js`; keep `redisClient.js` as the raw connection.

## Phasing

1. **Phase A (first win):** `getRosterMap()` read-through cache + evict on
   `/register`. Immediately cuts the `/signup` hot-path Sheets reads. Write paths
   (col-B refresh, `/register` update) keep reading fresh to avoid stale `rowIndex`.
2. **Phase B:** current-week signups cache + `/recentsignups`.
3. **Phase C:** standings/ELO caches with a `node-cron` refresh around the Monday
   event (`node-cron` is already a dependency).

## Non-goals / risks

- **No cache for write correctness.** Never resolve a write target (`rowIndex`,
  dedupe match) purely from cache — always confirm against a fresh read in the write
  path. Cache is for read/gate/display only.
- **Single dyno assumption.** With `web=1` (see `05`), there's one process; no
  cross-dyno invalidation concerns. If we ever scale >1, eviction must be
  centralized in Redis (it is) — but we already forbid >1 dyno (duplicate bots).
- **Redis outage = full fallback.** Everything must work (slower) with Redis down.
