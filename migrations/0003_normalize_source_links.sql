-- Earlier versions retained /photo/N or /video/N in source URLs.
-- Post identity remains x_post_id; do not touch schedules, media or history.
UPDATE wallpapers
SET source_url = substr(source_url, 1, instr(source_url, '/status/') + 7 + length(x_post_id))
WHERE source_url LIKE 'https://x.com/%'
  AND instr(source_url, '/status/') > 0
  AND substr(source_url, instr(source_url, '/status/') + 8, length(x_post_id)) = x_post_id
  AND length(source_url) > instr(source_url, '/status/') + 7 + length(x_post_id);
