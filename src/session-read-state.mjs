import fs from 'node:fs';
import path from 'node:path';
import { processingStatuses, completedStatuses } from '../public/session-status.js';

export function completionToken(session) {
  if (!completedStatuses.includes(session.status) || session.source === 'imported' && !session.historyLoaded) return null;
  const latest = session.turns?.at(-1);
  const final = [...(session.events || [])].reverse().find(event => {
    const item = event.message?.params?.item;
    return item?.type === 'agentMessage' && item.phase === 'final_answer'
      && (!latest?.id || (event.turnId || event.message?.params?.turnId) === latest.id);
  });
  const at = latest?.completedAt || session.completedAt || final?.at || latest?.startedAt || session.updatedAt;
  if (!at) return null;
  const turnId=latest?.id || final?.message.params.turnId || [...(session.events || [])].reverse().find(event=>event.message?.method==='turn/completed')?.message.params.turn?.id;
  return turnId ? JSON.stringify(['turn',turnId]) : JSON.stringify(['reply',final?.message.params.item.id || session.id,final?.message.params.item.id ? null : at]);
}

function canonicalToken(token) {
  if(!token)return null;
  let parts;try{parts=JSON.parse(token);}catch{return token;}
  if(!Array.isArray(parts) || ['turn','reply'].includes(parts[0]))return token;
  return typeof parts[0]==='string' ? JSON.stringify(['turn',parts[0]]) : token;
}

export class SessionReadState {
  constructor(directory) {
    this.file = path.join(directory, 'session-read-state.json'); this.entries = {};
    try {
      const saved=JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.entries = saved.sessions || {};
      for(const entry of Object.values(this.entries)){entry.completion=canonicalToken(entry.completion);entry.read=canonicalToken(entry.read);}
      // Keep our own receipts. Desktop flags must neither resurrect an already
      // read reply nor clear a completion that has not been read remotely.
      let migrated=saved.version!==3;
      for(const entry of Object.values(this.entries))if(Object.hasOwn(entry,'desktop')){delete entry.desktop;migrated=true;}
      if(migrated)this.save();
    } catch { /* first use or lost preferences */ }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive:true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version:3, sessions:this.entries }), { mode:0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  observe(session) {
    // A freshly imported thread's list metadata may be active before its older
    // completed history arrives. Establish the baseline from that history.
    if (session.source === 'imported' && !session.historyLoaded) return;
    const token = completionToken(session);
    if (!token && !processingStatuses.includes(session.status)) return;
    const previous = this.entries[session.id];
    if (!previous) {
      // Existing finished history is the baseline, rather than a flood of new unread replies.
      this.entries[session.id] = { completion:token, read:token }; this.save();
    } else if (token && token !== previous.completion) {
      previous.completion = token; this.save();
    }
  }
  status(id) {
    const entry = this.entries[id];
    return { completionToken:entry?.completion || null, unread:Boolean(entry?.completion && entry.read !== entry.completion),readSource:'relay' };
  }
  matches(id,token){return Boolean(token && this.entries[id]?.completion===token);}
  markRead(id, token) {
    const entry = this.entries[id];
    if (!token || !entry || token !== entry.completion) return { matched:false, changed:false };
    const changed = entry.read !== token;
    if (changed) { entry.read = token; this.save(); }
    return { matched:true, changed };
  }
}
