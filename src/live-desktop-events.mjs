import {desktopRuntimeIsActive} from './desktop-runtime.mjs';
import {itemTiming} from '../public/command-timing.js';

// Rollout snapshots may lag the Desktop stream. Keep current item state until
// history contains the same completed item, rather than replaying text deltas.
export function pruneDesktopHistory(session, visibleTurnIds, observedAt = Infinity) {
  const visible=new Set(visibleTurnIds);
  for (const map of [session.liveItems,session.liveNotices]) for (const [key,event] of map || []) {
    const turnId=event.message.params.turnId || event.message.params.turn?.id;
    if (turnId && !visible.has(turnId) && event.at <= observedAt) map.delete(key);
  }
  if(session.liveTurn && !visible.has(session.liveTurn.id) && session.liveTurn.at <= observedAt)session.liveTurn=null;
  for(const [id,question] of session.questionItems || []) if(!visible.has(question.turnId) && question.at <= observedAt) {
    session.questionItems.delete(id);session.questionResponses?.delete(id);
  }
}

export function rememberDesktopEvent(session, event) {
  const message = event.message, params = message.params || {};
  session.liveItems ||= new Map();
  session.liveNotices ||= new Map();
  const itemId = params.item?.id || params.itemId;
  if(itemId && session.liveResyncIds?.has(itemId)){
    if(message.method==='item/completed')session.liveResyncIds.delete(itemId);
    else if(message.method.includes('delta') || message.method.includes('Delta'))return;
  }
  if (['item/started', 'item/completed'].includes(message.method) && itemId) {
    const previous = session.liveItems.get(itemId);
    const item={...previous?.message.params.item,...params.item,status:message.method==='item/started'?'inProgress':'completed'};
    if(!['agentMessage','userMessage','reasoning'].includes(item.type))Object.assign(item,itemTiming(item,previous?.message.params.item,{at:event.at,phase:message.method==='item/started'?'started':'completed'}));
    session.liveItems.set(itemId, { ...event, message: { method: message.method, params: { ...params, item } } });
  } else if (itemId && ['item/agentMessage/delta', 'item/plan/delta', 'item/commandExecution/outputDelta'].includes(message.method)) {
    const type = message.method === 'item/plan/delta' ? 'plan' : message.method === 'item/commandExecution/outputDelta' ? 'commandExecution' : 'agentMessage';
    const previous = session.liveItems.get(itemId);
    const item = { id: itemId, type, status: 'inProgress', ...previous?.message.params.item };
    if(type==='commandExecution'&&!item.startedAt)item.timingSource='unknown';
    const field = type === 'commandExecution' ? 'aggregatedOutput' : 'text';
    const limit = field === 'aggregatedOutput' ? 24000 : 80000;
    const value = (item[field] || '') + (params.delta || '');
    item[field] = value.length > limit ? value.slice(0,limit) + '\n…（内容已截断）' : value;
    session.liveItems.set(itemId, { ...event, message: { method: 'item/started', params: { threadId: params.threadId, turnId: params.turnId, item } } });
  } else if (['turn/started', 'turn/completed', 'turn/plan/updated', 'turn/diff/updated', 'error'].includes(message.method)) {
    session.liveNotices.set(`${message.method}:${params.turnId || params.turn?.id || ''}`, event);
  }
  for (const map of [session.liveItems, session.liveNotices]) while (map.size > 2000) map.delete(map.keys().next().value);
}

export function mergeDesktopHistory(session, incoming, turns) {
  const runtime=session.desktopRuntime;
  if(desktopRuntimeIsActive(runtime,turns) && runtime.turnId) {
    const current=turns.find(turn=>turn.id===runtime.turnId);
    if(current){current.status='inProgress';current.completedAt=0;}
    if(session.liveTurn?.id===runtime.turnId && !['inProgress','running'].includes(session.liveTurn.status) && session.liveTurn.at<=runtime.observedAt)session.liveTurn=null;
  }
  for(const id of session.liveResyncIds || []){
    const event=incoming.find(value=>value.message?.params?.item?.id===id);
    if(event?.message.params.item.status==='completed' || turns.some(turn=>turn.id===event?.message.params.turnId && !['inProgress','running'].includes(turn.status)))session.liveResyncIds.delete(id);
  }
  const liveTurn = session.liveTurn;
  for (const [id, event] of session.liveItems || []) {
    const item = event.message.params.item;
    const index = incoming.findIndex(entry => entry.message?.params?.item?.id === id);
    const stored = incoming[index]?.message.params.item;
    const turn = turns.find(turn => turn.id === event.message.params.turnId);
    const commandFinished=item.type==='commandExecution' && stored?.type==='commandExecution'
      && ['inProgress','running'].includes(item.status) && ['completed','failed','declined','interrupted'].includes(stored.status)
      && incoming[index].message.params.turnId===event.message.params.turnId;
    // A completion notification can be lost while the turn continues. Once
    // persisted history has the terminal command, its old live start/output
    // must not overwrite that status and keep the command's clock running.
    if(commandFinished){
      session.liveItems.delete(id);
      if(turn?.activity?.id===id)turn.activity={...turn.activity,...stored};
      continue;
    }
    const fields = ['text', 'aggregatedOutput', 'changes', 'images'];
    const caughtUp = stored && item.status === 'completed' && fields.every(field => item[field] == null || JSON.stringify(item[field]) === JSON.stringify(stored[field]));
    if (caughtUp || (turn && !['inProgress', 'running'].includes(turn.status) && item.status !== 'completed')) { session.liveItems.delete(id); continue; }
    if (index >= 0) incoming[index] = event;
    else incoming.push(event);
  }
  if (liveTurn) {
    const index = turns.findIndex(turn => turn.id === liveTurn.id);
    if (index < 0) {
      if (!turns.length || liveTurn.startedAt >= (turns.at(-1).startedAt || 0)) turns.push({ ...liveTurn });
      else session.liveTurn = null;
    }
    else if (['inProgress', 'running'].includes(turns[index].status)
      || !['inProgress', 'running', 'stopped'].includes(liveTurn.status) && liveTurn.at > (turns[index].completedAt || 0)) Object.assign(turns[index], liveTurn);
    else session.liveTurn = null;
  }
  for (const [key, event] of session.liveNotices || []) {
    const turnId = event.message.params.turnId || event.message.params.turn?.id;
    if (!turnId || turns.some(turn => turn.id === turnId)) incoming.push(event);
    else session.liveNotices.delete(key);
  }
  for (const event of session.events || []) {
    if (!['approval_request', 'approval_resolved', 'action_error'].includes(event.type)) continue;
    if (turns.some(turn => turn.id === (event.request?.params?.turnId || event.turnId))) incoming.push(event);
  }
}
