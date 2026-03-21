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

// ── Project Lock ──
// Ensures only one project is active at a time.
// Tasks needing a different project WAIT for current tasks to finish.
// Tasks needing the SAME project proceed in parallel.

const _projectLock = {
    activeName: null,   // "[KS] Workflow A" or null
    taskCount: 0,
    waiters: []         // { projectName, resolve, timer }
};

// In-memory: last time each project was verified to exist (for staleness check)
const _projectVerifiedAt = {};

/**
 * Acquire project lock. Returns immediately if same project or no active project.
 * Queues if a different project is active with running tasks (max wait: 5 min).
 * @param {string|null} projectName - null = credential-only (no lock needed)
 */
function acquireProjectLock(projectName) {
    return new Promise((resolve, reject) => {
        if (!projectName) { resolve(); return; }

        if (!_projectLock.activeName || _projectLock.activeName === projectName) {
            _projectLock.activeName = projectName;
            _projectLock.taskCount++;
            console.log('[Komfy] [ProjectLock] Acquired:', projectName, '(tasks:', _projectLock.taskCount + ')');
            resolve();
            return;
        }

        // Different project active → queue
        console.log('[Komfy] [ProjectLock] ⏳ Waiting for "' + _projectLock.activeName + '" (' + _projectLock.taskCount + ' tasks) before "' + projectName + '"');
        const timer = setTimeout(() => {
            _projectLock.waiters = _projectLock.waiters.filter(w => w._id !== waiterId);
            reject(new Error('ProjectLock timeout: waited 5min for "' + _projectLock.activeName + '" to finish'));
        }, 300000); // 5 min timeout

        const waiterId = Date.now() + '_' + Math.random();
        _projectLock.waiters.push({
            _id: waiterId,
            projectName,
            resolve: () => { clearTimeout(timer); resolve(); }
        });
    });
}

/**
 * Release project lock after task completes.
 * When all tasks on current project finish, activates next queued project.
 */
function releaseProjectLock(projectName) {
    if (!projectName) return;
    if (_projectLock.activeName !== projectName) return;

    _projectLock.taskCount = Math.max(0, _projectLock.taskCount - 1);
    console.log('[Komfy] [ProjectLock] Released:', projectName, '(remaining:', _projectLock.taskCount + ')');

    if (_projectLock.taskCount > 0) return;

    // All tasks done — activate next project in queue
    _projectLock.activeName = null;

    if (_projectLock.waiters.length === 0) return;

    // Group: all waiters for the same (first) project proceed together
    const nextProject = _projectLock.waiters[0].projectName;
    const batch = [];
    _projectLock.waiters = _projectLock.waiters.filter(w => {
        if (w.projectName === nextProject) {
            batch.push(w);
            return false;
        }
        return true;
    });

    _projectLock.activeName = nextProject;
    _projectLock.taskCount = batch.length;
    console.log('[Komfy] [ProjectLock] → Switching to "' + nextProject + '" (' + batch.length + ' tasks)');
    batch.forEach(w => w.resolve());
}


