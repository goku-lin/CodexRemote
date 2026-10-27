import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {isLocalHtml,htmlReferences,htmlPreviewUrl} from '../public/html-links.js';
import {HtmlPreviewReader} from '../src/html-preview.mjs';
import {createMediaFixture} from './media-fixture.mjs';
import {localRequest} from '../src/connector-node.mjs';
import {MEDIA_CHUNK_BYTES} from '../src/media-reader.mjs';

test('HTML links support Windows paths, spaces, Unicode and anchors without treating remote or executable URLs as local files',()=>{
  const ref='D:/工程/脸部 对比/review.html#motion',url=htmlPreviewUrl('chat',ref);
  assert.equal(decodeURIComponent(Buffer.from(url.split('/')[5],'base64url').toString()),ref);
  assert.ok(url.endsWith('/review.html#motion'));
  assert.deepEqual(htmlReferences('[查看](<'+ref+'>)'),[ref]);
  for(const value of ['https://example.test/page.html','javascript:evil.html','data:text/html,evil.html'])assert.equal(isLocalHtml(value),false);
});

test('native visualize cards and Markdown paths with parentheses share the exact authorized HTML reference',()=>{
  const ref='D:/Program Files (x86)/Steam/Mods/[MTK]Core/Preview/ability-effects.html';
  const marker='visualize'+JSON.stringify({path:ref})+'';
  assert.deepEqual(htmlReferences(marker),[ref]);
  assert.deepEqual(htmlReferences('[查看动画]('+ref+')'),[ref]);
  assert.deepEqual(htmlReferences('visualize{"path":"https://example.test/report.html"}'),[]);
  assert.deepEqual(htmlReferences('visualize{"path":123}'),[]);
  assert.match(htmlPreviewUrl('chat',ref+'#effect',{interactive:true}),/\?interactive=1#effect$/);
});

test('interactive preview is opt-in and runs inline scripts without origin access or outbound requests',{timeout:15000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-html-interactive-')),report=path.join(directory,'effect (v2).html');
  const html='<canvas id="effect"></canvas><script>document.querySelector("canvas").dataset.loaded="yes"</script>';
  await writeFile(report,html);const fixture=await createMediaFixture({directory,files:[]});
  t.after(async()=>{await fixture.close();assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  await fixture.history('\nvisualize'+JSON.stringify({path:report})+'');
  assert.equal(fixture.requests.length,0);
  const url=new URL(htmlPreviewUrl(fixture.session.id,report,{interactive:true}),fixture.base);
  const response=await fetch(url);assert.equal(response.status,200);assert.equal(await response.text(),html);
  const policy=response.headers.get('content-security-policy');
  assert.match(policy,/sandbox allow-scripts;/);assert.doesNotMatch(policy,/allow-same-origin|allow-popups|allow-top-navigation/);
  assert.match(policy,/script-src 'unsafe-inline';/);assert.match(policy,/connect-src 'none';/);
  const staticPage=await fetch(fixture.base+htmlPreviewUrl(fixture.session.id,report));
  assert.match(staticPage.headers.get('content-security-policy'),/script-src 'none'/);
  const unknown=htmlPreviewUrl(fixture.session.id,path.join(directory,'private.html'),{interactive:true});
  assert.equal((await fetch(fixture.base+unknown)).status,403);
});

test('HTML preview sends its relative images and GIFs on demand while keeping unmentioned files and other conversations private',{timeout:15000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-html-preview-')),reportDir=path.join(directory,'report');await mkdir(path.join(reportDir,'images'),{recursive:true});
  const report=path.join(reportDir,'review.html'),gif=Buffer.alloc(2*MEDIA_CHUNK_BYTES,6);gif.write('GIF89a');
  const html='<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="style.css"><h1>脸部预览</h1><img loading="lazy" src="images/motion.gif"><a href="#motion">动图</a><a href="result.json">验证</a><script>fetch("/api/bootstrap")</script>';
  await writeFile(report,html);await writeFile(path.join(reportDir,'images','motion.gif'),gif);await writeFile(path.join(reportDir,'style.css'),'body{color:red;background:url("images/bg.png")}');
  await writeFile(path.join(reportDir,'images','bg.png'),Buffer.from('PNG-placeholder'));await writeFile(path.join(reportDir,'result.json'),'{}');await writeFile(path.join(reportDir,'private.json'),'secret');
  const fixture=await createMediaFixture({directory,files:[report]});
  t.after(async()=>{await fixture.close();assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  const url=new URL(htmlPreviewUrl(fixture.session.id,report),fixture.base);
  assert.equal(fixture.requests.length,0,'synchronizing history does not fetch HTML or its images');
  assert.equal((await fetch(url,{headers:{'x-forwarded-proto':'https'}})).status,401);assert.equal(fixture.requests.length,0);
  const page=await fetch(url);assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/^text\/html; charset=utf-8$/);assert.match(page.headers.get('content-security-policy'),/script-src 'none'/);assert.equal(await page.text(),html);
  const image=await fetch(new URL('images/motion.gif',url));assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/gif');assert.deepEqual(Buffer.from(await image.arrayBuffer()),gif);
  const css=await fetch(new URL('style.css',url));assert.equal(css.status,200);assert.match(await css.text(),/background/);
  assert.equal((await fetch(new URL('images/bg.png',url))).status,200);
  assert.equal((await fetch(new URL('private.json',url))).status,404);assert.equal((await fetch(new URL('result.json',url))).status,200);
  const unknown=htmlPreviewUrl(fixture.session.id,path.join(reportDir,'other.html'));assert.equal((await fetch(fixture.base+unknown)).status,403);
  const proxied=await localRequest(fixture.base,{path:url.pathname});assert.match(proxied.headers['content-security-policy'],/script-src 'none'/);assert.equal(proxied.headers['referrer-policy'],'no-referrer');
  assert.ok(fixture.requests.filter(item=>item.action==='read').every(item=>item.length<=MEDIA_CHUNK_BYTES));
});

test('preview rejects traversal, symlinks outside the report folder and forged approval',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-html-bounds-')),root=path.join(directory,'report');await mkdir(root);
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  await mkdir(path.join(directory,'outside'));await writeFile(path.join(directory,'outside','secret.json'),'secret');
  await symlink(path.join(directory,'outside'),path.join(root,'linked'),'junction');
  const report=path.join(root,'review.html');await writeFile(report,'<a href="linked/secret.json">外部</a><a href="../outside/secret.json">越界</a>');
  const reader=new HtmlPreviewReader(),command={ref:report,approvedRef:report,cwd:directory,action:'info'};
  await assert.rejects(reader.read({...command,approvedRef:'other',resource:'review.html'}));
  await assert.rejects(reader.read({...command,resource:'../outside/secret.json'}));
  await assert.rejects(reader.read({...command,resource:'linked/secret.json'}));
  const info=await reader.read({...command,resource:'review.html'});assert.equal(info.mime,'text/html');
});

test('Windows preview resolves a slash-prefixed drive from another working drive and preserves exact approval',{skip:process.platform!=='win32'},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-html-drive-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  const report=path.join(directory,'脸型 对照.html');await writeFile(report,'<h1>脸型对照</h1>');
  const reader=new HtmlPreviewReader(),absolute=report.replaceAll('\\','/'),rooted='/'+absolute;
  const cwd=path.parse(report).root[0].toLowerCase()==='z' ? 'Y:\\other-project' : 'Z:\\other-project';
  for(const ref of [absolute,report,rooted,'\\'+report,pathToFileURL(report).href]){
    const info=await reader.read({ref,approvedRef:ref,cwd,resource:path.basename(report),action:'info'});
    assert.equal(info.mime,'text/html');
  }
  await assert.rejects(reader.read({ref:rooted,approvedRef:absolute,cwd,resource:path.basename(report),action:'info'}),/没有出现在/);
});

test('an existing slash-prefixed Windows HTML link opens through the authenticated preview route',{skip:process.platform!=='win32',timeout:15000},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-html-rooted-link-')),report=path.join(directory,'review.html');
  const html='<h1>四项独立效果</h1><img src="side.png">';await writeFile(report,html);await writeFile(path.join(directory,'side.png'),'test image');
  const ref='/'+report.replaceAll('\\','/'),fixture=await createMediaFixture({directory,files:[ref]});
  t.after(async()=>{await fixture.close();assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  const url=new URL(htmlPreviewUrl(fixture.session.id,ref),fixture.base),response=await fetch(url);
  assert.equal(response.status,200);assert.equal(await response.text(),html);
  assert.match(response.headers.get('content-security-policy'),/script-src 'none'/);
  assert.equal((await fetch(new URL('side.png',url))).status,200);
  assert.equal((await fetch(new URL('private.json',url))).status,404);
});
