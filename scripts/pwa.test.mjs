import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));

function loadServiceWorker(t, entries = {}) {
    const origin = 'https://poncue.test/';
    const key = request => new URL(request.url || request, origin).href;
    const stored = new Map(Object.entries(entries).map(([url, response]) => [key(url), response]));
    const cache = {
        addAll: t.mock.fn(async () => {}),
        match: t.mock.fn(async (request, { ignoreSearch = false } = {}) => {
            const url = new URL(key(request));
            if (ignoreSearch) url.search = '';
            return stored.get(url.href);
        }),
        put: t.mock.fn(async (request, response) => stored.set(key(request), response)),
    };
    const listeners = {};
    const fetch = t.mock.fn(async () => { throw new Error('offline'); });
    const skipWaiting = t.mock.fn();
    runInNewContext(readFileSync(join(root, 'service-worker.js'), 'utf8'), {
        URL, Response,
        Request: class extends Request {
            constructor(url, options) { super(new URL(url, origin), options); }
        },
        caches: { open: async () => cache },
        fetch,
        self: {
            location: { origin: new URL(origin).origin },
            addEventListener: (name, listener) => { listeners[name] = listener; },
            skipWaiting,
        },
    });
    return {
        cache, fetch, skipWaiting, listeners,
        request(path, mode = 'navigate') {
            let response;
            listeners.fetch({
                request: { url: key(path), method: 'GET', mode },
                respondWith: promise => { response = promise; },
            });
            return response;
        },
    };
}

test('cached PWA pages do not wait for the network during reconnection', async t => {
    const main = new Response('main');
    const remote = new Response('remote');
    const worker = loadServiceWorker(t, { '/': main, '/remote/': remote });
    worker.fetch.mock.mockImplementation(() => new Promise(() => {}));

    for (const [path, expected] of [
        ['/', main],
        ['/?launch=pwa', main],
        ['/index.html', main],
        ['/assets/index.html', main],
        ['/remote', remote],
        ['/remote/?room=ABC', remote],
        ['/remote/index.html', remote],
    ]) {
        const response = worker.request(path);
        await new Promise(setImmediate);
        assert.equal(worker.fetch.mock.callCount(), 0, path);
        assert.equal(await response, expected, path);
    }
});

test('navigation ignores search parameters but asset cache keys retain them', async t => {
    const document = new Response('document');
    const worker = loadServiceWorker(t, { '/index.html': document, '/asset.js': new Response('asset') });
    assert.equal(await worker.request('/index.html?launch=pwa'), document);
    assert.equal(worker.fetch.mock.callCount(), 0);
    assert.equal((await worker.request('/asset.js?v=2', 'cors')).type, 'error');
    assert.equal(worker.fetch.mock.callCount(), 1);
});

test('uncached pages still use the network and cache successful responses', async t => {
    const worker = loadServiceWorker(t);
    const response = new Response('new page');
    Object.defineProperty(response, 'type', { value: 'basic' });
    worker.fetch.mock.mockImplementation(async () => response);
    assert.equal(await worker.request('/'), response);
    assert.equal(worker.fetch.mock.callCount(), 1);
    assert.equal(worker.cache.put.mock.callCount(), 1);
    assert.equal(await (await worker.cache.match('/')).text(), 'new page');
});

test('uncached offline navigation returns a network error', async t => {
    const worker = loadServiceWorker(t);
    assert.equal((await worker.request('/')).type, 'error');
});

test('installing an update does not force activation over an open app', async t => {
    const worker = loadServiceWorker(t);
    let installation;
    worker.listeners.install({ waitUntil: promise => { installation = promise; } });
    await installation;
    assert.equal(worker.cache.addAll.mock.callCount(), 1);
    assert.equal(worker.skipWaiting.mock.callCount(), 0);
});

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
