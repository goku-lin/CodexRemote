import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(pluginRoot, '..', '..');
process.env.MODEL_DELEGATE_CONFIG ||= path.join(projectRoot, '.relay-data', 'model-providers.json');
process.env.MODEL_DELEGATE_DEFAULT_CWD ||= projectRoot;
await import('../../src/delegate-mcp.mjs');
