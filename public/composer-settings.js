export const effortLabels = { none:'无', minimal:'最少', low:'低', medium:'中', high:'高', xhigh:'极高', max:'Max', ultra:'Ultra' };

export function sessionChoices(session = {}, choices = {}) {
  const currentModel = session.nativeModel || session.model || '';
  const inherited = !choices.model || choices.model === currentModel;
  const currentEffort = session.nativeModel ? session.nativeEffort : session.effort;
  return { ...choices, model:choices.model || currentModel,
    effort:choices.effort || (inherited && currentEffort) || '',
    permission:choices.permission ?? (session.executionOwner === 'desktop' ? '' : session.permission ?? '') };
}

export function effectiveSettings(catalog = {}, session = {}, choices = {}, {nativeFast=false} = {}) {
  const models = catalog.models || [];
  const selected = sessionChoices(session, choices);
  const model = models.find(item => item.model === (selected.model || catalog.defaultModel)) || (selected.model ? undefined : models.find(item => item.isDefault) || models[0]);
  const efforts = model?.supportedReasoningEfforts || [];
  const desired = selected.effort || model?.defaultReasoningEffort || catalog.defaultEffort;
  const effortIndex = Math.max(0, efforts.findIndex(item => item.reasoningEffort === desired));
  const effort = efforts[effortIndex]?.reasoningEffort;
  const permission = choices.permission || session.nativePermission || (session.executionOwner === 'desktop' ? undefined : session.permission || catalog.defaultPermission);
  const permissionPending=Boolean(session.executionOwner==='desktop' && choices.permission && choices.permission!==session.nativePermission);
  const fastTier=model?.serviceTiers?.find(tier=>tier.name?.toLowerCase() === 'fast' || ['fast','priority'].includes(tier.id));
  const desktopOwned=session.executionOwner === 'desktop' || session.source === 'imported' && session.executionOwner !== 'runner';
  const fastReadOnly=desktopOwned && !nativeFast;
  const nativeTier=session.nativeServiceTier || 'default';
  const serviceTier=desktopOwned ? (!fastReadOnly ? choices.serviceTier ?? nativeTier : nativeTier) : choices.serviceTier ?? session.serviceTier ?? session.nativeServiceTier ?? catalog.defaultServiceTier ?? model?.defaultServiceTier ?? 'default';
  const fastPending=Boolean(desktopOwned && !fastReadOnly && choices.serviceTier && choices.serviceTier!==nativeTier);
  return { model, efforts, effort, effortIndex, permission, permissionPending, fastTier, serviceTier, fast: Boolean(fastTier && ['priority','fast'].includes(serviceTier)),
    fastAvailable:Boolean(fastTier && catalog.fastModeEnabled !== false), fastReadOnly, fastPending,
    permissionLabel:catalog.permissions?.find(item => item.id === permission)?.label || '沿用当前权限' };
}

export function projectsForDevice(projects, deviceId) {
  return projects.filter(project => project.deviceId === deviceId && !project.hidden);
}
