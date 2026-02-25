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

        // (Nanti di sini kita buat filter untuk mendeteksi MINT / SWEEP)
        console.log("Menerima webhook dari provider:", data);

        const channel = await client.channels.fetch(process.env.CHANNEL_ID);

        // Membuat pesan visual (Embed) ke Discord
        const embed = new EmbedBuilder()
            .setColor(0x00D1B2) // Warna aksen
            .setTitle('🚨 Aktivitas Wallet Terdeteksi!')
            .setDescription('Target wallet baru saja melakukan transaksi.')
            .addFields(
                { name: 'Aksi', value: 'Mint / Sweep', inline: true },
                { name: 'Network', value: 'Ethereum / Solana', inline: true }
            )
            .setTimestamp()
            .setFooter({ text: 'Trace NFT Watcher' });

        // Kirim pesan ke channel
        await channel.send({ embeds: [embed] });

        // Beri response OK ke provider agar webhook tidak dikirim ulang
        res.status(200).send('Webhook berhasil diproses');
    } catch (error) {
        console.error('Error memproses webhook:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Jalankan Express Server & Login Bot
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server Webhook berjalan di http://localhost:${PORT}`);
    client.login(process.env.DISCORD_TOKEN);
});