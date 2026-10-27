import {readFile,realpath,stat,open} from 'node:fs/promises';
import path from 'node:path';
import {localFilePath} from './local-file-path.mjs';
import {createHash} from 'node:crypto';
import {isLocalPreview,isLocalDocument} from '../public/html-links.js';
import {renderDocument} from './document-preview.mjs';
import {MEDIA_CHUNK_BYTES} from './media-reader.mjs';

const types={'.html':'text/html','.htm':'text/html','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.avif':'image/avif','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.json':'application/json','.txt':'text/plain','.glb':'application/octet-stream','.blend':'application/octet-stream'};
export const previewMimes=new Set(Object.values(types));
export const previewHeaders={'content-security-policy':"sandbox allow-same-origin allow-downloads; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",'referrer-policy':'no-referrer'};
// Opt-in self-contained animations execute in an opaque origin: no Relay cookies,
// storage, network APIs, external scripts, popups or access to the opening window.
export const interactivePreviewHeaders={'content-security-policy':"sandbox allow-scripts; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",'referrer-policy':'no-referrer'};
const inside=(root,file)=>{const relative=path.relative(root,file);return !path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep);};
const version=(file,info)=>createHash('sha256').update(file+':'+info.size+':'+info.mtimeMs+':'+info.ctimeMs).digest('hex');
function references(text){
  const refs=[];
  for(const match of text.matchAll(/\b(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))|url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)|@import\s+["']([^"']+)["']/gi))refs.push(match.slice(1).find(value=>value!==undefined));
  for(const match of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi))for(const candidate of match[1].split(','))refs.push(candidate.trim().split(/\s+/)[0]);
  return refs;
}
export class HtmlPreviewReader {
  constructor(){this.manifests=new Map();this.documents=new Map();this.documentBytes=0;}
  async document(command,file){
    if(command.resource!==path.basename(file))throw new Error('文档预览仅允许读取本文件。');
    const info=await stat(file);
    if(!info.isFile() || info.size>1024*1024)throw new Error('文本预览仅支持 1 MB 以内的文件。');
    const signature=version(file,info);let cached=this.documents.get(file);
    if(!cached || cached.signature!==signature || Date.now()-cached.at>2000){
      const bytes=await readFile(file);
      if(bytes.length>1024*1024 || bytes.includes(0))throw new Error('文件不是支持的 UTF-8 文本文档。');
      let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('文件不是支持的 UTF-8 文本文档。');}
      const body=Buffer.from(renderDocument(text,path.basename(file),{plain:/\.txt$/i.test(file)}));
      if(cached){this.documentBytes-=cached.body.length;this.documents.delete(file);}
      cached={signature,body,at:Date.now()};this.documents.set(file,cached);this.documentBytes+=body.length;
      while(this.documents.size>16 || this.documentBytes>8*1024*1024){const key=this.documents.keys().next().value;this.documentBytes-=this.documents.get(key).body.length;this.documents.delete(key);}
    }
    const metadata={size:cached.body.length,mime:'text/html',name:path.basename(file),version:signature};
    if(command.version && command.version!==signature)throw new Error('文档已更新，请重新打开。');
    if(command.action==='info')return metadata;
    const {offset=0,length=MEDIA_CHUNK_BYTES}=command;
    if(command.action!=='read' || !Number.isSafeInteger(offset) || offset<0 || offset>=metadata.size || !Number.isSafeInteger(length) || length<1 || length>MEDIA_CHUNK_BYTES)throw new Error('读取范围无效。');
    return {...metadata,offset,body:cached.body.subarray(offset,offset+length).toString('base64')};
  }
  async manifest(rootFile){
    const info=await stat(rootFile),signature=version(rootFile,info),cached=this.manifests.get(rootFile);
    if(cached?.signature===signature && Date.now()-cached.at<2000)return cached;
    const root=path.dirname(rootFile),allowed=new Set([path.basename(rootFile)]),queue=[path.basename(rootFile)];let bytes=0;
    while(queue.length){
      const relative=queue.shift();let filename;try{filename=await realpath(path.resolve(root,relative));}catch{continue;}if(!inside(root,filename))continue;
      const entry=await stat(filename);if(entry.size>4*1024*1024)throw new Error('HTML 或样式文件超过 4 MB。');
      bytes+=entry.size;if(bytes>8*1024*1024)throw new Error('预览页面资源清单过大。');
      const text=await readFile(filename,'utf8');
      for(const value of references(text)){
        const ref=value.replace(/&amp;/gi,'&').trim();if(!ref || ref[0]==='#' || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|\\)/i.test(ref))continue;
        let target;try{target=path.resolve(root,path.dirname(relative),decodeURIComponent(ref.split(/[?#]/)[0]).replaceAll('\\','/'));}catch{continue;}
        const resource=path.relative(root,target).replaceAll(path.sep,'/'),ext=path.extname(target).toLowerCase();
        if(!inside(root,target) || !types[ext] || allowed.has(resource))continue;
        if(allowed.size>=256)throw new Error('预览资源超过 256 项。');
        allowed.add(resource);
        if(['.css','.html','.htm'].includes(ext))queue.push(resource);
      }
    }
    const result={root,allowed,signature,at:Date.now()};this.manifests.set(rootFile,result);
    while(this.manifests.size>32)this.manifests.delete(this.manifests.keys().next().value);
    return result;
  }
  async read(command){
    if(command.approvedRef!==command.ref || !isLocalPreview(command.ref))throw new Error('预览文件没有出现在这条对话中。');
    const document=isLocalDocument(command.ref);
    let ref=command.ref.split(/[?#]/)[0];if(document)ref=ref.replace(/:\d+$/,'');
    const rootFile=await realpath(localFilePath(ref,command.cwd));
    if(document)return this.document(command,rootFile);
    const manifest=await this.manifest(rootFile);
    const resource=command.resource;
    if(typeof resource!=='string' || resource.includes('\\') || resource.includes('\0') || !manifest.allowed.has(resource))throw new Error('资源没有出现在预览页面中。');
    const file=await realpath(path.resolve(manifest.root,resource));if(!inside(manifest.root,file))throw new Error('预览资源超出了报告目录。');
    const entry=await stat(file),mime=types[path.extname(file).toLowerCase()];
    if(!entry.isFile() || !mime || entry.size<1 || entry.size>512*1024*1024)throw new Error('预览资源为空、过大或类型不支持。');
    const metadata={size:entry.size,mime,name:path.basename(file),version:version(file,entry)};
    if(command.version && command.version!==metadata.version)throw new Error('预览文件已更新，请重新打开。');
    if(command.action==='info')return metadata;
    const {offset=0,length=MEDIA_CHUNK_BYTES}=command;
    if(command.action!=='read' || !Number.isSafeInteger(offset) || offset<0 || offset>=entry.size || !Number.isSafeInteger(length) || length<1 || length>MEDIA_CHUNK_BYTES)throw new Error('读取范围无效。');
    const handle=await open(file,'r');
    try{const buffer=Buffer.alloc(Math.min(length,entry.size-offset));let read=0;while(read<buffer.length){const chunk=await handle.read(buffer,read,buffer.length-read,offset+read);if(!chunk.bytesRead)break;read+=chunk.bytesRead;}if(read!==buffer.length)throw new Error('预览文件已更新。');return {...metadata,offset,body:buffer.toString('base64')};}
    finally{await handle.close();}
  }
}
