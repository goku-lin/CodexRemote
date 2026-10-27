import {processingStatuses,completedStatuses} from './session-status.js';
import {needsHandling} from './session-attention.js';

const normalized=value=>String(value || '').normalize('NFKC').toLowerCase().trim();
export const sessionFilterLabels={all:'全部',running:'运行中',unread:'未读',waiting:'待处理'};

export function sessionSearchActive(query,filter='all') {
  return Boolean(normalized(query) || filter!=='all');
}

export function searchSessions(sessions,{query='',filter='all',deviceId}={}) {
  const words=normalized(query).split(/\s+/).filter(Boolean);
  return sessions.filter(session=>{
    if(session.hidden || session.archived || deviceId && session.deviceId!==deviceId)return false;
    if(filter==='running' && !processingStatuses.includes(session.status))return false;
    if(filter==='unread' && !(session.unread && completedStatuses.includes(session.status)))return false;
    if(filter==='waiting' && !needsHandling(session))return false;
    if(!words.length)return true;
    const text=normalized([session.title,session.projectName,session.projectCwd,session.cwd].filter(Boolean).join(' '));
    return words.every(word=>text.includes(word));
  }).sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned)) || (a.pinned&&b.pinned?(a.pinOrder??Infinity)-(b.pinOrder??Infinity):0) || (b.updatedAt || b.createdAt || 0)-(a.updatedAt || a.createdAt || 0));
}
