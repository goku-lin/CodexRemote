import {createHash} from 'node:crypto';
import {MediaReader,MEDIA_CHUNK_BYTES} from './media-reader.mjs';
import {decodeImage,imageMime} from './media.mjs';
const uploadPreviews=new MediaReader();
const mimes=new Set(['image/png','image/jpeg','image/gif','image/webp','audio/mpeg','audio/wav','audio/ogg','audio/mp4','video/mp4','video/webm']);

export function mediaRange(value,size) {
  if(!value)return null;
  const match=String(value).match(/^bytes=(\d*)-(\d*)$/);
  if(!match || !match[1] && !match[2])throw new Error('Range');
  let start=match[1] ? Number(match[1]) : Math.max(0,size-Number(match[2]));
  let end=match[1] && match[2] ? Number(match[2]) : size-1;
  if(!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<0 || start>=size || end<start || !match[1] && Number(match[2])===0)throw new Error('Range');
  return {start,end:Math.min(end,size-1,start+MEDIA_CHUNK_BYTES-1)};
}

function json(res,status,data,headers={}) {
  const text=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(text);
}
function waitForDrain(res) {
  return new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);});
}

export async function serveMedia(req,res,url,read,{allowedMimes=mimes,extraHeaders={},attachment=false}={}) {
  try {
    let info=await read({action:'info'});
    // Old executors can still deliver an image, with no automatic original fallback.
    if(info.dataUrl){const image=decodeImage(info.dataUrl);return serveImageBytes(req,res,url,{...image,name:'附图'});}
    if(!allowedMimes.has(info.mime) || !Number.isSafeInteger(info.size) || info.size<1 || info.size>512*1024*1024 || !/^[a-f0-9]{64}$/.test(info.version))throw new Error('附件信息无效，请更新执行服务。');
    if(url.searchParams.get('info')==='1')return json(res,200,{size:info.size,mime:info.mime,name:info.name,version:info.version});
    if(url.searchParams.get('preview')==='1') {
      if(!info.mime.startsWith('image/'))throw new Error('此附件不支持图片预览。');
      const preview=await read({action:'preview',version:info.version});
      const bytes=Buffer.from(preview.body || '','base64');
      if(!bytes.length || bytes.length>2*1024*1024 || imageMime(bytes)!=='image/webp')throw new Error('预览图片无效。');
      res.writeHead(200,{'content-type':'image/webp','content-length':bytes.length,'cache-control':'private, max-age=3600','x-content-type-options':'nosniff'});return res.end(req.method==='HEAD' ? undefined : bytes);
    }
    const etag='"'+info.version+'"';
    let range;
    try {range=mediaRange(req.headers['if-range'] && req.headers['if-range']!==etag ? null : req.headers.range,info.size);}
    catch{return json(res,416,{error:'附件读取范围无效。'},{'content-range':'bytes */'+info.size});}
    const start=range?.start || 0,end=range?.end ?? info.size-1;
    const headers={'content-type':info.mime.startsWith('text/') ? info.mime+'; charset=utf-8' : info.mime,'content-length':end-start+1,'accept-ranges':'bytes',etag,'cache-control':'private, max-age=0, must-revalidate','x-content-type-options':'nosniff',...extraHeaders};
    if(range)headers['content-range']=`bytes ${start}-${end}/${info.size}`;
    if(attachment || info.mime==='application/octet-stream' || url.searchParams.get('download')==='1')headers['content-disposition']="attachment; filename*=UTF-8''"+encodeURIComponent(info.name || '附件').replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
    if(req.method==='HEAD'){res.writeHead(range ? 206 : 200,headers);return res.end();}
    let position=start;
    while(position<=end && !res.destroyed) {
      const length=Math.min(MEDIA_CHUNK_BYTES,end-position+1);
      const result=await read({action:'read',offset:position,length,version:info.version});
      const bytes=Buffer.from(result.body || '','base64');
      if(bytes.length!==length || result.version!==info.version || result.offset!==position)throw new Error('附件内容发生变化，请重新打开。');
      if(res.destroyed)return;
      if(!res.headersSent)res.writeHead(range ? 206 : 200,headers);
      position+=bytes.length;
      if(!res.write(bytes))await waitForDrain(res);
    }
    if(!res.destroyed)res.end();
  } catch(error) {
    if(res.destroyed)return;
    if(res.headersSent)return res.destroy();
    json(res,404,{error:error.message});
  }
}

export function serveImageBytes(req,res,url,{bytes,mime,name}) {
  const version=createHash('sha256').update(bytes).digest('hex');
  return serveMedia(req,res,url,async options=>{
    const info={size:bytes.length,mime,name,version};
    if(options.action==='info')return info;
    if(options.action==='preview')return uploadPreviews.read({dataUrl:`data:${mime};base64,${bytes.toString('base64')}`},'',name,{action:'preview'});
    return {...info,offset:options.offset,body:bytes.subarray(options.offset,options.offset+options.length).toString('base64')};
  });
}
