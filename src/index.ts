import { extractXPost, FxEmbedError } from "./fxembed";

interface BotEnv extends Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  WEBHOOK_SETUP_SECRET: string;
  OWNER_TELEGRAM_USER_ID: string;
}

type TelegramUpdate = {
  update_id: number;
  message?: {
    from?: {
      id: number;
    };
    chat?: {
      id: number;
    };
    text?: string;
  };
  channel_post?: {
    chat?: {
      id: number;
      type?: string;
    };
    text?: string;
  };
  callback_query?: {
    id?: string;
    from?: { id?: number };
    data?: string;
  };
};

type QueuedWallpaper = {
  artist_handle: string | null;
  source_url: string;
  status: string;
  scheduled_for: string | null;
};

type ExistingWallpaper = {
  id: string;
  status: string;
  scheduled_for: string | null;
};

type ArchiveMedia = {
  id: string;
  source_position: number;
  original_url: string;
  filename: string;
  archive_file_id: string | null;
};

type ArchiveWallpaper = {
  archive_message_ids: string | null;
};

type WallpaperId = {
  id: string;
};

type OccupiedSlot = {
  scheduled_for: string;
};

type PreviewWallpaper = {
  id: string;
  artist_handle: string;
  source_url: string;
  scheduled_for: string;
};

type PreviewMedia = {
  preview_url: string;
};

type ControlWallpaper = {
  id: string;
  artist_handle: string | null;
  source_url: string;
  status: string;
  scheduled_for: string | null;
  archive_message_ids: string | null;
  published_photo_message_ids: string | null;
  published_document_message_ids: string | null;
  retry_count: number;
};

type PublishMedia = {
  preview_url: string;
  archive_file_id: string;
};

type TelegramInlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

type ClearableWallpaper = {
  id: string;
  archive_message_ids: string | null;
};

type XPostLink = {
  postId: string;
  canonicalUrl: string;
};

const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";
const TELEGRAM_SETUP_PATH = "/internal/register-webhook";
const ARCHIVE_SETUP_MARKER = "#wallpaperbot-archive-setup";
const PUBLIC_CHANNEL_SETUP_MARKER = "#wallpaperbot-public-setup";

export default {
  async fetch(request: Request, env: BotEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        service: "WallpaperBot",
        status: "foundation-ready",
      });
    }

    if (request.method === "POST" && url.pathname === TELEGRAM_WEBHOOK_PATH) {
      return handleTelegramWebhook(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === TELEGRAM_SETUP_PATH) {
      return registerTelegramWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
  async scheduled(_controller: ScheduledController, env: BotEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processDuePublications(env));
  },
} satisfies ExportedHandler<BotEnv>;

async function handleTelegramWebhook(
  request: Request,
  env: BotEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const verificationToken = request.headers.get(
    "X-Telegram-Bot-Api-Secret-Token",
  );

  if (verificationToken !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!isTelegramUpdate(update)) {
    return new Response("Invalid Telegram update", { status: 400 });
  }

  if (update.channel_post) {
    await handleChannelSetup(update, env);
    return new Response("OK");
  }

  if (update.callback_query) {
    await handleCallbackQuery(update, env, ctx);
    return new Response("OK");
  }

  await handleOwnerMessage(update, env, ctx);
  return new Response("OK");
}

async function registerTelegramWebhook(
  request: Request,
  env: BotEnv,
): Promise<Response> {
  if (request.headers.get("X-WallpaperBot-Setup-Secret") !== env.WEBHOOK_SETUP_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const webhookUrl = new URL(TELEGRAM_WEBHOOK_PATH, request.url).toString();
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "channel_post", "callback_query"],
      }),
    },
  );

  if (!response.ok) {
    console.error("Telegram rejected webhook registration", await response.text());
    return new Response("Telegram webhook registration failed", { status: 502 });
  }

  return Response.json({ status: "webhook-registered" });
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return (
    typeof value === "object" &&
    value !== null &&
    "update_id" in value &&
    typeof value.update_id === "number"
  );
}

async function handleOwnerMessage(
  update: TelegramUpdate,
  env: BotEnv,
  ctx: ExecutionContext,
): Promise<void> {
  const message = update.message;
  const senderId = message?.from?.id;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim();

  if (senderId === undefined || chatId === undefined || text === undefined) {
    return;
  }

  // This bot is personal-use only. Do not reveal its capabilities to other users.
  if (String(senderId) !== env.OWNER_TELEGRAM_USER_ID) {
    console.warn(`Ignored update ${update.update_id} from an unauthorized sender.`);
    return;
  }

  if (!(await claimTelegramUpdate(update.update_id, env))) {
    return;
  }

  if (text === "/start" || text === "/help") {
    await sendTelegramMessage(
      env,
      chatId,
      [
        "WallpaperBot is connected.",
        "",
        "Soon you will be able to send a public X (Twitter) image-post link here and the bot will queue it automatically.",
        "",
        "Commands available now:",
        "/start — show this message",
        "/help — show this message",
        "/queue — view the queue (coming next)",
      ].join("\n"),
    );
    return;
  }

  if (text === "/queue") {
    await sendTelegramMessage(env, chatId, await buildQueueMessage(env));
    return;
  }

  if (text === "/clearqueue") {
    await sendTelegramMessage(
      env,
      chatId,
      "Clear every wallpaper that is currently queued? This permanently deletes their private archive files. Published history is kept.",
      { inline_keyboard: [[
        { text: "Yes, clear the whole queue", callback_data: "q:clear" },
        { text: "Keep the queue", callback_data: "q:keep" },
      ]] },
    );
    return;
  }

  const xPost = parseXPostLink(text);
  if (xPost) {
    await sendTelegramMessage(env, chatId, await receiveXPost(xPost, env, chatId, ctx));
    return;
  }

  await sendTelegramMessage(
    env,
    chatId,
    "Send a direct public X (Twitter) post link containing images, or use /help.",
  );
}

async function handleChannelSetup(update: TelegramUpdate, env: BotEnv): Promise<void> {
  const channelPost = update.channel_post;
  const channelId = channelPost?.chat?.id;
  const marker = channelPost?.text?.trim();
  if (channelId === undefined) {
    return;
  }

  if (!(await claimTelegramUpdate(update.update_id, env))) {
    return;
  }

  if (marker === ARCHIVE_SETUP_MARKER) {
    await setBotSetting("archive_channel_id", String(channelId), env);
    await sendTelegramMessage(
      env,
      env.OWNER_TELEGRAM_USER_ID,
      "Private archive channel connected successfully.",
    );
    return;
  }

  if (marker === PUBLIC_CHANNEL_SETUP_MARKER) {
    await setBotSetting("public_channel_id", String(channelId), env);
    await sendTelegramMessage(
      env,
      env.OWNER_TELEGRAM_USER_ID,
      "Public wallpaper channel connected successfully. Nothing has been published.",
    );
  }
}

async function handleCallbackQuery(
  update: TelegramUpdate,
  env: BotEnv,
  ctx: ExecutionContext,
): Promise<void> {
  const callback = update.callback_query;
  const callbackId = callback?.id;
  const senderId = callback?.from?.id;
  const data = callback?.data;
  if (!callbackId || senderId === undefined || !data) return;

  if (String(senderId) !== env.OWNER_TELEGRAM_USER_ID) {
    await answerCallbackQuery(env, callbackId, "This control belongs to the bot owner.");
    return;
  }
  if (!(await claimTelegramUpdate(update.update_id, env))) return;

  if (data === "q:keep") {
    await answerCallbackQuery(env, callbackId, "Queue kept.");
    return;
  }
  if (data === "q:clear") {
    await answerCallbackQuery(env, callbackId, "Clearing queued wallpapers…");
    ctx.waitUntil(clearQueuedWallpapers(env));
    return;
  }

  const [action, wallpaperId, value] = data.split(":");
  if (!wallpaperId || !isWallpaperId(wallpaperId)) {
    await answerCallbackQuery(env, callbackId, "This control is no longer valid.");
    return;
  }

  if (action === "c") {
    await answerCallbackQuery(env, callbackId);
    await sendTelegramMessage(
      env,
      env.OWNER_TELEGRAM_USER_ID,
      "Cancel this wallpaper permanently? Its queue record and private archive files will be deleted.",
      { inline_keyboard: [[
        { text: "Yes, cancel permanently", callback_data: `x:${wallpaperId}` },
        { text: "Keep it", callback_data: `k:${wallpaperId}` },
      ]] },
    );
    return;
  }

  if (action === "k") {
    await answerCallbackQuery(env, callbackId, "Wallpaper kept.");
    return;
  }

  if (action === "x") {
    await answerCallbackQuery(env, callbackId, "Canceling wallpaper…");
    ctx.waitUntil(cancelWallpaper(wallpaperId, env));
    return;
  }

  if (action === "r") {
    if (value) {
      await answerCallbackQuery(env, callbackId, "Rescheduling wallpaper…");
      ctx.waitUntil(rescheduleWallpaper(wallpaperId, Number(value), env));
    } else {
      await answerCallbackQuery(env, callbackId);
      await sendRescheduleChoices(wallpaperId, env);
    }
    return;
  }

  if (action === "p") {
    await answerCallbackQuery(env, callbackId, "Publishing to the connected channel…");
    ctx.waitUntil(publishWallpaper(wallpaperId, env));
  }
}

function isWallpaperId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function claimTelegramUpdate(updateId: number, env: BotEnv): Promise<boolean> {
  const result = await env.WALLPAPERBOT_DB.prepare(
    "INSERT OR IGNORE INTO processed_telegram_updates (update_id) VALUES (?)",
  )
    .bind(updateId)
    .run();

  return result.meta.changes === 1;
}

async function setBotSetting(
  key: string,
  value: string,
  env: BotEnv,
): Promise<void> {
  await env.WALLPAPERBOT_DB.prepare(
    `INSERT INTO bot_settings (setting_key, setting_value)
     VALUES (?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET
       setting_value = excluded.setting_value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(key, value)
    .run();
}

async function buildQueueMessage(env: BotEnv): Promise<string> {
  await assignSlotsForArchivedWallpapers(env);
  await sendMissingPreviews(env);
  const result = await env.WALLPAPERBOT_DB.prepare(
    `SELECT artist_handle, source_url, status, scheduled_for
     FROM wallpapers
     WHERE status IN ('extracting', 'scheduled', 'publishing', 'failed')
     ORDER BY scheduled_for IS NULL, scheduled_for, created_at
     LIMIT 10`,
  ).all<QueuedWallpaper>();

  if (result.results.length === 0) {
    return "Your wallpaper queue is empty.";
  }

  const entries = result.results.map((wallpaper, index) => {
    const artist = wallpaper.artist_handle ?? "Unknown artist";
    const state =
      wallpaper.status === "scheduled" && !wallpaper.scheduled_for
        ? "Ready — waiting for a slot"
        : wallpaper.scheduled_for
          ? `${formatTehranTime(wallpaper.scheduled_for)} (${wallpaper.status})`
          : "Awaiting extraction";
    return `${index + 1}. ${artist} — ${state}`;
  });

  return ["Wallpaper queue", "", ...entries].join("\n");
}

function formatTehranTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran",
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  }).format(new Date(value));
}

function parseXPostLink(text: string): XPostLink | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") {
    return null;
  }

  const supportedHosts = new Set([
    "x.com",
    "www.x.com",
    "mobile.x.com",
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com",
  ]);
  if (!supportedHosts.has(url.hostname.toLowerCase())) {
    return null;
  }

  const match = url.pathname.match(/(?:^|\/)status\/(\d+)(?:\/|$)/);
  if (!match) {
    return null;
  }

  return {
    postId: match[1],
    canonicalUrl: `https://x.com${url.pathname.replace(/\/$/, "")}`,
  };
}

async function receiveXPost(
  xPost: XPostLink,
  env: BotEnv,
  chatId: number,
  ctx: ExecutionContext,
): Promise<string> {
  const existing = await env.WALLPAPERBOT_DB.prepare(
    "SELECT id, status, scheduled_for FROM wallpapers WHERE x_post_id = ?",
  )
    .bind(xPost.postId)
    .first<ExistingWallpaper>();

  if (existing) {
    if (existing.status === "failed") {
      await env.WALLPAPERBOT_DB.batch([
        env.WALLPAPERBOT_DB.prepare(
          `UPDATE wallpapers
           SET status = 'extracting', retry_count = 0, next_retry_at = NULL,
               last_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        ).bind(existing.id),
        env.WALLPAPERBOT_DB.prepare(
          "INSERT INTO wallpaper_events (wallpaper_id, event_type) VALUES (?, 'retry_requested')",
        ).bind(existing.id),
      ]);
      ctx.waitUntil(recoverExistingExtraction(existing.id, xPost.postId, chatId, env));
      return "That post previously failed. Its extraction retry cycle has been restarted.";
    }

    if (existing.status === "extracting") {
      ctx.waitUntil(recoverExistingExtraction(existing.id, xPost.postId, chatId, env));
    }

    const schedule = existing.scheduled_for
      ? ` It is scheduled for ${formatTehranTime(existing.scheduled_for)}.`
      : " It is already being processed.";
    return `That X post is already known to the bot.${schedule}`;
  }

  const wallpaperId = crypto.randomUUID();
  await env.WALLPAPERBOT_DB.batch([
    env.WALLPAPERBOT_DB.prepare(
      `INSERT INTO wallpapers (id, x_post_id, source_url, status)
       VALUES (?, ?, ?, 'extracting')`,
    ).bind(wallpaperId, xPost.postId, xPost.canonicalUrl),
    env.WALLPAPERBOT_DB.prepare(
      "INSERT INTO wallpaper_events (wallpaper_id, event_type) VALUES (?, 'submitted')",
    ).bind(wallpaperId),
  ]);

  ctx.waitUntil(extractAndStoreMetadata(wallpaperId, xPost.postId, chatId, env));

  return [
    "X post accepted.",
    "",
    "I’m checking its media now. A schedule slot will be assigned only after every image has been safely archived.",
  ].join("\n");
}

async function extractAndStoreMetadata(
  wallpaperId: string,
  postId: string,
  chatId: number,
  env: BotEnv,
): Promise<void> {
  try {
    const extracted = await extractXPost(postId, env.FXEMBED_API_BASE_URL);
    const filenameNumber = await allocateFilenameNumber(extracted.artistHandle, env);
    const mediaStatements = extracted.images.map((image, position) => {
      const filename = buildFilename(
        extracted.artistHandle,
        filenameNumber,
        position,
        extracted.images.length,
        image.originalUrl,
      );
      return env.WALLPAPERBOT_DB.prepare(
        `INSERT INTO media (
          id, wallpaper_id, source_position, original_url, preview_url, filename
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        wallpaperId,
        position,
        image.originalUrl,
        image.originalUrl,
        filename,
      );
    });

    await env.WALLPAPERBOT_DB.batch([
      env.WALLPAPERBOT_DB.prepare(
        `UPDATE wallpapers
         SET artist_handle = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      ).bind(extracted.artistHandle, wallpaperId),
      ...mediaStatements,
      env.WALLPAPERBOT_DB.prepare(
        "INSERT INTO wallpaper_events (wallpaper_id, event_type, details_json) VALUES (?, 'metadata_extracted', ?)",
      ).bind(wallpaperId, JSON.stringify({ imageCount: extracted.images.length })),
    ]);

    await archiveExtractedWallpaper(wallpaperId, chatId, env);
    await sendTelegramMessage(
      env,
      chatId,
      `Archived ${extracted.images.length} original image(s) by ${extracted.artistHandle}. No publication slot has been reserved yet.`,
    );
  } catch (error) {
    const extractionError =
      error instanceof FxEmbedError
        ? error
        : new FxEmbedError("An unexpected extraction error occurred.", true);
    await recordExtractionFailure(wallpaperId, extractionError, env);
    await sendTelegramMessage(env, chatId, `Could not process this X post: ${extractionError.message}`);
  }
}

async function recoverExistingExtraction(
  wallpaperId: string,
  postId: string,
  chatId: number,
  env: BotEnv,
): Promise<void> {
  const mediaCount = await env.WALLPAPERBOT_DB.prepare(
    "SELECT COUNT(*) AS count FROM media WHERE wallpaper_id = ?",
  )
    .bind(wallpaperId)
    .first<{ count: number }>();

  if ((mediaCount?.count ?? 0) === 0) {
    await extractAndStoreMetadata(wallpaperId, postId, chatId, env);
    return;
  }

  try {
    await archiveExtractedWallpaper(wallpaperId, chatId, env);
    await sendTelegramMessage(env, chatId, "The missing archive uploads have been recovered.");
  } catch (error) {
    const archiveError = toArchiveError(error);
    await recordExtractionFailure(wallpaperId, archiveError, env);
    await sendTelegramMessage(env, chatId, `Could not archive this X post: ${archiveError.message}`);
  }
}

async function archiveExtractedWallpaper(
  wallpaperId: string,
  chatId: number,
  env: BotEnv,
): Promise<void> {
  const archiveChannelId = await getBotSetting("archive_channel_id", env);
  if (!archiveChannelId) {
    throw new FxEmbedError("The private archive channel has not been connected.", false);
  }

  const [mediaResult, wallpaper] = await Promise.all([
    env.WALLPAPERBOT_DB.prepare(
      `SELECT id, source_position, original_url, filename, archive_file_id
       FROM media WHERE wallpaper_id = ? ORDER BY source_position`,
    )
      .bind(wallpaperId)
      .all<ArchiveMedia>(),
    env.WALLPAPERBOT_DB.prepare(
      "SELECT archive_message_ids FROM wallpapers WHERE id = ?",
    )
      .bind(wallpaperId)
      .first<ArchiveWallpaper>(),
  ]);

  const messageIds = parseMessageIds(wallpaper?.archive_message_ids);
  for (const media of mediaResult.results) {
    if (media.archive_file_id) {
      continue;
    }

    const archived = await uploadOriginalToTelegramArchive(
      env,
      archiveChannelId,
      media.original_url,
      media.filename,
    );
    messageIds.push(archived.messageId);
    await env.WALLPAPERBOT_DB.batch([
      env.WALLPAPERBOT_DB.prepare(
        "UPDATE media SET archive_file_id = ? WHERE id = ?",
      ).bind(archived.fileId, media.id),
      env.WALLPAPERBOT_DB.prepare(
        `UPDATE wallpapers
         SET archive_message_ids = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      ).bind(JSON.stringify(messageIds), wallpaperId),
    ]);
  }

  await env.WALLPAPERBOT_DB.prepare(
    `UPDATE wallpapers
     SET status = 'scheduled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  )
    .bind(wallpaperId)
    .run();

  await env.WALLPAPERBOT_DB.prepare(
    "INSERT INTO wallpaper_events (wallpaper_id, event_type) VALUES (?, 'archived')",
  )
    .bind(wallpaperId)
    .run();

  await assignNextAvailableSlot(wallpaperId, env);
}

async function assignSlotsForArchivedWallpapers(env: BotEnv): Promise<void> {
  const ready = await env.WALLPAPERBOT_DB.prepare(
    `SELECT id FROM wallpapers
     WHERE status = 'scheduled' AND scheduled_for IS NULL
       AND EXISTS (SELECT 1 FROM media WHERE media.wallpaper_id = wallpapers.id)
       AND NOT EXISTS (
         SELECT 1 FROM media
         WHERE media.wallpaper_id = wallpapers.id AND media.archive_file_id IS NULL
       )
     ORDER BY created_at`,
  ).all<WallpaperId>();

  for (const wallpaper of ready.results) {
    await assignNextAvailableSlot(wallpaper.id, env);
  }
}

async function assignNextAvailableSlot(
  wallpaperId: string,
  env: BotEnv,
): Promise<string | null> {
  const occupiedResult = await env.WALLPAPERBOT_DB.prepare(
    `SELECT scheduled_for FROM wallpapers
     WHERE status IN ('scheduled', 'publishing') AND scheduled_for IS NOT NULL`,
  ).all<OccupiedSlot>();
  const occupied = new Set(occupiedResult.results.map((wallpaper) => wallpaper.scheduled_for));

  for (const candidate of futureTehranSlots(new Date())) {
    const value = candidate.toISOString();
    if (occupied.has(value)) {
      continue;
    }

    try {
      const result = await env.WALLPAPERBOT_DB.prepare(
        `UPDATE wallpapers
         SET scheduled_for = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND scheduled_for IS NULL`,
      )
        .bind(value, wallpaperId)
        .run();
      if (result.meta.changes !== 1) {
        return null;
      }

      await env.WALLPAPERBOT_DB.prepare(
        "INSERT INTO wallpaper_events (wallpaper_id, event_type, details_json) VALUES (?, 'slot_assigned', ?)",
      )
        .bind(wallpaperId, JSON.stringify({ scheduledFor: value }))
        .run();
      await sendScheduledPreview(wallpaperId, env);
      return value;
    } catch {
      // The unique D1 index wins a rare simultaneous assignment race.
      occupied.add(value);
    }
  }

  return null;
}

async function sendMissingPreviews(env: BotEnv): Promise<void> {
  const missing = await env.WALLPAPERBOT_DB.prepare(
    `SELECT w.id FROM wallpapers w
     WHERE w.status = 'scheduled' AND w.scheduled_for IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM wallpaper_events e
         WHERE e.wallpaper_id = w.id AND e.event_type = 'preview_sent'
       )`,
  ).all<WallpaperId>();
  for (const wallpaper of missing.results) {
    await sendScheduledPreview(wallpaper.id, env);
  }
}

async function sendScheduledPreview(wallpaperId: string, env: BotEnv): Promise<void> {
  const alreadySent = await env.WALLPAPERBOT_DB.prepare(
    "SELECT id FROM wallpaper_events WHERE wallpaper_id = ? AND event_type = 'preview_sent' LIMIT 1",
  )
    .bind(wallpaperId)
    .first<{ id: number }>();
  if (alreadySent) return;

  const wallpaper = await env.WALLPAPERBOT_DB.prepare(
    `SELECT id, artist_handle, source_url, scheduled_for FROM wallpapers
     WHERE id = ? AND artist_handle IS NOT NULL AND scheduled_for IS NOT NULL`,
  )
    .bind(wallpaperId)
    .first<PreviewWallpaper>();
  if (!wallpaper) return;

  const media = await env.WALLPAPERBOT_DB.prepare(
    "SELECT preview_url FROM media WHERE wallpaper_id = ? ORDER BY source_position",
  )
    .bind(wallpaperId)
    .all<PreviewMedia>();
  const caption = buildChannelCaption(wallpaper.artist_handle, wallpaper.source_url);

  let visualSent = false;
  try {
    await sendPreviewImages(env, media.results.map((item) => item.preview_url), caption);
    visualSent = true;
  } catch (error) {
    console.error("Visual preview could not be sent", error);
  }

  const text = [
    "Wallpaper preview",
    `Scheduled: ${formatTehranTime(wallpaper.scheduled_for)} Tehran time`,
    `Images: ${media.results.length}`,
    "",
    "The visual preview and exact channel caption are shown above.",
  ].join("\n");
  const sent = await sendTelegramMessage(
    env,
    env.OWNER_TELEGRAM_USER_ID,
    text,
    previewControls(wallpaper.id),
  );
  if (sent && visualSent) {
    await env.WALLPAPERBOT_DB.prepare(
      "INSERT INTO wallpaper_events (wallpaper_id, event_type) VALUES (?, 'preview_sent')",
    )
      .bind(wallpaperId)
      .run();
  }
}

function previewControls(wallpaperId: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "Publish now", callback_data: `p:${wallpaperId}` },
        { text: "Reschedule", callback_data: `r:${wallpaperId}` },
      ],
      [{ text: "Cancel", callback_data: `c:${wallpaperId}` }],
    ],
  };
}

function buildChannelCaption(artistHandle: string, sourceUrl: string): string {
  const safeArtist = escapeHtml(artistHandle);
  const safeSource = escapeHtml(sourceUrl);
  return [
    `Artist: <a href="https://x.com/${safeArtist}">${safeArtist}</a>`,
    "Wallpaper Source: X (Twitter)",
    `Link: ${safeSource}`,
    "",
    "@LycoRyco_Wallpapers",
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

async function sendPreviewImages(env: BotEnv, urls: string[], caption: string): Promise<void> {
  if (urls.length === 0) return;
  const previewUrls = urls.map((value) => {
    const url = new URL(value);
    url.searchParams.set("name", "large");
    return url.toString();
  });
  const endpoint = previewUrls.length === 1 ? "sendPhoto" : "sendMediaGroup";
  const body = previewUrls.length === 1
    ? { chat_id: env.OWNER_TELEGRAM_USER_ID, photo: previewUrls[0], caption, parse_mode: "HTML" }
    : {
      chat_id: env.OWNER_TELEGRAM_USER_ID,
      media: previewUrls.map((url, index) => ({
        type: "photo", media: url,
        ...(index === 0 ? { caption, parse_mode: "HTML" } : {}),
      })),
    };
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { ok?: boolean; description?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description || `Telegram ${endpoint} failed`);
  }
}

function futureTehranSlots(now: Date): Date[] {
  const earliest = new Date(now.getTime() + 15 * 60 * 1000);
  const today = tehranDateParts(now);
  const slots: Date[] = [];

  for (let dayOffset = 0; dayOffset < 22; dayOffset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
    for (const hour of [9, 10, 11]) {
      const slot = tehranLocalTimeToUtc(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        hour,
        0,
      );
      if (slot.getTime() >= earliest.getTime()) {
        slots.push(slot);
      }
    }
  }
  return slots;
}

function tehranLocalTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const targetMilliseconds = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = targetMilliseconds;

  // Iteration accounts for the IANA timezone offset instead of assuming a
  // fixed UTC offset for Tehran.
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const observed = tehranDateParts(new Date(timestamp));
    const observedMilliseconds = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
    );
    timestamp += targetMilliseconds - observedMilliseconds;
  }
  return new Date(timestamp);
}

function tehranDateParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

async function getBotSetting(key: string, env: BotEnv): Promise<string | null> {
  const setting = await env.WALLPAPERBOT_DB.prepare(
    "SELECT setting_value FROM bot_settings WHERE setting_key = ?",
  )
    .bind(key)
    .first<{ setting_value: string }>();
  return setting?.setting_value ?? null;
}

function parseMessageIds(value: string | null | undefined): number[] {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

async function uploadOriginalToTelegramArchive(
  env: BotEnv,
  archiveChannelId: string,
  sourceUrl: string,
  filename: string,
): Promise<{ fileId: string; messageId: number }> {
  const source = await fetch(sourceUrl, {
    headers: { "user-agent": "WallpaperBot/0.1 (personal Telegram bot)" },
  });
  if (!source.ok || !source.body) {
    throw new FxEmbedError("The original image could not be downloaded from X.", true);
  }

  const contentLength = Number(source.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 50 * 1024 * 1024) {
    throw new FxEmbedError("The original image is larger than Telegram's 50 MB bot limit.", false);
  }

  const boundary = `WallpaperBot${crypto.randomUUID().replaceAll("-", "")}`;
  const contentType = source.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
  const body = createMultipartStream(
    boundary,
    archiveChannelId,
    source.body,
    filename,
    contentType,
  );
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
    {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    },
  );
  const payload = (await response.json()) as {
    ok?: boolean;
    result?: { message_id?: number; document?: { file_id?: string } };
    description?: string;
  };
  const fileId = payload.result?.document?.file_id;
  const messageId = payload.result?.message_id;
  if (!response.ok || !payload.ok || !fileId || messageId === undefined) {
    throw new FxEmbedError(
      payload.description || "Telegram could not archive the original image.",
      response.status >= 500 || response.status === 429,
    );
  }
  return { fileId, messageId };
}

function createMultipartStream(
  boundary: string,
  chatId: string,
  source: ReadableStream<Uint8Array>,
  filename: string,
  contentType: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const safeFilename = filename.replaceAll('"', "_");
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="disable_notification"\r\n\r\ntrue\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${safeFilename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const reader = source.getReader();
  let phase = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (phase === 0) {
        phase = 1;
        controller.enqueue(prefix);
        return;
      }
      if (phase === 1) {
        const next = await reader.read();
        if (!next.done) {
          controller.enqueue(next.value);
          return;
        }
        phase = 2;
      }
      if (phase === 2) {
        phase = 3;
        controller.enqueue(suffix);
        controller.close();
      }
    },
    async cancel() {
      await reader.cancel();
    },
  });
}

function toArchiveError(error: unknown): FxEmbedError {
  return error instanceof FxEmbedError
    ? error
    : new FxEmbedError("An unexpected archive error occurred.", true);
}

async function allocateFilenameNumber(artistHandle: string, env: BotEnv): Promise<number> {
  const result = await env.WALLPAPERBOT_DB.prepare(
    `INSERT INTO artist_counters (artist_handle, next_filename_number)
     VALUES (?, 2)
     ON CONFLICT(artist_handle) DO UPDATE SET
       next_filename_number = artist_counters.next_filename_number + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     RETURNING next_filename_number - 1 AS filename_number`,
  )
    .bind(artistHandle)
    .first<{ filename_number: number }>();

  if (!result) {
    throw new Error("Could not allocate a filename number.");
  }
  return result.filename_number;
}

function buildFilename(
  artistHandle: string,
  number: number,
  position: number,
  imageCount: number,
  sourceUrl: string,
): string {
  const extension = new URL(sourceUrl).pathname.match(/\.(jpe?g|png|webp)$/i)?.[1]?.toLowerCase() ?? "jpg";
  const base = `${artistHandle}_Twitter${String(number).padStart(3, "0")}`;
  return imageCount === 1
    ? `${base}.${extension}`
    : `${base}_${String(position + 1).padStart(2, "0")}.${extension}`;
}

async function recordExtractionFailure(
  wallpaperId: string,
  error: FxEmbedError,
  env: BotEnv,
): Promise<void> {
  const nextRetrySql = error.retryable
    ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 minutes')"
    : "NULL";
  await env.WALLPAPERBOT_DB.batch([
    env.WALLPAPERBOT_DB.prepare(
      `UPDATE wallpapers
       SET status = 'failed', last_error = ?, next_retry_at = ${nextRetrySql},
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    ).bind(error.message, wallpaperId),
    env.WALLPAPERBOT_DB.prepare(
      "INSERT INTO wallpaper_events (wallpaper_id, event_type, details_json) VALUES (?, 'extraction_failed', ?)",
    ).bind(wallpaperId, JSON.stringify({ retryable: error.retryable, message: error.message })),
  ]);
}

async function sendRescheduleChoices(wallpaperId: string, env: BotEnv): Promise<void> {
  const wallpaper = await getControlWallpaper(wallpaperId, env);
  if (!wallpaper || wallpaper.status !== "scheduled") {
    await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, "That wallpaper is no longer available to reschedule.");
    return;
  }

  const slots = await availableFutureSlots(wallpaperId, env);
  if (slots.length === 0) {
    await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, "There are no free future slots available yet.");
    return;
  }

  await sendTelegramMessage(
    env,
    env.OWNER_TELEGRAM_USER_ID,
    "Choose a new Tehran-time publication slot:",
    {
      inline_keyboard: slots.slice(0, 6).map((slot) => [{
        text: formatTehranTime(slot.toISOString()),
        callback_data: `r:${wallpaperId}:${slot.getTime()}`,
      }]),
    },
  );
}

async function availableFutureSlots(wallpaperId: string, env: BotEnv): Promise<Date[]> {
  const occupiedResult = await env.WALLPAPERBOT_DB.prepare(
    `SELECT scheduled_for FROM wallpapers
     WHERE id != ? AND status IN ('scheduled', 'publishing') AND scheduled_for IS NOT NULL`,
  )
    .bind(wallpaperId)
    .all<OccupiedSlot>();
  const occupied = new Set(occupiedResult.results.map((wallpaper) => wallpaper.scheduled_for));
  return futureTehranSlots(new Date()).filter((slot) => !occupied.has(slot.toISOString()));
}

async function rescheduleWallpaper(
  wallpaperId: string,
  milliseconds: number,
  env: BotEnv,
): Promise<void> {
  const slot = new Date(milliseconds);
  const validSlot = Number.isFinite(slot.getTime()) && (await availableFutureSlots(wallpaperId, env))
    .some((candidate) => candidate.getTime() === slot.getTime());
  if (!validSlot) {
    await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, "That time slot is no longer available. Choose Reschedule again.");
    return;
  }

  const scheduledFor = slot.toISOString();
  const result = await env.WALLPAPERBOT_DB.prepare(
    `UPDATE wallpapers
     SET scheduled_for = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND status = 'scheduled'`,
  )
    .bind(scheduledFor, wallpaperId)
    .run();
  if (result.meta.changes !== 1) {
    await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, "That wallpaper can no longer be rescheduled.");
    return;
  }

  await env.WALLPAPERBOT_DB.prepare(
    "INSERT INTO wallpaper_events (wallpaper_id, event_type, details_json) VALUES (?, 'rescheduled', ?)",
  )
    .bind(wallpaperId, JSON.stringify({ scheduledFor }))
    .run();
  await sendTelegramMessage(
    env,
    env.OWNER_TELEGRAM_USER_ID,
    `Rescheduled for ${formatTehranTime(scheduledFor)} Tehran time.`,
  );
}

async function cancelWallpaper(wallpaperId: string, env: BotEnv): Promise<void> {
  const wallpaper = await getControlWallpaper(wallpaperId, env);
  const archiveChannelId = await getBotSetting("archive_channel_id", env);
  if (!wallpaper || wallpaper.status !== "scheduled" || !archiveChannelId) {
    await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, "That wallpaper can no longer be canceled.");
    return;
  }

  const messageIds = parseMessageIds(wallpaper.archive_message_ids);
  for (const messageId of messageIds) {
    await telegramApi(env, "deleteMessage", { chat_id: archiveChannelId, message_id: messageId });
  }
  await env.WALLPAPERBOT_DB.batch([
    env.WALLPAPERBOT_DB.prepare("DELETE FROM wallpaper_events WHERE wallpaper_id = ?").bind(wallpaperId),
    env.WALLPAPERBOT_DB.prepare("DELETE FROM media WHERE wallpaper_id = ?").bind(wallpaperId),
    env.WALLPAPERBOT_DB.prepare("DELETE FROM wallpapers WHERE id = ?").bind(wallpaperId),
  ]);
  await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, "Wallpaper canceled and its private archive files were deleted.");
}

async function clearQueuedWallpapers(env: BotEnv): Promise<void> {
  try {
    const archiveChannelId = await getBotSetting("archive_channel_id", env);
    const queued = await env.WALLPAPERBOT_DB.prepare(
      `SELECT id, archive_message_ids FROM wallpapers
       WHERE status IN ('extracting', 'scheduled', 'publishing', 'failed')`,
    ).all<ClearableWallpaper>();

    if (queued.results.length === 0) {
      await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, "Your queue is already empty.");
      return;
    }

    if (archiveChannelId) {
      for (const wallpaper of queued.results) {
        for (const messageId of parseMessageIds(wallpaper.archive_message_ids)) {
          await telegramApi(env, "deleteMessage", { chat_id: archiveChannelId, message_id: messageId });
        }
      }
    }

    for (const wallpaper of queued.results) {
      await env.WALLPAPERBOT_DB.batch([
        env.WALLPAPERBOT_DB.prepare("DELETE FROM wallpaper_events WHERE wallpaper_id = ?").bind(wallpaper.id),
        env.WALLPAPERBOT_DB.prepare("DELETE FROM media WHERE wallpaper_id = ?").bind(wallpaper.id),
        env.WALLPAPERBOT_DB.prepare("DELETE FROM wallpapers WHERE id = ?").bind(wallpaper.id),
      ]);
    }
    await sendTelegramMessage(
      env,
      env.OWNER_TELEGRAM_USER_ID,
      `Cleared ${queued.results.length} queued wallpaper(s) and their private archive files.`,
    );
  } catch (error) {
    console.error("Queue clearing failed", error);
    await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, "The queue could not be fully cleared. Nothing else was deleted automatically.");
  }
}

async function processDuePublications(env: BotEnv): Promise<void> {
  const now = new Date().toISOString();
  const due = await env.WALLPAPERBOT_DB.prepare(
    `SELECT id FROM wallpapers
     WHERE status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= ?
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY scheduled_for
     LIMIT 5`,
  )
    .bind(now, now)
    .all<WallpaperId>();

  for (const wallpaper of due.results) {
    await publishWallpaper(wallpaper.id, env, true);
  }
}

async function publishWallpaper(
  wallpaperId: string,
  env: BotEnv,
  automatic = false,
): Promise<void> {
  const publicChannelId = await getBotSetting("public_channel_id", env);
  if (!publicChannelId) {
    await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, "No public wallpaper channel is connected yet.");
    return;
  }

  const locked = await env.WALLPAPERBOT_DB.prepare(
    `UPDATE wallpapers SET status = 'publishing', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND status = 'scheduled'`,
  )
    .bind(wallpaperId)
    .run();
  if (locked.meta.changes !== 1) {
    await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, "That wallpaper is already being published or is no longer available.");
    return;
  }

  let attemptNumber = 1;
  try {
    const wallpaper = await getControlWallpaper(wallpaperId, env);
    const media = await env.WALLPAPERBOT_DB.prepare(
      "SELECT preview_url, archive_file_id FROM media WHERE wallpaper_id = ? ORDER BY source_position",
    )
      .bind(wallpaperId)
      .all<PublishMedia>();
    if (!wallpaper?.artist_handle || media.results.length === 0 || media.results.some((item) => !item.archive_file_id)) {
      throw new Error("The archived media for this wallpaper is incomplete.");
    }
    attemptNumber = wallpaper.retry_count + 1;

    let photoIds = parseMessageIds(wallpaper.published_photo_message_ids);
    if (photoIds.length === 0) {
      photoIds = await sendPublicPhotos(env, publicChannelId, media.results.map((item) => item.preview_url), buildChannelCaption(wallpaper.artist_handle, wallpaper.source_url));
      await env.WALLPAPERBOT_DB.prepare(
        "UPDATE wallpapers SET published_photo_message_ids = ? WHERE id = ?",
      ).bind(JSON.stringify(photoIds), wallpaperId).run();
    }

    let documentIds = parseMessageIds(wallpaper.published_document_message_ids);
    for (let index = documentIds.length; index < media.results.length; index += 1) {
      const result = await telegramApi(env, "sendDocument", {
        chat_id: publicChannelId,
        document: media.results[index].archive_file_id,
        disable_notification: true,
      }) as { message_id?: number };
      if (result.message_id === undefined) throw new Error("Telegram did not return a document message ID.");
      documentIds.push(result.message_id);
      await env.WALLPAPERBOT_DB.prepare(
        "UPDATE wallpapers SET published_document_message_ids = ? WHERE id = ?",
      ).bind(JSON.stringify(documentIds), wallpaperId).run();
    }

    await env.WALLPAPERBOT_DB.batch([
      env.WALLPAPERBOT_DB.prepare(
        "UPDATE wallpapers SET status = 'published', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      ).bind(wallpaperId),
      env.WALLPAPERBOT_DB.prepare(
        "INSERT INTO wallpaper_events (wallpaper_id, event_type) VALUES (?, 'published')",
      ).bind(wallpaperId),
    ]);
    await sendTelegramMessage(
      env,
      env.OWNER_TELEGRAM_USER_ID,
      automatic
        ? "Scheduled wallpaper published successfully to the connected channel."
        : "Wallpaper published successfully to the connected test channel.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "An unexpected publication error occurred.";
    const retryAt = attemptNumber < 3;
    await env.WALLPAPERBOT_DB.prepare(
      `UPDATE wallpapers
       SET status = ?, retry_count = ?, next_retry_at = ?, last_error = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).bind(
      retryAt ? "scheduled" : "failed",
      attemptNumber,
      retryAt ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null,
      message,
      wallpaperId,
    ).run();
    await sendTelegramMessage(
      env,
      env.OWNER_TELEGRAM_USER_ID,
      retryAt
        ? `Could not publish this wallpaper. I will retry in 30 minutes (attempt ${attemptNumber} of 3): ${message}`
        : `Could not publish this wallpaper after 3 attempts: ${message}`,
    );
  }
}

async function getControlWallpaper(wallpaperId: string, env: BotEnv): Promise<ControlWallpaper | null> {
  return env.WALLPAPERBOT_DB.prepare(
    `SELECT id, artist_handle, source_url, status, scheduled_for, archive_message_ids,
            published_photo_message_ids, published_document_message_ids, retry_count
     FROM wallpapers WHERE id = ?`,
  )
    .bind(wallpaperId)
    .first<ControlWallpaper>();
}

async function sendPublicPhotos(
  env: BotEnv,
  channelId: string,
  urls: string[],
  caption: string,
): Promise<number[]> {
  const previewUrls = urls.map((value) => {
    const url = new URL(value);
    url.searchParams.set("name", "large");
    return url.toString();
  });
  const method = previewUrls.length === 1 ? "sendPhoto" : "sendMediaGroup";
  const result = await telegramApi(env, method, previewUrls.length === 1
    ? { chat_id: channelId, photo: previewUrls[0], caption, parse_mode: "HTML", disable_notification: true }
    : {
      chat_id: channelId,
      disable_notification: true,
      media: previewUrls.map((url, index) => ({
        type: "photo", media: url,
        ...(index === 0 ? { caption, parse_mode: "HTML" } : {}),
      })),
    });
  const messages = Array.isArray(result) ? result : [result];
  const ids = messages.map((message) => (message as { message_id?: number }).message_id);
  if (ids.some((id) => id === undefined)) throw new Error("Telegram did not return photo message IDs.");
  return ids as number[];
}

async function sendTelegramMessage(
  env: BotEnv,
  chatId: number | string,
  text: string,
  replyMarkup?: TelegramInlineKeyboard,
): Promise<boolean> {
  try {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return true;
  } catch (error) {
    console.error("Telegram sendMessage failed", error);
    return false;
  }
}

async function answerCallbackQuery(env: BotEnv, callbackQueryId: string, text?: string): Promise<void> {
  try {
    await telegramApi(env, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  } catch (error) {
    console.error("Telegram callback acknowledgement failed", error);
  }
}

async function telegramApi(
  env: BotEnv,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { ok?: boolean; result?: unknown; description?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description || `Telegram ${method} failed`);
  }
  return payload.result;
}
