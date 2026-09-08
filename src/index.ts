interface BotEnv extends Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  WEBHOOK_SETUP_SECRET: string;
}

type TelegramUpdate = {
  update_id: number;
};

const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";
const TELEGRAM_SETUP_PATH = "/internal/register-webhook";

export default {
  async fetch(request: Request, env: BotEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        service: "WallpaperBot",
        status: "foundation-ready",
      });
    }

    if (request.method === "POST" && url.pathname === TELEGRAM_WEBHOOK_PATH) {
      return handleTelegramWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === TELEGRAM_SETUP_PATH) {
      return registerTelegramWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<BotEnv>;

async function handleTelegramWebhook(request: Request, env: BotEnv): Promise<Response> {
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

  // The next stage adds owner-only command processing here.
  console.log(`Received Telegram update ${update.update_id}`);
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
