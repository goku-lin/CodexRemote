const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const label=(value,fallback=null)=>typeof value==='string'&&/^[a-zA-Z0-9 _./()-]{1,100}$/.test(value)?value:fallback;
// Only this summary crosses the browser boundary, including for older peers.
export function quotaSummary(usage={},deviceId){
  return {deviceId,updatedAt:number(usage.updatedAt),refreshing:usage.refreshing===true,reset:usage.reset===true,
    error:usage.error?'额度读取失败，请检查本机登录与连接后重试。':null,
    buckets:(Array.isArray(usage.buckets)?usage.buckets:[]).slice(0,30).map(bucket=>({
      id:label(bucket.id,'codex'),name:label(bucket.name,'Codex'),planType:label(bucket.planType),
      windows:(Array.isArray(bucket.windows)?bucket.windows:[]).slice(0,10).map(window=>({minutes:number(window.minutes),remainingPercent:number(window.remainingPercent),resetsAt:number(window.resetsAt)})),
      credits:bucket.credits?{unlimited:bucket.credits.unlimited===true,balance:/^\d+(?:\.\d+)?$/.test(String(bucket.credits.balance))?String(bucket.credits.balance):null}:null
    }))};
}
