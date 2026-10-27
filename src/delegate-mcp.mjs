import readline from 'node:readline';
import { delegateToAgent, delegateToModel, listConfiguredModels, loadModelRouterConfig } from './model-router.mjs';

const protocolVersion = '2024-11-05';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

function toolDescription(config) {
  const models = listConfiguredModels(config);
  const apiModels = models.filter(item => item.execution === 'api');
  const names = apiModels.map(item => `${item.alias} (${item.provider})`).join(', ') || '尚未配置模型';
  const tools = [{
    name: 'delegate_to_model',
    description: `把一个独立任务交给指定的低成本或专用模型，并返回最终文本。当前可用模型：${names}`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['model', 'task'],
      properties: {
        model: { type: 'string', description: '配置中的模型别名，例如 deepseek-flash 或 claude-sonnet。' },
        task: { type: 'string', description: '交给子模型的独立任务。请写成自包含指令。' },
        system: { type: 'string', description: '可选的子模型系统指令。' },
        max_output_tokens: { type: 'integer', minimum: 1, maximum: 65536, description: '可选的最大输出 token 数。' }
      }
    }
  }];
  const agents = models.filter(item => ['codex-cli', 'claude-cli'].includes(item.execution));
  if (agents.length) tools.push({
    name: 'delegate_to_agent',
    description: `在需要独立编码、审查或测试时启动一个独立的 CLI 执行器，并返回最终结果。可用执行器：${agents.map(item => `${item.alias} (${item.label})`).join(', ')}`,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['model', 'task'],
      properties: {
        model: { type: 'string', description: '配置中的执行器别名。' },
        task: { type: 'string', description: '自包含的编码、审查或测试任务。' },
        mode: { type: 'string', enum: ['review', 'implement'], description: 'review 只读；implement 允许在工作区修改文件。' },
        cwd: { type: 'string', description: '可选的绝对工作目录；省略时使用 CodexRemote 配置的默认项目目录。' },
        system: { type: 'string', description: '可选的执行器指令。' },
        session_id: { type: 'string', description: '仅 Claude Code：继续此前返回的会话 UUID。' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: '仅 Claude Code：推理强度，默认 max。' }
      }
    }
  });
  const dshAgents = models.filter(item => item.execution === 'dsh-cli');
  if (dshAgents.length) tools.push({
    name: 'delegate_to_dsh',
    description: `通过本机 DeepSeek Harness 的 headless CLI 启动一次独立子代理任务，并返回最终答案。可用 DSH 执行器：${dshAgents.map(item => `${item.alias} (${item.label})`).join(', ')}。DSH 使用自己的登录/密钥和模型路由。`,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['task'],
      properties: {
        model: { type: 'string', description: '可选的 DSH 模型别名；省略时使用配置中的第一个 DSH 模型。' },
        task: { type: 'string', description: '自包含的 DeepSeek Harness 任务。' },
        mode: { type: 'string', enum: ['review', 'implement'], description: 'review 只读；implement 允许 DSH 在工作区修改文件。' },
        cwd: { type: 'string', description: '可选的绝对工作目录；省略时使用 CodexRemote 配置的默认项目目录。' },
        system: { type: 'string', description: '可选的 DSH 子代理系统指令。' }
      }
    }
  });
  return tools;
}

async function main() {
  let config = await loadModelRouterConfig();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: '无效 JSON。' } }); continue; }
    if (!request.id && request.method?.startsWith('notifications/')) continue;
    try {
      switch (request.method) {
        case 'initialize':
          send({ id: request.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'codex-model-delegator', version: '0.2.0' } } });
          break;
        case 'ping':
          send({ id: request.id, result: {} });
          break;
        case 'tools/list':
          config = await loadModelRouterConfig();
          send({ id: request.id, result: { tools: toolDescription(config) } });
          break;
        case 'tools/call': {
          config = await loadModelRouterConfig();
          if (!['delegate_to_model', 'delegate_to_agent', 'delegate_to_dsh'].includes(request.params?.name)) throw new Error('未知工具。');
          const args = request.params.arguments || {};
          let result;
          if (request.params.name === 'delegate_to_agent') {
            result = await delegateToAgent({ config, model: args.model, task: args.task, system: args.system, mode: args.mode || 'review', cwd: args.cwd, sessionId: args.session_id, effort: args.effort });
          } else if (request.params.name === 'delegate_to_dsh') {
            const dshModel = args.model || listConfiguredModels(config).find(item => item.execution === 'dsh-cli')?.alias;
            if (!dshModel) throw new Error('没有配置 DSH 子代理模型。');
            result = await delegateToAgent({ config, model: dshModel, task: args.task, system: args.system, mode: args.mode || 'review', cwd: args.cwd });
          } else {
            result = await delegateToModel({ config, model: args.model, task: args.task, system: args.system, maxOutputTokens: args.max_output_tokens });
          }
          send({ id: request.id, result: { content: [{ type: 'text', text: result.text }], structuredContent: { model: result.rawModel, usage: result.usage, ...(result.sessionId ? { session_id: result.sessionId, run_id: result.runId, proof_directory: result.proofDirectory, tool_uses: result.toolUses, permission_denials: result.permissionDenials } : {}) } } });
          break;
        }
        default:
          send({ id: request.id, error: { code: -32601, message: `未知方法：${request.method}` } });
      }
    } catch (error) {
      if (request.id !== undefined) send({ id: request.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } });
    }
  }
}

main().catch(error => { process.stderr.write(`delegate-mcp: ${error.message}\n`); process.exitCode = 1; });
