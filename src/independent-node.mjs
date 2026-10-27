import path from 'node:path';
import {supervise} from './supervisor.mjs';

export function independentPort(value=4317){
  const port=Number(value);
  if(!Number.isInteger(port) || port<1 || port>65535)throw new Error('独立连接端口需要在 1–65535 之间');
  return port;
}

export function independentService({app,config,state,version}){
  const port=independentPort(config.port);
  return {entry:path.join(app,'server.mjs'),env:{
    HOST:'127.0.0.1',PORT:String(port),CODEX_RELAY_EXECUTION_NODE:'1',
    CODEX_RELAY_CONNECTION_MODE:'independent',CODEX_RELAY_NO_EMBEDDED:'',
    CODEX_RELAY_LOCAL_DEVICE_ID:config.id,CODEX_RELAY_LOCAL_DEVICE_NAME:config.name,
    CODEX_RELAY_DATA_DIR:state,CODEX_WORKSPACE:config.cwd,CODEX_RELAY_TOKEN:config.token,
    CODEX_RELAY_RELEASE_ID:version,CODEX_RELAY_PARENT_PIPE:'1'
  }};
}

export async function runIndependentNode(options){
  const {entry,env}=independentService(options);
  // This process has no upstream connection, snapshot upload, or remote lease.
  const service=supervise(options.node,[entry],{cwd:options.app,windowsHide:true,
    stdio:['pipe','inherit','inherit'],env:{...process.env,...env}});
  console.log('独立连接已启动，本机网页：http://127.0.0.1:'+env.PORT+'/');
  await new Promise(resolve=>{
    let stopped=false;
    const stop=()=>{
      if(stopped)return;stopped=true;
      process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
      process.stdin.removeListener('end',stop);service.stop();resolve();
    };
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    process.stdin.resume();process.stdin.once('end',stop);
  });
}
