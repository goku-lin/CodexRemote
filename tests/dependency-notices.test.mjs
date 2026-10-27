import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {dependencyNotices} from '../src/dependency-notices.mjs';
import {inflateRawSync} from 'node:zlib';
import {buildRelease} from '../src/connector-release.mjs';

test('bundled MPL packages carry corresponding source, license and version-specific source links',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-notices-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'node_modules','fixture-mpl');await fs.mkdir(path.join(directory,'lib'),{recursive:true});
  await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({name:'fixture-mpl',version:'1.2.3',license:'MPL-2.0'}));
  await fs.writeFile(path.join(directory,'LICENSE'),'fixture license');await fs.writeFile(path.join(directory,'lib','index.js'),'export const originalSource=true;');
  const input=path.join(directory,'lib','index.js'),files=await dependencyNotices([input,input]);
  const notice=files.find(file=>file.name.endsWith('dependency-notices.txt')).bytes.toString();
  assert.match(notice,/https:\/\/registry.npmjs.org\/fixture-mpl\/-\/fixture-mpl-1.2.3.tgz/);
  assert.match(notice,/Corresponding source distributed under MPL-2.0/);assert.match(notice,/fixture license/);
  const archives=files.filter(file=>file.name.endsWith('.zip'));assert.equal(archives.length,1);
  const archive=archives[0].bytes,extracted=new Map();let offset=0;
  while(archive.readUInt32LE(offset)===0x04034b50){
    const length=archive.readUInt32LE(offset+18),nameLength=archive.readUInt16LE(offset+26),extra=archive.readUInt16LE(offset+28),name=archive.subarray(offset+30,offset+30+nameLength).toString(),start=offset+30+nameLength+extra;
    extracted.set(name,inflateRawSync(archive.subarray(start,start+length)).toString());offset=start+length;
  }
  assert.equal(extracted.get('lib/index.js'),'export const originalSource=true;');
  assert.equal(extracted.get('LICENSE'),'fixture license');
});
test('public builds cannot overwrite a LAN publication',async()=>{
  await assert.rejects(buildRelease('unused',{publish:true,publicBuild:true}),/不能覆盖局域网/);
});
