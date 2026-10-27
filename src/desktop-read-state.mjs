import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Match Desktop's account partition without returning credentials or account
// identifiers. Only the read-state subset of global storage is consumed.
export function desktopReadSnapshot(global,auth) {
  const state=global?.['electron-thread-read-state-v1'];
  if(state?.version!==1)return null;
  for(const token of [auth?.tokens?.id_token,auth?.tokens?.access_token]) {
    if(typeof token!=='string')continue;
    let claims;try{claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));}catch{continue;}
    const info=claims['https://api.openai.com/auth'] || {};
    const accountId=auth.tokens.account_id || info.chatgpt_account_id,userId=info.chatgpt_user_id || info.user_id || claims.sub;
    if(!accountId || !userId)continue;
    const identity=hash(['chatgpt',accountId,userId]),hosts=state.unreadByIdentity?.[identity];
    const local=Object.entries(hosts || {}).filter(([key,ids])=>key.startsWith('local:') && Array.isArray(ids));
    if(local.length!==1)continue;
    return {contextKey:hash([identity,local[0][0]]),unreadThreadIds:local[0][1].filter(id=>typeof id==='string')};
  }
  return null;
}

export class DesktopReadStateReader {
  constructor(directory,bridge) {this.directory=directory;this.bridge=bridge;}
  async read(threadIds) {
    const scope=new Set(threadIds);
    try {
      const filename=path.join(this.directory,'.codex-global-state.json'),authFile=path.join(this.directory,'auth.json');
      const [globalInfo,authInfo]=await Promise.all([stat(filename),stat(authFile)]);
      if(globalInfo.size>16*1024*1024 || authInfo.size>1024*1024)return null;
      const signature=JSON.stringify([globalInfo.mtimeMs,globalInfo.size,authInfo.mtimeMs,authInfo.size]);
      if(signature!==this.signature) {
        const [global,auth]=await Promise.all([readFile(filename,'utf8'),readFile(authFile,'utf8')]);
        this.snapshot=desktopReadSnapshot(JSON.parse(global),JSON.parse(auth));this.signature=signature;
      }
      if(this.snapshot)return {...this.snapshot,scopeThreadIds:[...scope],unreadThreadIds:this.snapshot.unreadThreadIds.filter(id=>scope.has(id)),observedAt:globalInfo.mtimeMs};
    } catch { /* A partial atomic write or unavailable account is retried later. */ }
    return null;
  }
  async markRead(command,validate) {
    const before=await this.read([command.threadId]);
    if(!before || before.contextKey!==command.contextKey)throw new Error('桌面账号或已读状态已变化，请同步后重试。');
    await validate();
    const submittedAt=Date.now();
    await this.bridge.tool('set_thread_read_state',{threadId:command.threadId,hostId:'local',source:'codex',read:true});
    return {contextKey:before.contextKey,submittedAt};
  }
}
