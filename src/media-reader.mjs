import {open,stat} from 'node:fs/promises';
import {localFilePath} from './local-file-path.mjs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {decodeImage,imageMime,MAX_IMAGE_BYTES} from './media.mjs';
import {mediaKind,mediaName} from '../public/media-types.js';

export const MEDIA_CHUNK_BYTES=256 * 1024;
const MAX_MEDIA_BYTES=512 * 1024 * 1024;

function mimeFor(bytes,ref) {
  const image=imageMime(bytes);if(image)return image;
  if(bytes.subarray(0,3).toString()==='ID3' || bytes[0]===0xff && (bytes[1]&0xe0)===0xe0)return 'audio/mpeg';
  if(bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WAVE')return 'audio/wav';
  if(bytes.subarray(0,4).toString()==='OggS')return 'audio/ogg';
  if(bytes.subarray(4,8).toString()==='ftyp')return mediaKind(ref)==='audio' ? 'audio/mp4' : 'video/mp4';
  if(bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return 'video/webm';
  throw new Error('不支持该附件的文件格式。');
}

export class MediaReader {
  constructor({thumbnail=makeThumbnail,maxEntries=64,maxBytes=8 * 1024 * 1024}={}) {
    Object.assign(this,{thumbnail,maxEntries,maxBytes});this.previews=new Map();this.pending=new Map();this.bytes=0;this.activePreviews=0;this.previewQueue=[];
  }

  async info(source,cwd,ref) {
    if(source.dataUrl) {
      const {bytes,mime}=decodeImage(source.dataUrl);
      return {size:bytes.length,mime,name:mediaName(ref),version:createHash('sha256').update(bytes).digest('hex'),bytes};
    }
    if(!source.path)throw new Error('附件不存在。');
    const file=localFilePath(source.path,cwd);
    const entry=await stat(file);
    if(!entry.isFile() || !entry.size || entry.size>MAX_MEDIA_BYTES)throw new Error('附件为空或超过 512 MB。');
    const handle=await open(file,'r');let header;
    try{header=Buffer.alloc(Math.min(64,entry.size));await handle.read(header,0,header.length,0);}finally{await handle.close();}
    const mime=mimeFor(header,ref);
    if(mime.startsWith('image/') && entry.size>MAX_IMAGE_BYTES)throw new Error('图片超过 10 MB。');
    return {file,size:entry.size,mime,name:mediaName(ref),version:createHash('sha256').update(file+':'+entry.size+':'+entry.mtimeMs+':'+entry.ctimeMs).digest('hex')};
  }

  async read(source,cwd,ref,{action='info',offset=0,length=MEDIA_CHUNK_BYTES,version}={}) {
    const info=await this.info(source,cwd,ref);
    if(version && version!==info.version)throw new Error('附件已更新，请重新打开。');
    const {bytes:embedded,file,...metadata}=info;
    if(action==='info')return metadata;
    if(action==='preview') {
      if(!info.mime.startsWith('image/'))throw new Error('该附件不支持小图预览。');
      const key=info.version;
      let preview=this.previews.get(key);
      if(preview){this.previews.delete(key);this.previews.set(key,preview);}
      else {
        if(!this.pending.has(key)){
          if(this.pending.size>=16)throw new Error('预览生成中，请稍后重试。');
          const job=(async()=>{
            if(this.activePreviews>=2)await new Promise(resolve=>this.previewQueue.push(resolve));
            else this.activePreviews++;
            try {
              const image=embedded || await this.readBytes(file,0,info.size);
              const bytes=await this.thumbnail(image);
              if(imageMime(bytes)!=='image/webp' || bytes.length>2*1024*1024)throw new Error('预览图片无效。');
              this.previews.set(key,bytes);this.bytes+=bytes.length;
              while(this.previews.size>this.maxEntries || this.bytes>this.maxBytes){const oldest=this.previews.keys().next().value;this.bytes-=this.previews.get(oldest).length;this.previews.delete(oldest);}
              return bytes;
            } finally {
              const next=this.previewQueue.shift();if(next)next();else this.activePreviews--;
            }
          })();this.pending.set(key,job);job.finally(()=>this.pending.delete(key)).catch(()=>{});
        }
        preview=await this.pending.get(key);
      }
      return {...metadata,mime:'image/webp',size:preview.length,body:preview.toString('base64')};
    }
    if(action!=='read' || !Number.isSafeInteger(offset) || offset<0 || offset>=info.size || !Number.isSafeInteger(length) || length<1 || length>MEDIA_CHUNK_BYTES)throw new Error('附件读取范围无效。');
    const size=Math.min(length,info.size-offset);
    const bytes=embedded ? embedded.subarray(offset,offset+size) : await this.readBytes(file,offset,size);
    if(bytes.length!==size)throw new Error('附件已更新，请重新打开。');
    return {...metadata,offset,body:bytes.toString('base64')};
  }

  async readBytes(file,offset,length) {
    const handle=await open(file,'r');
    try{const bytes=Buffer.alloc(length);let read=0;while(read<length){const result=await handle.read(bytes,read,length-read,offset+read);if(!result.bytesRead)break;read+=result.bytesRead;}return bytes.subarray(0,read);}
    finally{await handle.close();}
  }
}

export function makeThumbnail(bytes) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.CODEX_RELAY_FFMPEG || 'ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-i','pipe:0','-frames:v','1','-vf',"scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease",'-c:v','libwebp','-quality','55','-f','webp','pipe:1'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks=[];let size=0,failed=false;
    const fail=error=>{if(failed)return;failed=true;clearTimeout(timer);child.kill();reject(error);};
    const timer=setTimeout(()=>fail(new Error('预览生成超时，请重试或打开原图。')),12000);
    child.on('error',()=>fail(new Error('图片预览需要 FFmpeg；可使用“原图”。')));
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024)fail(new Error('预览图片过大。'));else chunks.push(chunk);});
    child.stderr.resume();child.stdin.on('error',()=>{});
    child.on('close',code=>{clearTimeout(timer);if(failed)return;if(code!==0)reject(new Error('无法生成预览，可重试或打开原图。'));else resolve(Buffer.concat(chunks));});
    child.stdin.end(bytes);
  });
}
