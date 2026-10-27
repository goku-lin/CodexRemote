import test from 'node:test';
import assert from 'node:assert/strict';
import {renderChatgptMarkdown} from '../public/chatgpt-markdown.js';

test('ChatGPT messages render common Markdown and hide internal reference markers',()=>{
  const html=renderChatgptMarkdown('# 标题\n\n- **重点**\n- `代码`\n\n```js\nconst value = 1;\n```\n\n[官方文档](https://example.com) :chatgpt-content-reference{index="0"}');
  assert.match(html,/<h1>标题<\/h1>/);
  assert.match(html,/<ul>[\s\S]*<strong>重点<\/strong>[\s\S]*<code>代码<\/code>[\s\S]*<\/ul>/);
  assert.match(html,/<pre><code>const value = 1;<\/code><\/pre>/);
  assert.match(html,/<a href="https:\/\/example\.com"/);
  assert.doesNotMatch(html,/chatgpt-content-reference/);
});

test('ChatGPT Markdown escapes HTML and rejects unsafe links',()=>{
  const html=renderChatgptMarkdown('<script>alert(1)</script>\n\n[javascript](javascript:alert(1))');
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html,/javascript:alert/);
  assert.doesNotMatch(html,/<script>/);
});
