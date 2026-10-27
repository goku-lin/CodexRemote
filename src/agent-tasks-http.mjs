// The caller must apply its existing browser authentication and origin checks.
export async function agentTasksHttp(req, res, pathname, { tasks, parseBody, sendJson, sendError }) {
  if (!pathname.startsWith('/api/agent-tasks')) return false;
  try {
    const url = new URL(req.url, 'http://localhost');
    if (pathname === '/api/agent-tasks' && req.method === 'GET') {
      sendJson(res, 200, { runs: tasks.runs.list(), models: await tasks.models() }); return true;
    }
    if (pathname === '/api/agent-tasks' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.requestId) throw new Error('请提供请求编号，以免网络重试重复执行。');
      sendJson(res, 202, await tasks.start({ ...body, sourceThreadId: null })); return true;
    }
    const match = pathname.match(/^\/api\/agent-tasks\/([a-f0-9-]{36})(?:\/(stop|continue|files)(?:\/([a-f0-9]{24})\/(.+))?)?$/i);
    if (!match) { sendError(res, 404, '子代理接口不存在。'); return true; }
    const [, id, action, fileId, resource] = match;
    if (!action && req.method === 'GET') {
      const details = tasks.runs.details(id);
      if (!details) sendError(res, 404, '子代理任务不存在。'); else sendJson(res, 200, details);
    } else if (action === 'stop' && req.method === 'POST') {
      sendJson(res, 200, { run: tasks.runs.stop(id) });
    } else if (action === 'continue' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.requestId) throw new Error('请提供请求编号，以免重复续聊。');
      sendJson(res, 202, await tasks.continue(id, body));
    } else if (action === 'files' && req.method === 'GET' && fileId && resource) {
      const file = await tasks.artifact(id, fileId, decodeURIComponent(resource));
      res.writeHead(200, { ...file.headers, 'content-type': file.mime, 'content-length': file.body.length, 'cache-control': 'no-store', ...(url.searchParams.get('download') === '1' ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` } : {}) });
      res.end(file.body);
    } else sendError(res, 405, '此操作不支持该请求方式。');
  } catch (error) { sendError(res, error.status || 400, error.message); }
  return true;
}
