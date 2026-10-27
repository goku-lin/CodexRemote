import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { NativeDesktopClient } from '../src/native-desktop-channel.mjs';

const exec = promisify(execFile);
const compiler = process.platform === 'win32' ? path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe') : '';
const available = compiler && await access(compiler).then(() => true, () => false);
test('compiled CLI shim and Desktop stdio share one child with native Relay RPCs', { skip: !available, timeout: 12_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay native process '));
  const originalCli = path.join(directory, 'fixture core.exe');
  const sourceFile = path.join(directory, 'core.cs');
  const log = path.join(directory, 'received.jsonl');
  const endpointFile = path.join(directory, 'endpoint.json');
  const configFile = path.join(directory, 'configuration.json');
  const proxyFile = path.resolve('native-cli-proxy.mjs');
  const shimFile = path.join(directory, 'relay shim.exe');
  let desktop, client, lines;
  t.after(async () => {
    client?.close(); lines?.close();
    if (desktop && desktop.exitCode === null) {
      const exited = once(desktop, 'exit'); desktop.stdin.end();
      const timeout = setTimeout(() => desktop.kill(), 3000);
      await exited; clearTimeout(timeout);
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const source = [
    'using System; using System.IO; using System.Collections.Generic; using System.Web.Script.Serialization;',
    'public class CoreFixture { public static int Main(string[] args) {',
    'Console.InputEncoding = new System.Text.UTF8Encoding(false); Console.OutputEncoding = new System.Text.UTF8Encoding(false);',
    'var serializer = new JavaScriptSerializer();',
    'foreach (string arg in args) if (arg == "--version") { Console.WriteLine("codex-cli fixture"); return 0; }',
    'string line; while ((line = Console.ReadLine()) != null) {',
    'File.AppendAllText(Environment.GetEnvironmentVariable("RELAY_NATIVE_TEST_LOG"), line + "\\n");',
    'var message = serializer.Deserialize<Dictionary<string,object>>(line);',
    'if (!message.ContainsKey("id")) continue;',
    'object result = new Dictionary<string,object>();',
    'string method = (string)message["method"];',
    'if (method == "initialize") result = new { userAgent = "desktop-fixture" };',
    'if (method == "configRequirements/read") result = new { requirements = new { application = new { network = new { enabled = true, domains = new Dictionary<string,string> { { "allowed.fixture", "allow" }, { "blocked.fixture", "deny" } } } } } };',
    'if (method == "config/read") result = new { config = new { } };',
    'if (method == "thread/read") { var p = (Dictionary<string,object>)message["params"]; result = new { thread = new { id = (string)p["threadId"], status = new { type = "idle" } } }; }',
    'if (method == "turn/start") result = new { turn = new { id = "core-turn" } };',
    'Console.WriteLine(serializer.Serialize(new { id = message["id"], result = result }));',
    '} return 0; } }'
  ].join('\n');
  await writeFile(sourceFile, source);
  await exec(compiler, ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', '/out:' + originalCli, sourceFile], { windowsHide: true });
  await writeFile(configFile, JSON.stringify({ cliPath: originalCli, endpointFile }));
  const csharp = value => '@"' + value.replaceAll('"', '""') + '"';
  const shimSource = (await readFile('src/native-cli-shim.cs', 'utf8'))
    .replace('__NODE_PATH__', csharp(process.execPath))
    .replace('__PROXY_PATH__', csharp(proxyFile))
    .replace('__CONFIG_PATH__', csharp(configFile));
  const shimSourceFile = path.join(directory, 'shim.cs');
  await writeFile(shimSourceFile, shimSource);
  await exec(compiler, ['/nologo', '/target:exe', '/out:' + shimFile, shimSourceFile], { windowsHide: true });
  assert.equal((await exec(shimFile, ['--version'], { windowsHide: true })).stdout.trim(), 'codex-cli fixture');
  desktop = spawn(shimFile, ['app-server', '--analytics-default-enabled'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RELAY_NATIVE_TEST_LOG: log }
  });
  let stderr = ''; desktop.stderr.on('data', chunk => stderr += chunk);
  const desktopMessages = []; lines = readline.createInterface({ input: desktop.stdout });
  lines.on('line', line => desktopMessages.push(JSON.parse(line)));
  client = new NativeDesktopClient({ CODEX_RELAY_NATIVE_ENDPOINT: endpointFile });
  desktop.stdin.write(JSON.stringify({ id: 'network-initialize', method: 'initialize', params: { clientInfo: { name: 'native-desktop' },capabilities:{experimentalApi:true} } }) + '\n');
  for (let n = 0; n < 100 && !desktopMessages.some(x => x.id === 'network-initialize'); n++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(desktopMessages.some(x => x.id === 'network-initialize'), stderr);
  desktop.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  desktop.stdin.write(JSON.stringify({id:'network-requirements',method:'configRequirements/read',params:{}})+'\n');
  desktop.stdin.write(JSON.stringify({id:'network-config',method:'config/read',params:{includeLayers:false}})+'\n');
  for(let n=0;n<100&&!desktopMessages.some(x=>x.id==='network-config');n++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.deepEqual(desktopMessages.find(x=>x.id==='network-requirements')?.result,{requirements:{application:{network:{enabled:true,domains:{'allowed.fixture':'allow','blocked.fixture':'deny'}}}}});
  assert.deepEqual(desktopMessages.find(x=>x.id==='network-config')?.result,{config:{}});
  // The actual Desktop starts using the connection after initialize's response;
  // it does not send the separate notification assumed by our old fixture.
  const result = await client.send({ threadId: 'existing-desktop-thread', text: '保留当前工作，继续排查' });
  assert.equal(result.delivery, 'native'); assert.equal(result.turn.id, 'core-turn');
  const received = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(received.filter(x => x.method === 'initialize').length, 1);
  const request = received.find(x => x.method === 'turn/start');
  assert.equal(request.params.threadId, 'existing-desktop-thread');
  assert.deepEqual(request.params.input, [{ type: 'text', text: '保留当前工作，继续排查' }]);
  assert.ok(!received.some(x => ['tools/call', 'thread/start', 'thread/fork'].includes(x.method)));
  assert.ok(!desktopMessages.some(x => x.result?.turn));
});
