# Deploy your own WallpaperBot

This guide creates a separate bot, database, archive channel, and public channel for you. It never uses the original author’s Telegram bot or Cloudflare resources.

## Before you begin

You need:

- A Telegram account.
- A free Cloudflare account.
- Node.js 20 or newer.
- Git, or a downloaded copy of this repository.

## 1. Get the code and install dependencies

```bash
git clone https://github.com/LycoRyco/WallpaperBot.git
cd WallpaperBot
npm ci
npx wrangler login
```

`wrangler login` opens a browser so you can authorize the Cloudflare command-line tool.

## 2. Create your Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot` and follow its prompts.
3. Copy the token BotFather gives you. Treat it like a password.
4. Find your numeric Telegram user ID. This will be the only account allowed to operate the bot.

## 3. Create your Cloudflare D1 database

In the project folder, run:

```bash
npx wrangler d1 create your-wallpaperbot-db
```

Cloudflare prints a database UUID. Copy it.

Then create your own Worker configuration from the safe example:

```powershell
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

Open `wrangler.jsonc` and replace all three values:

- `name` — a unique Worker name, such as `my-wallpaperbot`.
- `database_name` and `database_id` — the D1 database name and UUID Cloudflare gave you.
- `CHANNEL_HANDLE` — your public channel username, including `@`.

Apply the database schema:

```bash
npx wrangler d1 migrations apply your-wallpaperbot-db --remote
```

## 4. Add the four secrets

Run each command below. Wrangler asks for the value privately; it does not write it into Git.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put OWNER_TELEGRAM_USER_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put WEBHOOK_SETUP_SECRET
```

Use the BotFather token for `TELEGRAM_BOT_TOKEN` and your numeric Telegram ID for `OWNER_TELEGRAM_USER_ID`.

For the two remaining values, create two different long random strings and save them in a password manager. They protect incoming Telegram requests and the one-time webhook setup route.

## 5. Deploy and register the webhook

Deploy the Worker:

```bash
npm run deploy
```

Copy the Worker URL printed by Wrangler. Then register Telegram’s webhook from PowerShell, replacing the two placeholders with your own values:

```powershell
$workerUrl = "https://YOUR-WORKER.workers.dev"
$setupSecret = "YOUR_WEBHOOK_SETUP_SECRET"
Invoke-RestMethod -Method Post -Uri "$workerUrl/internal/register-webhook" -Headers @{ "X-WallpaperBot-Setup-Secret" = $setupSecret }
```

The result should contain `webhook-registered`.

## 6. Connect your channels

Create two Telegram channels:

- A private archive channel for original files.
- A public wallpaper channel.

Add your bot as an administrator in both, with permission to post messages and media, and delete messages.

In your private bot chat:

1. Send `/start`.
2. Send `/connectarchive`, then post the one-time marker the bot gives you in the private archive channel.
3. Send `/connectpublic`, then post its one-time marker in the public wallpaper channel.

Each marker expires after 10 minutes and is removed automatically after the channel is connected.

## 7. Test safely

Use a separate test channel first if you prefer. Connect it with `/connectpublic`, send the bot a public X image post, and use **Publish now** from the private preview. When you are satisfied, connect your real public channel with `/connectpublic`; it replaces the test destination without publishing anything.

## Keeping it updated

To update a deployment later:

```bash
git pull
npm ci
npx wrangler d1 migrations apply your-wallpaperbot-db --remote
npm run typecheck
npm run deploy
```

Never copy another person’s `wrangler.jsonc`, D1 UUID, Cloudflare secrets, or Telegram token.
