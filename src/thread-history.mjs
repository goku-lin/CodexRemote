import {normalizeNativeItem} from './rollout.mjs';
import {questionCallId} from '../public/questions.js';
import {itemTiming} from '../public/command-timing.js';

// Native pages provide command status/duration but no command start timestamp.
// Recover only the same visible item's recorded timing; never borrow turn time.
export function restoreCommandTiming(history,rollout){
  const known=new Map(),key=item=>item.turnId+':'+item.id;
  for(const item of rollout.items || [])if(item.kind==='commandExecution')known.set(key(item),item);
  for(const turn of rollout.turns || [])if(turn.activity?.kind==='commandExecution')known.set(key({...turn.activity,turnId:turn.id}),turn.activity);
  const items=history.items.map(item=>{
    if(item.kind!=='commandExecution')return item;const original=known.get(key(item));if(!original)return item;
    return {...item,...itemTiming({...item,startedAt:item.startedAt||original.startedAt,completedAt:item.completedAt||original.completedAt,durationMs:item.durationMs??original.durationMs},original)};
  });
  const turns=history.turns.map(turn=>{
    if(turn.status!=='inProgress')return turn;
    const activity=(rollout.turns || []).find(original=>original.id===turn.id)?.activity;
    const latest=items.filter(item=>item.turnId===turn.id&&item.role==='process').at(-1);
    if(activity?.kind!=='commandExecution'||latest?.id!==activity.id)return turn;
    return {...turn,activity:{...activity,...latest,at:latest.completedAt||latest.startedAt||activity.at},lastUpdateAt:latest.completedAt||latest.startedAt||turn.startedAt};
  });
  return {...history,items,turns};
}

// Paginated threads keep their visible history in the app-server database.
// A rollout can still contain the suffix that Desktop has already reverted.
export async function readPaginatedThread(rpc, threadId, maxTurns = 5) {
  const summaries = await pages(rpc, threadId, 'notLoaded', Infinity);
  const limit = maxTurns === 'all' ? Infinity : Math.max(1, Number(maxTurns) || 5);
  const selected = await pages(rpc, threadId, 'full', Math.min(limit, summaries.length));
  if (selected.some((turn, index) => turn.id !== summaries[index]?.id)) throw new Error('读取期间对话历史已变化，正在重新同步。');
  selected.reverse();
  const items = [], replies = [];
  const turns = selected.map(turn => {
    const at = (turn.startedAt || 0) * 1000;
    for (const [index, raw] of (turn.items || []).entries()) {
      const item = normalizeNativeItem(raw, {started_at_ms:at + index,syntheticTiming:true}, {timestamp:new Date(at).toISOString()});
      if (!item) continue;
      item.turnId = turn.id;
      if (item.role === 'questionAnswer') replies.push(item);
      else items.push(item);
    }
    return {id:turn.id, status:turn.status, startedAt:at, completedAt:(turn.completedAt || 0) * 1000,
      itemCount:(turn.items || []).filter(item => item.type !== 'reasoning').length,
      ...(turn.error ? {alert:{message:turn.error.message || String(turn.error),retrying:false}} : {})};
  });
  for (const response of replies) for (const reply of response.replies) {
    const id = questionCallId(reply.questionItemId);
    const question = items.find(item => item.id === id && item.questions?.some(q => q.id === reply.questionItemId));
    if (!question) continue;
    (question.questionAnswers ||= {})[reply.questionItemId] = reply.answer;
    question.answerState = response.answerState; question.answeredAt = response.at;
  }
  return {items, turns, turnCount:summaries.length,
    messageCount:selected.length === summaries.length ? turns.reduce((sum, turn) => sum + turn.itemCount, 0) : null,
    visibleTurnIds:summaries.map(turn => turn.id), authoritative:true};
}

async function pages(rpc, threadId, itemsView, limit) {
  const result = [], cursors = new Set(), ids = new Set();
  let cursor;
  while (result.length < limit) {
    const page = await rpc('thread/turns/list', {threadId, itemsView, sortDirection:'desc', limit:Math.min(100, limit - result.length), ...(cursor ? {cursor} : {})});
    if (!Array.isArray(page?.data) || page.data.some(turn => !turn?.id || ids.has(turn.id) || itemsView === 'full' && turn.itemsView !== 'full')) throw new Error('对话历史分页不完整，正在重新同步。');
    for (const turn of page.data) { ids.add(turn.id); result.push(turn); }
    cursor = page.nextCursor;
    if (!cursor) break;
    if (cursors.has(cursor)) throw new Error('对话历史分页游标重复。');
    cursors.add(cursor);
  }
  return result;
}
