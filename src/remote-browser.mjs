import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const allowedOrigins = new Set(['https://chatgpt.com', 'https://chat.openai.com']);
const keyNames = new Set(['Enter','Escape','Tab','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Space']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function edgePath() {
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = roots.flatMap(root => [
    path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge_proxy.exe')
  ]);
  return candidates.find(candidate => requireExists(candidate));
}

function requireExists(file) {
  return existsSync(file);
}

function safeChatGptUrl(value) {
  const url = new URL(value || 'https://chatgpt.com/');
  if (!allowedOrigins.has(url.origin)) throw new Error('远程浏览器只允许打开 ChatGPT 官方网页。');
  return url.toString();
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export class RemoteBrowser {
  constructor({ dataDir, debugPort = Number(process.env.CODEX_RELAY_BROWSER_DEBUG_PORT || 9333), executable = edgePath() } = {}) {
    this.dataDir = dataDir;
    this.debugPort = debugPort;
    this.executable = executable;
    this.profileDir = path.join(dataDir, 'remote-browser-profile');
    this.process = null;
    this.socket = null;
    this.target = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async targets() {
    const response = await fetch(`http://127.0.0.1:${this.debugPort}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('远程浏览器调试接口没有响应。');
    return response.json();
  }

  async start(url = 'https://chatgpt.com/') {
    const targetUrl = safeChatGptUrl(url);
    let targets;
    if (this.process && !this.process.killed) {
      try { targets = await this.targets(); } catch {}
    }
    if (!targets) {
      if (!this.executable) throw new Error('没有找到 Microsoft Edge。请先在家里电脑安装 Edge。');
      await fs.mkdir(this.profileDir, { recursive: true });
      this.process = spawn(this.executable, [
        `--remote-debugging-port=${this.debugPort}`,
        `--user-data-dir=${this.profileDir}`,
        '--no-first-run', '--no-default-browser-check', targetUrl
      ], { detached: true, windowsHide: false, stdio: 'ignore' });
      this.process.unref();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try { targets = await this.targets(); break; } catch { await sleep(250); }
      }
    }
    if (!targets?.length) throw new Error('远程浏览器没有打开可控制的页面。');
    this.target = targets.find(item => item.type === 'page' && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(item.url || '')) || targets.find(item => item.type === 'page');
    if (!this.target?.webSocketDebuggerUrl) throw new Error('没有找到远程浏览器页面。');
    await this.connect(this.target.webSocketDebuggerUrl);
    if (this.target.url !== targetUrl) await this.command('Page.navigate', { url: targetUrl });
    return this.state();
  }

  async connect(endpoint) {
    if (this.socket?.readyState === 1) return;
    const socket = this.socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const fail = error => { socket.close(); reject(error instanceof Error ? error : new Error('远程浏览器连接失败。')); };
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', fail, { once: true });
    });
    socket.addEventListener('message', event => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || '远程浏览器命令失败。'));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('远程浏览器连接已关闭。')); }
      this.pending.clear(); this.socket = null;
    });
    await this.command('Page.enable');
    await this.command('Runtime.enable');
  }

  command(method, params = {}) {
    if (!this.socket || this.socket.readyState !== 1) return Promise.reject(new Error('远程浏览器尚未启动。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('远程浏览器响应超时。')); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async state() {
    if (!this.socket || !this.target) return { running: false, url: null, title: null, viewport: null };
    const result = await this.command('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,title:document.title,width:innerWidth,height:innerHeight})', returnByValue: true });
    let page = {}; try { page = JSON.parse(result?.result?.value || '{}'); } catch {}
    return { running: true, url: page.url || this.target.url || null, title: page.title || this.target.title || null, viewport: { width: page.width || 0, height: page.height || 0 } };
  }

  async screenshot(quality = 55) {
    if (!this.socket) throw new Error('请先启动远程浏览器。');
    const level = number(quality, 55, 25, 85);
    const result = await this.command('Page.captureScreenshot', { format: 'webp', quality: level, fromSurface: true });
    return Buffer.from(result.data, 'base64');
  }

  async input(body = {}) {
    if (!this.socket) throw new Error('请先启动远程浏览器。');
    const type = String(body.type || '');
    if (type === 'click') {
      const x = number(body.x, 0, 0, 10000), y = number(body.y, 0, 0, 10000);
      await this.command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await this.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } else if (type === 'scroll') {
      await this.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: number(body.x, 10, 0, 10000), y: number(body.y, 10, 0, 10000), deltaX: number(body.deltaX, 0, -3000, 3000), deltaY: number(body.deltaY, 0, -3000, 3000) });
    } else if (type === 'type') {
      const text = String(body.text || ''); if (text.length > 20_000) throw new Error('输入内容过长。');
      await this.command('Input.insertText', { text });
    } else if (type === 'key') {
      const key = String(body.key || ''); if (!keyNames.has(key)) throw new Error('不支持这个键盘操作。');
      const text = key === 'Space' ? ' ' : key === 'Enter' ? '\r' : undefined;
      await this.command('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key === 'Space' ? 'Space' : key, text });
      await this.command('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key === 'Space' ? 'Space' : key });
    } else throw new Error('不支持的远程浏览器操作。');
    return { ok: true };
  }

  async close() {
    this.socket?.close(); this.socket = null; this.target = null;
    if (this.process && !this.process.killed) this.process.kill();
    this.process = null;
  }
}

export { safeChatGptUrl };
