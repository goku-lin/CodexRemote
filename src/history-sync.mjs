import {createHash} from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');

function eventIdentity(event) {
  const params = event.message?.params || {};
  return JSON.stringify([event.type, event.turnId || params.turnId || params.turn?.id || null,
    event.id || params.item?.id || params.itemId || event.request?.key || null,
    event.message?.method || null, event.id || params.item?.id ? null : event.at || null]);
}

// Keep only small manifests, never duplicate the full history for each cursor.
export class HistorySync {
  constructor({maxEntries = 64, maxBytes = 8 * 1024 * 1024} = {}) {
    this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.snapshots = new Map(); this.bytes = 0;
  }
  response(value, window, baseCursor) {
    const counts = new Map(), keys = [], hashes = [], sizes = [];
    for (const event of value.events) {
      const identity = eventIdentity(event), occurrence = counts.get(identity) || 0;
      counts.set(identity, occurrence + 1);
      const key = hash(identity + ':' + occurrence).slice(0, 32), json = JSON.stringify(event);
      keys.push(key); hashes.push(hash(json)); sizes.push(Buffer.byteLength(json));
    }
    const {events, ...metadata} = value;
    const cursor = hash(JSON.stringify([value.sessionId, window, keys, hashes, metadata]));
    const previous = this.snapshots.get(baseCursor);
    const full = {...value, historySync:{kind:'full', cursor, keys}};
    let result = full;
    if (previous?.sessionId === value.sessionId && previous.window === window) {
      const before = new Map(previous.keys.map((key, index) => [key, previous.hashes[index]]));
      const changed = keys.flatMap((key, index) => before.get(key) === hashes[index] ? [] : [index]);
      const reordered = keys.length !== previous.keys.length || keys.some((key, index) => key !== previous.keys[index]);
      const deltaBytes = changed.reduce((sum, index) => sum + sizes[index] + 36, 0) + (reordered ? keys.length * 36 : 0);
      const fullBytes = sizes.reduce((sum, size) => sum + size + 36, 0);
      if (deltaBytes < fullBytes || !changed.length && !reordered) {
        result = {...metadata, events:changed.map(index => events[index]),
          historySync:{kind:'delta', baseCursor, cursor, keys:changed.map(index => keys[index]), ...(reordered ? {order:keys} : {})}};
      }
    }
    const manifest = {sessionId:value.sessionId, window, keys, hashes};
    const bytes = Buffer.byteLength(JSON.stringify(manifest));
    const old = this.snapshots.get(cursor);
    if (old) { this.bytes -= old.bytes; this.snapshots.delete(cursor); }
    if (bytes <= this.maxBytes) {
      this.snapshots.set(cursor, {...manifest, bytes}); this.bytes += bytes;
      while (this.snapshots.size > this.maxEntries || this.bytes > this.maxBytes) {
        const oldest = this.snapshots.keys().next().value;
        this.bytes -= this.snapshots.get(oldest).bytes; this.snapshots.delete(oldest);
      }
    }
    return result;
  }
  stats() { return {entries:this.snapshots.size, bytes:this.bytes}; }
}
