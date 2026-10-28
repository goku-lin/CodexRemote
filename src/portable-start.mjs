import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {updateSource} from './connector-updates.mjs';
import {recordManagedRelease} from './installation-storage.mjs';

export async function initializeApplication(home,{name=os.hostname(),workspace=os.homedir()}={}){
  home=path.resolve(home);
  const selection=JSON.parse(await fs.readFile(path.join(home,'current.json'),'utf8'));
  if(!/^[a-f0-9]{20}$/.test(selection.version))throw new Error('应用版本记录无效。');
  const directory=path.join(home,'versions',selection.version),metadata=JSON.parse(await fs.readFile(path.join(directory,'release.json'),'utf8'));
  if(metadata.version!==selection.version)throw new Error('应用版本不匹配。');
  const updates=metadata.updates?updateSource(metadata.updates):null,state=path.join(home,'state');
  await fs.mkdir(state,{recursive:true});
  const filename=path.join(state,'connector.json');
  const config={mode:'independent',id:'pc-'+crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex'),port:4317,name,cwd:workspace};
  // A portable app initializes only its own missing configuration. Opening it
  // again does not enroll another computer or replace existing authorizations.
  try{await fs.writeFile(filename,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST')throw error;return {initialized:false};}
  if(updates)await fs.writeFile(path.join(state,'update-source.json'),JSON.stringify(updates),{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  await recordManagedRelease(directory);
  return {initialized:true};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await initializeApplication(process.argv[process.argv.indexOf('--home')+1]);}
  catch(error){console.error(error.message);process.exitCode=1;}
}
