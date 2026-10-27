import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageUploads} from '../public/uploads.js';
import {Drafts} from '../public/reliability.js';
import {hydrateImageInput} from '../src/input-media.mjs';

const id='12345678-1234-1234-1234-123456789abc';
const dataUrl='data:image/png;base64,iVBORw0KGgo=';
const file={name:'手机截图.png',type:'image/png',size:8};
const image={id,name:file.name,url:'/api/uploads/'+id};
function fixture(api){
  let stored='{}';const storage={getItem:()=>stored,setItem:(_key,value)=>stored=value};
  const drafts=new Drafts(storage);drafts.set('original',{text:'保留我的文字',attachments:[]});
  const uploads=new ImageUploads({api,drafts,read:async()=>dataUrl,newId:()=>id});
  return {uploads,drafts,storage,stored:()=>stored};
}

test('a lost upload response is confirmed by ID without a duplicate upload or silently losing the attachment',async()=>{
  const calls=[];const {uploads,drafts}=fixture(async(url,options)=>{calls.push({url,options});if(url==='/api/uploads')throw new Error('response lost');return {found:true,image};});
  await uploads.add('original',file);
  assert.equal(calls.length,0);assert.equal(uploads.list('original')[0].state,'selected');
  await uploads.upload('original');
  assert.deepEqual(drafts.get('original').attachments,[image]);assert.equal(drafts.get('original').text,'保留我的文字');assert.equal(uploads.tasks.size,0);
  assert.deepEqual(calls.map(call=>call.url),['/api/uploads',`/api/uploads/${id}/status`]);
  assert.equal(calls[0].options.timeoutMs,120000);assert.equal(JSON.parse(calls[0].options.body).requestId,id);
});

test('unconfirmed images remain retryable, preserve text and reuse the original upload ID',async()=>{
  let available=false;const ids=[];
  const {uploads,drafts,stored}=fixture(async(url,options)=>{
    if(url==='/api/uploads'){ids.push(JSON.parse(options.body).requestId);if(!available)throw new Error('timeout');return image;}
    return {found:false};
  });
  await uploads.add('original',file);
  await assert.rejects(uploads.upload('original'));
  assert.match(uploads.list('original')[0].error,/尚未上传完成/);assert.equal(drafts.get('original').attachments.length,0);
  assert.ok(!stored().includes('base64'));assert.equal(drafts.get('original').uploadJobs[0].id,id);
  available=true;await uploads.retry(id);assert.deepEqual(ids,[id,id]);assert.deepEqual(drafts.get('original').attachments,[image]);
});

test('after reload, upload confirmation recovers into the original draft without resending a model request',async()=>{
  const original=fixture(async()=>{throw new Error('network down');});await original.uploads.add('original',file);await assert.rejects(original.uploads.upload('original'));
  const drafts=new Drafts(original.storage),calls=[];
  drafts.set('different',{text:'另一条对话',attachments:[]});
  const restored=new ImageUploads({drafts,api:async url=>{calls.push(url);return {found:true,image};}});
  await restored.reconcile();await restored.reconcile();
  assert.deepEqual(calls,[`/api/uploads/${id}/status`]);assert.deepEqual(drafts.get('original').attachments,[image]);assert.equal(drafts.get('different').attachments.length,0);
  assert.equal(drafts.get('original').text,'保留我的文字');assert.equal(restored.busy,0);
});

test('missing upload bytes after reload require reselection and can be removed explicitly',async()=>{
  const {drafts}=fixture(async()=>{});drafts.set('original',{...drafts.get('original'),uploadJobs:[{id,name:file.name}]});
  const restored=new ImageUploads({drafts,api:async()=>({found:false})});await restored.reconcile();
  assert.match(restored.list('original')[0].error,/重新选择/);assert.equal(drafts.get('original').attachments.length,0);
  restored.remove(id);assert.equal(restored.list('original').length,0);assert.equal(drafts.get('original').text,'保留我的文字');
});

test('invalid or full attachment selections do not submit an upload',async()=>{
  let calls=0;const {uploads,drafts}=fixture(async()=>{calls++;});
  await assert.rejects(uploads.add('original',{...file,type:'text/plain'}));
  await assert.rejects(uploads.add('original',{...file,size:11*1024*1024}));
  drafts.set('original',{text:'',attachments:Array.from({length:5},()=>image)});
  await assert.rejects(uploads.add('original',file));assert.equal(calls,0);
});

test('local image selection and reload validation never contact the server before Send',async()=>{
  const files=new Map(),cache={put:async(id,file)=>files.set(id,file),get:async id=>files.get(id),delete:async id=>files.delete(id)};
  const {drafts,storage}=fixture(async()=>assert.fail('selection must stay local'));
  const uploads=new ImageUploads({api:async()=>assert.fail('selection must stay local'),drafts,files:cache,read:async()=>dataUrl,newId:()=>id});
  await uploads.add('original',file);assert.equal(uploads.list('original')[0].dataUrl,dataUrl);
  const restored=new ImageUploads({api:async()=>assert.fail('restoring a local draft must stay local'),drafts:new Drafts(storage),files:cache,read:async()=>dataUrl});
  await restored.reconcile();assert.equal(restored.list('original')[0].state,'selected');assert.equal(restored.list('original')[0].dataUrl,dataUrl);
  restored.remove(id);assert.ok(!files.has(id));
});

test('client image validation fails before upload and prevents the attachment stage from completing',async()=>{
  const {drafts}=fixture(async()=>assert.fail());
  const uploads=new ImageUploads({api:async()=>assert.fail(),drafts,read:async()=>{throw new Error('图片无效');},newId:()=>id});
  await uploads.add('original',file);assert.equal(uploads.list('original')[0].state,'error');
  await assert.rejects(uploads.upload('original'),/图片无效/);assert.equal(drafts.get('original').text,'保留我的文字');
});

test('Runner hydrates only validated upload identifiers, leaving existing inputs intact',async()=>{
  const input=[{type:'text',text:'请看图'},{type:'image',uploadId:id},{type:'image',url:dataUrl}];
  const calls=[];assert.deepEqual(await hydrateImageInput(input,async value=>{calls.push(value);return dataUrl;}),[{type:'text',text:'请看图'},{type:'image',url:dataUrl},{type:'image',url:dataUrl}]);
  assert.deepEqual(calls,[id]);assert.ok(!input[1].url);
  await assert.rejects(hydrateImageInput([{type:'image',uploadId:'../../private'}],async()=>assert.fail()));
  await assert.rejects(hydrateImageInput([{type:'image',uploadId:id}],async()=>'not an image'));
});
