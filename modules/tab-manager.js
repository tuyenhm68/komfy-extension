// Tab management: find, wait, ensure Flow tab.

async function findFlowTab() {
    const tabs = await chrome.tabs.query({});
    const flowTabs = tabs.filter(t => t.url && t.url.includes('labs.google'));
    if (flowTabs.length === 0) return null;
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
 * Xoa cache project (single-key storage).
 */
async function clearProjectCache() {
    console.log('[Komfy] Xoa cache project "' + KOMFY_FIXED_PROJECT + '"...');
    // Clear in-memory verification timestamp
    delete _projectVerifiedAt[KOMFY_FIXED_PROJECT];
    await chrome.storage.local.remove('komfySingleProjectId');
    sessionData.projectId = null;
    console.log('[Komfy] Da xoa cache project.');
}


/**
 * Scan home page de kiem tra project con ton tai khong.
 *
 * STRATEGY (theo do tin cay giam dan):
 * 1. Neu co cachedProjectId: tim thang link /project/{cachedProjectId} trong DOM
 *    â†’ Neu tim thay: project van con ton tai, dung URL do luon (NHANH, CHINH XAC)
 * 2. Neu khong co ID (hoac ID khong tim thay): scan theo ten
 *    â†’ Match exact roi includes voi targetProjectName
 *
 * @param {string} tabId
 * @param {string} targetProjectName - Ten can tim ('komfy-studio')
 * @param {string|null} cachedProjectId - Project ID da luu tu truoc (uu tien tim truoc)
 * @returns {string|null} href URL cua project neu tim thay, null neu khong co
 */
async function scanHomeForProject(tabId, targetProjectName, cachedProjectId = null) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let projectUrl = null;

    for (let attempt = 0; attempt < 4 && !projectUrl; attempt++) {
        const scanResult = await chrome.scripting.executeScript({
            target: { tabId },
            func: (targetName, projectId) => {
                const links = [...document.querySelectorAll('a[href]')];
                const projectLinks = links.filter(a => a.href && a.href.includes('/tools/flow/project/'));

                // === STRATEGY 1: Tim theo project ID (nhanh, chinh xac) ===
                if (projectId) {
                    for (const link of projectLinks) {
                        if (link.href.includes('/project/' + projectId)) {
                            return { url: link.href, found: true, strategy: 'id-match', name: projectId.substring(0, 12) };
                        }
                    }
                }

                // === STRATEGY 2: scan ten voi [KS] prefix matching ===
                // Format: "[KS] {workflowName}" â€” prefix luon nam dau, DOM noise chi ghep o cuoi
                const KS = '[KS] ';
                const target = targetName; // full name, e.g. "[KS] UGC Ads"

                // Lay raw text tu tung project link (parent container text)
                const projectEntries = [];
                for (const link of projectLinks) {
                    // Lay text tu nhieu nguon: parent, sibling, aria-label
                    let name = '';

                    // Parent container text (bao trum nhat)
                    const card = link.closest('[class]') || link.parentElement;
                    if (card) {
                        // Lay text nhung bo cac button/interactive text
                        const clone = card.cloneNode(true);
                        clone.querySelectorAll('button, [role="button"], svg, [aria-hidden="true"]').forEach(el => el.remove());
                        name = clone.textContent.trim();
                    }

                    // Fallback: sibling text
                    if (!name) {
                        let sib = link.nextSibling;
                        for (let i = 0; i < 5 && sib; i++) {
                            const txt = (sib.textContent || '').trim();
                            if (txt.length > 0 && txt.length < 200) { name = txt; break; }
                            sib = sib.nextSibling;
                        }
                    }

                    // Fallback: aria-label, title
                    if (!name) {
                        name = link.getAttribute('aria-label') || link.getAttribute('title') || link.textContent.trim() || '';
                    }

                    if (name) projectEntries.push({ raw: name, url: link.href });
                }

                // --- MATCHING: tim [KS] prefix trong raw text ---
                // targetName da co prefix "[KS] " (tu caller)
                // DOM text co the la: "[KS] My Workflowprojectproject" hoac "[KS] My Workflow Edit project"
                // Match: raw text CHUA target name, va ky tu ngay sau target la non-alphanumeric hoac het chuoi

                // Priority 1: Exact â€” raw text chua CHINH XAC target (ke ca co noise phia sau)
                for (const entry of projectEntries) {
                    const raw = entry.raw;
                    const idx = raw.indexOf(target);
                    if (idx === -1) continue;
                    // Boundary check: ky tu ngay sau target phai la non-alphanumeric, space, hoac end
                    const afterIdx = idx + target.length;
                    if (afterIdx >= raw.length) {
                        return { url: entry.url, found: true, strategy: 'exact', name: target };
                    }
                    const charAfter = raw[afterIdx];
                    // Cho phep: space, punctuation, button text bat dau (khong phai a-z, A-Z, 0-9, -, _)
                    // Ngan chan: "[KS] Test" match "[KS] Test Campaign"
                    if (!/[a-zA-Z0-9\u00C0-\u024F_-]/.test(charAfter)) {
                        return { url: entry.url, found: true, strategy: 'exact-boundary', name: target };
                    }
                }

                // Priority 2: Loose â€” target chua [KS] prefix, tim bat ky entry nao co [KS] + workflow name
                // Truong hop ten bi split boi DOM structure
                const workflowPart = target.startsWith(KS) ? target.substring(KS.length) : target;
                for (const entry of projectEntries) {
                    const raw = entry.raw;
                    if (!raw.includes(KS) && !raw.includes('[KS]')) continue;
                    if (raw.includes(workflowPart)) {
                        // Boundary check cho workflow name
                        const wIdx = raw.indexOf(workflowPart);
                        const wAfter = wIdx + workflowPart.length;
                        if (wAfter >= raw.length || !/[a-zA-Z0-9\u00C0-\u024F_-]/.test(raw[wAfter])) {
                            return { url: entry.url, found: true, strategy: 'ks-loose', name: raw.substring(0, 60) };
                        }
                    }
                }

                // Priority 3: Legacy fallback â€” tim project cu chua co [KS] prefix (migration)
                const legacyTarget = workflowPart.toLowerCase();
                for (const entry of projectEntries) {
                    const rawLow = entry.raw.toLowerCase();
                    // Tim "komfy-studio" hoac "{workflowName} - komfy-studio" (format cu)
                    if (rawLow.includes(legacyTarget) && rawLow.includes('komfy')) {
                        return { url: entry.url, found: true, strategy: 'legacy', name: entry.raw.substring(0, 60) };
                    }
                }

                return {
                    found: false,
                    total: projectLinks.length,
                    names: projectEntries.map(e => (e.raw || '').substring(0, 50)).slice(0, 10),
                };
            },
            args: [targetProjectName, cachedProjectId],
        }).catch(e => {
            console.warn('[Komfy] Scan script error:', e.message);
            return [{ result: { found: false } }];
        });

        const result = scanResult?.[0]?.result;
        if (result?.found) {
            projectUrl = result.url;
            console.log('[Komfy] âœ… Tim thay project (' + result.strategy + '):', result.name, 'â†’', projectUrl.substring(0, 80));
        } else {
            console.log('[Komfy] Attempt ' + (attempt + 1) + '/4: Chua thay (total links: ' + (result?.total || 0) + ', names: ' + JSON.stringify(result?.names || []) + ')');
            await sleep(1500 + Math.random() * 1500); // 1.5-3s jitter between scan retries
        }
    }

    return projectUrl;
}

/**
 * Mo tab Google Flow neu chua co. Cho tab load xong roi tra ve tab.
 *
 * STRATEGY:
 * - Neu co cachedProjectId â†’ navigate thang toi project
 *   â†’ Sau khi load, neu credentials capture duoc â†’ dung luon (FAST PATH)
 *   â†’ Neu credentials fail â†’ co the project bi xoa â†’ navigate home â†’ scan â†’ create
 * - Neu KHONG co cachedProjectId â†’ navigate home â†’ scan theo ten â†’ create neu khong tim thay
 *
 * @param {boolean} focusTab - Focus tab sau khi mo
 * @param {string} projectName - Ten project (default: 'komfy-studio')
 */
// Lock to prevent concurrent ensureFlowTab calls (race condition between auto-recovery and task execution)
let _ensureFlowTabPromise = null;

async function ensureFlowTab(focusTab = true, projectName = null) {
    // If another ensureFlowTab is already running, wait for it instead of racing
    if (_ensureFlowTabPromise) {
        console.log('[Komfy] ensureFlowTab already running -> waiting for existing call...');
        try {
            return await _ensureFlowTabPromise;
        } catch (e) {
            console.log('[Komfy] Previous ensureFlowTab failed, retrying...');
        }
    }

    const promise = _ensureFlowTabInner(focusTab);
    _ensureFlowTabPromise = promise;
    try {
        const result = await promise;
        return result;
    } finally {
        if (_ensureFlowTabPromise === promise) _ensureFlowTabPromise = null;
    }
}

async function _ensureFlowTabInner(focusTab) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // Always use the fixed project name
    const targetProjectName = KOMFY_FIXED_PROJECT;

    // â˜… CREDENTIAL-ONLY MODE: called from auto-recovery (no project navigation)
    if (!focusTab && focusTab !== true) {
        // Keep original credential-only behaviour when called with focusTab=false from sendToProxy
    }

    // --- Buoc 1: Tim hoac tao Flow tab ---
    let tab = await findFlowTab();
    let tabId;

    if (tab) {
        tabId = tab.id;
        console.log('[Komfy] Tim thay tab Flow:', tab.url?.substring(0, 80));
        if (focusTab) {
            await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        }
    } else {
        console.log('[Komfy] Mo Flow home page...', focusTab ? '(focus)' : '(background)');
        tab = await chrome.tabs.create({ url: FLOW_URL, active: focusTab });
        tabId = tab.id;
        await waitForTabLoad(tabId, 20000).catch(e => console.warn('[Komfy]', e.message));
    }

    // --- Buoc 2: Doc locale va cached project ID ---
    const currentTabInfo = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
    const currentUrl = currentTabInfo.url || '';
    const locMatch = currentUrl.match(/\/fx(\/[a-z]{2}(?:-[a-z]{2})?)?\/tools\/flow/);
    const savedLoc = locMatch?.[1] || '';
    const storedData = await new Promise(r => chrome.storage.local.get(['komfySingleProjectId', 'komfyLocale'], r));
    const storedLocale = storedData.komfyLocale || savedLoc;

    // Read single cached project ID
    let cachedProjectId = storedData.komfySingleProjectId || null;

    // Legacy migration: komfyProjectMap -> komfySingleProjectId (one-time)
    if (!cachedProjectId) {
        const legacy = await new Promise(r => chrome.storage.local.get(['komfyProjectMap', 'komfyProjectId'], r));
        const legacyMap = legacy.komfyProjectMap || {};
        // Try to find this fixed project name in the old map first
        const fromMap = legacyMap[KOMFY_FIXED_PROJECT]
            || legacyMap['[KS] komfy-studio']
            || legacyMap['komfy-studio']
            || legacy.komfyProjectId
            || null;
        if (fromMap) {
            cachedProjectId = fromMap;
            await chrome.storage.local.set({ komfySingleProjectId: cachedProjectId });
            await chrome.storage.local.remove(['komfyProjectMap', 'komfyProjectId']);
            console.log('[Komfy] Migrated legacy cache -> komfySingleProjectId:', cachedProjectId.substring(0, 16) + '...');
        }
    }

    const homeUrl = `https://labs.google/fx${storedLocale}/tools/flow`;

    // =========================================================
    // === FAST PATH: Co cached projectId -> navigate thang  ===
    // =========================================================
    if (cachedProjectId) {
        const projectUrl = `https://labs.google/fx${storedLocale}/tools/flow/project/${cachedProjectId}`;
        const alreadyOnProject = currentUrl.includes(`/project/${cachedProjectId}`);

        let projectDeleted = false;

        if (alreadyOnProject) {
            const VERIFY_STALE_MS = 2 * 60 * 1000;
            const lastVerified = _projectVerifiedAt[cachedProjectId] || 0;
            const isStale = Date.now() - lastVerified > VERIFY_STALE_MS;

            if (sessionData.bearerToken && sessionData.projectId === cachedProjectId && !isStale) {
                console.log('[Komfy] Fast Path: Tab on correct project + credentials OK + recently verified -> SKIP reload.');
                return await chrome.tabs.get(tabId).catch(() => tab);
            }
            if (sessionData.bearerToken && sessionData.projectId === cachedProjectId && isStale) {
                console.log('[Komfy] [Fast Path] Credentials OK but stale -> verifying via API...');
                let isAlive = true;
                try {
                    const input = encodeURIComponent(JSON.stringify({ json: { projectId: cachedProjectId } }));
                    const trpcUrl = `https://labs.google/fx/api/trpc/flow.projectInitialData?input=${input}`;
                    
                    const res = await fetch(trpcUrl, {
                        method: 'GET',
                        headers: {
                            'authorization': `Bearer ${sessionData.bearerToken}`,
                            'accept': 'application/json'
                        }
                    });
                    
                    // User reported that deleted projects return 400
                    if (!res.ok) {
                        isAlive = false;
                        console.warn(`[Komfy] API Verify Failed: HTTP ${res.status}`);
                    } else {
                        // Check JSON body for tRPC errors just in case
                        const json = await res.json().catch(() => null);
                        if (json && json.error) {
                            isAlive = false;
                            console.warn(`[Komfy] API Verify Failed: TRPC Error`, json.error);
                        }
                    }
                } catch (e) {
                    console.error('[Komfy] API Check Project Error:', e);
                    // On network error, assume alive to fallback to normal behavior
                }

                if (isAlive) {
                    _projectVerifiedAt[cachedProjectId] = Date.now();
                    console.log('[Komfy] [Fast Path] Project is ALIVE via API!');
                    return await chrome.tabs.get(tabId).catch(() => tab);
                } else {
                    console.warn('[Komfy] [Fast Path] Project DELETED -> fall to slow path');
                    await clearProjectCache();
                    projectDeleted = true;
                }
            }

            if (!projectDeleted) {
                if (sessionData.projectId && sessionData.projectId !== cachedProjectId) {
                    sessionData.projectId = null;
                }
                console.log('[Komfy] Tab on correct project but no credentials -> reload...');
                await chrome.tabs.reload(tabId);
            }
        } else if (!projectDeleted) {
            if (sessionData.projectId && sessionData.projectId !== cachedProjectId) {
                sessionData.projectId = null;
            }
            console.log('[Komfy] Navigate to cached project:', projectUrl.substring(0, 80));
            await chrome.tabs.update(tabId, { url: projectUrl });
        }

        if (!projectDeleted) {
            await waitForTabLoad(tabId, 20000).catch(e => console.warn('[Komfy]', e.message));
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});

            console.log('[Komfy] [Fast Path] Cho credentials (expected projectId:', cachedProjectId.substring(0, 12) + '...)');
            const fastStart = Date.now();
            while (Date.now() - fastStart < 20000) {
                if (sessionData.bearerToken && sessionData.projectId === cachedProjectId) {
                    console.log('[Komfy] [Fast Path] Credentials OK! projectId:', sessionData.projectId.substring(0, 12));
                    await chrome.storage.local.set({ komfySingleProjectId: sessionData.projectId });
                    _projectVerifiedAt[cachedProjectId] = Date.now();
                    return await chrome.tabs.get(tabId).catch(() => tab);
                }
                await sleep(500);
            }
            console.warn('[Komfy] [Fast Path] Failed -> falling to slow path');
            await clearProjectCache();
        }
    }

    // =========================================================
    // === SLOW PATH: Navigate home -> scan -> navigate/create ===
    // =========================================================
    sessionData.projectId = null;

    const slowPathTab = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
    const slowPathUrl = slowPathTab.url || '';
    console.log('[Komfy] [Slow Path] Current URL:', slowPathUrl.substring(0, 80), '-> Navigate to home:', homeUrl);
    const alreadyAtHome = slowPathUrl.includes('/tools/flow') && !slowPathUrl.includes('/project/');
    if (alreadyAtHome) {
        await chrome.tabs.reload(tabId);
    } else {
        await chrome.tabs.update(tabId, { url: homeUrl });
    }
    await waitForTabLoad(tabId, 20000).catch(e => console.warn('[Komfy]', e.message));

    // Detect locale from post-redirect URL
    const postHomeInfo = await chrome.tabs.get(tabId).catch(() => ({ url: homeUrl }));
    const postHomeUrl = postHomeInfo.url || homeUrl;
    const localeMatch = postHomeUrl.match(/\/fx(\/[a-z]{2}(?:-[a-z]{2})?)?\/tools\/flow/);
    const localePrefix = localeMatch?.[1] || storedLocale || '';
    await chrome.storage.local.set({ komfyLocale: localePrefix });

    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});

    await humanDelay(2500, 4000);

    // Scan for fixed project by ID first, then by name
    const freshCachedId = (await new Promise(r => chrome.storage.local.get(['komfySingleProjectId'], r))).komfySingleProjectId || null;
    console.log('[Komfy] Scan home page... (freshCached ID:', freshCachedId?.substring(0, 12) || 'none', ')');
    const foundProjectUrl = await scanHomeForProject(tabId, targetProjectName, freshCachedId);

    if (foundProjectUrl) {
        console.log('[Komfy] Navigate to project:', foundProjectUrl.substring(0, 80));
        await chrome.tabs.update(tabId, { url: foundProjectUrl });
        await waitForTabLoad(tabId, 20000).catch(e => console.warn('[Komfy]', e.message));
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});

        const freshIdMatch = foundProjectUrl.match(/\/project\/([a-zA-Z0-9_-]+)/);
        if (freshIdMatch) {
            await chrome.storage.local.set({ komfySingleProjectId: freshIdMatch[1] });
            console.log('[Komfy] Cache updated: komfySingleProjectId =', freshIdMatch[1].substring(0, 16) + '...');
        }
    } else {
        // First time: create the single fixed project
        console.log('[Komfy] Project "' + targetProjectName + '" not found -> Creating (one-time setup)...');
        await createAndRenameProject(tabId, targetProjectName);
    }

    // --- Wait for credentials ---
    const postNavTab = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
    const postNavUrl = postNavTab.url || '';
    const expectedIdMatch = postNavUrl.match(/\/project\/([a-zA-Z0-9_-]+)/);
    const expectedProjectId = expectedIdMatch ? expectedIdMatch[1] : null;
    console.log('[Komfy] Cho credentials... (expected projectId:', (expectedProjectId || 'unknown').substring(0, 12) + ')');

    const start = Date.now();
    while (Date.now() - start < 25000) {
        const pidOk = sessionData.projectId && (!expectedProjectId || sessionData.projectId === expectedProjectId);
        if (sessionData.bearerToken && pidOk) {
            console.log('[Komfy] Da co credentials! projectId:', sessionData.projectId.substring(0, 12));
            await chrome.storage.local.set({ komfySingleProjectId: sessionData.projectId });
            break;
        }
        await sleep(500);
    }

    if (!sessionData.bearerToken) throw new Error('Khong co Google session. Hay dang nhap vao Google Flow truoc.');
    if (!sessionData.projectId) throw new Error('Khong lay duoc Project ID. Vui long mo Google Flow va vao 1 project.');

    return await chrome.tabs.get(tabId).catch(() => tab);
}


