import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Callers must authorize the original conversation reference before resolving it.
export function localFilePath(ref,cwd='.') {
  let source=ref.startsWith('file:') ? fileURLToPath(ref) : ref;
  // Desktop links may prefix an absolute drive path with a slash. Windows
  // otherwise roots /D:/file on the working drive, producing D:\D:\file.
  if(process.platform==='win32' && /^[/\\][a-z]:[/\\]/i.test(source))source=source.slice(1);
  return path.resolve(cwd || '.',source);
}
