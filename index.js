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
    PermissionFlagsBits,
    MessageFlags
} = require('discord.js');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const NFT_CATEGORIES = new Set(['erc721', 'erc1155']);
const NFT_TOKEN_TYPES = new Set(['erc721', 'erc1155']);
const VALID_EVENT_TYPES = new Set(['mint', 'sweep', 'buy', 'sell', 'transfer']);
const DEFAULT_EVENT_FILTERS = ['mint', 'sweep', 'buy', 'sell', 'transfer'];
const MAX_SWEEP_TOKEN_PREVIEW = 10;
const ETHERSCAN_ADDRESS_URL = 'https://etherscan.io/address';
const WEBHOOK_PATH = '/webhook/nft';
const WEBHOOK_BODY_LIMIT = process.env.WEBHOOK_BODY_LIMIT || '20mb';
const WEBHOOK_DEBUG_SKIPS = parseBooleanEnv(process.env.WEBHOOK_DEBUG_SKIPS, false);

const dataDir = path.join(__dirname, 'data');
const walletLabelsPath = path.join(dataDir, 'wallet-labels.json');

const app = express();
const webhookJsonParser = express.json({ limit: WEBHOOK_BODY_LIMIT });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const enabledEventFilters = parseEventFilters(process.env.TX_EVENT_FILTERS);
const configuredTrackedWallets = parseAddressList(process.env.TRACKED_WALLETS);

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
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            await interaction.reply({
                content: 'Kamu tidak punya izin untuk mengelola label wallet.',
                flags: MessageFlags.Ephemeral
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
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (!ownerInput) {
                await interaction.reply({
                    content: 'Nama owner tidak boleh kosong.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            guildLabels[normalizedAddress] = ownerInput;
            saveWalletLabels(allLabels);

            await interaction.reply({
                content: `Label disimpan: \`${shortAddress(normalizedAddress)}\` -> **${escapeMarkdown(ownerInput)}**`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (subcommand === 'remove') {
            const addressInput = interaction.options.getString('address', true);
            const normalizedAddress = normalizeAddress(addressInput);

            if (!isValidAddress(normalizedAddress)) {
                await interaction.reply({
                    content: 'Alamat wallet tidak valid. Gunakan format 0x + 40 karakter hex.',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            if (!guildLabels[normalizedAddress]) {
                await interaction.reply({
                    content: `Label untuk \`${shortAddress(normalizedAddress)}\` tidak ditemukan.`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            delete guildLabels[normalizedAddress];
            saveWalletLabels(allLabels);

            await interaction.reply({
                content: `Label untuk \`${shortAddress(normalizedAddress)}\` berhasil dihapus.`,
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        if (subcommand === 'list') {
            const entries = Object.entries(guildLabels);
            if (entries.length === 0) {
                await interaction.reply({
                    content: 'Belum ada label wallet untuk guild ini.',
                    flags: MessageFlags.Ephemeral
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
                flags: MessageFlags.Ephemeral
            });
        }
    } catch (error) {
        console.error('Error saat memproses slash command wallet-label:', error);

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'Terjadi error saat memproses command.',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.followUp({
            content: 'Terjadi error saat memproses command.',
            flags: MessageFlags.Ephemeral
        });
    }
});

app.post(WEBHOOK_PATH, webhookJsonParser, async (req, res) => {
    try {
        const activities = Array.isArray(req.body?.event?.activity) ? req.body.event.activity : [];
        console.log(`[WEBHOOK] Received ${activities.length} activities`);

        if (activities.length === 0) {
            return res.status(200).send('ok');
        }

        const channel = await client.channels.fetch(process.env.CHANNEL_ID);
        if (!channel || typeof channel.send !== 'function') {
            console.error('[WEBHOOK] Channel target tidak valid atau tidak bisa mengirim pesan.');
            return res.status(200).send('ok');
        }

        const guildLabels = getGuildLabels(channel.guildId);
        const trackedWallets = buildTrackedWallets(guildLabels);
        const incomingCount = activities.length;
        let nftAccepted = 0;
        let nftRejected = 0;
        const normalizedActivities = [];

        for (const [index, activity] of activities.entries()) {
            const support = isSupportedNFTActivity(activity);
            if (!support.supported) {
                nftRejected += 1;
                logWebhookSkip({ reason: support.reason, activity });
                continue;
            }

            const normalized = normalizeActivity(activity, index);
            if (!normalized) {
                nftRejected += 1;
                logWebhookSkip({ reason: 'normalize_failed', activity });
                continue;
            }

            normalizedActivities.push({
                ...normalized,
                transactionHash: activity.transactionHash || activity.hash || normalized.hash || null,
                tokenIds: extractTokenIds(activity)
            });
            nftAccepted += 1;
        }

        if (normalizedActivities.length === 0) {
            console.log(
                `[WEBHOOK] Summary incoming=${incomingCount}, nftAccepted=${nftAccepted}, nftRejected=${nftRejected}, tx=0, transfer=0, filtered=0, sent=0, failed=0, tracked=${trackedWallets.size}`
            );
            return res.status(200).send('ok');
        }

        // One notification per transaction hash to avoid sweep spam.
        const groupedActivities = groupByTxHash(normalizedActivities);
        let classifiedTransfer = 0;
        let filteredByEnv = 0;
        let sentCount = 0;
        let failedCount = 0;
        let droppedNoEvent = 0;

        for (const [txHash, txActivities] of groupedActivities.entries()) {
            // Classify at transaction level so conduit/proxy transfers are still captured.
            const classification = classifyTransaction(txActivities, trackedWallets);
            const { eventType, nftCount, rawEventType } = classification;
            if (eventType === 'TRANSFER') {
                classifiedTransfer += 1;
            }
            const logEventType = rawEventType && rawEventType !== eventType
                ? `${eventType} (${rawEventType})`
                : eventType;
            console.log(`[WEBHOOK] Processing tx ${txHash} → ${logEventType} (${nftCount} NFTs)`);

            const event = buildEventFromTransaction(txHash, txActivities, classification, trackedWallets);
            if (!event) {
                droppedNoEvent += 1;
                logWebhookSkip({ reason: 'event_build_failed', activity: txActivities[0], txHash });
                continue;
            }

            if (!enabledEventFilters.has(event.type)) {
                filteredByEnv += 1;
                logWebhookSkip({
                    reason: 'filtered_by_env',
                    activity: txActivities[0],
                    txHash,
                    eventType: event.type
                });
                continue;
            }

            const embed = buildEmbed(event, guildLabels);
            try {
                await channel.send({ embeds: [embed] });
                sentCount += 1;
            } catch (error) {
                failedCount += 1;
                console.error(`Gagal mengirim embed Discord. type=${event.type}, hash=${event.hash || 'N/A'}`, error);
            }
        }

        console.log(
            `[WEBHOOK] Summary incoming=${incomingCount}, nftAccepted=${nftAccepted}, nftRejected=${nftRejected}, tx=${groupedActivities.size}, transfer=${classifiedTransfer}, filtered=${filteredByEnv}, sent=${sentCount}, failed=${failedCount}, dropped=${droppedNoEvent}, tracked=${trackedWallets.size}`
        );
    } catch (error) {
        console.error('[WEBHOOK] Error memproses webhook Alchemy:', error);
    }

    if (!res.headersSent) {
        return res.status(200).send('ok');
    }
});

app.use((error, req, res, next) => {
    const isWebhookRequest = req.path === WEBHOOK_PATH;
    const isPayloadTooLarge = error?.type === 'entity.too.large' || error?.status === 413;

    if (isWebhookRequest && isPayloadTooLarge) {
        const length = req.headers['content-length'] || 'unknown';
        console.warn(
            `[WEBHOOK] Payload terlalu besar. content-length=${length}, limit=${WEBHOOK_BODY_LIMIT}, status=413`
        );
        return res.status(413).json({ error: 'payload_too_large' });
    }

    return next(error);
});

// Jalankan Express Server & Login Bot
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server Webhook berjalan di http://localhost:${PORT}`);
    console.log(`📦 WEBHOOK_BODY_LIMIT aktif: ${WEBHOOK_BODY_LIMIT}`);
    console.log(`🧪 WEBHOOK_DEBUG_SKIPS: ${WEBHOOK_DEBUG_SKIPS}`);
    console.log(`⚙️ Filter event aktif: ${[...enabledEventFilters].join(', ')}`);
    console.log(`👀 Tracked wallet dari env: ${configuredTrackedWallets.size}`);
    if (configuredTrackedWallets.size === 0) {
        console.warn(
            'TRACKED_WALLETS kosong. BUY/SELL/SWEEP akan mengandalkan wallet label, dan event ambigu dipetakan ke TRANSFER.'
        );
    }
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

function parseBooleanEnv(rawValue, defaultValue = false) {
    if (typeof rawValue !== 'string') {
        return defaultValue;
    }

    const normalized = rawValue.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
        return false;
    }

    return defaultValue;
}

function parseAddressList(rawValue) {
    if (typeof rawValue !== 'string' || rawValue.trim() === '') {
        return new Set();
    }

    const parsed = new Set();
    const tokens = rawValue.split(/[,\s]+/).map((entry) => normalizeAddress(entry));

    for (const token of tokens) {
        if (!token) {
            continue;
        }

        if (!isValidAddress(token)) {
            console.warn(`Alamat di TRACKED_WALLETS tidak valid dan di-skip: ${token}`);
            continue;
        }

        parsed.add(token);
    }

    return parsed;
}

function buildTrackedWallets(guildLabels) {
    const tracked = new Set(configuredTrackedWallets);

    for (const address of Object.keys(guildLabels || {})) {
        const normalizedAddress = normalizeAddress(address);
        if (!isValidAddress(normalizedAddress)) {
            continue;
        }
        tracked.add(normalizedAddress);
    }

    return tracked;
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
    if (!activity) {
        return null;
    }

    const category = normalizeCategory(activity.category);
    const tokenIds = extractTokenIds(activity);
    const tokenId = tokenIds[0] || 'N/A';

    return {
        id: `${index}-${activity.hash || activity.transactionHash || 'nohash'}`,
        hash: activity.hash || activity.transactionHash || null,
        rawCategory: activity.category || null,
        category,
        tokenType: normalizeTokenType(activity.tokenType) || null,
        contractAddress: activity.rawContract?.address || activity.contractAddress || null,
        tokenId: String(tokenId),
        fromAddress: activity.fromAddress || null,
        toAddress: activity.toAddress || null
    };
}

function isSupportedNFTActivity(activity) {
    if (!activity) {
        return { supported: false, reason: 'missing_activity' };
    }

    const category = normalizeCategory(activity.category);
    const tokenType = normalizeTokenType(activity.tokenType);
    const hasERC721TokenId = activity?.erc721TokenId !== undefined && activity?.erc721TokenId !== null;
    const hasERC1155Metadata = Array.isArray(activity?.erc1155Metadata) &&
        activity.erc1155Metadata.some((metadata) => metadata?.tokenId !== undefined && metadata?.tokenId !== null);
    const hasNFTEvidence = hasERC721TokenId || hasERC1155Metadata || NFT_TOKEN_TYPES.has(tokenType);

    if (NFT_CATEGORIES.has(category)) {
        return { supported: true, reason: 'accepted_nft_category' };
    }

    if (category === 'token') {
        if (hasNFTEvidence) {
            return { supported: true, reason: 'accepted_token_with_nft_evidence' };
        }
        return { supported: false, reason: 'token_without_nft_evidence' };
    }

    return { supported: false, reason: `unsupported_category:${category || 'unknown'}` };
}

function extractTokenIds(act) {
    const tokenIdSet = new Set();

    if (act?.erc721TokenId !== undefined && act?.erc721TokenId !== null) {
        const tokenId = String(act.erc721TokenId).trim();
        if (tokenId) {
            tokenIdSet.add(tokenId);
        }
    }

    if (act?.tokenId !== undefined && act?.tokenId !== null) {
        const tokenId = String(act.tokenId).trim();
        if (tokenId) {
            tokenIdSet.add(tokenId);
        }
    }

    if (Array.isArray(act?.erc1155Metadata)) {
        for (const metadata of act.erc1155Metadata) {
            if (metadata?.tokenId === undefined || metadata?.tokenId === null) {
                continue;
            }
            const tokenId = String(metadata.tokenId).trim();
            if (tokenId) {
                tokenIdSet.add(tokenId);
            }
        }
    }

    return [...tokenIdSet];
}

function normalizeCategory(category) {
    if (typeof category !== 'string') {
        return '';
    }
    return category.trim().toLowerCase();
}

function normalizeTokenType(tokenType) {
    if (typeof tokenType !== 'string') {
        return '';
    }
    return tokenType.trim().toLowerCase();
}

function logWebhookSkip({ reason, activity = null, txHash = null, eventType = null }) {
    if (!WEBHOOK_DEBUG_SKIPS) {
        return;
    }

    const category = normalizeCategory(activity?.category) || 'unknown';
    const tokenType = normalizeTokenType(activity?.tokenType) || 'unknown';
    const resolvedTxHash = txHash || activity?.transactionHash || activity?.hash || 'nohash';
    const eventTypeSuffix = eventType ? `, eventType=${eventType}` : '';

    console.log(
        `[WEBHOOK][SKIP] reason=${reason}, tx=${resolvedTxHash}, category=${category}, tokenType=${tokenType}${eventTypeSuffix}`
    );
}

function groupByTxHash(activities) {
    const grouped = new Map();

    for (const activity of activities) {
        const txHash = activity?.hash || activity?.transactionHash || null;
        if (!txHash) {
            console.warn('[WEBHOOK] Activity tanpa tx hash di-skip.');
            continue;
        }

        if (!grouped.has(txHash)) {
            grouped.set(txHash, []);
        }
        grouped.get(txHash).push(activity);
    }

    return grouped;
}

function classifyTransaction(txActivities, trackedWallets) {
    let nftCount = 0;
    let hasMint = false;
    let hasTrackedFrom = false;
    let hasTrackedTo = false;

    for (const activity of txActivities) {
        const tokenIds = Array.isArray(activity.tokenIds) ? activity.tokenIds.filter(Boolean) : [];
        nftCount += tokenIds.length > 0 ? tokenIds.length : 1;

        const normalizedFrom = normalizeAddress(activity.fromAddress);
        const normalizedTo = normalizeAddress(activity.toAddress);

        if (normalizedFrom === ZERO_ADDRESS) {
            hasMint = true;
        }

        if (normalizedFrom && trackedWallets.has(normalizedFrom)) {
            hasTrackedFrom = true;
        }

        if (normalizedTo && trackedWallets.has(normalizedTo)) {
            hasTrackedTo = true;
        }
    }

    // Mint takes precedence over trade direction.
    if (hasMint) {
        return { eventType: 'MINT', rawEventType: 'MINT', nftCount, isSweep: false };
    }

    if (nftCount > 1) {
        if (hasTrackedFrom && hasTrackedTo) {
            return { eventType: 'TRANSFER', rawEventType: 'INTERNAL_TRANSFER', nftCount, isSweep: false };
        }
        if (hasTrackedTo) {
            return { eventType: 'SWEEP_BUY', rawEventType: 'SWEEP_BUY', nftCount, isSweep: true };
        }
        if (hasTrackedFrom) {
            return { eventType: 'SWEEP_SELL', rawEventType: 'SWEEP_SELL', nftCount, isSweep: true };
        }
    }

    if (hasTrackedTo) {
        return { eventType: 'BUY', rawEventType: 'BUY', nftCount, isSweep: false };
    }
    if (hasTrackedFrom) {
        return { eventType: 'SELL', rawEventType: 'SELL', nftCount, isSweep: false };
    }

    return { eventType: 'TRANSFER', rawEventType: 'TRANSFER_FALLBACK', nftCount, isSweep: false };
}

function buildEventFromTransaction(txHash, txActivities, classification, trackedWallets) {
    if (!Array.isArray(txActivities) || txActivities.length === 0 || !classification) {
        return null;
    }

    const eventType = classification.eventType;
    const rawEventType = classification.rawEventType || eventType;

    let primaryTrackedWallet = null;

    for (const activity of txActivities) {
        const normalizedTo = normalizeAddress(activity.toAddress);
        if (normalizedTo && trackedWallets.has(normalizedTo)) {
            primaryTrackedWallet = normalizedTo;
            break;
        }
    }

    if (!primaryTrackedWallet) {
        for (const activity of txActivities) {
            const normalizedFrom = normalizeAddress(activity.fromAddress);
            if (normalizedFrom && trackedWallets.has(normalizedFrom)) {
                primaryTrackedWallet = normalizedFrom;
                break;
            }
        }
    }

    const mappedType = {
        MINT: 'mint',
        BUY: 'buy',
        SELL: 'sell',
        SWEEP_BUY: 'sweep',
        SWEEP_SELL: 'sweep',
        TRANSFER: 'transfer'
    }[eventType];

    if (!mappedType) {
        return null;
    }

    if (mappedType === 'sweep') {
        // Aggregate sweep payload into a single embed-compatible event.
        const contractSet = new Set();
        const fromAddressSet = new Set();
        const tokenIdSet = new Set();
        let toAddress = null;

        for (const activity of txActivities) {
            if (activity.contractAddress) {
                contractSet.add(activity.contractAddress);
            }
            if (activity.fromAddress) {
                fromAddressSet.add(activity.fromAddress);
            }

            if (!toAddress && activity.toAddress) {
                toAddress = activity.toAddress;
            }

            const activityTokenIds = Array.isArray(activity.tokenIds) && activity.tokenIds.length > 0
                ? activity.tokenIds
                : [activity.tokenId].filter(Boolean);
            for (const tokenId of activityTokenIds) {
                tokenIdSet.add(String(tokenId));
            }
        }

        if (primaryTrackedWallet && eventType === 'SWEEP_BUY') {
            const preferredTo = txActivities.find(
                (activity) => normalizeAddress(activity.toAddress) === primaryTrackedWallet
            );
            if (preferredTo?.toAddress) {
                toAddress = preferredTo.toAddress;
            }
        }

        return {
            type: 'sweep',
            rawEventType,
            hash: txHash,
            toAddress,
            fromAddresses: [...fromAddressSet],
            contracts: [...contractSet],
            tokenIds: [...tokenIdSet],
            nftCount: classification.nftCount,
            isSweep: Boolean(classification.isSweep),
            sweepType: eventType === 'SWEEP_BUY' ? 'buy' : 'sell',
            primaryTrackedWallet
        };
    }

    let representative = null;

    if (primaryTrackedWallet) {
        representative = txActivities.find((activity) =>
            normalizeAddress(activity.toAddress) === primaryTrackedWallet ||
            normalizeAddress(activity.fromAddress) === primaryTrackedWallet
        );
    }

    if (!representative && eventType === 'MINT') {
        representative = txActivities.find(
            (activity) => normalizeAddress(activity.fromAddress) === ZERO_ADDRESS
        );
    }

    if (!representative && eventType === 'BUY') {
        representative = txActivities.find((activity) => {
            const normalizedTo = normalizeAddress(activity.toAddress);
            return normalizedTo && trackedWallets.has(normalizedTo);
        });
    }

    if (!representative && eventType === 'SELL') {
        representative = txActivities.find((activity) => {
            const normalizedFrom = normalizeAddress(activity.fromAddress);
            return normalizedFrom && trackedWallets.has(normalizedFrom);
        });
    }

    representative = representative || txActivities[0];
    if (!representative) {
        return null;
    }

    const representativeTokenId = Array.isArray(representative.tokenIds) && representative.tokenIds.length > 0
        ? representative.tokenIds[0]
        : representative.tokenId;

    return {
        type: mappedType,
        rawEventType,
        hash: txHash,
        contractAddress: representative.contractAddress || null,
        tokenId: representativeTokenId ? String(representativeTokenId) : 'N/A',
        fromAddress: representative.fromAddress || null,
        toAddress: representative.toAddress || null,
        nftCount: classification.nftCount,
        isSweep: Boolean(classification.isSweep),
        sweepType: null,
        primaryTrackedWallet
    };
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
