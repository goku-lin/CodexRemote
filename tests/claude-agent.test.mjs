import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { delegateToAgent } from '../src/model-router.mjs';

const session = '12345678-1234-1234-1234-123456789abc';

async function fixture(t, behavior = 'success') {
  const dir = await mkdtemp(path.join(tmpdir(), 'claude-delegate-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake-claude.cjs');
  await writeFile(script, `
    const fs = require('node:fs');
    let prompt = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => prompt += chunk);
    process.stdin.on('end', () => {
      fs.writeFileSync('received.json', JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd() }));
      const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
      if (${JSON.stringify(behavior)} === 'hang') { setInterval(() => {}, 1000); return; }
      if (${JSON.stringify(behavior)} === 'malformed') { process.stdout.write('invalid json\\n'); return; }
      emit({ type: 'system', subtype: 'init', model: 'actual-model', session_id: '${session}' });
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', id: 'tool-1' }] } });
      if (${JSON.stringify(behavior)} === 'missing-result') return;
      emit({ type: 'result', subtype: 'success', is_error: ${behavior === 'api-error'},
        result: ${JSON.stringify(behavior === 'api-error' ? 'Authentication failed' : 'completed')},
        session_id: '${session}', duration_ms: 42, usage: { input_tokens: 12, output_tokens: 3 } });
    });
  `);
  return {
    dir,
    config: { providers: { cc: {
      execution: 'claude-cli', command: process.execPath, args: [script],
      runsDirectory: path.join(dir, 'runs'), timeoutMs: behavior === 'hang' ? 700 : 10_000,
      models: { 'test-cc': { id: 'requested-model' } }
    } } }
  };
}

test('CC passes task via stdin, records actual execution, and enforces review tools', async t => {
  const { dir, config } = await fixture(t);
  const result = await delegateToAgent({ config, model: 'test-cc', task: 'quote " / 中文 / $(literal)', cwd: dir });
  const received = JSON.parse(await readFile(path.join(dir, 'received.json'), 'utf8'));
  const args = received.args;
  assert.ok(received.prompt.endsWith('quote " / 中文 / $(literal)'));
  assert.ok(received.prompt.includes(dir));
  assert.match(received.prompt, /report the denial rather than trying to bypass it/);
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(result.rawModel, 'actual-model');
  assert.equal(result.sessionId, session);
  assert.equal(result.toolUses[0].name, 'Write');
  assert.equal(result.usage.output_tokens, 3);
  assert.equal(JSON.parse(await readFile(path.join(result.proofDirectory, 'result.json'), 'utf8')).success, true);
  assert.match(await readFile(path.join(result.proofDirectory, 'events.jsonl'), 'utf8'), /tool_use/);
});

test('CC implementation allows file/command tools and resumes the requested native session', async t => {
  const { dir, config } = await fixture(t);
  await delegateToAgent({ config, model: 'test-cc', task: 'Implement', mode: 'implement', cwd: dir, sessionId: session, effort: 'high' });
  const { args } = JSON.parse(await readFile(path.join(dir, 'received.json'), 'utf8'));
  assert.equal(args[args.indexOf('--resume') + 1], session);
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Write,Edit,Bash');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
});

for (const [behavior, expected] of [
  ['api-error', /Authentication failed/],
  ['missing-result', /未返回最终 result/],
  ['malformed', /无效 stream-json/],
  ['hang', /超过 700ms/]
]) test(`CC reports ${behavior} as failure and preserves evidence`, async t => {
  const { dir, config } = await fixture(t, behavior);
  await assert.rejects(delegateToAgent({ config, model: 'test-cc', task: 'probe', cwd: dir }), error => {
    assert.match(error.message, expected);
    assert.match(error.message, /执行记录/);
    return true;
  });
});

test('CC rejects invalid resume IDs and pre-cancelled calls before starting a process', async t => {
  const { dir, config } = await fixture(t);
  await assert.rejects(delegateToAgent({ config, model: 'test-cc', task: 'probe', cwd: dir, sessionId: 'bad' }), /UUID/);
  await assert.rejects(delegateToAgent({ config, model: 'test-cc', task: 'probe', cwd: dir, signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(readFile(path.join(dir, 'received.json')), { code: 'ENOENT' });
});

test('fresh MCP connection advertises CC and returns native session and execution evidence', async t => {
  const { dir, config } = await fixture(t);
  const configPath = path.join(dir, 'providers.json');
  await writeFile(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/delegate-mcp.mjs', import.meta.url))], {
    env: { ...process.env, MODEL_DELEGATE_CONFIG: configPath }, windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
  child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate_to_agent', arguments: { model: 'test-cc', task: 'review', cwd: dir, session_id: session } } }
  ].map(message => JSON.stringify(message)).join('\n') + '\n');
  assert.equal(await closed, 0, stderr);
  const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
  const tool = responses[0].result.tools.find(item => item.name === 'delegate_to_agent');
  assert.match(tool.description, /test-cc/);
  assert.ok(tool.inputSchema.properties.session_id);
  assert.equal(responses[1].result.structuredContent.session_id, session);
  assert.equal(responses[1].result.structuredContent.model, 'actual-model');
  assert.equal(responses[1].result.content[0].text, 'completed');
  assert.ok(responses[1].result.structuredContent.proof_directory);
});
