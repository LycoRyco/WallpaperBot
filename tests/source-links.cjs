const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual Worker helpers without network calls or production data.
const source = fs.readFileSync('src/index.ts', 'utf8') +
  '\nexports.testHelpers = { parseXPostLink, buildChannelCaption, showPublishedHistoryForLink };';
const calls = [];
const sandbox = {
  exports: {}, require: () => ({}), URL, console,
  fetch: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  },
};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, sandbox);
const { parseXPostLink, buildChannelCaption, showPublishedHistoryForLink } = sandbox.exports.testHelpers;
const base = 'https://x.com/syokumura/status/2104873781105967255';
for (const suffix of ['', '/', '/photo/1', '/photo/4?foo=bar#test', '/video/1', '?s=20', '#test']) {
  const parsed = parseXPostLink(base + suffix);
  assert.equal(parsed.canonicalUrl, base);
  assert.equal(parsed.postId, '2104873781105967255');
}
assert.equal(parseXPostLink(base.replace('x.com', 'mobile.twitter.com') + '/photo/1').canonicalUrl, base);
assert.equal(parseXPostLink('https://x.com/i/web/status/123/photo/1').canonicalUrl, 'https://x.com/i/web/status/123');
for (const invalid of ['https://example.com/a/status/123', 'https://x.com/a/status/123abc', 'not a link']) {
  assert.equal(parseXPostLink(invalid), null);
}
assert.ok(buildChannelCaption('artist', base + '/photo/1', '@channel').includes(`Link: ${base}\n`));

(async () => {
  let record = { id: 'published-id' };
  const env = { TELEGRAM_BOT_TOKEN: 'test', WALLPAPERBOT_DB: {
    prepare(sql) {
      assert.ok(sql.includes("status = 'published'"));
      return { bind(id) {
        assert.equal(id, '2104873781105967255');
        return { first: async () => record };
      } };
    },
    batch() { throw new Error('Selection must not delete records'); },
  } };
  await showPublishedHistoryForLink(1, base + '/photo/1', env);
  assert.ok(calls.at(-1).text.includes(base));
  assert.ok(!calls.at(-1).text.includes('/photo/1'));
  assert.equal(calls.at(-1).reply_markup.inline_keyboard[0][0].callback_data, 'd:published-id');
  record = null;
  await showPublishedHistoryForLink(1, base, env);
  assert.ok(calls.at(-1).text.includes('queue is unchanged'));
  await showPublishedHistoryForLink(1, 'invalid', env);
  assert.ok(calls.at(-1).text.includes('valid X post link'));
  console.log('Source normalization, caption, and targeted history selection tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
