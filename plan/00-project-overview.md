# TDL-Bot — Project Overview (Planning)

> **Status:** Planning only. No implementation code yet. This folder contains design docs.

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
| `Standings` | League standings |
| `Ruleset` | Rules |
| `Builds` | Build list |
| `Result ID` | Result keys |
| `WL` | Win/Loss records |
| `ELO Ratings` / `ELO Wins` / `ELO Loss` / `ELO Join` / `ELO Summary` | ELO system |

### Registration tab columns

**Current (form-driven):** `Status | Timestamp | Email Address | Name | Notes | Category`

**New (bot-driven, DECIDED):** `Timestamp | Discord UUID | Discord Username | Notes | Category`

> **DECIDED:** We are **reshaping** the tab to the new columns and going
> **bot-only** — the Google Form is **retired**, not rebuilt. Rationale: a Google
> Form cannot reliably capture a Discord UUID (its only injection path, pre-filled
> links, produces a user-editable field and still requires the bot in the loop). The
> bot writes rows directly via the Sheets API. See `04-google-form-retirement.md`.

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

## Deferred / Future scope (not now)

- `/standings`, `/elo`, `/results`, `/builds` read commands (report-style, like DFC)
- Result reporting command (writes to `Results`)
- Discord ↔ in-game-name mapping (needed to link signups to Results/ELO)
- Signup-window open/close announcements via cron
- `/cancelsignup`

## Planning docs in this folder

- `00-project-overview.md` — this file
- `01-signup-command.md` — the focal feature: `/signup` flow, window, sheet writes
- `02-sheets-integration.md` — auth, read/write, dedupe, env config
- `03-decisions.md` — resolved decisions (was open questions)
- `04-google-form-retirement.md` — why the Form is retired; bot-only rationale
