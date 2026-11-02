import os from 'node:os';
import path from 'node:path';
import {readFile} from 'node:fs/promises';

// Read only the local Desktop's new-chat permission selection. Thread-specific
// permissions and account/profile caches are deliberately not returned.
export function desktopNewChatPermission(state) {
  const selected=state?.['electron-persisted-atom-state']?.['permission-selection-by-host-id:local'];
  if(selected?.kind!=='agent-mode')return null;
  return ({'read-only':'read-only',auto:'workspace-write','full-access':'danger-full-access'})[selected.agentMode] || null;
}

export async function readDesktopNewChatPermission(home=process.env.CODEX_HOME || path.join(os.homedir(),'.codex')) {
  try{return desktopNewChatPermission(JSON.parse((await readFile(path.join(home,'.codex-global-state.json'),'utf8')).replace(/^\ufeff/,'')));}
  catch(error){if(['ENOENT','EACCES','EPERM'].includes(error.code) || error instanceof SyntaxError)return null;throw error;}
}
