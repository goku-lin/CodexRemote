export function pinnedSessions(preferences){return Array.isArray(preferences.pinnedSessions)?[...new Set(preferences.pinnedSessions.filter(id=>typeof id==='string'))]:[];}
export function sessionPin(preferences,id){const index=pinnedSessions(preferences).indexOf(id);return {pinned:index>=0,pinOrder:index>=0?index:null};}
export function setSessionPinned(preferences,id,value){
  if(typeof value!=='boolean')throw new Error('请选择置顶或取消置顶。');
  const ids=pinnedSessions(preferences),previous=ids.includes(id);
  if(value&&!previous&&ids.length>=200)throw new Error('置顶对话已达到上限，请先取消部分置顶。');
  preferences.pinnedSessions=value?previous?ids:[...ids,id]:ids.filter(item=>item!==id);
  return sessionPin(preferences,id);
}
