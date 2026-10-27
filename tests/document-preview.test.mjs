import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {isLocalDocument,htmlReferences,htmlPreviewUrl} from '../public/html-links.js';
import {HtmlPreviewReader} from '../src/html-preview.mjs';
import {renderDocument} from '../src/document-preview.mjs';
import {createMediaFixture} from './media-fixture.mjs';

test('local document links retain exact authorization and support spaces, parentheses, Windows drive prefixes and line suffixes',()=>{
  for(const ref of ['/D:/学习 (一)/第001课.md','C:\\notes\\中文笔记.markdown','notes/todo.txt','/D:/项目/方案.md:9']){
    assert.equal(isLocalDocument(ref),true);
    assert.deepEqual(htmlReferences('[阅读](<'+ref+'>)'),[ref]);
    const url=htmlPreviewUrl('chat',ref);
    assert.equal(decodeURIComponent(Buffer.from(url.split('/')[5],'base64url').toString()),ref);
    assert.doesNotMatch(decodeURIComponent(url.split('/').at(-1)),/:9$/);
  }
  for(const ref of ['https://example.test/a.md','javascript:evil.md','data:evil.txt','C:/notes/program.exe'])assert.equal(isLocalDocument(ref),false);
});

test('document reader formats Markdown without executing raw HTML or fetching images and local links',()=>{
  const html=renderDocument('# 标题\n\n1. 一\n2. 二\n\n| 名称 | 数值 |\n| --- | --- |\n| 检查 | 1 |\n\n<script>alert(1)</script>\n\n![照片](https://example.test/photo.png)\n\n[内部](/api/bootstrap)\n\n[视频](https://example.test/video)','笔记.md');
  assert.match(html,/<h1>标题<\/h1>/);assert.match(html,/<ol><li>一<\/li><li>二<\/li><\/ol>/);assert.match(html,/<table>/);
  assert.doesNotMatch(html,/<script|<img|href="\/api\/bootstrap/);assert.match(html,/&lt;script&gt;/);assert.match(html,/href="https:\/\/example.test\/video/);
  assert.match(renderDocument('# 原文','notes.txt',{plain:true}),/<pre># 原文<\/pre>/);
});

test('document preview is on demand, authenticated, chunked and limited to the conversation file',{timeout:20000},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-document-')),file=path.join(directory,'学习 (001).md');
  await fs.writeFile(file,'# 学习笔记\n\n正文中文。\n\n[其他](private.txt)');
  await fs.writeFile(path.join(directory,'private.txt'),'secret');
  const fixture=await createMediaFixture({directory,files:[file]});
  t.after(async()=>{await fixture.close();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  assert.equal(fixture.requests.length,0);
  const url=new URL(htmlPreviewUrl(fixture.session.id,file),fixture.base);
  assert.equal((await fetch(url,{headers:{'x-forwarded-proto':'https'}})).status,401);assert.equal(fixture.requests.length,0);
  const result=await fetch(url);assert.equal(result.status,200);assert.match(result.headers.get('content-type'),/^text\/html/);
  assert.match(result.headers.get('content-security-policy'),/script-src 'none'/);
  assert.match(await result.text(),/<h1>学习笔记<\/h1>/);
  assert.equal((await fetch(new URL('private.txt',url))).status,404);
  assert.equal((await fetch(new URL(htmlPreviewUrl(fixture.session.id,path.join(directory,'private.txt')),fixture.base))).status,403);
  const range=await fetch(url,{headers:{range:'bytes=0-19'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,20);
  await fixture.history('\n[行号](<'+file+':9>)');
  assert.equal((await fetch(fixture.base+htmlPreviewUrl(fixture.session.id,file+':9'))).status,200);
  assert.equal((await fetch(fixture.base+htmlPreviewUrl(fixture.session.id,file,{interactive:true}))).headers.get('content-security-policy'),result.headers.get('content-security-policy'));
});

test('reader rejects forged approval, binary or oversized text, bad ranges and stale versions',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-document-bounds-')),file=path.join(directory,'note.md'),reader=new HtmlPreviewReader();
  t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  await fs.writeFile(file,'# Text');
  const command={ref:file,approvedRef:file,resource:path.basename(file),cwd:directory,action:'info'};
  await assert.rejects(reader.read({...command,approvedRef:'other'}),/没有出现在/);
  await assert.rejects(reader.read({...command,resource:'../note.md'}),/仅允许/);
  const info=await reader.read(command);
  await assert.rejects(reader.read({...command,action:'read',offset:-1}),/范围无效/);
  await fs.writeFile(file,'Changed Markdown content');
  await assert.rejects(reader.read({...command,version:info.version}),/已更新/);
  await fs.writeFile(file,Buffer.alloc(1024*1024+1,65));
  await assert.rejects(reader.read(command),/1 MB/);
  await fs.writeFile(file,Buffer.from([1,0,2]));
  await assert.rejects(reader.read(command),/文本文档/);
});
