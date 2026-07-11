// modules/02_dom.js

// このオブジェクトに全てのDOM要素への参照を保持します
export const dom = {};

/**
 * HTMLからDOM要素を取得し、domオブジェクトに格納します。
 * キー名とIDを明示的にマッピングすることで、HTMLの変更に強くします。
 */
export function initDom() {
    const elementMap = {
        // --- JS側で使うキー名 : HTMLのid属性 ---
        soundboard: 'soundboard',
        addSoundBtn: 'add-sound-btn',
        stopAllBtn: 'stop-all-btn',
        fileInput: 'file-input',
        importFileInput: 'import-file-input',
        masterVolumeSlider: 'master-volume', // ★★★ HTMLのid="master-volume"に対応するよう修正
        masterVolumeValue: 'master-volume-value',
        sceneSettingsBtn: 'scene-settings-btn',
        sceneSettingsModal: 'scene-settings-modal',
        modalCloseBtn: 'modal-close-btn',
        modalSceneList: 'modal-scene-list',
        modalAddSceneBtn: 'modal-add-scene-btn',
        modalImportBtn: 'modal-import-btn',
        modalExportBtn: 'modal-export-btn',
        popupToggleCheckbox: 'popup-toggle-checkbox',
        interactionClickRadio: 'interaction-click',
        interactionDragRadio: 'interaction-drag',
        waveformToggleCheckbox: 'waveform-toggle-checkbox',
        padSizeSlider: 'pad-size-slider',
        padSizeValue: 'pad-size-value',
        masterEffectBar: 'master-effect-bar',
        levelMeterArea: 'level-meter-area',
        waveformDisplayArea: 'waveform-display-area',
        waveformCanvas: 'waveform-canvas',
        // カスタムモーダル要素
        customModalOverlay: 'custom-modal-overlay',
        customModalContent: 'custom-modal-content',
        customModalTitle: 'custom-modal-title',
        customModalMessage: 'custom-modal-message',
        customModalBody: 'custom-modal-body',
        customModalOkBtn: 'custom-modal-ok-btn',
        customModalCancelBtn: 'custom-modal-cancel-btn',
        perfHighRadio: 'perf-high',
        perfLowRadio: 'perf-low'
    };

    for (const key in elementMap) {
        dom[key] = document.getElementById(elementMap[key]);
    }
    
    // 個別の要素もdomオブジェクトに直接追加
    dom.darkModeToggle = document.getElementById('dark-mode-toggle');
    
    // Canvasのコンテキストは特別に取得します
    dom.waveformCtx = dom.waveformCanvas ? dom.waveformCanvas.getContext('2d') : null;
}

/**
 * アプリケーションの動作に必須な要素が取得できているか確認します。
 * @returns {boolean} - 全ての必須要素が見つかった場合はtrue
 */
export function checkElements() {
    let missingElements = false;
    // 必須要素のキーリスト（キー名は変更しない）
    const essentialElements = [
        'soundboard', 'addSoundBtn', 'fileInput', 'masterVolumeSlider', 'sceneSettingsBtn'
    ];
    
    for (const key of essentialElements) {
        if (!dom[key]) {
            console.error(`Init Error: Essential element '${key}' not found.`);
            missingElements = true;
        }
    }

    // デバッグ用に、必須ではないが見つからない要素も警告としてログに出力します
    for (const key in dom) {
        // domオブジェクトのプロパティで、かつ値がnullまたはundefinedのもの
        if (Object.prototype.hasOwnProperty.call(dom, key) && !dom[key]) {
             console.warn(`Element for key '${key}' might be missing.`);
        }
    }

    return !missingElements;
}
