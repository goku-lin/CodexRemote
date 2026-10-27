export function mediaKind(ref = '') {
  const value = String(ref).split(/[?#]/)[0];
  if (/\.(png|jpe?g|gif|webp)$/i.test(value) || /^inline:|^data:image\//i.test(value)) return 'image';
  if (/\.(mp3|wav|m4a|ogg|oga)$/i.test(value)) return 'audio';
  if (/\.(mp4|webm)$/i.test(value)) return 'video';
  return null;
}

export function mediaName(ref = '') {
  if (/^inline:|^data:/i.test(ref)) return '附图';
  try { return decodeURIComponent(String(ref).split(/[?#]/)[0].split(/[\\/]/).at(-1)) || '附件'; }
  catch { return '附件'; }
}
