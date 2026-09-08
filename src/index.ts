/**
 * WallpaperBot Worker entry point.
 *
 * This intentionally contains only a health check at the foundation stage.
 * Telegram webhooks, D1, and scheduled publishing are added in later stages.
 */
export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        service: "WallpaperBot",
        status: "foundation-ready",
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler;
