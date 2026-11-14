import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkify, MAX_LINK_LENGTH, type ChatPart } from './linkify.js';

const links = (text: string) => linkify(text).filter((p) => p.kind === 'link').map((p) => (p as Extract<ChatPart, { kind: 'link' }>).href);

/** Rendering the parts back gives the original text, except that links show their normalized href. */
const render = (parts: ChatPart[]) => parts.map((p) => (p.kind === 'link' ? p.href : p.text)).join('');

test('plain text stays one text part', () => {
  assert.deepEqual(linkify('hello there'), [{ kind: 'text', text: 'hello there' }]);
  assert.deepEqual(linkify(''), []);
});

test('finds http and https links and splits around them', () => {
  const parts = linkify('see https://example.com/a?b=1#c and http://test.org now');
  assert.deepEqual(parts, [
    { kind: 'text', text: 'see ' },
    { kind: 'link', href: 'https://example.com/a?b=1#c', prefix: 'https://', host: 'example.com', rest: '/a?b=1#c' },
    { kind: 'text', text: ' and ' },
    { kind: 'link', href: 'http://test.org/', prefix: 'http://', host: 'test.org', rest: '/' },
    { kind: 'text', text: ' now' },
  ]);
});

test('every link part is prefix + host + rest', () => {
  for (const p of linkify('https://Example.COM:8443/x https://a.b/c?d#e')) {
    if (p.kind === 'link') assert.equal(p.prefix + p.host + p.rest, p.href);
  }
  assert.deepEqual(links('HTTPS://EXAMPLE.COM:8443/Path'), ['https://example.com:8443/Path']);
});

test('only http and https ever become links', () => {
  for (const text of [
    'javascript:alert(1)',
    'javascript://example.com/%0aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'mailto:someone@example.com',
    'ftp://example.com/file',
    'ws://example.com/socket',
    'example.com',
    'www.example.com',
  ]) {
    assert.deepEqual(links(text), [], text);
  }
  // Only the http(s) URL inside another scheme can be a link, and it shows as exactly that.
  assert.deepEqual(links('blob:https://example.com/uuid'), ['https://example.com/uuid']);
});

test('a URL inside another scheme is not taken apart into a link', () => {
  assert.deepEqual(links('git+https://example.com/repo'), []);
  assert.deepEqual(links('xhttps://example.com'), []);
  // A real http(s) URL right after other punctuation is fine.
  assert.deepEqual(links('view-source:https://example.com'), ['https://example.com/']);
  assert.deepEqual(links('(https://example.com)'), ['https://example.com/']);
});

test('trailing punctuation is not part of the link', () => {
  assert.deepEqual(links('go to https://example.com.'), ['https://example.com/']);
  assert.deepEqual(links('https://example.com/a, then'), ['https://example.com/a']);
  assert.deepEqual(links('is it https://example.com/x?'), ['https://example.com/x']);
  assert.deepEqual(links('wow https://example.com/x!!!'), ['https://example.com/x']);
  assert.deepEqual(links("'https://example.com/q'"), ['https://example.com/q']);
  assert.deepEqual(links('"https://example.com/q"'), ['https://example.com/q']);
  assert.deepEqual(links('https://example.com/a…'), ['https://example.com/a']);
  const parts = linkify('end: https://example.com.');
  assert.deepEqual(parts.at(-1), { kind: 'text', text: '.' });
});

test('unbalanced closing brackets are trimmed, balanced ones kept', () => {
  assert.deepEqual(links('(see https://example.com/a)'), ['https://example.com/a']);
  assert.deepEqual(links('https://en.wikipedia.org/wiki/Foo_(bar)'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(links('(https://en.wikipedia.org/wiki/Foo_(bar))'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.deepEqual(links('[https://example.com/x]'), ['https://example.com/x']);
  assert.deepEqual(links('{https://example.com/x}.'), ['https://example.com/x']);
  assert.deepEqual(links('https://example.com/a[1]'), ['https://example.com/a[1]']);
});

test('URLs end at whitespace, quotes, angle brackets and CJK punctuation', () => {
  assert.deepEqual(links('<https://example.com/a>'), ['https://example.com/a']);
  assert.deepEqual(links('https://example.com/a\nnext line'), ['https://example.com/a']);
  assert.deepEqual(links('请看https://example.com/a。谢谢'), ['https://example.com/a']);
  assert.deepEqual(links('リンク（https://example.com/b）です'), ['https://example.com/b']);
  assert.deepEqual(links('a https://x.org/1 b https://y.org/2'), ['https://x.org/1', 'https://y.org/2']);
});

test('internationalized hostnames are shown as punycode', () => {
  // Cyrillic small a (U+0430) in place of Latin "a": shown as punycode, so it can't pass as apple.com.
  const [link] = linkify('https://\u0430pple.com/login').filter((p) => p.kind === 'link');
  assert.ok(link && link.kind === 'link');
  assert.equal(link.host, 'xn--pple-43d.com');
  assert.equal(link.href, 'https://xn--pple-43d.com/login');
  assert.deepEqual(links('https://bücher.example/'), ['https://xn--bcher-kva.example/']);
});

test('the shown text is printable ASCII: non-ASCII, bidi and invisible characters are encoded', () => {
  for (const text of [
    'https://example.com/\u202egnp.exe',
    'https://example.com/a\u200bb',
    'https://example.com/日本?q=ü#ß',
  ]) {
    const [href] = links(text);
    assert.ok(href, text);
    assert.match(href, /^[\x21-\x7e]+$/, text);
  }
  assert.deepEqual(links('https://ja.wikipedia.org/wiki/日本'), ['https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC']);
});

test('links with a username or password stay text', () => {
  assert.deepEqual(links('https://yourbank.com@evil.example/login'), []);
  assert.deepEqual(links('https://user:pass@example.com/'), []);
  assert.deepEqual(links('https://:pass@example.com/'), []);
  // An @ in the path is fine.
  assert.deepEqual(links('https://social.example/@alice'), ['https://social.example/@alice']);
});

test('the href shows where a parser quirk really goes', () => {
  // Backslashes are path separators in http(s) URLs: the link visibly goes to evil.example.
  assert.deepEqual(links('https://evil.example\\@good.example'), ['https://evil.example/@good.example']);
  assert.deepEqual(links('https://0x7f.1/'), ['https://127.0.0.1/']);
});

test('broken or empty URLs stay text', () => {
  assert.deepEqual(links('https://'), []);
  assert.deepEqual(links('https://.'), []);
  assert.deepEqual(links('http://[::1'), []);
  assert.deepEqual(links('https://exa mple.com'), ['https://exa/']);
  assert.equal(render(linkify('broken https:// link')), 'broken https:// link');
});

test('overlong URLs stay text', () => {
  const long = `https://example.com/${'a'.repeat(MAX_LINK_LENGTH)}`;
  assert.deepEqual(linkify(long), [{ kind: 'text', text: long }]);
  const ok = `https://example.com/${'a'.repeat(MAX_LINK_LENGTH - 40)}`;
  assert.deepEqual(links(ok), [ok]);
});

test('text around links is preserved exactly', () => {
  const text = 'a\n\n  https://example.com/x  (and https://example.org/y)!\tend';
  assert.equal(render(linkify(text)), text);
});

test('pathological input stays fast', () => {
  const start = Date.now();
  linkify(`https://example.com/${')'.repeat(5000)}`);
  linkify(`${'https://'.repeat(600)}`);
  linkify(`https://a.b/${'('.repeat(2500)}${')'.repeat(2500)}`);
  assert.ok(Date.now() - start < 500);
});
