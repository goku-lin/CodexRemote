import test from 'node:test';import assert from 'node:assert/strict';import {readFile}from'node:fs/promises';import {fileURLToPath}from'node:url';import path from'node:path';
import {appIconThemes,appIconTheme,resolveAppIcon}from'../public/app-icon-themes.js';
import {applicationIcon,applicationManifest,applicationWorker}from'../src/app-shell.mjs';
const publicDir=fileURLToPath(new URL('../public',import.meta.url));

test('computer labels select distinct icon colors and badges, and explicit selection overrides detection',()=>{
  assert.equal(resolveAppIcon('台式机').id,'desktop');assert.equal(resolveAppIcon('笔记本').id,'laptop');
  assert.notEqual(resolveAppIcon('台式机').color,resolveAppIcon('笔记本').color);assert.notEqual(resolveAppIcon('台式机').badge,resolveAppIcon('笔记本').badge);
  assert.equal(resolveAppIcon('办公室电脑').id,'office');assert.equal(resolveAppIcon('家里电脑').id,'home');
  assert.equal(resolveAppIcon('未知电脑','auto','LAPTOP-TEST').id,'laptop');assert.equal(resolveAppIcon('台式机','auto','LAPTOP-TEST').id,'desktop');
  assert.equal(resolveAppIcon('笔记本','office').id,'office');assert.throws(()=>appIconTheme('../../file'));
});

test('all install icons are ready-made PNG assets of the declared size with versioned identities',async()=>{
  const versions=new Set();
  for(const theme of appIconThemes){
    const icon=applicationIcon(publicDir,'name',theme.id),manifest=applicationManifest(publicDir,'name',theme.id);versions.add(icon.version);
    assert.match(icon.small,/\?v=[a-f0-9]{16}$/);assert.equal(manifest.icons[0].src,icon.small);assert.equal(manifest.id,'/');
    for(const size of [192,512]){const png=await readFile(path.join(publicDir,`app-icon-${theme.id}-${size}.png`));assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);}
    assert.match(await readFile(path.join(publicDir,`app-icon-${theme.id}-icon.svg`),'utf8'),new RegExp(theme.badge));
  }
  assert.equal(versions.size,appIconThemes.length);
});

test('identity changes refresh the cached page shell and background notifications use the computer icon',()=>{
  const blue=applicationIcon(publicDir,'台式机'),purple=applicationIcon(publicDir,'笔记本');
  const first=applicationWorker(publicDir,blue.version,blue.small),second=applicationWorker(publicDir,purple.version,purple.small);
  assert.notEqual(first.match(/SHELL_CACHE='([^']+)'/)[1],second.match(/SHELL_CACHE='([^']+)'/)[1]);
  assert.ok(first.includes('const APP_NOTIFICATION_ICON='+JSON.stringify(blue.small)));
  const assets=JSON.parse(first.match(/const SHELL_ASSETS=(\[[^;]+\]);/)[1]);assert.ok(!assets.includes('/app-icon-laptop-192.png'),'identity images must use current network assets instead of generic shell cache');
});
