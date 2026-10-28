import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createArchive} from './connector-archive.mjs';
import {projectRoot} from './layout.mjs';
import {publisherUrls,releaseSigningKey,signRelease,updateSource,validReleaseFilename} from './connector-updates.mjs';
import {buildManagerHost,buildManagerLauncher,buildManagerSetup} from './manager-package.mjs';
import {applicationEntries} from './application-entries.mjs';
import {assertPublicFiles} from './release-privacy.mjs';
import {dependencyNotices} from './dependency-notices.mjs';

export const releaseDirectory=(root,dataDir)=>path.join(dataDir || path.join(root,'.relay-data'),'releases');
export async function buildRelease(root,{dataDir,nodePath=process.execPath,publish=true,publicBuild=false}={}){
  if(publicBuild&&publish)throw new Error('公开构建不能覆盖局域网 OTA 发布，请使用 --candidate。');
  const expected=(await fs.readFile(path.join(root,'.node-version'),'utf8')).trim();
  const runtimeVersion=(await promisify(execFile)(nodePath,['--version'],{windowsHide:true,timeout:10000})).stdout.trim();
  if(runtimeVersion!=='v'+expected)throw new Error('安装包需使用已验证的 Node.js '+expected+' 构建，当前运行环境为 '+runtimeVersion+'。');
  const {build}=await import('esbuild');
  const stateDir=dataDir || path.join(root,'.relay-data'),directory=releaseDirectory(root,dataDir);
  const signing=await releaseSigningKey(stateDir,{keyJson:publicBuild?process.env.CODEX_REMOTE_RELEASE_SIGNING_KEY:undefined});
  const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  const previous=await fs.readFile(path.join(directory,'latest.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const sequence=Math.max(Date.now(),(previous?.sequence || 0)+1);
  const urls=publicBuild?[]:publisherUrls(Number(process.env.PORT || 4317));
  const updates=publicBuild ? updateSource({schema:1,kind:'github',repository:pkg.codexRemote.updateRepository,channel:pkg.codexRemote.updateChannel,publicKey:signing.publicKey,sequence})
    : urls.length ? {schema:1,publicKey:signing.publicKey,urls,sequence} : undefined;
  const codeRoot=path.join(root,'src');
  const names=(await fs.readdir(codeRoot)).filter(name=>/^[a-z0-9-]+\.mjs$/.test(name));
  names.push('native-cli-shim.cs','native-package-launch.cs','manager-shell.cs','manager-launcher.cs','package.json','LICENSE','THIRD_PARTY_NOTICES.md','manager-ui.ps1','install-manager.ps1','lan-access.ps1');
  for(const name of await fs.readdir(path.join(root,'public')))if(/^[a-z0-9-]+\.(?:js|css|html|webmanifest|png|svg)$/.test(name))names.push('public/'+name);
  names.sort();
  const files=await Promise.all(names.map(async name=>{
    const from=['package.json','LICENSE','THIRD_PARTY_NOTICES.md'].includes(name) || name.startsWith('public/') ? path.join(root,name) : name.endsWith('.ps1') ? path.join(root,'scripts',name) : path.join(codeRoot,name);
    let bytes=await fs.readFile(from);
    if(name==='push-runtime.mjs')bytes=Buffer.from("import {createRequire} from 'node:module';const runtime=createRequire(import.meta.url)('./push-runtime.cjs');export const generateVAPIDKeys=runtime.generateVAPIDKeys;export const sendNotification=runtime.sendNotification;\n");
    // The source and packaged applications share the same modules.
    if(name.endsWith('.mjs'))bytes=Buffer.from(bytes.toString('utf8').replaceAll("'../public/", "'./public/"));
    return {name:'app/'+name,bytes};
  }));
  files.push({name:'app/manager-host.exe',bytes:await buildManagerHost(root)});
  const launcher=await buildManagerLauncher(root);files.push({name:'app/manager-launcher.exe',bytes:launcher});
  const bundled=await build({entryPoints:[path.join(codeRoot,'connector-runtime.mjs')],bundle:true,platform:'node',target:'node22',format:'cjs',write:false,minify:true,metafile:true,logLevel:'silent'});
  files.push({name:'app/connector-runtime.cjs',bytes:Buffer.from(bundled.outputFiles[0].contents)});
  const pushBundled=await build({entryPoints:[path.join(codeRoot,'push-runtime.mjs')],bundle:true,platform:'node',target:'node22',format:'cjs',write:false,minify:true,metafile:true,logLevel:'silent'});
  files.push({name:'app/push-runtime.cjs',bytes:Buffer.from(pushBundled.outputFiles[0].contents)});
  files.push(...await dependencyNotices([...new Set([...Object.keys(bundled.metafile.inputs),...Object.keys(pushBundled.metafile.inputs)])]));
  const node=await fs.readFile(nodePath);
  // Windows executables, not a path or runtime specific to the publishing PC.
  if(node.subarray(0,2).toString()!=='MZ')throw new Error('请在 Windows 上使用 node.exe 打包连接器');
  files.push({name:'runtime/node.exe',bytes:node});
  const license=await fs.readFile(path.join(path.dirname(nodePath),'LICENSE')).catch(()=>fs.readFile(path.join(path.dirname(nodePath),'LICENSE.txt')));
  files.push({name:'runtime/LICENSE.txt',bytes:license});
  const digest=crypto.createHash('sha256').update(JSON.stringify({updates,sequence}));for(const file of files)digest.update(file.name).update('\0').update(file.bytes);
  const version=digest.digest('hex').slice(0,20);
  const metadata=Buffer.from(JSON.stringify({version,releaseVersion:pkg.version,nodeVersion:runtimeVersion,distribution:publicBuild?'public':'lan',signingPublicKey:signing.publicKey,updates}));
  const packaged=files.map(file=>({...file,name:'versions/'+version+'/'+file.name}));
  packaged.push({name:'versions/'+version+'/release.json',bytes:metadata},{name:'release.json',bytes:metadata},
    {name:'current.json',bytes:Buffer.from(JSON.stringify({version}))},{name:'manager.json',bytes:Buffer.from(JSON.stringify({version}))},
    {name:'CodexRemote.exe',bytes:launcher},{name:'portable.json',bytes:Buffer.from('{"schema":1}')},
    {name:'README.txt',bytes:Buffer.from('\ufeff解压后双击 CodexRemote.exe。启动、外网配置、密码、更新和重启均在应用中操作。\r\n本机数据保存在 state 文件夹；移动应用时请移动整个文件夹。\r\n')});
  for(const [name,value] of Object.entries(applicationEntries()))packaged.push({name,bytes:Buffer.from(value)});
  assertPublicFiles(packaged.map(file=>file.name));
  const bytes=createArchive(packaged);await fs.mkdir(directory,{recursive:true});
  const filename='CodexRemote-Portable-v'+pkg.version+'-win-x64.zip',manifest={...signRelease({version,filename,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length,sequence},signing),builtAt:sequence};
  await fs.writeFile(path.join(directory,filename),bytes);
  const setupPath=path.join(directory,'CodexRemote-Setup-v'+pkg.version+'-win-x64.exe');
  await buildManagerSetup(root,{archive:path.join(directory,filename),manifest,publicKey:signing.publicKey,output:setupPath});
  const manifestPath=path.join(directory,publish ? 'latest.json' : 'candidate-'+version+'.json');
  await fs.writeFile(manifestPath+'.tmp',JSON.stringify(manifest));await fs.rename(manifestPath+'.tmp',manifestPath);
  if(publicBuild)await fs.writeFile(path.join(directory,'update-manifest.json'),JSON.stringify(manifest));
  return {...manifest,path:path.join(directory,filename),manifestPath,setupPath};
}
export async function readRelease(root,dataDir){
  const directory=releaseDirectory(root,dataDir);let manifest;
  try{manifest=JSON.parse(await fs.readFile(path.join(directory,'latest.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!/^[a-f0-9]{20}$/.test(manifest.version) || !validReleaseFilename(manifest.filename) || !/^[a-f0-9]{64}$/.test(manifest.sha256))throw new Error('应用发布信息无效');
  return {...manifest,path:path.join(directory,manifest.filename)};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const candidate=process.argv.includes('--candidate');
  const result=await buildRelease(projectRoot,{dataDir:process.env.CODEX_RELAY_DATA_DIR,publish:!candidate,publicBuild:process.argv.includes('--public')});
  console.log((candidate?'连接器安装包已构建（未发布）：':'连接器安装包已发布：')+result.path+'\nEXE：'+result.setupPath+'\n清单：'+result.manifestPath+'\n版本：'+result.version);
}
