# WallpaperBot

A personal Telegram bot for turning an X (Twitter) post link into a scheduled wallpaper post.

WallpaperBot downloads the images from a supported X post, keeps them in their original order, sends you a private preview, and publishes them to your Telegram channel at the next available Tehran-time slot.

> **Project status:** planning and project setup. No bot code has been written yet.

## What the bot will do

- Accept X post links from its owner only.
- Extract image-only X posts through a configurable extractor service.
- Keep the image order shown in the original X post.
- Create a Telegram photo album with the channel caption, followed by downloadable document files.
- Keep the original X source link visible in the caption.
- Use the artist's X handle in the caption and filename.
- Queue ready posts for 09:00, 10:00, or 11:00 in Tehran time.
- Send a private preview with **Cancel**, **Reschedule**, and **Publish now** controls.
- Retry failed extraction every 30 minutes, up to three times, then notify the owner.
- Store queued source files in a private Telegram archive channel.

## Planned technology

- **Hosting:** Cloudflare Workers (free plan)
- **Database:** Cloudflare D1
- **Scheduling:** Cloudflare Cron Trigger, with Tehran time calculated by the bot
- **Bot platform:** Telegram Bot API
- **X extraction:** FxEmbed public API initially; the extractor is designed to be replaceable later

The application logic will be kept separate from Cloudflare-specific code, so it can later be packaged in Docker and moved to a VPS without rewriting the bot.

## Expected post format

The source link remains visible, as requested:

```text
Artist: @artist_handle
Wallpaper Source: X (Twitter)
Link: https://x.com/artist_handle/status/POST_ID

@LycoRyco_Wallpapers
```

Each wallpaper gets a stable filename when it is successfully downloaded, for example:

```text
artist_handle_Twitter001.jpg
```

Using **Publish now** may intentionally make these filename numbers appear out of channel-posting order. The filename will not be changed later.

## Telegram file limits

- The original image is preserved as a Telegram document when it is no more than 50 MB.
- If an original is too large for Telegram's visual photo preview, the bot uses an X-provided smaller rendition for the preview while keeping the original document unchanged.
- Files above Telegram's normal 50 MB bot-upload limit cannot be published by this first version.

## Repository layout

```text
WallpaperBot/
├── README.md              # Project overview and decisions
├── .env.example           # Safe list of required configuration names
├── .gitignore             # Keeps secrets and generated files out of Git
├── docs/                  # Architecture and setup guides (to be added)
└── src/                   # Bot source code (to be added)
```

## Before code is deployed

You will need to:

1. Create a Telegram bot with BotFather.
2. Create a private Telegram archive channel and make the bot an admin there.
3. Make the bot an admin in the public wallpaper channel.
4. Create a free Cloudflare account and configure Workers and D1.
5. Add the bot token and channel IDs as Cloudflare secrets, never to this repository.

Detailed beginner-friendly setup instructions will be added as the project is built.
