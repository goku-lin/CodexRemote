import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {applyHistoryUpdate} from '../public/history-sync.js';

test('initial data and history windows preserve authorization and counts; text compresses, static files revalidate, SSE stays live', { timeout: 15_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-loading-'));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url), windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_RELAY_TOKEN: 'loading-test', CODEX_RELAY_NO_EMBEDDED: '1', CODEX_RELAY_DATA_DIR: directory }
  });
  t.after(async () => {
    const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped;
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject); child.stdout.on('data', chunk => { if (String(chunk).includes('listening')) resolve(); });
  });
  const base = `http://127.0.0.1:${port}`;
  const health=await (await fetch(base+'/api/health')).json();
  assert.equal(health.relay.state,'ready');assert.equal(health.runner.state,'offline');
  const check=await fetch(base+'/api/health/check',{method:'POST'});assert.equal(check.status,202);
  const recover=await fetch(base+'/api/health/recover',{method:'POST'});assert.equal(recover.status,202);
  for(let n=0;n<20;n++){
    const result=await (await fetch(base+'/api/health')).json();
    if(!result.checking){assert.equal(result.external.state,'disabled');break;}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const raw = (endpoint, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = request(base + endpoint, { method, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
  fs.writeFileSync(path.join(directory, 'network.json'), JSON.stringify({ externalOrigin: 'https://relay.test-tail.ts.net' }));
  const remote = { host: 'relay.test-tail.ts.net', 'x-forwarded-proto': 'https' };
  assert.equal((await raw('/api/health',remote)).status,401);
  assert.equal((await raw('/api/health/check',remote,'POST')).status,401);
  assert.equal((await raw('/api/health/recover',remote,'POST')).status,401);
  const locked = await raw('/api/bootstrap', remote);
  assert.deepEqual(JSON.parse(locked.body), { access: { required: true, local: false } });
  assert.equal(locked.headers['cache-control'], 'no-store');
  const local = await (await fetch(base + '/api/bootstrap')).json();
  assert.deepEqual(local.access, { required: false, local: true }); assert.equal(local.devices[0].id, 'local');

  const post = body => fetch(base + '/api/runner/local/events', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-relay-token': 'loading-test' }, body: JSON.stringify(body)
  });
  await post({ type: 'thread_list', threads: [{ id: 'window', name: 'Loading fixture', cwd: directory, createdAt: 1, updatedAt: 2, status: { type: 'idle' } }] });
  const session = (await (await fetch(base + '/api/sessions')).json()).sessions[0];
  const turns = Array.from({ length: 12 }, (_, i) => ({ id: 't' + i, status: 'completed', itemCount: 3, startedAt: (i + 1) * 10_000, completedAt: (i + 1) * 10_000 + 1000 }));
  const items = turns.flatMap(turn => [
    { id: 'u' + turn.id, turnId: turn.id, role: 'user', text: '用户输入😀', at: turn.startedAt },
    { id: 'c' + turn.id, turnId: turn.id, role: 'process', kind: 'commandExecution', command: 'node --check app.js', output: '完整输出中文😀\n'.repeat(200), at: turn.startedAt + 500 },
    { id: 'a' + turn.id, turnId: turn.id, role: 'assistant', phase: 'final_answer', text: '完成', at: turn.completedAt }
  ]);
  await post({ type: 'thread_history', sessionId: session.id, threadId: 'window', turns, items, turnCount: 12, messageCount: 36 });
  const historyPath = `/api/sessions/${session.id}/history`;
  const full = await (await fetch(base + historyPath)).json();
  const recent = await raw(historyPath + '?maxTurns=5', { 'accept-encoding': 'gzip' });
  assert.equal(recent.headers['content-encoding'], 'gzip');
  const decoded = JSON.parse(gunzipSync(recent.body));
  assert.deepEqual(decoded.turns.map(turn => turn.id), turns.slice(-5).map(turn => turn.id));
  assert.equal(decoded.events.length, 16); assert.equal(decoded.messageCount, 36); assert.equal(decoded.turnCount, 12);
  assert.equal(decoded.historyVersion, full.historyVersion); assert.match(decoded.events[2].message.params.item.output, /中文😀/);
  assert.ok(recent.body.length < Buffer.byteLength(JSON.stringify(decoded)) / 3);
  assert.equal(recent.headers['cache-control'], 'no-store');
  const expanded = await (await fetch(base + historyPath + '?maxTurns=10')).json();
  assert.equal(expanded.turns.length, 10); assert.equal(expanded.events.length, 31);
  assert.deepEqual(await (await fetch(base + historyPath + '?maxTurns=all')).json(), full);
  assert.equal((await fetch(base + historyPath + '?maxTurns=NaN')).status, 400);
  const initial = await (await fetch(base + '/api/bootstrap')).json();
  assert.equal(initial.sessions[0].historyVersion, full.historyVersion);
  assert.ok(!Object.hasOwn(initial.sessions[0], 'events'));
  assert.equal((await raw(historyPath, remote)).status, 401);

  const identity = await raw('/app.js');
  const compressed = await raw('/app.js', { 'accept-encoding': 'gzip;q=0.5, br;q=1' });
  assert.equal(compressed.headers['content-encoding'], 'br');
  assert.deepEqual(brotliDecompressSync(compressed.body), identity.body);
  assert.equal(compressed.headers.vary, 'Accept-Encoding');
  assert.equal(compressed.headers.etag, identity.headers.etag);
  const disabled = await raw('/app.js', { 'accept-encoding': 'br;q=0, gzip;q=0, *;q=1' });
  assert.ok(!disabled.headers['content-encoding']); assert.deepEqual(disabled.body, identity.body);
  const cached = await raw('/app.js', { 'if-none-match': compressed.headers.etag, 'accept-encoding': 'br' });
  assert.equal(cached.status, 304); assert.equal(cached.body.length, 0);
  const head = await raw('/app.js', { 'accept-encoding': 'br' }, 'HEAD');
  assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), compressed.body.length);
  const abort = new AbortController(); t.after(() => abort.abort());
  const stream = await fetch(base + '/api/events', { headers: { 'accept-encoding': 'br,gzip' }, signal: abort.signal });
  assert.ok(!stream.headers.has('content-encoding'));
  const reader = stream.body.getReader(); const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /: connected/); assert.match(first, /event: snapshot/); await reader.cancel();

  const synced=await (await fetch(base+historyPath+'?maxTurns=5&sync=1')).json();
  assert.equal(synced.historySync.kind,'full');
  const previous=applyHistoryUpdate({},synced);
  const cursorPath=historyPath+'?maxTurns=5&sync=1&cursor='+synced.historySync.cursor;
  const unchanged=await(await fetch(base+cursorPath)).json();
  assert.equal(unchanged.historySync.kind,'delta');assert.equal(unchanged.events.length,0);
  assert.equal((await raw(cursorPath,remote)).status,401);
  assert.equal((await fetch(base+historyPath+'?maxTurns=5&sync=1&cursor=invalid')).status,400);
  items.at(-1).text='更新后的回复';
  await post({type:'thread_history',sessionId:session.id,threadId:'window',turns,items,turnCount:12,messageCount:36});
  const updated=await(await fetch(base+cursorPath)).json();
  assert.equal(updated.historySync.kind,'delta');assert.equal(updated.events.length,1);
  const expected=await(await fetch(base+historyPath+'?maxTurns=5')).json();
  assert.deepEqual(applyHistoryUpdate(previous,updated).events,expected.events);
  assert.equal((await(await fetch(base+historyPath+'?maxTurns=10&sync=1&cursor='+previous.cursor)).json()).historySync.kind,'full');
  const removed=items.filter(item=>item.turnId!=='t11');
  await post({type:'thread_history',sessionId:session.id,threadId:'window',turns:turns.slice(0,-1),items:removed,turnCount:11,messageCount:33});
  const rolledBack=await(await fetch(base+historyPath+'?maxTurns=5&sync=1&cursor='+updated.historySync.cursor)).json();
  assert.deepEqual(applyHistoryUpdate(applyHistoryUpdate(previous,updated),rolledBack).events,(await(await fetch(base+historyPath+'?maxTurns=5')).json()).events);
  await post({type:'thread_list',threads:[{id:'other',name:'Other fixture',cwd:directory,status:{type:'idle'},createdAt:1,updatedAt:2}]});
  const other=(await(await fetch(base+'/api/sessions')).json()).sessions.find(item=>item.threadId==='other');
  const scoped=await(await fetch(base+`/api/sessions/${other.id}/history?maxTurns=5&sync=1&cursor=${previous.cursor}`)).json();
  assert.equal(scoped.historySync.kind,'full');assert.equal(scoped.events.length,0);
});
