# NFT Watcher Bot

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)
[![Express](https://img.shields.io/badge/Express-5.x-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/license/isc-license-txt)
[![PM2 Ready](https://img.shields.io/badge/PM2-ready-2B037A?logo=pm2&logoColor=white)](https://pm2.keymetrics.io/)
[![Build](https://img.shields.io/github/actions/workflow/status/your-org/nft-watcher/ci.yml?branch=main&label=build)](https://github.com/your-org/nft-watcher/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/github/actions/workflow/status/your-org/nft-watcher/tests.yml?branch=main&label=tests)](https://github.com/your-org/nft-watcher/actions/workflows/tests.yml)

NFT Watcher Bot is a Node.js + Discord bot that tracks Ethereum NFT activity (ERC721 and ERC1155) in real time.  
It receives Alchemy Custom Webhook payloads, classifies events heuristically, and sends structured Discord embed notifications.

## Features

- **Heuristic Event Classification**: Detects and classifies events into `MINT`, `BUY`, `SELL`, `SWEEP`, and fallback `TRANSFER`.
- **Anti-Spam Sweep Deduplication**: Multiple NFTs swept in the same transaction context are summarized into a single embed.
- **In-Discord Wallet Labeling**: Manage labels directly from Discord with `/wallet-label add`, `/wallet-label remove`, and `/wallet-label list`.
- **Admin-Only Wallet Label Commands**: Slash commands require the `ManageGuild` permission.
- **Global Event Filters**: Control which event types are sent via `TX_EVENT_FILTERS` in `.env`.

## Architecture Snapshot

`Alchemy Custom Webhook` -> `Express endpoint (/webhook/nft)` -> `Normalization + Classification + Filtering` -> `Discord Embed Notification`

Wallet labels are stored locally at:

```js
path.join(__dirname, 'data', 'wallet-labels.json')
```

The `data/` directory is auto-created at runtime if it does not exist.

## Prerequisites

- Node.js LTS (`>=18` recommended)
- A Discord application and bot token
- Bot added to your target Discord server
- An Alchemy app with Custom Webhooks configured
- Linux VPS (optional, for PM2 deployment)

## Installation & Setup

```bash
git clone https://github.com/your-org/nft-watcher.git
cd nft-watcher
npm install
cp .env.example .env
```

Edit `.env` with your values, then run:

```bash
node index.js
```

When the bot is online and `DISCORD_CLIENT_ID` + `GUILD_ID` are valid, slash commands are registered automatically for the target guild.

## Environment Variables

| Variable | Required | Description | Example |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Yes | Discord bot token | `MTAx...` |
| `CHANNEL_ID` | Yes | Target Discord channel ID for embeds | `123456789012345678` |
| `DISCORD_CLIENT_ID` | Yes | Discord application client ID (for slash command registration) | `123456789012345678` |
| `GUILD_ID` | Yes | Discord server ID where slash commands are registered | `123456789012345678` |
| `TRACKED_WALLETS` | No | Comma-separated wallet addresses to classify BUY/SELL direction | `0xabc...,0xdef...` |
| `TX_EVENT_FILTERS` | No | Comma-separated event types to send | `mint,sweep,buy,sell,transfer` |
| `PORT` | No | HTTP server port for webhook receiver | `3000` |
| `WEBHOOK_BODY_LIMIT` | No | Max JSON payload size for `/webhook/nft` | `20mb` |
| `WEBHOOK_DEBUG_SKIPS` | No | Enable debug logs for skipped/filtered webhook activities | `false` |

Notes:

- `TX_EVENT_FILTERS` valid values: `mint`, `sweep`, `buy`, `sell`, `transfer`.
- `TRACKED_WALLETS` is optional but recommended in production so BUY/SELL classification is consistent.
- Invalid or empty filter values fall back to default: `mint,sweep,buy,sell,transfer`.
- For Alchemy `Address Activity`, payload `category: token` is treated as NFT only when NFT evidence exists (`erc721TokenId`, `erc1155Metadata`, or `tokenType` = `ERC721/ERC1155`).
- Ambiguous NFT direction (cannot infer BUY/SELL safely) is mapped to `TRANSFER` instead of being dropped.
- Set `WEBHOOK_DEBUG_SKIPS=true` temporarily for detailed skip reasons (`reason`, `category`, `tokenType`, `txHash`).
- If webhook payload size exceeds `WEBHOOK_BODY_LIMIT`, endpoint returns HTTP `413` with `{ "error": "payload_too_large" }`.
- Restart the process after changing environment variables.

## Usage

### Slash Commands

- Add or update wallet label:

```text
/wallet-label add address:0xYourWalletAddress owner:Whale A
```

- Remove wallet label:

```text
/wallet-label remove address:0xYourWalletAddress
```

- List wallet labels:

```text
/wallet-label list
```

### Webhook Endpoint

- Method: `POST`
- Path: `/webhook/nft`
- Source: Alchemy Custom Webhooks

Behavior summary:

- Non-NFT activities are ignored.
- Non-NFT or unsupported payload patterns are skipped.
- Events not included in `TX_EVENT_FILTERS` are not sent.

## Deployment (PM2)

Install PM2 globally:

```bash
npm i -g pm2
```

Start the bot:

```bash
pm2 start index.js --name nft-watcher-bot
```

Persist process list:

```bash
pm2 save
```

Enable startup on reboot:

```bash
pm2 startup
```

Run the command generated by PM2, then save again:

```bash
pm2 save
```

Common PM2 operations:

```bash
pm2 status
pm2 logs nft-watcher-bot
pm2 restart nft-watcher-bot
pm2 restart nft-watcher-bot --update-env
pm2 stop nft-watcher-bot
pm2 delete nft-watcher-bot
```

Optional log rotation:

```bash
pm2 install pm2-logrotate
```

## Troubleshooting

- **Slash commands not appearing**
  - Verify `DISCORD_CLIENT_ID` and `GUILD_ID`.
  - Confirm bot is online and invited to the correct guild.
  - Check logs for command registration errors.
- **Invalid channel ID / no notifications**
  - Verify `CHANNEL_ID` points to a channel accessible by the bot.
  - Ensure the bot has permission to send messages and embeds.
- **Webhook requests received but no output**
  - Confirm payload uses Alchemy `event.activity`.
  - Check whether events are filtered out by `TX_EVENT_FILTERS`.
  - Ensure target wallets are configured in `TRACKED_WALLETS` or via `/wallet-label add`, otherwise BUY/SELL can be skipped as unknown.

## Security

- Never commit `.env` or any credentials.
- Keep Discord tokens and webhook-related secrets private.
- Rotate tokens immediately if they are exposed.

## Contributing

Contributions are welcome.  
Open an issue for bugs or feature proposals, then submit a focused pull request with clear context and reproduction steps when relevant.

## License

This project is licensed under the ISC License. See `package.json` for the current license metadata.
