/**
 * Periodic signup-reminder post for the TDL-chat channel.
 *
 * Posts the signup panel (counts embed + Sign Up / Withdraw buttons) into
 * TDL-chat on a fixed 8-hour cadence, nudging duelers to register. Suppressed
 * during the closed window (Monday 7 PM ET through the Tuesday event) via the
 * shared `isRegistrationOpen` gate.
 *
 * Clutter handling = "replace previous" (Option B): the prior reminder is
 * deleted before the next is posted, so exactly one reminder is live but it
 * still re-surfaces at the bottom of chat each fire. Tracking is in-memory — a
 * dyno restart just orphans one old post (harmless), then replacement resumes.
 *
 * Reuses existing building blocks: `buildSignupsEmbed({ countsOnly: true })`
 * (the exact counts embed used by the panel) and the panel's button customIds
 * (`tdlsignup_panel` / `tdlwithdraw_panel`), which already route via index.js.
 */

const cron = require('node-cron');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { buildSignupsEmbed } = require('./signupEmbed');
const { isRegistrationOpen, nowET, TIME_ZONE } = require('./tdlWeekUtils');
const { invalidateSignupsCache } = require('./signupUtils');

// ---- Config ----
// Hardcoded default (TDL-chat); env override stays available but no var is
// required to deploy. See CLAUDE.md "Configuration Values".
const REMINDER_CHANNEL_ID = process.env.REMINDER_CHANNEL_ID || '1537111833260064788';
const SPREADSHEET_ID = process.env.TDL_SPREADSHEET_ID || '1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww';
// Every 8 hours at fixed ET clock times: 12:00 AM, 8:00 AM, 4:00 PM.
const CRON_EXPR = '0 0,8,16 * * *';
// Only the 4:00 PM post pings the reminder role (daytime nudge); the 12 AM / 8 AM
// posts stay silent. Ping goes in message content (not the embed) so it notifies.
const PING_HOUR = 16;
const PING_ROLE_ID = process.env.REMINDER_PING_ROLE_ID || '1551825607036248064';

// Option B state: id of the last reminder we posted (in-memory).
let lastMessageId = null;
// Idempotency guard for the scheduled task.
let task = null;

/** The Sign Up + Withdraw row (same customIds as the persistent panel). */
function reminderButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tdlsignup_panel').setLabel('Sign Up').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('tdlwithdraw_panel').setLabel('Withdraw').setStyle(ButtonStyle.Danger)
    );
}

/**
 * Build the reminder message payload: the counts embed + button row. When
 * `ping` is true, adds the role mention as message CONTENT (outside the embed,
 * where pings actually fire) plus an allowedMentions whitelist for that role.
 * @throws if the signups Sheets read fails (caller decides how to handle).
 */
async function buildReminderPayload(sheets, auth, { ping = false } = {}) {
    const embed = await buildSignupsEmbed({ sheets, auth, spreadsheetId: SPREADSHEET_ID, countsOnly: true });
    const payload = { embeds: [embed], components: [reminderButtons()] };
    if (ping) {
        payload.content = `<@&${PING_ROLE_ID}>`;
        payload.allowedMentions = { roles: [PING_ROLE_ID] };
    }
    return payload;
}

/**
 * Gated reminder post. No-ops (returns false) when the registration window is
 * closed or the channel/perms are unavailable. On success deletes the previous
 * reminder (Option B) and posts a fresh one.
 *
 * @param {object} [opts]
 * @param {Date}   [opts.now] - injected clock for the window gate (tests).
 * @returns {Promise<boolean>} true if a new reminder was posted.
 */
async function postReminderNow(client, sheets, auth, { now, ping } = {}) {
    const ts = new Date().toISOString();
    const clock = now || nowET();

    if (!isRegistrationOpen(clock)) {
        console.log(`[${ts}] [reminder] skipped — registration window closed`);
        return false;
    }

    let channel;
    try {
        channel = await client.channels.fetch(REMINDER_CHANNEL_ID);
    } catch (err) {
        console.warn(`[reminder] channel ${REMINDER_CHANNEL_ID} unavailable:`, err.message);
        return false;
    }
    if (!channel || typeof channel.send !== 'function') {
        console.warn(`[reminder] channel ${REMINDER_CHANNEL_ID} not sendable`);
        return false;
    }

    // Preflight the bot's own View/Send perms so we skip cleanly instead of
    // throwing a 403 at send time (mirrors /tdlpanel).
    const me = channel.guild && channel.guild.members && channel.guild.members.me;
    const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    if (!perms || !perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
        console.warn(`[reminder] missing View/Send in channel ${REMINDER_CHANNEL_ID} — skipping`);
        return false;
    }

    // Forced-fresh counts: evict so the reminder reflects the latest signups.
    try { await invalidateSignupsCache(); } catch { /* non-fatal */ }

    // Only the 4 PM post pings the reminder role (unless overridden for tests).
    const shouldPing = ping !== undefined ? ping : clock.getHours() === PING_HOUR;

    let payload;
    try {
        payload = await buildReminderPayload(sheets, auth, { ping: shouldPing });
    } catch (err) {
        console.error(`[${ts}] [reminder] payload build failed:`, err.message);
        return false;
    }

    // Option B: delete the prior reminder before posting the new one.
    if (lastMessageId) {
        try {
            const prev = await channel.messages.fetch(lastMessageId);
            await prev.delete();
        } catch { /* already gone/deleted */ }
        lastMessageId = null;
    }

    const sent = await channel.send(payload);
    lastMessageId = sent.id;
    console.log(`[${ts}] [reminder] posted to ${REMINDER_CHANNEL_ID} (msg ${sent.id})`);
    return true;
}

/**
 * Register the recurring reminder cron job. Idempotent — a second call returns
 * the existing task without scheduling another.
 */
function startReminderSchedule(client, sheets, auth) {
    if (task) return task;
    task = cron.schedule(
        CRON_EXPR,
        () => {
            postReminderNow(client, sheets, auth).catch(err =>
                console.error('[reminder] scheduled post failed (non-fatal):', err.message)
            );
        },
        { timezone: TIME_ZONE }
    );
    console.log(`[reminder] scheduled '${CRON_EXPR}' (${TIME_ZONE}) -> channel ${REMINDER_CHANNEL_ID}`);
    return task;
}

module.exports = {
    startReminderSchedule,
    postReminderNow,
    buildReminderPayload,
    reminderButtons,
    REMINDER_CHANNEL_ID,
    CRON_EXPR,
    PING_ROLE_ID,
    PING_HOUR,
    // Test-only: clear the in-memory "last message" tracker between cases.
    _resetForTest() { lastMessageId = null; }
};
