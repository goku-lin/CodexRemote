import { renderChatgptMarkdown } from './chatgpt-markdown.js';

const modeKey = 'codex-relay-product-mode';
const validModes = new Set(['codex', 'chatgpt']);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char]));

export function setupChatGptMode({ api, storage = globalThis.localStorage } = {}) {
  const get = id => document.getElementById(id);
  const state = { mode: 'codex', threads: [], activeId: null, loading: false, listExpanded: false };
  try {
    const saved = storage?.getItem(modeKey);
    if (validModes.has(saved)) state.mode = saved;
  } catch { /* use Codex as the safe default */ }

  function saveMode() { try { storage?.setItem(modeKey, state.mode); } catch { /* optional preference */ } }

  function renderModeControls() {
    get('productModeLabel').textContent = state.mode === 'chatgpt' ? 'ChatGPT' : 'Codex';
    get('productSwitcherMenu').querySelectorAll('[data-product-mode]').forEach(button => {
      button.setAttribute('aria-checked', String(button.dataset.productMode === state.mode));
    });
  }

  function renderThreads() {
    const list = get('chatgptThreadList');
    const visibleThreads = state.listExpanded ? state.threads : state.threads.slice(0, 3);
    const rows = visibleThreads.map(thread => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'chatgpt-thread' + (thread.id === state.activeId ? ' active' : '');
      button.dataset.chatgptThread = thread.id;
      button.innerHTML = `<strong>${escapeHtml(thread.title)}</strong><small>${thread.unread ? '未读 · ' : ''}${thread.status === 'active' ? '进行中' : '最近对话'}</small>`;
      return button;
    });
    if (state.threads.length > visibleThreads.length) {
      const more = document.createElement('button');
      more.type = 'button'; more.className = 'chatgpt-thread-more link-btn'; more.dataset.chatgptMore = 'true';
      more.textContent = `显示更多（共 ${state.threads.length} 条）`;
      rows.push(more);
    }
    list.replaceChildren(...rows);
    if (!state.threads.length && !state.loading) list.innerHTML = '<div class="muted">暂时没有可见的 ChatGPT 对话。</div>';
  }

  function renderConversation(data) {
    const title = data.thread?.title || '选择一个 ChatGPT 对话';
    get('chatgptConversationTitle').textContent = title;
    get('chatgptConversationStatus').textContent = data.thread?.status === 'active' ? '进行中' : 'ChatGPT 对话';
    const messages = get('chatgptMessages');
    const rows = [];
    for (const turn of data.turns || []) for (const item of turn.items || []) {
      const row = document.createElement('div'); row.className = 'chatgpt-message';
      row.innerHTML = `<span class="avatar ${item.role === 'user' ? 'you' : 'codex'}">${item.role === 'user' ? '你' : 'G'}</span><div class="chatgpt-message-body"><strong>${item.role === 'user' ? '你' : 'ChatGPT'}</strong><div class="bubble markdown">${renderChatgptMarkdown(item.text)}</div></div>`;
      rows.push(row);
    }
    messages.replaceChildren(...(rows.length ? rows : [Object.assign(document.createElement('div'), { className:'chatgpt-empty', textContent:'这个对话暂时没有可显示的消息。' })]));
    messages.scrollTop = messages.scrollHeight;
  }

  async function openThread(id) {
    state.activeId = id; state.listExpanded = true; renderThreads(); get('chatgptError').textContent = '';
    try { renderConversation(await api(`/api/chatgpt/threads/${encodeURIComponent(id)}?turnLimit=3`)); }
    catch (error) { get('chatgptError').textContent = error.message; }
  }

  async function refreshThreads() {
    state.loading = true; get('chatgptAvailability').textContent = '正在从 Codex 读取 ChatGPT 对话…'; renderThreads();
    try {
      const result = await api('/api/chatgpt/threads');
      state.threads = result.threads || [];
      get('chatgptAvailability').textContent = state.threads.length > 3 ? `最近 3 条对话，可展开全部 ${state.threads.length} 条` : state.threads.length ? `最近 ${state.threads.length} 条对话` : '没有可见的 ChatGPT 对话';
      if (!state.threads.some(thread => thread.id === state.activeId)) state.activeId = null;
      renderThreads();
    } catch (error) {
      state.threads = []; state.activeId = null; renderThreads();
      const missingRoute = error.status === 404 || /not found/i.test(error.message);
      get('chatgptAvailability').textContent = missingRoute ? 'Relay 后台还没有加载 ChatGPT 接口，请重启后台。' : 'ChatGPT 入口暂不可用';
      get('chatgptError').textContent = missingRoute ? '重启 Relay 后再从左上角切换到 ChatGPT。' : error.message;
    } finally { state.loading = false; }
  }

  async function send(event) {
    event.preventDefault();
    if (!state.activeId) { get('chatgptError').textContent = '请先选择一个 ChatGPT 对话。'; return; }
    const input = get('chatgptPromptInput'), prompt = input.value.trim();
    if (!prompt) return;
    const button = get('chatgptSendBtn'); button.disabled = true; get('chatgptError').textContent = '正在发送…';
    try { await api(`/api/chatgpt/threads/${encodeURIComponent(state.activeId)}`, { method:'POST', body:JSON.stringify({prompt}) }); input.value = ''; await openThread(state.activeId); get('chatgptError').textContent = ''; }
    catch (error) { get('chatgptError').textContent = error.message; }
    finally { button.disabled = false; }
  }

  function setMode(mode) {
    if (!validModes.has(mode)) return;
    state.mode = mode; saveMode(); renderModeControls(); get('productSwitcherMenu').classList.add('hidden'); get('productSwitcherBtn').setAttribute('aria-expanded', 'false');
    document.querySelector('.main').classList.toggle('chatgpt-active', mode === 'chatgpt');
    document.querySelector('.app').classList.toggle('chatgpt-mode', mode === 'chatgpt');
    get('chatgptView').classList.toggle('hidden', mode !== 'chatgpt');
    if (mode === 'chatgpt' && !state.threads.length) refreshThreads();
  }

  get('productSwitcherBtn').onclick = () => {
    const menu = get('productSwitcherMenu'), open = menu.classList.toggle('hidden');
    get('productSwitcherBtn').setAttribute('aria-expanded', String(!open));
  };
  get('productSwitcherMenu').addEventListener('click', event => { const button = event.target.closest('[data-product-mode]'); if (button) setMode(button.dataset.productMode); });
  get('refreshChatgptBtn').onclick = refreshThreads;
  get('chatgptThreadList').addEventListener('click', event => {
    const more = event.target.closest('[data-chatgpt-more]');
    if (more) { state.listExpanded = true; renderThreads(); return; }
    const button = event.target.closest('[data-chatgpt-thread]'); if (button) openThread(button.dataset.chatgptThread);
  });
  get('chatgptComposer').addEventListener('submit', send);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && state.mode === 'chatgpt') setMode('codex'); });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.product-switcher')) { get('productSwitcherMenu').classList.add('hidden'); get('productSwitcherBtn').setAttribute('aria-expanded', 'false'); } });
  renderModeControls(); setMode(state.mode);
  return { get mode() { return state.mode; }, setMode, refreshThreads };
}
