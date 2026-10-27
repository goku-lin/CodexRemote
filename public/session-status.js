import { effortLabels } from './composer-settings.js';
import {attentionLabel} from './session-attention.js';

export const processingStatuses = ['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting'];
export const completedStatuses = ['done', 'failed', 'interrupted'];

export function sessionIndicator(session = {}) {
  const labels = { starting:'启动中', running:'运行中', waiting_approval:'等待审批', waiting_input:'等待回答', interrupting:'正在中断', done:'已完成', failed:'失败', interrupted:'已中断', synced:'已同步', ready:'待开始' };
  const label = labels[session.status] || session.status || '待开始';
  const attention=attentionLabel(session);
  if(attention) return {kind:session.status==='failed' ? 'failed' : 'waiting',label:attention + (session.status==='running' ? ' · 仍在运行' : '')};
  if (processingStatuses.includes(session.status)) return { kind:'running', label };
  if (session.unread && completedStatuses.includes(session.status)) return { kind:'unread', label:label + ' · 未读' };
  return { kind:'idle', label };
}

export function codexSettingsLabel(session = {}, catalog = {}) {
  // Send choices and catalog defaults do not establish the desktop's settings.
  if (!session.nativeModel) return '模型和强度尚未确认';
  const name = catalog.models?.find(model => model.model === session.nativeModel)?.displayName
    || session.nativeModel.replace(/^gpt-/i, 'GPT-').replace(/-(sol|astra|luna|terra)$/i, (_, family) => ' ' + family[0].toUpperCase() + family.slice(1));
  const effort = session.nativeEffort ? effortLabels[session.nativeEffort] || session.nativeEffort : '强度尚未确认';
  return name.replace(/-(Sol|Astra|Luna|Terra)$/, ' $1') + ' · ' + effort;
}

export function canMarkSessionRead({ session, hidden, focused = true, covered, loading, atBottom, hasContent, requestedRead = false }) {
  return Boolean(session?.unread && session.completionToken && completedStatuses.includes(session.status)
    && !hidden && focused && !covered && !loading && (atBottom || requestedRead) && hasContent
    && (session.source !== 'imported' || session.loadedHistoryVersion === session.historyVersion));
}
