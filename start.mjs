import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {supervise} from './src/supervisor.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const target=process.argv.includes('--runner') ? 'runner.mjs' : 'server.mjs';
const service=supervise(process.execPath,[path.join(root,target)],{
  cwd:root,env:{...process.env,CODEX_RELAY_PARENT_PIPE:'1'},stdio:['pipe','inherit','inherit'],windowsHide:true
},{onState:state=>{if(state.state==='restarting')console.error(`Relay 已退出，${Math.round(state.delay/100)/10} 秒后恢复${state.error ? ': '+state.error : ''}`);}});
let closing=false;
function shutdown(){if(closing)return;closing=true;service.stop();setTimeout(()=>process.exit(0),500);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
