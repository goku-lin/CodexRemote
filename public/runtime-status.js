// Runtime notifications only: never infer a state from user text or commands.
export function reconnectStatus(payload = {}, at = 0) {
  const error = payload.error;
  const message = String(payload.message || error?.message || (typeof error === 'string' ? error : '') || '').slice(0, 2000);
  const count = message.match(/(?:reconnect\w*|retry\w*|重新连接|重试)[^\n\d]*(\d+)\s*\/\s*(\d+)/i);
  const attempt = Number(payload.attempt ?? payload.retryAttempt ?? payload.retry_attempt ?? payload.retries ?? count?.[1]) || null;
  const maxAttempts = Number(payload.maxAttempts ?? payload.max_attempts ?? payload.maxRetries ?? payload.max_retries ?? count?.[2]) || null;
  const waiting = /waiting (?:for|on) (?:the )?network|等待网络/i.test(message);
  return { kind:'reconnect', status:'inProgress', at, attempt, maxAttempts, waiting,
    text:`正在重新连接${attempt ? ` ${attempt}${maxAttempts ? '/' + maxAttempts : ''}` : ''}${waiting ? ' · 等待网络' : ''}`,
    detail:message || '连接中断，Codex 正在重试。' };
}

export function runtimeNotice(method, params = {}, at = 0) {
  if (['error','runner/error','stream_error','codex/event/stream_error'].includes(method)) {
    if (params.willRetry || params.will_retry || /stream_error/.test(method)) return reconnectStatus(params, at);
    return null;
  }
  if (/^(?:runner\/)?(?:reconnect|retry|network_wait)/i.test(method)) return reconnectStatus(params, at);
  const item = params.item;
  if (item && /context_?compaction/i.test(item.type || item.kind || '')) return { kind:'contextCompaction', id:item.id, at,
    status:/completed/.test(method) ? 'completed' : 'inProgress', text:/completed/.test(method) ? '上下文已自动压缩，继续处理…' : '正在压缩上下文…' };
  if (['thread/compacted','context_compacted'].includes(method)) return {kind:'contextCompaction',status:'completed',at,text:'上下文已自动压缩，继续处理…'};
  return null;
}

export function composerModelLabel(settings) {
  const name = (settings.model?.displayName || settings.model?.model || '').replace(/-(Sol|Astra|Luna|Terra)$/, ' $1');
  const labels = {none:'无',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'极高',max:'Max',ultra:'Ultra'};
  return name ? `${name}${settings.effort ? ' ' + (labels[settings.effort] || settings.effort) : ''}` : '选择模型';
}
