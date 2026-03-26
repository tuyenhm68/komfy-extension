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
const KOMFY_PROJECT_PREFIX = '[KS] ';
const KOMFY_PROJECT_NAME = 'komfy-studio'; // legacy fallback

// All workflows share a single fixed Flow project.
// Eliminates per-workflow project creation, scan, and rename (the main source of errors).
const KOMFY_FIXED_PROJECT = '[KS] Komfy Studio';

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

// ── Human-like delay helpers (anti-bot detection) ──

/**
 * Random delay between minMs and maxMs (uniform distribution).
 * Simulates human reaction time / thinking pause.
 */
function humanDelay(minMs, maxMs) {
    const ms = minMs + Math.random() * (maxMs - minMs);
    return new Promise(r => setTimeout(r, Math.round(ms)));
}

/**
 * Random delay with slight Gaussian-like distribution (more natural).
 * Uses sum of 2 uniform randoms for bell-curve approximation.
 */
function humanDelayNatural(centerMs, spreadMs) {
    const r1 = Math.random(), r2 = Math.random();
    const gaussian = (r1 + r2) / 2; // 0..1, peaks at 0.5
    const ms = centerMs + (gaussian - 0.5) * 2 * spreadMs;
    return new Promise(r => setTimeout(r, Math.max(100, Math.round(ms))));
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

// -- Project Lock --
// Since all tasks now share a single fixed project (KOMFY_FIXED_PROJECT),
// there is no need to queue tasks of different projects.
// Keep the API signature for compatibility with existing callers.

const _projectLock = {
    activeName: KOMFY_FIXED_PROJECT,
    taskCount: 0,
    waiters: [] // always empty now
};

// In-memory: last time project was verified to exist (for staleness check)
const _projectVerifiedAt = {};

/**
 * Acquire project lock.
 * All tasks share KOMFY_FIXED_PROJECT -> always immediate, no queuing.
 */
function acquireProjectLock(projectName) {
    _projectLock.taskCount++;
    console.log('[Komfy] [ProjectLock] Acquired (fixed project, tasks:', _projectLock.taskCount + ')');
    return Promise.resolve();
}

/**
 * Release project lock after task completes.
 */
function releaseProjectLock(projectName) {
    _projectLock.taskCount = Math.max(0, _projectLock.taskCount - 1);
    console.log('[Komfy] [ProjectLock] Released (remaining:', _projectLock.taskCount + ')');
}


