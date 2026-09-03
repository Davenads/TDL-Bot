# TDL-Bot

Discord bot for the **Toeshank Dueling League (TDL)** — a weekly Diablo 2: Resurrected
PvP dueling event hosted by Toeshank. The event runs Mondays at 6:00 PM ET (~4 hours).

The bot handles weekly event signups, writing directly to the league's Google Sheet
(their pseudo-database) and capturing each player's Discord UUID and live username —
data a Google Form cannot reliably capture.

## Tech stack

- Node.js 20.x + discord.js v14 (slash commands, buttons, modals)
- Google Sheets API (googleapis) — persistence
- Redis (optional) — phase-2 read caching
- Heroku (GitHub auto-deploy)

## Project structure

```
index.js              Bootstrap: command loader, Sheets auth, interaction router, HTTP server
deploy-commands.js    Registers slash commands to the TEST and PROD guilds
commands/
  signup.js           /signup wizard + Google Sheets upsert
utils/
  googleAuth.js       Service-account JWT auth
  redisClient.js      Optional Redis connection
  tdlWeekUtils.js     Registration-window gate, week math, timestamp formatting
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
  it drifted. A future `/register` command will add users to the roster.
- Registration window: opens Tuesday 12:00 AM ET, closes Sunday 11:59 PM ET (all day
  Monday is closed so matchups can be built before the event).

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
| `SIGNUP_CHANNEL_ID` | Optional channel for public confirmations; defaults to invoking channel |
| `REDISCLOUD_URL` | Optional Redis URL (phase-2 caching) |

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
