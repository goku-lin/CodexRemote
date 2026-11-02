import os from 'node:os';
import path from 'node:path';
import {readFile} from 'node:fs/promises';

const normalized=value=>String(value || '').replaceAll('\\','/').replace(/\/+$/,'').toLowerCase();

// Desktop keeps project membership separately from the historical thread cwd.
// Read only project fields; never rewrite Desktop state or an execution cwd.
export function attachDesktopProjects(threads,state) {
  const projects=new Map(Object.values(state?.['local-projects'] || {}).filter(p=>p?.id && typeof p.name==='string' && p.rootPaths?.some(root=>typeof root==='string' && root)).map(p=>[p.id,p]));
  const assignments=state?.['thread-project-assignments'] || {};
  const hosts=state?.['thread-project-membership-host-ids'] || {};
  const projectless=new Set(state?.['projectless-thread-ids'] || []);
  return threads.map(thread=>{
    if(!thread?.id || projectless.has(thread.id) || hosts[thread.id] && hosts[thread.id]!=='local')return thread;
    const assignment=assignments[thread.id];
    let project=assignment?.projectKind==='local' ? projects.get(assignment.projectId) : null;
    // An explicit assignment (including a deleted project) takes precedence.
    if(!assignment){
      const cwd=normalized(thread.cwd);
      const candidates=[...projects.values()].filter(p=>p.rootPaths.some(root=>normalized(root)===cwd));
      if(candidates.length===1)project=candidates[0];
    }
    return project ? {...thread,relayProject:{id:project.id,name:project.name,cwd:project.rootPaths.find(root=>typeof root==='string' && root)}} : thread;
  });
}

export async function readDesktopProjects(threads,home=process.env.CODEX_HOME || path.join(os.homedir(),'.codex')) {
  try{return attachDesktopProjects(threads,JSON.parse((await readFile(path.join(home,'.codex-global-state.json'),'utf8')).replace(/^\ufeff/,'')));}
  catch(error){if(['ENOENT','EACCES','EPERM'].includes(error.code) || error instanceof SyntaxError)return threads;throw error;}
}
