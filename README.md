# TDL-Bot

Discord bot for the **Toeshank Dueling League (TDL)** — a weekly Diablo 2: Resurrected
PvP dueling event hosted by Toeshank. The event runs Mondays at 6:00 PM ET (~4 hours).

The bot handles weekly event signups, writing directly to the league's Google Sheet
(their pseudo-database) and capturing each player's Discord UUID and live username —
data a Google Form cannot reliably capture.

## Tech stack

- Node.js 20.x + discord.js v14 (slash commands, buttons, modals)
- Google Sheets API (googleapis) — persistence
- Redis (optional) — read caching (roster map + current-week signups; see `plan/07`)
- Heroku (GitHub auto-deploy)

## Project structure

```
index.js              Bootstrap: command loader, Sheets auth, interaction router, HTTP server
deploy-commands.js    Registers slash commands to the TEST and PROD guilds
commands/
  signup.js           /signup wizard + Google Sheets upsert
  register.js         /register — add/update a player in the Roster tab
  recentsignups.js    /recentsignups — this week's signups by division (cached read)
utils/
  googleAuth.js       Service-account JWT auth
  redisClient.js      Optional Redis connection
  cache.js            Guarded cache helpers over Redis (graceful no-op fallback)
  tdlWeekUtils.js     Registration-window gate, week math, timestamp formatting
  rosterUtils.js      Roster read/lookup + cache, username refresh, register upsert
  signupUtils.js      Registration schema (REG_TAB/COL) + current-week signups cache
plan/                 Design docs (source of truth for decisions)
```

## `/signup`

1. Guards: guild-only, registration window open, and the `@Dueler` role.
2. Division selection: HLD, LLD, or Both.
3. Optional notes modal (category carried in the modal customId — no session store).
4. Writes `[Timestamp, Discord UUID, Discord Username, Notes, Category]` to the
   Registration tab, then posts a public confirmation.

Behavior:
- **Both** expands to two rows (one HLD, one LLD).
- Upsert keyed on **(UUID + Category)** within the current week — re-running replaces
  that division's row rather than duplicating it.
- **Roster gate:** checks the `Roster` tab (`Data Name | Discord Name | Discord UUID`)
  by UUID up front — users not on the roster are blocked. On a match it resolves the
  Data Name (shown in the confirmation) and refreshes the stored Discord username if
  it drifted. Use `/register` to get on the roster. The gate read is served from a
  Redis cache (`tdl:roster`, 10-min TTL) that `/register` evicts, so a just-registered
  player can sign up immediately; with Redis down it falls back to a live Sheets read.
- Registration window: opens Tuesday 12:00 AM ET, closes Sunday 11:59 PM ET (all day
  Monday is closed so matchups can be built before the event).

## `/register`

Adds (or updates) a player in the `Roster` tab — the identity that `/signup` gates on.

```
/register data_name:<name> [user:@member]
```

- **Self-serve:** anyone runs `/register data_name:<name>` to add themselves. No
  `@Dueler` role required — this is the onboarding entry point (register → get
  `@Dueler` → `/signup`).
- **Admins** (holders of `TDL_ADMIN_ROLE_NAME`, or members with the Manage Server
  permission) may register/fix another member via the optional `user:` option.
- **Re-register** with the same account updates your row (Data Name + username) — fix
  your own typos.
- **Name clash blocked:** a Data Name already held by a different player is refused.
- Writes `[Data Name, Discord Name, Discord UUID]`; confirmation is ephemeral.

## `/recentsignups`

Ephemeral list of who has signed up for this week's event.

- Groups signups by division (**HLD** / **LLD**) with per-division counts and a
  distinct-dueler total.
- Names shown are roster **Data Names** (falls back to the stored Discord username if
  the roster lookup hiccups).
- Reads are served from a Redis cache (`tdl:signups:current`, `:test` in `TEST_MODE`,
  2-hour TTL) that `/signup` evicts on each new signup; with Redis down it falls back
  to a live Sheets read. Long division lists are truncated with a `+N more` tail to
  stay under Discord's field limit.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in (see table below).
3. Grant the Google service account **Editor** access to the TDL spreadsheet.
4. Ensure the Registration tab header is:
   `Timestamp | Discord UUID | Discord Username | Notes | Category`
   (use `Registration Test` for QA with `TEST_MODE=true`).
   Also ensure a `Roster` tab exists with columns
   `Data Name | Discord Name | Discord UUID` (one shared tab across test/prod).
5. Register commands: `node deploy-commands.js`
6. Start: `npm start`

## Environment variables

| Variable | Purpose |
|---|---|
| `BOT_TOKEN` | Discord bot token |
| `CLIENT_ID` | Discord application (client) ID |
| `GUILD_ID` | Test server guild ID |
| `PROD_GUILD_ID` | Production server guild ID |
| `TDL_SPREADSHEET_ID` | TDL Google Sheet ID |
| `GOOGLE_CLIENT_EMAIL` | Service-account email |
| `GOOGLE_PRIVATE_KEY` | Service-account key (real newlines on Heroku; `\n`-escaped locally) |
| `TEST_MODE` | `true` -> Registration Test tab; `false` -> Registration tab |
| `DUELER_ROLE_NAME` | Role name required for `/signup` (default `Dueler`) |
| `TDL_ADMIN_ROLE_NAME` | Optional role name allowed to register others via `/register`; Manage-Server members can too |
| `SIGNUP_CHANNEL_ID` | Optional channel for public confirmations; defaults to invoking channel |
| `REDISCLOUD_URL` | Optional Redis URL (caches roster map + current-week signups) |

## Deployment

GitHub auto-deploy to Heroku:

1. Push to `main` on GitHub.
2. Heroku (connected to the repo) auto-deploys.

Do not `git push heroku main`; deployment is driven by GitHub.

## Design docs

See `plan/` for the full design and decision records:

- `00-project-overview.md`
- `01-signup-command.md`
- `02-sheets-integration.md`
- `03-decisions.md`
- `04-google-form-retirement.md`
- `05-heroku-hosting.md`
- `06-google-cloud-setup.md`
- `07-redis-caching.md`
