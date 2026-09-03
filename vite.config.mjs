import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// サウンドボード本体 (index.html) とリモコン (remote/index.html) のマルチページビルド。
// /remote/ は Cloudflare Workers Assets の html_handling (auto-trailing-slash) で配信される。
export default defineConfig({
    appType: 'mpa',
    build: {
        rollupOptions: {
            input: {
                main: fileURLToPath(new URL('./index.html', import.meta.url)),
                remote: fileURLToPath(new URL('./remote/index.html', import.meta.url)),
            },
        },
    },
});
