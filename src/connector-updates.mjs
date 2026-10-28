import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {isIP} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {lookup} from 'node:dns/promises';

export const updateManifestPath='/api/connector-updates/manifest';
export const updatePackagePath=version=>'/api/connector-updates/package/'+version;
export const maxPackageSize=180_000_000;

export function privateUpdateAddress(value){
  const address=String(value).replace(/^::ffff:/i,'');
  if(address==='::1')return true;
  if(isIP(address)!==4)return false;
  const [a,b]=address.split('.').map(Number);
  // Tailscale CGNAT addresses are private to the tailnet and are suitable for
  // signed LAN OTA traffic; Funnel/proxy requests are still rejected below.
  return a===127 || a===10 || a===100 && b>=64 && b<=127 || a===192 && b===168 || a===172 && b>=16 && b<=31;
}
export function lanUpdateRequest(req){
  return privateUpdateAddress(req.socket.remoteAddress)
    && !Object.keys(req.headers).some(name=>/^(?:forwarded$|x-forwarded-|tailscale-)/i.test(name));
}
export function updateUrl(value){
  if(typeof value!=='string' || value.length>1000)throw new Error('更新来源地址无效');
  const url=new URL(value);
  const hostname=url.hostname;
  const localName=/^[a-z0-9][a-z0-9-]{0,62}(?:\.local)?$/i.test(hostname);
  if(url.protocol!=='http:' || !(privateUpdateAddress(hostname) || localName)
    || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw new Error('更新来源需要局域网 HTTP 根地址');
  return url.origin;
}
function publicKey(value){
  if(typeof value!=='string' || !/^[A-Za-z0-9+/]{40,120}={0,2}$/.test(value))throw new Error('更新来源的发布公钥无效');
  const key=crypto.createPublicKey({key:Buffer.from(value,'base64'),format:'der',type:'spki'});
  if(key.asymmetricKeyType!=='ed25519')throw new Error('更新来源的发布公钥无效');
  return key;
}
export function updateSource(value){
  if(value?.kind==='github'){
    if(value.schema!==1 || !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(value.repository)
      || !['stable','preview'].includes(value.channel) || !Number.isSafeInteger(value.sequence) || value.sequence<1)throw new Error('GitHub 更新来源配置无效');
    publicKey(value.publicKey);
    return {schema:1,kind:'github',repository:value.repository,channel:value.channel,publicKey:value.publicKey,sequence:value.sequence};
  }
  if(!value || value.schema!==1 || !Array.isArray(value.urls) || !value.urls.length || value.urls.length>8
    || !Number.isSafeInteger(value.sequence) || value.sequence<1)throw new Error('更新来源配置无效');
  publicKey(value.publicKey);
  return {schema:1,publicKey:value.publicKey,urls:[...new Set(value.urls.map(updateUrl))],sequence:value.sequence};
}
export function publisherUrls(port=4317){
  if(!Number.isInteger(port) || port<1 || port>65535)throw new Error('更新来源端口无效');
  const ips=Object.values(os.networkInterfaces()).flat().filter(item=>item && !item.internal && item.family==='IPv4' && privateUpdateAddress(item.address)).map(item=>item.address);
  const names=/^[a-z0-9][a-z0-9-]{0,62}$/i.test(os.hostname()) ? [os.hostname()] : [];
  return [...new Set([...ips,...names].map(host=>updateUrl('http://'+host+':'+port)))].slice(0,8);
}
export async function releaseSigningKey(dataDir,{keyJson}={}){
  await fs.mkdir(dataDir,{recursive:true});
  // No private key enters the package or a network response.
  const keyFile=path.join(dataDir,'release-signing-key.json');
  let saved;
  try{saved=JSON.parse(keyJson || await fs.readFile(keyFile,'utf8'));}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    const pair=crypto.generateKeyPairSync('ed25519');
    saved={publicKey:pair.publicKey.export({format:'der',type:'spki'}).toString('base64'),privateKey:pair.privateKey.export({format:'pem',type:'pkcs8'})};
    try{await fs.writeFile(keyFile,JSON.stringify(saved),{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST')throw error;saved=JSON.parse(await fs.readFile(keyFile,'utf8'));}
  }
  const privateKey=crypto.createPrivateKey(saved.privateKey);
  if(privateKey.asymmetricKeyType!=='ed25519' || crypto.createPublicKey(privateKey).export({format:'der',type:'spki'}).toString('base64')!==saved.publicKey)throw new Error('发布签名密钥无效，请保留原密钥并检查配置');
  return {publicKey:saved.publicKey,privateKey};
}
function signedPayload(value){
  if(value?.schema!==1 || !/^[a-f0-9]{20}$/.test(value.version) || value.filename!=='connector-'+value.version+'.zip'
    || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size<1 || value.size>maxPackageSize
    || !Number.isSafeInteger(value.sequence) || value.sequence<1)throw new Error('更新版本信息无效');
  return {schema:1,version:value.version,filename:value.filename,sha256:value.sha256,size:value.size,sequence:value.sequence};
}
export function signRelease(value,key){
  const payload=signedPayload({...value,schema:1});
  return {...payload,signature:crypto.sign(null,Buffer.from(JSON.stringify(payload)),key.privateKey).toString('base64')};
}
export function verifyRelease(value,source){
  const payload=signedPayload(value);
  if(typeof value.signature!=='string' || !/^[A-Za-z0-9+/]{86}==$/.test(value.signature)
    || !crypto.verify(null,Buffer.from(JSON.stringify(payload)),publicKey(source.publicKey),Buffer.from(value.signature,'base64')))throw new Error('更新发布签名校验失败');
  if(payload.sequence<source.sequence)throw new Error('拒绝安装较旧的发布版本');
  return {...payload,signature:value.signature};
}
export async function boundedBytes(response,limit){
  const size=Number(response.headers.get('content-length'));
  if(size>limit)throw new Error('更新响应过大');
  let length=0;const chunks=[];
  try{for await(const chunk of response.body){length+=chunk.length;if(length>limit)throw new Error('更新响应过大');chunks.push(chunk);}}
  catch(error){await response.body?.cancel().catch(()=>{});throw error;}
  return Buffer.concat(chunks);
}
function sourceFailure(error){
  const code=error?.cause?.code || error?.code;
  if(error?.name==='TimeoutError' || code==='ETIMEDOUT')return '连接超时，请检查是否在同一局域网';
  if(code==='ECONNREFUSED')return '连接被拒绝，请检查发布电脑的服务和端口';
  if(code==='ENOTFOUND' || code==='EAI_AGAIN')return '电脑名无法解析';
  return error?.message==='fetch failed' ? '连接失败'+(code ? '（'+code+'）' : '') : error?.message || '连接失败';
}
async function lanCandidates(url,{resolve,timeout}){
  const parsed=new URL(url);if(isIP(parsed.hostname))return [];
  let timer;
  try{
    const addresses=await Promise.race([resolve(parsed.hostname,{all:true,family:4}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('电脑名解析超时')),timeout);})]);
    return [...new Set(addresses.filter(item=>item.family===4 && privateUpdateAddress(item.address) && !item.address.startsWith('127.')).map(item=>{const candidate=new URL(url);candidate.hostname=item.address;return candidate.origin;}))].slice(0,8);
  }finally{clearTimeout(timer);}
}
export async function availableRelease(source,{fetcher=fetch,timeout=2500,resolve=lookup}={}){
  source=updateSource(source);
  if(source.kind==='github')return githubRelease(source,{fetcher,timeout:Math.max(timeout,10000)});
  const probe=async url=>{
    const response=await fetcher(url+updateManifestPath,{redirect:'error',signal:AbortSignal.timeout(timeout)});
    if(!response.ok)throw new Error(response.status===403 ? '更新入口拒绝此网络地址（HTTP 403）' : '更新来源暂时不可用（HTTP '+response.status+'）');
    const manifest=verifyRelease(JSON.parse((await boundedBytes(response,16384)).toString('utf8')),source);
    return {url,manifest};
  };
  const results=await Promise.allSettled(source.urls.map(async url=>{
    try{return await probe(url);}catch(error){
      const failures=[url+'：'+sourceFailure(error)];
      // A Windows name can prefer IPv6 or a VPN address. Resolve its private
      // IPv4 addresses explicitly; every fallback still requires the pinned key.
      let candidates;try{candidates=await lanCandidates(url,{resolve,timeout});}catch(error){failures.push('电脑名解析：'+sourceFailure(error));candidates=[];}
      const fallback=await Promise.allSettled(candidates.map(probe));
      const verified=fallback.filter(result=>result.status==='fulfilled').map(result=>result.value).sort((a,b)=>b.manifest.sequence-a.manifest.sequence);
      if(verified.length)return verified[0];
      fallback.forEach((result,index)=>{if(result.status==='rejected')failures.push(candidates[index]+'：'+sourceFailure(result.reason));});
      throw new Error(failures.join('；'));
    }
  }));
  const verified=results.filter(result=>result.status==='fulfilled').map(result=>result.value).sort((a,b)=>b.manifest.sequence-a.manifest.sequence);
  if(!verified.length)throw new Error('局域网更新检查失败：'+results.filter(result=>result.status==='rejected').map(result=>result.reason.message).join('；'));
  return verified[0];
}
export async function downloadRelease(url,manifest,{fetcher=fetch,timeout=120000}={}){
  const response=typeof url==='object' && url?.kind==='github'
    ? await githubResponse(githubAssetUrl(url.url,url.repository),{fetcher,timeout})
    : await fetcher(updateUrl(url)+updatePackagePath(manifest.version),{redirect:'error',signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw new Error('更新安装包暂时不可用（HTTP '+response.status+'）');
  const bytes=await boundedBytes(response,manifest.size);
  if(bytes.length!==manifest.size || crypto.createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw new Error('更新安装包校验失败');
  return bytes;
}

// Only public, anonymous GitHub release traffic. Browser grants, Codex accounts
// and the publisher's GitHub credentials never enter update requests.
function githubAssetUrl(value,repository){
  const url=new URL(value);
  const download=url.hostname==='github.com' && url.pathname.startsWith('/'+repository+'/releases/download/');
  const api=url.hostname==='api.github.com' && url.pathname.startsWith('/repos/'+repository+'/releases/assets/')
    && /^[1-9]\d*$/.test(url.pathname.slice(('/repos/'+repository+'/releases/assets/').length));
  if(url.protocol!=='https:' || !(download || api) || url.port || url.username || url.password || url.search || url.hash)throw new Error('GitHub 更新附件地址无效');
  return url.href;
}
function githubAssetRequest(asset,repository){
  if(!Number.isSafeInteger(asset.id) || asset.id<1)throw new Error('GitHub 更新附件编号无效');
  return 'https://api.github.com/repos/'+repository+'/releases/assets/'+asset.id;
}
async function githubResponse(value,{fetcher,timeout}){
  const signal=AbortSignal.timeout(timeout);let url=new URL(value);
  for(let redirects=0;redirects<5;redirects++){
    const response=await fetcher(url.href,{redirect:'manual',signal,headers:{Accept:url.pathname.includes('/releases/assets/')?'application/octet-stream':'application/vnd.github+json','User-Agent':'CodexRemote-Updater','X-GitHub-Api-Version':'2022-11-28'}});
    if(![301,302,303,307,308].includes(response.status)){
      if(!response.ok)throw new Error(response.status===403 || response.status===429 ? 'GitHub 更新检查受限，请稍后再试' : 'GitHub 更新请求失败（HTTP '+response.status+'）');
      return response;
    }
    await response.body?.cancel();const next=new URL(response.headers.get('location'),url);
    if(next.protocol!=='https:' || next.port || next.username || next.password
      || !['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname))throw new Error('GitHub 更新下载重定向地址无效');
    url=next;
  }
  throw new Error('GitHub 更新下载重定向过多');
}
async function githubRelease(source,{fetcher,timeout}){
  const list=await githubResponse('https://api.github.com/repos/'+source.repository+'/releases?per_page=20',{fetcher,timeout});
  const releases=JSON.parse((await boundedBytes(list,2_000_000)).toString('utf8'));
  if(!Array.isArray(releases))throw new Error('GitHub 版本列表无效');
  // Old releases without an updater manifest are manual-install releases.
  const release=releases.find(item=>!item.draft && (source.channel==='preview' || !item.prerelease)
    && item.assets?.some(asset=>asset.name==='update-manifest.json' && asset.state==='uploaded'));
  if(!release)return {status:'empty'};
  const asset=release.assets.find(item=>item.name==='update-manifest.json');
  githubAssetUrl(asset.browser_download_url,source.repository);
  const response=await githubResponse(githubAssetRequest(asset,source.repository),{fetcher,timeout});
  const manifest=verifyRelease(JSON.parse((await boundedBytes(response,16384)).toString('utf8')),source);
  const archive=release.assets.find(item=>item.name===manifest.filename && item.state==='uploaded');
  if(!archive || archive.size!==manifest.size)throw new Error('GitHub 发布缺少完整的更新安装包');
  const expected='/'+source.repository+'/releases/download/'+encodeURIComponent(release.tag_name)+'/';
  for(const item of [asset,archive])if(new URL(githubAssetUrl(item.browser_download_url,source.repository)).pathname!==expected+item.name)throw new Error('GitHub 更新附件不属于同一发布版本');
  return {url:{kind:'github',repository:source.repository,url:githubAssetRequest(archive,source.repository)},manifest,
    release:{tag:String(release.tag_name).slice(0,120),name:String(release.name || release.tag_name).slice(0,200),notes:String(release.body || '此版本未提供更新说明。').slice(0,12000)}};
}
