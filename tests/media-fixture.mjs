import {spawn} from 'node:child_process';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {MediaReader} from '../src/media-reader.mjs';
import {authorizedMediaSource} from '../src/media.mjs';
import {HtmlPreviewReader} from '../src/html-preview.mjs';

export async function createMediaFixture({directory,files,thumbnail,proofPanel=false,ownership}) {
  const root=fileURLToPath(new URL('..',import.meta.url)),reservation=createNetServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_TOKEN:'isolated-media-fixture',CODEX_RELAY_DATA_DIR:path.join(directory,'data'),CODEX_RELAY_PARENT_PIPE:'0'},stdio:['ignore','pipe','pipe']});
  let output='';child.stderr.on('data',chunk=>output+=chunk);
  await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',chunk=>{if(String(chunk).includes('listening'))resolve();});child.once('exit',()=>reject(new Error(output)));});
  const base=`http://127.0.0.1:${port}`,headers={'content-type':'application/json','x-codex-relay-token':'isolated-media-fixture'};
  const post=async body=>{const response=await fetch(base+'/api/runner/local/events',{method:'POST',headers,body:JSON.stringify(body)});if(!response.ok)throw new Error(await response.text());};
  const requests=[],reader=new MediaReader(thumbnail ? {thumbnail} : {}),htmlReader=new HtmlPreviewReader(),abort=new AbortController();
  const stream=await fetch(base+'/api/runner/local/commands',{headers,signal:abort.signal});
  let buffer='';
  const consume=(async()=>{for await(const chunk of stream.body){buffer+=new TextDecoder().decode(chunk);const frames=buffer.split('\n\n');buffer=frames.pop() || '';for(const frame of frames){const line=frame.split('\n').find(line=>line.startsWith('data:'));if(!line)continue;const command=JSON.parse(line.slice(5));if(ownership && command.type==='composerContext' && command.operation==='ownership'){await post({type:'composer_context_reply',requestId:command.requestId,result:ownership});continue;}if(!['readMedia','readHtmlPreview'].includes(command.type))continue;
    const record={action:command.action,offset:command.offset,length:command.length,ref:command.ref,bytes:0};requests.push(record);
    try{const source=command.type==='readMedia' ? authorizedMediaSource(command.ref,null,command.approvedRef) : null,result=command.type==='readHtmlPreview' ? await htmlReader.read(command) : await reader.read(source,directory,command.ref,command);record.bytes=result.body ? Buffer.from(result.body,'base64').length : 0;await post({type:'media',mediaRevision:1,requestId:command.requestId,...result});}
    catch(error){await post({type:'media',requestId:command.requestId,error:error.message});}
  }}})().catch(error=>{if(!abort.signal.aborted)throw error;});
  await post({type:'thread_list',threads:[{id:'media-fixture',name:'媒体按需加载验证',cwd:directory,status:{type:'idle'},createdAt:1,updatedAt:2}]});
  const session=(await (await fetch(base+'/api/sessions')).json()).sessions[0];
  const text=files.map(file=>`[${path.basename(file)}](<${file}>)`).join('\n\n');
  const history=(suffix='')=>post({type:'thread_history',sessionId:session.id,threadId:'media-fixture',items:[{id:'u',role:'user',text:'请展示这些附件。',turnId:'t',at:1},{id:'a',role:'assistant',phase:'final_answer',text:text+suffix,turnId:'t',at:2}],turns:[{id:'t',status:'completed'}],turnCount:1,messageCount:2});await history();
  const heartbeat=setInterval(()=>fetch(base+'/api/runner/local/heartbeat',{method:'POST',headers,body:'{}'}).catch(()=>{}),5000);
  let wrapper;
  const stats=()=>({requests:requests.length,metadata:requests.filter(item=>item.action==='info').length,previewBytes:requests.filter(item=>item.action==='preview').reduce((n,item)=>n+item.bytes,0),originalBytes:requests.filter(item=>item.action==='read').reduce((n,item)=>n+item.bytes,0),ranges:requests.filter(item=>item.action==='read').map(({offset,length})=>({offset,length}))});
  let browserBase=base;
  if(proofPanel){
    wrapper=createHttpServer(async(req,res)=>{
      try{
        if(req.url==='/fixture-stats'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify(stats()));}
        if(req.url==='/fixture-refresh'){await history('\n\n实时更新验证 '+Date.now());res.writeHead(200,{'content-type':'application/json'});return res.end('{}');}
        const response=await fetch(base+req.url,{method:req.method,headers:{'content-type':req.headers['content-type'] || 'application/json',...(req.headers.range ? {range:req.headers.range} : {})},body:['POST','PATCH'].includes(req.method) ? await new Promise(resolve=>{let text='';req.on('data',chunk=>text+=chunk);req.on('end',()=>resolve(text));}) : undefined,signal:req.url==='/api/events' ? undefined : AbortSignal.timeout(20000)});
        const responseHeaders=Object.fromEntries(response.headers);delete responseHeaders['content-encoding'];delete responseHeaders['content-length'];
        res.writeHead(response.status,responseHeaders);
        if(req.url==='/'){let html=await response.text();html=html.replace('</body>',`<aside id="media-proof" style="position:fixed;bottom:14px;right:14px;z-index:9999;background:#151c26;color:#fff;border:1px solid #667;padding:10px;border-radius:9px;font:12px monospace;max-width:360px"><b>媒体传输验证</b><button id="fixture-refresh">模拟回复更新</button><pre id="media-proof-data">等待统计</pre><p id="media-player-proof"></p></aside><script>let previousPlayer;document.getElementById('fixture-refresh').onclick=async()=>{previousPlayer=document.querySelector('audio');await fetch('/fixture-refresh')};setInterval(async()=>{try{document.getElementById('media-proof-data').textContent=JSON.stringify(await(await fetch('/fixture-stats')).json(),null,2);if(previousPlayer)document.getElementById('media-player-proof').textContent=previousPlayer===document.querySelector('audio')?'播放器保留：通过':'播放器保留：未通过'}catch{}},500)</script></body>`);return res.end(html);}
        if(!response.body)return res.end();
        const streamReader=response.body.getReader();res.once('close',()=>streamReader.cancel().catch(()=>{}));
        while(!res.destroyed){const chunk=await streamReader.read();if(chunk.done)break;res.write(chunk.value);}if(!res.destroyed)res.end();
      }catch(error){if(!res.headersSent)res.writeHead(500);if(!res.destroyed)res.end(error.message);}
    });
    await new Promise(resolve=>wrapper.listen(0,'127.0.0.1',resolve));browserBase=`http://127.0.0.1:${wrapper.address().port}`;
  }
  return {base,browserBase,session,requests,stats,history,post,close:async()=>{clearInterval(heartbeat);abort.abort();wrapper?.closeAllConnections();wrapper?.close();await consume;const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;}};
}
