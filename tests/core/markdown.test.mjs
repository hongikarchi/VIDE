import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../../src/ui/markdown.ts';

test('AI answers draw headings, bold, lists, tables and code (T-189)', () => {
  const html = renderMarkdown(
    [
      '## 요약',
      '',
      '**굵게**와 *기울임*, `inline`',
      '',
      '- 하나',
      '- 둘',
      '',
      '| 층 | 면적 |',
      '|---|---:|',
      '| 1F | 120 |',
      '',
      '```python',
      'print(1 < 2)',
      '```',
      '',
      '> 인용',
    ].join('\n'),
  );
  assert.match(html, /<h2>요약<\/h2>/);
  assert.match(html, /<strong>굵게<\/strong>/);
  assert.match(html, /<em>기울임<\/em>/);
  assert.match(html, /<code>inline<\/code>/);
  assert.match(html, /<ul>\s*<li>하나<\/li>/);
  assert.match(html, /<div class="md-table"><table>/);
  assert.match(html, /<th>층<\/th>/);
  assert.match(html, /<td style="text-align:right">120<\/td>/);
  assert.match(html, /<pre><code class="language-python">print\(1 &lt; 2\)/);
  assert.match(html, /<blockquote>/);
  assert.doesNotMatch(html, /\*\*|\|---/);
});

test('raw HTML stays text and unsafe links are not links (T-189)', () => {
  const html = renderMarkdown(
    '<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n' +
      '[나쁜](javascript:alert(1)) [데이터](data:text/html,x) [좋은](https://example.com) ' +
      '[메일](mailto:a@example.com) ![그림](https://example.com/a.png)',
  );
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /href="(javascript|data):/i);
  assert.match(html, /\[나쁜\]\(javascript:alert\(1\)\)/);
  assert.match(
    html,
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">좋은<\/a>/,
  );
  assert.match(html, /href="mailto:a@example\.com"/);
});
