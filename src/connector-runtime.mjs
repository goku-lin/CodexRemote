import fs from 'node:fs/promises';
import path from 'node:path';
import {runIndependentNode} from './independent-node.mjs';
(async()=>{
  if(process.argv.includes('--self-check')){await import('./connector-node.mjs');console.log('RTC runtime ready');return;}
  const app=path.dirname(path.resolve(process.argv[1])),state=process.env.CODEX_RELAY_DATA_DIR;
  const config=JSON.parse(await fs.readFile(path.join(state,'connector.json'),'utf8'));
  const options={app,node:process.execPath,config,state,version:process.env.CODEX_RELAY_RELEASE_ID};
  if(config.mode==='independent')await runIndependentNode(options);
  else {const {runConnectorNode}=await import('./connector-node.mjs');await runConnectorNode(options);}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
