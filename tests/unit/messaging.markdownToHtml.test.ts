import { describe, expect, it } from 'vitest';
import { markdownToTelegramHtml, escapeHtml } from '../../src/messaging/markdownToHtml.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('<b> & "quoted" \'single\'')).toBe(
      '&lt;b&gt; &amp; &quot;quoted&quot; &#39;single&#39;',
    );
  });
});

describe('markdownToTelegramHtml', () => {
  it('converts **bold** to <b>', () => {
    expect(markdownToTelegramHtml('this is **bold**')).toBe('this is <b>bold</b>');
  });

  it('converts _italic_ to <i>', () => {
    expect(markdownToTelegramHtml('this is _italic_')).toBe('this is <i>italic</i>');
  });

  // v1.21.10 regression: @-mentions must not be mangled by italic parsing.
  // @your_tony_bot was being converted to @ai<i>Tony</i>Stark_bot,
  // breaking the Telegram mention entity.
  it('preserves underscore-bearing @-mentions through markdown processing', () => {
    expect(markdownToTelegramHtml('hi @your_tony_bot, please check'))
      .toBe('hi @your_tony_bot, please check');
  });

  it('preserves @-mention even with bold around it', () => {
    expect(markdownToTelegramHtml('**urgent** @your_jarvis_bot ping'))
      .toBe('<b>urgent</b> @your_jarvis_bot ping');
  });

  it('converts single *asterisk* to bold (Telegram convention)', () => {
    expect(markdownToTelegramHtml('this is *bold*')).toBe('this is <b>bold</b>');
  });

  it('converts `inline code` to <code>', () => {
    expect(markdownToTelegramHtml('run `ls -la` now')).toBe('run <code>ls -la</code> now');
  });

  it('escapes HTML inside inline code', () => {
    expect(markdownToTelegramHtml('see `<script>`')).toBe('see <code>&lt;script&gt;</code>');
  });

  it('converts fenced code blocks to <pre>', () => {
    const md = '```\nhello\nworld\n```';
    expect(markdownToTelegramHtml(md)).toBe('<pre>hello\nworld</pre>');
  });

  it('escapes HTML inside fenced code blocks', () => {
    const md = '```\n<div>hi</div>\n```';
    expect(markdownToTelegramHtml(md)).toBe('<pre>&lt;div&gt;hi&lt;/div&gt;</pre>');
  });

  it('does not interpret markdown inside code', () => {
    // **bold** inside a fenced block stays literal.
    const md = '```\n**not bold**\n```';
    expect(markdownToTelegramHtml(md)).toBe('<pre>**not bold**</pre>');
  });

  it('converts links to <a>', () => {
    expect(markdownToTelegramHtml('see [anthropic](https://anthropic.com)')).toBe(
      'see <a href="https://anthropic.com">anthropic</a>',
    );
  });

  it('converts > blockquote lines', () => {
    const md = '> first line\n> second line';
    expect(markdownToTelegramHtml(md)).toBe('<blockquote>first line\nsecond line</blockquote>');
  });

  it('escapes stray HTML in prose', () => {
    expect(markdownToTelegramHtml('see <script>alert(1)</script>')).toBe(
      'see &lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('handles a mixed realistic reply', () => {
    const md =
      'Done. Wrote **12 files** to `./dist/` — main entry is _src/index.ts_.\n\n```js\nconsole.log("hi");\n```\n\nNext: check [the docs](https://example.com).';
    const html = markdownToTelegramHtml(md);
    expect(html).toContain('<b>12 files</b>');
    expect(html).toContain('<code>./dist/</code>');
    expect(html).toContain('<i>src/index.ts</i>');
    expect(html).toContain('<pre>console.log(&quot;hi&quot;);</pre>');
    expect(html).toContain('<a href="https://example.com">the docs</a>');
  });

  it('returns empty string on empty input', () => {
    expect(markdownToTelegramHtml('')).toBe('');
  });
});
