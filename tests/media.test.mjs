import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MediaReader,MEDIA_CHUNK_BYTES} from '../src/media-reader.mjs';
import {mediaRange} from '../src/media-http.mjs';
import {authorizedMediaSource,mediaReferences,mediaDataUrl} from '../src/media.mjs';
import {MediaCards} from '../public/media-cards.js';

test('media refs retain local audio/video links and require conversation authorization',()=>{
  const refs=mediaReferences('[声音](<D:/with spaces/music.mp3>)\n[视频](file:///D:/clip.mp4)\n[图片](D:/image.webp)\n[网页](https://example.com)');
  assert.deepEqual(refs,['D:/image.webp','D:/with spaces/music.mp3','file:///D:/clip.mp4']);
  assert.deepEqual(authorizedMediaSource(refs[1],null,refs[1]),{path:refs[1]});
  assert.throws(()=>authorizedMediaSource('D:/not-listed.mp3',null,null));
  assert.throws(()=>authorizedMediaSource('https://internal/secret.mp3',null,'https://internal/secret.mp3'));
  assert.throws(()=>authorizedMediaSource('javascript:secret.mp3',null,'javascript:secret.mp3'));
});

test('ranges are bounded and include suffix/seek requests while invalid ranges fail',()=>{
  const size=4*MEDIA_CHUNK_BYTES;
  assert.deepEqual(mediaRange('bytes=0-',size),{start:0,end:MEDIA_CHUNK_BYTES-1});
  assert.deepEqual(mediaRange('bytes=100-200',size),{start:100,end:200});
  assert.deepEqual(mediaRange('bytes=-100',size),{start:size-100,end:size-1});
  for(const value of ['bytes=8-3','bytes=-0','bytes=999999999-','bytes=0-1,3-4','bytes=a-b','bytes=-'])assert.throws(()=>mediaRange(value,size));
});

test('media metadata reads only headers and chunks stay bounded, rejecting changed files',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-media-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  const file=path.join(directory,'music.mp3'),bytes=Buffer.alloc(3*MEDIA_CHUNK_BYTES,17);bytes.write('ID3');await writeFile(file,bytes);
  const reader=new MediaReader(),source={path:file};
  const info=await reader.read(source,directory,file);assert.equal(info.size,bytes.length);assert.equal(info.mime,'audio/mpeg');assert.ok(!info.body);
  const chunk=await reader.read(source,directory,file,{action:'read',offset:500,length:100,version:info.version});
  assert.deepEqual(Buffer.from(chunk.body,'base64'),bytes.subarray(500,600));
  await assert.rejects(reader.read(source,directory,file,{action:'read',length:MEDIA_CHUNK_BYTES+1}));
  await writeFile(file,Buffer.concat([bytes,Buffer.from('changed')]));
  await assert.rejects(reader.read(source,directory,file,{action:'read',version:info.version}),/已更新/);
});

test('Windows drive-prefixed attachments share path handling across previews, originals, legacy reads and audio/video',{skip:process.platform!=='win32'},async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-media-drive-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l0AAAAASUVORK5CYII=','base64');
  const files=[['脸型 对照.png',png,'image/png'],['voice.mp3',Buffer.from('ID3audio'),'audio/mpeg'],['clip.mp4',Buffer.from('0000ftypvideo'),'video/mp4']];
  const preview=Buffer.from('RIFFxxxxWEBPpreview'),reader=new MediaReader({thumbnail:async bytes=>{assert.deepEqual(bytes,png);return preview;}});
  const cwd=path.parse(directory).root[0].toLowerCase()==='z' ? 'Y:\\other-project' : 'Z:\\other-project';
  for(const [name,bytes,mime] of files){
    const file=path.join(directory,name);await writeFile(file,bytes);const ref='/'+file.replaceAll('\\','/');
    const source=authorizedMediaSource(ref,null,ref),info=await reader.read(source,cwd,ref);
    assert.equal(info.mime,mime);assert.equal(info.size,bytes.length);
    const original=await reader.read(source,cwd,ref,{action:'read',version:info.version});assert.deepEqual(Buffer.from(original.body,'base64'),bytes);
    assert.throws(()=>authorizedMediaSource(ref,null,file),'normalization cannot approve a different reference');
    if(mime==='image/png'){
      assert.deepEqual(Buffer.from((await reader.read(source,cwd,ref,{action:'preview'})).body,'base64'),preview);
      assert.equal(await mediaDataUrl(source,cwd),'data:image/png;base64,'+png.toString('base64'));
    }
  }
});

test('image preview jobs coalesce, cache bytes are bounded, and failures never return originals',async()=>{
  const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l0AAAAASUVORK5CYII=';
  const preview=Buffer.from('RIFFxxxxWEBPpreview');let calls=0,release;
  const gate=new Promise(resolve=>release=resolve);
  const reader=new MediaReader({thumbnail:async()=>{calls++;await gate;return preview;},maxEntries:1,maxBytes:20});
  const a=reader.read({dataUrl:image},'','image.png',{action:'preview'}),b=reader.read({dataUrl:image},'','image.png',{action:'preview'});
  release();const [first,second]=await Promise.all([a,b]);assert.equal(calls,1);assert.equal(first.body,second.body);assert.equal(first.size,preview.length);
  await reader.read({dataUrl:image},'','image.png',{action:'preview'});assert.equal(calls,1);assert.ok(reader.bytes<=20);
  const broken=new MediaReader({thumbnail:async()=>{throw new Error('converter unavailable');}});
  await assert.rejects(broken.read({dataUrl:image},'','image.png',{action:'preview'}),/converter unavailable/);
  assert.equal(broken.pending.size,0);
});

test('images default to lazy compressed thumbnails; audio and video wait for explicit playback',async()=>{
  let requests=0,resolves=0,changes=0,session='a';
  const cards=new MediaCards({sessionId:()=>session,path:ref=>'/api/sessions/a/media?ref='+encodeURIComponent(ref),request:async()=>{requests++;return {size:123456,mime:'audio/mpeg'};},resolveImage:url=>{resolves++;return url;},onChange:()=>changes++,maxEntries:2});
  for(let n=0;n<100;n++){
    const html=cards.render('D:/image'+n+'.png');
    assert.match(html,/<img[^>]+src="[^"]+[?&](?:amp;)?preview=1"[^>]+loading="lazy"[^>]+decoding="async"/);
    assert.match(html,/class="media-thumbnail"[^>]+href="[^"]+"[^>]+target="_blank"/);
    assert.match(html,/打开原图/);assert.doesNotMatch(html,/小图预览|下载/);
  }
  assert.doesNotMatch(cards.render('D:/movie.mp4'),/<video|src=/);
  const ref='D:/sound.mp3',html=cards.render(ref);assert.doesNotMatch(html,/<audio|src=/);assert.equal(requests,0);assert.equal(resolves,0);assert.equal(cards.items.size,0);
  const key=encodeURIComponent(JSON.stringify([session,ref]));
  await cards.activate(key,'play');assert.equal(requests,1);assert.match(cards.render(ref),/<audio controls preload="none" src=/);
  await cards.activate(key,'close');assert.doesNotMatch(cards.render(ref),/<audio|src=/);
  for(let n=0;n<10;n++)await cards.activate(encodeURIComponent(JSON.stringify([session,'D:/sound'+n+'.mp3'])),'play');
  assert.ok(cards.items.size<=2);assert.ok(changes>0);
  session='b';assert.doesNotMatch(cards.render(ref),/<audio|src=/);
});

test('failed automatic thumbnails offer a retry without silently fetching original bytes',async()=>{
  let changes=0,requests=0;
  const ref='D:/image.png',key=encodeURIComponent(JSON.stringify(['a',ref]));
  const cards=new MediaCards({sessionId:()=> 'a',path:()=>'/api/sessions/a/media?ref=image.png',request:async()=>requests++,onChange:()=>changes++});
  const fallback={hidden:true},image={closest:()=>({dataset:{mediaKey:key},querySelectorAll:()=>[fallback]})};
  cards.bind({querySelectorAll:selector=>selector==='[data-media-image]' ? [image] : []});
  image.onerror();image.onerror();assert.equal(changes,0);assert.equal(image.hidden,true);assert.equal(fallback.hidden,false);
  const failed=cards.render(ref);assert.doesNotMatch(failed,/<img/);assert.match(failed,/重试缩略图/);assert.match(failed,/打开原图/);
  await cards.activate(key,'preview');const retried=cards.render(ref);
  assert.match(retried,/<img[^>]+src="[^"]+preview=1&amp;retry=1"/);assert.equal(requests,0);
});

test('a burst of different thumbnails queues at most two converters and a failed job releases its slot',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-preview-queue-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());await rm(directory,{recursive:true,force:true});});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l0AAAAASUVORK5CYII=','base64');
  const files=Array.from({length:6},(_,i)=>path.join(directory,i+'.png'));
  await Promise.all(files.map(file=>writeFile(file,png)));
  let active=0,peak=0,count=0;
  const reader=new MediaReader({thumbnail:async()=>{
    active++;peak=Math.max(peak,active);const index=count++;
    try{await new Promise(resolve=>setTimeout(resolve,15));if(index===0)throw new Error('bad preview');return Buffer.from('RIFFxxxxWEBPpreview');}
    finally{active--;}
  }});
  const results=await Promise.allSettled(files.map(file=>reader.read({path:file},directory,file,{action:'preview'})));
  assert.equal(peak,2);assert.equal(count,6);assert.equal(results.filter(result=>result.status==='fulfilled').length,5);
  assert.equal(reader.activePreviews,0);assert.equal(reader.previewQueue.length,0);assert.equal(reader.pending.size,0);
});

test('closing or switching during a media load cannot reopen the old player',async()=>{
  let session='a',release;
  const cards=new MediaCards({sessionId:()=>session,path:()=>'/api/media',onChange:()=>{},request:()=>new Promise(resolve=>release=resolve)});
  const key=encodeURIComponent(JSON.stringify(['a','D:/sound.mp3']));
  const loading=cards.activate(key,'play');await cards.activate(key,'close');release({size:1});await loading;
  assert.equal(cards.items.get(key).mode,null);
  const next=cards.activate(key,'play');session='b';release({size:1});await next;assert.equal(cards.items.get(key).loading,false);assert.equal(cards.items.get(key).mode,null);
});
