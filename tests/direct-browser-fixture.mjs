// Isolated Chromium/WebRTC verification; no Codex or real credentials are used.
import http from 'node:http';
import fs from 'node:fs/promises';
import {ConnectorPeers} from '../src/connector-node.mjs';
const deviceId='pc-browser-fixture';let peers;
const html=`<!doctype html><meta charset="utf-8"><title>直连测试</title><button id="run">验证浏览器直连</button><pre id="result">等待验证</pre><script type="module">
import {DirectConnections,peerResponse} from '/direct-connection.js';
const output=document.getElementById('result');
document.getElementById('run').onclick=async()=>{
 const events=[],manager=new DirectConnections({signal:async(path,options)=>{const response=await fetch(path,{...options,headers:{'content-type':'application/json'}});if(!response.ok)throw new Error(await response.text());return response.json();},onEvent:(id,type,data)=>events.push({type,data}),onChange:()=>{}});
 try{await manager.ensure({id:'${deviceId}',executionRelay:true,online:true});if(!manager.ready('${deviceId}'))throw new Error('RTC未接通');
 const result=await manager.request('${deviceId}','/api/projects');const data=await peerResponse(result).json();
 if(data.text!== '手机🌍'.repeat(20000))throw new Error('分片内容不匹配');
 let denied=false;try{await manager.request('${deviceId}','/api/connectors/code',{method:'POST',body:'{}'});}catch{denied=true;}if(!denied)throw new Error('管理接口未拒绝');
 output.textContent=JSON.stringify({passed:true,transport:'真实浏览器 WebRTC',characters:data.text.length,snapshot:events.some(item=>item.type==='snapshot'),administrationDenied:denied});
 }catch(error){output.textContent=JSON.stringify({passed:false,error:error.message});}finally{manager.stop();}
};</script>`;
const server=http.createServer(async(req,res)=>{
 try{if(req.url==='/'){res.setHeader('content-type','text/html');return res.end(html);}
 if(['/direct-connection.js','/peer-wire.js'].includes(req.url)){res.setHeader('content-type','text/javascript');return res.end(await fs.readFile(new URL('../public'+req.url,import.meta.url)));}
 if(req.url.includes('/direct')){let text='';for await(const bytes of req)text+=bytes;const body=JSON.parse(text || '{}');let result;
   if(req.url.endsWith('/direct'))result=await peers.offer({peerId:crypto.randomUUID(),offer:body.offer});
   else{const id=req.url.split('/').at(-2);if(req.url.endsWith('/close')){peers.close(id);result={ok:true};}else result=peers.lease(id);}
   res.setHeader('content-type','application/json');return res.end(JSON.stringify(result));}
 res.setHeader('content-type','application/json');res.end(JSON.stringify({devices:[],sessions:[],projects:[],text:'手机🌍'.repeat(20000)}));
 }catch(error){res.writeHead(500);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;peers=new ConnectorPeers({base,deviceId});console.log(base);
process.on('SIGINT',()=>{peers.stop();server.close(()=>process.exit(0));});
