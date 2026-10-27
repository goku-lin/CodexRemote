import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('user and assistant messages expose one-click copy controls',async()=>{
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(source,/data-copy-message/);
  assert.match(source,/navigator\.clipboard\?\.writeText/);
  assert.match(source,/复制问题/);
  assert.match(source,/复制回答/);
});
