# 08 — Setup & Deployment Runbook

> **Purpose:** the single ordered checklist to take TDL-Bot from empty to running,
> locally and on Heroku. This is the operator's "do these in order" index; deeper
> rationale lives in `05-heroku-hosting.md` (Heroku) and `06-google-cloud-setup.md`
> (Google). Work top to bottom, ticking boxes. Nothing here needs code changes.

## What you're wiring together

Three external systems plus the host:

1. **Discord** — the bot identity, its token, privileged intents, and which servers
   (guilds) it lives in.
2. **Google Sheets** — a service account that can read/write the TDL spreadsheet.
3. **Heroku** — where the bot process runs 24/7 (GitHub auto-deploy).
4. **Redis (optional)** — a Heroku add-on that speeds up reads; safe to skip at first.

You will collect a set of secret **values** along the way. Keep them in a scratch
note; they become `.env` locally and **Config Vars** on Heroku.

| Value | Where it comes from | Step |
|---|---|---|
| `BOT_TOKEN` | Discord Developer Portal → Bot | 1 |
| `CLIENT_ID` | Discord Developer Portal → General Information (Application ID) | 1 |
| `GUILD_ID` | Your **test** Discord server ID | 1 |
| `PROD_GUILD_ID` | Toeshank's (production) server ID | 1 |
| `GOOGLE_CLIENT_EMAIL` | Service-account email | 2 |
| `GOOGLE_PRIVATE_KEY` | Service-account JSON `private_key` | 2 |
| `TDL_SPREADSHEET_ID` | Already known (in `.env.example`) | 2 |
| `REDIS_URL` / `REDISCLOUD_URL` | Set automatically by the Heroku Redis add-on | 6 |

---

## 0. Prerequisites (one-time, on your machine)

- [ ] **Node.js 20.x** installed (`node -v` → `v20.x`). The app pins `20.x` in
      `package.json` engines; other majors may break the Google key parsing.
- [ ] **Git** installed and you can push to `github.com/Davenads/TDL-Bot`.
- [ ] A **Discord account** with **Manage Server** on your test server.
- [ ] The **sheet owner** (Toeshank) reachable — you'll need them to share the sheet
      (Step 2) unless they've already granted you edit-share rights.
- [ ] A **Heroku account** (for Step 5).

Clone and install:

```bash
git clone https://github.com/Davenads/TDL-Bot.git
cd TDL-Bot
npm install
```

---

## 1. Discord application, bot, and servers

### 1a. Create the application + bot
1. Go to <https://discord.com/developers/applications> → **New Application**, name it.
2. **General Information** → copy the **Application ID** → this is `CLIENT_ID`.
3. **Bot** tab → **Reset Token** → copy it → this is `BOT_TOKEN`. Treat it like a
   password; it won't be shown again.

### 1b. Enable privileged intents (CRITICAL — first-boot gotcha)
`index.js` requests the `GuildMembers` and `MessageContent` intents. Both are
**privileged**. If they're off, `client.login()` crashes with
`Used disallowed intents` and the bot never starts.

1. **Bot** tab → **Privileged Gateway Intents**:
   - [ ] **Server Members Intent** → ON
   - [ ] **Message Content Intent** → ON
2. Save.

### 1c. Invite the bot to both servers
1. **OAuth2 → URL Generator**:
   - Scopes: **`bot`** and **`applications.commands`**.
   - Bot permissions: **View Channels**, **Send Messages**, **Embed Links**,
     **Read Message History**, **Use Application Commands**.
2. Open the generated URL, invite the bot to your **test server**, then repeat for
   **Toeshank's production server** (an admin there must approve it).

### 1d. Grab the two guild IDs
1. In Discord: **User Settings → Advanced → Developer Mode** → ON.
2. Right-click your **test server** icon → **Copy Server ID** → `GUILD_ID`.
3. Right-click the **production server** icon → **Copy Server ID** → `PROD_GUILD_ID`.

> Slash commands are registered **per guild** (Step 4c / 7), so the bot only shows
> commands in the guilds whose IDs you set here. It must also be a *member* of each.

---

## 2. Google Sheets access (service account)

Full detail: **`06-google-cloud-setup.md`**. The short path (reuse DFC's account):

1. [ ] Get the service-account **email** (`...@<project>.iam.gserviceaccount.com`) and
       **private key** — from DFC-Data's `.env` or its JSON key (`client_email` /
       `private_key`). These become `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY`.
2. [ ] **Share the spreadsheet** with that email as **Editor**
       (sheet: `1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww`). Toeshank does this,
       or grants you share rights. Without this every read/write returns
       *"The caller does not have permission."*
3. [ ] `TDL_SPREADSHEET_ID` is already the correct default in `.env.example`.

New-from-scratch account instead? Follow **Path B** in `06`.

**Private-key formatting** (bites everyone once):
- **Local `.env`:** one line, literal `\n` escapes, wrapped in double quotes.
- **Heroku config var:** paste the real multi-line PEM (actual newlines).
`utils/googleAuth.js` normalizes both, but use the right form per environment.

---

## 3. Spreadsheet tabs & headers

The sheet must have these tabs with these exact header rows (row 1):

- [ ] **`Registration`** — `Timestamp | Discord UUID | Discord Username | Notes | Category`
- [ ] **`Registration Test`** — same headers (QA target when `TEST_MODE=true`)
- [ ] **`Roster`** — `Data Name | Discord Name | Discord UUID`

The `Roster` tab is the identity gate: a Discord user must exist there (by UUID)
before `/signup` will let them in. `/register` writes to it.

---

## 4. Run & QA locally (test server first)

### 4a. Create `.env`
```bash
cp .env.example .env      # Windows: copy .env.example .env
```
Fill in every value from Steps 1–2. Keep **`TEST_MODE=true`** for QA so writes land
in `Registration Test`, not the live tab.

### 4b. Verify Google access
Run the sanity snippet from `06-google-cloud-setup.md` ("Verify access"). It should
print the `Registration Test` header row. Fix any error it reports before continuing.

### 4c. Register the slash commands (test guild)
```bash
npm run deploy-cmds        # = node deploy-commands.js
```
This registers all commands (`/signup`, `/register`, `/recentsignups`) to `GUILD_ID`,
and to `PROD_GUILD_ID` too if it's set. Guild commands appear instantly.

> **Re-run this whenever command definitions change** — e.g. `/recentsignups` only
> appears after a fresh `deploy-commands` run.

### 4d. Run the tests, then start the bot
```bash
npm test                   # 54 checks across 5 suites — all should pass
npm start                  # logs "Logged in as <bot>#0000"
```
Then in your test server exercise: `/register` → `/signup` → `/recentsignups`.
Confirm rows appear in the `Registration Test` and `Roster` tabs.

---

## 5. Deploy to Heroku

Full detail: **`05-heroku-hosting.md`**. Deployment is **GitHub-driven** — never
`git push heroku main`.

1. [ ] Create the Heroku app.
2. [ ] **Deploy** tab → connect the `Davenads/TDL-Bot` GitHub repo → enable
       **Automatic deploys** from `main`.
3. [ ] **Settings → Config Vars** → add every key below.

| Config var | Value / note |
|---|---|
| `BOT_TOKEN` | from Step 1 |
| `CLIENT_ID` | from Step 1 |
| `GUILD_ID` | test guild ID |
| `PROD_GUILD_ID` | production guild ID |
| `TDL_SPREADSHEET_ID` | `1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww` |
| `GOOGLE_CLIENT_EMAIL` | service-account email |
| `GOOGLE_PRIVATE_KEY` | **real multi-line PEM** (not `\n`-escaped) |
| `TEST_MODE` | **`false`** on production (writes to `Registration`) |
| `DUELER_ROLE_NAME` | `Dueler` (or your role name) |
| `TDL_ADMIN_ROLE_NAME` | optional — role allowed to `/register` others |
| `SIGNUP_CHANNEL_ID` | optional — public-confirmation channel |
| `NODE_ENV` | `production` (also enables the health-check HTTP server) |

4. [ ] **Resources** tab → ensure exactly **one `web` dyno** is on
       (`web: npm start`). **Never scale above 1** — duplicate dynos = duplicate
       bots = double-posted signups.
5. [ ] Trigger the first deploy (push to `main`, or "Deploy Branch" once) and watch
       **`heroku logs --tail`** for `Logged in as ...`.

---

## 6. Redis add-on (optional — enables the cache)

The bot runs fine without this; add it when you want the roster/signups caches live.
Detail + TLS rationale: **`05-heroku-hosting.md` → Redis**.

1. [ ] Provision **one** add-on (either works; the URL var is set automatically):
   ```bash
   heroku addons:create heroku-redis:mini -a <app>   # sets REDIS_URL  (paid ~$3/mo, TLS)
   # or
   heroku addons:create rediscloud:30 -a <app>       # sets REDISCLOUD_URL (free 30MB)
   ```
   (Or add it from the dashboard **Resources** tab.)
2. [ ] After the automatic restart, check the logs for **`Redis ready`**. If Redis is
       ever unreachable you'll see warnings and the bot keeps working against live
       Sheets — nothing to fix urgently.

No code or config changes are needed: `rediss://` (TLS, self-signed cert) is handled
automatically.

---

## 7. Register commands on the production guild

If `PROD_GUILD_ID` was set when you ran `deploy-commands` in Step 4c, production is
already covered. Otherwise run it once with production env values set:

```bash
node deploy-commands.js     # registers to GUILD_ID and PROD_GUILD_ID
```

Re-run any time you add or change a command.

---

## 8. Go-live verification

- [ ] `heroku logs --tail` shows `Command loaded: signup/register/recentsignups`,
      then `Logged in as ...`, then `HTTP server running on port ...`.
- [ ] (If Redis added) `Redis ready` appears.
- [ ] In the production server: `/register` a test user, `/signup`, `/recentsignups`.
- [ ] A row appears in the live **`Registration`** tab (confirms `TEST_MODE=false`).
- [ ] Exactly **one** dyno is running (`heroku ps -a <app>`).

---

## 9. Ongoing operations & troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Bot won't start, `Used disallowed intents` | Privileged intents off → Step 1b. |
| `The caller does not have permission` on read/write | Sheet not shared with the service account → Step 2.2. |
| `error:1E08010C:DECODER routines::unsupported` / 400 on auth | `GOOGLE_PRIVATE_KEY` formatting → real newlines on Heroku, `\n` locally. |
| `Unable to parse range` | Tab name typo → check `Registration` / `Registration Test` / `Roster`. |
| Slash command missing in a server | `deploy-commands` not run for that guild, or bot not a member → Steps 1c / 7. |
| Signups posted twice | More than one dyno → scale back to `web=1`. |
| Writes hit the wrong tab | `TEST_MODE` wrong on that environment (`false` in prod). |
| Cache seems stale after a manual sheet edit | Expected — manual edits ride the TTL (roster 10 min, signups 2 h). |

**Deploys:** push to `main` → Heroku auto-builds. **Rollback:** Heroku **Activity**
tab → "Roll back". **Logs:** `heroku logs --tail -a <app>`. **Restart:**
`heroku restart -a <app>` (rarely needed).

**Guardrails:** deploy only via GitHub `main`; keep `web=1`; never commit `.env` or
the Google key; production `TEST_MODE=false`.
