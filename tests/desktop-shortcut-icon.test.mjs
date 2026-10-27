import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('startup refreshes the desktop shortcut icon from the newest Codex package',async()=>{
  const script=await readFile(new URL('../scripts/刷新桌面图标.ps1',import.meta.url),'utf8');
  const startup=await readFile(new URL('../scripts/启动项目.ps1',import.meta.url),'utf8');
  assert.match(script,/Sort-Object \{ \[version\]\$_.Version \} -Descending/);
  assert.match(script,/ChatGPT\.exe/);
  assert.match(script,/Codex远程\.lnk/);
  assert.match(startup,/刷新桌面图标\.ps1/);
});
