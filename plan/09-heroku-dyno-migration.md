# 09 — Heroku Dyno Migration: Retire NvD-Bot, Deploy TDL-Bot Without Losing Shared Redis

**Status:** Planning / decision doc
**Date:** 2026-10-07
**Owner:** David

---

## 1. The Issue

Four Discord bots run as separate Heroku apps under one Personal account:

| Heroku app | GitHub repo (local dir) | Role |
|---|---|---|
| `nvd-bot` | `Davenads/NvD-Bot` (`NvD-Bot/`) | NvD ladder — **owns the Redis add-on** |
| `svs-bot` | (`SvS-Bot-2/`) | SvS ladder |
| `dfc-data` | (`DFC-Data/`) | DFC data/signups |
| `d2r-1v1-bot` | (`D2R-PvP-1v1-Bot/`) | 1v1 queue ladder |

One **Redis Cloud** add-on (`rediscloud-clear-19473`, free 30 MB) is provisioned on the **`nvd-bot`** app. The other three bots "piggyback" on that same instance by referencing its connection URL in their own config vars. NvD is going inactive; we want to **put TDL-Bot where NvD-Bot is** without losing the Redis instance that all four bots share, and ideally without losing existing Redis keys.

### Two questions to answer
1. Do we need to re-acquire a new Redis plugin?
2. Do we consequently need to update the Redis-related env vars on all the bots?

**Short answer: No and No — if we repurpose the `nvd-bot` app in place instead of deleting it.** Details below.

---

## 2. Current-State Architecture (verified from code)

### 2.1 Who owns Redis
- The Redis Cloud add-on lives on **`nvd-bot`**. Its lifecycle is bound to that app: **delete the app (or remove the add-on) and the Redis instance — and all its data — is destroyed**, which simultaneously breaks the other three bots.
- Redis Cloud free tier is **limited to 1 per account**. We cannot spin up a *second* free Redis Cloud add-on on another app while this one exists. (A different provider — e.g. Heroku Key-Value Store / Heroku Data for Redis — would not hit this limit, but that's the fallback, not the plan.)

### 2.2 How each bot consumes the URL (naming is inconsistent — important)

| Bot | Env var it reads | Source file |
|---|---|---|
| NvD | `REDISCLOUD_URL` | `NvD-Bot/redis-client.js` (set automatically by the add-on on this app) |
| SvS | `REDISCLOUD_URL` | `SvS-Bot-2/redis-client.js` (URL copied in manually) |
| DFC | `REDISCLOUD_URL` | `DFC-Data/utils/redisClient.js` (URL copied in manually) |
| D2R | **`REDIS_URL`** | `D2R-PvP-1v1-Bot/src/config.ts` (URL copied in manually, different var name) |
| **TDL** | `REDIS_URL` → **`REDISCLOUD_URL`** → `REDIS_TLS_URL` (priority order) | `TDL-Bot/utils/redisClient.js` |

Two takeaways:
- They are **not** using Heroku's `addons:attach` to share the add-on; they manually pasted the endpoint URL into each app's config vars.
- **TDL-Bot already resolves `REDISCLOUD_URL`** (2nd priority). So on an app where the Redis Cloud add-on is present, TDL connects with **zero Redis config** needed — the add-on sets `REDISCLOUD_URL` and TDL picks it up.

### 2.3 Key namespacing — no collisions on the shared instance
Every bot prefixes its keys, so they coexist safely on one Redis:
- NvD → `nvd:challenge:*`, `nvd:challenge-warning:*`, `nvd:cooldown:*`, `nvd:warning-lock:*` (every key has a TTL)
- SvS → `svs:season:*`, `svs:titledefends:*`, …
- DFC → `dfc-data:*` (plus some in-process node-cache)
- D2R → its own `cache.ts` keyspace
- TDL → `tdl:roster`, `tdl:signups:current[:test]`

Retiring NvD simply leaves `nvd:*` keys behind; they all carry TTLs and **self-expire**. They never collide with TDL's `tdl:*` keys.

---

## 3. "Confirm this" — Cache Sync/Refresh Functionality

**Confirmed: Google Sheets is the system of record for all four bots; Redis holds only rebuildable caches and ephemeral timers.** If the Redis instance were wiped tomorrow, no durable data is lost — caches repopulate on the next read, and the only visible effect would be that in-flight NvD/SvS challenge timers and cooldowns reset.

| Bot | Refresh/rebuild mechanism |
|---|---|
| NvD | On challenge expiry it reconstructs challenge data **from the NvD Ladder sheet** if Redis is empty (`handleChallengeExpiry`); ladder truth = Sheets |
| SvS | `/syncredis` command + `challenge-expiry-*` services rebuild from Sheets |
| DFC | `/refreshcache` command + read-through `utils/*Cache.js` |
| D2R | `refreshCache.ts` / `refreshLadder.ts` admin commands + read-through `services/cache.ts` |
| TDL | Read-through roster + current-week signups; delete-on-write invalidation; **degrades to a live Sheets read whenever Redis is unavailable** |

So preserving Redis keys is a *nice-to-have*, not a correctness requirement. The recommended plan preserves them anyway (zero wipe), so this is moot — but it's the safety net that makes the whole migration low-risk.

---

## 4. The Core Misconception to Clear Up: Dyno vs. App

You can't move a *dyno* between apps — the **app** is the unit that owns the dyno, the GitHub connection, the config vars, **and the add-on**. "Replace TDL-Bot into NvD's dyno" really means: **repoint the `nvd-bot` app's deploy source to the TDL-Bot repo and deploy.** Keeping that app alive is exactly what preserves the Redis add-on.

The single destructive action to **avoid**: clicking **Delete app** on `nvd-bot`, or removing the Redis Cloud add-on. Either one destroys the shared instance and breaks SvS, DFC, and D2R.

---

## 5. Recommendation — Repurpose `nvd-bot` In Place (Plan A)

This keeps the Redis add-on owned by the same app, so the endpoint URL never changes, nothing is wiped, and **no other bot needs any change**.

### Steps
1. **Stop NvD's workload.** In `nvd-bot` → Resources, turn the `web` dyno OFF (or scale to 0). This halts NvD's scheduled tasks/expiry handlers so they stop acting on the sheet. Leave the app and add-on intact.
2. **Repoint the deploy source.** `nvd-bot` → Deploy → Disconnect `Davenads/NvD-Bot`, connect the **TDL-Bot GitHub repo**, branch `main`. (Enable automatic deploys if desired.)
3. **Set TDL's config vars** on this app (Settings → Config Vars): `BOT_TOKEN`, `CLIENT_ID`, `PROD_GUILD_ID`/`GUILD_ID` as needed, `TDL_SPREADSHEET_ID`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, and **`TEST_MODE=false`** for prod. **Do NOT set any Redis var** — the add-on already injects `REDISCLOUD_URL`, which TDL resolves automatically.
   - Remove NvD-specific vars that no longer apply (e.g. NvD's `SPREADSHEET_ID`, channel IDs) to keep the app clean. Leaving them set is harmless but messy.
4. **Confirm the Procfile.** TDL must run its worker/bot process (`web: node index.js` is fine on a basic dyno, matching the current formation). Verify `Procfile` matches what the app expects.
5. **Deploy** (manual deploy of `main`, or push to trigger auto-deploy). Watch `heroku logs --tail --app nvd-bot`: expect a clean Discord login and `Redis ready`.
6. **(Optional) Rename the app** `nvd-bot` → `tdl-bot` (Settings → Rename, or `heroku apps:rename tdl-bot --app nvd-bot`). **This does not change the Redis Cloud endpoint URL** and does **not** break the other bots, because they hold the raw Redis endpoint, not an `nvd-bot`-derived hostname. (It *will* change the app's own git remote/URL — reconnect local git remote if you push manually.)
7. **Smoke test TDL in prod**, then retire NvD's Discord registration (remove its slash commands from its guilds via NvD's `clear-commands.js` if you want them gone).

### Why this satisfies both questions
- **New Redis plugin?** No. The same add-on keeps running on the same app; TDL just becomes its primary consumer (which is sensible — TDL is the active bot now).
- **Update env vars on all bots?** No. SvS/DFC/D2R keep pointing at the same unchanged endpoint. Zero changes to their config vars. No data wipe.

---

## 6. Optional Hardening (do later, not required for the migration)

Right now the shared URL is copy-pasted into each app. If Redis Cloud ever rotates the credential, all four bots break until you re-paste. To make Heroku manage it:

```
# Attach the existing add-on to the other apps so Heroku owns the shared credential.
heroku addons:attach rediscloud-clear-19473 --app svs-bot
heroku addons:attach rediscloud-clear-19473 --app dfc-data
# D2R reads REDIS_URL, so attach under that alias:
heroku addons:attach rediscloud-clear-19473 --app d2r-1v1-bot --as REDIS
```

Caveat: the **owning app still controls lifecycle** — even with attachments, deleting the owner app breaks everyone. Since we're keeping the owner app alive (now as TDL), that's fine. This step only improves credential-rotation resilience; it is **not** needed to complete the migration.

---

## 7. Fallback — Dedicated Redis for TDL (Plan B, only if you insist on a clean split)

If you ever want Redis *not* tied to the legacy NvD app:
1. Provision a fresh store on a chosen app. Because Redis Cloud free is 1-per-account, either first remove the existing one (destructive) **or** use **Heroku Key-Value Store / Heroku Data for Redis** (different product, no 1-per-account clash). That provides `REDIS_URL` as `rediss://` (TLS) — TDL already handles self-signed TLS, so it works out of the box.
2. Update the Redis env var on **all four** bots to the new endpoint (`REDISCLOUD_URL` for SvS/DFC/NvD-successor, `REDIS_URL` for D2R).
3. Accept a cache wipe (keys don't migrate unless you dump/restore). Safe because of §3 — caches rebuild; only live NvD/SvS timers reset.

**Cost:** touches every bot's config, risks a coordinated cutover, and gains little over Plan A. Not recommended unless there's a billing/ownership reason to divorce the add-on from the legacy app.

---

## 8. Rollback

Plan A is reversible until you delete NvD's repo connection permanently:
- If TDL misbehaves on the app, reconnect `Davenads/NvD-Bot` in Deploy, restore NvD's config vars, redeploy, turn the dyno back on. The Redis add-on never moved, so the other three bots were unaffected throughout.
- Keep a copy of NvD's current config vars (screenshot Settings → Config Vars) **before** step 3 so a rollback is trivial.

---

## 9. TL;DR

- **Don't delete `nvd-bot`.** Repurpose that app: swap its GitHub repo to TDL-Bot, set TDL's config vars, deploy. Optionally rename to `tdl-bot`.
- The Redis Cloud add-on stays put → **no new plugin, no env-var changes on any bot, no data wipe.**
- TDL auto-connects via the add-on's `REDISCLOUD_URL` (already in its resolver). Set `TEST_MODE=false`.
- Cache/refresh is confirmed on all bots; Redis holds only rebuildable caches + TTL'd timers, so even a worst-case wipe is non-fatal.
