import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RolloutReader, compactHistoryItems } from '../src/rollout.mjs';
import { questionReplyText, questionReplyMessage, normalizeQuestions } from '../public/questions.js';

const timestamp = '2026-10-11T02:00:00.000Z';
const record = payload => ({ type: 'event_msg', timestamp, payload });
const start = id => record({ type: 'task_started', turn_id: id, started_at: 1791684000 });
const end = id => record({ type: 'task_complete', turn_id: id, completed_at: 1791684060 });
const native = (turn, item, at = 1791684000000) => record({ type: 'item_completed', turn_id: turn, started_at_ms: at, completed_at_ms: at + 10, item });
const user = (turn, text = '真实请求') => native(turn, { id: `${turn}-user`, type: 'UserMessage', text });
const reply = (turn, phase = 'final_answer', text = '完成') => native(turn, { id: `${turn}-${phase}`, type: 'AgentMessage', text, phase }, 1791684060000);
const lines = entries => entries.map(entry => JSON.stringify(entry) + '\n').join('');

test('rollback markers remove edited history and rehydrate the older visible tail without reviving removed turns',async t=>{
  const file=await fixture(t,Array.from({length:6},(_,index)=>[start('t'+index),user('t'+index,'请求'+index),reply('t'+index),end('t'+index)]).flat());
  const reader=new RolloutReader(2);let history=await reader.read([file]);assert.equal(history.turnCount,6);assert.equal(history.items[0].text,'请求4');
  await appendFile(file,lines([record({type:'thread_rolled_back',num_turns:5})]));
  history=await reader.read([file]);assert.equal(history.turnCount,1);assert.equal(history.items[0].text,'请求0');assert.equal(history.messageCount,2);
  await appendFile(file,lines([start('edited'),user('edited','编辑后的请求'),reply('edited'),end('edited')]));
  history=await reader.read([file]);assert.equal(history.turnCount,2);assert.equal(history.messageCount,4);assert.ok(!history.items.some(item=>item.turnId==='t5'));assert.equal(history.items.find(item=>item.turnId==='edited' && item.role==='user').text,'编辑后的请求');
});
test('token usage updates without counting messages, selects newer records and follows compaction',async t=>{
  const file=await fixture(t,[start('tokens'),user('tokens'),record({type:'token_count',info:{last_token_usage:{total_tokens:100},total_token_usage:{total_tokens:99999},model_context_window:1000}})]);
  const reader=new RolloutReader();let history=await reader.read([file]);assert.equal(history.messageCount,1);assert.equal(history.tokenUsage.usedPercent,10);
  await appendFile(file,lines([{type:'event_msg',timestamp:'2026-10-11T02:01:00.000Z',payload:{type:'token_count',info:{last_token_usage:{total_tokens:20},model_context_window:1000}}},record({type:'token_count',info:{last_token_usage:{total_tokens:800},model_context_window:1000}})]));
  history=await reader.read([file]);assert.equal(history.tokenUsage.usedPercent,2);assert.equal(history.messageCount,1);
});

test('desktop model and reasoning settings retain their real values and clear an unconfirmed effort after a model change',async t=>{
  const file=await fixture(t,[{type:'turn_context',timestamp,payload:{model:'gpt-6.1-sol',effort:'max'}},start('settings'),user('settings')]);
  const reader=new RolloutReader();let history=await reader.read([file]);
  assert.equal(history.settings.model,'gpt-6.1-sol');assert.equal(history.settings.effort,'max');
  assert.equal(history.settings.at,Date.parse(timestamp));
  await appendFile(file,lines([record({type:'thread_settings_applied',thread_settings:{model:'gpt-6-astra'}})]));
  history=await reader.read([file]);assert.equal(history.settings.model,'gpt-6-astra');assert.equal(history.settings.effort,null);
  await appendFile(file,lines([{type:'turn_context',timestamp,payload:{model:'gpt-6-astra',reasoning_effort:'high'}}]));
  history=await reader.read([file]);assert.equal(history.settings.effort,'high');
});

test('image-view native rows retain file URLs and normal image links for remote delivery',async t=>{
  const file=await fixture(t,[start('images'),user('images'),
    native('images',{id:'v1',type:'ImageView',path:'file:///D:/comparison one.png'}),
    native('images',{id:'v2',type:'ImageView',path:'file:///D:/comparison_two.png'}),
    reply('images','final_answer','[参考图](D:/comparison one.png)'),end('images')]);
  const history=await new RolloutReader().read([file]);
  assert.equal(history.items.find(item=>item.id==='v1').kind,'imageView');
  assert.equal(history.items.find(item=>item.id==='v1').images[0].ref,'file:///D:/comparison one.png');
  assert.equal(history.items.find(item=>item.phase==='final_answer').images[0].ref,'D:/comparison one.png');
  assert.equal(history.turns[0].itemCount,4);
});

test('human-readable forwarded question answers remain attached to the pending question',async t=>{
  const questions=normalizeQuestions([{title:'选择连接方式',options:['Wi-Fi','外网']}],'ask-readable');
  const prompt=questionReplyMessage(questions,{[questions[0].id]:'Wi-Fi'});
  const file=await fixture(t,[start('a'),user('a'),native('a',{id:'ask-readable',type:'AgentMessage',delivery:'async',questions}),
    native('a',{id:'forwarded',type:'FunctionCallOutput',name:'send_message_to_thread',output:`<codex_delegation><input>${prompt}</input></codex_delegation>`}),reply('a'),end('a')]);
  const history=await new RolloutReader().read([file]);
  assert.equal(history.turnCount,1);assert.equal(history.items.filter(item=>item.role==='user').length,1);
  assert.equal(history.items.find(item=>item.id==='ask-readable').answerState,'forwarded');
  assert.equal(history.items.find(item=>item.id==='ask-readable').questionAnswers[questions[0].id],'Wi-Fi');
});

test('desktop forwarded input creates its real turn, keeps the reply, and inherits Fast settings',async t=>{
  const output='<codex_delegation>\n<source_thread_id>source</source_thread_id>\n<input>你好</input>\n</codex_delegation>';
  const file=await fixture(t,[start('a'),user('a'),reply('a'),end('a'),
    record({type:'thread_settings_applied',thread_settings:{service_tier:'priority',model:'model'}}),
    {type:'turn_context',payload:{effort:'max'}},start('b'),
    {type:'response_item',timestamp,payload:{type:'function_call_output',id:'forwarded',name:'send_message_to_thread',output,internal_chat_message_metadata_passthrough:{turn_id:'b'}}},
    native('b',{type:'FunctionCallOutput',id:'forwarded',name:'send_message_to_thread',output}),
    {type:'response_item',timestamp,payload:{type:'message',role:'assistant',id:'answer',phase:'final_answer',content:[{text:'你好！'}],internal_chat_message_metadata_passthrough:{turn_id:'b'}}},end('b')]);
  const history=await new RolloutReader().read([file]);
  assert.equal(history.turns[0].status,'completed');
  assert.equal(history.turns.length,2);
  assert.equal(history.items.find(item=>item.id === 'forwarded').text,'你好');
  assert.equal(history.items.find(item=>item.id === 'answer').turnId,'b');
  assert.equal(history.settings.serviceTier,'priority');
});

async function fixture(t, entries) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-rollout-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('relay-rollout-test-'));
    return rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'history.jsonl');
  await writeFile(file, lines(entries));
  return file;
}

test('native async questions retain controls, native and forwarded answers resolve them without replacing user input', async t => {
  const questions=normalizeQuestions([{title:'选择连接方式',options:['Wi-Fi','外网']}],'ask');
  const question=native('a',{id:'ask',type:'AgentMessage',phase:'final_answer',delivery:'async',questions});
  const answer=questionReplyText(questions,{[questions[0].id]:'Wi-Fi'});
  const file=await fixture(t,[start('a'),user('a'),question,
    native('a',{id:'answer',type:'UserMessage',text:answer},1791684020000),
    native('a',{id:'progress',type:'AgentMessage',phase:'commentary',text:'正在配置手机'},1791684030000)]);
  const reader=new RolloutReader(), history=await reader.read([file]);
  assert.equal(history.turnCount,1);assert.equal(history.items.length,3);
  assert.equal(history.turns[0].status,'inProgress');
  assert.equal(history.items.find(item=>item.id === 'ask').questionAnswers[questions[0].id],'Wi-Fi');
  assert.equal(history.items.find(item=>item.id === 'ask').answerState,'answered');
  assert.equal(history.turns[0].startedAt,1791684000000);
  const forwarded=questionReplyText(questions,{[questions[0].id]:'外网'});
  await appendFile(file,lines([native('a',{id:'forwarded',type:'FunctionCallOutput',name:'send_message_to_thread',output:`<codex_delegation><input>${forwarded}</input></codex_delegation>`},1791684040000)]));
  const changed=await reader.read([file]);
  assert.equal(changed.items.length,3);
  assert.equal(changed.items.find(item=>item.id === 'ask').answerState,'answered');
  assert.equal(changed.items.find(item=>item.id === 'ask').questionAnswers[questions[0].id],'Wi-Fi');
});

test('native UI items supersede execution wrappers and retain phase, command, diff and browser title', async t => {
  const file = await fixture(t, [start('a'), user('a'),
    { type: 'response_item', timestamp, payload: { type: 'function_call', call_id: 'wrapper', name: 'exec', arguments: 'tools.exec_command(...)' } },
    native('a', { id: 'comment', type: 'AgentMessage', text: '正在检查', phase: 'commentary' }),
    native('a', { id: 'command', type: 'CommandExecution', command: ['powershell.exe', '-Command', 'Get-Content app.js'], aggregated_output: '结果', exit_code: 0 }),
    native('a', { id: 'edit', type: 'FileChange', changes: { 'C:/app.js': { type: 'update', unified_diff: '@@\n+new\n-old' } } }),
    native('a', { id: 'browser', type: 'McpToolCall', server: 'cua_repl', tool: 'js', arguments: { title: '读取当前界面', code: 'await tab.getAXState()' }, result: { content: [{ type: 'text', text: '页面结构' }] } }),
    native('a', { id: 'compact', type: 'ContextCompaction' }),
    native('a', { id: 'reasoning', type: 'Reasoning', text: 'private' }), reply('a'), end('a')]);
  const history = await new RolloutReader().read([file]);
  assert.equal(history.turnCount, 1);
  assert.equal(history.turns[0].itemCount, 7);
  assert.equal(history.items.filter(item => item.role !== 'user' && item.phase !== 'final_answer').length, 5);
  assert.ok(!history.items.some(item => item.id === 'wrapper' || item.id === 'reasoning'));
  assert.equal(history.items.find(item => item.id === 'command').command, 'Get-Content app.js');
  assert.equal(history.items.find(item => item.id === 'edit').changes[0].additions, 1);
  assert.equal(history.items.find(item => item.id === 'browser').title, '读取当前界面');
  assert.equal(history.items.find(item => item.phase === 'final_answer').text, '完成');
});

test('wrapped requests survive, new user turns stay separate, userless continuations belong to the same turn', async t => {
  const file = await fixture(t, [start('a'), user('a'), reply('a'), end('a'), start('b'),
    user('b', '<in-app-browser-context>state</in-app-browser-context>\n\n## My request:\n最新请求'),
    native('b', { id: 'context-only', type: 'UserMessage', text: '<in-app-browser-context>state</in-app-browser-context>' }),
    native('b', { id: 'progress', type: 'AgentMessage', text: '检查中', phase: 'commentary' }),
    start('continuation'), native('continuation', { id: 'compact', type: 'ContextCompaction' }), reply('continuation'), end('continuation')]);
  const history = await new RolloutReader().read([file]);
  assert.deepEqual(history.turns.map(turn => [turn.id, turn.status]), [['a', 'completed'], ['b', 'completed']]);
  assert.ok(history.items.some(item => item.text?.includes('最新请求')));
  assert.equal(history.items.find(item => item.id === 'compact').turnId, 'b');
  assert.ok(!history.items.some(item => item.id === 'context-only'));
});

test('idle reads consume zero bytes; partial UTF-8 records and changed outputs merge without duplicates', async t => {
  const file = await fixture(t, [start('a'), user('a')]);
  const reader = new RolloutReader();
  await reader.read([file]);
  const before = reader.bytesRead;
  await reader.read([file]);
  assert.equal(reader.bytesRead, before);
  const entry = Buffer.from(lines([native('a', { id: 'command', type: 'CommandExecution', command: ['node', '--check', 'app.js'], aggregated_output: '中文输出' })]));
  const offset = entry.indexOf(Buffer.from('中文')) + 1;
  await appendFile(file, entry.subarray(0, offset));
  assert.equal((await reader.read([file])).items.length, 1);
  await appendFile(file, entry.subarray(offset));
  assert.equal((await reader.read([file])).items.find(item => item.id === 'command').output, '中文输出');
  await appendFile(file, lines([native('a', { id: 'command', type: 'CommandExecution', command: 'node --check app.js', aggregated_output: '新输出' })]));
  const history = await reader.read([file]);
  assert.equal(history.items.length, 2);
  assert.equal(history.items.find(item => item.id === 'command').output, '新输出');
});

test('recent window keeps whole turns and older counts; payload clipping keeps row identities', async t => {
  const entries = Array.from({ length: 8 }, (_, i) => [start(`t${i}`), user(`t${i}`), reply(`t${i}`), end(`t${i}`)]).flat();
  const file = await fixture(t, entries);
  const recent = await new RolloutReader(5).read([file]);
  assert.equal(recent.turnCount, 8);
  assert.deepEqual(recent.turns.map(turn => turn.id), ['t3', 't4', 't5', 't6', 't7']);
  assert.equal(recent.items.length, 10);
  const all = await new RolloutReader(Infinity).read([file]);
  assert.equal(all.items.length, 16);
  const oversized = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, role: 'process', output: 'x'.repeat(24000) }));
  const compact = compactHistoryItems(oversized, 200000);
  assert.deepEqual(compact.map(item => item.id), oversized.map(item => item.id));
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 200000);
});
