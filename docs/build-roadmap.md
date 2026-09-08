# Beginner-friendly build roadmap

This is the order we will follow. Each stage ends with a small test before moving to the next one.

## Stage 1 — Project foundation

**Purpose:** Create a clean repository and choose the development tools.

Completed:

- Public GitHub repository connected.
- README, safe configuration template, and Git ignore rules added.
- Architecture decision record added.
- TypeScript Cloudflare Worker foundation created.
- Local Worker health check tested successfully.

Available local commands:

- `npm run dev` — starts a local-only Worker for development.
- `npm run typecheck` — checks TypeScript for mistakes.
- `npm run deploy` — deploys only after Cloudflare has been configured.

## Stage 2 — Telegram and Cloudflare accounts

**Purpose:** Create the services the code will use.

You will be guided through:

1. Creating the Telegram bot with BotFather.
2. Creating the private `WallpaperBot Archive` channel.
3. Adding the bot as an administrator in the archive channel and public wallpaper channel.
4. Creating a free Cloudflare account, if needed.
5. Creating a D1 database and Worker project.
6. Saving private values as Cloudflare secrets rather than GitHub files.

No token will ever be pasted into source code or committed to Git.

Completed:

- Cloudflare Worker deployed at the project's `workers.dev` address.
- Free D1 database created and bound to the Worker.
- Telegram bot token stored as an encrypted Cloudflare secret.
- Telegram webhook registered with request verification enabled.

## Stage 3 — Basic secure bot

**Purpose:** Confirm that Telegram can reach the Worker safely.

The first working bot will:

- answer `/start` and `/help` for the owner;
- reject everyone else;
- accept an X URL but only acknowledge it initially;
- expose `/queue` as an empty queue.

Test: send `/start` to the bot and confirm only your account receives a response.

## Stage 4 — Database and queue

**Purpose:** Give the bot permanent memory.

We will add:

- database migrations;
- X post duplicate checks;
- queue statuses;
- Tehran schedule-slot selection;
- `/queue` output.

Test: submit example entries and verify slot selection, duplicate handling, and rescheduling.

## Stage 5 — X image extraction and archive

**Purpose:** Turn a real X post into safely stored images.

We will add:

- FxEmbed extractor client;
- image-only validation;
- media order preservation;
- stable filenames;
- sending originals to the private archive channel;
- retry handling.

Test: submit a public multi-image X post and confirm the private archive contains the same images in the same order.

## Stage 6 — Preview and controls

**Purpose:** Let you check a wallpaper at a glance and intervene only when needed.

We will add:

- private preview messages;
- Cancel, Reschedule, and Publish now buttons;
- safe button validation;
- permanent discard of canceled archive files.

Test: use all three buttons on test wallpapers without publishing unintended posts.

## Stage 7 — Automatic publication

**Purpose:** Publish the complete channel format automatically.

We will add:

- Cloudflare Cron trigger;
- Tehran-time due-slot check;
- visual album posting;
- following document album posting;
- exact caption formatting;
- safe publication retry/error notification.

Test: temporarily use a near-future test slot and confirm the public channel receives the visual album followed by the documents.

## Stage 8 — Final hardening

**Purpose:** Make personal daily use dependable.

We will verify:

- failure messages are understandable;
- no source URL or Telegram file is unintentionally exposed;
- no bot secret exists in Git history;
- large-image behavior works as documented;
- deployment instructions can be repeated from scratch.

## What you will need from your side

At the relevant stages, you will only need to provide or do these things:

- a Telegram bot token, entered directly into Cloudflare as a secret;
- your Telegram numeric user ID;
- the private archive and public channel IDs;
- access to your Cloudflare account;
- a few public X image post links for testing.

I will explain where each value comes from at the moment it is needed.
