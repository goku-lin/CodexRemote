import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Published connectors flatten src into app; both layouts share the same state paths.
export const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.basename(sourceDir) === 'src' ? path.dirname(sourceDir) : sourceDir;
export const scriptsDir = sourceDir === projectRoot ? projectRoot : path.join(projectRoot, 'scripts');
