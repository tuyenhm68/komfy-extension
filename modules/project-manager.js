// Project management — Extension Shell
// ★ Core IP (createProject, updateProject) runs in Electron via /api/internal/flow-action
// Extension only handles: tab navigation (Chrome APIs) + UI fallback

const FLOW_ACTION_URL = 'http://127.0.0.1:3120/api/internal/flow-action';

/**
 * Helper: Delegate một action sang Electron FlowBroker.
 * Electron sẽ dùng bearer token đã lưu để gọi trực tiếp Google API.
 */
async function callFlowAction(action, params) {
    const cfg = await loadFlowConfig();
    const res = await fetch(FLOW_ACTION_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, config: cfg, params })
    }).catch(e => ({ ok: false, _fetchError: e.message }));

    if (res._fetchError) {
        return { ok: false, error: 'Electron not running: ' + res._fetchError };
    }
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${txt.substring(0, 200)}` };
    }
    return res.json().catch(() => ({ ok: false, error: 'Invalid JSON response' }));
}

/**
 * Tao project moi tren Google Flow va dat ten.
 * STRATEGY:
 *   Fast Path: Electron tạo project qua tRPC (core IP bảo vệ) → navigate → Electron rename
 *   Fallback : Click nut "New Project" → cho navigate → Electron rename
 *
 * @param {number} tabId - Tab ID dang o trang home Flow
 * @param {string} projectName - Ten project can dat (vd: "[KS] Komfy Studio")
 */
async function createAndRenameProject(tabId, projectName) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // === FAST PATH: Electron tạo project (core IP nằm trong ASAR) ===
    console.log('[Komfy] Delegate createProject → Electron FlowBroker...');
    const createResult = await callFlowAction('createProject', {});

    if (createResult?.ok && createResult?.projectId) {
        const projectId = createResult.projectId;
        console.log('[Komfy] ✅ Electron tao project thanh cong:', projectId);

        // Navigate tab → Extension vẫn giữ phần Chrome API (không thể di chuyển)
        const newUrl = 'https://labs.google/fx/tools/flow/project/' + projectId;
        await chrome.tabs.update(tabId, { url: newUrl });
        await waitForTabLoad(tabId, 15000).catch(() => {});
        await sleep(2000);

        // Electron rename (core IP bảo vệ)
        const renameResult = await callFlowAction('updateProject', { projectId, projectTitle: projectName });
        if (renameResult?.ok) {
            console.log('[Komfy] ✅ Electron doi ten project thanh cong');
        } else {
            console.warn('[Komfy] ⚠️ Electron rename that bai:', renameResult?.error);
        }

        // Cache
        await chrome.storage.local.set({ komfySingleProjectId: projectId });
        sessionData.projectId = projectId;
        console.log('[Komfy] ✅ Cached komfySingleProjectId:', projectId.substring(0, 16) + '...');
        return; // Done
    }

    console.warn('[Komfy] ⚠️ Electron createProject that bai:', createResult?.error, '→ fallback UI Click');

    // === FALLBACK: Click nut "New Project" tren home page ===
    const cfg = await loadFlowConfig();
    await humanDelay(1000, 2500);
    console.log('[Komfy] Tim nut "Du an moi" / "New project"...');
    const clickResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selectorCfg) => {
            const keywords = selectorCfg.keywords || ['du an moi', 'new project', 'tao du an', 'create project'];
            const maxLen = selectorCfg.maxTextLength || 40;
            const candidates = [...document.querySelectorAll('button, a, [role="button"], [tabindex]')];

            // Strategy 1: textContent
            for (const el of candidates) {
                const text = (el.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
                if (text.length > 0 && text.length < maxLen) {
                    for (const kw of keywords) {
                        if (text.includes(kw)) {
                            el.click();
                            return { clicked: true, text: el.textContent.trim().substring(0, 50), strategy: 'text' };
                        }
                    }
                }
            }

            // Strategy 2: aria-label
            for (const el of candidates) {
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                if (label.length > 0 && label.length < maxLen) {
                    for (const kw of keywords) {
                        if (label.includes(kw)) {
                            el.click();
                            return { clicked: true, text: label, strategy: 'aria-label' };
                        }
                    }
                }
            }

            // Strategy 3: any small element
            for (const el of [...document.querySelectorAll('*')]) {
                const text = (el.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.width < 300 && r.height > 20 && r.height < 100 && text.length > 0 && text.length < maxLen) {
                    for (const kw of keywords) {
                        if (text.includes(kw)) {
                            el.click();
                            return { clicked: true, text: el.textContent.trim().substring(0, 50), strategy: 'any-element', tag: el.tagName };
                        }
                    }
                }
            }

            const debugBtns = candidates.slice(0, 15).map(b => ({
                tag: b.tagName,
                text: (b.textContent || '').trim().substring(0, 40),
                label: b.getAttribute('aria-label'),
            }));
            return { clicked: false, debug: debugBtns };
        },
        args: [cfg.selectors.newProject]
    }).catch(e => [{ result: { clicked: false, error: e.message } }]);

    const wasClicked = clickResult?.[0]?.result?.clicked;
    if (!wasClicked) {
        const debugInfo = clickResult?.[0]?.result?.debug || clickResult?.[0]?.result?.error || 'no debug info';
        console.error('[Komfy] ⚠ Khong tim thay nut tao project! Debug:', JSON.stringify(debugInfo));
        throw new Error('Khong tim thay nut "Du an moi" / "New project" tren trang Flow. Vui long tao project thu cong.');
    }
    console.log('[Komfy] Da click nut tao project moi:', clickResult[0].result.text, '(strategy:', clickResult[0].result.strategy + ')');

    await waitForTabLoad(tabId, 20000).catch(e => console.warn('[Komfy]', e.message));
    await sleep(3000);
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});

    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    const currentUrl = currentTab?.url || '';
    if (!currentUrl.includes('/project/')) {
        console.warn('[Komfy] ⚠ Khong navigate duoc toi project page. URL:', currentUrl);
        throw new Error('Khong tao duoc project moi. Vui long thu lai.');
    }
    console.log('[Komfy] Project moi da tao, URL:', currentUrl);

    // Rename qua Electron (fallback path vẫn dùng Electron để rename)
    const newProjectIdMatch = currentUrl.match(/\/project\/([a-zA-Z0-9_-]+)/);
    const newProjectId = newProjectIdMatch ? newProjectIdMatch[1] : null;
    if (newProjectId) {
        const renameResult = await callFlowAction('updateProject', { projectId: newProjectId, projectTitle: projectName });
        if (renameResult?.ok) {
            console.log('[Komfy] ✅ Electron doi ten project (fallback) thanh cong');
        } else {
            console.warn('[Komfy] ⚠️ Electron rename (fallback) that bai:', renameResult?.error);
        }
        sessionData.projectId = newProjectId;
        await chrome.storage.local.set({ komfySingleProjectId: newProjectId });
        console.log('[Komfy] ✅ Cached komfySingleProjectId:', newProjectId.substring(0, 16) + '...');
    }
}

/**
 * Rename một project qua Electron FlowBroker (thin wrapper, logic ở Electron).
 * @param {string} newName   - New project name
 * @param {string} projectId - Project UUID
 */
async function renameProjectOnFlow(newName, projectId) {
    console.log('[Komfy] Delegate updateProject → Electron FlowBroker...');
    const result = await callFlowAction('updateProject', { projectId, projectTitle: newName });
    if (result?.ok) {
        console.log('[Komfy] ✅ Project renamed via Electron');
    } else {
        console.warn('[Komfy] ⚠️ Electron rename that bai:', result?.error);
    }
}
