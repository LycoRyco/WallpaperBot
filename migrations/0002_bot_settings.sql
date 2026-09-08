-- Small key/value settings that are learned through the owner-friendly
-- Telegram setup flow, such as private and public channel IDs.
CREATE TABLE bot_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
