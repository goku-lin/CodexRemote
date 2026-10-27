export class HistoryPoll {
  constructor({activeMs = 10_000, idleMs = 60_000, now = Date.now} = {}) {
    Object.assign(this, {activeMs, idleMs, now}); this.checkedAt = new Map();
  }
  checked(id) { this.checkedAt.set(id, this.now()); }
  due(id, active) {
    const last = this.checkedAt.get(id);
    return last == null || this.now() - last >= (active ? this.activeMs : this.idleMs);
  }
  forget(id) { this.checkedAt.delete(id); }
}

export function historyIsActive(reader, turnId, runtime) {
  if (runtime === 'active') return true;
  if (['idle','notLoaded','systemError'].includes(runtime)) return false;
  if (!reader) return true;
  const latest = reader.turns.get(reader.order.at(-1));
  if (['inProgress', 'running'].includes(latest?.status)) return true;
  if (!turnId) return false;
  const recorded = reader.turns.get(reader.aliases.get(turnId) || turnId);
  return !recorded || !['completed', 'failed', 'interrupted', 'stopped'].includes(recorded.status);
}
