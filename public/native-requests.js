// Responses are scoped to the original server request, never sent as chat text.
export const requestKey = id => `${typeof id}:${String(id)}`;
export const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request']);
export const nativeRequestMethods = new Set([...approvalMethods, 'item/tool/requestUserInput']);
const decisions = ['accept', 'acceptForSession', 'decline', 'cancel'];

export function approvalChoices(request) {
  if (request.method === 'mcpServer/elicitation/request') return ['accept', 'decline', 'cancel'];
  const available = request.params?.availableDecisions;
  return decisions.filter(decision => !Array.isArray(available) || available.includes(decision));
}

function validateForm(value, schema, depth = 0) {
  if (!schema || depth > 10) throw new Error('此表单需要在桌面完成。');
  if (schema.enum && !schema.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) throw new Error('请选择表单提供的选项。');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请输入 JSON 对象。');
    for (const name of schema.required || []) if (!Object.hasOwn(value, name)) throw new Error(`请填写 ${name}。`);
    for (const [name, field] of Object.entries(value)) {
      if (!schema.properties?.[name]) throw new Error(`未知字段：${name}`);
      validateForm(field, schema.properties[name], depth + 1);
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > Math.min(schema.maxLength ?? 10000, 10000)) throw new Error('表单文本长度不符合要求。');
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('此字段须为 true 或 false。');
  } else if (['number', 'integer'].includes(schema.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) throw new Error('表单数字不符合要求。');
  } else throw new Error('此表单字段需要在桌面完成。');
}

export function approvalResult(request, decision, content) {
  if (!approvalChoices(request).includes(decision)) throw new Error('不支持这个审批选项。');
  if (request.method === 'item/permissions/requestApproval') return {
    permissions: ['accept', 'acceptForSession'].includes(decision) ? request.params.permissions : {},
    scope: decision === 'acceptForSession' ? 'session' : 'turn'
  };
  if (request.method === 'mcpServer/elicitation/request') {
    if (decision !== 'accept') return { action: decision };
    if (request.params.mode === 'url') return { action: decision };
    validateForm(content, request.params.requestedSchema);
    return { action: decision, content };
  }
  return { decision };
}

export function validateNativeResponse(request, result) {
  if (!result || typeof result !== 'object') throw new Error('回答格式无效。');
  if (request.method === 'item/tool/requestUserInput') {
    const questions = request.params.questions || [];
    if (!result.answers || Object.keys(result).some(key => key !== 'answers')) throw new Error('回答格式无效。');
    const expected = new Set(questions.map(question => question.id));
    if (Object.keys(result.answers).some(id => !expected.has(id))) throw new Error('回答包含未知问题。');
    for (const question of questions) {
      const values = result.answers[question.id]?.answers;
      if (!Array.isArray(values) || !values.length || values.length > 10 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 10000)) throw new Error('请回答所有问题。');
    }
    return;
  }
  if (request.method === 'item/permissions/requestApproval') {
    if (!['turn', 'session'].includes(result.scope) || (JSON.stringify(result.permissions) !== '{}' && JSON.stringify(result.permissions) !== JSON.stringify(request.params.permissions))) throw new Error('只能批准本次请求列出的权限。');
    if (Object.keys(result).some(key => !['permissions', 'scope'].includes(key))) throw new Error('权限回答格式无效。');
    return;
  }
  if (request.method === 'mcpServer/elicitation/request') {
    approvalResult(request, result.action, result.content);
    if (Object.keys(result).some(key => !['action', 'content'].includes(key))) throw new Error('表单回答格式无效。');
    return;
  }
  if (!approvalMethods.has(request.method) || Object.keys(result).some(key => key !== 'decision') || !approvalChoices(request).includes(result.decision)) throw new Error('审批回答格式无效。');
}
