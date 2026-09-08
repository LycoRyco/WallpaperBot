# WallpaperBot

Personal Telegram bot for turning a public X (Twitter) image post into a scheduled wallpaper post.

WallpaperBot is built for one owner. Send it an X post link; it archives the original images, assigns the next available Tehran-time slot, sends a private preview, and publishes the finished post automatically.

## What it does

- Accepts public `x.com` and `twitter.com` image-post links from the configured owner only.
- Preserves the original image order.
- Archives original image files privately before a slot is reserved.
- Schedules wallpapers at 09:00, 10:00, or 11:00 in `Asia/Tehran`.
- Sends a private visual preview with **Publish now**, **Reschedule**, and **Cancel** controls.
- Publishes a visual photo album first, then the original downloadable document album.
- Keeps the visible X source link and artist handle in the public caption.
- Adds `@LycoRyco_Wallpapers` to the final document in a multi-image file album.
- Retries temporary extraction, archive, and publication failures every 10 minutes, up to three total attempts.
- Prevents accidental duplicate posts, with an owner command to intentionally allow reuse of one of the last three published links.

## Daily use

1. Send a public X image-post link to the bot.
2. Wait for the private preview and its assigned Tehran-time slot.
3. Leave it alone for automatic publication, or use the preview buttons to publish immediately, choose another slot, or cancel it.

Send `/start` in the bot chat to show the persistent keyboard and owner command menu.

For the full command list and operational notes, see [the daily-use guide](docs/operations.md).

## Public post format

```text
Artist: artist_handle
Wallpaper Source: X (Twitter)
Link: https://x.com/artist_handle/status/POST_ID

@LycoRyco_Wallpapers
```

The artist handle links to the artist’s X profile while remaining readable as plain text. The source URL is intentionally visible.

## Technology

- Cloudflare Workers and D1
- Cloudflare Cron Trigger, checked every five minutes
- Telegram Bot API
- FxEmbed public API for X-post extraction

The project keeps its Telegram and X-extraction logic separate enough to make a future Docker/VPS migration practical.

## Limits

- Image-only X posts are supported. Videos, GIFs, mixed-media posts, private posts, and deleted posts are rejected.
- Original files larger than Telegram’s 50 MB normal bot-upload limit cannot be published by this version.
- The FxEmbed public service is an external dependency; temporary problems are retried automatically.

## Repository guide

```text
src/                 Worker and bot logic
migrations/          Versioned D1 schema
docs/architecture.md System design and data flow
docs/operations.md   Daily use, commands, and channel setup
docs/build-roadmap.md Historical implementation record
```

## Development

```bash
npm run typecheck
npm run dev
npm run deploy
```

Never commit real secrets. `.env.example` lists only the required secret names.
