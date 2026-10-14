const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ChannelType,
    PermissionFlagsBits
} = require('discord.js');
const { getEventDateString } = require('../utils/tdlWeekUtils');
const { invalidateSignupsCache } = require('../utils/signupUtils');
const { buildSignupsEmbed } = require('../utils/signupEmbed');
const { getPanelBinding, setPanelBinding, clearPanelBinding } = require('../utils/panelStore');

// ---- Config ----
const SPREADSHEET_ID = process.env.TDL_SPREADSHEET_ID || '1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww';
// Who may post/rebind the panel: either the panel-admin role ID OR any role named
// "Moderator" (matched by name). Enforced in `execute` rather than via the index.js
// generic gate, which is single-role / AND-only and can't express this OR.
const PANEL_ADMIN_ROLE_ID = '1538611745558626315';
const PANEL_ADMIN_ROLE_NAME = 'Moderator';
// Live-roster refresh cadence (ms). Catches manual sheet edits + week rollover.
const PANEL_REFRESH_MS = 120000;

/**
 * May this member manage the panel? True if they hold the panel-admin role ID
 * OR any role literally named "Moderator". Safe on a missing member/roles cache.
 */
function memberCanManagePanel(member) {
    const roles = member && member.roles && member.roles.cache;
    if (!roles) return false;
    return roles.has(PANEL_ADMIN_ROLE_ID) || roles.some(r => r.name === PANEL_ADMIN_ROLE_NAME);
}

const BRAND_COLOR = 0x2b6cb0;
const WARN_COLOR = 0xe53e3e;

let refreshTimer = null;

function panelInfoEmbed() {
    return new EmbedBuilder()
        .setColor(BRAND_COLOR)
        .setTitle('Toeshank Dueling League — Sign Up')
        .setDescription(
            `Event: **${getEventDateString()} — 6:00 PM ET**\n\n` +
            'Press **Sign Up** below to register for this week. You can choose ' +
            '**HLD**, **LLD**, or **Both**, and add optional notes.\n\n' +
            '_You need the **@Dueler** role and a roster entry to sign up._'
        )
        .setFooter({ text: 'Toeshank Dueling League' })
        .setTimestamp();
}

function rosterUnavailableEmbed() {
    return new EmbedBuilder()
        .setColor(WARN_COLOR)
        .setTitle('TDL Signups')
        .setDescription("Could not load this week's signups right now — it will refresh shortly.")
        .setFooter({ text: 'Toeshank Dueling League' })
        .setTimestamp();
}

function panelButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tdlsignup_panel').setLabel('Sign Up').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('tdlwithdraw_panel').setLabel('Withdraw').setStyle(ButtonStyle.Danger)
    );
}

/**
 * Build the full panel message payload: [info embed, live roster embed] + button.
 * The roster read is non-fatal — on failure we render an "unavailable" roster
 * embed so the panel (and its button) still works.
 */
async function buildPanelPayload(sheets, auth) {
    let rosterEmbed;
    try {
        rosterEmbed = await buildSignupsEmbed({ sheets, auth, spreadsheetId: SPREADSHEET_ID, countsOnly: true });
    } catch (err) {
        console.error(`[${new Date().toISOString()}] panel roster build failed:`, err.message);
        rosterEmbed = rosterUnavailableEmbed();
    }
    return { embeds: [panelInfoEmbed(), rosterEmbed], components: [panelButtons()] };
}

/**
 * Refresh the bound panel message in place. Forced-fresh: evicts the signups
 * cache first so manual sheet edits surface. No-op (returns false) if there is
 * no binding or the message/channel is gone.
 *
 * @returns {Promise<boolean>} true if a panel edit was issued.
 */
async function refreshSignupPanel(client, sheets, auth) {
    const binding = await getPanelBinding();
    if (!binding || !binding.channelId || !binding.messageId) return false;

    let channel;
    try {
        channel = await client.channels.fetch(binding.channelId);
    } catch (err) {
        console.warn(`[panel] channel ${binding.channelId} unavailable:`, err.message);
        return false;
    }
    if (!channel || typeof channel.messages?.fetch !== 'function') return false;

    let message;
    try {
        message = await channel.messages.fetch(binding.messageId);
    } catch (err) {
        // Message was deleted — drop the stale binding so boot stops chasing it.
        console.warn(`[panel] message ${binding.messageId} gone — clearing binding.`);
        await clearPanelBinding();
        return false;
    }

    // Forced-fresh view: evict then rebuild (repopulates cache for /recentsignups).
    await invalidateSignupsCache();
    const payload = await buildPanelPayload(sheets, auth);
    await message.edit(payload);
    return true;
}

/**
 * Start the periodic live-roster refresh. Idempotent (a second call is a no-op).
 */
function startPanelRefreshTimer(client, sheets, auth) {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
        refreshSignupPanel(client, sheets, auth).catch(err =>
            console.error(`[panel] periodic refresh failed (non-fatal):`, err.message)
        );
    }, PANEL_REFRESH_MS);
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
    console.log(`[panel] live-roster refresh every ${PANEL_REFRESH_MS}ms`);
}

module.exports = {
    // Exposed for unit testing the OR permission gate.
    memberCanManagePanel,
    refreshSignupPanel,
    startPanelRefreshTimer,

    data: new SlashCommandBuilder()
        .setName('tdlpanel')
        .setDescription('Post or rebind the persistent TDL signup panel')
        .addChannelOption(o =>
            o.setName('channel')
                .setDescription('Channel to post the panel in (defaults to this channel)')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(false)
        ),

    async execute(interaction, sheets, auth) {
        const timestamp = new Date().toISOString();

        if (!interaction.guild || !interaction.channel) {
            await interaction.reply({ content: 'Run `/tdlpanel` in a server channel.', ephemeral: true });
            return;
        }

        // OR gate: panel-admin role ID OR a role named "Moderator".
        if (!memberCanManagePanel(interaction.member)) {
            await interaction.reply({
                content: 'You need the **Moderator** role (or the panel-admin role) to use `/tdlpanel`.',
                ephemeral: true
            });
            return;
        }

        // Destination defaults to the invoking channel. An explicit `channel`
        // option lets admins target a channel they can't invoke commands in —
        // "Use Application Commands" gates the invoker here, while the post is
        // governed by the BOT's Send Messages perm in the target.
        const target = interaction.options.getChannel('channel') || interaction.channel;

        // Preflight the bot's own perms in the target so we fail with a clear
        // message instead of an opaque 403 at send time.
        const me = interaction.guild.members.me;
        const perms = me ? target.permissionsFor(me) : null;
        if (!perms || !perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
            await interaction.reply({
                content: `I need **View Channel** and **Send Messages** in <#${target.id}> to post the panel there.`,
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const here = target.id === interaction.channelId;
        const existing = await getPanelBinding();
        const payload = await buildPanelPayload(sheets, auth);

        // Rebind in place if a panel already lives in the TARGET channel.
        if (existing && existing.channelId === target.id) {
            try {
                const ch = await interaction.client.channels.fetch(existing.channelId);
                const msg = await ch.messages.fetch(existing.messageId);
                await msg.edit(payload);
                await setPanelBinding({ channelId: ch.id, messageId: msg.id });
                startPanelRefreshTimer(interaction.client, sheets, auth);
                console.log(`[${timestamp}] tdlpanel refreshed existing panel in ${ch.id} by ${interaction.user.tag}`);
                await interaction.editReply(`Signup panel refreshed in <#${ch.id}>.`);
                return;
            } catch {
                // fall through to post a fresh one
            }
        }

        // Post a new panel in the target channel and bind to it.
        const sent = await target.send(payload);
        await setPanelBinding({ channelId: target.id, messageId: sent.id });
        startPanelRefreshTimer(interaction.client, sheets, auth);

        // Best-effort: remove a stale panel left in another channel.
        if (existing && existing.messageId && existing.messageId !== sent.id) {
            try {
                const oldCh = await interaction.client.channels.fetch(existing.channelId);
                const oldMsg = await oldCh.messages.fetch(existing.messageId);
                await oldMsg.delete();
            } catch { /* old panel already gone */ }
        }

        console.log(`[${timestamp}] tdlpanel posted in ${target.id} by ${interaction.user.tag}`);
        await interaction.editReply(
            here ? 'Signup panel posted and bound to this channel.'
                 : `Signup panel posted in <#${target.id}>.`
        );
    }
};
