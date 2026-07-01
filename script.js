// main.js - Application Entry Point

import { initDom, checkElements } from './modules/02_dom.js';
import { initializeApp, disableAppControls, renderFallbackUI } from './modules/07_scenes.js';
import { setupEventListeners } from './modules/08_handlers.js';

// --- MAIN EXECUTION ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOMContentLoaded fired. Initializing app v3.7.4 (Fix loop toggle) - Modularized");

    // 1. Register service worker (skip in Vite dev to avoid stale cache)
    if ('serviceWorker' in navigator && !import.meta.env?.DEV) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('service-worker.js')
                .then(registration => {
                    console.log('ServiceWorker registration successful with scope: ', registration.scope);
                })
                .catch(err => {
                    console.log('ServiceWorker registration failed: ', err);
                });
        });
    } else if ('serviceWorker' in navigator) {
        // Dev mode: unregister any existing service worker to prevent stale cache
        navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
    }

    // 2. Initialize DOM elements
    initDom();
    if (!checkElements()) {
        if (document.body) {
            const msg = document.createElement('p');
            msg.textContent = "HTML要素読込失敗。再読込してください。";
            msg.style.color = 'red';
            msg.style.padding = '20px';
            msg.style.textAlign = 'center';
            document.body.prepend(msg);
        }
        return; // Stop execution if essential elements are missing
    }
    console.log("All required HTML elements found.");


    // 3. Initialize the application
    initializeApp().then(() => {
        // 4. Setup event listeners after successful initialization
        setupEventListeners();
        console.log("Application initialized and ready.");
    }).catch(error => {
        console.error("--- Unhandled Application Initialization Error ---", error);
        renderFallbackUI(`アプリケーションの起動に失敗しました。ページを再読み込みしてください。(${error.message})`);
        disableAppControls();
    });
    
    console.log("Initial script execution finished. App initialization started...");
});