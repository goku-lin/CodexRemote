import {searchSessions} from './session-search.js';

export function unreadSessions(sessions,deviceId){return searchSessions(sessions,{filter:'unread',deviceId});}
export function nextUnreadSession(sessions,{deviceId,activeSessionId}={}){
  const unread=unreadSessions(sessions,deviceId);
  return unread.find(session=>session.id!==activeSessionId) || unread[0] || null;
}

export function pendingSessions(sessions,deviceId){return searchSessions(sessions,{filter:'waiting',deviceId});}
export function nextPendingSession(sessions,{deviceId,activeSessionId}={}){
  const pending=pendingSessions(sessions,deviceId);
  if(!pending.length)return null;
  const ordered=searchSessions(sessions,{deviceId}),ids=new Set(pending.map(session=>session.id));
  const current=ordered.findIndex(session=>session.id===activeSessionId);
  for(let step=1;step<=ordered.length;step++){
    const session=ordered[(current+step)%ordered.length];if(ids.has(session.id))return session;
  }
  return null;
}
