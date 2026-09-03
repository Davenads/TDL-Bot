# TDL-Bot — Project Overview (Planning)

> **Status:** Scaffold built. `/signup`, `/register`, and `/recentsignups`
> implemented + unit-tested (not yet Discord-tested or deployed). Redis caching
> **Phases A & B** are built — Phase A (roster read-through + evict on `/register`)
> and Phase B (current-week signups read-through + evict on `/signup`, feeding
> `/recentsignups`). This folder is the source of truth for design decisions.

## What is TDL-Bot?

A Discord.js bot for the **Toeshank Dueling League (TDL)** — a weekly Diablo 2:
Resurrected PvP dueling event hosted by professional dueler **Toeshank**. Players
also queue for matches outside the weekly event.

The event runs **Mondays at 6:00 PM ET** and lasts roughly **4 hours**.

The bot's job (starting point): let players **sign up** for the weekly event via a
Discord slash command, writing their signup directly into the league's Google Sheet
(their current pseudo-database), while capturing the player's **Discord UUID** and
**current Discord username** — data a plain Google Form cannot reliably capture.

## Tech Stack (mirrors DFC-Data, the sibling project)

- **Node.js 20.x** + **discord.js v14** (slash commands, buttons, modals)
- **Google Sheets API** (`googleapis` v144) — primary persistence
- **Redis** (optional) — short-lived signup session state + light caching
- **Heroku** — deployment target (GitHub auto-deploy, same model as DFC-Data)
- **node-cron** — scheduled cache refreshes / window announcements (later)

## Reference Project: DFC-Data

TDL-Bot is architecturally modeled on `C:\Projects\DFC-Data`. Reusable patterns:

| DFC-Data component | Reuse for TDL |
|---|---|
| `utils/googleAuth.js` | Copy as-is (service-account JWT auth) |
| `utils/redisClient.js` | Copy as-is (optional cache/session) |
| `utils/signupCache.js` | Session state pattern (may not be needed — see signup plan) |
| `utils/dfcWeekUtils.js` | Adapt → `tdlWeekUtils.js` (Monday-event window logic) |
| `commands/signup.js` | Simplify heavily → TDL has no class/build steps |
| `commands/register.js` | Direct `spreadsheets.values.update` write pattern |
| `handlers/commandHandler.js` | Copy command-loading pattern |
| `index.js` | Copy bootstrap + button routing map |

### KEY DIFFERENCE FROM DFC

DFC submits signups by **POSTing to a Google Form** (`formResponse` URL). TDL will
instead **write directly to the Google Sheet via the Sheets API** (`values.append`).

**Why direct-write instead of a Form:**
- A public Google Form cannot capture a user's Discord UUID or live username.
- We already have a service account with Sheets write access (same as DFC's roster
  writes in `register.js`).
- Direct write lets us do dedupe / "upsert" logic (replace a user's existing signup
  for the week) which a Form append cannot.

## Google Sheet

- **Spreadsheet ID:** `1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww`
- **Live sign-up tab:** `Registration`
- **QA sign-up tab:** `Registration Test` ← bot writes here while `TEST_MODE=true`

### Known tabs (for future features)

| Tab | Purpose |
|---|---|
| `Results` | Match results — Timestamp, Email, Winner, Winner Build, Loser, Loser Build, Winner Score, Loser Score, Notes, Mirror, Title, Category |
| `Registration` | Weekly event signups (live) |
| `Registration Test` | Signups (QA) |
| `Roster` | Dueler identity map — `A` Data Name (rankings/data display), `B` Discord Name (last-parsed username, changes over time), `C` Discord UUID (stable join key) |
| `Standings` | League standings |
| `Ruleset` | Rules |
| `Builds` | Build list |
| `Result ID` | Result keys |
| `WL` | Win/Loss records |
| `ELO Ratings` / `ELO Wins` / `ELO Loss` / `ELO Join` / `ELO Summary` | ELO system |

### Registration tab columns

**Legacy (form-driven, retired):** `Status | Timestamp | Email Address | Name | Notes | Category`

**New (bot-driven, DECIDED):** `Timestamp | Discord UUID | Discord Username | Notes | Category`

> **DECIDED:** We are **reshaping** the tab to the new columns and going
> **bot-only** — the Google Form is **retired**, not rebuilt. Rationale: a Google
> Form cannot reliably capture a Discord UUID (its only injection path, pre-filled
> links, produces a user-editable field and still requires the bot in the loop). The
> bot writes rows directly via the Sheets API. See `04-google-form-retirement.md`.

### Roster tab — the Discord ↔ Data Name map

The `Roster` tab (`A` Data Name · `B` Discord Name · `C` Discord UUID) is the
identity bridge between a player's Discord account and how they appear in the
dueling data / rankings. This is the **Discord ↔ in-game-name mapping** that was
previously deferred — it now exists as a real tab.

- **`Discord UUID` (col C) is the stable join key.** Usernames drift (Discord allows
  a change every ~2 weeks), so never key on the name.
- **Roster membership is a hard gate on `/signup`.** The bot reads `Roster` and, if
  the invoking user's UUID isn't present, **blocks the signup** with a "get added to
  the roster first" message — a guard alongside the `@Dueler` role.
- On a matched signup the bot resolves the player's **Data Name** (used in the public
  confirmation) and can **opportunistically refresh** col B (Discord Name) when the
  stored username is stale — keeping the roster current for free (bot has write access).
- The bot never **invents** a Data Name. Roster rows are created via the **`/register`**
  command (self-serve or admin) or by an admin editing the sheet directly. See
  `02-sheets-integration.md` for mechanics and `03-decisions.md` for the decisions.
- **Caching:** the gate read is served from a Redis read-through cache
  (`tdl:roster`, 10-min TTL) that `/register` evicts; with Redis down it falls back
  to a live Sheets read. See `07-redis-caching.md`.

## Categories

Signups pick a **Category**, one of:

- **HLD** — High Level Dueling
- **LLD** — Low Level Dueling
- **Both** — signing up for both divisions

> **DECIDED:** "Both" is stored as **two rows** — one `HLD` row and one `LLD` row.
> The stored `Category` value is therefore only ever `HLD` or `LLD` (never `Both`).

## Environments (TEST_MODE)

Same dual-mode pattern as DFC-Data:

| Concern | Test | Prod |
|---|---|---|
| Discord server | Test guild | Toeshank's guild |
| Sheet tab | `Registration Test` | `Registration` |
| Bot token / client ID | Test app | Prod app |

## Implemented commands

- **`/signup`** — weekly-event signup wizard (window + `@Dueler` + roster gates,
  upsert to `Registration`, public confirmation with Data Name). See `01`.
- **`/register`** — appends/updates a player in the `Roster` tab (`Data Name |
  Discord Name | Discord UUID`); the write path that populates the `/signup` gate.
  Hybrid model (self-serve + admin override). See `03` rows 14–18.
- **`/recentsignups`** — ephemeral list of this week's signups, grouped by division
  (HLD/LLD) with a distinct-dueler count. Served from the Redis current-week signups
  cache (Phase B), with Data Names resolved via the roster cache. See `07`.

## Deferred / Future scope (not now)

- **Redis caching (Phase C)** — Phases A (roster cache) and B (current-week signups
  cache + `/recentsignups`) are **built**; next is caching standings/ELO with a
  cron refresh. See `07-redis-caching.md`.
- `/standings`, `/elo`, `/results`, `/builds` read commands (report-style, like DFC)
- Result reporting command (writes to `Results`)
- Signup-window open/close announcements via cron
- `/cancelsignup`

## Planning docs in this folder

- `00-project-overview.md` — this file
- `01-signup-command.md` — the focal feature: `/signup` flow, window, sheet writes
- `02-sheets-integration.md` — auth, read/write, dedupe, roster, env config
- `03-decisions.md` — resolved decisions (was open questions)
- `04-google-form-retirement.md` — why the Form is retired; bot-only rationale
- `05-heroku-hosting.md` — Heroku deploy model, config vars, dyno, ops
- `06-google-cloud-setup.md` — service account / Sheets API access setup
- `07-redis-caching.md` — Redis caching strategy (what/where/TTL/invalidation)
