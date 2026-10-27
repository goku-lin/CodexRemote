import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';

test('CC panel preserves browser auth, deduplicates dispatch, serves confined static artifacts, resumes and stops only its job', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-panel-http-'));
  const cwd = path.join(root, 'workspace'); await fs.mkdir(cwd);
  const config = path.join(root, 'providers.json'), script = path.join(root, 'fake.cjs'), session = randomUUID();
  await fs.writeFile(script, `
    const fs=require('node:fs');let task='';const emit=v=>console.log(JSON.stringify(v));
    process.stdin.setEncoding('utf8').on('data',c=>task+=c).on('end',()=>{
      emit({type:'system',subtype:'init',model:'mock-model',session_id:'${session}'});
      emit({type:'system',subtype:'thinking_tokens',tokens:1});
      if(task.includes('HANG')){setInterval(()=>{},1000);return;}
      emit({type:'assistant',message:{content:[{type:'tool_use',id:'w',name:'Write',input:{file_path:'test.svg'}}]}});
      fs.writeFileSync('test.svg','<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>');
      emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'w',content:'ok',is_error:false}]}});
      emit({type:'result',subtype:'success',is_error:false,session_id:'${session}',result:'done'});
    });
  `);
  await fs.writeFile(config, JSON.stringify({ providers: { cc: { execution: 'claude-cli', command: process.execPath, args: [script], timeoutMs: 15000, models: { 'cc-deepseek-flash': { id: 'mock-model' } } } } }));
  await fs.writeFile(path.join(root, 'network.json'), JSON.stringify({ externalOrigin: 'https://cc-panel.test-tail.ts.net' }));
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve)); const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_RELAY_DATA_DIR: root, CODEX_RELAY_TOKEN: 'test-cc-panel', CODEX_RELAY_NO_EMBEDDED: '1', MODEL_DELEGATE_CONFIG: config } });
  t.after(async () => { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); await closed; assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.on('data', chunk => { if (String(chunk).includes('listening')) resolve(); }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (url, { headers = {}, body, method = body === undefined ? 'GET' : 'POST' } = {}) => new Promise((resolve, reject) => {
    const req = request(base + url, { method, headers: { 'content-type': 'application/json', ...headers } }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json, headers: res.headers }); }); });
    req.once('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const remote = { host: 'cc-panel.test-tail.ts.net', 'x-forwarded-proto': 'https' };
  assert.equal((await send('/api/agent-tasks', { headers: remote })).status, 401);
  assert.equal((await send('/api/agent-tasks', { headers: remote, body: {} })).status, 401);
  const phone = (await send('/api/phone')).json;
  const pair = await send('/api/access/pair', { headers: remote, body: { code: phone.code } });
  const paired = { ...remote, cookie: pair.headers['set-cookie'][0].split(';')[0] };
  assert.equal((await send('/api/agent-tasks', { headers: { ...paired, origin: 'https://wrong.test' }, body: {} })).status, 403);
  assert.equal((await send('/api/agent-tasks', { headers: paired })).json.models[0].id, 'mock-model');
  assert.equal((await send('/agent-tasks.html')).status, 200);
  const id = randomUUID(), body = { requestId: id, task: 'create a file', cwd, mode: 'implement' };
  assert.equal((await send('/api/agent-tasks', { headers: paired, body })).status, 202);
  const duplicate = await send('/api/agent-tasks', { headers: paired, body });
  assert.equal(duplicate.json.duplicate, true);
  async function untilState(id, state) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const response = await send('/api/agent-tasks/' + id, { headers: paired }); if (response.json?.status.state === state) return response.json; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Test worker did not reach ' + state);
  }
  const done = await untilState(id, 'completed'), file = done.files.find(file => file.name === 'test.svg');
  assert.equal(done.status.sourceThreadId, null, 'web tasks do not inherit the web server launcher thread ID');
  const fileUrl = `/api/agent-tasks/${id}/files/${file.id}/test.svg`;
  assert.equal((await send(fileUrl, { headers: remote })).status, 401);
  const artifact = await send(fileUrl, { headers: paired });
  assert.equal(artifact.status, 200); assert.match(artifact.text, /<svg/); assert.match(artifact.headers['content-security-policy'], /script-src 'none'/);
  assert.equal((await send(`/api/agent-tasks/${id}/files/${file.id}/providers.json`, { headers: paired })).status, 404);
  const next = randomUUID();
  assert.equal((await send(`/api/agent-tasks/${id}/continue`, { headers: paired, body: { requestId: next, task: 'continue' } })).status, 202);
  assert.equal((await untilState(next, 'completed')).status.sessionId, session);
  const hang = randomUUID();
  await send('/api/agent-tasks', { headers: paired, body: { ...body, requestId: hang, task: 'HANG' } });
  await untilState(hang, 'responding');
  assert.equal((await send(`/api/agent-tasks/${hang}/continue`, { headers: paired, body: { requestId: randomUUID(), task: 'parallel' } })).status, 409);
  assert.equal((await send(`/api/agent-tasks/${hang}/stop`, { headers: paired, body: {} })).json.run.stopRequested, true);
  await untilState(hang, 'cancelled');
  assert.equal((await send(`/api/agent-tasks/${id}`, { headers: paired })).json.status.state, 'completed', 'stopping one job leaves another unchanged');
});
