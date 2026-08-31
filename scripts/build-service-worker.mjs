import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const distAssets = join(root, 'dist', 'assets');
const assets = readdirSync(distAssets, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => `  './assets/${entry.name}',`)
    .sort();

const source = readFileSync(join(root, 'service-worker.js'), 'utf8');
const marker = '  // @poncue-build-assets';
if (!source.includes(marker)) throw new Error(`Missing ${marker} in service-worker.js`);
const fingerprint = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 12);
const versioned = source.replace(
    /const VERSION = '([^']+)';/,
    (_, baseVersion) => `const VERSION = '${baseVersion}-${fingerprint}';`
);
const built = versioned.replace(marker, assets.join('\n'));
writeFileSync(join(root, 'dist', 'service-worker.js'), built);
