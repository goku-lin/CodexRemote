const timestamp=value=>Number.isFinite(value)&&value>0?value:0;
const duration=value=>Number.isFinite(value)&&value>=0?value:null;
export function itemTiming(item,previous={}, {at=0,phase='snapshot'}={}){
  const running=['inProgress','running'].includes(item.status);
  const startedAt=timestamp(item.startedAt)||timestamp(previous.startedAt)
    ||(phase==='started'&&item.timingSource!=='unknown'?timestamp(item.at)||timestamp(at):0);
  const completedAt=running?0:timestamp(item.completedAt)||(phase==='completed'?timestamp(at):0);
  const durationMs=running?null:duration(item.durationMs)??(startedAt&&completedAt>=startedAt?completedAt-startedAt:duration(previous.durationMs));
  return {startedAt,completedAt,durationMs,timingSource:startedAt?(item.timingSource&&item.timingSource!=='unknown'?item.timingSource:previous.timingSource||'event'):durationMs!=null?'duration':'unknown'};
}
export function commandElapsed(milliseconds){
  const seconds=Math.max(0,Math.floor(milliseconds/1000));
  if(seconds<60)return `${seconds} 秒`;
  if(seconds<3600)return `${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
  return `${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分 ${seconds%60} 秒`;
}
export function commandTiming(activity,now=Date.now()){
  const running=['inProgress','running'].includes(activity.status),start=timestamp(activity.startedAt);
  const elapsed=running?(start?Math.max(0,now-start):null):duration(activity.durationMs)??(start&&timestamp(activity.completedAt)>=start?activity.completedAt-start:null);
  const longRunning=running&&elapsed!=null&&elapsed>=10*60*1000;
  return {running,startedAt:start,longRunning,label:elapsed==null?(running?'起始时间未知':'耗时未知'):`${running?'已运行':'用时'} ${commandElapsed(elapsed)}${longRunning?' · 运行较久':''}`};
}
