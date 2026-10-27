// Isolated sidebar UI fixture. Commands never reach Desktop or a model.
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),directory=await mkdtemp(path.join(os.tmpdir(),'relay-search-browser-'));
const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const child=spawn(process.execPath,[path.join(root,'server.mjs')],{cwd:root,windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_TOKEN:'isolated-search-fixture',CODEX_RELAY_NO_EMBEDDED:'1',CODEX_RELAY_DATA_DIR:directory,CODEX_RELAY_PARENT_PIPE:'0'},stdio:['ignore','pipe','pipe']});
child.stderr.on('data',data=>process.stderr.write(data));
await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.on('data',bytes=>{if(String(bytes).includes('listening'))resolve();});});
const base=`http://127.0.0.1:${port}`,headers={'content-type':'application/json','x-codex-relay-token':'isolated-search-fixture'};
const post=async body=>{const response=await fetch(base+'/api/runner/local/events',{method:'POST',headers,body:JSON.stringify(body)});if(!response.ok)throw new Error(await response.text());};
const abort=new AbortController(),stream=await fetch(base+'/api/runner/local/commands',{headers,signal:abort.signal});
const consumed=(async()=>{for await(const _ of stream.body){}})().catch(()=>{});
await post({type:'catalog',catalog:{defaultModel:'fixture',models:[{model:'fixture',displayName:'测试模型',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]}});
await post({type:'native_status',connected:true,capabilities:{events:true,serverRequests:true},activeTurns:{}});
const titles=['首页布局调整','图片按需预览','MP3 播放体验','网络复盘','移动端输入优化','图片缓存','对话状态同步','历史登录说明','旧版界面记录','整理读书笔记','资料索引生成','待选择输出格式','待批准命令','文档目录调整','笔记导出','图表工具','脚本检查','快捷键整理'];
const now=Date.now();
const threads=titles.map((name,i)=>({id:'search-'+i,name,cwd:path.join(directory,i<9 ? '项目甲' : i<15 ? '项目乙' : '工具箱'),status:{type:'idle'},createdAt:1,updatedAt:now+(titles.length-i)*1000}));
await post({type:'thread_list',threads});
const sessions=(await(await fetch(base+'/api/sessions')).json()).sessions;
for(const session of sessions){
  const i=Number(session.threadId.slice(7)),at=now+(titles.length-i)*1000,active=[10,11,12].includes(i);
  const history=extra=>post({type:'thread_history',sessionId:session.id,threadId:session.threadId,settings:{model:'fixture',effort:'high',at},items:[{id:session.id+'-u',role:'user',text:'隔离测试：'+titles[i],turnId:'t'+i,at},{id:session.id+'-a',role:'assistant',phase:active ? 'commentary' : 'final_answer',text:'对话内容示例。'+extra,turnId:'t'+i,at:at+100+(extra ? 50 : 0)}],turns:[{id:'t'+i,status:active ? 'inProgress' : 'completed',startedAt:at,...(active ? {} : {completedAt:at+100+(extra ? 50 : 0)})}],turnCount:1,messageCount:2});
  await history('');if(i===3)await history('新增未读回复。');
  if(i===11)await post({type:'codex',origin:'desktop',sessionId:session.id,message:{id:'search-question',method:'item/tool/requestUserInput',params:{threadId:session.threadId,turnId:'t'+i,itemId:'ask',isBlocking:true,questions:[{id:'format',question:'选择输出格式',options:[{label:'文档'},{label:'纯文本'}]}]}}});
  if(i===12)await post({type:'codex',origin:'desktop',sessionId:session.id,message:{id:'search-approval',method:'item/commandExecution/requestApproval',params:{threadId:session.threadId,turnId:'t'+i,itemId:'command',command:'echo fixture',availableDecisions:['accept','decline']}}});
}
const heartbeat=setInterval(()=>fetch(base+'/api/runner/local/heartbeat',{method:'POST',headers,body:'{}'}).catch(()=>{}),5000);
console.log(JSON.stringify({url:base,sessions:sessions.length}));
let closing=false;
async function close(){if(closing)return;closing=true;clearInterval(heartbeat);abort.abort();await consumed;const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir()))throw new Error('Cleanup path');await rm(directory,{recursive:true,force:true});process.exit(0);}
process.stdin.on('data',close);process.on('SIGTERM',close);process.on('SIGINT',close);
