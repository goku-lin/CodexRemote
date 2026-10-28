import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createArchive} from './connector-archive.mjs';
import {projectRoot} from './layout.mjs';
import {publisherUrls,releaseSigningKey,signRelease,updateSource} from './connector-updates.mjs';
import {buildManagerHost,buildManagerSetup} from './manager-package.mjs';
import {assertPublicFiles} from './release-privacy.mjs';
import {dependencyNotices} from './dependency-notices.mjs';

export const releaseDirectory=(root,dataDir)=>path.join(dataDir || path.join(root,'.relay-data'),'releases');
export async function buildRelease(root,{dataDir,nodePath=process.execPath,publish=true,publicBuild=false}={}){
  if(publicBuild&&publish)throw new Error('公开构建不能覆盖局域网 OTA 发布，请使用 --candidate。');
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
  names.push('native-cli-shim.cs','native-package-launch.cs','manager-shell.cs','manager-installer.cs','package.json','LICENSE','THIRD_PARTY_NOTICES.md','connector-bootstrap.ps1','manager-ui.ps1','install-manager.ps1','lan-access.ps1');
  for(const name of await fs.readdir(path.join(root,'public')))if(/^[a-z0-9-]+\.(?:js|css|html|webmanifest|png|svg)$/.test(name))names.push('public/'+name);
  names.sort();
  const files=await Promise.all(names.map(async name=>{
    const from=['package.json','LICENSE','THIRD_PARTY_NOTICES.md'].includes(name) || name.startsWith('public/') ? path.join(root,name) : name.endsWith('.ps1') ? path.join(root,'scripts',name) : path.join(codeRoot,name);
    let bytes=await fs.readFile(from);
    if(name==='push-runtime.mjs')bytes=Buffer.from("import {createRequire} from 'node:module';const runtime=createRequire(import.meta.url)('./push-runtime.cjs');export const generateVAPIDKeys=runtime.generateVAPIDKeys;export const sendNotification=runtime.sendNotification;\n");
    // Keep the portable app layout compatible with already-installed connectors.
    if(name.endsWith('.mjs'))bytes=Buffer.from(bytes.toString('utf8').replaceAll("'../public/", "'./public/"));
    return {name:'app/'+name,bytes};
  }));
  files.push({name:'app/manager-host.exe',bytes:await buildManagerHost(root)});
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
  files.push({name:'release.json',bytes:Buffer.from(JSON.stringify({version,releaseVersion:pkg.version,nodeVersion:process.version,distribution:publicBuild?'public':'lan',signingPublicKey:signing.publicKey,updates}))});
  files.push({name:'安装连接器.cmd',bytes:Buffer.from('@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\\connector-bootstrap.ps1"\r\nif errorlevel 1 pause\r\n')});
  files.push({name:'连接器说明.txt',bytes:Buffer.from('\ufeff'+[
    '运行任务的 Windows 电脑先安装并登录 Codex 桌面；手机和公司笔记本只需浏览器。',
    '首次解压全部文件，双击「安装连接器.cmd」，回车选择独立连接，无需主电脑连接码。',
    '安装完成后，日常和本机一样，双击安装目录中的「启动.cmd」：准备连接服务、按需打开 Codex，再打开控制网页。',
    '正在运行的 Codex 任务会保留。桌面尚未接通时，等任务结束后正常退出，再双击同一个「启动.cmd」。旧的「打开Codex远程连接.cmd」仍可用，执行相同启动流程。',
    '本机网页「连接手机」可开启或关闭局域网入口，并查看地址和配对码。每台电脑分别配对，各自管理浏览器授权。',
    '网页「独立电脑入口」可保存各电脑地址并下载本地入口页；保存入口页或书签，一台电脑关机不影响另一台。',
    '局域网 HTTP 未加密，限可信网络。外网需各电脑自己的 HTTPS 入口；执行电脑安装并登录 Tailscale 后可运行「配置外网入口.cmd」，访问端只需浏览器，隧道仍依赖 Tailscale。',
    publicBuild ? '管理程序「版本与更新」可检查 GitHub Releases，查看更新说明并选择安装；不会静默安装，来源离线时可继续使用已有版本。' : '独立模式的「启动.cmd」会自动检查安装包内记住的局域网更新来源，验证发布签名后下载更新；来源离线时继续使用已有版本。',
    '仍有任务运行或等待处理时暂缓自动更新，下次空闲时启动再检查；不会强制重启正在运行的 Codex。',
    '更新会保留任务、配置和浏览器授权；桌面代理在下次正常启动时更新。需要离线更新时可使用「从安装包更新.cmd」选择可信 ZIP。'
  ].join('\r\n')+'\r\n')});
  assertPublicFiles(files.map(file=>file.name));
  const bytes=createArchive(files);await fs.mkdir(directory,{recursive:true});
  const filename='connector-'+version+'.zip',manifest={...signRelease({version,filename,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length,sequence},signing),builtAt:sequence};
  await fs.writeFile(path.join(directory,filename),bytes);
  const setupPath=path.join(directory,'CodexRemote-Setup-'+version+'.exe');
  await buildManagerSetup(root,{archive:path.join(directory,filename),manifest,publicKey:signing.publicKey,output:setupPath});
  const manifestPath=path.join(directory,publish ? 'latest.json' : 'candidate-'+version+'.json');
  await fs.writeFile(manifestPath+'.tmp',JSON.stringify(manifest));await fs.rename(manifestPath+'.tmp',manifestPath);
  if(publicBuild)await fs.writeFile(path.join(directory,'update-manifest.json'),JSON.stringify(manifest));
  return {...manifest,path:path.join(directory,filename),manifestPath,setupPath};
}
export async function readRelease(root,dataDir){
  const directory=releaseDirectory(root,dataDir);let manifest;
  try{manifest=JSON.parse(await fs.readFile(path.join(directory,'latest.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!/^[a-f0-9]{20}$/.test(manifest.version) || manifest.filename!=='connector-'+manifest.version+'.zip' || !/^[a-f0-9]{64}$/.test(manifest.sha256))throw new Error('连接器发布信息无效');
  return {...manifest,path:path.join(directory,manifest.filename)};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const candidate=process.argv.includes('--candidate');
  const result=await buildRelease(projectRoot,{dataDir:process.env.CODEX_RELAY_DATA_DIR,publish:!candidate,publicBuild:process.argv.includes('--public')});
  console.log((candidate?'连接器安装包已构建（未发布）：':'连接器安装包已发布：')+result.path+'\nEXE：'+result.setupPath+'\n清单：'+result.manifestPath+'\n版本：'+result.version);
}
