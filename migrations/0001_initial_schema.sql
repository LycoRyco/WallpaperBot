-- WallpaperBot's first permanent data model.
-- Timestamps are UTC ISO-8601 strings. Tehran time is calculated by application code.

CREATE TABLE wallpapers (
  id TEXT PRIMARY KEY,
  x_post_id TEXT NOT NULL UNIQUE,
  source_url TEXT NOT NULL,
  artist_handle TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'extracting',
      'scheduled',
      'publishing',
      'published',
      'failed',
      'cancelled'
    )
  ),
  scheduled_for TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_retry_at TEXT,
  last_error TEXT,
  archive_message_ids TEXT,
  published_photo_message_ids TEXT,
  published_document_message_ids TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX wallpapers_by_status_and_schedule
  ON wallpapers(status, scheduled_for);

-- Only one active wallpaper may own a future publication slot.
CREATE UNIQUE INDEX one_active_wallpaper_per_slot
  ON wallpapers(scheduled_for)
  WHERE status IN ('scheduled', 'publishing');

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  wallpaper_id TEXT NOT NULL REFERENCES wallpapers(id) ON DELETE CASCADE,
  source_position INTEGER NOT NULL CHECK (source_position >= 0),
  original_url TEXT NOT NULL,
  preview_url TEXT,
  archive_file_id TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT,
  original_size_bytes INTEGER CHECK (original_size_bytes >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(wallpaper_id, source_position)
);

CREATE TABLE artist_counters (
  artist_handle TEXT PRIMARY KEY,
  next_filename_number INTEGER NOT NULL DEFAULT 1 CHECK (next_filename_number > 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE wallpaper_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallpaper_id TEXT NOT NULL REFERENCES wallpapers(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX wallpaper_events_by_wallpaper
  ON wallpaper_events(wallpaper_id, created_at);

-- Telegram may retry a webhook delivery. Recording processed update IDs makes
-- queue actions idempotent rather than creating duplicate wallpaper entries.
CREATE TABLE processed_telegram_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
