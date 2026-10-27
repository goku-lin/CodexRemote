import {decodeImage} from './media.mjs';

export async function hydrateImageInput(input,readUpload){
  const resolved=[];
  for(const part of input){
    if(part.type!=='image' || !part.uploadId){resolved.push(part);continue;}
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(part.uploadId))throw new Error('图片编号无效，输入尚未提交。');
    const dataUrl=await readUpload(part.uploadId);decodeImage(dataUrl);
    resolved.push({type:'image',url:dataUrl});
  }
  return resolved;
}
