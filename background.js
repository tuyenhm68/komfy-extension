/**
 * Komfy Bridge Extension - Entry Point (v2.1.2 Modular)
 *
 * Modules:
 *   session.js            - Shared state, constants, proxy heartbeat
 *   tab-manager.js        - Flow tab management
 *   project-manager.js    - Project creation & renaming
 *   video-gen-settings.js - Settings popover automation (B0.1–B0.8)
 *   video-gen-frames.js   - I2V frame selection helpers
 *   video-gen-poll.js     - Post-submit polling (progress, error, result)
 *   video-gen.js          - Video generation orchestrator
 *   image-gen.js          - Image generation (CDP) + image upload
 *   download.js           - Media download & direct API
 *   polling.js            - Task polling & token capture
 */

importScripts(
    'modules/session.js',
    'modules/tab-manager.js',
    'modules/project-manager.js',
    'modules/video-gen-settings.js',
    'modules/video-gen-frames.js',
    'modules/video-gen-poll.js',
    'modules/video-gen.js',
    'modules/image-gen.js',
    'modules/download.js',
    'modules/polling.js'
);

// ── Initialization ──
chrome.storage.local.get(['komfyClientId', 'komfyProjectId'], (res) => {
    if (res.komfyClientId) {
        sessionData.clientId = res.komfyClientId;
    } else {
        sessionData.clientId = 'ext_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
        chrome.storage.local.set({ komfyClientId: sessionData.clientId });
    }
    if (res.komfyProjectId) {
        sessionData.projectId = res.komfyProjectId;
        console.log('[Komfy] Restored cached projectId:', res.komfyProjectId.substring(0, 16) + '...');
    }
    sendToProxy().catch(() => {});
    setInterval(() => { sendToProxy().catch(() => {}); }, 5000);
});

// ── Auto-inject content scripts ──
async function injectContentScriptsIntoFlowTabs() {
    try {
        const tabs = await chrome.tabs.query({});
        const flowTabs = tabs.filter(t => t.url && t.url.includes('labs.google'));
        for (const tab of flowTabs) {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_main.js'], world: 'MAIN' }).catch(e => console.warn('[Komfy] MAIN:', e.message));
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(e => console.warn('[Komfy] ISOLATED:', e.message));
        }
    } catch (e) {
        console.warn('[Komfy] Auto-inject error:', e.message);
    }
}
setTimeout(injectContentScriptsIntoFlowTabs, 1000);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && tab.url.includes('labs.google')) {
        setTimeout(async () => {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});
        }, 2000);
    }
});

// ── Start polling ──
pollForApiRequests();

console.log('[Komfy Bridge] v' + EXTENSION_VERSION + ' loaded (modular)');
