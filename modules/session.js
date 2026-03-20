/**
 * Session management: shared state, constants, proxy heartbeat.
 * All variables and functions are in service worker global scope.
 */

// â”€â”€ Shared session state â”€â”€
let sessionData = {
    bearerToken: null,
    xbv: null,
    projectId: null,
    clientId: null,
    lastSync: 0,
    syncError: null
};

// â”€â”€ Constants â”€â”€
const PROXY_URL = 'http://127.0.0.1:3120/api/internal/update-session';
const PROXY_EXECUTE_URL = 'http://127.0.0.1:3120/api/internal/execute-request';
const FLOW_URL = 'https://labs.google/fx/tools/flow';
const KOMFY_PROJECT_NAME = 'komfy-studio';
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// UI callbacks map (used by polling and content scripts)
const uiCallbacks = new Map();

/**
 * Send session heartbeat to FlowBroker proxy.
 * Auto-recovers if token is lost (service worker restart).
 */
let _lastAutoRecovery = 0;
async function sendToProxy() {
    if (!sessionData.clientId) return;

    // Try restore token from storage if lost
    if (!sessionData.bearerToken) {
        try {
            const stored = await chrome.storage.session.get(['komfyBearerToken', 'komfyXbv', 'komfyProjectId', 'komfyXClientData', 'komfyGoogExts']);
            if (stored.komfyBearerToken) {
                sessionData.bearerToken = stored.komfyBearerToken;
                sessionData.xbv = stored.komfyXbv || null;
                sessionData.projectId = stored.komfyProjectId || null;
                sessionData.xClientData = stored.komfyXClientData || null;
                sessionData.googExts = stored.komfyGoogExts || {};
                console.log('[Komfy] Restored token from session storage');
            }
        } catch(e) {}
    }

    try {
        const payload = Object.assign({}, sessionData, { version: EXTENSION_VERSION });
        const res = await fetch(PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        sessionData.lastSync = Date.now();
        sessionData.syncError = null;

        // Auto-recovery: if heartbeat ok but no token, reload Flow tab (cooldown 60s)
        if (!sessionData.bearerToken && Date.now() - _lastAutoRecovery > 60000) {
            _lastAutoRecovery = Date.now();
            console.log('[Komfy] No token after proxy sync â†’ auto-recovering via ensureFlowTab...');
            if (typeof ensureFlowTab === 'function') {
                ensureFlowTab(false).catch(e => console.warn('[Komfy] Auto-recovery failed:', e.message));
            }
        }
    } catch (e) {
        sessionData.syncError = e.message;
    }
}

/**
 * Persist token to session storage (survives service worker restart).
 */
function persistToken() {
    if (sessionData.bearerToken) {
        chrome.storage.session.set({
            komfyBearerToken: sessionData.bearerToken,
            komfyXbv: sessionData.xbv || '',
            komfyProjectId: sessionData.projectId || '',
            komfyXClientData: sessionData.xClientData || '',
            komfyGoogExts: sessionData.googExts || {}
        }).catch(() => {});
    }
}


