const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');
const { getEventDateString } = require('../utils/tdlWeekUtils');
const { invalidateSignupsCache } = require('../utils/signupUtils');
const { buildSignupsEmbed } = require('../utils/signupEmbed');
const { getPanelBinding, setPanelBinding, clearPanelBinding } = require('../utils/panelStore');

// ---- Config ----
const SPREADSHEET_ID = process.env.TDL_SPREADSHEET_ID || '1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww';
// Only members with this role may post/rebind the panel (see index.js roleId gate).
const PANEL_ADMIN_ROLE_ID = '1538611745558626315';
// Live-roster refresh cadence (ms). Catches manual sheet edits + week rollover.
const PANEL_REFRESH_MS = 120000;

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
        rosterEmbed = await buildSignupsEmbed({ sheets, auth, spreadsheetId: SPREADSHEET_ID });
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
    // index.js enforces this via the generic roleId gate.
    roleId: PANEL_ADMIN_ROLE_ID,
    refreshSignupPanel,
    startPanelRefreshTimer,

    data: new SlashCommandBuilder()
        .setName('tdlpanel')
        .setDescription('Post or rebind the persistent TDL signup panel in this channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction, sheets, auth) {
        const timestamp = new Date().toISOString();

        if (!interaction.guild || !interaction.channel) {
            await interaction.reply({ content: 'Run `/tdlpanel` in a server channel.', ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        const existing = await getPanelBinding();
        const payload = await buildPanelPayload(sheets, auth);

        // Rebind in place if a panel already lives in THIS channel.
        if (existing && existing.channelId === interaction.channelId) {
            try {
                const ch = await interaction.client.channels.fetch(existing.channelId);
                const msg = await ch.messages.fetch(existing.messageId);
                await msg.edit(payload);
                await setPanelBinding({ channelId: ch.id, messageId: msg.id });
                startPanelRefreshTimer(interaction.client, sheets, auth);
                console.log(`[${timestamp}] tdlpanel refreshed existing panel in ${ch.id} by ${interaction.user.tag}`);
                await interaction.editReply('Signup panel refreshed in this channel.');
                return;
            } catch {
                // fall through to post a fresh one
            }
        }

        // Post a new panel and bind to it.
        const sent = await interaction.channel.send(payload);
        await setPanelBinding({ channelId: interaction.channelId, messageId: sent.id });
        startPanelRefreshTimer(interaction.client, sheets, auth);

        // Best-effort: remove a stale panel left in another channel.
        if (existing && existing.messageId && existing.messageId !== sent.id) {
            try {
                const oldCh = await interaction.client.channels.fetch(existing.channelId);
                const oldMsg = await oldCh.messages.fetch(existing.messageId);
                await oldMsg.delete();
            } catch { /* old panel already gone */ }
        }

        console.log(`[${timestamp}] tdlpanel posted in ${interaction.channelId} by ${interaction.user.tag}`);
        await interaction.editReply('Signup panel posted and bound to this channel.');
    }
};
