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

type XPostLink = {
  postId: string;
  canonicalUrl: string;
};

const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";
const TELEGRAM_SETUP_PATH = "/internal/register-webhook";

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
        allowed_updates: ["message", "callback_query"],
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

async function claimTelegramUpdate(updateId: number, env: BotEnv): Promise<boolean> {
  const result = await env.WALLPAPERBOT_DB.prepare(
    "INSERT OR IGNORE INTO processed_telegram_updates (update_id) VALUES (?)",
  )
    .bind(updateId)
    .run();

  return result.meta.changes === 1;
}

async function buildQueueMessage(env: BotEnv): Promise<string> {
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
    const when = wallpaper.scheduled_for
      ? formatTehranTime(wallpaper.scheduled_for)
      : "Awaiting extraction";
    return `${index + 1}. ${artist} — ${when} (${wallpaper.status})`;
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
      ctx.waitUntil(extractAndStoreMetadata(existing.id, xPost.postId, chatId, env));
      return "That post previously failed. Its extraction retry cycle has been restarted.";
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

    await sendTelegramMessage(
      env,
      chatId,
      `Found ${extracted.images.length} image(s) by ${extracted.artistHandle}. They are awaiting private-archive setup; no publication slot has been reserved.`,
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

async function sendTelegramMessage(
  env: BotEnv,
  chatId: number,
  text: string,
): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    },
  );

  if (!response.ok) {
    console.error("Telegram sendMessage failed", await response.text());
  }
}
