export const permissionModes = [
  { id: 'read-only', label: '只读', approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } },
  { id: 'workspace-write', label: '工作区访问', approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false } },
  { id: 'danger-full-access', label: '完全访问', approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
];

export function availablePermissions(requirements) {
  return permissionModes.filter(mode => (!requirements?.allowedSandboxModes || requirements.allowedSandboxModes.includes(mode.sandbox))
    && (!requirements?.allowedApprovalPolicies || requirements.allowedApprovalPolicies.includes(mode.approvalPolicy)));
}

export function validateOptions(body, catalog = {}) {
  const result = {};
  if (body.model) {
    const model = catalog.models?.find(item => item.model === body.model || item.id === body.model);
    if (!model) throw new Error('该设备没有提供这个模型，请刷新模型列表。');
    result.model = model.model || model.id;
    if (body.effort) {
      if (!model.supportedReasoningEfforts?.some(item => item.reasoningEffort === body.effort)) throw new Error('该模型不支持这个推理强度。');
      result.effort = body.effort;
    }
  } else if (body.effort) throw new Error('请先选择模型，再选择推理强度。');
  if (body.serviceTier) {
    const model=catalog.models?.find(item=>(item.model || item.id) === result.model);
    if (body.serviceTier !== 'default' && (!model?.serviceTiers?.some(tier=>tier.id === body.serviceTier) || catalog.fastModeEnabled === false)) throw new Error('该模型或设备不支持这个 Fast 档位。');
    result.serviceTier=body.serviceTier;
  }
  if (body.permission) {
    if (!availablePermissions(catalog.requirements).some(item => item.id === body.permission)) throw new Error('该设备不允许使用这个权限。');
    result.permission = body.permission;
  }
  return result;
}

export function threadOptions(command) {
  const options = {};
  if (command.model) options.model = command.model;
  if (command.serviceTier) options.serviceTier = command.serviceTier === 'default' ? null : command.serviceTier;
  const permission = permissionModes.find(item => item.id === command.permission);
  if (permission) Object.assign(options, { approvalPolicy: permission.approvalPolicy, sandbox: permission.sandbox });
  return options;
}

export function turnOptions(command) {
  const options = {};
  if (command.model) options.model = command.model;
  if (command.effort) options.effort = command.effort;
  if (command.serviceTier) options.serviceTier = command.serviceTier === 'default' ? null : command.serviceTier;
  if (command.cwd) options.cwd = command.cwd;
  const permission = permissionModes.find(item => item.id === command.permission);
  if (permission) Object.assign(options, { approvalPolicy: permission.approvalPolicy, sandboxPolicy: { ...permission.sandboxPolicy,
    ...(permission.id === 'workspace-write' && command.cwd ? { writableRoots: [command.cwd] } : {}) } });
  return options;
}
