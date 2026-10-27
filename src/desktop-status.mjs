import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { reconnectStatus } from '../public/runtime-status.js';

// Desktop does not persist retry notifications in its rollout. Read only the
// thread-scoped retry diagnostics; never expose arbitrary log bodies to Relay.
export function statusFromLog(row) {
  const body = String(row.feedback_log_body || '');
  const turnId = body.match(/\bturn_id="?([a-f\d-]{36})/i)?.[1] || body.match(/\bturn\.id="?([a-f\d-]{36})/i)?.[1];
  if (!row.thread_id || !turnId) return null;
  const at = row.ts * 1000 + Math.floor((row.ts_nanos || 0) / 1_000_000);
  if (row.target === 'codex_core::responses_retry' && /stream disconnected - retrying sampling request/.test(body)) {
    const count = body.match(/\((\d+)\/(\d+) in /);
    const detail = body.match(/\bsampling_error=(.*)$/)?.[1];
    const notice = reconnectStatus({attempt:count?.[1],maxAttempts:count?.[2],message:detail}, at);
    return { ...notice, id:`desktop-retry-${row.id}`, turnId, threadId:row.thread_id, role:'process' };
  }
  if (/compact/.test(row.target) && /(?:context compaction|compacting context|compaction) (?:started|starting|completed)/i.test(body)) {
    return {id:`desktop-compact-${row.id}`,threadId:row.thread_id,turnId,role:'process',kind:'contextCompaction',at,
      status:/compaction completed/i.test(body) ? 'completed' : 'inProgress'};
  }
  return null;
}

export class DesktopStatusReader {
  constructor(directory) { this.directory=directory; this.cursors=new Map(); this.notices=new Map(); }
  async open() {
    if (this.db) return;
    const files=(await readdir(this.directory)).filter(name=>/^logs_\d+\.sqlite$/.test(name)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
    if (!files.length) return;
    const { DatabaseSync } = await import('node:sqlite');
    this.filename=files[0];
    this.db=new DatabaseSync(path.join(this.directory,this.filename),{readOnly:true});
    this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=50;');
    this.query=this.db.prepare(`SELECT id,ts,ts_nanos,target,thread_id,feedback_log_body FROM logs
      WHERE thread_id=? AND ts>=? AND id>? AND (target='codex_core::responses_retry' OR target LIKE '%compact%') ORDER BY id LIMIT 256`);
  }
  async read(threadId, turns, aliases = new Map()) {
    try {
      await this.open();
      if (!this.db || !turns.length) return turns;
      const since=Math.floor(Math.min(...turns.map(turn=>turn.startedAt || Date.now()))/1000);
      const saved=this.cursors.get(threadId);
      let cursor=saved?.since === since ? saved.id : 0;
      let notices=this.notices.get(threadId) || new Map();
      const ids=new Set(turns.map(turn=>turn.id));
      for (const [id,notice] of notices) if (!ids.has(notice.turnId)) notices.delete(id);
      for (const row of this.query.all(threadId,since,cursor)) {
        cursor=Math.max(cursor,row.id);
        const notice=statusFromLog(row);
        if (notice) notice.turnId=aliases.get(notice.turnId) || notice.turnId;
        if (notice && ids.has(notice.turnId)) notices.set(notice.id,notice);
      }
      this.cursors.set(threadId,{id:cursor,since}); this.notices.set(threadId,notices);
      return turns.map(turn=>{
        const extra=[...new Map([...(turn.notices || []),...[...notices.values()].filter(notice=>notice.turnId === turn.id)].map(notice=>[notice.id,notice])).values()].sort((a,b)=>a.at-b.at);
        const latest=extra.at(-1);
        const observedAt=Math.max(turn.activity?.at || 0,turn.lastUpdateAt || 0);
        const live=turn.status === 'inProgress' && latest && latest.at >= observedAt;
        return { ...turn, notices:extra, ...(live ? {activity:latest} : {}) };
      });
    } catch { return turns; } // A different Desktop schema must not stop history.
  }
  forget(threadId) { this.cursors.delete(threadId);this.notices.delete(threadId); }
  close() { this.db?.close();this.db=null; }
}
