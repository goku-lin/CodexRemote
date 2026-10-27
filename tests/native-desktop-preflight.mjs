// Optional, real-CLI preflight. Reads an existing conversation; never sends a
// turn, resumes a writer, changes a Goal, or touches the live Desktop endpoint.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { once } from 'node:events';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { NativeDesktopClient } from '../src/native-desktop-channel.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const threadId = process.argv[2];
assert.ok(threadId, 'Provide the existing thread ID for a read-only check.');
const exec = promisify(execFile);
const liveFiles = ['native-desktop.json', 'native-desktop-required.json'];
const snapshot = async () => Promise.all(liveFiles.map(name => readFile(path.join(root, '.relay-data', name)).catch(() => null)));
const before = await snapshot();
const { cliPath } = JSON.parse(await readFile(path.join(root, '.relay-data', 'native-desktop-launch.json'), 'utf8'));
const directory = await mkdtemp(path.join(os.tmpdir(), 'relay native preflight '));
let desktop, client, lines;
try {
  const schemaDir = path.join(directory, 'schema');
  await exec(cliPath, ['app-server', 'generate-json-schema', '--experimental', '--out', schemaDir], { windowsHide: true, timeout: 15000 });
  const schemaFiles = await readdir(schemaDir, { recursive: true });
  const turnSchemaFile = schemaFiles.find(name => name.endsWith('TurnStartParams.json'));
  assert.ok(turnSchemaFile, 'The installed CLI did not provide TurnStartParams schema.');
  const turnSchema = JSON.parse(await readFile(path.join(schemaDir, turnSchemaFile), 'utf8'));
  const definitions = turnSchema.definitions || turnSchema.$defs || {};
  const inputSchema = definitions.UserInput;
  assert.ok(inputSchema, 'The installed CLI did not provide UserInput schema.');
  const variants = inputSchema.oneOf || inputSchema.anyOf;
  const textSchema = variants?.find(value => value.properties?.type?.const === 'text' || value.properties?.type?.enum?.includes('text'));
  assert.ok(textSchema, 'The installed CLI did not provide text input schema.');
  // Capture the request our sender builds without dispatching it to any CLI.
  const schemaClient = new NativeDesktopClient({ CODEX_RELAY_NATIVE_ENDPOINT: path.join(directory, 'unused.json') });
  let generatedTurn;
  schemaClient.request = async (method, params) => {
    if (method === 'thread/read') return { thread: { id: threadId, status: { type: 'idle' } } };
    assert.equal(method, 'turn/start');
    generatedTurn = params;
    return { turn: { id: 'schema-check-only' } };
  };
  await schemaClient.send({ threadId, text: 'schema check only' });
  for (const name of turnSchema.required || []) assert.ok(Object.hasOwn(generatedTurn, name), 'Missing turn field: ' + name);
  for (const name of textSchema.required || []) assert.ok(Object.hasOwn(generatedTurn.input[0], name), 'Missing input field: ' + name);
  assert.equal(generatedTurn.input[0].type, 'text');
  assert.equal(typeof generatedTurn.input[0].text, 'string');
  const steerSchemaFile = schemaFiles.find(name => name.endsWith('TurnSteerParams.json'));
  const steerSchema = JSON.parse(await readFile(path.join(schemaDir,steerSchemaFile),'utf8'));
  let generatedSteer;
  schemaClient.connect = async () => {};
  schemaClient.request = async (method,params) => { assert.equal(method,'turn/steer'); generatedSteer=params; return {turnId:'schema-only'}; };
  await schemaClient.send({threadId,mode:'steer',expectedTurnId:'schema-only',text:'schema check only'});
  for (const name of steerSchema.required || []) assert.ok(Object.hasOwn(generatedSteer,name),'Missing steer field: '+name);
  const serverRequestSchema = JSON.parse(await readFile(path.join(schemaDir,schemaFiles.find(name=>name.endsWith('ServerRequest.json'))),'utf8'));
  const methods = serverRequestSchema.oneOf.map(variant=>variant.properties.method.enum?.[0] || variant.properties.method.const);
  for(const method of ['item/tool/requestUserInput','item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','mcpServer/elicitation/request']) assert.ok(methods.includes(method),'Missing native request: '+method);
  console.log(JSON.stringify({ textInputRequired: textSchema.required, turnStartRequired: turnSchema.required, senderFieldsMatch: true }));

  const configurationFile = path.join(directory, 'config.json');
  const endpointFile = path.join(directory, 'endpoint.json');
  await writeFile(configurationFile, JSON.stringify({ cliPath, endpointFile }));
  const csharpString = value => '@"' + value.replaceAll('"', '""') + '"';
  const shimSource = (await readFile(path.join(root, 'src', 'native-cli-shim.cs'), 'utf8'))
    .replace('__NODE_PATH__', csharpString(process.execPath))
    .replace('__PROXY_PATH__', csharpString(path.join(root, 'native-cli-proxy.mjs')))
    .replace('__CONFIG_PATH__', csharpString(configurationFile));
  const shimSourceFile = path.join(directory, 'shim.cs');
  const shimFile = path.join(directory, 'shim.exe');
  await writeFile(shimSourceFile, shimSource);
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await exec(compiler, ['/nologo', '/codepage:65001', '/target:exe', '/out:' + shimFile, shimSourceFile], { windowsHide: true });
  const version = (await exec(shimFile, ['--version'], { windowsHide: true, timeout: 5000 })).stdout.trim();
  desktop = spawn(shimFile, ['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  // Drain stderr without displaying account-specific diagnostics.
  desktop.stderr.resume();
  const messages = [];
  lines = readline.createInterface({ input: desktop.stdout });
  lines.on('line', line => messages.push(JSON.parse(line)));
  desktop.stdin.write(JSON.stringify({ id: 0, method: 'initialize', params: {
    clientInfo: { name: 'codex-relay-readonly-preflight', version: '0.1.0' }, capabilities: { experimentalApi: true }
  } }) + '\n');
  for (let n = 0; n < 150 && !messages.some(message => message.id === 0); n++) {
    assert.equal(desktop.exitCode, null, 'The isolated CLI exited before initialization.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const initialized = messages.find(message => message.id === 0);
  assert.ok(initialized?.result, initialized?.error?.message || 'The isolated CLI did not initialize.');
  // Match the current Desktop: no extra initialized notification.
  client = new NativeDesktopClient({ CODEX_RELAY_NATIVE_ENDPOINT: endpointFile }, 5000);
  await client.connect();
  assert.equal(client.capabilities.events,true);assert.equal(client.capabilities.serverRequests,true);
  await client.subscribe([threadId]);
  const { thread } = await client.request('thread/read', { threadId, includeTurns: false });
  assert.equal(thread.id, threadId);
  assert.equal(messages.filter(message => message.result?.thread).length, 0, 'Relay read response leaked onto Desktop stdio.');
  console.log(JSON.stringify({ version, authenticated: true, sameThreadRead: true, initializationRequests: 1, extraInitializationNotifications: 0, modelRequests: 0 }));
} finally {
  client?.close(); lines?.close();
  if (desktop && desktop.exitCode === null) {
    const exited = once(desktop, 'exit');
    desktop.stdin.end();
    const timer = setTimeout(() => desktop.kill(), 5000);
    await exited; clearTimeout(timer);
  }
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
  assert.deepEqual(await snapshot(), before, 'The live Desktop endpoint changed during preflight.');
}
