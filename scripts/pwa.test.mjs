import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('PWA installation uses root URLs and keeps the legacy launch redirect', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest\.json"\s*\/>/);
    const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.json'), 'utf8'));
    assert.equal(manifest.id, '/');
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    const redirects = readFileSync(join(root, 'public/_redirects'), 'utf8');
    assert.match(redirects, /^\/assets\/index\.html\s+\/\s+302\s*$/m);
});

test('service worker precaches app files but not Cloudflare redirect configuration', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'poncue-pwa-'));
    try {
        mkdirSync(join(fixture, 'dist'));
        for (const path of ['service-worker.js', 'favicon.svg']) {
            copyFileSync(join(root, path), join(fixture, path));
        }
        for (const [source, target] of [
            ['index.html', 'index.html'],
            ['public/manifest.json', 'manifest.json'],
            ['public/_redirects', '_redirects'],
        ]) {
            copyFileSync(join(root, source), join(fixture, 'dist', target));
        }
        execFileSync(process.execPath, [join(root, 'scripts/build-service-worker.mjs')], { cwd: fixture });
        const worker = readFileSync(join(fixture, 'dist/service-worker.js'), 'utf8');
        assert.match(worker, /'\.\/index\.html',/);
        assert.match(worker, /'\.\/manifest\.json',/);
        assert.match(worker, /'\.\/favicon\.svg',/);
        assert.doesNotMatch(worker, /'\.\/_redirects',/);
        assert.doesNotMatch(worker, /'\.\/service-worker\.js',/);
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});
