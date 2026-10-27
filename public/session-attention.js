const busy = new Set(['starting','running','waiting_input','waiting_approval','interrupting']);
const closed = new Set(['answered','resolved','sent','forwarded','sending']);

export function pendingQuestion(item, session = {}) {
  if (!item?.questions?.length || closed.has(item.answerState) || !busy.has(session.status)) return false;
  if (item.questions.every(question => typeof item.questionAnswers?.[question.id] === 'string')) return false;
  if (session.activeTurnId && item.turnId && item.turnId !== session.activeTurnId) return false;
  const turn = session.turns?.find(turn => turn.id === item.turnId);
  return !turn || ['inProgress','running','waiting_input'].includes(turn.status);
}

// Small summaries let inactive chats show pending work without fetching history.
export function sessionAttention(session = {}, view) {
  if (!busy.has(session.status)) return [];
  if (session.pendingAttention?.length === 0) return [];
  const entries = new Map((session.pendingAttention || []).map(item => [item.id,item]));
  const questions = new Map();
  for (const event of session.events || []) {
    const item = event.message?.params?.item;
    if (item?.questions?.length) questions.set(item.id,{...item});
    if (event.type === 'question_updated' && questions.has(event.itemId)) Object.assign(questions.get(event.itemId),event.patch);
  }
  for (const item of session.questionItems?.values?.() || []) questions.set(item.id,item);
  for (const item of view?.timeline || []) if (item.questions?.length) questions.set(item.id,item);
  for (const item of questions.values()) {
    if (session.pendingAttention !== undefined && !entries.has(item.id)) continue;
    entries.delete(item.id);
    if (pendingQuestion(item,session)) entries.set(item.id,{id:item.id,kind:'question',turnId:item.turnId || null});
  }
  if (view?.approvals && session.pendingAttention === undefined) {
    for (const [id,item] of entries) if (item.kind === 'approval') entries.delete(id);
    for (const [id] of view.approvals) entries.set(id,{id,kind:'approval'});
  }
  if (session.pendingAttention === undefined) {
    if (session.status === 'waiting_input' && ![...entries.values()].some(item=>item.kind==='question')) entries.set('$question',{id:'$question',kind:'question'});
    if (session.status === 'waiting_approval' && ![...entries.values()].some(item=>item.kind==='approval')) entries.set('$approval',{id:'$approval',kind:'approval'});
  }
  return [...entries.values()];
}

export function attentionLabel(session, view) {
  const entries = sessionAttention(session,view);
  if (entries.some(item=>item.kind==='question')) return '待回答';
  if (entries.some(item=>item.kind==='approval')) return '待审批';
  if (session.status === 'failed' && session.unread) return '执行失败';
  return '';
}

export function needsHandling(session,view) {
  return Boolean(attentionLabel(session,view) || session.unread && ['done','failed','interrupted'].includes(session.status));
}

export class TaskNotices {
  constructor(storage) {
    this.storage=storage;this.previous=new Map();this.seen=new Set();
    try { this.seen=new Set(JSON.parse(storage?.getItem('codex-relay-notice-seen') || '[]')); } catch {}
  }
  observe(sessions, {baseline=false}={}) {
    const notices=[];let changed=false;
    for (const session of sessions) {
      const previous=this.previous.get(session.id);
      const pending=sessionAttention(session);
      const turn=session.activeTurnId || session.completionToken || '';
      const candidates=pending.map(item=>({key:JSON.stringify([session.id,item.kind,item.id,item.turnId || turn]),kind:item.kind,itemId:item.id}));
      if (['done','failed','interrupted'].includes(session.status)) {
        // Starting a new send can briefly expose the previous finished turn.
        // Only a new completion receipt establishes a newly finished reply.
        let completion=session.completionToken && session.completionToken!==previous?.completionToken ? session.completionToken : null;
        if (!completion && previous && busy.has(previous.status) && session.status!=='done') {
          completion=previous.activeTurnId ? JSON.stringify(['turn',previous.activeTurnId]) : !session.completionToken ? 'error:'+session.updatedAt : null;
        }
        if (completion) candidates.push({key:JSON.stringify([session.id,session.status,completion]),kind:session.status});
      }
      for (const candidate of candidates) {
        if (this.seen.has(candidate.key)) continue;
        this.seen.add(candidate.key);
        changed=true;
        if (!baseline && previous) notices.push({...candidate,sessionId:session.id,title:session.title,projectName:session.projectName});
      }
      this.previous.set(session.id,{status:session.status,activeTurnId:session.activeTurnId,completionToken:session.completionToken || previous?.completionToken || null});
    }
    const ids=new Set(sessions.map(session=>session.id));
    for (const id of this.previous.keys()) if (!ids.has(id)) this.previous.delete(id);
    while (this.seen.size>1000) this.seen.delete(this.seen.values().next().value);
    if(changed)try { this.storage?.setItem('codex-relay-notice-seen',JSON.stringify([...this.seen])); } catch {}
    return notices;
  }
}
