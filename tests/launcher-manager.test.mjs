import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile,spawn} from 'node:child_process';
import readline from 'node:readline';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {promisify} from 'node:util';
import {managerContext,managerStatus,managerAction,executorInventory,readManagerRequest} from '../src/launcher-manager.mjs';
import {loadModelRouterConfig,listConfiguredModels,resolveModel} from '../src/model-router.mjs';
import {entries} from '../src/connector-client.mjs';
import {releaseSigningKey,signRelease} from '../src/connector-updates.mjs';
import {writeApplicationFixture} from './application-fixture.mjs';

const execute=promisify(execFile);
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'Codex manager 含空格 '));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));return fs.rm(root,{recursive:true,force:true});});
  const context=managerContext({root});await fs.mkdir(context.dataDir,{recursive:true});return context;
}
const save=(file,value)=>fs.writeFile(file,JSON.stringify(value));

test('management requests tolerate the Framework UTF-8 BOM and split Unicode, bound input, and never echo password-bearing malformed JSON',async()=>{
  const bytes=Buffer.from('\ufeff'+JSON.stringify({action:'status',label:'中文 🖥️'}));
  const pieces=Array.from(bytes,byte=>Buffer.from([byte]));
  assert.deepEqual(await readManagerRequest(Readable.from(pieces)),{action:'status',label:'中文 🖥️'});
  await assert.rejects(readManagerRequest(Readable.from([Buffer.from('{"password":"private-fixture-secret"')])),error=>{
    assert.match(error.message,/格式无效/);assert.doesNotMatch(error.message,/private-fixture-secret/);return true;
  });
  await assert.rejects(readManagerRequest(Readable.from([Buffer.alloc(65537,65)])),/过大/);
  await assert.rejects(readManagerRequest(Readable.from([Buffer.from('[]')])),/缺少操作/);
});

test('real WPF window sends and renders status through Windows PowerShell 5 and the compiled EXE host',{skip:process.platform!=='win32',timeout:30000},async t=>{
  const context=await fixture(t),version='c'.repeat(20),versionRoot=path.join(context.root,'versions',version);
  await fs.mkdir(versionRoot,{recursive:true});await fs.mkdir(path.join(context.root,'state'));
  await fs.symlink(path.resolve('src'),path.join(versionRoot,'app'),'junction');
  await fs.symlink(path.dirname(process.execPath),path.join(versionRoot,'runtime'),'junction');
  const server=createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.url==='/api/runtime'?{chatgptRevision:2}:req.url==='/api/maintenance'?{passwordConfigured:false}:{relay:{message:'Relay 测试正常'},desktop:{message:'桌面测试正常'}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  await save(path.join(context.root,'state','connector.json'),{port:server.address().port});await save(path.join(context.root,'current.json'),{version});
  const quote=value=>"'"+value.replaceAll("'","''")+"'",ui=path.resolve('scripts/manager-ui.ps1');
  for(const encoding of ["[Text.Encoding]::GetEncoding(936)","[Text.UTF8Encoding]::new($true)"]){
    const script="[Console]::InputEncoding="+encoding+"; & "+quote(ui)+" -ProjectRoot "+quote(versionRoot)+" -ConnectorHome "+quote(context.root)+" -VerifyStatusOnly";
    const result=await execute('powershell.exe',['-NoProfile','-STA','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000});
    const proof=JSON.parse(result.stdout.trim().replace(/^\ufeff/,''));assert.equal(proof.verified,true);assert.equal(proof.healthRows,5);assert.match(proof.versionText,new RegExp(version));
  }
  const receipt=path.join(context.root,'rendered.json');await fs.mkdir(path.join(context.root,'scripts'));
  await fs.writeFile(path.join(context.root,'scripts','manager-ui.ps1'),'\ufeff'+"$result=& "+quote(ui)+" -ProjectRoot "+quote(versionRoot)+" -ConnectorHome "+quote(context.root)+" -VerifyStatusOnly\r\n[IO.File]::WriteAllText("+quote(receipt)+",[string]$result,[Text.UTF8Encoding]::new($false))");
  await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/install-manager.ps1'),'-HomeDirectory',context.root,'-SourceDirectory',path.resolve('src'),'-NoShortcut'],{windowsHide:true,timeout:15000});
  await execute(path.join(context.root,'CodexRemote.exe'),['--check-entry'],{windowsHide:true,timeout:15000});
  const proof=JSON.parse(await fs.readFile(receipt,'utf8'));assert.equal(proof.verified,true);assert.equal(proof.healthRows,5);assert.match(proof.versionText,new RegExp(version));
});

test('opening the manager only reads cached local state and omits credentials from executor inventory',async t=>{
  const context=await fixture(t);
  await save(path.join(context.dataDir,'model-providers.json'),{providers:{claude:{execution:'claude-cli',name:'Claude',command:path.join(context.root,'missing.exe'),env:{ANTHROPIC_AUTH_TOKEN:'private-token'},apiKey:'private-key',models:{cc:'model'}}}});
  const calls=[];
  const state=await managerStatus(context,{fetcher:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/runtime')?{connectorRevision:2}:{relay:{state:'ready'}});}});
  assert.equal(state.online,true);assert.equal(state.executors.providers[0].installed,false);
  assert.ok(calls.every(call=>call.url.startsWith('http://127.0.0.1:4317/')&&!call.options.method));
  assert.doesNotMatch(JSON.stringify(state),/private-token|private-key|ANTHROPIC_AUTH_TOKEN/);
});

test('executor enable changes the next loaded route without losing provider settings or touching running tasks',async t=>{
  const context=await fixture(t),file=path.join(context.dataDir,'model-providers.json');
  const config={providers:{dsh:{execution:'dsh-cli',models:{dsh:{id:'deepseek-flash'}},env:{CUSTOM:'keep-private'}}}};
  await save(file,config);
  await managerAction({action:'toggle-executor',id:'dsh',enabled:false},context);
  const disabled=await loadModelRouterConfig(file);assert.equal(disabled.providers.dsh.env.CUSTOM,'keep-private');
  assert.deepEqual(listConfiguredModels(disabled),[]);assert.throws(()=>resolveModel(disabled,'dsh'),/未配置模型/);
  assert.deepEqual(JSON.parse(await fs.readFile(file+'.manager-backup','utf8')),config);
  await managerAction({action:'toggle-executor',id:'dsh',enabled:true},context);
  assert.equal(listConfiguredModels(await loadModelRouterConfig(file))[0].alias,'dsh');
  await assert.rejects(managerAction({action:'toggle-executor',id:'__proto__',enabled:false},context),/不存在/);
  assert.equal((await executorInventory(context)).providers[0].enabled,true);
});

test('an already connected new MCP server rereads executor switches without restarting Codex or calling a model',async t=>{
  const context=await fixture(t),file=path.join(context.dataDir,'model-providers.json');
  await save(file,{providers:{dsh:{execution:'dsh-cli',models:{harness:{id:'deepseek-flash'}}}}});
  const child=spawn(process.execPath,[path.resolve('src/delegate-mcp.mjs')],{windowsHide:true,env:{...process.env,MODEL_DELEGATE_CONFIG:file},stdio:['pipe','pipe','pipe']});
  child.stderr.resume();const pending=new Map();
  readline.createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);pending.get(value.id)?.(value);pending.delete(value.id);});
  t.after(async()=>{child.stdin.end();if(child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));});
  let id=0;const call=(method,params)=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(new Error('MCP reply timeout')),4000);pending.set(key,value=>{clearTimeout(timer);resolve(value);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');});
  assert.ok((await call('tools/list')).result.tools.some(tool=>tool.name==='delegate_to_dsh'));
  await managerAction({action:'toggle-executor',id:'dsh',enabled:false},context);
  assert.equal((await call('tools/list')).result.tools.some(tool=>tool.name==='delegate_to_dsh'),false);
  const rejected=await call('tools/call',{name:'delegate_to_dsh',arguments:{task:'must not execute'}});
  assert.equal(rejected.result.isError,true);
  await managerAction({action:'toggle-executor',id:'dsh',enabled:true},context);
  assert.ok((await call('tools/list')).result.tools.some(tool=>tool.name==='delegate_to_dsh'));
});

test('restart and recovery require outage confirmation, desktop confirmation and existing server password validation',async t=>{
  const context=await fixture(t),calls=[],options={fetcher:async(url,init)=>{calls.push({url,init});return Response.json({job:{id:'fixture',state:'queued'}});}};
  await assert.rejects(managerAction({action:'restart',scope:'desktop',password:'123456'},context,options),/先确认/);
  await assert.rejects(managerAction({action:'restart',scope:'desktop',confirmNetwork:true,password:'123456'},context,options),/确认中断/);
  await assert.rejects(managerAction({action:'recover'},context,options),/先确认/);assert.equal(calls.length,0);
  const result=await managerAction({action:'restart',scope:'desktop',confirmNetwork:true,confirmDesktop:true,password:'123456'},context,options);
  assert.equal(result.job.state,'queued');assert.equal(JSON.parse(calls[0].init.body).password,'123456');
  assert.doesNotMatch(JSON.stringify(result),/123456/);
});

test('password can be set from the local manager without returning or logging the secret',async t=>{
  const context=await fixture(t);
  const result=await managerAction({action:'set-password',password:'123456',confirmation:'123456'},context);
  assert.match(result.message,/已在本机保存/);
  const saved=JSON.parse(await fs.readFile(path.join(context.dataDir,'maintenance-password.json'),'utf8'));
  assert.equal(saved.version,1); assert.equal(saved.hash.includes('123456'),false);
  await assert.rejects(managerAction({action:'set-password',password:'123456',confirmation:'654321'},context),/不一致/);
});

test('installed manager checks public release notes without service calls and installs only after confirmation',async t=>{
  const f=await fixture(t),context=managerContext({root:f.root,home:f.root});await fs.mkdir(context.dataDir,{recursive:true});
  const key=await releaseSigningKey(path.join(f.root,'publisher')),version='a'.repeat(20),filename='CodexRemote-Portable-v0.2.0-win-x64.zip';
  const updates={schema:1,kind:'github',repository:'example/remote',channel:'preview',publicKey:key.publicKey,sequence:1};
  await save(path.join(context.dataDir,'update-source.json'),updates);await save(path.join(f.root,'current.json'),{version:'b'.repeat(20)});
  const manifest=signRelease({version,filename,size:100,sha256:'c'.repeat(64),sequence:2},key),base='https://github.com/example/remote/releases/download/v0.1.1/';
  const result=await managerAction({action:'check-update'},context,{fetcher:async url=>url.endsWith('/releases?per_page=20')?Response.json([{tag_name:'v0.1.1',name:'新版',body:'保留配对与设置',assets:[{id:1,name:'update-manifest.json',state:'uploaded',browser_download_url:base+'update-manifest.json'},{id:2,name:filename,state:'uploaded',size:100,browser_download_url:base+filename}]}]):Response.json(manifest)});
  assert.equal(result.update.status,'available');assert.equal(result.update.release.notes,'保留配对与设置');
  let called=false;const options={run:async(_file,args)=>{called=true;assert.ok(args.includes('--install'));return {stdout:'已更新'};}};
  await assert.rejects(managerAction({action:'update'},context,options),/先确认/);assert.equal(called,false);
  assert.equal((await managerAction({action:'update',confirmNetwork:true},context,options)).message,'已更新');
});

test('a running desktop is kept, and a healthy service does not execute a startup or ingress recovery command',async t=>{
  const context=await fixture(t),calls=[];
  const options={run:async(...args)=>{calls.push(args);return {stdout:'3\r\n'};},fetcher:async()=>Response.json({connectorRevision:2,chatgptRevision:2,remoteBrowserRevision:3,chatgptAppToolsAvailable:true})};
  assert.match((await managerAction({action:'start-desktop'},context,options)).message,/保留当前任务/);
  assert.equal(calls.length,1);assert.equal(calls[0][1].at(-1).includes('Stop-Process'),false);
  await managerAction({action:'start-service'},context,options);assert.equal(calls.length,1);
  await assert.rejects(managerAction({action:'arbitrary-command',command:'bad'},context),/不支持/);
});

test('an available Relay remains reusable when the optional desktop app-tools channel is unavailable',async t=>{
  const context=await fixture(t);
  const result=await managerAction({action:'start-service'},context,{fetcher:async()=>Response.json({chatgptRevision:2,remoteBrowserRevision:3,chatgptAppToolsAvailable:false}),run:async()=>{throw new Error('Must not launch or restart an already healthy service');}});
  assert.match(result.message,/无需重复启动/);
});

test('PowerShell startup preserves Chinese output, literal paths and switch parameters; failures remain readable',{skip:process.platform!=='win32'},async t=>{
  const context=await fixture(t),directory=path.join(context.root,"带'引号");
  await fs.mkdir(path.join(directory,'scripts'),{recursive:true});
  const actualContext=managerContext({root:directory}),file=path.join(directory,'scripts','启动远程服务.ps1');
  const options={fetcher:async()=>{throw new Error('Fixture offline');}};
  await fs.writeFile(file,'\ufeff'+"param([switch]$NoBrowser,[switch]$Quiet)\r\nif (-not $NoBrowser -or -not $Quiet) { throw '参数丢失' }\r\nWrite-Output '后台正常，中文日志可读。'\r\n");
  assert.equal((await managerAction({action:'start-service'},actualContext,options)).message,'后台正常，中文日志可读。');
  await fs.writeFile(file,'\ufeff'+"param([switch]$NoBrowser,[switch]$Quiet)\r\nthrow '后台尚未响应，请查看服务日志。'\r\n");
  await assert.rejects(managerAction({action:'start-service'},actualContext,options),error=>{
    assert.equal(error.message,'后台尚未响应，请查看服务日志。');
    assert.doesNotMatch(error.message,/\ufffd|CLIXML|EncodedCommand/);return true;
  });
});

test('the internal manager entry follows the selected application version without legacy entry points',{skip:process.platform!=='win32'},async t=>{
  const context=await fixture(t),receipt=path.join(context.root,'manager-receipt.json'),quote=value=>"'"+value.replaceAll("'","''")+"'";
  for(const version of ['a'.repeat(20),'b'.repeat(20)]){
    const {app}=await writeApplicationFixture(context.root,{version});await entries(context.root);
    await fs.writeFile(path.join(app,'manager-ui.ps1'),'\ufeff'+"param($ProjectRoot,$ConnectorHome,[switch]$ValidateOnly,[switch]$VerifyStatusOnly)\r\n@{root=$ProjectRoot;home=$ConnectorHome;validate=[bool]$ValidateOnly} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath "+quote(receipt));
    await execute('powershell.exe',['-NoProfile','-STA','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(context.root,'runtime/manager.ps1'),'-ValidateOnly'],{windowsHide:true,timeout:15000,cwd:os.tmpdir()});
    const opened=JSON.parse((await fs.readFile(receipt,'utf8')).replace(/^\ufeff/,''));
    assert.equal(opened.validate,true);assert.equal(await fs.realpath(opened.root),await fs.realpath(path.dirname(app)));assert.equal(await fs.realpath(opened.home),await fs.realpath(context.root));
    assert.equal((await fs.readdir(context.root)).some(name=>/\.(cmd|bat|ps1)$/i.test(name)),false);
  }
});

test('native WPF manager loads without starting desktop, services or model requests',{skip:process.platform!=='win32'},async()=>{
  const value=await execute('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/manager-ui.ps1'),'-ValidateOnly'],{windowsHide:true,timeout:15000});
  assert.match(value.stdout,/Manager WPF loaded/);
});

test('compiled Windows application opens the local entry without a console or a desktop restart',{skip:process.platform!=='win32'},async t=>{
  const context=await fixture(t),receipt=path.join(context.root,'receipt.txt');await fs.mkdir(path.join(context.root,'scripts'));
  await fs.writeFile(path.join(context.root,'scripts','manager-ui.ps1'),'\ufeff'+`Set-Content -LiteralPath '${receipt.replaceAll("'","''")}' -Value 'opened'`);
  await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/install-manager.ps1'),'-HomeDirectory',context.root,'-SourceDirectory',path.resolve('src'),'-NoShortcut'],{windowsHide:true,timeout:15000});
  await execute(path.join(context.root,'CodexRemote.exe'),[],{windowsHide:true,timeout:5000});
  for(let i=0;i<40;i++){if(await fs.access(receipt).then(()=>true,()=>false)){assert.match(await fs.readFile(receipt,'utf8'),/opened/);return;}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.fail('Native launcher did not open fixture entry');
});
