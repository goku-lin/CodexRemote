// A partial or failed page must never be treated as the full list of live threads.
export async function readThreadList(readPage) {
  const threads = new Map(), cursors = new Set();
  let cursor;
  do {
    const page = await readPage(cursor);
    if (!Array.isArray(page?.data)) throw new Error('线程列表响应不完整。');
    for (const thread of page.data) if (thread?.id) threads.set(thread.id, thread);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('线程列表分页游标重复。');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...threads.values()];
}

export function applyThreadStatus(session, status, at = Date.now()) {
  if (!status?.type || session.pendingSend || session.pendingEdit || session.liveTurn?.at > at) return;
  if (status.type === 'active') {
    if (!['waiting_input', 'waiting_approval', 'interrupting'].includes(session.status)) session.status = 'running';
    return;
  }
  if (!['idle', 'notLoaded', 'systemError'].includes(status.type)) return;
  const latest = session.liveTurn || session.turns?.at(-1);
  if (latest && ['inProgress', 'running'].includes(latest.status)) {
    // Idle confirms that execution stopped, but does not establish a successful reply.
    session.liveTurn = { ...latest, status:'stopped', completedAt:at, at };
  }
  const ended = session.liveTurn || latest;
  session.status = status.type === 'systemError' ? 'failed'
    : ({completed:'done', failed:'failed', interrupted:'interrupted'})[ended?.status] || 'synced';
  session.activeTurnId = null;
}
