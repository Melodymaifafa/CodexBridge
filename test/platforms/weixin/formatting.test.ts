import assert from 'node:assert/strict';
import test from 'node:test';
import { formatWeixinText, splitWeixinText } from '../../../src/platforms/weixin/formatting.js';

test('formatWeixinText applies official markdown filtering before local heading rewrite', () => {
  const formatted = formatWeixinText('# 标题\n\n![alt](https://example.com/a.png)\n\n中文*强调*和English *italic*');

  assert.equal(formatted, '【标题】\n\n中文强调和English *italic*');
});

test('formatWeixinText keeps fenced code blocks intact while rewriting headings outside fences', () => {
  const formatted = formatWeixinText('# 外部标题\n\n```md\n# 内部标题\n```\n\n## 次标题');

  assert.equal(formatted, '【外部标题】\n\n```md\n# 内部标题\n```\n\n**次标题**');
});

// `weixin send` resumes a partly delivered digest by replaying the FULL text
// with a skip offset, never by re-sending the leftover segments on their own.
// This is why: a segment cut out of an oversized code fence no longer carries
// the opening fence, so a second formatting pass rewrites its `#` lines into
// 【...】 and the segment grows back over the limit.
test('splitWeixinText does not round-trip a segment taken from inside a code fence', () => {
  const limit = 2048;
  const fence = ['```bash'];
  for (let index = 0; index < 120; index += 1) {
    fence.push(`# 注释 ${index}，夹在代码块里的 # 开头行不应被重写`);
    fence.push(`echo "step ${index}"`);
  }
  fence.push('```');
  const digest = [
    '# Linear 早报',
    '',
    ...Array.from({ length: 40 }, (_, index) => `- MEL-${index}：一条足够长的中文标题，用来把整份早报推过分段门槛。`),
    '',
    '## 次标题',
    ...fence,
  ].join('\n');

  const segments = splitWeixinText(formatWeixinText(digest), limit);
  const orphaned = segments.find((segment) => segment.startsWith('# '));

  assert.ok(orphaned, 'a segment must start inside the fence, without the opening marker');
  const reformatted = splitWeixinText(formatWeixinText(orphaned), limit);
  assert.notDeepEqual(reformatted, [orphaned]);
  assert.ok(reformatted.length > 1, 'the rewritten segment no longer fits the limit');
});
