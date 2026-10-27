const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function contextUsage(value, at = 0,scope={}) {
  if (!value || typeof value !== 'object') return null;
  const last = value.last || value.last_token_usage;
  const total = value.total || value.total_token_usage;
  const usedTokens = number(last?.totalTokens ?? last?.total_tokens);
  if (usedTokens == null) return null;
  const windowTokens = number(value.modelContextWindow ?? value.model_context_window);
  return { usedTokens, windowTokens:windowTokens > 0 ? windowTokens : null,
    usedPercent:windowTokens > 0 ? Math.min(100, Math.max(0, usedTokens / windowTokens * 100)) : null,
    totalTokens:number(total?.totalTokens ?? total?.total_tokens),
    outputTokens:number(last?.outputTokens ?? last?.output_tokens),
    totalOutputTokens:number(total?.outputTokens ?? total?.output_tokens),
    turnId:scope.turnId || null,model:scope.model || null,updatedAt:at };
}

export function compactTokens(value) {
  if(!Number.isFinite(value))return '—';
  if(value>=100000000)return (value/100000000).toFixed(2).replace(/\.00$/,'')+'亿';
  if(value>=10000)return (value/10000).toFixed(1).replace(/\.0$/,'')+'万';
  return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0}).format(value);
}

export class TokenRateTracker {
  constructor(){this.entries=new Map();}
  observe(session) {
    const usage=session?.tokenUsage;if(!usage?.turnId || !usage.model || usage.totalOutputTokens==null || !usage.updatedAt)return null;
    const key=JSON.stringify([session.id,usage.turnId,usage.model]),previous=this.entries.get(key);
    if(previous && usage.updatedAt<=previous.at)return previous.rate;
    const elapsed=previous ? (usage.updatedAt-previous.at)/1000 : 0;
    const output=previous ? usage.totalOutputTokens-previous.output : 0;
    const rate=elapsed>=.5 && output>0 ? output/elapsed : previous?.rate ?? null;
    this.entries.delete(key);this.entries.set(key,{at:usage.updatedAt,output:usage.totalOutputTokens,rate:output<0 ? null : rate});
    while(this.entries.size>32)this.entries.delete(this.entries.keys().next().value);
    return output<0 ? null : rate;
  }
}

export function accountLimits(data = {}) {
  const entries = data.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length
    ? Object.entries(data.rateLimitsByLimitId) : data.rateLimits ? [[data.rateLimits.limitId || 'codex', data.rateLimits]] : [];
  return entries.map(([id, bucket]) => ({ id, name:bucket.limitName || id, planType:bucket.planType || null,
    windows:[bucket.primary,bucket.secondary].filter(Boolean).map(window => {
      const used = number(window.usedPercent);
      return { minutes:number(window.windowDurationMins), remainingPercent:used == null ? null : Math.min(100, Math.max(0, 100-used)), resetsAt:number(window.resetsAt) };
    }), credits:bucket.credits ? { unlimited:bucket.credits.unlimited === true,
      balance:bucket.credits.balance == null ? null : String(bucket.credits.balance) } : null }));
}

export function projectCounts(sessions) {
  const active = new Set(['starting','running','waiting_approval','waiting_input','interrupting']);
  return { completed:sessions.filter(session=>session.status === 'done').length,
    running:sessions.filter(session=>active.has(session.status)).length,
    unread:sessions.filter(session=>!active.has(session.status) && session.unread).length };
}

export function quotaWindowName(minutes) {
  if (minutes === 300) return '5 小时额度';
  if (minutes === 10080) return '周额度';
  if (minutes == null) return '额度窗口';
  return minutes % 1440 === 0 ? `${minutes/1440} 天额度` : minutes % 60 === 0 ? `${minutes/60} 小时额度` : `${minutes} 分钟额度`;
}
