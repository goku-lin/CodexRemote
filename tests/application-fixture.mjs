import fs from 'node:fs/promises';
import path from 'node:path';
import {createArchive} from '../src/connector-archive.mjs';
import {applicationEntries} from '../src/application-entries.mjs';

export function applicationFiles(files){
  const metadata=files.find(file=>file.name==='release.json');
  const {version}=JSON.parse(metadata.bytes.toString('utf8'));
  const result=files.map(file=>({...file,name:'versions/'+version+'/'+file.name}));
  result.push(metadata,{name:'current.json',bytes:Buffer.from(JSON.stringify({version}))},{name:'manager.json',bytes:Buffer.from(JSON.stringify({version}))},
    {name:'CodexRemote.exe',bytes:Buffer.from('MZfixture-launcher')},{name:'portable.json',bytes:Buffer.from('{"schema":1}')});
  for(const [name,value] of Object.entries(applicationEntries()))result.push({name,bytes:Buffer.from(value)});
  return result;
}
export const applicationArchive=files=>createArchive(applicationFiles(files));
export async function writeApplicationFixture(root,{version='a'.repeat(20),updates}={}){
  const files=applicationFiles([
    {name:'release.json',bytes:Buffer.from(JSON.stringify({version,updates}))},
    {name:'runtime/node.exe',bytes:Buffer.from('MZfixture-node')},
    {name:'app/connector-client.mjs',bytes:Buffer.from('// Fixture client')},
    {name:'app/manager-host.exe',bytes:Buffer.from('MZfixture-host')},
    {name:'app/manager-launcher.exe',bytes:Buffer.from('MZfixture-launcher')},
    {name:'app/install-manager.ps1',bytes:Buffer.from('\ufeffparam($HomeDirectory,$SourceDirectory,[switch]$NoShortcut)\r\n')}
  ]);
  for(const {name,bytes} of files){const filename=path.join(root,name);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,bytes);}
  return {version,app:path.join(root,'versions',version,'app')};
}
