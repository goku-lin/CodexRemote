import test from 'node:test';
import assert from 'node:assert/strict';
import { delegateToAgent, delegateToModel, listConfiguredModels, resolveModel } from '../src/model-router.mjs';

const config = {
  providers: {
    deepseek: {
      name: 'DeepSeek', protocol: 'openai-chat', baseUrl: 'https://deepseek.test/v1', apiKeyEnv: 'TEST_DEEPSEEK_KEY',
      models: { 'deepseek-flash': { id: 'deepseek-flash', label: 'Flash' } }
    },
    anthropic: {
      name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://anthropic.test', apiKeyEnv: 'TEST_ANTHROPIC_KEY',
      models: { 'claude-sonnet': { id: 'claude-sonnet-4-5' } }
    }
  }
};

test('lists aliases and resolves a model to its provider', () => {
  assert.deepEqual(listConfiguredModels(config).map(item => item.alias), ['deepseek-flash', 'claude-sonnet']);
  process.env.TEST_DEEPSEEK_KEY = 'test-key';
  assert.equal(resolveModel(config, 'deepseek-flash').provider.apiKey, 'test-key');
  delete process.env.TEST_DEEPSEEK_KEY;
});

test('delegates to an OpenAI-compatible provider', async () => {
  const original = globalThis.fetch;
  process.env.TEST_DEEPSEEK_KEY = 'test-key';
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://deepseek.test/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.messages.at(-1).content, '做一个小测试');
    return new Response(JSON.stringify({ model: 'deepseek-flash', choices: [{ message: { content: '测试完成' } }] }), { status: 200 });
  };
  await assert.doesNotReject(async () => {
    const result = await delegateToModel({ config, model: 'deepseek-flash', task: '做一个小测试' });
    assert.equal(result.text, '测试完成');
  });
  globalThis.fetch = original;
  delete process.env.TEST_DEEPSEEK_KEY;
});

test('delegates to Anthropic Messages API', async () => {
  const original = globalThis.fetch;
  process.env.TEST_ANTHROPIC_KEY = 'test-key';
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://anthropic.test/v1/messages');
    assert.equal(init.headers['x-api-key'], 'test-key');
    return new Response(JSON.stringify({ model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Claude 完成' }] }), { status: 200 });
  };
  const result = await delegateToModel({ config, model: 'claude-sonnet', task: '检查一下' });
  assert.equal(result.text, 'Claude 完成');
  globalThis.fetch = original;
  delete process.env.TEST_ANTHROPIC_KEY;
});

test('runs a configured Codex CLI child and returns its final answer', async () => {
  const childScript = "process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'子代理完成'}})+'\\n')";
  const agentConfig = {
    providers: {
      codex: {
        name: 'Codex CLI', execution: 'codex-cli', command: process.execPath,
        args: ['-e', childScript], timeoutMs: 10_000,
        models: { 'test-agent': { id: 'test-model' } }
      }
    }
  };
  const result = await delegateToAgent({ config: agentConfig, model: 'test-agent', task: '执行测试', mode: 'review' });
  assert.equal(result.text, '子代理完成');
  assert.equal(result.rawModel, 'test-model');
});

test('runs a configured DeepSeek Harness child with a temporary route overlay', async () => {
  const childScript = "const fs=require('node:fs'); const p=process.argv.find(value=>value.endsWith('.yml')); process.stdout.write(p ? fs.readFileSync(p, 'utf8') : 'missing overlay')";
  const dshConfig = {
    providers: {
      dsh: {
        name: 'DeepSeek Harness', execution: 'dsh-cli', command: process.execPath,
        args: ['-e', childScript, '--'], profile: 'headless', reuseCredentials: true, timeoutMs: 10_000,
        models: { 'dsh-flash': { id: 'deepseek-flash', route: 'deepseek-account/deepseek-flash', label: 'DSH Flash' } }
      }
    }
  };
  const result = await delegateToAgent({ config: dshConfig, model: 'dsh-flash', task: '执行 DSH 测试', mode: 'review' });
  assert.match(result.text, /provider: "deepseek-account"/);
  assert.match(result.text, /model: "deepseek-flash"/);
  assert.equal(result.rawModel, 'deepseek-account/deepseek-flash');
});
