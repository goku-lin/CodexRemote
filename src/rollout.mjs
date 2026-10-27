import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { imageReferences, mediaReferences } from './media.mjs';
import {mediaKind} from '../public/media-types.js';
import { runtimeNotice } from '../public/runtime-status.js';
import { contextUsage } from '../public/usage.js';
import { normalizeQuestions, questionReplies, questionCallId, forwardedQuestionReplies } from '../public/questions.js';
import {itemTiming} from '../public/command-timing.js';

export function clipText(value, limit = 24_000) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n…（内容已截断）` : text;
}

export function messageText(content) {
  return (content || []).map(part => part.text || part.output_text || part.input_text || '').join('').trim();
}

function toolText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.filter(part => part?.type !== 'image').map(part => part?.text || part?.output_text || '').filter(Boolean).join('\n');
  if (value.content) return toolText(value.content);
  return JSON.stringify(value);
}

export function isContextOnlyUserMessage(text) {
  const value = String(text || '').trim();
  return value.startsWith('<') && !/(?:^|\n)##\s*My request\s*:/i.test(value);
}

export function normalizeNativeItem(raw, payload, entry) {
  const type = String(raw.type || '').replace(/^./, first => first.toLowerCase());
  if (type === 'reasoning') return null;
  const at = payload.started_at_ms || Date.parse(entry.timestamp) || 0;
  const base = { id: raw.id || `${type}-${at}`, at, completedAt: payload.completed_at_ms || at, status: raw.status || 'completed' };
  if (type === 'functionCallOutput' && raw.name === 'send_message_to_thread') {
    const input=String(raw.output || '').match(/<codex_delegation>\s*[\s\S]*?<input>([\s\S]*)<\/input>\s*<\/codex_delegation>/)?.[1];
    const replies=questionReplies(input);
    if (replies.length) return {...base,role:'questionAnswer',replies,answerState:'sent'};
    const forwarded=forwardedQuestionReplies(input);
    if (forwarded.length) return {...base,role:'questionAnswer',replies:forwarded,answerState:'forwarded',text:clipText(input,80_000)};
    if (input != null) return {...base,role:'user',text:clipText(input,80_000),images:imageReferences(input).map(ref=>({ref})),desktopInput:true};
  }
  if (type === 'userMessage' || type === 'agentMessage') {
    const text = clipText(raw.text || messageText(raw.content), 80_000);
    const replies=type === 'userMessage' ? questionReplies(text) : [];
    if (replies.length) return {...base,role:'questionAnswer',replies,answerState:'answered'};
    const images = imageReferences(raw.text || messageText(raw.content), raw.content);
    if ((!text && !images.length && !raw.questions?.length) || type === 'userMessage' && isContextOnlyUserMessage(text)) return null;
    return { ...base, role: type === 'userMessage' ? 'user' : 'assistant', text, images: images.map(ref => ({ ref })),attachments:mediaReferences(raw.text || messageText(raw.content),raw.content).filter(ref=>mediaKind(ref)!=='image').map(ref=>({ref})), phase: raw.phase || null,
      ...(raw.questions?.length ? {questions:normalizeQuestions(raw.questions,raw.id,raw.delivery),delivery:raw.delivery || 'desktop'} : {}) };
  }
  const processStatus=payload.type==='item_started'?'inProgress':base.status;
  Object.assign(base,itemTiming({status:processStatus,startedAt:raw.startedAt || (!payload.syntheticTiming?payload.started_at_ms:0),completedAt:raw.completedAt || (!payload.syntheticTiming?payload.completed_at_ms:0),durationMs:raw.durationMs ?? raw.duration_ms,timingSource:'recorded'},{},{at,phase:payload.syntheticTiming?'snapshot':payload.type==='item_started'?'started':'snapshot'}),{status:processStatus});
  if (type === 'commandExecution') {
    const argv = Array.isArray(raw.command) ? raw.command : [];
    const scriptFlag = argv.findIndex(value => ['-command', '-c', '-lc', '/c'].includes(String(value).toLowerCase()));
    const command = argv.length ? (scriptFlag >= 0 ? argv.slice(scriptFlag + 1).join(' ') : argv.join(' ')) : raw.command || '';
    return { ...base, role: 'process', kind: type, command: clipText(command, 24_000), cwd: raw.cwd, output: clipText(raw.aggregated_output || raw.aggregatedOutput || raw.stdout || raw.formatted_output || ''), exitCode: raw.exit_code ?? raw.exitCode };
  }
  if (type === 'fileChange') {
    const entries = Array.isArray(raw.changes) ? raw.changes : Object.entries(raw.changes || {}).map(([filePath, change]) => ({ path: filePath, ...change }));
    const changes = entries.map(change => {
      const diff = change.diff || change.unified_diff || '';
      const lines = diff.split('\n');
      return { path: change.path, kind: typeof change.kind === 'string' ? change.kind : change.kind?.type || change.type || 'update', diff: clipText(diff, 12_000), additions: lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length, deletions: lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length };
    });
    return { ...base, role: 'process', kind: type, changes };
  }
  if (type === 'mcpToolCall') return { ...base, role: 'process', kind: type, name: raw.tool || raw.name, server: raw.server, title: raw.arguments?.title || '', input: clipText(toolText(raw.arguments), 16_000), output: clipText(toolText(raw.result)), error: raw.error };
  if (type === 'extension') return { ...base, role: 'process', kind: raw.kind?.startsWith('web.') ? 'webSearch' : 'toolCall', name: raw.kind || '扩展', title: raw.query || raw.action?.url || '', input: clipText(toolText(raw.action)), output: clipText(toolText(raw.results)) };
  if (type === 'contextCompaction') return { ...base, role: 'process', kind: type };
  if (type === 'imageView') return { ...base, role:'process', kind:type, images:imageReferences('',[{type:'image',path:raw.path}]).map(ref=>({ref})) };
  return { ...base, role: 'process', kind: type, name: raw.name || raw.type, text: clipText(raw.text || raw.summary || ''), input: clipText(toolText(raw.arguments || ''), 8_000), output: clipText(toolText(raw.result || '')) };
}

// Read the semantic items Codex uses for its own UI. Response items are a
// fallback for older logs; they never replace the native items of a turn.
export class RolloutReader {
  constructor(maxTurns = 5) {
    this.maxTurns = maxTurns;
    this.files = new Map();
    this.turns = new Map();
    this.order = [];
    this.aliases = new Map();
    this.taskStarts = new Map();
    this.currentTurnId = null;
    this.lastUserTurnId = null;
    this.bytesRead = 0;
    this.settings = {};
    this.tokenUsage = null;
  }

  ensureTurn(id, user = false) {
    if (!id) id = this.currentTurnId || this.lastUserTurnId || 'unknown';
    const rawId = id;
    if (!user) {
      id = this.aliases.get(id) || id;
      // Automatic continuations have a task ID but no new user input.
      if (!this.turns.has(id) && this.lastUserTurnId) id = this.lastUserTurnId;
      this.aliases.set(rawId, id);
    } else {
      const previous = this.turns.get(this.lastUserTurnId);
      if (previous && previous.id !== id && previous.status === 'inProgress') previous.status = 'interrupted';
      this.aliases.set(id, id); this.lastUserTurnId = id;
    }
    if (!this.turns.has(id)) {
      this.turns.set(id, { id, native: new Map(), fallback: new Map(), nativeIds: new Set(), fallbackIds: new Set(), fallbackAssistantSignatures:new Map(), nativeAssistantSignatures:new Set(), startedAt: 0, completedAt: 0, status: 'inProgress' });
      this.order.push(id);
    }
    const turn = this.turns.get(id);
    turn.startedAt ||= this.taskStarts.get(rawId) || 0;
    if ((this.taskStarts.get(rawId) || 0) > turn.completedAt) turn.status = 'inProgress';
    return turn;
  }

  put(turn, source, item) {
    item.turnId = turn.id;
    if (item.role === 'questionAnswer') {
      let matched=false;
      for (const reply of item.replies) {
        const question=reply.questionItemId ? null : [...turn.native.values(),...turn.fallback.values()].findLast(item=>item.questions?.some(question=>question.title===reply.question));
        const callId=reply.questionItemId ? questionCallId(reply.questionItemId) : question?.id;
        if (!callId) continue;
        matched=true;
        const questionId=reply.questionItemId || question.questions.find(question=>question.title===reply.question).id;
        const response=turn.questionReplies?.get(callId) || {questionAnswers:{}};
        if (response.answerState==='answered' && item.answerState!=='answered') continue;
        response.questionAnswers[questionId]=reply.answer;
        response.answerState=item.answerState; response.answeredAt=item.at;
        (turn.questionReplies ||= new Map()).set(callId,response);
        for (const target of ['native','fallback']) {
          const question=turn[target].get(callId);
          if (question) Object.assign(question,response);
        }
      }
      if (item.answerState!=='forwarded' || matched) { turn.lastUpdateAt=Math.max(turn.lastUpdateAt || 0,item.at); return; }
      // A normal message with the same heading must not disappear if the
      // corresponding question is absent from this turn.
      item.role='user';item.desktopInput=true;
    }
    if (item.questions && turn.questionReplies?.has(item.id)) Object.assign(item,turn.questionReplies.get(item.id));
    turn[`${source}Ids`].add(item.id);
    if (item.role === 'assistant') {
      const signature=createHash('sha256').update(`${item.phase || ''}:${item.text || ''}`).digest('hex');
      if (source === 'fallback') turn.fallbackAssistantSignatures.set(item.id,signature);
      else turn.nativeAssistantSignatures.add(signature);
    }
    if (item.desktopInput) turn.desktopInput=true;
    const retained = this.retainedTurnIds ? this.retainedTurnIds.has(turn.id) : this.order.slice(-this.maxTurns).includes(turn.id);
    if (retained) turn[source].set(item.id, item);
    turn.lastUpdateAt = Math.max(turn.lastUpdateAt || 0, item.completedAt || item.at || 0);
    turn.startedAt ||= item.at;
    if (item.role === 'user') turn.startedAt = turn.startedAt ? Math.min(turn.startedAt,item.at) : item.at;
    // Late tool results can arrive after completion or cancellation. Only a new
    // task_started record establishes that execution resumed.
    // Keep counts for older turns, but release their command output buffers.
    for (const id of this.order.slice(0, Math.max(0, this.order.length - this.maxTurns))) {
      const older = this.turns.get(id);
      if(!this.retainedTurnIds?.has(id)){older.native.clear(); older.fallback.clear();}
    }
  }

  consume(entry) {
    const p = entry.payload || {};
    if(entry.type==='event_msg' && p.type==='thread_rolled_back') {
      const count=p.num_turns;
      if(!Number.isInteger(count) || count<1)return;
      const removed=new Set(this.order.splice(Math.max(0,this.order.length-count)));
      for(const id of removed){this.turns.delete(id);this.taskStarts.delete(id);}
      for(const [id,target] of this.aliases)if(removed.has(id) || removed.has(target))this.aliases.delete(id);
      this.currentTurnId=this.order.at(-1) || null;this.lastUserTurnId=this.currentTurnId;
      this.rollbackSeen=true;return;
    }
    if (entry.type === 'event_msg' && p.type === 'token_count') {
      const usage = contextUsage(p.info, Date.parse(entry.timestamp) || 0,{turnId:this.currentTurnId,model:this.settings.model});
      if (usage && usage.updatedAt >= (this.tokenUsage?.updatedAt || 0)) this.tokenUsage = usage;
      return;
    }
    if (entry.type === 'event_msg' && p.type === 'thread_settings_applied') {
      const settings=p.thread_settings || {};
      const changedModel = settings.model && settings.model !== this.settings.model;
      this.settings={...this.settings, model:settings.model || this.settings.model,
        effort:settings.reasoning_effort ?? settings.model_reasoning_effort ?? (changedModel ? null : this.settings.effort),
        ...(Date.parse(entry.timestamp) ? {at:Date.parse(entry.timestamp)} : {}),
        ...(Object.hasOwn(settings,'service_tier') ? {serviceTier:settings.service_tier || 'default'} : {})};
      return;
    }
    if (entry.type === 'turn_context') {
      const changedModel = p.model && p.model !== this.settings.model;
      this.settings = { ...this.settings, model:p.model || this.settings.model,
        effort:p.effort ?? p.reasoning_effort ?? p.model_reasoning_effort ?? (changedModel ? null : this.settings.effort),
        ...(Date.parse(entry.timestamp) ? {at:Date.parse(entry.timestamp)} : {}),
        permission:({readOnly:'read-only',workspaceWrite:'workspace-write',dangerFullAccess:'danger-full-access','read-only':'read-only','workspace-write':'workspace-write','danger-full-access':'danger-full-access'})[p.sandbox_policy?.type] || this.settings.permission };
      return;
    }
    if (entry.type === 'event_msg') {
      if (p.type === 'task_started') {
        const rawId = p.root_turn_id || p.turn_id;
        this.currentTurnId = rawId || this.currentTurnId;
        this.taskStarts.set(rawId, (p.started_at || 0) * 1000 || Date.parse(entry.timestamp) || 0);
        if (p.turn_id && p.turn_id !== rawId) this.aliases.set(p.turn_id, rawId);
        const turn = this.turns.get(this.aliases.get(rawId) || rawId);
        if (turn) { turn.status = 'inProgress'; turn.activity=null; turn.alert=null; }
      } else if (p.type === 'turn_aborted') {
        const turn = this.ensureTurn(p.turn_id);
        turn.completedAt = Date.parse(entry.timestamp) || 0;
        turn.status = 'interrupted';
        turn.activity = null; turn.alert = null;
      } else if (p.type === 'task_complete') {
        const turn = this.ensureTurn(p.turn_id);
        turn.completedAt = (p.completed_at || 0) * 1000 || Date.parse(entry.timestamp) || 0;
        turn.status = p.error ? 'failed' : 'completed';
        turn.activity=null; turn.alert=null;
        if (p.error) turn.alert = { message: typeof p.error === 'string' ? p.error : p.error.message || 'Codex 返回错误', retrying:false, at:turn.completedAt };
      } else if (p.type === 'item_started' && p.item) {
        const turn = this.ensureTurn(p.turn_id);
        const item = normalizeNativeItem(p.item, p, entry);
        if (item?.role === 'process') { turn.activity = { ...item, status:'inProgress' }; turn.alert=null; }
      } else if (p.type === 'item_completed' && p.item) {
        const item = normalizeNativeItem(p.item, p, entry);
        if (!item) return;
        const turn = this.ensureTurn(p.turn_id, item.role === 'user');
        if (item.role === 'user' && p.turn_id) this.aliases.set(p.turn_id, turn.id);
        this.put(turn, 'native', item);
        turn.alert=null;
        if (item.role === 'process') turn.activity = { ...item, status:'completed' };
        if (item.phase === 'final_answer' && !item.questions) { turn.activity = null; turn.alert = null; }
      } else if (p.type === 'error' || p.type === 'stream_error') {
        const turn = this.ensureTurn(p.turn_id);
        const at=Date.parse(entry.timestamp) || 0;
        const notice=runtimeNotice(p.type,p,at);
        turn.alert = { message: p.message || p.error?.message || p.error || 'Codex 返回错误', retrying:Boolean(notice), at };
        if (notice) { turn.activity=notice; (turn.notices ||= new Map()).set(`${p.type}-${at}`,{...notice,id:`${p.type}-${at}`,turnId:turn.id,role:'process'}); }
      } else if (/reconnect|stream_error|retry/i.test(p.type || '')) {
        const turn = this.ensureTurn(p.turn_id);
        const at = Date.parse(entry.timestamp) || 0;
        const notice=runtimeNotice('reconnect',p,at);
        turn.activity=notice;
        (turn.notices ||= new Map()).set(`${p.type}-${at}`,{...notice,id:`${p.type}-${at}`,turnId:turn.id,role:'process'});
      }
      return;
    }
    if (entry.type !== 'response_item') return;
    const rawId = p.internal_chat_message_metadata_passthrough?.turn_id || p.metadata?.turn_id || p.metadata?.turnId || p.turn_id || entry.turn_id;
    const at = Date.parse(entry.timestamp) || 0;
    if (p.type === 'message') {
      if (!['user', 'assistant'].includes(p.role)) return;
      const text = clipText(messageText(p.content), 80_000);
      const replies=p.role === 'user' ? questionReplies(text) : [];
      if (replies.length) { this.put(this.ensureTurn(rawId),'fallback',{role:'questionAnswer',replies,answerState:'answered',at}); return; }
      const images = imageReferences(messageText(p.content), p.content);
      if ((!text && !images.length) || p.role === 'user' && isContextOnlyUserMessage(text)) return;
      const turn = this.ensureTurn(rawId, p.role === 'user');
      this.put(turn, 'fallback', { id: p.id || `${p.role}-${at}`, role: p.role, text, images: images.map(ref => ({ ref })),attachments:mediaReferences(messageText(p.content),p.content).filter(ref=>mediaKind(ref)!=='image').map(ref=>({ref})), phase: p.phase || null, at });
      if (p.role === 'assistant') { turn.alert=null; if (turn.activity?.kind === 'reconnect' || p.phase === 'final_answer') turn.activity=null; }
    } else if (p.type === 'function_call_output' && p.name === 'send_message_to_thread') {
      const item=normalizeNativeItem({...p,type:'FunctionCallOutput'}, {}, entry);
      if (item?.desktopInput || item?.role === 'questionAnswer') this.put(this.ensureTurn(rawId,Boolean(item.desktopInput)),'fallback',item);
    } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      const turn = this.ensureTurn(rawId);
      if (/^request_user_input(?:_async)?$/.test(p.name)) {
        let args; try { args=JSON.parse(p.arguments); } catch { args={}; }
        this.put(turn,'fallback',{id:p.call_id,role:'assistant',phase:'question',delivery:p.name.endsWith('_async') ? 'async' : 'desktop',questions:normalizeQuestions(args.questions,p.call_id,p.name.endsWith('_async') ? 'async' : 'desktop'),at});
        return;
      }
      this.put(turn, 'fallback', { id: p.call_id || p.id || `call-${at}`, role: 'process', kind: 'toolCall', name: p.name || '工具', input: clipText(toolText(p.input || p.arguments), 16_000), at,startedAt:at,completedAt:0,status:'inProgress',timingSource:'recorded' });
      let argumentsValue; try { argumentsValue = JSON.parse(p.arguments || p.input); } catch { argumentsValue = {}; }
      const command = argumentsValue.cmd || argumentsValue.command;
      turn.activity = { id:p.call_id || p.id, kind:command ? 'commandExecution' : 'toolCall', name:p.name || '工具', title:argumentsValue.title || '', command, input:clipText(toolText(p.input || p.arguments), 5000), status:'inProgress', at,startedAt:at,timingSource:'recorded' };
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const turn = this.ensureTurn(rawId);
      const call = turn.fallback.get(p.call_id);
      if (call)Object.assign(call,{output:clipText(toolText(p.output)),status:'completed'},itemTiming({...call,status:'completed'},{},{at,phase:'completed'}));
      if (turn.activity?.id === p.call_id)Object.assign(turn.activity,itemTiming({...turn.activity,status:'completed'},{},{at,phase:'completed'}),{status:'completed'});
    }
  }

  async read(paths) {
    const metadata = await Promise.all(paths.map(async filePath => ({ path: filePath.startsWith('\\\\?\\') ? filePath.slice(4) : filePath, info: await stat(filePath) })));
    if (metadata.some(file => this.files.has(file.path) && this.files.get(file.path).offset > file.info.size)) {
      this.files.clear(); this.turns.clear(); this.order = []; this.aliases.clear(); this.taskStarts.clear(); this.currentTurnId = null; this.lastUserTurnId = null;
    }
    for (const file of metadata) {
      let cursor = this.files.get(file.path);
      if (!cursor) { cursor = { offset: 0, pending: Buffer.alloc(0) }; this.files.set(file.path, cursor); }
      if (file.info.size <= cursor.offset) continue;
      for await (const chunk of createReadStream(file.path, { start: cursor.offset, end: file.info.size - 1, highWaterMark: 256 * 1024 })) {
        this.bytesRead += chunk.length;
        const buffer = cursor.pending.length ? Buffer.concat([cursor.pending, chunk]) : chunk;
        let start = 0;
        for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, start)) {
          try { this.consume(JSON.parse(buffer.subarray(start, end).toString('utf8'))); } catch { /* skip a malformed complete record */ }
          start = end + 1;
        }
        cursor.pending = Buffer.from(buffer.subarray(start));
        cursor.offset += chunk.length;
      }
    }
    if(this.rollbackSeen && !this.rebuildingRollback) {
      // A rollback can expose turns whose large buffers were already released.
      // Rescan once, retaining only the final visible tail throughout the scan.
      this.retainedTurnIds=new Set(this.order.slice(-this.maxTurns));
      this.files.clear();this.turns.clear();this.order=[];this.aliases.clear();this.taskStarts.clear();this.currentTurnId=null;this.lastUserTurnId=null;
      this.settings={};this.tokenUsage=null;this.rebuildingRollback=true;this.rollbackSeen=false;
      try {return await this.read(paths);} finally {this.rebuildingRollback=false;this.rollbackSeen=false;this.retainedTurnIds=null;}
    }
    const retained = this.order.slice(-this.maxTurns);
    const summaries = this.order.map(id => {
      const turn = this.turns.get(id);
      const extraReplies=turn.desktopInput ? [...turn.fallbackAssistantSignatures.values()].filter(signature=>!turn.nativeAssistantSignatures.has(signature)).length : 0;
      return { id, startedAt: turn.startedAt, completedAt: turn.completedAt, status: turn.status, itemCount: turn.nativeIds.size ? turn.nativeIds.size + extraReplies : turn.fallbackIds.size,
        ...(retained.includes(id) ? { activity:turn.activity || null, alert:turn.alert || null, lastUpdateAt:turn.lastUpdateAt || turn.startedAt, notices:[...(turn.notices?.values() || [])] } : {}) };
    });
    const items = retained.flatMap(id => {
      const turn = this.turns.get(id);
      const items=[...(turn.nativeIds.size ? turn.native : turn.fallback).values()];
      if (turn.desktopInput) for (const item of turn.fallback.values()) if (item.role === 'assistant' && !items.some(native=>native.role === 'assistant' && native.text === item.text && native.phase === item.phase)) items.push(item);
      return items.sort((a, b) => a.at - b.at);
    });
    return { items, settings:this.settings, tokenUsage:this.tokenUsage, turns: summaries.filter(turn => retained.includes(turn.id)), turnCount: summaries.length, messageCount: summaries.reduce((sum, turn) => sum + turn.itemCount, 0) };
  }
}

// Preserve every row and identity even when outputs need to be shortened to
// fit the relay envelope. The row count must not depend on output verbosity.
export function compactHistoryItems(items, maxBytes = 1_600_000) {
  let inputLimit = 16_000, outputLimit = 24_000, textLimit = 80_000;
  const compact = () => items.map(item => ({ ...item,
    ...(item.text != null ? { text: clipText(item.text, textLimit) } : {}),
    ...(item.input != null ? { input: clipText(item.input, inputLimit) } : {}),
    ...(item.output != null ? { output: clipText(item.output, outputLimit) } : {}),
    ...(item.changes ? { changes: item.changes.map(change => ({ ...change, diff: clipText(change.diff, outputLimit) })) } : {})
  }));
  let result = compact();
  while (Buffer.byteLength(JSON.stringify(result)) > maxBytes && textLimit > 512) {
    inputLimit = Math.max(256, Math.floor(inputLimit / 2)); outputLimit = Math.max(256, Math.floor(outputLimit / 2));
    textLimit = Math.max(512, Math.floor(textLimit / 2)); result = compact();
  }
  return result;
}
