/**
 * Periodic signup-reminder post for the TDL-chat channel.
 *
 * Posts the signup panel (counts embed + Sign Up / Withdraw buttons) into
 * TDL-chat on a fixed 8-hour cadence, nudging duelers to register. Suppressed
 * during the closed window (Monday 7 PM ET through the Tuesday event) via the
 * shared `isRegistrationOpen` gate.
 *
 * Clutter handling = "sweep previous": before posting a fresh reminder we scan
 * the channel's recent history and delete EVERY prior reminder this bot posted
 * (identified by author + the "TDL Signups" lead-embed signature), so exactly
 * one reminder is live. This is restart-safe (no in-memory tracking to lose on a
 * dyno cycle) and never touches the persistent /tdlpanel message — the bound
 * panel id is explicitly excluded, and the panel's lead embed is a different
 * title anyway. Scan window is the latest 100 messages (one fetch, no
 * pagination); reminders buried deeper than that in an active chat are left.
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
const { getPanelBinding } = require('./panelStore');

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
const PING_ROLE_ID = process.env.REMINDER_PING_ROLE_ID || '1537139321797345320';
// Lead-embed title that marks one of OUR reminder posts. The /tdlpanel message
// leads with a different title ("Toeshank Dueling League — Sign Up"), so this
// distinguishes a reminder from the panel even in the same channel.
const REMINDER_EMBED_TITLE = 'TDL Signups';
// How many recent messages to scan when sweeping old reminders (Discord caps a
// single fetch at 100; no pagination — see module doc).
const SWEEP_LIMIT = 100;

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
 * Delete every prior reminder this bot posted in the channel's recent history.
 * A reminder is one authored by the bot whose lead embed is titled
 * `REMINDER_EMBED_TITLE`. The currently-bound /tdlpanel message (if it lives in
 * this channel) is explicitly skipped so we never nuke the panel. Best-effort:
 * per-message delete failures are swallowed.
 *
 * @returns {Promise<number>} how many old reminders were deleted.
 */
async function sweepPreviousReminders(channel, client) {
    const botId = client && client.user && client.user.id;
    if (!botId || typeof channel.messages?.fetch !== 'function') return 0;

    // Never delete the live persistent panel, even if it shares this channel.
    let panelMessageId = null;
    try {
        const binding = await getPanelBinding();
        if (binding && binding.channelId === channel.id) panelMessageId = binding.messageId;
    } catch { /* no binding / store unavailable — nothing to protect */ }

    let fetched;
    try {
        fetched = await channel.messages.fetch({ limit: SWEEP_LIMIT });
    } catch (err) {
        console.warn(`[reminder] history fetch failed during sweep:`, err.message);
        return 0;
    }

    const list = Array.from(typeof fetched.values === 'function' ? fetched.values() : fetched);
    let deleted = 0;
    for (const msg of list) {
        if (!msg || msg.id === panelMessageId) continue;
        const authorId = msg.author && msg.author.id;
        const leadTitle = msg.embeds && msg.embeds[0] && msg.embeds[0].title;
        if (authorId !== botId || leadTitle !== REMINDER_EMBED_TITLE) continue;
        try { await msg.delete(); deleted++; } catch { /* already gone */ }
    }
    return deleted;
}

/**
 * Gated reminder post. No-ops (returns false) when the registration window is
 * closed or the channel/perms are unavailable. On success sweeps any prior
 * reminders this bot left in the channel, then posts a fresh one.
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

    // Sweep any prior reminders this bot left in the channel before posting.
    const removed = await sweepPreviousReminders(channel, client);
    if (removed) console.log(`[${ts}] [reminder] swept ${removed} prior reminder(s)`);

    const sent = await channel.send(payload);
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
    sweepPreviousReminders,
    buildReminderPayload,
    reminderButtons,
    REMINDER_CHANNEL_ID,
    REMINDER_EMBED_TITLE,
    CRON_EXPR,
    PING_ROLE_ID,
    PING_HOUR,
    // Test-only: no in-memory state remains (sweep is history-driven); kept as a
    // no-op so existing cases that call it still work.
    _resetForTest() { /* no-op */ }
};
