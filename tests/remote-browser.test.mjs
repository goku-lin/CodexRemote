import test from 'node:test';
import assert from 'node:assert/strict';
import {safeChatGptUrl} from '../src/remote-browser.mjs';

test('remote browser only accepts official ChatGPT origins',()=>{
  assert.equal(safeChatGptUrl('https://chatgpt.com/'), 'https://chatgpt.com/');
  assert.throws(()=>safeChatGptUrl('https://example.com/'), /官方网页/);
  assert.throws(()=>safeChatGptUrl('javascript:alert(1)'), /官方网页/);
});
