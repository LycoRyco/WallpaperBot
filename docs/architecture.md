# WallpaperBot architecture

This document is the agreed technical blueprint for version 1 of WallpaperBot. It is written so that each later coding step has a clear purpose.

## Goal

The owner sends an X post link to the Telegram bot. The bot automatically extracts its images, stores a private copy, queues the post for a Tehran-time publishing slot, shows the owner a private preview, and publishes it to the public wallpaper channel.

Version 1 is intentionally personal-use only. It accepts commands from one configured Telegram account and does not provide a public interface.

## Main pieces

```text
Owner's Telegram chat
        |
        v
Telegram Bot API <--> Cloudflare Worker <--> Cloudflare D1 database
                              |
                              +--> FxEmbed API (extract X post media)
                              |
                              +--> Private Telegram archive channel
                              |
                              +--> Public Telegram wallpaper channel
```

### Cloudflare Worker

The Worker is the small web application that receives Telegram updates and runs scheduled checks. It contains the bot's rules, but no permanent secrets in source code.

### Cloudflare D1

D1 is the lightweight database. It remembers each submitted X post, its status, its chosen time slot, image metadata, retry attempts, and file-number counters.

### Telegram

Telegram has three roles:

1. **Owner chat** — where you send X links and receive previews, errors, and control buttons.
2. **Private archive channel** — where the bot safely keeps queued original files. This is only internal storage.
3. **Public wallpaper channel** — where the finished visual album and downloadable files are posted.

### FxEmbed

The first version uses FxEmbed's public API to read public X post data without paying for X's API. The code treats it as an interchangeable extractor, so a future self-hosted extractor or VPS implementation can replace it without changing the queue or Telegram logic.

## Processing flow

### 1. Receive a link

1. You paste an `x.com` or `twitter.com` post URL into the bot chat.
2. The Worker verifies that the sender's Telegram numeric ID matches `OWNER_TELEGRAM_USER_ID`.
3. The bot extracts and normalizes the X post ID from the URL.
4. D1 checks whether that post is already known.

Duplicate behavior:

- **Queued, ready, scheduled, or published:** the bot returns its existing status instead of downloading it again.
- **Failed:** sending the link again starts a fresh retry cycle for that same post.

### 2. Extract and archive

1. The Worker asks FxEmbed for the post's author handle and media list.
2. Version 1 accepts only posts containing images. Video, GIF, mixed-media, private, deleted, or unsupported posts are rejected clearly and do not consume a schedule slot.
3. Images retain the exact order provided by X.
4. Each image receives a stable document filename at successful download time, such as `artist_handle_Twitter001.jpg`.
5. The bot sends the original files to the private archive channel and stores their Telegram file identifiers in D1.

The filename is intentionally assigned before publication. If **Publish now** makes a newer item appear in the public channel first, its filename number can be ahead of an older queued item. The bot never renames it later.

### 3. Assign a slot and preview

Only a fully downloaded and archived item can reserve a schedule slot.

- Publishing slots are 09:00, 10:00, and 11:00 in `Asia/Tehran`.
- A ready item must have at least 15 minutes before its slot. For example, an item ready at 10:53 cannot use 11:00.
- The bot selects the next unreserved qualifying slot.
- It sends you a private preview with its artist, source link, number of images, assigned time, and preview images.

The private preview includes:

- **Cancel** — permanently removes the queue record and its private archive files.
- **Reschedule** — lets you choose another future free slot.
- **Publish now** — immediately sends it to the public channel.

### 4. Publish

At the selected time, the Worker:

1. Obtains the queued item and marks it as being published so it cannot run twice.
2. Sends the visual image album to the public channel, with the channel caption on the first image.
3. Sends the matching original files immediately afterward as Telegram documents.
4. Records the resulting Telegram message IDs and marks the item published.
5. Notifies you if publication cannot complete.

For one image, the bot sends one photo followed by one document. For multiple images, it sends a photo album followed by a document album. Telegram albums use the same source order as the X post.

## Caption format

```text
Artist: artist_handle
Wallpaper Source: X (Twitter)
Link: https://x.com/artist_handle/status/POST_ID

@LycoRyco_Wallpapers
```

The artist-handle text is clickable in Telegram, but its readable text remains the full original handle and is not prefixed with `@`. The source link stays visible.

## File-size policy

| Situation | Bot behavior |
| --- | --- |
| Original image is suitable as a Telegram photo | Uses it in the visual album and archives it as a document. |
| Original is too large for Telegram's photo display | Uses an X-provided smaller rendition for the visual preview, while the document remains the original. |
| Original is over Telegram's 50 MB normal bot document limit | Reports the item as unsupported; it is not published. |

The Worker will not re-compress or alter original files. This avoids quality loss and stays within the Cloudflare free plan's practical limits.

## Retries and failures

### Extraction failures

- Initial extraction happens immediately.
- The bot tries again after 30 minutes.
- It makes up to three automatic retry attempts.
- After the final failure, it notifies you with a **Retry** button.
- No slot is held during an extraction failure.

When a delayed retry succeeds, the item takes the next available future slot. It never displaces a previously ready or scheduled wallpaper.

### Publication failures

The bot records each publication attempt to prevent accidental duplicate posts. If Telegram reports an error, the bot notifies you with the affected item and a safe retry option.

## Schedule implementation

Telegram's built-in Scheduled Messages interface cannot be created or edited through a normal bot. Therefore the queue is managed by WallpaperBot and visible in the bot's own `/queue` command.

Cloudflare Cron wakes the Worker on a regular schedule. The Worker uses the `Asia/Tehran` timezone to decide whether a 09:00, 10:00, or 11:00 slot is due. This avoids depending on a fixed UTC offset and keeps the intended Tehran wall-clock times correct.

## Database records

The final database schema will contain at least:

| Record | Purpose |
| --- | --- |
| `wallpapers` | One record per X post: normalized post ID, artist, URL, state, slot, retry information, and publication results. |
| `media` | One record per image: original URL, preview URL, original filename, source ordering, and private archive Telegram file ID. |
| `counters` | The next filename number for each artist handle. |
| `events` | A small audit trail for submission, retry, reschedule, cancellation, and publishing events. |
| `processed_telegram_updates` | Prevents Telegram webhook retries from processing the same update twice. |

## Security rules

- The bot token is stored only as a Cloudflare secret.
- Telegram webhook requests carry a second Cloudflare secret header, so forged requests are rejected.
- The owner Telegram user ID is stored as configuration and checked on every update.
- Channel IDs are stored as configuration, not hard-coded in source code.
- `.env` files are ignored by Git.
- The public repository contains placeholders only, never credentials, personal chat IDs, or bot tokens.

## Portability to a VPS

The code will have two layers:

```text
Core bot rules
  ├── link parsing, queueing, captions, filenames, retries
  └── Telegram and extractor interfaces

Platform layer
  ├── Cloudflare Worker webhook, D1, and Cron adapters
  └── future Docker/VPS webhook, SQL database, and scheduler adapters
```

If Cloudflare's free plan is no longer sufficient, the core rules can be kept and wrapped in a Docker service for a VPS. The future VPS would need its own database and scheduled-job runner, but the behavior and Telegram workflow would remain the same.
