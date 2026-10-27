export function selectableModels(catalog = {}) {
  const hidden = new Set(catalog.hiddenModels || []);
  return (catalog.models || []).filter(model => !hidden.has(model.model));
}

export function preferredModel(catalog = {}) {
  const models = selectableModels(catalog);
  return models.find(model => model.model === catalog.defaultModel || model.isDefault) || models[0];
}

export function validateHiddenModels(catalog, hidden) {
  if (!Array.isArray(hidden) || hidden.length > 200 || hidden.some(id => typeof id !== 'string' || !(catalog.models || []).some(model => model.model === id))) throw new Error('模型列表已改变，请重新打开模型管理。');
  const unique = [...new Set(hidden)];
  if (!selectableModels({...catalog, hiddenModels:unique}).length) throw new Error('请至少保留一个可选模型。');
  return unique;
}
