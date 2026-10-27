import {randomBytes} from 'node:crypto';
import {downloadBytes,uploadBytes} from '../public/network-check.js';

// Mounted behind the existing browser authorization and same-origin checks.
export function createNetworkCheck({now=Date.now,uploadTimeoutMs=12000}={}){
  let payload;const last=new Map();let uploading=false,pingWindow=0,pingCount=0;
  return async(req,res,pathname)=>{
    if(!pathname.startsWith('/api/network-check/'))return false;
    const kind=pathname.slice('/api/network-check/'.length);
    const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store, no-transform'});res.end(JSON.stringify(value));};
    if(!['ping','download','upload'].includes(kind)){json(404,{error:'未知的网络检测操作'});return true;}
    if(req.method!==(kind==='upload' ? 'POST' : 'GET')){json(405,{error:'不支持的网络检测操作'});return true;}
    // Bound repeated clicks across all paired browsers; there are no timers or
    // packets until the user requests a test.
    const at=now(),previous=last.get(kind);
    if(at-pingWindow>=1000){pingWindow=at;pingCount=0;}
    if(kind==='ping' ? ++pingCount>12 : previous!=null && at-previous<5000){json(429,{error:'检测过于频繁，请稍后重试'});req.resume();return true;}
    if(kind==='upload' && uploading){json(429,{error:'已有上传检测正在进行'});req.resume();return true;}
    last.set(kind,now());
    if(kind==='ping'){json(200,{networkCheck:1});return true;}
    if(kind==='download'){
      payload ||= randomBytes(downloadBytes);
      res.writeHead(200,{'content-type':'application/octet-stream','content-length':payload.length,'cache-control':'no-store, no-transform','x-content-type-options':'nosniff'});
      res.end(payload);return true;
    }
    if(req.headers['content-length']!=null && Number(req.headers['content-length'])!==uploadBytes){json(413,{error:'上传检测只接收固定大小的测试数据'});req.resume();return true;}
    uploading=true;
    await new Promise(resolve=>{
      let bytes=0,finished=false;
      const done=(status,value)=>{
        if(finished)return;finished=true;clearTimeout(timeout);uploading=false;
        req.removeListener('data',onData);req.removeListener('end',onEnd);req.removeListener('aborted',onAbort);req.removeListener('error',onAbort);res.removeListener('close',onAbort);
        if(status && !res.destroyed)json(status,value);req.resume();resolve();
      };
      const onData=chunk=>{bytes+=chunk.length;if(bytes>uploadBytes)done(413,{error:'上传测试数据过大'});};
      const onEnd=()=>done(bytes===uploadBytes ? 200 : 400,bytes===uploadBytes ? {bytes} : {error:'上传测试数据不完整'});
      const onAbort=()=>done();
      const timeout=setTimeout(()=>done(408,{error:'上传检测超时'}),uploadTimeoutMs);timeout.unref?.();
      req.on('data',onData);req.once('end',onEnd);req.once('aborted',onAbort);req.once('error',onAbort);res.once('close',onAbort);
    });
    return true;
  };
}
