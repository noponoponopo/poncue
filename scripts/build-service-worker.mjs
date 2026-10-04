import { createHash } from 'node:crypto';
import { copyFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');
// Preserve /favicon.svg for the manifest.
copyFileSync(join(root, 'favicon.svg'), join(dist, 'favicon.svg'));
const files = readdirSync(dist, { recursive: true })
    // Cloudflare consumes _redirects as configuration; it is not a fetchable asset.
    .filter(path => !['service-worker.js', '_redirects'].includes(path) && statSync(join(dist, path)).isFile())
    .sort();
const assets = files.map(path => `  './${path.replaceAll('\\', '/')}',`);

const source = readFileSync(join(root, 'service-worker.js'), 'utf8');
const marker = '  // @poncue-build-assets';
if (!source.includes(marker)) throw new Error(`Missing ${marker} in service-worker.js`);
const hash = createHash('sha256').update(source);
for (const path of files) {
    hash.update(path).update('\0').update(readFileSync(join(dist, path)));
}
const fingerprint = hash.digest('hex').slice(0, 12);
const versioned = source.replace(
    /const VERSION = '([^']+)';/,
    (_, baseVersion) => `const VERSION = '${baseVersion}-${fingerprint}';`
);
const built = versioned.replace(marker, assets.join('\n'));
writeFileSync(join(dist, 'service-worker.js'), built);
