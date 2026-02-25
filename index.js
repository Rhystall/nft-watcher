require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const app = express();
app.use(express.json());

// Inisialisasi Discord Bot
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', () => {
    console.log(`🤖 Bot Discord online sebagai ${client.user.tag}`);
});

// Endpoint Webhook untuk menerima data dari Blockchain Provider
app.post('/webhook/nft', async (req, res) => {
    try {
        const data = req.body;

        // Alchemy membungkus data transaksinya di dalam object "event.activity"
        const activities = data.event?.activity;

        // Kalau bukan data transaksi yang valid, abaikan saja
        if (!activities || activities.length === 0) {
            return res.status(200).send('Bukan aktivitas transaksi');
        }

        const channel = await client.channels.fetch(process.env.CHANNEL_ID);

        // Looping jika dalam 1 transaksi ada banyak NFT yang di-transfer/sweep
        for (const activity of activities) {
            // Kita filter hanya untuk transaksi NFT (ERC721 atau ERC1155)
            if (activity.category === 'erc721' || activity.category === 'erc1155') {

                const contractAddress = activity.rawContract?.address || 'Unknown';
                const tokenId = activity.erc721TokenId || activity.erc1155Metadata?.[0]?.tokenId || 'N/A';
                const fromWallet = activity.fromAddress;
                const toWallet = activity.toAddress; // Wallet yang menerima/membeli

                // Bikin Embed Message yang dinamis sesuai data blockchain
                const embed = new EmbedBuilder()
                    .setColor(0x627EEA) // Warna biru Ethereum
                    .setTitle('🚨 Transaksi NFT Ethereum Terdeteksi!')
                    .addFields(
                        { name: 'Koleksi (Contract)', value: `[${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}](https://etherscan.io/address/${contractAddress})`, inline: false },
                        { name: 'Token ID', value: tokenId, inline: true },
                        { name: 'Dari', value: `[${fromWallet.slice(0, 6)}...](https://etherscan.io/address/${fromWallet})`, inline: true },
                        { name: 'Ke (Target)', value: `[${toWallet.slice(0, 6)}...](https://etherscan.io/address/${toWallet})`, inline: true }
                    )
                    .setTimestamp()
                    .setFooter({ text: 'Trace NFT Watcher • Powered by Alchemy' });

                await channel.send({ embeds: [embed] });
            }
        }

        // Wajib balas 200 OK ke Alchemy biar webhook ngga dianggap gagal & diulang-ulang
        res.status(200).send('Webhook berhasil diproses');
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