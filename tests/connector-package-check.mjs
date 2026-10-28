// Read-only model smoke check of the actual portable Windows package.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readRelease,releaseDirectory} from '../src/connector-release.mjs';
import {extractArchive} from '../src/connector-archive.mjs';
import {verifyPortableConnector} from './connector-runtime-smoke.mjs';
import {verifyRelease,updateSource} from '../src/connector-updates.mjs';
import {assertPublicFiles} from '../src/release-privacy.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),exec=promisify(execFile);
process.env.CODEX_RELAY_NO_DESKTOP_SHORTCUT='1';
const candidate=process.env.CODEX_RELAY_RELEASE_CHECK_MANIFEST;
const manifest=candidate ? JSON.parse(await fs.readFile(candidate,'utf8')) : null;
if(manifest && (!/^[a-f0-9]{20}$/.test(manifest.version)||manifest.filename!=='connector-'+manifest.version+'.zip'))throw new Error('candidate manifest invalid');
const release=manifest ? {...manifest,path:path.join(releaseDirectory(root,process.env.CODEX_RELAY_RELEASE_CHECK_DATA_DIR),manifest.filename)} : await readRelease(root,process.env.CODEX_RELAY_RELEASE_CHECK_DATA_DIR),directory=await fs.mkdtemp(path.join(root,'.relay-data','package-check-'));
try{
  const bytes=await fs.readFile(release.path);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==release.sha256)throw new Error('release hash mismatch');
  await extractArchive(bytes,directory);
  const metadata=JSON.parse(await fs.readFile(path.join(directory,'release.json'),'utf8'));
  verifyRelease(release,metadata.distribution==='public'?{publicKey:metadata.signingPublicKey,sequence:0}:updateSource(metadata.updates));
  if(metadata.distribution==='public' && (updateSource(metadata.updates).kind!=='github' || metadata.updates.urls || metadata.updates.publicKey!==metadata.signingPublicKey))throw new Error('Public package has an invalid public update source');
  const names=await fs.readdir(directory,{recursive:true});
  assertPublicFiles(names);
  await fs.access(path.join(directory,'app','lan-access.ps1'));
  await fs.access(path.join(directory,'app','LICENSE'));
  const notices=await fs.readFile(path.join(directory,'app','dependency-notices.txt'),'utf8');
  if(!notices.includes('Source package: https://registry.npmjs.org/web-push/-/web-push-3.6.7.tgz')||!notices.includes('third-party-sources/web-push-3.6.7.zip'))throw new Error('MPL corresponding source is missing');
  await fs.access(path.join(directory,'app','third-party-sources','web-push-3.6.7.zip'));
  const node=path.join(directory,'runtime','node.exe'),app=path.join(directory,'app');
  const pushRuntime=await import(new URL('file:///'+path.join(app,'push-runtime.mjs').replaceAll('\\','/')));
  const pushKeys=pushRuntime.generateVAPIDKeys();if(!pushKeys.publicKey||!pushKeys.privateKey)throw new Error('Portable push runtime unavailable');
  console.log('后台提醒的便携加密与签名依赖可独立加载；未发送通知。');
  const appShell=await import(new URL('file:///'+path.join(app,'app-shell.mjs').replaceAll('\\','/')));
  const shellSource=appShell.applicationWorker(path.join(app,'public'));
  const desktopIcon=appShell.applicationManifest(path.join(app,'public'),'台式机'),laptopIcon=appShell.applicationManifest(path.join(app,'public'),'笔记本');
  if(desktopIcon.icons[0].src===laptopIcon.icons[0].src)throw new Error('Portable computer icons are identical');
  for(const manifest of [desktopIcon,laptopIcon])for(const icon of manifest.icons)await fs.access(path.join(app,'public',new URL(icon.src,'http://fixture.test').pathname));
  const shellAssets=JSON.parse(shellSource.match(/const SHELL_ASSETS=(\[[^;]+\]);/)[1]);
  for(const asset of shellAssets)await fs.access(path.join(app,'public',asset));
  console.log('手机快速启动界面、安装清单与图标已完整打包。');
  const documentPreview=await import(new URL('file:///'+path.join(app,'document-preview.mjs').replaceAll('\\','/')));
  if(!documentPreview.renderDocument('# 学习笔记','note.md').includes('<h1>学习笔记</h1>'))throw new Error('便携文档阅读器缺少 Markdown 渲染依赖');
  const {HtmlPreviewReader}=await import(new URL('file:///'+path.join(app,'html-preview.mjs').replaceAll('\\','/')));
  const note=path.join(directory,'portable-note.md');await fs.writeFile(note,'# 便携笔记');
  const noteInfo=await new HtmlPreviewReader().read({ref:note,approvedRef:note,resource:path.basename(note),action:'info'});
  if(noteInfo.mime!=='text/html')throw new Error('便携 Markdown 阅读不可用');
  console.log('Markdown 文档阅读和跨目录渲染依赖已完整打包。');
  await exec('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(app,'manager-ui.ps1'),'-ProjectRoot',directory,'-ConnectorHome',directory,'-ValidateOnly'],{windowsHide:true,timeout:15000});
  await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(app,'install-manager.ps1'),'-HomeDirectory',directory,'-SourceDirectory',app,'-NoShortcut'],{windowsHide:true,timeout:15000});
  await fs.access(path.join(directory,'CodexRemote.exe'));
  console.log('管理应用的便携 WPF 窗口加载及原生 EXE 编译通过；未更改桌面快捷方式。');
  await fs.access(path.join(directory,'runtime','LICENSE.txt'));
  const runtime=await exec(node,['--version'],{windowsHide:true});console.log('独立运行环境：'+runtime.stdout.trim());
  const peer=await exec(node,[path.join(app,'connector-runtime.cjs'),'--self-check'],{windowsHide:true,timeout:20_000});
  if(!peer.stdout.includes('RTC runtime ready'))throw new Error('portable RTC runtime failed');
  await fs.access(path.join(app,'dependency-notices.txt'));
  await exec(node,['--input-type=module','-e','import '+JSON.stringify(new URL('file:///'+path.join(app,'connector-release.mjs').replaceAll('\\','/')).href)],{windowsHide:true,timeout:20_000});
  console.log('便携直连运行环境及无额外依赖的服务模块加载通过。');
  await exec(node,[path.join(app,'native-desktop-setup.mjs'),'prepare'],{windowsHide:true,timeout:60_000,env:{...process.env,CODEX_RELAY_DATA_DIR:path.join(directory,'state'),CODEX_RELAY_CONNECTOR_HOME:directory,CODEX_RELAY_RELEASE_ID:release.version}});
  const launcher=await fs.readFile(path.join(app,'打开原生桌面连接.ps1'),'utf8');
  if(!launcher.includes('connector-entry.ps1') || launcher.includes('启动Relay后台'))throw new Error('connector launcher starts the wrong backend');
  console.log('版本启动器编译及 CLI --version 验证通过；未启动桌面或发送模型请求。');
  const configurationFile=path.join(directory,'state','native-desktop-launch-'+release.version+'.json');
  const configuration=JSON.parse(await fs.readFile(configurationFile,'utf8'));
  // Reproduce an installed connector retaining a now-obsolete cache path. Run
  // the real packaged launcher, intercepting only service and GUI startup.
  await fs.writeFile(configurationFile,JSON.stringify({...configuration,cliPath:path.join(directory,'obsolete-cache','codex.exe')}));
  const quote=value=>"'"+value.replaceAll("'","''")+"'",receipt=path.join(directory,'launch-receipt.json'),wrapper=path.join(directory,'verify-packaged-launch.ps1');
  const packageLaunch=path.join(app,'native-package-launch.mjs'),fixtureLaunch=path.join(directory,'fixture-package-launch.mjs'),fixtureScript=path.join(directory,'verify-desktop-entry.ps1');
  if(!launcher.includes(quote(packageLaunch)))throw new Error('packaged app identity launcher is missing');
  await fs.writeFile(fixtureLaunch,`import fs from 'node:fs';const value=flag=>process.argv[process.argv.indexOf(flag)+1];if(!value('--app-root')||!value('--proxy')||!value('--data-dir'))throw new Error('missing package launch arguments');fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({proxy:value('--proxy'),launchMethod:'windows-package'}));`);
  await fs.writeFile(fixtureScript,launcher.replace(quote(packageLaunch),quote(fixtureLaunch)));
  await fs.writeFile(wrapper,'\ufeff'+[
    "$ErrorActionPreference = 'Stop'",
    'function Get-Process {}',
    "function powershell.exe { param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ToolArguments) if ($ToolArguments[-1] -ne 'start') { throw 'Unexpected service command' }; $global:LASTEXITCODE = 0 }",
    "function Start-Process { throw 'Unexpected direct GUI launch' }",
    '& '+quote(fixtureScript),
    'exit $LASTEXITCODE',''
  ].join('\r\n'));
  await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper],{windowsHide:true,timeout:30_000});
  const refreshed=JSON.parse(await fs.readFile(configurationFile,'utf8')),launched=JSON.parse((await fs.readFile(receipt,'utf8')).replace(/^\ufeff/,''));
  if(refreshed.cliPath!==configuration.cliPath || !refreshed.cliVersion?.startsWith('codex'))throw new Error('packaged launcher did not refresh the CLI from the current desktop');
  if(refreshed.endpointFile!==configuration.endpointFile || launched.launchMethod!=='windows-package' || !launched.proxy.endsWith('codex-native-proxy-'+release.version+'.exe'))throw new Error('packaged launcher changed the bridge endpoint or GUI launch');
  console.log('实际安装版启动脚本已纠正过期 CLI 路径；后台与桌面启动均被验证夹具拦截。');
  console.log('安装包哈希与私密文件排除检查通过。');
  const setupPath=path.join(path.dirname(release.path),'CodexRemote-Setup-'+release.version+'.exe');await fs.access(setupPath);
  await verifyPortableConnector(directory,{setupPath});
  const shared=await exec(node,['--test',path.join(root,'tests','shared-desktop.test.mjs')],{windowsHide:true,timeout:40000,env:{...process.env,CODEX_RELAY_SHARED_PACKAGE_ROOT:app}});
  if(!shared.stdout.includes('# fail 0'))throw new Error('便携双端共用检查未通过');
  console.log('实际便携包的桌面共用新建、引导、空闲 Runner 释放和交还桌面通过；未启动真实桌面或发送模型请求。');
}finally{
  if(path.dirname(directory)!==path.join(root,'.relay-data') || !path.basename(directory).startsWith('package-check-'))throw new Error('cleanup path mismatch');
  await fs.rm(directory,{recursive:true,force:true});
}
