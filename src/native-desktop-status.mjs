import { NativeDesktopClient } from './native-desktop-channel.mjs';

// Read-only readiness check. Never initialize or submit a model request.
const client = new NativeDesktopClient(process.env, 3000);
try {
  if (!client.configured) throw new Error('桌面原生入口尚未启动。');
  await client.connect();
  if (process.argv.includes('--require-controls') && (!client.capabilities.events || !client.capabilities.serverRequests)) throw new Error('桌面仍使用旧代理。请在当前任务结束后，关闭 Codex 并通过原生入口重新打开一次。');
  console.log('桌面原生连接已接通。');
} catch (error) {
  if (!process.argv.includes('--quiet')) console.error(error.message);
  process.exitCode = 1;
} finally {
  client.close();
}
