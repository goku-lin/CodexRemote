import os from 'node:os';
import path from 'node:path';
import {readFile} from 'node:fs/promises';

const readJson=async file=>JSON.parse((await readFile(file,'utf8')).replace(/^\ufeff/,''));
const effort=entry=>({reasoningEffort:entry.effort,description:entry.description});

// The desktop keeps a newer account-scoped model catalog than a long-lived
// app-server child sometimes exposes through model/list. Merge only models
// explicitly listed and supported by the desktop cache; the app-server remains
// authoritative whenever it already returned the same model.
export function cachedModels(cache){
  if(!Array.isArray(cache?.models))return [];
  return cache.models.filter(item=>typeof item?.slug==='string' && item.visibility==='list' && item.supported_in_api!==false).map(item=>({
    id:item.slug,model:item.slug,displayName:item.display_name || item.slug,description:item.description || '',
    supportedReasoningEfforts:Array.isArray(item.supported_reasoning_levels) ? item.supported_reasoning_levels.filter(level=>typeof level?.effort==='string').map(effort) : [],
    defaultReasoningEffort:item.default_reasoning_level,
    additionalSpeedTiers:item.additional_speed_tiers,
    serviceTiers:item.service_tiers,
    availabilityNux:item.availability_nux,upgrade:item.upgrade,hidden:false
  }));
}

export function mergeModelCatalog(models,cache){
  const merged=Array.isArray(models) ? [...models] : [],seen=new Set(merged.map(item=>item.model || item.id));
  for(const item of cachedModels(cache))if(!seen.has(item.model)){merged.push(item);seen.add(item.model);}
  return merged;
}

export async function readDesktopModelCache(home=process.env.CODEX_HOME || path.join(os.homedir(),'.codex')){
  try{return await readJson(path.join(home,'models_cache.json'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
