export function applyHistoryUpdate(previous, result) {
  const sync = result.historySync, events = result.events || [];
  if (!sync) return {events, keys:null, cursor:null};
  if (!Array.isArray(sync.keys) || sync.keys.length !== events.length || sync.keys.some(key=>typeof key !== 'string')
    || new Set(sync.keys).size !== sync.keys.length || typeof sync.cursor !== 'string') throw new Error('历史增量响应不完整');
  if (sync.kind === 'full') {
    if (new Set(sync.keys).size !== sync.keys.length) throw new Error('历史记录编号重复');
    return {events, keys:sync.keys, cursor:sync.cursor};
  }
  if (sync.kind !== 'delta' || sync.baseCursor !== previous.cursor || !Array.isArray(previous.keys)
    || previous.keys.length !== previous.events?.length) throw new Error('历史增量基准已过期');
  const records = new Map(previous.keys.map((key, index) => [key, previous.events[index]]));
  sync.keys.forEach((key, index) => records.set(key, events[index]));
  const keys = sync.order || previous.keys;
  if (!Array.isArray(keys) || new Set(keys).size !== keys.length || keys.some(key => !records.has(key))) throw new Error('历史增量缺少记录');
  return {events:keys.map(key => records.get(key)), keys, cursor:sync.cursor};
}
