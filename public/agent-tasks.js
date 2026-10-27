export const phaseLabels = { queued: '等待启动', starting: '正在启动', connecting: '等待模型回应', responding: '模型输出中', waiting_model: '等待模型回应', tools: '执行工具中', finishing: '正在收尾', completed: '已完成', failed: '失败', cancelled: '已停止', timed_out: '已超时', interrupted: '执行器已退出', unknown: '旧记录 · 状态未知' };
export const duration = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds >= 3600 ? `${Math.floor(seconds / 3600)}时${Math.floor(seconds / 60) % 60}分` : seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`; };
export function activityMessage(run) {
  if (run.stopRequested && run.active) return '已发出停止请求，等待执行器确认。';
  if (run.error) return run.error;
  if (run.heartbeatStale) return '执行器一段时间未更新，状态待核实。';
  if (run.waitingLong) return '较长时间没有模型新响应；尚不能据此判断任务卡死。';
  if (run.activeTools?.length) return run.activeTools.map(tool => `${tool.name} · ${tool.description}`).join('；');
  return ({ queued: '任务已登记，等待执行器接手。', connecting: 'CC 已启动，尚未收到模型输出。', responding: '正在接收模型响应。', waiting_model: '工具已返回，等待模型继续。', finishing: '已收到结果，等待执行器正常退出。', completed: 'CC 已正常结束；产物质量仍以验收为准。', cancelled: '任务已停止，已经写入的文件保留。', unknown: '这份旧日志没有运行心跳，不能确认当前执行状态。' })[run.state] || '正在启动本机 CC。';
}

export function setupAgentTasks() {
  const $ = id => document.getElementById(id);
  const state = { runs: [], models: [], selected: new URL(location.href).searchParams.get('run'), filter: 'all', loading: false, details: null, signature: '', action: false, pending: null, connectionError: false };
  const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const showError = message => { $('page-error').textContent = message || ''; $('page-error').hidden = !message; };
  const rememberSelection = id => { state.selected = id; state.signature = ''; const url = new URL(location.href); url.searchParams.set('run', id); history.replaceState(null, '', url); };
  async function api(url, options = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, headers: { 'content-type': 'application/json' } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(response.status === 401 ? '此浏览器尚未配对，请先返回 Codex 网页完成连接。' : response.status === 404 ? '当前后台尚未加载子代理面板接口；请使用更新后的 Relay 服务。' : body.error || `请求失败（${response.status}）`);
      return body;
    } finally { clearTimeout(timer); }
  }
  function renderList() {
    $('counts').textContent = `${state.runs.length} 项 · ${state.runs.filter(run => run.active).length} 项执行中`;
    const query = $('search').value.toLowerCase();
    const runs = state.runs.filter(run => (state.filter === 'all' || state.filter === 'active' && run.active || state.filter === 'ended' && !run.active) && `${run.title} ${run.model} ${run.sessionId || ''}`.toLowerCase().includes(query));
    const list = $('task-list'), old = new Map([...list.children].map(node => [node.dataset.id, node]));
    for (const [index, run] of runs.entries()) {
      let row = old.get(run.id);
      if (!row) { row = element('button', 'task-row'); row.type = 'button'; row.dataset.id = run.id; row.append(element('span', 'row-title'), element('span', 'row-meta'), element('span', 'row-meta')); row.onclick = () => select(run.id); }
      old.delete(run.id); row.setAttribute('aria-current', String(run.id === state.selected));
      row.children[0].textContent = run.title;
      const phase = element('span', run.active ? 'state-active' : 'state-' + run.state, phaseLabels[run.state] || run.state);
      row.children[1].replaceChildren(phase, element('span', '', duration(run.elapsedMs)));
      row.children[2].textContent = `${run.model} · ${new Date(run.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    }
    for (const node of old.values()) node.remove();
    if (!runs.length) list.append(element('small', 'empty-list', state.runs.length ? '没有符合条件的任务。' : '还没有任务记录。'));
  }
  function fileUrl(runId, file) { return `/api/agent-tasks/${runId}/files/${file.id}/${encodeURIComponent(file.name.split('/').at(-1))}`; }
  function renderDetail(details) {
    state.details = details;
    const run = details.status, sessionBusy = state.runs.some(other => other.sessionId === run.sessionId && other.active), canContinue = Boolean(run.sessionId && !sessionBusy && !run.active && run.state !== 'unknown');
    $('empty').hidden = true; $('task-content').hidden = false;
    $('model-name').textContent = run.model; $('task-title').textContent = run.title;
    $('phase').textContent = run.stopRequested && run.active ? '正在停止' : phaseLabels[run.state] || run.state; $('run-banner').dataset.state = run.state;
    $('run-message').textContent = activityMessage(run); $('elapsed').textContent = duration(run.elapsedMs);
    $('last-model').textContent = run.lastModelAt ? duration(Date.now() - run.lastModelAt) + '前' : run.legacy ? '旧记录未采集' : '尚未收到';
    $('worker').textContent = run.active ? run.ownerAlive ? run.heartbeatStale ? '连接待核实' : '在线' : run.state === 'queued' ? '等待启动' : '待确认' : '已结束';
    $('tool-count').textContent = run.toolCallCount;
    $('session-id').textContent = run.sessionId || '等待 CC 返回'; $('copy-session').disabled = !run.sessionId;
    $('run-id').textContent = run.id; $('cwd').textContent = run.cwd;
    $('source-thread').textContent = run.sourceThreadId ? `来源 Codex 对话 ${run.sourceThreadId}` : '来源对话未记录';
    $('run-settings').textContent = `${run.mode === 'implement' ? '可修改文件、运行命令' : '只读分析'} · ${run.effort || '默认'}${run.legacy ? ' · 历史记录' : ''}`;
    $('task-prompt').textContent = details.task || '旧记录未保存任务正文。';
    $('stop-task').hidden = !run.active; $('stop-task').disabled = state.action || run.stopRequested;
    $('follow-up').disabled = !canContinue || state.action; $('continue-submit').disabled = !canContinue || state.action;
    $('continue-hint').textContent = canContinue ? '沿用这个 CC 会话、工作目录与权限。' : run.active || sessionBusy ? '同一 CC 会话的任务结束或停止后，可以继续。' : '当前任务没有可安全续聊的会话。';
    const signature = JSON.stringify([run.id, run.sequence, run.state, details.events, details.files]);
    if (signature === state.signature) return;
    state.signature = signature;
    const list = $('timeline'), open = new Set([...list.querySelectorAll('details[open]')].map(node => node.dataset.key));
    const scrollTop = list.scrollTop, atBottom = list.scrollHeight - scrollTop - list.clientHeight < 60;
    const nodes = [];
    let messageCount = 0, commandCount = 0, lastAssistantText = '';
    const addMeta = (text, at) => { const node = element('div', 'conversation-meta'); node.append(element('span', '', text), element('small', '', at ? new Date(at).toLocaleTimeString('zh-CN') : '')); nodes.push(node); };
    const addBubble = (kind, label, text, at) => {
      if (!text?.trim()) return;
      const node = element('article', `chat-message ${kind}`), head = element('div', 'chat-heading');
      head.append(element('strong', '', label), element('small', '', at ? new Date(at).toLocaleTimeString('zh-CN') : '历史记录'));
      node.append(head, element('div', 'chat-text', text)); nodes.push(node); messageCount++;
    };
    if (details.task?.trim()) addBubble('user', '发给 CC 的任务', details.task.trim(), null);
    for (const [index, event] of details.events.entries()) {
      if (event.kind === 'task') continue;
      if (event.kind === 'connected') { addMeta('CC 已启动，开始处理任务', event.at); continue; }
      if (event.kind === 'assistant') { addBubble('assistant', 'DeepSeek · Claude Code', event.text, event.at); lastAssistantText = event.text || ''; continue; }
      if (event.kind === 'result') {
        if (event.text && event.text.trim() === lastAssistantText.trim()) continue;
        addBubble(event.isError ? 'error' : 'result', event.isError ? 'CC 返回错误' : '最终结果', event.text, event.at); lastAssistantText = event.text || ''; continue;
      }
      if (event.kind === 'tool_start' || event.kind === 'tool_result') {
        const node = element('article', `tool-entry ${event.isError ? 'is-error' : ''}`), head = element('div', 'chat-heading');
        head.append(element('strong', '', event.kind === 'tool_start' ? `执行工具 · ${event.name}` : `${event.name || '工具'} 返回${event.isError ? '（失败）' : ''}`), element('small', '', event.at ? new Date(event.at).toLocaleTimeString('zh-CN') : '历史记录'));
        const section = element('details'); section.dataset.key = String(event.sequence || event.id || index) + event.kind; section.open = open.has(section.dataset.key);
        section.append(element('summary', '', event.kind === 'tool_start' ? (event.description || '查看命令') : '查看工具返回'), element('pre', '', event.command || event.text || ''));
        node.append(head, section); nodes.push(node); if (event.kind === 'tool_start') commandCount++; continue;
      }
      if (event.kind === 'finished') addMeta(event.state === 'completed' ? '任务完成' : `任务结束：${phaseLabels[event.state] || event.state}`, event.at);
    }
    if (!nodes.length) nodes.push(element('small', '', '等待执行器返回任务事件…'));
    list.replaceChildren(...nodes); list.scrollTop = atBottom ? list.scrollHeight : scrollTop;
    $('conversation-summary').textContent = `${messageCount} 条消息 · ${commandCount} 条命令 · ${duration(run.elapsedMs)}`;
    $('event-note').textContent = details.events.length >= 200 ? '显示最近 200 条记录' : '不展示模型内部推理，只显示可读消息和工具结果';
    $('artifacts-section').hidden = !details.files.length;
    $('artifacts').replaceChildren(...details.files.map(file => {
      const row = element('div', 'artifact'), title = element('div', 'artifact-name', file.name), actions = element('nav');
      title.append(element('small', '', ` · ${Math.ceil(file.size / 1024)} KB · ${file.source === 'tool_record' ? '工具涉及的文件' : '目录内近期文件'}`));
      const view = element('a', '', '查看'), download = element('a', '', '下载');
      if (/\.html?$/i.test(file.name)) { view.textContent = '静态预览'; view.title = '静态预览不运行页面脚本；下载后可在本机打开完整页面。'; }
      view.href = fileUrl(run.id, file); view.target = '_blank'; view.rel = 'noopener';
      download.href = fileUrl(run.id, file) + '?download=1'; actions.append(view, download); row.append(title, actions); return row;
    }));
    const image = details.files.find(file => /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name));
    $('artifact-preview').hidden = !image;
    if (image) { const src = fileUrl(run.id, image) + '?v=' + Math.round(image.updatedAt || image.size); if ($('artifact-preview').getAttribute('src') !== src) $('artifact-preview').src = src; }
    else $('artifact-preview').removeAttribute('src');
  }
  async function load() {
    if (state.loading || document.hidden) return;
    state.loading = true;
    try {
      const data = await api('/api/agent-tasks'); state.runs = data.runs; state.models = data.models;
      if (state.connectionError) { showError(''); state.connectionError = false; }
      $('connection').textContent = '已连接 · 每 2 秒更新'; $('connection').className = 'ok';
      $('new-task').disabled = !state.models.length;
      if (!state.selected || !state.runs.some(run => run.id === state.selected)) state.selected = state.runs.find(run => run.active)?.id || state.runs[0]?.id || null;
      renderList();
      if (state.selected) {
        const selected = state.selected, details = await api('/api/agent-tasks/' + selected);
        if (selected === state.selected) renderDetail(details);
      }
    } catch (error) { $('connection').textContent = '状态连接不可用'; $('connection').className = 'error'; state.connectionError = true; showError(error.message); }
    finally { state.loading = false; }
  }
  async function select(id) { rememberSelection(id); $('follow-up').value = ''; showError(''); renderList(); try { const details = await api('/api/agent-tasks/' + id); if (state.selected === id) renderDetail(details); } catch (error) { showError(error.message); } }
  async function submit(url, body) {
    const key = JSON.stringify({ url, body });
    if (state.pending?.key !== key) state.pending = { key, id: crypto.randomUUID() };
    const id = state.pending.id;
    try { const result = await api(url, { method: 'POST', body: JSON.stringify({ ...body, requestId: id }) }); state.pending = null; return result.run; }
    catch (error) { const data = await api('/api/agent-tasks').catch(() => null); const existing = data?.runs.find(run => run.id === id); if (existing) { state.pending = null; return existing; } throw error; }
  }
  $('refresh').onclick = () => { showError(''); load(); };
  $('search').oninput = renderList;
  for (const button of document.querySelectorAll('[data-filter]')) button.onclick = () => { state.filter = button.dataset.filter; for (const item of document.querySelectorAll('[data-filter]')) item.setAttribute('aria-pressed', String(item === button)); renderList(); };
  $('copy-session').onclick = async () => { try { await navigator.clipboard.writeText(state.details.status.sessionId); $('copy-session').textContent = '已复制'; setTimeout(() => $('copy-session').textContent = '复制', 1500); } catch { showError('复制不可用，请直接选中上方会话 ID。'); } };
  $('stop-task').onclick = async () => {
    if (state.action || !state.details?.status.active) return;
    state.action = true; $('stop-task').disabled = true; showError('');
    try { await api(`/api/agent-tasks/${state.selected}/stop`, { method: 'POST', body: '{}' }); $('run-message').textContent = '已发出停止请求，等待执行器确认…'; }
    catch (error) { showError(error.message); }
    finally { state.action = false; }
  };
  $('continue-form').onsubmit = async event => {
    event.preventDefault(); if (state.action || !$('follow-up').value.trim()) return;
    state.action = true; $('continue-submit').disabled = true; showError('');
    try { const run = await submit(`/api/agent-tasks/${state.selected}/continue`, { task: $('follow-up').value }); $('follow-up').value = ''; rememberSelection(run.id); await load(); }
    catch (error) { showError(error.message); }
    finally { state.action = false; if (state.details) renderDetail(state.details); }
  };
  $('new-task').onclick = () => { $('new-model').replaceChildren(...state.models.map(model => { const option = element('option', '', model.label); option.value = model.alias; return option; })); $('new-error').textContent = ''; $('new-dialog').showModal(); };
  $('close-dialog').onclick = () => $('new-dialog').close();
  $('new-form').onsubmit = async event => {
    event.preventDefault(); if (state.action) return;
    state.action = true; $('new-submit').disabled = true; $('new-error').textContent = '';
    try { const run = await submit('/api/agent-tasks', { model: $('new-model').value, cwd: $('new-cwd').value, mode: $('new-mode').value, task: $('new-prompt').value }); $('new-dialog').close(); rememberSelection(run.id); await load(); }
    catch (error) { $('new-error').textContent = error.message; }
    finally { state.action = false; $('new-submit').disabled = false; }
  };
  const interval = setInterval(load, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  load();
  return { stop: () => clearInterval(interval) };
}
if (typeof document !== 'undefined') setupAgentTasks();
