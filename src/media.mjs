export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
import {mediaKind} from '../public/media-types.js';
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function decodeImage(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error('请上传 PNG、JPEG、WebP 或 GIF 图片。');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('每张图片不能超过 10 MB。');
  const actual = imageMime(bytes);
  if (!actual) throw new Error('文件不是支持的图片格式。');
  return { bytes, mime: actual };
}

export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export function imageReferences(text = '', content = []) {
  const refs = [];
  const explicit=new Set();
  for (const match of String(text).matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\n)]+))\)|<image\b[^>]*\bpath=["']([^"']+)["'][^>]*>/gi)) {
    const ref=(match[1] || match[2] || match[3]).trim(); refs.push(ref);
    if (/^(?:!|<image)/i.test(match[0])) explicit.add(ref);
  }
  for (const part of content || []) {
    if (['image', 'input_image', 'localImage', 'local_image'].includes(part.type)) {
      const ref = part.path || part.url || part.image_url;
      if (typeof ref === 'string') { refs.push(ref); explicit.add(ref.trim()); }
    }
  }
  return [...new Set(refs.map(ref => ref.trim()))].filter(ref => /^data:image\/(png|jpeg|webp|gif);base64,/.test(ref) || /\.(png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(ref) || explicit.has(ref) && /^https?:\/\//i.test(ref));
}
import {readFile,stat} from 'node:fs/promises';
import {localFilePath} from './local-file-path.mjs';


export function authorizedMediaSource(ref,registered,approvedRef) {
  if (registered) return registered;
  // approvedRef comes only from the server after checking conversation refs.
  // Restored local paths can be read before rollout subscriptions finish loading.
  if (approvedRef!==ref || !mediaKind(ref) || /^(?!file:|[a-z]:[\\/])[a-z][a-z0-9+.-]*:/i.test(ref)) throw new Error('该附件没有出现在对话中。');
  return {path:ref};
}

export function mediaReferences(text = '', content = []) {
  const refs = new Set(imageReferences(text, content));
  for (const match of String(text).matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\n)]+))\)/g)) {
    const ref=(match[1] || match[2]).trim();
    if(mediaKind(ref))refs.add(ref);
  }
  return [...refs];
}

export async function mediaDataUrl(source,cwd) {
  let dataUrl=source.dataUrl;
  if (source.path) {
    const filePath=localFilePath(source.path,cwd);
    const info=await stat(filePath); if(info.size>MAX_IMAGE_BYTES) throw new Error('图片超过 10 MB。');
    const bytes=await readFile(filePath); const mime=imageMime(bytes);
    if (!mime) throw new Error('文件不是支持的图片格式。');
    dataUrl=`data:${mime};base64,${bytes.toString('base64')}`;
  }
  decodeImage(dataUrl);return dataUrl;
}
