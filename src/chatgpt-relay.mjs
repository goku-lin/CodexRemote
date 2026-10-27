import { DesktopBridge } from './desktop-bridge.mjs';

const CHATGPT_KIND = 'chatgpt';

function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part.text === 'string') return part.text;
    return '';
  }).filter(Boolean).join('');
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'agentMessage') return { role: 'assistant', text: String(item.text || '') };
  if (item.type === 'userMessage') return { role: 'user', text: textFromContent(item.content) };
  return null;
}

function normalizeThread(thread) {
  return {
    id: String(thread.id),
    kind: CHATGPT_KIND,
    title: String(thread.title || '未命名 ChatGPT 对话'),
    status: thread.status || 'idle',
    updatedAt: thread.updatedAt || null,
    projectId: thread.projectId || null,
    unread: Boolean(thread.isUnread)
  };
}

function normalizeRead(result) {
  const thread = result?.thread && normalizeThread(result.thread);
  const turns = (result?.turns || []).map(turn => ({
    id: String(turn.id || ''),
    status: turn.status || 'completed',
    items: (turn.items || []).map(normalizeItem).filter(item => item && item.text)
  })).filter(turn => turn.items.length);
  if (result?.page?.order === 'newest_first') turns.reverse();
  return { thread, turns, nextCursor: result?.page?.nextCursor || null, hasMore: Boolean(result?.page?.hasMore) };
}

export class ChatGptRelay {
  constructor({ bridge = new DesktopBridge(), limit = 50 } = {}) {
    this.bridge = bridge;
    this.limit = limit;
    this.threads = new Map();
    this.sendLocks = new Set();
  }

  get available() { return this.bridge?.appToolsAvailable ?? Boolean(this.bridge?.available); }

  async listThreads() {
    if (!this.available) throw new Error('当前 Relay 没有接通 Codex 的 app-tools，暂时无法读取 ChatGPT 对话。');
    const result = await this.bridge.tool('list_threads', { limit: this.limit });
    const threads = (result?.threads || []).filter(thread => thread?.kind === CHATGPT_KIND).map(normalizeThread);
    this.threads = new Map(threads.map(thread => [thread.id, thread]));
    return { available: true, threads };
  }

  async readThread(threadId, options = {}) {
    const id = String(threadId || '');
    if (!id || !this.threads.has(id)) throw new Error('ChatGPT 对话不存在或尚未同步，请先刷新对话列表。');
    const result = await this.bridge.tool('read_thread', {
      threadId: id,
      ...(options.cursor ? { cursor: String(options.cursor) } : {}),
      turnLimit: Math.min(10, Math.max(1, Number(options.turnLimit) || 3)),
      maxOutputCharsPerItem: Math.min(20_000, Math.max(0, Number(options.maxOutputCharsPerItem) || 12_000))
    });
    return normalizeRead(result);
  }

  async send(threadId, prompt) {
    const id = String(threadId || ''), text = String(prompt || '').trim();
    if (!id || !this.threads.has(id)) throw new Error('ChatGPT 对话不存在或尚未同步，请先刷新对话列表。');
    if (!text) throw new Error('请输入要发送的内容。');
    if (text.length > 100_000) throw new Error('消息过长，请控制在 100000 个字符以内。');
    if (this.sendLocks.has(id)) throw new Error('这条 ChatGPT 对话正在发送，请等待当前回复完成。');
    this.sendLocks.add(id);
    try {
      const result = await this.bridge.tool('send_message_to_thread', { threadId: id, prompt: text });
      return { ok: true, result };
    } finally {
      this.sendLocks.delete(id);
    }
  }

  close() { this.bridge?.close(); }
}

export { normalizeItem, normalizeRead, normalizeThread };
