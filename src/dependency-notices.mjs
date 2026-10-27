import fs from 'node:fs/promises';
import path from 'node:path';
import {createArchive} from './connector-archive.mjs';
import {projectRoot} from './layout.mjs';

async function packageSources(directory){
  const files=[];
  async function walk(folder){
    for(const entry of await fs.readdir(folder,{withFileTypes:true})){
      if(['node_modules','.git'].includes(entry.name))continue;
      const file=path.join(folder,entry.name);
      if(entry.isSymbolicLink())throw new Error('Dependency source contains a symbolic link');
      if(entry.isDirectory())await walk(file);
      else if(entry.isFile())files.push({name:path.relative(directory,file).replaceAll('\\','/'),bytes:await fs.readFile(file)});
    }
  }
  await walk(directory);return createArchive(files.sort((a,b)=>a.name.localeCompare(b.name)));
}
export async function dependencyNotices(inputs){
  const packages=new Map(),files=[];
  for(const input of inputs.filter(name=>name.includes('node_modules'))){
    let directory=path.dirname(path.resolve(input));
    while(directory!==path.dirname(directory)){
      const metadata=await fs.readFile(path.join(directory,'package.json'),'utf8').then(JSON.parse).catch(()=>null);
      if(metadata?.name){
        if(!packages.has(metadata.name)){
          const licenses=(await fs.readdir(directory)).filter(name=>/^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(name));
          const contents=await Promise.all(licenses.map(name=>fs.readFile(path.join(directory,name),'utf8')));
          if(!contents.length){
            const supplied=path.join(projectRoot,'third_party','licenses',metadata.name.replaceAll('/','-')+'-'+metadata.version+'.txt');
            const text=await fs.readFile(supplied,'utf8').catch(()=>null);
            if(!text)throw new Error('Dependency license text missing: '+metadata.name);
            contents.push(text);
          }
          let text=metadata.name+' '+metadata.version+' ('+(metadata.license||'see license')+')\n';
          const basename=metadata.name.split('/').at(-1);
          text+='Source package: https://registry.npmjs.org/'+metadata.name+'/-/'+basename+'-'+metadata.version+'.tgz\n';
          if(String(metadata.license).includes('MPL-2.0')){
            const archive='third-party-sources/'+metadata.name.replaceAll('/','-').replace(/^@/,'')+'-'+metadata.version+'.zip';
            text+='Corresponding source distributed under MPL-2.0: '+archive+'\n';
            files.push({name:'app/'+archive,bytes:await packageSources(directory)});
          }
          packages.set(metadata.name,text+contents.join('\n'));
        }
        break;
      }
      directory=path.dirname(directory);
    }
  }
  files.push({name:'app/dependency-notices.txt',bytes:Buffer.from([...packages].sort(([a],[b])=>a.localeCompare(b)).map(([,text])=>text).join('\n\n'))});
  return files;
}
