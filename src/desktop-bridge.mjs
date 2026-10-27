import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { readdir, access, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { decodeImage } from './media.mjs';
import { questionReplyText } from '../public/questions.js';
import { NativeDesktopClient } from './native-desktop-channel.mjs';

// Prefer ordinary user input through the Desktop's own app-server child. The
// legacy app-tools route is kept only for installations not yet switched over.
// Neither route acquires, deletes, or replaces a thread's writer lock.
export class DesktopBridge {
  constructor(env = process.env) { this.env = env; this.pending = new Map(); this.nextId = 1; this.native = new NativeDesktopClient(env); }
  get appToolsAvailable() { return Boolean(this.env.CODEX_APP_TOOLS_PIPE_PATH && this.env.CODEX_THREAD_ID); }
  get available() { return this.native.configured || this.appToolsAvailable; }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.open().catch(error => { this.close(); throw error; });
    return this.ready;
  }
  async open() {
    if (!this.env.CODEX_APP_TOOLS_PIPE_PATH || !this.env.CODEX_THREAD_ID) throw new Error('桌面插件连接不可用。请从 Codex 桌面任务启动 Relay。');
    let script = this.env.CODEX_DESKTOP_BRIDGE_SERVER;
    if (!script) {
      const folder = path.join(this.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
      const versions = (await readdir(folder, { withFileTypes:true })).filter(item => item.isDirectory()).map(item => item.name).sort((a,b) => b.localeCompare(a, undefined, { numeric:true }));
      for (const version of versions) { const candidate = path.join(folder, version, 'server.mjs'); try { await access(candidate); script = candidate; break; } catch {} }
    }
    if (!script) throw new Error('没有找到 Codex 桌面的 app-tools 插件。');
    const child = this.child = spawn(process.execPath, [script], { env:this.env, windowsHide:true, stdio:['pipe','pipe','ignore'] });
    readline.createInterface({ input:child.stdout }).on('line', line => {
      let message; try { message=JSON.parse(line); } catch { return; }
      const request=this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    });
    child.on('error', error => { if (this.child === child) this.disconnect(error); });
    child.stdin.on('error', error => { if (this.child === child) this.disconnect(error); });
    child.on('exit', () => { if (this.child === child) this.disconnect(new Error('桌面连接已关闭，请确认对话是否已收到后再发送。')); });
    await this.request('initialize', { protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'codex-relay-desktop',version:'0.1.0'} });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const catalog = await this.request('tools/list', {});
    if (!catalog.tools?.some(tool => tool.name === 'send_message_to_thread')) throw new Error('桌面接口不支持继续对话。');
  }
  request(method, params) {
    const id=this.nextId++;
    return new Promise((resolve,reject) => {
      const timer=setTimeout(() => { this.pending.delete(id); const error=new Error('桌面请求超时，请先确认对话是否已收到，避免重复发送。');error.ambiguous=method==='tools/call';reject(error); }, 20000);
      this.pending.set(id,{resolve,reject,timer});
      try { this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n'); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async tool(name, argumentsValue) {
    await this.connect();
    const result=await this.request('tools/call', { name, arguments:argumentsValue, _meta:{'openai/threadId':this.env.CODEX_THREAD_ID} });
    const text=(result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (result.isError) throw new Error(text || '桌面拒绝了这个请求。');
    let data; try { data=JSON.parse(text); } catch { data={text}; }
    return data;
  }
  async send(command, currentPermission, currentServiceTier = 'default') {
    if (this.native.configured) return this.native.send(command);
    if (command.permission && command.permission !== currentPermission) throw new Error('这条对话通过桌面继续，权限须沿用桌面的当前设置。请在桌面调整权限后重试。');
    if (command.serviceTier && command.serviceTier !== (currentServiceTier || 'default')) throw new Error('这条对话通过桌面继续，Fast 模式须沿用桌面的当前设置。请在桌面切换 Fast 后重试。');
    const imageParts=(command.input || []).filter(part => part.type === 'image');
    let prompt=command.text || (command.input || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    if (imageParts.length) {
      const folder=path.join(this.env.CODEX_RELAY_CWD || process.cwd(), '.relay-data', 'desktop-attachments');
      await mkdir(folder,{recursive:true});
      for (const part of imageParts) {
        const image=decodeImage(part.url);
        const filename=path.join(folder,randomUUID()+'.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'})[image.mime]);
        await writeFile(filename,image.bytes);
        prompt += `\n<image path="${filename.replaceAll('\\','/')}"></image>`;
      }
      prompt += '\n请读取以上附图后回答。';
    }
    return this.tool('send_message_to_thread', {threadId:command.threadId, hostId:'local', prompt,
      ...(command.model ? {model:command.model} : {}), ...(command.effort ? {thinking:command.effort} : {})});
  }
  async answer(command) {
    const text=questionReplyText(command.questions,command.answers);
    if (this.native.configured) return this.native.send({ ...command, text, input:[{type:'text',text}] });
    return this.tool('send_message_to_thread',{threadId:command.threadId,hostId:'local',prompt:text});
  }
  disconnect(error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.child=null; this.ready=null;
  }
  close() { const child=this.child; this.disconnect(new Error('桌面连接已关闭')); child?.kill(); this.native.close(); }
}
