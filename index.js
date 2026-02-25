require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits
} = require('discord.js');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TRACKED_CATEGORIES = new Set(['erc721', 'erc1155']);
const VALID_EVENT_TYPES = new Set(['mint', 'sweep', 'buy', 'sell']);
const DEFAULT_EVENT_FILTERS = ['mint', 'sweep', 'buy', 'sell'];
const MAX_SWEEP_TOKEN_PREVIEW = 10;
const ETHERSCAN_ADDRESS_URL = 'https://etherscan.io/address';

const dataDir = path.join(__dirname, 'data');
const walletLabelsPath = path.join(dataDir, 'wallet-labels.json');

const app = express();
app.use(express.json());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const enabledEventFilters = parseEventFilters(process.env.TX_EVENT_FILTERS);

ensureLabelStorage();

const walletLabelCommand = new SlashCommandBuilder()
    .setName('wallet-label')
    .setDescription('Kelola label owner wallet untuk notifikasi NFT')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
        subcommand
            .setName('add')
            .setDescription('Tambah atau update label wallet')
            .addStringOption((option) =>
                option
                    .setName('address')
                    .setDescription('Alamat wallet 0x...')
                    .setRequired(true)
            )
            .addStringOption((option) =>
                option
                    .setName('owner')
                    .setDescription('Nama owner wallet')
                    .setRequired(true)
            )
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName('remove')
            .setDescription('Hapus label wallet')
            .addStringOption((option) =>
                option
                    .setName('address')
                    .setDescription('Alamat wallet 0x...')
                    .setRequired(true)
            )
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName('list')
            .setDescription('Lihat semua label wallet di server ini')
    );

const slashCommands = [walletLabelCommand];

client.once('clientReady', () => {
    console.log(`🤖 Bot Discord online sebagai ${client.user.tag}`);
    registerGuildCommands().catch((error) => {
        console.error('Gagal mendaftarkan slash command:', error);
    });
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) {
        return;
    }

    if (interaction.commandName !== 'wallet-label') {
        return;
    }

    try {
        if (!interaction.inGuild()) {
            await interaction.reply({
                content: 'Command ini hanya bisa digunakan di server (guild).',
                ephemeral: true
            });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({
                content: 'Kamu tidak punya izin untuk mengelola label wallet.',
                ephemeral: true
            });
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        const allLabels = loadWalletLabels();
        const guildId = interaction.guildId;

        if (!allLabels[guildId] || typeof allLabels[guildId] !== 'object') {
            allLabels[guildId] = {};
        }
        const guildLabels = allLabels[guildId];

        if (subcommand === 'add') {
            const addressInput = interaction.options.getString('address', true);
            const ownerInput = interaction.options.getString('owner', true).trim();
            const normalizedAddress = normalizeAddress(addressInput);

            if (!isValidAddress(normalizedAddress)) {
                await interaction.reply({
                    content: 'Alamat wallet tidak valid. Gunakan format 0x + 40 karakter hex.',
                    ephemeral: true
                });
                return;
            }

            if (!ownerInput) {
                await interaction.reply({
                    content: 'Nama owner tidak boleh kosong.',
                    ephemeral: true
                });
                return;
            }

            guildLabels[normalizedAddress] = ownerInput;
            saveWalletLabels(allLabels);

            await interaction.reply({
                content: `Label disimpan: \`${shortAddress(normalizedAddress)}\` -> **${escapeMarkdown(ownerInput)}**`,
                ephemeral: true
            });
            return;
        }

        if (subcommand === 'remove') {
            const addressInput = interaction.options.getString('address', true);
            const normalizedAddress = normalizeAddress(addressInput);

            if (!isValidAddress(normalizedAddress)) {
                await interaction.reply({
                    content: 'Alamat wallet tidak valid. Gunakan format 0x + 40 karakter hex.',
                    ephemeral: true
                });
                return;
            }

            if (!guildLabels[normalizedAddress]) {
                await interaction.reply({
                    content: `Label untuk \`${shortAddress(normalizedAddress)}\` tidak ditemukan.`,
                    ephemeral: true
                });
                return;
            }

            delete guildLabels[normalizedAddress];
            saveWalletLabels(allLabels);

            await interaction.reply({
                content: `Label untuk \`${shortAddress(normalizedAddress)}\` berhasil dihapus.`,
                ephemeral: true
            });
            return;
        }

        if (subcommand === 'list') {
            const entries = Object.entries(guildLabels);
            if (entries.length === 0) {
                await interaction.reply({
                    content: 'Belum ada label wallet untuk guild ini.',
                    ephemeral: true
                });
                return;
            }

            const maxRows = 20;
            const lines = entries
                .slice(0, maxRows)
                .map(([address, owner]) => `- \`${shortAddress(address)}\` -> ${escapeMarkdown(owner)}`);
            const remain = entries.length > maxRows ? `\n... dan ${entries.length - maxRows} label lainnya.` : '';

            await interaction.reply({
                content: `Daftar label wallet (${entries.length}):\n${lines.join('\n')}${remain}`,
                ephemeral: true
            });
        }
    } catch (error) {
        console.error('Error saat memproses slash command wallet-label:', error);

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'Terjadi error saat memproses command.',
                ephemeral: true
            });
            return;
        }

        await interaction.followUp({
            content: 'Terjadi error saat memproses command.',
            ephemeral: true
        });
    }
});

app.post('/webhook/nft', async (req, res) => {
    try {
        const data = req.body;
        const activities = Array.isArray(data?.event?.activity) ? data.event.activity : [];

        if (activities.length === 0) {
            return res.status(200).send('Bukan aktivitas transaksi');
        }

        const normalizedActivities = activities
            .map((activity, index) => normalizeActivity(activity, index))
            .filter(Boolean);

        if (normalizedActivities.length === 0) {
            return res.status(200).send('Tidak ada aktivitas NFT valid');
        }

        const channel = await client.channels.fetch(process.env.CHANNEL_ID);
        if (!channel || typeof channel.send !== 'function') {
            console.error('Channel target tidak valid atau tidak bisa mengirim pesan.');
            return res.status(500).send('Channel target tidak valid');
        }

        const guildLabels = getGuildLabels(channel.guildId);
        const events = buildEventsFromActivities(normalizedActivities, guildLabels);

        let sentCount = 0;
        for (const event of events) {
            if (!enabledEventFilters.has(event.type)) {
                continue;
            }

            const embed = buildEmbed(event, guildLabels);
            await channel.send({ embeds: [embed] });
            sentCount += 1;
        }

        res.status(200).send(`Webhook berhasil diproses (${sentCount} notifikasi)`);
    } catch (error) {
        console.error('Error memproses webhook Alchemy:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Jalankan Express Server & Login Bot
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server Webhook berjalan di http://localhost:${PORT}`);
    client.login(process.env.DISCORD_TOKEN);
});

function parseEventFilters(rawValue) {
    if (typeof rawValue !== 'string' || rawValue.trim() === '') {
        return new Set(DEFAULT_EVENT_FILTERS);
    }

    const parsed = rawValue
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => VALID_EVENT_TYPES.has(entry));

    return parsed.length > 0 ? new Set(parsed) : new Set(DEFAULT_EVENT_FILTERS);
}

function ensureLabelStorage() {
    fs.mkdirSync(dataDir, { recursive: true });

    if (!fs.existsSync(walletLabelsPath)) {
        fs.writeFileSync(walletLabelsPath, '{}\n', 'utf8');
    }
}

function loadWalletLabels() {
    try {
        ensureLabelStorage();
        const content = fs.readFileSync(walletLabelsPath, 'utf8');
        const parsed = JSON.parse(content);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        console.error('Gagal membaca wallet label, fallback ke object kosong:', error);
        return {};
    }
}

function saveWalletLabels(nextData) {
    ensureLabelStorage();

    const tempPath = `${walletLabelsPath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(nextData, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, walletLabelsPath);
}

function getGuildLabels(guildId) {
    if (!guildId) {
        return {};
    }

    const allLabels = loadWalletLabels();
    const rawLabels = allLabels[guildId];
    if (!rawLabels || typeof rawLabels !== 'object') {
        return {};
    }

    const normalized = {};
    for (const [address, owner] of Object.entries(rawLabels)) {
        const normalizedAddress = normalizeAddress(address);
        if (!isValidAddress(normalizedAddress)) {
            continue;
        }
        normalized[normalizedAddress] = owner;
    }

    return normalized;
}

function normalizeActivity(activity, index) {
    if (!activity || !TRACKED_CATEGORIES.has(activity.category)) {
        return null;
    }

    const tokenId = activity.erc721TokenId || activity.erc1155Metadata?.[0]?.tokenId || 'N/A';

    return {
        id: `${index}-${activity.hash || activity.transactionHash || 'nohash'}`,
        hash: activity.hash || activity.transactionHash || null,
        category: activity.category,
        contractAddress: activity.rawContract?.address || null,
        tokenId: String(tokenId),
        fromAddress: activity.fromAddress || null,
        toAddress: activity.toAddress || null
    };
}

function buildEventsFromActivities(activities, guildLabels) {
    const events = [];
    const consumedActivityIds = new Set();
    const sweepBuckets = new Map();

    for (const activity of activities) {
        if (!activity.hash || !activity.toAddress) {
            continue;
        }

        const normalizedFrom = normalizeAddress(activity.fromAddress);
        if (normalizedFrom === ZERO_ADDRESS) {
            continue;
        }

        const normalizedTo = normalizeAddress(activity.toAddress);
        const key = `${activity.hash}:${normalizedTo}`;
        if (!sweepBuckets.has(key)) {
            sweepBuckets.set(key, []);
        }
        sweepBuckets.get(key).push(activity);
    }

    for (const groupedActivities of sweepBuckets.values()) {
        if (groupedActivities.length < 2) {
            continue;
        }

        for (const activity of groupedActivities) {
            consumedActivityIds.add(activity.id);
        }

        const uniqueContracts = [...new Set(groupedActivities.map((item) => item.contractAddress).filter(Boolean))];
        const uniqueFromAddresses = [...new Set(groupedActivities.map((item) => item.fromAddress).filter(Boolean))];
        const tokenIds = groupedActivities.map((item) => item.tokenId).filter(Boolean);

        events.push({
            type: 'sweep',
            hash: groupedActivities[0].hash,
            toAddress: groupedActivities[0].toAddress,
            fromAddresses: uniqueFromAddresses,
            contracts: uniqueContracts,
            tokenIds,
            nftCount: groupedActivities.length
        });
    }

    for (const activity of activities) {
        if (consumedActivityIds.has(activity.id)) {
            continue;
        }

        const type = classifySingleActivity(activity, guildLabels);
        if (type === 'unknown') {
            continue;
        }

        events.push({
            type,
            hash: activity.hash,
            contractAddress: activity.contractAddress,
            tokenId: activity.tokenId,
            fromAddress: activity.fromAddress,
            toAddress: activity.toAddress
        });
    }

    return events;
}

function classifySingleActivity(activity, guildLabels) {
    const normalizedFrom = normalizeAddress(activity.fromAddress);
    const normalizedTo = normalizeAddress(activity.toAddress);

    if (normalizedFrom === ZERO_ADDRESS) {
        return 'mint';
    }

    if (normalizedTo && guildLabels[normalizedTo]) {
        return 'buy';
    }

    if (normalizedFrom && guildLabels[normalizedFrom]) {
        return 'sell';
    }

    return 'unknown';
}

function buildEmbed(event, guildLabels) {
    const typeLabel = event.type.toUpperCase();

    const embed = new EmbedBuilder()
        .setColor(0x627EEA)
        .setTitle(`🚨 ${typeLabel} NFT Ethereum Terdeteksi!`)
        .setTimestamp()
        .setFooter({ text: 'Trace NFT Watcher • Powered by Alchemy' });

    if (event.type === 'sweep') {
        embed.addFields(
            { name: 'Koleksi (Contract)', value: formatSweepContracts(event.contracts), inline: false },
            { name: 'Tipe', value: typeLabel, inline: true },
            { name: 'Jumlah NFT', value: String(event.nftCount), inline: true },
            { name: 'Token Ringkasan', value: formatTokenSummary(event.tokenIds), inline: false },
            { name: 'Dari', value: formatSweepFrom(event.fromAddresses, guildLabels), inline: true },
            { name: 'Ke (Target)', value: formatWallet(event.toAddress, guildLabels), inline: true }
        );
        return embed;
    }

    embed.addFields(
        { name: 'Koleksi (Contract)', value: formatContract(event.contractAddress), inline: false },
        { name: 'Tipe', value: typeLabel, inline: true },
        { name: 'Token ID', value: escapeMarkdown(event.tokenId || 'N/A'), inline: true },
        { name: 'Dari', value: formatWallet(event.fromAddress, guildLabels), inline: true },
        { name: 'Ke (Target)', value: formatWallet(event.toAddress, guildLabels), inline: true }
    );

    return embed;
}

function formatSweepFrom(fromAddresses, guildLabels) {
    if (!Array.isArray(fromAddresses) || fromAddresses.length === 0) {
        return 'N/A';
    }

    if (fromAddresses.length === 1) {
        return formatWallet(fromAddresses[0], guildLabels);
    }

    return `Multiple wallets (${fromAddresses.length})`;
}

function formatSweepContracts(contracts) {
    if (!Array.isArray(contracts) || contracts.length === 0) {
        return 'Unknown';
    }

    if (contracts.length === 1) {
        return formatContract(contracts[0]);
    }

    const preview = contracts
        .slice(0, 3)
        .map((address) => formatContract(address))
        .join(', ');
    const extra = contracts.length > 3 ? ` +${contracts.length - 3} lainnya` : '';

    return `${contracts.length} contracts (${preview}${extra})`;
}

function formatTokenSummary(tokenIds) {
    if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
        return 'N/A';
    }

    const sanitized = tokenIds.map((tokenId) => escapeMarkdown(tokenId));
    const preview = sanitized.slice(0, MAX_SWEEP_TOKEN_PREVIEW).join(', ');

    if (sanitized.length <= MAX_SWEEP_TOKEN_PREVIEW) {
        return preview;
    }

    return `${preview} +${sanitized.length - MAX_SWEEP_TOKEN_PREVIEW} lainnya`;
}

function formatContract(contractAddress) {
    if (!contractAddress) {
        return 'Unknown';
    }

    if (!isValidAddress(contractAddress)) {
        return escapeMarkdown(contractAddress);
    }

    return `[${shortAddress(contractAddress)}](${ETHERSCAN_ADDRESS_URL}/${contractAddress})`;
}

function formatWallet(address, guildLabels) {
    if (!address) {
        return 'N/A';
    }

    const normalizedAddress = normalizeAddress(address);
    const ownerName = normalizedAddress ? guildLabels[normalizedAddress] : null;
    const ownerSuffix = ownerName ? ` (${escapeMarkdown(ownerName)})` : '';

    if (!isValidAddress(address)) {
        return `${escapeMarkdown(address)}${ownerSuffix}`;
    }

    return `[${shortAddress(address)}${ownerSuffix}](${ETHERSCAN_ADDRESS_URL}/${address})`;
}

function shortAddress(address) {
    if (typeof address !== 'string' || address.length < 10) {
        return address || 'N/A';
    }

    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function normalizeAddress(address) {
    if (typeof address !== 'string') {
        return null;
    }

    return address.trim().toLowerCase();
}

function isValidAddress(address) {
    return typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address);
}

function escapeMarkdown(value) {
    return String(value ?? '').replace(/([\\`*_{}\[\]()#+\-.!|>~])/g, '\\$1');
}

async function registerGuildCommands() {
    const token = process.env.DISCORD_TOKEN;
    const clientId = process.env.DISCORD_CLIENT_ID;
    const guildId = process.env.GUILD_ID;

    if (!token || !clientId || !guildId) {
        console.warn('Skip registrasi slash command: DISCORD_TOKEN / DISCORD_CLIENT_ID / GUILD_ID belum lengkap.');
        return;
    }

    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: slashCommands.map((command) => command.toJSON()) }
    );

    console.log(`✅ Slash command wallet-label terdaftar untuk guild ${guildId}`);
}
