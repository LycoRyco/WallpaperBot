# Daily use and operations

## Everyday workflow

Send a public X image-post link to WallpaperBot in your private chat. The bot validates the post, stores original files in the private archive channel, assigns the next available 09:00, 10:00, or 11:00 Tehran-time slot, and sends a private preview.

The preview appears once for each newly scheduled wallpaper. `/queue` is only a compact schedule list; it does not resend previews.

Leave a scheduled wallpaper alone for automatic publication, or use its buttons:

- **Publish now** — posts to the currently connected public channel.
- **Reschedule** — offers the next six free Tehran-time slots.
- **Cancel** — asks for confirmation, then deletes the queued item and its private archive files.

## Commands

| Command | Purpose |
| --- | --- |
| `/start` or `/help` | Shows the persistent keyboard and owner command menu. |
| `/queue` | Lists current queued items and their Tehran-time slots. |
| `/clearqueue` | Permanently removes every queued item after confirmation. Published history stays intact. |
| `/clearpublished` | Lets you choose one of the last three published records to forget, allowing that X link to be submitted again. Existing Telegram posts stay intact. |
| `/connectpublic` | Safely connects or replaces the public publishing channel. |
| `/connectarchive` | Safely connects or replaces the private archive channel. |

## Connecting a channel

1. Add the bot as a channel administrator with permission to post messages and media, and delete messages.
2. In the private bot chat, send `/connectpublic` or `/connectarchive`.
3. The bot gives you a one-time code valid for 10 minutes.
4. Post the exact marker and code in the target channel.
5. The bot removes the marker and confirms privately.

Connecting another public channel replaces the old publishing destination. It does not publish anything during setup.

## Automatic publication and recovery

Cloudflare wakes the bot every five minutes. The bot checks for due slots using the `Asia/Tehran` time zone, so it does not rely on a fixed UTC offset.

If extraction, archiving, or publication temporarily fails, the bot retries after 10 minutes. It makes at most three total attempts and sends a clear private error after the final failure.

## Notes

- The private archive channel is internal storage. Public channel users cannot see its files.
- The bot does not use Telegram’s native Scheduled Messages interface; Telegram does not let normal bots manage that interface. The bot’s own `/queue` is the schedule source of truth.
- Published-history removal is intended for deliberate reposting or testing. It does not delete existing public channel messages.
