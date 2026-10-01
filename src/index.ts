import { extractXPost, FxEmbedError } from "./fxembed";

interface BotEnv extends Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  WEBHOOK_SETUP_SECRET: string;
  OWNER_TELEGRAM_USER_ID: string;
  CHANNEL_HANDLE?: string;
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
    message_id?: number;
    text?: string;
  };
  callback_query?: {
    id?: string;
    from?: { id?: number };
    data?: string;
    message?: {
      message_id?: number;
      chat?: { id?: number };
    };
  };
};

type QueuedWallpaper = {
  artist_handle: string | null;
  source_url: string;
  status: string;
  scheduled_for: string | null;
};

type QueueCount = {
  count: number;
};

type QueueView = {
  text: string;
  replyMarkup?: TelegramInlineKeyboard;
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

type RescheduleSlotOwner = OccupiedSlot & {
  id: string;
  status: string;
  artist_handle: string | null;
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

type TelegramReplyKeyboard = {
  keyboard: string[][];
  resize_keyboard: true;
  is_persistent: true;
  input_field_placeholder: string;
};

type TelegramReplyMarkup = TelegramInlineKeyboard | TelegramReplyKeyboard;

type ClearableWallpaper = {
  id: string;
  archive_message_ids: string | null;
};

type RetryableExtraction = {
  id: string;
  x_post_id: string;
};

type PublishedHistoryItem = {
  id: string;
  artist_handle: string | null;
  updated_at: string;
};

type FailureOutcome = {
  attemptNumber: number;
  willRetry: boolean;
};

type XPostLink = {
  postId: string;
  canonicalUrl: string;
};

const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";
const TELEGRAM_SETUP_PATH = "/internal/register-webhook";
const ARCHIVE_SETUP_MARKER = "#wallpaperbot-archive-setup";
const PUBLIC_CHANNEL_SETUP_MARKER = "#wallpaperbot-public-setup";
const CHANNEL_SETUP_LIFETIME_MS = 10 * 60 * 1000;
const DEFAULT_CHANNEL_HANDLE = "@LycoRyco_Wallpapers";
const QUEUE_BUTTON = "📋 Queue";
const HELP_BUTTON = "ℹ️ Help";
const CLEAR_QUEUE_BUTTON = "🗑 Clear queue";
const CONNECT_CHANNEL_BUTTON = "🔗 Connect channel";
const QUEUE_PAGE_SIZE = 10;

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
    ctx.waitUntil(processDueExtractions(env));
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

  if (text === "/start" || text === "/help" || text === HELP_BUTTON) {
    await ensureOwnerCommandMenu(env);
    await sendTelegramMessage(
      env,
      chatId,
      [
        "WallpaperBot is connected.",
        "",
        "Send a public X (Twitter) image-post link and I will archive, preview, and schedule it automatically.",
        "",
        "Quick controls:",
        "/start — show this message",
        "/queue — view the current queue",
        "/clearqueue — permanently clear queued items",
        "/clearpublished — choose a recent post to reuse",
        "/clearpublished <X link> — allow that specific post to be reused",
        "/connectpublic — connect a public channel with a one-time code",
        "/connectarchive — connect the private archive channel with a one-time code",
      ].join("\n"),
      ownerReplyKeyboard(),
    );
    return;
  }

  if (text === "/queue" || text === QUEUE_BUTTON) {
    const view = await buildQueueView(env, 0);
    await sendTelegramMessage(env, chatId, view.text, view.replyMarkup);
    return;
  }

  if (text === "/clearqueue" || text === CLEAR_QUEUE_BUTTON) {
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

  const clearPublishedCommand = text.match(/^\/clearpublished(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (clearPublishedCommand) {
    if (clearPublishedCommand[1]) {
      await showPublishedHistoryForLink(chatId, clearPublishedCommand[1].trim(), env);
    } else {
      await showPublishedHistoryChoices(chatId, env);
    }
    return;
  }

  if (text === "/connectpublic" || text === CONNECT_CHANNEL_BUTTON) {
    await requestChannelConnection("public", chatId, env);
    return;
  }

  if (text === "/connectarchive") {
    await requestChannelConnection("archive", chatId, env);
    return;
  }

  const xPost = parseXPostLink(text);
  if (xPost) {
    const reply = await receiveXPost(xPost, env, chatId, ctx);
    if (reply) await sendTelegramMessage(env, chatId, reply);
    return;
  }

  await sendTelegramMessage(
    env,
    chatId,
    "Send a direct public X (Twitter) post link containing images, or use /help.",
  );
}

function ownerReplyKeyboard(): TelegramReplyKeyboard {
  return {
    keyboard: [
      [QUEUE_BUTTON, HELP_BUTTON],
      [CLEAR_QUEUE_BUTTON, CONNECT_CHANNEL_BUTTON],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Send an X wallpaper post link…",
  };
}

async function ensureOwnerCommandMenu(env: BotEnv): Promise<void> {
  try {
    await telegramApi(env, "setMyCommands", {
      scope: { type: "chat", chat_id: Number(env.OWNER_TELEGRAM_USER_ID) },
      commands: [
        { command: "start", description: "Show the bot controls" },
        { command: "queue", description: "View the wallpaper queue" },
        { command: "clearqueue", description: "Permanently clear the queue" },
        { command: "clearpublished", description: "Reuse a published post (optional X link)" },
        { command: "connectpublic", description: "Connect the public channel" },
        { command: "connectarchive", description: "Connect the private archive" },
        { command: "help", description: "Show help" },
      ],
    });
  } catch (error) {
    console.error("Could not set the owner command menu", error);
  }
}

async function handleChannelSetup(update: TelegramUpdate, env: BotEnv): Promise<void> {
  const channelPost = update.channel_post;
  const channelId = channelPost?.chat?.id;
  const marker = channelPost?.text?.trim();
  const messageId = channelPost?.message_id;
  const setup = parseChannelSetupMarker(marker);
  if (channelId === undefined || messageId === undefined || !setup) {
    return;
  }

  const pending = await getPendingChannelConnection(setup.kind, env);
  if (!pending || pending.code !== setup.code || pending.expiresAt <= Date.now()) {
    console.warn("Ignored an invalid or expired channel connection marker.");
    return;
  }

  if (!(await claimTelegramUpdate(update.update_id, env))) return;

  await setBotSetting(`${setup.kind}_channel_id`, String(channelId), env);
  await deleteBotSetting(`pending_${setup.kind}_channel_setup`, env);
  try {
    await telegramApi(env, "deleteMessage", { chat_id: String(channelId), message_id: messageId });
  } catch (error) {
    console.warn("Could not remove channel setup marker", error);
  }
  await sendTelegramMessage(
    env,
    env.OWNER_TELEGRAM_USER_ID,
    setup.kind === "archive"
      ? "Private archive channel connected successfully."
      : "Public wallpaper channel connected successfully. Nothing has been published.",
  );
}

type ChannelKind = "archive" | "public";

type PendingChannelConnection = {
  code: string;
  expiresAt: number;
};

function parseChannelSetupMarker(value: string | undefined): { kind: ChannelKind; code: string } | null {
  if (!value) return null;
  const match = value.match(/^(#wallpaperbot-(archive|public)-setup)\s+([0-9a-f-]{36})$/i);
  if (!match) return null;
  return {
    kind: match[2].toLowerCase() as ChannelKind,
    code: match[3].toLowerCase(),
  };
}

async function requestChannelConnection(kind: ChannelKind, chatId: number, env: BotEnv): Promise<void> {
  const code = crypto.randomUUID();
  const marker = kind === "archive" ? ARCHIVE_SETUP_MARKER : PUBLIC_CHANNEL_SETUP_MARKER;
  await setBotSetting(
    `pending_${kind}_channel_setup`,
    JSON.stringify({ code, expiresAt: Date.now() + CHANNEL_SETUP_LIFETIME_MS }),
    env,
  );
  await sendTelegramMessage(
    env,
    chatId,
    [
      `To connect the ${kind === "archive" ? "private archive" : "public wallpaper"} channel, send this exact message in that channel within 10 minutes:`,
      "",
      `${marker} ${code}`,
      "",
      "The bot will remove this setup message after connecting the channel.",
    ].join("\n"),
  );
}

async function getPendingChannelConnection(
  kind: ChannelKind,
  env: BotEnv,
): Promise<PendingChannelConnection | null> {
  const value = await getBotSetting(`pending_${kind}_channel_setup`, env);
  if (!value) return null;
  try {
    const pending = JSON.parse(value) as PendingChannelConnection;
    return typeof pending.code === "string" && typeof pending.expiresAt === "number" ? pending : null;
  } catch {
    return null;
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
  if (data.startsWith("qp:")) {
    const page = Number(data.slice(3));
    const messageId = callback?.message?.message_id;
    const chatId = callback?.message?.chat?.id;
    if (!Number.isInteger(page) || page < 0 || messageId === undefined ||
        String(chatId) !== env.OWNER_TELEGRAM_USER_ID) {
      await answerCallbackQuery(env, callbackId, "This queue page is no longer valid.");
      return;
    }
    await answerCallbackQuery(env, callbackId);
    try {
      const view = await buildQueueView(env, page);
      await editTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, messageId, view.text, view.replyMarkup);
    } catch (error) {
      console.error("Could not update queue page", error);
      await answerCallbackQuery(env, callbackId, "Could not update this queue. Send /queue to open it again.");
    }
    return;
  }

  const [action, wallpaperId, value] = data.split(":");
  if (!wallpaperId || !isWallpaperId(wallpaperId)) {
    await answerCallbackQuery(env, callbackId, "This control is no longer valid.");
    return;
  }

  if (["c", "x", "r", "p", "P", "b"].includes(action)) {
    const messageId = callback?.message?.message_id;
    if (messageId === undefined || String(callback?.message?.chat?.id) !== env.OWNER_TELEGRAM_USER_ID) {
      await answerCallbackQuery(env, callbackId, "This control is no longer available.");
      return;
    }
    await answerCallbackQuery(env, callbackId);
    ctx.waitUntil(handleWallpaperControl(action, wallpaperId, value, messageId, env));
    return;
  }

  if (action === "h") {
    const wallpaper = await getControlWallpaper(wallpaperId, env);
    if (!wallpaper || wallpaper.status !== "published") {
      await answerCallbackQuery(env, callbackId, "That published-history entry is no longer available.");
      return;
    }
    await answerCallbackQuery(env, callbackId);
    await confirmPublishedHistoryRemoval(Number(env.OWNER_TELEGRAM_USER_ID), wallpaperId, wallpaper.source_url, env);
    return;
  }

  if (action === "k") {
    await answerCallbackQuery(env, callbackId, "Wallpaper kept.");
    return;
  }

  if (action === "d") {
    await answerCallbackQuery(env, callbackId, "Removing published-history record…");
    ctx.waitUntil(forgetPublishedWallpaper(wallpaperId, env));
    return;
  }

}

function backControl(wallpaperId: string): { text: string; callback_data: string } {
  return { text: "‹ Back", callback_data: `b:${wallpaperId}` };
}

async function restoreWallpaperCard(wallpaperId: string, messageId: number, env: BotEnv): Promise<void> {
  const wallpaper = await getControlWallpaper(wallpaperId, env);
  if (!wallpaper) {
    await editTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, messageId, "This wallpaper is no longer in the queue.");
    return;
  }
  const media = await env.WALLPAPERBOT_DB.prepare(
    "SELECT COUNT(*) AS count FROM media WHERE wallpaper_id = ?",
  ).bind(wallpaperId).first<{ count: number }>();
  const text = [
    `Wallpaper • ${wallpaper.artist_handle ?? "Unknown artist"}`,
    wallpaper.status === "scheduled" && wallpaper.scheduled_for
      ? `Scheduled: ${formatTehranTime(wallpaper.scheduled_for)}`
      : `Status: ${wallpaper.status}`,
    `Images: ${media?.count ?? 0}`,
  ].join("\n");
  await editTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, messageId, text,
    wallpaper.status === "scheduled" ? previewControls(wallpaperId) : undefined);
}

async function handleWallpaperControl(
  action: string,
  wallpaperId: string,
  value: string | undefined,
  messageId: number,
  env: BotEnv,
): Promise<void> {
  try {
    const wallpaper = await getControlWallpaper(wallpaperId, env);
    if (!wallpaper || wallpaper.status !== "scheduled") {
      await restoreWallpaperCard(wallpaperId, messageId, env);
      return;
    }
    // Adopt older preview cards too, so publication can update their status.
    const details = JSON.stringify({ messageId });
    const saved = await env.WALLPAPERBOT_DB.prepare(
      "SELECT details_json FROM wallpaper_events WHERE wallpaper_id = ? AND event_type = 'preview_card' ORDER BY id DESC LIMIT 1",
    ).bind(wallpaperId).first<{ details_json: string }>();
    if (saved?.details_json !== details) {
      await env.WALLPAPERBOT_DB.prepare(
        "INSERT INTO wallpaper_events (wallpaper_id, event_type, details_json) VALUES (?, 'preview_card', ?)",
      ).bind(wallpaperId, details).run();
    }
    if (action === "b") {
      await restoreWallpaperCard(wallpaperId, messageId, env);
    } else if (action === "c" || action === "p") {
      await editTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, messageId,
        action === "c"
          ? `Cancel ${wallpaper.artist_handle ?? "this wallpaper"}? Its queued item and archive files will be deleted.`
          : `Publish ${wallpaper.artist_handle ?? "this wallpaper"} to the connected channel now?`,
        { inline_keyboard: [
          [{ text: action === "c" ? "Confirm cancellation" : "Confirm publish", callback_data: `${action === "c" ? "x" : "P"}:${wallpaperId}` }],
          [backControl(wallpaperId)],
        ] });
    } else if (action === "r") {
      if (value?.startsWith("page")) await sendRescheduleChoices(wallpaperId, env, messageId, Number(value.slice(4)));
      else if (value) await rescheduleWallpaper(wallpaperId, Number(value), env, messageId);
      else await sendRescheduleChoices(wallpaperId, env, messageId);
    } else if (action === "x") {
      await cancelWallpaper(wallpaperId, env, messageId);
    } else if (action === "P") {
      await editTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, messageId, "Publishing…");
      await publishWallpaper(wallpaperId, env);
    }
  } catch (error) {
    console.error("Wallpaper control failed", error);
    try {
      await editTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, messageId,
        "Couldn’t complete this action. Check the wallpaper’s current status before trying again.",
        { inline_keyboard: [[backControl(wallpaperId)]] });
    } catch (editError) {
      console.error("Could not display control error", editError);
    }
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

async function deleteBotSetting(key: string, env: BotEnv): Promise<void> {
  await env.WALLPAPERBOT_DB.prepare(
    "DELETE FROM bot_settings WHERE setting_key = ?",
  )
    .bind(key)
    .run();
}

async function buildQueueView(env: BotEnv, requestedPage: number): Promise<QueueView> {
  await assignSlotsForArchivedWallpapers(env);
  await sendMissingPreviews(env);
  const countResult = await env.WALLPAPERBOT_DB.prepare(
    `SELECT COUNT(*) AS count FROM wallpapers
     WHERE status IN ('extracting', 'scheduled', 'publishing', 'failed')`,
  ).first<QueueCount>();
  const total = countResult?.count ?? 0;
  if (total === 0) {
    return { text: "Your wallpaper queue is empty." };
  }

  const pageCount = Math.ceil(total / QUEUE_PAGE_SIZE);
  const page = Math.min(requestedPage, pageCount - 1);
  const offset = page * QUEUE_PAGE_SIZE;
  const result = await env.WALLPAPERBOT_DB.prepare(
    `SELECT artist_handle, source_url, status, scheduled_for
     FROM wallpapers
     WHERE status IN ('extracting', 'scheduled', 'publishing', 'failed')
     ORDER BY scheduled_for IS NULL, scheduled_for, created_at
     LIMIT ? OFFSET ?`,
  )
    .bind(QUEUE_PAGE_SIZE, offset)
    .all<QueuedWallpaper>();

  const entries = result.results.map((wallpaper, index) => {
    const artist = wallpaper.artist_handle ?? "Unknown artist";
    const state =
      wallpaper.status === "scheduled" && !wallpaper.scheduled_for
        ? "Ready — waiting for a slot"
        : wallpaper.scheduled_for
          ? `${formatTehranTime(wallpaper.scheduled_for)} (${wallpaper.status})`
          : "Awaiting extraction";
    return `${offset + index + 1}. ${artist} — ${state}`;
  });

  const start = offset + 1;
  const end = offset + result.results.length;
  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) navigation.push({ text: "‹ Previous", callback_data: `qp:${page - 1}` });
  if (page < pageCount - 1) navigation.push({ text: "Next ›", callback_data: `qp:${page + 1}` });
  return {
    text: [
      `Wallpaper queue — ${start}–${end} of ${total}`,
      "",
      ...entries,
    ].join("\n"),
    ...(navigation.length > 0 ? { replyMarkup: { inline_keyboard: [navigation] } } : {}),
  };
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
    canonicalUrl: `https://x.com${url.pathname.slice(0, match.index! + match[0].length).replace(/\/$/, "")}`,
  };
}

async function receiveXPost(
  xPost: XPostLink,
  env: BotEnv,
  chatId: number,
  ctx: ExecutionContext,
): Promise<string | null> {
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
      return "Retrying this wallpaper.";
    }

    if (existing.status === "extracting") {
      return "This wallpaper is still being prepared.";
    }

    if (existing.status === "published") {
      return "Already published. Use /clearpublished if you want to post it again.";
    }

    if (existing.status === "publishing") {
      return "This wallpaper is being published.";
    }

    if (existing.status === "scheduled" && existing.scheduled_for) {
      return `Already scheduled: ${formatTehranTime(existing.scheduled_for)}.`;
    }

    return "This wallpaper is already in your queue.";
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

  return null;
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
  } catch (error) {
    const extractionError =
      error instanceof FxEmbedError
        ? error
        : new FxEmbedError("An unexpected extraction error occurred.", true);
    const outcome = await recordExtractionFailure(wallpaperId, extractionError, env);
    await notifyExtractionFailure(chatId, extractionError, outcome, env);
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
  } catch (error) {
    const archiveError = toArchiveError(error);
    const outcome = await recordExtractionFailure(wallpaperId, archiveError, env);
    await notifyExtractionFailure(chatId, archiveError, outcome, env);
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
     SET status = 'scheduled', retry_count = 0, next_retry_at = NULL, last_error = NULL,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
  const ready = await env.WALLPAPERBOT_DB.prepare(
    "SELECT scheduled_for FROM wallpapers WHERE id = ?",
  ).bind(wallpaperId).first<{ scheduled_for: string | null }>();
  if (ready && !ready.scheduled_for) {
    await sendTelegramMessage(env, chatId, "Wallpaper ready. Waiting for an available slot; check /queue for its status.");
  }
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
  const caption = buildChannelCaption(
    wallpaper.artist_handle,
    wallpaper.source_url,
    configuredChannelHandle(env),
  );

  let visualSent = false;
  try {
    await sendPreviewImages(env, media.results.map((item) => item.preview_url), caption);
    visualSent = true;
  } catch (error) {
    console.error("Visual preview could not be sent", error);
  }

  const text = [
    `Wallpaper • ${wallpaper.artist_handle}`,
    `Scheduled: ${formatTehranTime(wallpaper.scheduled_for)}`,
    `Images: ${media.results.length}`,
    ...(!visualSent ? ["Preview unavailable. Open /queue to retry the preview."] : []),
  ].join("\n");
  let sent = await updateWallpaperCard(wallpaper.id, text, previewControls(wallpaper.id), env);
  if (!sent) {
    const card = await telegramApi(env, "sendMessage", {
      chat_id: env.OWNER_TELEGRAM_USER_ID,
      text,
      reply_markup: previewControls(wallpaper.id),
    }) as { message_id: number };
    await env.WALLPAPERBOT_DB.prepare(
      "INSERT INTO wallpaper_events (wallpaper_id, event_type, details_json) VALUES (?, 'preview_card', ?)",
    ).bind(wallpaper.id, JSON.stringify({ messageId: card.message_id })).run();
    sent = true;
  }
  if (sent && visualSent) {
    await env.WALLPAPERBOT_DB.prepare(
      "INSERT INTO wallpaper_events (wallpaper_id, event_type) VALUES (?, 'preview_sent')",
    )
      .bind(wallpaperId)
      .run();
  }
}

async function updateWallpaperCard(
  wallpaperId: string,
  text: string,
  replyMarkup: TelegramInlineKeyboard | undefined,
  env: BotEnv,
): Promise<boolean> {
  try {
    const event = await env.WALLPAPERBOT_DB.prepare(
      `SELECT details_json FROM wallpaper_events
       WHERE wallpaper_id = ? AND event_type = 'preview_card' ORDER BY id DESC LIMIT 1`,
    ).bind(wallpaperId).first<{ details_json: string }>();
    if (!event) return false;
    const { messageId } = JSON.parse(event.details_json) as { messageId?: number };
    if (typeof messageId !== "number" || !Number.isInteger(messageId)) return false;
    await editTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, messageId, text, replyMarkup);
    return true;
  } catch (error) {
    console.warn("Could not update wallpaper status card", error);
    return false;
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

function buildChannelCaption(artistHandle: string, sourceUrl: string, channelHandle: string): string {
  const safeArtist = escapeHtml(artistHandle);
  const safeSource = escapeHtml(parseXPostLink(sourceUrl)?.canonicalUrl ?? sourceUrl);
  return [
    `Artist: <a href="https://x.com/${safeArtist}">${safeArtist}</a>`,
    "Wallpaper Source: X (Twitter)",
    `Link: ${safeSource}`,
    "",
    channelHandle,
  ].join("\n");
}

function configuredChannelHandle(env: BotEnv): string {
  return env.CHANNEL_HANDLE?.trim() || DEFAULT_CHANNEL_HANDLE;
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
): Promise<FailureOutcome> {
  const wallpaper = await env.WALLPAPERBOT_DB.prepare(
    "SELECT retry_count FROM wallpapers WHERE id = ?",
  )
    .bind(wallpaperId)
    .first<{ retry_count: number }>();
  const attemptNumber = (wallpaper?.retry_count ?? 0) + 1;
  const willRetry = error.retryable && attemptNumber < 3;
  await env.WALLPAPERBOT_DB.batch([
    env.WALLPAPERBOT_DB.prepare(
      `UPDATE wallpapers
       SET status = 'failed', retry_count = ?, last_error = ?, next_retry_at = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    ).bind(
      attemptNumber,
      error.message,
      willRetry ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null,
      wallpaperId,
    ),
    env.WALLPAPERBOT_DB.prepare(
      "INSERT INTO wallpaper_events (wallpaper_id, event_type, details_json) VALUES (?, 'extraction_failed', ?)",
    ).bind(wallpaperId, JSON.stringify({ retryable: error.retryable, message: error.message, attemptNumber })),
  ]);
  return { attemptNumber, willRetry };
}

async function notifyExtractionFailure(
  chatId: number,
  error: FxEmbedError,
  outcome: FailureOutcome,
  env: BotEnv,
): Promise<void> {
  if (outcome.willRetry) {
    if (outcome.attemptNumber === 1) {
      await sendTelegramMessage(
        env,
        chatId,
        `Couldn’t prepare this wallpaper. Retrying in 10 minutes.\n${error.message}`,
      );
    }
    return;
  }

  const reason = error.retryable
    ? `Preparation failed after ${outcome.attemptNumber} attempts.`
    : "This post cannot be processed.";
  await sendTelegramMessage(env, chatId, `${reason}\n${error.message}`);
}

async function sendRescheduleChoices(wallpaperId: string, env: BotEnv, messageId: number, requestedPage = 0): Promise<void> {
  const wallpaper = await getControlWallpaper(wallpaperId, env);
  if (!wallpaper || wallpaper.status !== "scheduled") {
    await restoreWallpaperCard(wallpaperId, messageId, env);
    return;
  }

  const futureSlots = futureTehranSlots(new Date());
  const occupied = await env.WALLPAPERBOT_DB.prepare(
    `SELECT id, scheduled_for, status, artist_handle FROM wallpapers
     WHERE status IN ('scheduled', 'publishing') AND scheduled_for IS NOT NULL`,
  ).all<RescheduleSlotOwner>();
  const owners = new Map(occupied.results.map((item) => [item.scheduled_for, item]));
  const canSwap = futureSlots.some((slot) => slot.toISOString() === wallpaper.scheduled_for);
  const slots = futureSlots.filter((slot) => {
    const owner = owners.get(slot.toISOString());
    return !owner || owner.id === wallpaperId || (canSwap && owner.status === "scheduled");
  });
  if (slots.length === 0) {
    await editTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, messageId,
      "There are no future slots available yet.",
      { inline_keyboard: [[backControl(wallpaperId)]] });
    return;
  }

  const pageCount = Math.ceil(slots.length / 6);
  const page = Number.isInteger(requestedPage) ? Math.max(0, Math.min(requestedPage, pageCount - 1)) : 0;
  const navigation = [];
  if (page > 0) navigation.push({ text: "‹ Previous", callback_data: `r:${wallpaperId}:page${page - 1}` });
  if (page + 1 < pageCount) navigation.push({ text: "Next ›", callback_data: `r:${wallpaperId}:page${page + 1}` });
  await editTelegramMessage(
    env,
    env.OWNER_TELEGRAM_USER_ID,
    messageId,
    `Choose a slot — page ${page + 1}/${pageCount}`,
    {
      inline_keyboard: [...slots.slice(page * 6, page * 6 + 6).map((slot) => {
        const owner = owners.get(slot.toISOString());
        const label = owner?.id === wallpaperId ? "✓ Current"
          : owner ? `🔒 ${owner.artist_handle ?? "Unknown artist"}` : "○ Free";
        return [{ text: `${formatTehranTime(slot.toISOString())} · ${label}`,
          callback_data: `r:${wallpaperId}:${slot.getTime()}` }];
      }), ...(navigation.length ? [navigation] : []), [backControl(wallpaperId)]],
    },
  );
}

async function rescheduleWallpaper(
  wallpaperId: string,
  milliseconds: number,
  env: BotEnv,
  messageId: number,
): Promise<void> {
  const slot = new Date(milliseconds);
  const futureSlots = futureTehranSlots(new Date());
  const validSlot = Number.isFinite(slot.getTime()) && futureSlots
    .some((candidate) => candidate.getTime() === slot.getTime());
  if (!validSlot) {
    await editTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, messageId,
      "That slot is no longer available. Go back and choose Reschedule again.",
      { inline_keyboard: [[backControl(wallpaperId)]] });
    return;
  }

  const scheduledFor = slot.toISOString();
  const wallpaper = await getControlWallpaper(wallpaperId, env);
  if (!wallpaper || wallpaper.status !== "scheduled") {
    await restoreWallpaperCard(wallpaperId, messageId, env);
    return;
  }
  if (wallpaper.scheduled_for === scheduledFor) {
    await restoreWallpaperCard(wallpaperId, messageId, env);
    return;
  }
  const occupied = await env.WALLPAPERBOT_DB.prepare(
    `SELECT id, scheduled_for, status, artist_handle FROM wallpapers
     WHERE scheduled_for = ? AND status IN ('scheduled', 'publishing')`,
  ).bind(scheduledFor).first<RescheduleSlotOwner>();
  if (occupied) {
    if (occupied.status !== "scheduled" || !wallpaper.scheduled_for ||
        !futureSlots.some((candidate) => candidate.toISOString() === wallpaper.scheduled_for)) {
      await editTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, messageId,
        "These wallpapers cannot be swapped: a slot is publishing or too close to its sending time. Choose another slot.",
        { inline_keyboard: [[backControl(wallpaperId)]] });
      return;
    }
    // D1 batches are transactions. A unique temporary value avoids the slot
    // index conflict; guards make a stale/concurrent request a complete no-op.
    const temporary = `swap-${crypto.randomUUID()}`;
    const oldSlot = wallpaper.scheduled_for;
    const results = await env.WALLPAPERBOT_DB.batch([
      env.WALLPAPERBOT_DB.prepare(
        `UPDATE wallpapers SET scheduled_for = ?
         WHERE id = ? AND status = 'scheduled' AND scheduled_for = ?
           AND EXISTS (SELECT 1 FROM wallpapers WHERE id = ? AND status = 'scheduled' AND scheduled_for = ?)`,
      ).bind(temporary, wallpaperId, oldSlot, occupied.id, scheduledFor),
      env.WALLPAPERBOT_DB.prepare(
        `UPDATE wallpapers SET scheduled_for = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'scheduled' AND scheduled_for = ?
           AND EXISTS (SELECT 1 FROM wallpapers WHERE id = ? AND scheduled_for = ?)`,
      ).bind(oldSlot, occupied.id, scheduledFor, wallpaperId, temporary),
      env.WALLPAPERBOT_DB.prepare(
        `UPDATE wallpapers SET scheduled_for = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'scheduled' AND scheduled_for = ?`,
      ).bind(scheduledFor, wallpaperId, temporary),
    ]);
    if (results.every((result) => result.meta.changes === 1)) {
      await env.WALLPAPERBOT_DB.batch([
        env.WALLPAPERBOT_DB.prepare("INSERT INTO wallpaper_events (wallpaper_id, event_type, details_json) VALUES (?, 'rescheduled', ?)")
          .bind(wallpaperId, JSON.stringify({ scheduledFor, swappedWith: occupied.id })),
        env.WALLPAPERBOT_DB.prepare("INSERT INTO wallpaper_events (wallpaper_id, event_type, details_json) VALUES (?, 'rescheduled', ?)")
          .bind(occupied.id, JSON.stringify({ scheduledFor: oldSlot, swappedWith: wallpaperId })),
      ]);
      const card = await env.WALLPAPERBOT_DB.prepare(
        "SELECT details_json FROM wallpaper_events WHERE wallpaper_id = ? AND event_type = 'preview_card' ORDER BY id DESC LIMIT 1",
      ).bind(occupied.id).first<{ details_json: string }>();
      if (card) {
        const savedMessageId = (JSON.parse(card.details_json) as { messageId?: number }).messageId;
        if (Number.isInteger(savedMessageId)) await restoreWallpaperCard(occupied.id, savedMessageId!, env);
      }
    }
    await restoreWallpaperCard(wallpaperId, messageId, env);
    return;
  }
  const result = await env.WALLPAPERBOT_DB.prepare(
    `UPDATE wallpapers
     SET scheduled_for = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND status = 'scheduled' AND scheduled_for IS ?
       AND NOT EXISTS (SELECT 1 FROM wallpapers WHERE scheduled_for = ? AND status IN ('scheduled', 'publishing'))`,
  )
    .bind(scheduledFor, wallpaperId, wallpaper.scheduled_for, scheduledFor)
    .run();
  if (result.meta.changes !== 1) {
    await restoreWallpaperCard(wallpaperId, messageId, env);
    return;
  }

  await env.WALLPAPERBOT_DB.prepare(
    "INSERT INTO wallpaper_events (wallpaper_id, event_type, details_json) VALUES (?, 'rescheduled', ?)",
  )
    .bind(wallpaperId, JSON.stringify({ scheduledFor }))
    .run();
  await restoreWallpaperCard(wallpaperId, messageId, env);
}

async function cancelWallpaper(wallpaperId: string, env: BotEnv, messageId: number): Promise<void> {
  const wallpaper = await getControlWallpaper(wallpaperId, env);
  const archiveChannelId = await getBotSetting("archive_channel_id", env);
  if (!wallpaper || wallpaper.status !== "scheduled" || !archiveChannelId) {
    await restoreWallpaperCard(wallpaperId, messageId, env);
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
  await editTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, messageId, "Wallpaper canceled. Its queue record and archive files were deleted.");
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

async function showPublishedHistoryForLink(chatId: number, link: string, env: BotEnv): Promise<void> {
  const post = parseXPostLink(link);
  if (!post) {
    await sendTelegramMessage(env, chatId, "Send /clearpublished followed by one valid X post link.");
    return;
  }
  const wallpaper = await env.WALLPAPERBOT_DB.prepare(
    "SELECT id FROM wallpapers WHERE x_post_id = ? AND status = 'published'",
  ).bind(post.postId).first<WallpaperId>();
  if (!wallpaper) {
    await sendTelegramMessage(env, chatId, "No published-history record was found for that X post. Your queue is unchanged.");
    return;
  }
  await confirmPublishedHistoryRemoval(chatId, wallpaper.id, post.canonicalUrl, env);
}

async function confirmPublishedHistoryRemoval(chatId: number, wallpaperId: string, sourceUrl: string, env: BotEnv): Promise<void> {
  const link = parseXPostLink(sourceUrl)?.canonicalUrl ?? sourceUrl;
  await sendTelegramMessage(env, chatId,
    `Allow this X post to be submitted again?\n${link}\n\nOnly its published-history record will be removed. Public posts and private archive files stay untouched.`,
    { inline_keyboard: [[
      { text: "Yes, allow reuse", callback_data: `d:${wallpaperId}` },
      { text: "Keep its history", callback_data: `k:${wallpaperId}` },
    ]] },
  );
}

async function showPublishedHistoryChoices(chatId: number, env: BotEnv): Promise<void> {
  const published = await env.WALLPAPERBOT_DB.prepare(
    `SELECT id, artist_handle, updated_at FROM wallpapers
     WHERE status = 'published' ORDER BY updated_at DESC LIMIT 3`,
  ).all<PublishedHistoryItem>();
  if (published.results.length === 0) {
    await sendTelegramMessage(env, chatId, "There are no published-history records to clear.");
    return;
  }
  await sendTelegramMessage(
    env,
    chatId,
    "Choose a published wallpaper to allow for reuse:",
    {
      inline_keyboard: published.results.map((wallpaper) => [{
        text: `${wallpaper.artist_handle ?? "Unknown artist"} — ${formatTehranTime(wallpaper.updated_at)}`,
        callback_data: `h:${wallpaper.id}`,
      }]),
    },
  );
}

async function forgetPublishedWallpaper(wallpaperId: string, env: BotEnv): Promise<void> {
  const wallpaper = await getControlWallpaper(wallpaperId, env);
  if (!wallpaper || wallpaper.status !== "published") {
    await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, "That published-history entry is no longer available.");
    return;
  }
  await env.WALLPAPERBOT_DB.batch([
    env.WALLPAPERBOT_DB.prepare("DELETE FROM wallpaper_events WHERE wallpaper_id = ?").bind(wallpaperId),
    env.WALLPAPERBOT_DB.prepare("DELETE FROM media WHERE wallpaper_id = ?").bind(wallpaperId),
    env.WALLPAPERBOT_DB.prepare("DELETE FROM wallpapers WHERE id = ?").bind(wallpaperId),
  ]);
  await sendTelegramMessage(
    env,
    env.OWNER_TELEGRAM_USER_ID,
    "Published-history record removed. You can submit that X post again.",
  );
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

async function processDueExtractions(env: BotEnv): Promise<void> {
  const now = new Date().toISOString();
  const failed = await env.WALLPAPERBOT_DB.prepare(
    `SELECT id, x_post_id FROM wallpapers
     WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?
       AND retry_count < 3
     ORDER BY next_retry_at
     LIMIT 5`,
  )
    .bind(now)
    .all<RetryableExtraction>();

  for (const wallpaper of failed.results) {
    const claimed = await env.WALLPAPERBOT_DB.prepare(
      `UPDATE wallpapers
       SET status = 'extracting', next_retry_at = NULL,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'failed'`,
    )
      .bind(wallpaper.id)
      .run();
    if (claimed.meta.changes === 1) {
      await recoverExistingExtraction(
        wallpaper.id,
        wallpaper.x_post_id,
        Number(env.OWNER_TELEGRAM_USER_ID),
        env,
      );
    }
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
      photoIds = await sendPublicPhotos(
        env,
        publicChannelId,
        media.results.map((item) => item.preview_url),
        buildChannelCaption(wallpaper.artist_handle, wallpaper.source_url, configuredChannelHandle(env)),
      );
      await env.WALLPAPERBOT_DB.prepare(
        "UPDATE wallpapers SET published_photo_message_ids = ? WHERE id = ?",
      ).bind(JSON.stringify(photoIds), wallpaperId).run();
    }

    let documentIds = parseMessageIds(wallpaper.published_document_message_ids);
    if (documentIds.length === 0) {
      documentIds = await sendPublicDocuments(
        env,
        publicChannelId,
        media.results.map((item) => item.archive_file_id),
        configuredChannelHandle(env),
      );
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
    const publishedText = `Wallpaper • ${wallpaper.artist_handle}\nPublished: ${formatTehranTime(new Date().toISOString())}\nImages: ${media.results.length}`;
    if (!(await updateWallpaperCard(wallpaperId, publishedText, undefined, env))) {
      await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, `Published: ${wallpaper.artist_handle}.`);
    }
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
      retryAt ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null,
      message,
      wallpaperId,
    ).run();
    const failureText = retryAt
      ? `Publication delayed. Retrying in 10 minutes (attempt ${attemptNumber} of 3).\n${message}`
      : `Publication failed after 3 attempts.\n${message}`;
    if (!(await updateWallpaperCard(wallpaperId, failureText, retryAt ? previewControls(wallpaperId) : undefined, env))) {
      await sendTelegramMessage(env, env.OWNER_TELEGRAM_USER_ID, failureText);
    }
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

async function sendPublicDocuments(
  env: BotEnv,
  channelId: string,
  fileIds: string[],
  channelHandle: string,
): Promise<number[]> {
  const method = fileIds.length === 1 ? "sendDocument" : "sendMediaGroup";
  const result = await telegramApi(env, method, fileIds.length === 1
    ? {
      chat_id: channelId,
      document: fileIds[0],
      caption: channelHandle,
      disable_notification: true,
    }
    : {
      chat_id: channelId,
      disable_notification: true,
      media: fileIds.map((fileId, index) => ({
        type: "document",
        media: fileId,
        ...(index === fileIds.length - 1 ? { caption: channelHandle } : {}),
      })),
    });
  const messages = Array.isArray(result) ? result : [result];
  const ids = messages.map((message) => (message as { message_id?: number }).message_id);
  if (ids.some((id) => id === undefined)) throw new Error("Telegram did not return document message IDs.");
  return ids as number[];
}

async function sendTelegramMessage(
  env: BotEnv,
  chatId: number | string,
  text: string,
  replyMarkup?: TelegramReplyMarkup,
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

async function editTelegramMessage(
  env: BotEnv,
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup?: TelegramInlineKeyboard,
): Promise<void> {
  try {
    await telegramApi(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
  } catch (error) {
    // Repeated taps or a shrinking queue may resolve to the displayed page.
    if (error instanceof Error && error.message.includes("message is not modified")) return;
    throw error;
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
