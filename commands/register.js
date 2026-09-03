const {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits
} = require('discord.js');
const { registerRosterEntry } = require('../utils/rosterUtils');

// ---- Config ----
const SPREADSHEET_ID = process.env.TDL_SPREADSHEET_ID || '1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww';
// Optional role that (in addition to Manage Server) may register OTHER members.
const ADMIN_ROLE = process.env.TDL_ADMIN_ROLE_NAME || null;
const MAX_NAME = 40;

const OK_COLOR = 0x38a169;
const WARN_COLOR = 0xe53e3e;

function warnEmbed(title, description) {
    return new EmbedBuilder()
        .setColor(WARN_COLOR)
        .setTitle(title)
        .setDescription(description)
        .setFooter({ text: 'Toeshank Dueling League' })
        .setTimestamp();
}

/**
 * May the invoking member register OTHER users?
 * True if they hold the configured admin role OR have Manage Server permission.
 */
function canRegisterOthers(interaction) {
    const member = interaction.member;
    if (!member) return false;
    if (ADMIN_ROLE && member.roles?.cache?.some(r => r.name === ADMIN_ROLE)) return true;
    return member.permissions?.has(PermissionFlagsBits.ManageGuild) === true;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('register')
        .setDescription('Add yourself to the TDL roster (admins can register others)')
        .addStringOption(o =>
            o.setName('data_name')
                .setDescription('Your in-game / rankings name (how you appear in the data)')
                .setRequired(true)
                .setMaxLength(MAX_NAME)
        )
        .addUserOption(o =>
            o.setName('user')
                .setDescription('(Admins only) the member to register')
                .setRequired(false)
        ),

    async execute(interaction, sheets, auth) {
        const timestamp = new Date().toISOString();

        // Guild-only (role/permission checks and member resolution need guild context).
        if (!interaction.guild || !interaction.member) {
            await interaction.reply({
                content: 'Please run `/register` in the TDL server, not in DMs.',
                ephemeral: true
            });
            return;
        }

        const dataName = (interaction.options.getString('data_name') || '').trim();
        if (!dataName) {
            await interaction.reply({
                embeds: [warnEmbed('Invalid Name', 'Please provide a non-empty Data Name.')],
                ephemeral: true
            });
            return;
        }

        // Resolve target: default is the invoker; a different `user` requires admin.
        const requested = interaction.options.getUser('user');
        let target = interaction.user;
        if (requested && requested.id !== interaction.user.id) {
            if (!canRegisterOthers(interaction)) {
                await interaction.reply({
                    embeds: [warnEmbed(
                        'Admins Only',
                        'Only league admins can register another member. ' +
                        'Run `/register` with just a `data_name` to register yourself.'
                    )],
                    ephemeral: true
                });
                return;
            }
            target = requested;
        }

        if (target.bot) {
            await interaction.reply({
                embeds: [warnEmbed('Invalid Target', 'Bots cannot be added to the roster.')],
                ephemeral: true
            });
            return;
        }

        const uuid = target.id;
        const discordName = target.username || target.globalName || target.tag || 'Unknown';

        await interaction.deferReply({ ephemeral: true });

        try {
            const result = await registerRosterEntry({
                sheets, auth, spreadsheetId: SPREADSHEET_ID, uuid, dataName, discordName
            });

            if (!result.ok && result.reason === 'NAME_TAKEN') {
                console.log(`[${timestamp}] Register blocked (name taken) — "${dataName}" requested for ${discordName} (${uuid}) by ${interaction.user.tag}`);
                await interaction.editReply({
                    embeds: [warnEmbed(
                        'Name Taken',
                        `The Data Name **${dataName}** is already registered to another player. ` +
                        'Pick a different name, or ask an admin if this is a mistake.'
                    )]
                });
                return;
            }

            const forOther = target.id !== interaction.user.id;
            const verb = result.action === 'updated' ? 'updated on' : 'added to';
            console.log(`[${timestamp}] Roster ${result.action} — ${discordName} (${uuid}) as "${dataName}" by ${interaction.user.tag}`);

            const embed = new EmbedBuilder()
                .setColor(OK_COLOR)
                .setTitle('Roster Updated')
                .setDescription(
                    `${forOther ? `<@${uuid}> was` : 'You were'} ${verb} the TDL roster as **${dataName}**.` +
                    (forOther ? '' : '\n\nYou can now use `/signup` during the registration window.')
                )
                .setFooter({ text: 'Toeshank Dueling League' })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error(`[${timestamp}] Error registering ${uuid}:`, error);
            await interaction.editReply({
                content: '⚠️ Registration failed — could not write to the roster. Please try again in a moment.'
            });
        }
    }
};
