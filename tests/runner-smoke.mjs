// Opt-in: exercises real model inference in an ephemeral, read-only thread.
// Run with `node tests/runner-smoke.mjs`; this consumes one small model request.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

function blueImage() {
  const chunk = (name, data) => {
    const body=Buffer.concat([Buffer.from(name),data]); let crc=0xffffffff;
    for (const byte of body) { crc^=byte; for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
    const size=Buffer.alloc(4);size.writeUInt32BE(data.length);const checksum=Buffer.alloc(4);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([size,body,checksum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(96,0);header.writeUInt32BE(96,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc(96*(1+96*3));for(let y=0;y<96;y++)for(let x=0;x<96;x++){const offset=y*289+1+x*3;pixels[offset+1]=136;pixels[offset+2]=255;}
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}

const directory=await mkdtemp(path.join(os.tmpdir(),'codex-relay-smoke-'));
const image=blueImage();const imagePath=directory.replaceAll('\\','/')+'/blue.png';
await writeFile(imagePath,Buffer.from(image.split(',')[1],'base64'));
const token=randomBytes(24).toString('hex');
let stream; let child; let selected; let reply=''; let outputRef; let resolveResult; let rejectResult;
const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
const send=command=>stream.write('data: '+JSON.stringify(command)+'\n\n');
const server=http.createServer(async(req,res)=>{
  if(req.headers['x-codex-relay-token']!==token){res.writeHead(401);return res.end();}
  if(req.url.startsWith('/api/runner/smoke/commands')){
    res.writeHead(200,{'content-type':'text/event-stream'});stream=res;send({type:'readCatalog'});return;
  }
  let body='';for await(const bytes of req)body+=bytes;res.writeHead(202);res.end('{}');
  if(!req.url.endsWith('/events'))return;
  const event=JSON.parse(body);
  try {
    if(event.type==='catalog' && !selected){
      const models=event.catalog.models;selected=models.find(model=>model.model===(process.env.RELAY_SMOKE_MODEL || 'gpt-6.1-sol')) || models.find(model=>model.isDefault) || models[0];assert.ok(selected);
      console.log('Catalog ready: '+selected.model);
      send({type:'startThread',sessionId:'smoke',cwd:directory,model:selected.model,permission:'read-only',ephemeral:true});
    }
    if(event.rpcMethod==='thread/start'){
      console.log('Ephemeral thread ready');
      assert.equal(event.message.result.model,selected.model);assert.equal(event.message.result.sandbox.type,'readOnly');
      send({type:'startTurn',sessionId:'smoke',threadId:event.message.result.thread.id,cwd:directory,model:selected.model,effort:'low',permission:'read-only',
        input:[{type:'text',text:`这是一次 Relay 图像输入验证。用中文一小句描述附图主要颜色，然后原样附上已有图片引用：![测试图](${imagePath})。禁止运行命令、访问文件或使用任何工具。`},{type:'image',url:image}]});
    }
    if(event.message?.method==='item/completed' && event.message.params.item.type==='agentMessage') { reply=event.message.params.item.text;outputRef=event.message.params.item.images?.[0]?.ref; }
    if(event.message?.method==='runner/error')throw new Error(event.message.params.message);
    if(event.message?.method==='error')throw new Error(JSON.stringify({message:event.message.params.error?.message || event.message.params.message,codexErrorInfo:event.message.params.error?.codexErrorInfo,additionalDetails:event.message.params.error?.additionalDetails}));
    if(event.message?.method==='turn/started')console.log('Image turn started');
    if(event.message?.method==='turn/completed'){
      assert.equal(event.message.params.turn.status,'completed',JSON.stringify(event.message.params.turn.error));
      assert.match(reply,/蓝/);assert.equal(outputRef,imagePath);
      send({type:'readMedia',threadId:event.message.params.threadId,ref:outputRef,requestId:'smoke-image'});
    }
    if(event.type==='media'){assert.ok(!event.error,event.error);assert.equal(event.dataUrl,image);resolveResult({model:selected.model,permission:'read-only',effort:'low',imageRecognized:true,imageTransported:true});}
  }catch(error){rejectResult(error);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const timer=setTimeout(()=>rejectResult(new Error('Real Runner smoke test timed out')),60000);
try {
  child=spawn(process.execPath,['runner.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,CODEX_RELAY_SERVER:`http://127.0.0.1:${server.address().port}`,CODEX_RELAY_TOKEN:token,CODEX_RELAY_DEVICE_ID:'smoke',CODEX_RELAY_CWD:directory,CODEX_SESSIONS_DIR:directory},windowsHide:true,stdio:['ignore','ignore','pipe']});
  child.on('error',rejectResult);child.on('exit',code=>rejectResult(new Error('Runner exited: '+code)));
  console.log(JSON.stringify(await result));
} finally {
  clearTimeout(timer);stream?.destroy();server.closeAllConnections();server.close();
  if(child?.pid){if(process.platform==='win32')spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill();}
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});
}
