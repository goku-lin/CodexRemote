export const DEFAULT_PERFORMANCE_SETTINGS=Object.freeze({preloadEnabled:true,preloadCount:8,historyTurns:5,preloadScope:'all'});

export function performanceSettings(value={},strict=false) {
  if(!value || typeof value!=='object' || Array.isArray(value)) {
    if(strict)throw new Error('无效的性能设置。');
    value={};
  }
  const result={...DEFAULT_PERFORMANCE_SETTINGS};
  for(const [key,item] of Object.entries(value)) {
    const valid=key==='preloadEnabled' ? typeof item==='boolean'
      : ['preloadCount','historyTurns'].includes(key) ? Number.isInteger(item) && item>=1 && item<=20
      : key==='preloadScope' && ['all','project'].includes(item);
    if(!valid){if(strict)throw new Error('预加载对话数和回合数需要为 1–20 的整数，范围需要为所有项目或当前项目。');continue;}
    result[key]=item;
  }
  return result;
}
