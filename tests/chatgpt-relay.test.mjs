import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGptRelay, normalizeRead } from '../src/chatgpt-relay.mjs';

class FakeBridge {
  available = true;
  calls = [];
  async tool(name, args) {
    this.calls.push({ name, args });
    if (name === 'list_threads') return { threads: [
      { id:'chat-1', kind:'chatgpt', title:'Chat 对话', status:'idle', updatedAt:10 },
      { id:'codex-1', kind:'codex', title:'Codex 对话' }
    ] };
    if (name === 'read_thread') return { thread:{id:'chat-1',kind:'chatgpt',title:'Chat 对话',status:{type:'idle'}}, turns:[{id:'turn-1',items:[
      { type:'userMessage', content:[{type:'text',text:'你好'}] },
      { type:'agentMessage', text:'你好！' },
      { type:'reasoning', text:'隐藏' }
    ]}] };
    if (name === 'send_message_to_thread') return { accepted:true };
    throw new Error('unexpected tool');
  }
  close() {}
}

test('ChatGPT relay lists only ChatGPT conversations and normalizes readable turns', async () => {
  const bridge = new FakeBridge(), relay = new ChatGptRelay({ bridge });
  assert.deepEqual((await relay.listThreads()).threads.map(thread => thread.id), ['chat-1']);
  const read = await relay.readThread('chat-1');
  assert.deepEqual(read.turns[0].items, [{role:'user',text:'你好'},{role:'assistant',text:'你好！'}]);
  assert.equal(bridge.calls[1].name, 'read_thread');
});

test('ChatGPT relay rejects sending before a listed conversation and forwards valid prompts', async () => {
  const bridge = new FakeBridge(), relay = new ChatGptRelay({ bridge });
  await assert.rejects(() => relay.send('unknown', '你好'), /不存在/);
  await relay.listThreads();
  await relay.send('chat-1', '继续');
  assert.deepEqual(bridge.calls.at(-1), { name:'send_message_to_thread', args:{threadId:'chat-1',prompt:'继续'} });
});

test('ChatGPT relay converts newest-first app-tool pages to chronological display order',()=>{
  const read=normalizeRead({page:{order:'newest_first'},turns:[
    {id:'new',items:[{type:'agentMessage',text:'较新的回答'}]},
    {id:'old',items:[{type:'agentMessage',text:'较早的回答'}]}
  ]});
  assert.deepEqual(read.turns.map(turn=>turn.id),['old','new']);
});
