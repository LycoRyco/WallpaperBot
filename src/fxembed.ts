export type ExtractedXImage = {
  originalUrl: string;
  width: number;
  height: number;
};

export type ExtractedXPost = {
  artistHandle: string;
  images: ExtractedXImage[];
};

type FxEmbedResponse = {
  code?: number;
  status?: {
    author?: { screen_name?: string };
    media?: {
      photos?: Array<{
        type?: string;
        url?: string;
        width?: number;
        height?: number;
      }>;
      videos?: unknown[];
    };
  };
  message?: string;
};

export class FxEmbedError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Reads public X post metadata while preserving its source image order. */
export async function extractXPost(
  postId: string,
  apiBaseUrl: string,
): Promise<ExtractedXPost> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/2/status/${postId}`, {
      headers: { "user-agent": "WallpaperBot/0.1 (personal Telegram bot)" },
    });
  } catch {
    throw new FxEmbedError("The X extractor could not be reached.", true);
  }

  let payload: FxEmbedResponse;
  try {
    payload = (await response.json()) as FxEmbedResponse;
  } catch {
    throw new FxEmbedError("The X extractor returned invalid data.", true);
  }

  if (!response.ok || payload.code !== 200 || !payload.status) {
    const message = payload.message?.trim() || "The X post could not be read.";
    throw new FxEmbedError(message, response.status >= 500 || response.status === 429);
  }

  const artistHandle = payload.status.author?.screen_name;
  if (!artistHandle || !/^[A-Za-z0-9_]{1,15}$/.test(artistHandle)) {
    throw new FxEmbedError("The X post did not contain a usable artist handle.", false);
  }

  const media = payload.status.media;
  const photos = media?.photos ?? [];
  const videos = media?.videos ?? [];
  if (videos.length > 0 || photos.some((photo) => photo.type !== "photo")) {
    throw new FxEmbedError(
      "This X post contains video or GIF media. WallpaperBot version 1 accepts image-only posts.",
      false,
    );
  }

  const images = photos.map((photo) => ({
    originalUrl: photo.url ?? "",
    width: photo.width ?? 0,
    height: photo.height ?? 0,
  }));
  if (
    images.length === 0 ||
    images.some((image) => !isSafeImageUrl(image.originalUrl) || image.width < 1 || image.height < 1)
  ) {
    throw new FxEmbedError("This X post does not contain usable images.", false);
  }

  return { artistHandle, images };
}

function isSafeImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith("twimg.com");
  } catch {
    return false;
  }
}
