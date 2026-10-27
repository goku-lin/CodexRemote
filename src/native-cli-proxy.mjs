import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NativeDesktopHost, readFrames } from './native-desktop-channel.mjs';

// Launched by the configured CLI shim. Other CLI subcommands pass through.
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const args = process.argv.slice(3);
const desktop = args.includes('app-server') && args.includes('--analytics-default-enabled') &&
  !args.some(value => ['daemon', 'proxy', 'generate-ts', 'generate-json-schema'].includes(value));
const env = { ...process.env, CODEX_CLI_PATH: config.cliPath };
if (!desktop) {
  const child = spawn(config.cliPath, args, { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const core = spawn(config.cliPath, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const host = new NativeDesktopHost({
    endpointFile: config.endpointFile,
    writeCore: message => core.stdin.write(JSON.stringify(message) + '\n'),
    writeDesktop: message => process.stdout.write(JSON.stringify(message) + '\n')
  });
  let stopping = false;
  const stop = async code => {
    if (stopping) return; stopping = true;
    clearInterval(parentWatch); process.stdin.destroy(); core.stdin.end();
    await host.close();
    const timer = setTimeout(() => core.kill(), 1500); timer.unref();
    process.exitCode = code;
  };
  const fail = error => { console.error('Relay native proxy: ' + error.message); void stop(1); };
  const parent = process.ppid;
  const parentWatch = setInterval(() => {
    try { process.kill(parent, 0); } catch { void stop(0); }
  }, 1000);
  core.stdin.on('error', fail); core.stdout.on('error', fail); core.on('error', fail);
  process.stdin.on('error', fail); process.stdout.on('error', fail);
  process.stdin.on('end', () => void stop(0));
  process.on('SIGINT', () => void stop(0)); process.on('SIGTERM', () => void stop(0));
  core.on('exit', code => { void stop(code ?? 1); });
  try {
    await new Promise((resolve, reject) => { core.once('spawn', resolve); core.once('error', reject); });
    if (!stopping) {
      await host.listen();
      // Preparing a launcher alone does not switch delivery. Once this Desktop
      // has really used native input, a disconnect must never restore forwarding.
      await writeFile(path.join(path.dirname(config.endpointFile), 'native-desktop-required.json'), '{"version":1}', { mode: 0o600 });
      if (stopping) await host.close();
      else {
        readFrames(process.stdin, message => host.fromDesktop(message), fail);
        readFrames(core.stdout, message => host.fromCore(message), fail);
      }
    }
  } catch (error) { fail(error); }
}
