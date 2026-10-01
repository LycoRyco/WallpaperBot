const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { DatabaseSync } = require('node:sqlite');
const { webcrypto } = require('node:crypto');
const now = Date.parse('2026-10-01T00:00:00Z');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const calls = [];
const sandbox = {
  exports: {}, require: () => ({}), URL, console, Date: FixedDate, crypto: webcrypto,
  fetch: async (url, options) => {
    calls.push({ method: url.split('/').at(-1), ...JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  },
};
const source = fs.readFileSync('src/index.ts', 'utf8') +
  '\nexports.helpers = { futureTehranSlots, sendRescheduleChoices, rescheduleWallpaper };';
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, sandbox);
const helpers = sandbox.exports.helpers;
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync('migrations/0001_initial_schema.sql', 'utf8'));
let beforeBatch;
let failSwap = false;
const adapter = {
  prepare(sql) {
    let values = [];
    return {
      sql,
      bind(...args) { values = args; return this; },
      async first() { return db.prepare(sql).get(...values) ?? null; },
      async all() { return { results: db.prepare(sql).all(...values) }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; },
    };
  },
  async batch(statements) {
    if (beforeBatch) { const hook = beforeBatch; beforeBatch = null; hook(); }
    db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
        if (failSwap && statements.length === 3 && results.length === 2) throw new Error('Simulated transaction failure');
      }
      db.exec('COMMIT');
      return results;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  },
};
const env = { WALLPAPERBOT_DB: adapter, OWNER_TELEGRAM_USER_ID: '1', TELEGRAM_BOT_TOKEN: 'test' };
const slots = helpers.futureTehranSlots(new FixedDate()).map(slot => slot.toISOString());
const insert = (id, slot, status = 'scheduled') => {
  db.prepare('INSERT INTO wallpapers (id, x_post_id, source_url, artist_handle, scheduled_for, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, id, 'https://x.com/artist/status/123', `Artist-${id}`, slot, status);
  db.prepare("INSERT INTO wallpaper_events (wallpaper_id, event_type, details_json) VALUES (?, 'preview_card', ?)")
    .run(id, JSON.stringify({ messageId: id === 'a' ? 101 : 202 }));
};
const reset = () => {
  db.exec('DELETE FROM wallpaper_events; DELETE FROM media; DELETE FROM wallpapers');
  calls.length = 0; beforeBatch = null; failSwap = false;
  insert('a', slots[0]); insert('b', slots[1]);
};
const time = id => db.prepare('SELECT scheduled_for FROM wallpapers WHERE id = ?').get(id).scheduled_for;

(async () => {
  reset();
  insert('c', slots[2], 'publishing');
  await helpers.sendRescheduleChoices('a', env, 101);
  const labels = calls.at(-1).reply_markup.inline_keyboard.flat().map(button => button.text).join('\n');
  assert.ok(labels.includes('🔒 Artist-b'));
  assert.ok(labels.includes('✓ Current'));
  assert.ok(labels.includes('○ Free'));
  assert.ok(!labels.includes('Artist-c'));
  assert.ok(!calls.at(-1).text.includes('Tehran'));
  assert.equal(calls.at(-1).text.split('\n').length, 1);
  await helpers.sendRescheduleChoices('a', env, 101, 1);
  assert.ok(calls.at(-1).text.includes('page 2/'));
  assert.ok(calls.at(-1).reply_markup.inline_keyboard.flat().some(b => b.text === '‹ Previous'));

  reset();
  await helpers.rescheduleWallpaper('a', Date.parse(slots[1]), env, 101);
  assert.equal(time('a'), slots[1]); assert.equal(time('b'), slots[0]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.message_id).sort(), [101, 202]);
  assert.ok(calls.every(c => c.method === 'editMessageText' && c.text.includes('Scheduled:') && !c.text.includes('Tehran')));
  assert.equal(db.prepare("SELECT count(*) AS n FROM wallpaper_events WHERE event_type = 'rescheduled'").get().n, 2);

  reset();
  await helpers.rescheduleWallpaper('a', Date.parse(slots[3]), env, 101);
  assert.equal(time('a'), slots[3]); assert.equal(time('b'), slots[1]);

  reset(); failSwap = true;
  await assert.rejects(() => helpers.rescheduleWallpaper('a', Date.parse(slots[1]), env, 101), /Simulated/);
  assert.equal(time('a'), slots[0]); assert.equal(time('b'), slots[1]);

  reset();
  beforeBatch = () => db.prepare("UPDATE wallpapers SET status = 'publishing' WHERE id = 'b'").run();
  await helpers.rescheduleWallpaper('a', Date.parse(slots[1]), env, 101);
  assert.equal(time('a'), slots[0]); assert.equal(time('b'), slots[1]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM wallpaper_events WHERE event_type = 'rescheduled'").get().n, 0);

  reset();
  db.prepare("UPDATE wallpapers SET scheduled_for = ? WHERE id = 'a'").run('2026-10-01T00:05:00.000Z');
  await helpers.sendRescheduleChoices('a', env, 101);
  assert.ok(!calls.at(-1).reply_markup.inline_keyboard.flat().some(b => b.text.includes('Artist-b')));
  await helpers.rescheduleWallpaper('a', Date.parse(slots[1]), env, 101);
  assert.equal(time('b'), slots[1]);
  assert.ok(calls.at(-1).text.includes('cannot be swapped'));

  reset();
  await helpers.rescheduleWallpaper('a', NaN, env, 101);
  assert.equal(time('a'), slots[0]);
  assert.ok(calls.every(c => c.method === 'editMessageText'));
  db.close();
  console.log('Reschedule UI, pagination, moves, swaps, both-card updates, rollback and stale-request tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
