let sessionData = {
    bearerToken: null,
    xbv: null,
    projectId: null,
    clientId: null,
    lastSync: 0,
    syncError: null
};

// Constants can be referenced anywhere
const PROXY_URL = 'http://127.0.0.1:3120/api/internal/update-session';
const PROXY_EXECUTE_URL = 'http://127.0.0.1:3120/api/internal/execute-request';

chrome.storage.local.get(['komfyClientId', 'komfyProjectId'], (res) => {
    if (res.komfyClientId) {
        sessionData.clientId = res.komfyClientId;
    } else {
        sessionData.clientId = 'ext_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
        chrome.storage.local.set({ komfyClientId: sessionData.clientId });
    }
    // Khoi phuc projectId tu cache neu co (de FlowBroker biet project ngay ca khi chua co tab Flow)
    if (res.komfyProjectId) {
        sessionData.projectId = res.komfyProjectId;
        console.log('[Komfy] Restored cached projectId:', res.komfyProjectId.substring(0, 16) + '...');
    }
    // Gui ngay lap tuc, sau do moi 5 giay
    sendToProxy().catch(() => {});
    setInterval(() => { sendToProxy().catch(() => {}); }, 5000);
});

const uiCallbacks = new Map();

async function injectContentScriptsIntoFlowTabs() {
    try {
        const tabs = await chrome.tabs.query({});
        const flowTabs = tabs.filter(t => t.url && t.url.includes('labs.google'));
        for (const tab of flowTabs) {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_main.js'], world: 'MAIN' }).catch(e => console.warn('[Komfy] MAIN inject:', e.message));
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(e => console.warn('[Komfy] ISOLATED inject:', e.message));
            console.log('[Komfy] Scripts injected into tab:', tab.id);
        }
        if (flowTabs.length === 0) console.log('[Komfy] No Flow tabs found.');
    } catch (e) {
        console.warn('[Komfy] Auto-inject error:', e.message);
    }
}

setTimeout(injectContentScriptsIntoFlowTabs, 1000);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && tab.url.includes('labs.google')) {
        setTimeout(async () => {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => { });
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => { });
        }, 2000);
    }
});

const EXTENSION_VERSION = '2.0.0'; // Dong bo voi manifest.json

async function sendToProxy() {
    if (!sessionData.clientId) return;
    // Luon gui heartbeat ke ca khi chua co token (de Studio biet ext dang song)
    try {
        const payload = Object.assign({}, sessionData, { version: EXTENSION_VERSION });
        const res = await fetch(PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        sessionData.lastSync = Date.now();
        sessionData.syncError = null;

        // Check Update tu Electron App
        if (res.ok) {
            const data = await res.json();
            if (data.latestVersion && data.latestVersion !== EXTENSION_VERSION) {
                chrome.action.setBadgeText({ text: 'NEW' });
                chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
                chrome.storage.local.set({
                    extensionUpdateAvailable: true,
                    latestVersion: data.latestVersion,
                    updateUrl: data.updateUrl
                });
            } else {
                // Chua co update - xoa badge (neu co)
                chrome.action.setBadgeText({ text: '' });
            }
        }
    } catch (e) {
        sessionData.syncError = e.message;
    }
}

const FLOW_URL = 'https://labs.google/fx/tools/flow';

async function findFlowTab() {
    const tabs = await chrome.tabs.query({});
    const flowTabs = tabs.filter(t => t.url && t.url.includes('labs.google'));
    if (flowTabs.length === 0) return null;
    // Uu tien project page (co textbox) hon home page
    const projectTab = flowTabs.find(t => t.url.includes('/tools/flow/project/'));
    return projectTab || flowTabs[0];
}

/** Helper: Cho 1 tab load xong (status === 'complete') trong timeout */
function waitForTabLoad(tabId, maxMs = 20000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error(`Tab ${tabId} load qua lau (>${maxMs / 1000}s)`));
        }, maxMs);
        function listener(id, changeInfo) {
            if (id === tabId && changeInfo.status === 'complete') {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }
        chrome.tabs.onUpdated.addListener(listener);
    });
}

/**
 * Constant: Ten project danh rieng cho Komfy Studio tren Google Flow
 */
const KOMFY_PROJECT_NAME = 'komfy-studio';

/**
 * Mo tab Google Flow neu chua co. Cho tab load xong roi tra ve tab.
 * Tu dong tim project co ten "komfy-studio". Neu chua co thi tao moi va dat ten.
 */
async function ensureFlowTab(focusTab = true) {
    let tab = await findFlowTab();
    if (tab) {
        if (focusTab) {
            await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
            await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
        return tab;
    }

    // --- Buoc 1: Mo Flow home page (Google tu dong redirect dung locale) ---
    console.log('[Komfy] Mo Flow home page...');
    const newTab = await chrome.tabs.create({ url: FLOW_URL, active: true });

    // --- Buoc 2: Cho trang load xong va lay URL thuc (co locale) ---
    await waitForTabLoad(newTab.id, 20000).catch(e => console.warn('[Komfy]', e.message));
    
    // Inject scripts
    await chrome.scripting.executeScript({ target: { tabId: newTab.id }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId: newTab.id }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});

    // Detect locale tu URL thuc te: /fx/vi/tools/flow → locale = "/vi"
    // English: /fx/tools/flow → locale = ""
    const tabInfo = await chrome.tabs.get(newTab.id);
    const actualUrl = tabInfo.url || '';
    console.log('[Komfy] Flow URL thuc te sau redirect:', actualUrl);
    
    // Extract locale prefix: match /fx/{locale}/tools/flow hoac /fx/tools/flow
    const localeMatch = actualUrl.match(/\/fx(\/[a-z]{2}(?:-[a-z]{2})?)?\/(tools\/flow)/);
    const localePrefix = localeMatch?.[1] || ''; // "/vi" hoac "" (English)
    console.log('[Komfy] Detected locale:', localePrefix || '(none/English)');
    
    // Luu locale de dung sau nay
    await chrome.storage.local.set({ komfyLocale: localePrefix });

    // --- Buoc 3: Tim project "komfy-studio" ---
    const cached = await new Promise(r => chrome.storage.local.get(['komfyProjectId'], r));
    const haveCachedProject = !!cached.komfyProjectId;

    if (haveCachedProject) {
        // Navigate truc tiep vao project VOI locale dung
        const projectUrl = `https://labs.google/fx${localePrefix}/tools/flow/project/${cached.komfyProjectId}`;
        console.log('[Komfy] Navigate vao project (cached):', projectUrl);
        await chrome.tabs.update(newTab.id, { url: projectUrl });
        await waitForTabLoad(newTab.id, 20000).catch(e => console.warn('[Komfy]', e.message));
        await chrome.scripting.executeScript({ target: { tabId: newTab.id }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
        await chrome.scripting.executeScript({ target: { tabId: newTab.id }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});
    } else {
        // Tim project "komfy-studio" tren home page
        console.log('[Komfy] Tim project "' + KOMFY_PROJECT_NAME + '" tren home page...');

        // Cho 3s de React render danh sach project
        await new Promise(r => setTimeout(r, 3000));

        let projectUrl = null;
        for (let attempt = 0; attempt < 5 && !projectUrl; attempt++) {
            const scanResult = await chrome.scripting.executeScript({
                target: { tabId: newTab.id },
                func: (targetName) => {
                    const links = [...document.querySelectorAll('a[href]')];
                    const projectLinks = links.filter(a =>
                        a.href && a.href.includes('/tools/flow/project/')
                    );

                    for (const link of projectLinks) {
                        const card = link.closest('[class]') || link;
                        const cardText = (card.textContent || '').toLowerCase().trim();
                        if (cardText.includes(targetName.toLowerCase())) {
                            return { url: link.href, found: true };
                        }
                    }

                    const cards = [...document.querySelectorAll('[data-project-id], [data-id]')];
                    for (const card of cards) {
                        const cardText = (card.textContent || '').toLowerCase().trim();
                        if (cardText.includes(targetName.toLowerCase())) {
                            const id = card.getAttribute('data-project-id') || card.getAttribute('data-id');
                            if (id) return { url: null, id: id, found: true };
                        }
                    }

                    return { url: null, found: false, totalProjects: projectLinks.length };
                },
                args: [KOMFY_PROJECT_NAME],
            }).catch(() => [{ result: { url: null, found: false, totalProjects: 0 } }]);

            const result = scanResult?.[0]?.result;
            if (result && result.found) {
                // Dung URL tu link (da co locale) hoac build tu ID
                projectUrl = result.url || `https://labs.google/fx${localePrefix}/tools/flow/project/${result.id}`;
                console.log('[Komfy] ✅ Tim thay project "' + KOMFY_PROJECT_NAME + '":', projectUrl);
            } else {
                console.log(`[Komfy] Attempt ${attempt + 1}/5: Chua tim thay project "${KOMFY_PROJECT_NAME}" (total: ${result?.totalProjects || 0}), cho them 2s...`);
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (projectUrl) {
            console.log('[Komfy] Navigate toi project "' + KOMFY_PROJECT_NAME + '":', projectUrl);
            await chrome.tabs.update(newTab.id, { url: projectUrl });
            await waitForTabLoad(newTab.id, 20000).catch(e => console.warn('[Komfy]', e.message));
            await chrome.scripting.executeScript({ target: { tabId: newTab.id }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
            await chrome.scripting.executeScript({ target: { tabId: newTab.id }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});
        } else {
            console.log('[Komfy] Khong tim thay project "' + KOMFY_PROJECT_NAME + '". Tao project moi...');
            await createAndRenameProject(newTab.id, KOMFY_PROJECT_NAME);
        }
    }

    // --- Buoc 4: Cho token + projectId duoc bat (toi da 25s) ---
    console.log('[Komfy] Cho credentials (token + projectId)...');
    const start = Date.now();
    while (Date.now() - start < 25000) {
        if (sessionData.bearerToken && sessionData.projectId) {
            console.log('[Komfy] ✅ Da co token + projectId. San sang generate!');
            break;
        }
        await new Promise(r => setTimeout(r, 500));
    }

    if (!sessionData.bearerToken) {
        throw new Error('Khong co Google session. Hay dang nhap vao Google Flow truoc.');
    }
    if (!sessionData.projectId) {
        throw new Error('Khong lay duoc Project ID. Vui long mo Google Flow va vao 1 project.');
    }

    return await chrome.tabs.get(newTab.id).catch(() => newTab);
}

/**
 * Tao project moi tren Google Flow va dat ten.
 * Flow 1: Click nut "+ Dự án mới" tren home page
 * Flow 2: Doi project page load → rename title thanh projectName
 *
 * @param {number} tabId - Tab ID dang o trang home Flow
 * @param {string} projectName - Ten project can dat (vd: "komfy-studio")
 */
async function createAndRenameProject(tabId, projectName) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // --- Buoc 1: Click nut "Dự án mới" / "New project" ---
    console.log('[Komfy] Tim nut "Dự án mới" / "New project"...');
    const clickResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            // Keywords cho ca tieng Viet va tieng Anh
            const keywords = ['dự án mới', 'new project', 'tạo dự án', 'create project', 'new flow'];

            // Tim tat ca interactive elements (button, a, div voi role, ...)
            const candidates = [...document.querySelectorAll('button, a, [role="button"], [tabindex]')];
            
            // Strategy 1: Tim theo textContent
            for (const el of candidates) {
                const text = (el.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
                for (const kw of keywords) {
                    if (text.includes(kw)) {
                        el.click();
                        return { clicked: true, text: el.textContent.trim().substring(0, 50), strategy: 'text' };
                    }
                }
            }

            // Strategy 2: Tim theo aria-label
            for (const el of candidates) {
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                for (const kw of keywords) {
                    if (label.includes(kw)) {
                        el.click();
                        return { clicked: true, text: label, strategy: 'aria-label' };
                    }
                }
                // Them keywords chung
                if (label.includes('new') || label.includes('create') || label.includes('mới') || label.includes('tạo')) {
                    el.click();
                    return { clicked: true, text: label, strategy: 'aria-label-generic' };
                }
            }

            // Strategy 3: Tim tat ca elements (ke ca div, span) co text khop
            const allEls = [...document.querySelectorAll('*')];
            for (const el of allEls) {
                const text = (el.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
                const r = el.getBoundingClientRect();
                // Chi lay cac phan tu nho (button-like), khong phai container lon
                if (r.width > 0 && r.width < 300 && r.height > 20 && r.height < 100) {
                    for (const kw of keywords) {
                        if (text.includes(kw)) {
                            el.click();
                            return { clicked: true, text: el.textContent.trim().substring(0, 50), strategy: 'any-element', tag: el.tagName };
                        }
                    }
                }
            }

            // Debug: log cac button tim thay de diagnose
            const debugBtns = candidates.slice(0, 15).map(b => ({
                tag: b.tagName,
                text: (b.textContent || '').trim().substring(0, 40),
                label: b.getAttribute('aria-label'),
            }));
            return { clicked: false, debug: debugBtns };
        }
    }).catch(e => [{ result: { clicked: false, error: e.message } }]);

    const wasClicked = clickResult?.[0]?.result?.clicked;
    if (!wasClicked) {
        const debugInfo = clickResult?.[0]?.result?.debug || clickResult?.[0]?.result?.error || 'no debug info';
        console.error('[Komfy] ⚠ Khong tim thay nut tao project! Debug:', JSON.stringify(debugInfo));
        throw new Error('Khong tim thay nut "Dự án mới" / "New project" tren trang Flow. Vui long tao project thu cong.');
    }
    console.log('[Komfy] Da click nut tao project moi:', clickResult[0].result.text, '(strategy:', clickResult[0].result.strategy + ')');

    // --- Buoc 2: Doi project page load (URL se chuyen sang /project/{id}) ---
    await waitForTabLoad(tabId, 20000).catch(e => console.warn('[Komfy]', e.message));
    await sleep(3000); // Cho SPA render xong

    // Inject scripts vao project page moi
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});

    // Xac nhan da navigate thanh cong
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    const currentUrl = currentTab?.url || '';
    if (!currentUrl.includes('/project/')) {
        console.warn('[Komfy] ⚠ Khong navigate duoc toi project page. URL hien tai:', currentUrl);
        throw new Error('Khong tao duoc project moi. Vui long thu lai.');
    }
    console.log('[Komfy] Project moi da tao, URL:', currentUrl);

    // --- Buoc 3: Dat ten project bang CDP ---
    console.log('[Komfy] Dat ten project thanh "' + projectName + '"...');
    try {
        await chrome.debugger.attach({ tabId }, '1.3');

        const send = (method, params) => new Promise((res, rej) => {
            chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
                if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
                else res(result);
            });
        });

        // Tim input title tren header (input co ten project hien tai, vd: "Mar 16 - 04:21")
        const titleResult = await send('Runtime.evaluate', {
            expression: `(function(){
                // Tim input trong header area
                var inputs = document.querySelectorAll('input');
                for (var i = 0; i < inputs.length; i++) {
                    var inp = inputs[i];
                    var r = inp.getBoundingClientRect();
                    // Title input thuong nam o top-left, nho va nam trong header
                    if (r.top < 80 && r.width > 50 && r.width < 500) {
                        return { x: r.left + r.width / 2, y: r.top + r.height / 2, found: true, value: inp.value };
                    }
                }
                // Fallback: Tim button hoac span co text giong title project
                var spans = document.querySelectorAll('button, span, div');
                for (var j = 0; j < spans.length; j++) {
                    var el = spans[j];
                    var r2 = el.getBoundingClientRect();
                    // Phan tu nam o header, nho, co text
                    if (r2.top < 80 && r2.left < 400 && r2.left > 30 && r2.width > 40 && el.textContent.trim().length > 3 && el.textContent.trim().length < 50) {
                        return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2, found: true, value: el.textContent.trim(), isSpan: true };
                    }
                }
                return { found: false };
            })()`,
            returnByValue: true,
            awaitPromise: false,
        });

        const titleInfo = titleResult?.result?.value;
        if (!titleInfo || !titleInfo.found) {
            console.warn('[Komfy] Khong tim thay title input. Project se giu ten mac dinh.');
        } else {
            console.log('[Komfy] Tim thay title:', titleInfo.value, 'isSpan:', !!titleInfo.isSpan);

            // Click vao title de focus/mo che do edit
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: titleInfo.x, y: titleInfo.y, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: titleInfo.x, y: titleInfo.y, button: 'left', clickCount: 1 });
            await sleep(500);

            // Neu la span/button, click lan nua co the mo input mode
            if (titleInfo.isSpan) {
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: titleInfo.x, y: titleInfo.y, button: 'left', clickCount: 1 });
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: titleInfo.x, y: titleInfo.y, button: 'left', clickCount: 1 });
                await sleep(500);
            }

            // Re-find input element (co the da xuat hien sau khi click span)
            const inputRefind = await send('Runtime.evaluate', {
                expression: `(function(){
                    var inputs = document.querySelectorAll('input');
                    for (var i = 0; i < inputs.length; i++) {
                        var inp = inputs[i];
                        var r = inp.getBoundingClientRect();
                        if (r.top < 80 && r.width > 50 && r.width < 500) {
                            // Focus vao input
                            inp.focus();
                            inp.select();
                            return { x: r.left + r.width / 2, y: r.top + r.height / 2, found: true, value: inp.value, isInput: true };
                        }
                    }
                    return { found: false };
                })()`,
                returnByValue: true,
                awaitPromise: false,
            });
            const inputInfo = inputRefind?.result?.value;
            const editTarget = (inputInfo && inputInfo.found) ? inputInfo : titleInfo;
            if (inputInfo && inputInfo.found) {
                console.log('[Komfy] Re-found input element, value:', inputInfo.value);
            }

            // Triple-click de select all text (dang tin cay hon Ctrl+A cho input fields)
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editTarget.x, y: editTarget.y, button: 'left', clickCount: 3 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editTarget.x, y: editTarget.y, button: 'left', clickCount: 3 });
            await sleep(200);

            // Them Ctrl+A de dam bao chon het (belt and suspenders)
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
            await sleep(200);

            // XOA TEXT CU: Backspace de xoa hoan toan text da select
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
            await sleep(200);

            // Xac nhan input da rong
            if (editTarget.isInput) {
                const emptyCheck = await send('Runtime.evaluate', {
                    expression: `(function(){
                        var inputs = document.querySelectorAll('input');
                        for (var i = 0; i < inputs.length; i++) {
                            var r = inputs[i].getBoundingClientRect();
                            if (r.top < 80 && r.width > 50 && r.width < 500) return inputs[i].value;
                        }
                        return '?';
                    })()`,
                    returnByValue: true,
                });
                console.log('[Komfy] Input after clear:', JSON.stringify(emptyCheck?.result?.value));
            }

            // GO TEN MOI
            await send('Input.insertText', { text: projectName });
            await sleep(500);

            // Xac nhan ten da duoc go dung
            if (editTarget.isInput) {
                const verifyCheck = await send('Runtime.evaluate', {
                    expression: `(function(){
                        var inputs = document.querySelectorAll('input');
                        for (var i = 0; i < inputs.length; i++) {
                            var r = inputs[i].getBoundingClientRect();
                            if (r.top < 80 && r.width > 50 && r.width < 500) return inputs[i].value;
                        }
                        return '?';
                    })()`,
                    returnByValue: true,
                });
                console.log('[Komfy] Input after type:', JSON.stringify(verifyCheck?.result?.value));
            }

            // Enter de confirm
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
            await sleep(300);

            // Click ngoai de blur (trigger save)
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 400, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 500, y: 400, button: 'left', clickCount: 1 });
            await sleep(500);

            console.log('[Komfy] ✅ Da dat ten project thanh "' + projectName + '"');
        }
    } catch (e) {
        console.warn('[Komfy] Loi khi dat ten project:', e.message);
        // Khong throw - project da duoc tao, chi la chua doi ten
    } finally {
        chrome.debugger.detach({ tabId }).catch(() => {});
    }

    // --- Buoc 4: Lay projectId tu URL va cache ---
    const finalTab = await chrome.tabs.get(tabId).catch(() => null);
    const finalUrl = finalTab?.url || '';
    const projectIdMatch = finalUrl.match(/\/project\/([a-zA-Z0-9_-]+)/);
    if (projectIdMatch) {
        const newProjectId = projectIdMatch[1];
        sessionData.projectId = newProjectId;
        chrome.storage.local.set({ komfyProjectId: newProjectId });
        console.log('[Komfy] ✅ Cached projectId:', newProjectId.substring(0, 16) + '...');
    }
}

/**
 * UI automation dung CDP (giong Puppeteer).
 */
async function generateViaUI(prompt, aspectRatio) {
    // Su dung ensureFlowTab thay vi findFlowTab - tu dong mo neu can
    const tab = await ensureFlowTab(true);
    const tabId = tab.id;
    console.log('[Komfy] CDP tab:', tabId, 'orient:', aspectRatio, 'prompt:', prompt.substring(0, 40));

    await chrome.debugger.attach({ tabId }, '1.3');

    const send = (method, params) => new Promise((res, rej) => {
        chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
            if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
            else res(result);
        });
    });

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const SNAPSHOT_EXPR = `
    (function() {
        const ids = new Set();
        document.querySelectorAll('[data-generation-id]').forEach(el => ids.add(el.getAttribute('data-generation-id')));
        document.querySelectorAll('video[src], source[src]').forEach(el => {
            const src = el.src || el.getAttribute('src') || '';
            const m = src.match(/generations\\/([a-zA-Z0-9_-]+)/);
            if (m) ids.add(m[1]);
        });
        document.querySelectorAll('[poster], img[src]').forEach(el => {
            const src = el.poster || el.src || '';
            const m = src.match(/generations\\/([a-zA-Z0-9_-]+)/);
            if (m) ids.add(m[1]);
        });
        document.querySelectorAll('[data-id],[data-key],[data-video-id]').forEach(el => {
            const val = el.getAttribute('data-id') || el.getAttribute('data-key') || el.getAttribute('data-video-id') || '';
            if (val.length > 10) ids.add(val);
        });
        document.querySelectorAll('video').forEach(v => {
            if (v.src && v.src.includes('media.getMediaUrlRedirect?name=')) {
                try {
                    const u = new URL(v.src);
                    ids.add('MEDIA:' + u.searchParams.get('name'));
                } catch(e) {}
            }
        });
        const videoCount = document.querySelectorAll('video, [role="img"], .video-card, [class*="video"], [class*="card"]').length;
        return { ids: [...ids], count: videoCount };
    })()
    `;

    try {
        // Doi SPA render xong video cu truoc khi chup snapshot
        console.log('[Komfy] Cho SPA render (2s)...');
        await sleep(2000);
        const beforeSnap = await send('Runtime.evaluate', { expression: SNAPSHOT_EXPR, returnByValue: true, awaitPromise: false });
        const beforeIds = new Set(beforeSnap && beforeSnap.result && beforeSnap.result.value && beforeSnap.result.value.ids || []);
        const beforeCount = beforeSnap && beforeSnap.result && beforeSnap.result.value && beforeSnap.result.value.count || 0;
        console.log('[Komfy] BEFORE: ids=', beforeIds.size, 'count=', beforeCount);

        await send('Runtime.evaluate', {
            expression: `window.__komfy_genId__ = null;
            if (!window.__komfy_intercept__) {
                window.__komfy_intercept__ = true;
                const origFetch = window.fetch;
                window.fetch = async function(...args) {
                    const url = typeof args[0]==='string'?args[0]:(args[0]?.url||'');
                    const res = await origFetch.apply(this, args);
                    if (url.includes('batchAsyncGenerateVideoText')) {
                        try { const d = await res.clone().json(); const gid = d?.generationResults?.[0]?.generationId; if (gid && window.__komfy_clickTime && Date.now() - window.__komfy_clickTime < 120000) { window.__komfy_genId__ = gid; } } catch(e){}
                    }
                    return res;
                };
            } else { window.__komfy_genId__ = null; }`,
            awaitPromise: false,
        });

        const focusResult = await send('Runtime.evaluate', {
            expression: `(function(){const tb=document.querySelector('[role="textbox"],[contenteditable="true"]');if(!tb)return null;tb.focus();tb.click();const r=tb.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,found:true};})()`,
            returnByValue: true, awaitPromise: false,
        });
        const tbInfo = focusResult && focusResult.result && focusResult.result.value;
        if (!tbInfo || !tbInfo.found) throw new Error('Khong tim thay textbox!');

        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tbInfo.x, y: tbInfo.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tbInfo.x, y: tbInfo.y, button: 'left', clickCount: 1 });
        await sleep(300);

        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
        await sleep(100);
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
        await sleep(100);
        await send('Input.insertText', { text: prompt });
        await sleep(500);
        console.log('[Komfy] Typed:', prompt.substring(0, 40));

        const btnResult = await send('Runtime.evaluate', {
            expression: `(function(){
                const btns=[...document.querySelectorAll('button')];
                const tb=document.querySelector('[role="textbox"],[contenteditable="true"]');
                const tbR=tb?tb.getBoundingClientRect():{right:0,bottom:0};
                let best=null,bestD=Infinity;
                for(const b of btns){const l=(b.getAttribute('aria-label')||'').toLowerCase();if(l.includes('create')||l.includes('send')||l.includes('generate')||l.includes('tao')){const r=b.getBoundingClientRect();best={x:r.left+r.width/2,y:r.top+r.height/2,label:l};break;}}
                if(!best){for(const b of btns){if(b.disabled)continue;const r=b.getBoundingClientRect();if(!r.width)continue;const d=Math.hypot(r.left-tbR.right,r.top-tbR.bottom);if(d<bestD&&d<300){bestD=d;best={x:r.left+r.width/2,y:r.top+r.height/2,dist:d};}}}
                return best;
            })()`,
            returnByValue: true, awaitPromise: false,
        });
        const btnInfo = btnResult && btnResult.result && btnResult.result.value;
        if (!btnInfo) throw new Error('Khong tim thay submit button!');


        // Reset genId VA set clickTime NGAY TRUOC khi click - tranh capture background fetches
        await send('Runtime.evaluate', {
            expression: 'window.__komfy_genId__ = null; window.__komfy_clickTime = Date.now();',
            awaitPromise: false,
        });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btnInfo.x, y: btnInfo.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btnInfo.x, y: btnInfo.y, button: 'left', clickCount: 1 });
        await sleep(1000);
        console.log('[Komfy] Clicked! Polling...');

        let generationId = null;

        for (let i = 0; i < 60; i++) {
            await sleep(2000);

            const fetchCheck = await send('Runtime.evaluate', { expression: 'window.__komfy_genId__', returnByValue: true });
            if (fetchCheck && fetchCheck.result && fetchCheck.result.value) {
                generationId = fetchCheck.result.value;
                console.log('[Komfy] GenerationId from fetch interceptor:', generationId);
                break;
            }

            const afterSnap = await send('Runtime.evaluate', { expression: SNAPSHOT_EXPR, returnByValue: true, awaitPromise: false });
            const afterIds = afterSnap && afterSnap.result && afterSnap.result.value && afterSnap.result.value.ids || [];
            const afterCount = afterSnap && afterSnap.result && afterSnap.result.value && afterSnap.result.value.count || 0;

            const newIds = afterIds.filter(id => !beforeIds.has(id));
            if (newIds.length > 0) {
                generationId = newIds[0];
                console.log('[Komfy] GenerationId from DOM diff:', generationId);
                break;
            }
            if (i % 5 === 0) console.log('[Komfy] Polling...', i * 2, 's');
        }

        if (!generationId) {
            const srcSnap = await send('Runtime.evaluate', {
                expression: `(function(){const srcs=[];document.querySelectorAll('video[src],source[src]').forEach(el=>srcs.push(el.src||el.getAttribute('src')));return srcs.filter(s=>s&&s.length>10);})()`,
                returnByValue: true, awaitPromise: false,
            });
            const newVideoSrcs = srcSnap && srcSnap.result && srcSnap.result.value || [];
            if (newVideoSrcs.length > 0) {
                generationId = 'DIRECT:' + newVideoSrcs[0];
            }
        }

        if (generationId) {
            return { ok: true, status: 200, body: JSON.stringify({ generationResults: [{ generationId }] }) };
        }

        throw new Error('Timeout 120s - khong tim thay video moi!');
    } finally {
        chrome.debugger.detach({ tabId }).catch(() => { });
    }
}

/**
 * Image generation via UI automation (Nano Banana 2 / Imagen on Google Flow).
 * Tuong tu generateViaUI cho video, nhung:
 * 1. Chuyen sang che do Image (click "Hình ảnh" / "Image")
 * 2. Intercept batchGenerateImages response
 * 3. Extract fifeUrl (URL anh truc tiep)
 * 4. Download va tra ve base64
 */
async function generateImageViaUI(prompt, aspectRatio, modelName) {
    const tab = await ensureFlowTab(true);
    const tabId = tab.id;
    console.log('[Komfy] Image CDP tab:', tabId, 'aspect:', aspectRatio, 'model:', modelName, 'prompt:', prompt.substring(0, 40));

    await chrome.debugger.attach({ tabId }, '1.3');

    const send = (method, params) => new Promise((res, rej) => {
        chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
            if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
            else res(result);
        });
    });

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    try {
        // === Buoc 0: Thoat edit mode bang NAVIGATE truc tiep ===
        const urlCheck = await send('Runtime.evaluate', {
            expression: 'window.location.href',
            returnByValue: true,
        });
        const currentPageUrl = urlCheck?.result?.value || '';
        console.log('[Komfy] Current URL:', currentPageUrl);
        
        if (currentPageUrl.includes('/edit/')) {
            const projectUrl = currentPageUrl.replace(/\/edit\/.*$/, '');
            console.log('[Komfy] Dang o EDIT MODE! Navigate ve project:', projectUrl);
            await send('Page.navigate', { url: projectUrl });
            
            for (let w = 0; w < 15; w++) {
                await sleep(1000);
                const recheck = await send('Runtime.evaluate', {
                    expression: 'window.location.href',
                    returnByValue: true,
                });
                const newUrl = recheck?.result?.value || '';
                if (!newUrl.includes('/edit/')) {
                    console.log('[Komfy] ✅ Da thoat edit mode:', newUrl);
                    break;
                }
                if (w === 14) console.warn('[Komfy] Timeout thoat edit mode!');
            }
            await sleep(2000);
        }

        // === Buoc 1: Mo popup va chuyen sang Image mode + chon model ===
        console.log('[Komfy] Mo settings popup...');
        // Click nut mode selector o bottom bar
        const switchResult = await send('Runtime.evaluate', {
            expression: `(function(){
                var btns = document.querySelectorAll('button, [role="button"]');
                for (var i = 0; i < btns.length; i++) {
                    var text = (btns[i].textContent || '').toLowerCase();
                    var r = btns[i].getBoundingClientRect();
                    if (r.bottom > window.innerHeight - 100 && r.width > 80 &&
                        (text.includes('video') || text.includes('banana') || text.includes('imagen') || text.includes('image') || text.includes('hình ảnh') || text.includes('veo'))) {
                        btns[i].click();
                        return { clicked: true, text: text.trim().substring(0, 40) };
                    }
                }
                return { clicked: false };
            })()`,
            returnByValue: true, awaitPromise: false,
        });
        console.log('[Komfy] Mode button click:', JSON.stringify(switchResult?.result?.value));
        await sleep(500);

        // Click tab "Hình ảnh" / "Image"
        const imageTabResult = await send('Runtime.evaluate', {
            expression: `(function(){
                var els = document.querySelectorAll('button, [role="tab"], [role="button"], div, span');
                for (var i = 0; i < els.length; i++) {
                    var text = (els[i].textContent || '').toLowerCase().trim();
                    var r = els[i].getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && r.width < 200 &&
                        (text === 'hình ảnh' || text === 'image' || text === 'images') &&
                        !text.includes('video')) {
                        els[i].click();
                        return { clicked: true, text: text };
                    }
                }
                return { clicked: false };
            })()`,
            returnByValue: true, awaitPromise: false,
        });
        console.log('[Komfy] Image tab click:', JSON.stringify(imageTabResult?.result?.value));
        await sleep(500);

        // === Buoc 1.2: Chon model (Nano Banana 2 / Nano Banana Pro / Imagen 4) ===
        const targetModel = (modelName || 'Nano Banana 2').toLowerCase();
        console.log('[Komfy] Target model:', targetModel);
        
        // Kiem tra model hien tai co dung chua (tu text cua dropdown)
        const currentModelCheck = await send('Runtime.evaluate', {
            expression: `(function(){
                // Tim element dropdown model trong popup (co arrow_drop_down icon)
                var els = document.querySelectorAll('div, button, span');
                for (var i = 0; i < els.length; i++) {
                    var text = (els[i].textContent || '').trim();
                    var r = els[i].getBoundingClientRect();
                    // Model dropdown: gan cuoi popup, chua text "arrow_drop_down" (material icon)
                    if (r.width > 100 && r.height > 20 && r.height < 60 &&
                        r.bottom > window.innerHeight - 350 &&
                        text.includes('arrow_drop_down') &&
                        (text.includes('Banana') || text.includes('Imagen') || text.includes('Gemini'))) {
                        var modelText = text.replace('arrow_drop_down', '').trim().toLowerCase();
                        return { currentModel: modelText };
                    }
                }
                return { currentModel: 'unknown' };
            })()`,
            returnByValue: true, awaitPromise: false,
        });
        const currentModel = currentModelCheck?.result?.value?.currentModel || 'unknown';
        console.log('[Komfy] Current model:', currentModel, '| target:', targetModel);
        
        // Chi doi model neu chua dung
        if (!currentModel.includes(targetModel)) {
            // Click mo dropdown model
            const dropdownResult = await send('Runtime.evaluate', {
                expression: `(function(){
                    var els = document.querySelectorAll('div, button, span');
                    for (var i = 0; i < els.length; i++) {
                        var text = (els[i].textContent || '').trim();
                        var r = els[i].getBoundingClientRect();
                        if (r.width > 100 && r.height > 20 && r.height < 60 &&
                            r.bottom > window.innerHeight - 350 &&
                            text.includes('arrow_drop_down') &&
                            (text.includes('Banana') || text.includes('Imagen') || text.includes('Gemini'))) {
                            els[i].click();
                            return { clicked: true, text: text.replace('arrow_drop_down','').trim().substring(0, 30) };
                        }
                    }
                    return { clicked: false };
                })()`,
                returnByValue: true, awaitPromise: false,
            });
            console.log('[Komfy] Model dropdown click:', JSON.stringify(dropdownResult?.result?.value));
            await sleep(500);

            // Chon model tu danh sach menuitem
            const modelSelectResult = await send('Runtime.evaluate', {
                expression: `(function(){
                    var target = '${targetModel}';
                    // Uu tien [role="menuitem"] (chinh xac nhat theo DOM Google Flow)
                    var items = document.querySelectorAll('[role="menuitem"]');
                    for (var i = 0; i < items.length; i++) {
                        var text = (items[i].textContent || '').toLowerCase().trim();
                        var r = items[i].getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        if (text.includes(target)) {
                            items[i].click();
                            return { clicked: true, text: text, method: 'menuitem' };
                        }
                    }
                    // Fallback: tim tat ca element visible co text model
                    var all = document.querySelectorAll('div, button, span, li');
                    for (var i = 0; i < all.length; i++) {
                        var text = (all[i].textContent || '').toLowerCase().trim();
                        var r = all[i].getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        if (text.includes(target) && text.length < 40 && r.height < 60) {
                            all[i].click();
                            return { clicked: true, text: text, method: 'fallback' };
                        }
                    }
                    return { clicked: false, target: target };
                })()`,
                returnByValue: true, awaitPromise: false,
            });
            console.log('[Komfy] Model select:', JSON.stringify(modelSelectResult?.result?.value));
            await sleep(300);
        } else {
            console.log('[Komfy] Model da dung, khong can doi.');
        }

        // === Buoc 1.5: Chon aspect ratio (Ngang/Doc) ===
        // Flow chi ho tro 2 tuy chon: Ngang (Landscape) va Doc (Portrait)
        // Map tu node settings: 16:9, 4:3, 1:1, Auto -> Landscape; 9:16, 3:4 -> Portrait
        const wantPortrait = aspectRatio === '9:16' || aspectRatio === '3:4' ||
            aspectRatio === 'portrait' || aspectRatio === 'IMAGE_ASPECT_RATIO_PORTRAIT';
        const targetOrientation = wantPortrait ? 'portrait' : 'landscape';
        console.log('[Komfy] Aspect ratio:', aspectRatio, '-> target:', targetOrientation);

        const arResult = await send('Runtime.evaluate', {
            expression: `(function(){
                var target = '${targetOrientation}';
                var els = document.querySelectorAll('button, [role="tab"], [role="button"]');
                for (var i = 0; i < els.length; i++) {
                    var text = (els[i].textContent || '').toLowerCase().trim();
                    var id = (els[i].id || '').toLowerCase();
                    var r = els[i].getBoundingClientRect();
                    if (r.width === 0) continue;
                    
                    if (target === 'portrait') {
                        // Tim "Doc" / "Portrait"
                        if (text === 'dọc' || text === 'portrait' || id.includes('portrait')) {
                            els[i].click();
                            return { clicked: true, text: text, orientation: 'portrait' };
                        }
                    } else {
                        // Tim "Ngang" / "Landscape"
                        if (text === 'ngang' || text === 'landscape' || id.includes('landscape')) {
                            els[i].click();
                            return { clicked: true, text: text, orientation: 'landscape' };
                        }
                    }
                }
                return { clicked: false, target: target };
            })()`,
            returnByValue: true, awaitPromise: false,
        });
        console.log('[Komfy] Aspect ratio click:', JSON.stringify(arResult?.result?.value));
        await sleep(300);

        // Dong menu bang Escape (KHONG click vao trang vi co the trung thumbnail anh → re-enter edit mode!)
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
        await sleep(500);
        
        // Safety check: dam bao khong bi vao edit mode sau khi dong menu
        const postMenuUrl = await send('Runtime.evaluate', {
            expression: 'window.location.href',
            returnByValue: true,
        });
        if ((postMenuUrl?.result?.value || '').includes('/edit/')) {
            const projectUrl = (postMenuUrl.result.value).replace(/\/edit\/.*$/, '');
            console.log('[Komfy] Bi vao edit mode sau dong menu! Navigate lai:', projectUrl);
            await send('Page.navigate', { url: projectUrl });
            await sleep(3000);
        }

        // === Buoc 2: Setup fetch interceptor cho batchGenerateImages ===
        await send('Runtime.evaluate', {
            expression: `window.__komfy_imageResult__ = null;
            if (!window.__komfy_imageIntercept__) {
                window.__komfy_imageIntercept__ = true;
                const origFetch = window.fetch;
                window.fetch = async function(...args) {
                    const url = typeof args[0]==='string'?args[0]:(args[0]?.url||'');
                    const res = await origFetch.apply(this, args);
                    if (url.includes('batchGenerateImages')) {
                        try {
                            const d = await res.clone().json();
                            window.__komfy_imageResult__ = d;
                        } catch(e){}
                    }
                    return res;
                };
            } else { window.__komfy_imageResult__ = null; }`,
            awaitPromise: false,
        });

        // === Buoc 3: Type prompt va click generate ===
        // Final check: dam bao dang o project view, KHONG phai edit mode
        const preTypeUrl = await send('Runtime.evaluate', {
            expression: `({url: window.location.href, placeholder: (document.querySelector('[role="textbox"]')?.getAttribute('data-placeholder') || '')})`,
            returnByValue: true,
        });
        const preTypeInfo = preTypeUrl?.result?.value || {};
        console.log('[Komfy] Pre-type check - URL:', (preTypeInfo.url || '').substring(0, 80), '| placeholder:', preTypeInfo.placeholder);
        if ((preTypeInfo.url || '').includes('/edit/')) {
            const projUrl = preTypeInfo.url.replace(/\/edit\/.*$/, '');
            console.log('[Komfy] WARN: Van o edit mode truoc khi type! Force navigate:', projUrl);
            await send('Page.navigate', { url: projUrl });
            await sleep(3000);
        }

        const focusResult = await send('Runtime.evaluate', {
            expression: `(function(){const tb=document.querySelector('[role="textbox"],[contenteditable="true"]');if(!tb)return null;tb.focus();tb.click();const r=tb.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,found:true};})()`,
            returnByValue: true, awaitPromise: false,
        });
        const tbInfo = focusResult && focusResult.result && focusResult.result.value;
        if (!tbInfo || !tbInfo.found) throw new Error('Khong tim thay textbox!');

        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tbInfo.x, y: tbInfo.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tbInfo.x, y: tbInfo.y, button: 'left', clickCount: 1 });
        await sleep(300);

        // Select all + delete + type
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
        await sleep(100);
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
        await sleep(100);
        await send('Input.insertText', { text: prompt });
        await sleep(500);
        console.log('[Komfy] Image prompt typed:', prompt.substring(0, 40));

        // Tim va click nut Generate/Create/Send
        const btnResult = await send('Runtime.evaluate', {
            expression: `(function(){
                const btns=[...document.querySelectorAll('button')];
                const tb=document.querySelector('[role="textbox"],[contenteditable="true"]');
                const tbR=tb?tb.getBoundingClientRect():{right:0,bottom:0};
                let best=null,bestD=Infinity;
                for(const b of btns){const l=(b.getAttribute('aria-label')||'').toLowerCase();if(l.includes('create')||l.includes('send')||l.includes('generate')||l.includes('tao')){const r=b.getBoundingClientRect();best={x:r.left+r.width/2,y:r.top+r.height/2,label:l};break;}}
                if(!best){for(const b of btns){if(b.disabled)continue;const r=b.getBoundingClientRect();if(!r.width)continue;const d=Math.hypot(r.left-tbR.right,r.top-tbR.bottom);if(d<bestD&&d<300){bestD=d;best={x:r.left+r.width/2,y:r.top+r.height/2,dist:d};}}}
                return best;
            })()`,
            returnByValue: true, awaitPromise: false,
        });
        const btnInfo = btnResult && btnResult.result && btnResult.result.value;
        if (!btnInfo) throw new Error('Khong tim thay submit button!');

        // === Snapshot anh hien co TRUOC khi generate (de diff sau) ===
        const preSnap = await send('Runtime.evaluate', {
            expression: `(function(){
                var imgs = document.querySelectorAll('img[src]');
                var urls = [];
                for (var k = 0; k < imgs.length; k++) {
                    var src = imgs[k].src || '';
                    if (src.includes('storage.googleapis.com') || src.includes('ai-sandbox') || src.includes('lh3.googleusercontent.com')) {
                        urls.push(src);
                    }
                }
                return urls;
            })()`,
            returnByValue: true,
        });
        const existingImgUrls = new Set(preSnap?.result?.value || []);
        console.log('[Komfy] Pre-gen image snapshot:', existingImgUrls.size, 'existing images');

        // Reset imageResult va click
        await send('Runtime.evaluate', {
            expression: 'window.__komfy_imageResult__ = null;',
            awaitPromise: false,
        });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btnInfo.x, y: btnInfo.y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btnInfo.x, y: btnInfo.y, button: 'left', clickCount: 1 });
        await sleep(1000);
        console.log('[Komfy] Image generate clicked! Polling...');

        // === Buoc 4: Poll cho ket qua ===
        let imageUrl = null;

        for (let i = 0; i < 60; i++) {
            await sleep(2000);

            // Check fetch interceptor (luon lay ket qua tu API response moi nhat)
            const fetchCheck = await send('Runtime.evaluate', {
                expression: `(function(){
                    if (!window.__komfy_imageResult__) return null;
                    var r = window.__komfy_imageResult__;
                    // Tim fifeUrl trong response - co nhieu format khac nhau
                    
                    // Format 1: { media: [{ generatedImage: { fifeUrl: "..." } }] }
                    if (r.media && r.media.length > 0) {
                        for (var j = 0; j < r.media.length; j++) {
                            var m = r.media[j];
                            if (m.generatedImage && m.generatedImage.fifeUrl) return m.generatedImage.fifeUrl;
                            if (m.generatedImage && m.generatedImage.url) return m.generatedImage.url;
                            if (m.fifeUrl) return m.fifeUrl;
                            if (m.url) return m.url;
                            if (m.gcsUri) return m.gcsUri;
                        }
                    }
                    
                    // Format 2: { result: { media: [...] } }
                    if (r.result && r.result.media && r.result.media.length > 0) {
                        for (var j = 0; j < r.result.media.length; j++) {
                            var m = r.result.media[j];
                            if (m.generatedImage && m.generatedImage.fifeUrl) return m.generatedImage.fifeUrl;
                            if (m.generatedImage && m.generatedImage.url) return m.generatedImage.url;
                            if (m.fifeUrl) return m.fifeUrl;
                            if (m.url) return m.url;
                        }
                    }
                    
                    // Format 3: Direct fields
                    if (r.fifeUrl) return r.fifeUrl;
                    if (r.imageUrl) return r.imageUrl;
                    
                    // Fallback: deep scan JSON for any URL containing storage.googleapis or ai-sandbox
                    var str = JSON.stringify(r);
                    var storageMatch = str.match(/"(https?:\\/\\/[^"]*(?:storage\\.googleapis\\.com|ai-sandbox)[^"]*)"/);
                    if (storageMatch) return storageMatch[1];
                    
                    // Return raw for debugging
                    return 'RAW:' + str.substring(0, 800);
                })()`,
                returnByValue: true,
            });

            const fUrl = fetchCheck && fetchCheck.result && fetchCheck.result.value;
            if (fUrl && !fUrl.startsWith('RAW:')) {
                imageUrl = fUrl;
                console.log('[Komfy] Image URL from interceptor:', imageUrl.substring(0, 80));
                break;
            }
            if (fUrl && fUrl.startsWith('RAW:')) {
                console.log('[Komfy] Image raw response:', fUrl.substring(0, 200));
            }

            // Fallback: scan DOM cho anh MOI (diff voi pre-snapshot)
            const imgScan = await send('Runtime.evaluate', {
                expression: `(function(){
                    var imgs = document.querySelectorAll('img[src]');
                    var results = [];
                    for (var k = 0; k < imgs.length; k++) {
                        var src = imgs[k].src || '';
                        if (src.includes('storage.googleapis.com') || src.includes('ai-sandbox') || src.includes('lh3.googleusercontent.com')) {
                            results.push(src);
                        }
                    }
                    return results;
                })()`,
                returnByValue: true,
            });
            const allImgUrls = imgScan && imgScan.result && imgScan.result.value || [];
            // Chi lay anh MOI (khong co trong pre-snapshot)
            const newImgs = allImgUrls.filter(u => !existingImgUrls.has(u));
            if (newImgs.length > 0) {
                imageUrl = newImgs[newImgs.length - 1]; // Lay anh moi nhat
                console.log('[Komfy] NEW image from DOM diff:', imageUrl.substring(0, 80), '(', newImgs.length, 'new)');
                break;
            }

            if (i % 5 === 0) console.log('[Komfy] Image polling...', i * 2, 's, existing:', existingImgUrls.size, 'current:', allImgUrls.length);
        }

        if (!imageUrl) {
            throw new Error('Timeout 120s - khong tim thay anh moi!');
        }

        // === Buoc 5: Download image TRONG PAGE CONTEXT (co Google cookies) ===
        // Service worker KHONG co cookies nen khong fetch duoc fifeUrl
        console.log('[Komfy] Downloading image in page context...');
        const dlResult = await send('Runtime.evaluate', {
            expression: `(async function(){
                try {
                    const url = ${JSON.stringify(imageUrl)};
                    const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
                    if (!res.ok) return { error: 'HTTP ' + res.status };
                    const blob = await res.blob();
                    const mimeType = blob.type || 'image/png';
                    const size = blob.size;
                    // Convert blob -> base64
                    return await new Promise(function(resolve){
                        var reader = new FileReader();
                        reader.onloadend = function(){
                            var dataUrl = reader.result; // "data:image/png;base64,..."
                            resolve({ dataUrl: dataUrl, mimeType: mimeType, size: size });
                        };
                        reader.readAsDataURL(blob);
                    });
                } catch(e) {
                    return { error: e.message };
                }
            })()`,
            returnByValue: true,
            awaitPromise: true,
        });

        const dlData = dlResult?.result?.value;
        if (dlData && dlData.dataUrl) {
            // Extract base64 from data URL
            const b64Match = dlData.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (b64Match) {
                console.log('[Komfy] ✅ Image downloaded:', (dlData.size / 1024).toFixed(1), 'KB, type:', dlData.mimeType);
                return {
                    ok: true,
                    status: 200,
                    body: JSON.stringify({
                        base64: b64Match[2],
                        mimeType: b64Match[1],
                        size: dlData.size,
                        imageUrl: imageUrl,
                    })
                };
            }
            // Fallback: tra ve data URL truc tiep
            console.log('[Komfy] ✅ Image downloaded as dataUrl, size:', dlData.size);
            return {
                ok: true,
                status: 200,
                body: JSON.stringify({
                    dataUrl: dlData.dataUrl,
                    mimeType: dlData.mimeType,
                    size: dlData.size,
                    imageUrl: imageUrl,
                })
            };
        }

        console.warn('[Komfy] Page download failed:', dlData?.error || 'unknown');
        // Fallback cuoi: tra ve URL de client tu fetch
        return {
            ok: true,
            status: 200,
            body: JSON.stringify({ imageUrl: imageUrl })
        };

    } finally {
        // === Cleanup: Thoat edit mode TRUOC khi detach ===
        try {
            const cleanupUrl = await send('Runtime.evaluate', {
                expression: 'window.location.href',
                returnByValue: true,
            });
            const url = cleanupUrl?.result?.value || '';
            if (url.includes('/edit/')) {
                const projUrl = url.replace(/\/edit\/.*$/, '');
                console.log('[Komfy] Cleanup: Navigate ve project:', projUrl);
                await send('Page.navigate', { url: projUrl });
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (e) {
            // Ignore - debugger co the da bi detach
        }
        chrome.debugger.detach({ tabId }).catch(() => { });
    }
}

/**
 * Download video blob.
 * Key fix: tRPC endpoint yeu cau UUID thuan tuy (khong co 'MEDIA:' prefix).
 * Vi du: 'MEDIA:020071f2-xxxx' → rawId='020071f2-xxxx'
 *
 * Buoc 0: Lay URL chinh xac tu DOM video element (luon co rawId dung)
 * Method 1: Service Worker fetch voi credentials + Bearer + XBV
 */
async function downloadBlobViaCDP(mediaId) {
    console.log('[Komfy] Download blob:', mediaId);

    // Strip 'MEDIA:' prefix - tRPC chi nhan UUID thuan
    const rawId = mediaId.startsWith('MEDIA:') ? mediaId.slice(6) : mediaId;
    console.log('[Komfy] rawId:', rawId);

    // === Buoc 0: Tim URL chinh xac tu DOM (video element luon dung rawId) ===
    let fetchUrl = null;
    const flowTab = await findFlowTab();
    if (flowTab) {
        try {
            await chrome.debugger.attach({ tabId: flowTab.id }, '1.3');
            const cdpS = (m, p) => new Promise((rs, rj) => {
                chrome.debugger.sendCommand({ tabId: flowTab.id }, m, p || {}, r => {
                    if (chrome.runtime.lastError) rj(new Error(chrome.runtime.lastError.message));
                    else rs(r);
                });
            });
            const safeRaw = rawId.replace(/"/g, '\\"');
            const expr = '(function(){'
                + 'var id="' + safeRaw + '";'
                + 'var vs=Array.from(document.querySelectorAll("video,source"));'
                + 'for(var i=0;i<vs.length;i++){'
                + 'var s=vs[i].src||vs[i].getAttribute("src")||"";'
                + 'if(s&&s.indexOf(id)>-1)return s;}'
                + 'for(var j=0;j<vs.length;j++){'
                + 'var s2=vs[j].src||vs[j].getAttribute("src")||"";'
                + 'if(s2&&s2.indexOf("getMediaUrlRedirect")>-1)return s2;}'
                + 'return null;})()';
            const sr = await cdpS('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
            fetchUrl = sr && sr.result && sr.result.value;
            chrome.debugger.detach({ tabId: flowTab.id }).catch(() => { });
            console.log('[Komfy] DOM src:', fetchUrl ? fetchUrl.substring(0, 100) : 'not found');
        } catch (e) {
            console.warn('[Komfy] CDP DOM err:', e.message);
            chrome.debugger.detach({ tabId: flowTab.id }).catch(() => { });
        }
    }

    // Fallback: xay dung URL voi rawId (da strip MEDIA:)
    if (!fetchUrl) {
        fetchUrl = 'https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=' + encodeURIComponent(rawId) + '&batch=1';
        console.log('[Komfy] Using constructed URL:', fetchUrl.substring(0, 100));
    }

    // === Method 1: Service Worker fetch ===
    // SW co <all_urls> host_permissions nen khong bi CORS restriction
    // credentials:include → dung cookies cua user
    try {
        console.log('[Komfy] SW fetch:', fetchUrl.substring(0, 100));
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 25000);

        const r1 = await fetch(fetchUrl, {
            credentials: 'include',
            redirect: 'follow',
            signal: ctrl.signal,
            headers: {
                'authorization': sessionData.bearerToken || '',
                'x-browser-validation': sessionData.xbv || '',
                'accept': '*/*',
                'referer': 'https://labs.google/',
            },
        });
        clearTimeout(t);

        console.log('[Komfy] SW status:', r1.status, 'type:', r1.type, 'url:', r1.url.substring(0, 80));

        let gcsUrl = null;

        // Redirect da follow → URL cuoi la GCS
        if (r1.url && r1.url.includes('storage.googleapis.com')) {
            gcsUrl = r1.url;
        }

        // 3xx redirect (manual)
        if (!gcsUrl && r1.status >= 300 && r1.status < 400) {
            gcsUrl = r1.headers.get('location');
            console.log('[Komfy] SW Location:', gcsUrl ? gcsUrl.substring(0, 80) : 'null');
        }

        // 200 JSON response co URL
        if (!gcsUrl && r1.ok && r1.type !== 'opaque') {
            try {
                const txt = await r1.text();
                console.log('[Komfy] SW body:', txt.substring(0, 200));
                const d = JSON.parse(txt);
                gcsUrl = (d && d[0] && d[0].result && d[0].result.data && d[0].result.data.url) || null;
            } catch (e) { console.warn('[Komfy] parse err:', e.message); }
        }

        if (gcsUrl) {
            console.log('[Komfy] GCS URL:', gcsUrl.substring(0, 80));
            const vr = await fetch(gcsUrl);
            if (!vr.ok) throw new Error('GCS failed: ' + vr.status);
            const buf = await vr.arrayBuffer();
            const u8 = new Uint8Array(buf);
            let b = ''; const C = 8192;
            for (let i = 0; i < u8.length; i += C) b += String.fromCharCode.apply(null, u8.subarray(i, i + C));
            console.log('[Komfy] Blob: ' + (buf.byteLength / 1024 / 1024).toFixed(2) + ' MB ✅');
            return { ok: true, status: 200, body: JSON.stringify({ base64: btoa(b), mimeType: 'video/mp4', size: buf.byteLength }) };
        }

        console.warn('[Komfy] SW: no GCS URL (status=' + r1.status + ' type=' + r1.type + ')');
    } catch (e) {
        console.warn('[Komfy] SW error:', e.message);
    }

    throw new Error('Khong download duoc video. MediaId: ' + mediaId + ' rawId: ' + rawId);
}

/**
 * Kiem tra trang thai video truc tiep tu background
 */
async function checkStatusDirect(endpoint, body) {
    const FLOW_API = 'https://aisandbox-pa.googleapis.com/v1';
    const response = await fetch(FLOW_API + endpoint, {
        method: 'POST',
        headers: {
            'authorization': sessionData.bearerToken || '',
            'x-browser-validation': sessionData.xbv || '',
            'content-type': 'text/plain;charset=UTF-8',
            'accept': '*/*',
            'origin': 'https://labs.google',
            'referer': 'https://labs.google/',
        },
        body,
    });
    const text = await response.text();
    console.log('[Komfy Status] Status:', response.status);
    return { ok: response.ok, status: response.status, body: text };
}

// Lang nghe tin nhan
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'UPDATE_XBV' && message.xbv) {
        sessionData.xbv = message.xbv;
        if (message.projectId && !sessionData.projectId) sessionData.projectId = message.projectId;
        sendToProxy();
    }
    if (message.action === 'UPDATE_STATE') {
        if (message.projectId && !sessionData.projectId) { sessionData.projectId = message.projectId; sendToProxy(); }
    }
    if (message.action === 'GET_STATE') { sendResponse(sessionData); return true; }
    if (message.action === 'FORCE_SYNC') { sendToProxy().finally(() => sendResponse(sessionData)); return true; }
    if (message.action === 'DEBUG_LOG') {
        console.log('[Komfy Content]', message.msg);
        fetch('http://127.0.0.1:3120/debug/log', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: message.msg })
        }).catch(() => { });
    }
    if (message.action === 'UI_RESULT') {
        const cb = uiCallbacks.get(message.requestId);
        if (cb) { uiCallbacks.delete(message.requestId); cb(message); }
    }
});

// Da duoc dinh nghia o dau file
// const PROXY_URL = 'http://127.0.0.1:3120/api/internal/update-session';
// const PROXY_EXECUTE_URL = 'http://127.0.0.1:3120/api/internal/execute-request';

// =========================================================
// LONG-POLL: Nhan lenh tu server
// =========================================================
async function pollForApiRequests() {
    while (true) {
        try {
            if (!sessionData.clientId) { await new Promise(r => setTimeout(r, 1000)); continue; }
            const res = await fetch(PROXY_EXECUTE_URL + '/poll?clientId=' + sessionData.clientId, {
                method: 'GET',
                signal: AbortSignal.timeout(58000), // Khop voi POLL_TIMEOUT_MS=55s + buffer
            });

            if (res.ok) {
                const task = await res.json();
                if (task && task.requestId) {
                    console.log('[Komfy] Task received:', task.endpoint, '| hasToken:', !!sessionData.bearerToken);
                    let result;
                    try {
                        if (task.endpoint.includes('batchAsyncGenerateVideoText')) {
                            // Video generation: ensureFlowTab() tu dong mo tab + cho token neu can
                            const body = JSON.parse(task.body);
                            const parts = body.requests && body.requests[0] && body.requests[0].textInput &&
                                body.requests[0].textInput.structuredPrompt && body.requests[0].textInput.structuredPrompt.parts;
                            const prompt = (parts && parts[0] && parts[0].text) || 'A beautiful scene';
                            const aspectRatio = (body.requests[0] && body.requests[0].videoGenerationConfig && body.requests[0].videoGenerationConfig.aspectRatio) || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
                            console.log('[Komfy] Video task | aspectRatio:', aspectRatio, '| prompt:', prompt.substring(0, 40));
                            result = await generateViaUI(prompt, aspectRatio);

                        } else if (task.endpoint.includes('batchGenerateImages')) {
                            // Image generation (Nano Banana 2 / Pro): tu dong chuyen sang Image mode
                            const body = JSON.parse(task.body);
                            const prompt = body.prompt || body.textInput?.structuredPrompt?.parts?.[0]?.text || 'A beautiful image';
                            const aspectRatio = body.aspectRatio || 'Auto';
                            const modelName = body.modelName || 'Nano Banana 2';
                            console.log('[Komfy] Image task | model:', modelName, '| aspectRatio:', aspectRatio, '| prompt:', prompt.substring(0, 40));
                            result = await generateImageViaUI(prompt, aspectRatio, modelName);

                        } else if (task.endpoint === 'DOWNLOAD_MEDIA_BLOB') {
                            if (!sessionData.bearerToken) {
                                console.log('[Komfy] DOWNLOAD: Cho token (toi da 25s)...');
                                const started = Date.now();
                                while (!sessionData.bearerToken && Date.now() - started < 25000) {
                                    await new Promise(r => setTimeout(r, 500));
                                }
                            }
                            result = await downloadBlobViaCDP(task.body);

                        } else {
                            if (!sessionData.bearerToken) {
                                console.log('[Komfy] STATUS: Cho token (toi da 25s)...');
                                const started = Date.now();
                                while (!sessionData.bearerToken && Date.now() - started < 25000) {
                                    await new Promise(r => setTimeout(r, 500));
                                }
                                if (!sessionData.bearerToken) {
                                    throw new Error('Khong co Google session token. Vui long mo tab Google Flow va dang nhap.');
                                }
                            }
                            result = await checkStatusDirect(task.endpoint, task.body);
                        }
                    } catch (e) {
                        const errMsg = e.message || String(e);
                        console.error('[Komfy] Task error:', errMsg);
                        fetch('http://127.0.0.1:3120/debug/log', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ msg: '[Extension Error] ' + errMsg }),
                        }).catch(() => {});
                        result = { ok: false, status: 0, error: errMsg };
                    }

                    fetch(PROXY_EXECUTE_URL + '/respond', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ requestId: task.requestId, clientId: sessionData.clientId, result }),
                    }).catch(() => {});
                }
            }
        } catch (e) {
            if (!e.message || !e.message.includes('aborted')) console.warn('[Komfy Poll]', e.message);
            await new Promise(r => setTimeout(r, 500)); // Giam tu 2s xuong 500ms
        }
    }
}

pollForApiRequests();

// Bat headers de cap nhat credentials
// Chi lang nghe cac domain can thiet (Google APIs + labs.google)
// Tranh bat toan bo moi request cua Chrome (YouTube, Gmail, ...)
const TOKEN_CAPTURE_URLS = [
    '*://labs.google/*',
    '*://aisandbox-pa.googleapis.com/*',
    '*://generativeai-pa.googleapis.com/*',
    '*://firebasevertexai.googleapis.com/*',
];

chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        let needsSync = false;

        const auth = details.requestHeaders.find(h => h.name.toLowerCase() === 'authorization');
        if (auth && auth.value && auth.value.startsWith('Bearer ') && sessionData.bearerToken !== auth.value) {
            sessionData.bearerToken = auth.value;
            needsSync = true;
        }
        const xbv = details.requestHeaders.find(h => h.name.toLowerCase() === 'x-browser-validation');
        if (xbv && sessionData.xbv !== xbv.value) {
            sessionData.xbv = xbv.value;
            needsSync = true;
        }
        const match = details.url.match(/projects\/([^\/]+)\/locations/);
        if (match && sessionData.projectId !== match[1]) {
            sessionData.projectId = match[1];
            needsSync = true;
            // Luu projectId vao storage de khoi phuc sau khi reload/restart
            chrome.storage.local.set({ komfyProjectId: match[1] });
            console.log('[Komfy] ProjectId captured & cached:', match[1].substring(0, 16) + '...');
        }

        // Chi goi sendToProxy 1 lan neu co thay doi (tranh spam nhieu call trong 1 request)
        if (needsSync) sendToProxy().catch(() => {});

        return { requestHeaders: details.requestHeaders };
    },
    { urls: TOKEN_CAPTURE_URLS },
    ['requestHeaders', 'extraHeaders']
);
