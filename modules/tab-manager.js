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
 * Xoa toan bo cache project (local storage + session storage + memory).
 * QUAN TRONG: phai clear session storage de tranh service worker restore lai!
 */
async function clearProjectCache(targetProjectName) {
    console.log('[Komfy] Xoa cache project "' + targetProjectName + '"...');
    const staleMap = (await new Promise(r => chrome.storage.local.get(['komfyProjectMap'], r))).komfyProjectMap || {};
    // Clean _projectVerifiedAt for the old projectId
    const oldId = staleMap[targetProjectName];
    if (oldId && typeof _projectVerifiedAt !== 'undefined') delete _projectVerifiedAt[oldId];
    delete staleMap[targetProjectName];
    await chrome.storage.local.set({ komfyProjectMap: staleMap });
    sessionData.projectId = null;
    console.log('[Komfy] Da xoa cache project.');
}

/**
 * Scan home page de kiem tra project con ton tai khong.
 *
 * STRATEGY (theo do tin cay giam dan):
 * 1. Neu co cachedProjectId: tim thang link /project/{cachedProjectId} trong DOM
 *    → Neu tim thay: project van con ton tai, dung URL do luon (NHANH, CHINH XAC)
 * 2. Neu khong co ID (hoac ID khong tim thay): scan theo ten
 *    → Match exact roi includes voi targetProjectName
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
                // Format: "[KS] {workflowName}" — prefix luon nam dau, DOM noise chi ghep o cuoi
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

                // Priority 1: Exact — raw text chua CHINH XAC target (ke ca co noise phia sau)
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

                // Priority 2: Loose — target chua [KS] prefix, tim bat ky entry nao co [KS] + workflow name
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

                // Priority 3: Legacy fallback — tim project cu chua co [KS] prefix (migration)
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
            console.log('[Komfy] ✅ Tim thay project (' + result.strategy + '):', result.name, '→', projectUrl.substring(0, 80));
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
 * - Neu co cachedProjectId → navigate thang toi project
 *   → Sau khi load, neu credentials capture duoc → dung luon (FAST PATH)
 *   → Neu credentials fail → co the project bi xoa → navigate home → scan → create
 * - Neu KHONG co cachedProjectId → navigate home → scan theo ten → create neu khong tim thay
 *
 * @param {boolean} focusTab - Focus tab sau khi mo
 * @param {string} projectName - Ten project (default: 'komfy-studio')
 */
// Lock to prevent concurrent ensureFlowTab calls (race condition between auto-recovery and task execution)
let _ensureFlowTabPromise = null;

async function ensureFlowTab(focusTab = true, projectName = null) {
    // If another ensureFlowTab is already running, wait for it instead of racing
    if (_ensureFlowTabPromise) {
        console.log('[Komfy] ensureFlowTab already running → waiting for existing call...');
        try {
            return await _ensureFlowTabPromise;
        } catch (e) {
            // Previous call failed, proceed with our own attempt
            console.log('[Komfy] Previous ensureFlowTab failed, retrying...');
        }
    }

    const promise = _ensureFlowTabInner(focusTab, projectName);
    _ensureFlowTabPromise = promise;
    try {
        const result = await promise;
        return result;
    } finally {
        // Only clear if we're still the current promise (not replaced by a new call)
        if (_ensureFlowTabPromise === promise) _ensureFlowTabPromise = null;
    }
}

async function _ensureFlowTabInner(focusTab, projectName) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ★ CREDENTIAL-ONLY MODE: projectName === null (auto-recovery)
    // Chi can lay credentials (bearerToken), KHONG touch projectMap, KHONG navigate sang project khac
    if (!projectName) {
        console.log('[Komfy] [Credential-Only] Recovery mode — chi lay credentials, khong thay doi project');
        let tab = await findFlowTab();
        let tabId;
        if (tab) {
            tabId = tab.id;
            if (!sessionData.bearerToken) {
                await chrome.tabs.reload(tabId);
                await waitForTabLoad(tabId, 20000).catch(() => {});
                await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
                await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});
            }
        } else {
            tab = await chrome.tabs.create({ url: FLOW_URL, active: false });
            tabId = tab.id;
            await waitForTabLoad(tabId, 20000).catch(() => {});
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});
        }
        // Cho credentials toi da 15s
        const crStart = Date.now();
        while (Date.now() - crStart < 15000) {
            if (sessionData.bearerToken) {
                console.log('[Komfy] [Credential-Only] ✅ Credentials captured.');
                return await chrome.tabs.get(tabId).catch(() => tab);
            }
            await sleep(500);
        }
        console.warn('[Komfy] [Credential-Only] Timeout — khong lay duoc credentials');
        return await chrome.tabs.get(tabId).catch(() => tab);
    }

    // Build full project name with [KS] prefix
    // projectName from caller can be:
    //   "[KS] UGC Ads"              → new format, use as-is
    //   "UGC Ads - komfy-studio"    → legacy format, strip suffix + add prefix
    //   "UGC Ads"                   → raw workflow name, add prefix
    let targetProjectName;
    const raw = projectName || '';
    if (raw.startsWith(KOMFY_PROJECT_PREFIX)) {
        // Already has [KS] prefix — use as-is
        targetProjectName = raw;
    } else if (raw) {
        // Strip legacy suffix if present, then add prefix
        const cleaned = raw.replace(/\s*-\s*komfy-studio$/i, '');
        targetProjectName = KOMFY_PROJECT_PREFIX + cleaned;
    } else {
        targetProjectName = KOMFY_PROJECT_PREFIX + KOMFY_PROJECT_NAME;
    }

    // --- Buoc 1: Tim hoac tao Flow tab ---
    let tab = await findFlowTab();
    let tabId;

    if (tab) {
        tabId = tab.id;
        console.log('[Komfy] Tim thay tab Flow:', tab.url?.substring(0, 80));
        if (focusTab) {
            // Only activate tab within window — do NOT focus the window
            // (chrome.windows.update focused:true steals OS focus from user's current app)
            await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        }
    } else {
        console.log('[Komfy] Mo Flow home page...', focusTab ? '(focus)' : '(background)');
        tab = await chrome.tabs.create({ url: FLOW_URL, active: focusTab });
        tabId = tab.id;
        await waitForTabLoad(tabId, 20000).catch(e => console.warn('[Komfy]', e.message));
    }

    // --- Buoc 2: Doc locale va cached project info ---
    const currentTabInfo = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
    const currentUrl = currentTabInfo.url || '';
    const locMatch = currentUrl.match(/\/fx(\/[a-z]{2}(?:-[a-z]{2})?)?\/tools\/flow/);
    const savedLoc = locMatch?.[1] || '';
    const storedData = await new Promise(r => chrome.storage.local.get(['komfyProjectMap', 'komfyProjectId', 'komfyLocale'], r));
    const storedLocale = storedData.komfyLocale || savedLoc;
    const projectMap = storedData.komfyProjectMap || {};

    // Migration: komfyProjectId cu → projectMap moi (one-time)
    let mapChanged = false;
    if (storedData.komfyProjectId) {
        const pid = storedData.komfyProjectId;
        // Only migrate if this ID isn't already cached under any [KS] key
        const alreadyCached = Object.entries(projectMap).some(([k, v]) => k.startsWith(KOMFY_PROJECT_PREFIX) && v === pid);
        if (!alreadyCached && !projectMap[KOMFY_PROJECT_PREFIX + KOMFY_PROJECT_NAME]) {
            projectMap[KOMFY_PROJECT_PREFIX + KOMFY_PROJECT_NAME] = pid;
            mapChanged = true;
            console.log('[Komfy] Migrated komfyProjectId →', KOMFY_PROJECT_PREFIX + KOMFY_PROJECT_NAME);
        } else if (alreadyCached) {
            console.log('[Komfy] komfyProjectId already cached under [KS] key, skipping migration');
        }
        // Remove legacy storage key — AWAIT to prevent re-migration
        await chrome.storage.local.remove('komfyProjectId');
    }

    // Migration: legacy keys "{name} - komfy-studio" → "[KS] {name}" + DELETE legacy key
    const legacyKeys = [];
    for (const key of Object.keys(projectMap)) {
        if (key.startsWith(KOMFY_PROJECT_PREFIX)) continue;
        const legacyMatch = key.match(/^(.+?)\s*-\s*komfy-studio$/i);
        if (legacyMatch) {
            const newKey = KOMFY_PROJECT_PREFIX + legacyMatch[1];
            if (!projectMap[newKey]) {
                projectMap[newKey] = projectMap[key];
                console.log('[Komfy] Migrated cache key:', key, '→', newKey);
            }
            legacyKeys.push(key);
        }
    }
    // Migrate bare "komfy-studio" → "[KS] komfy-studio" + DELETE bare key
    if (projectMap[KOMFY_PROJECT_NAME]) {
        if (!projectMap[KOMFY_PROJECT_PREFIX + KOMFY_PROJECT_NAME]) {
            projectMap[KOMFY_PROJECT_PREFIX + KOMFY_PROJECT_NAME] = projectMap[KOMFY_PROJECT_NAME];
            console.log('[Komfy] Migrated cache key:', KOMFY_PROJECT_NAME, '→', KOMFY_PROJECT_PREFIX + KOMFY_PROJECT_NAME);
        }
        legacyKeys.push(KOMFY_PROJECT_NAME);
    }
    // Delete all legacy keys after migration
    if (legacyKeys.length > 0) {
        for (const lk of legacyKeys) delete projectMap[lk];
        mapChanged = true;
        console.log('[Komfy] Deleted legacy keys:', legacyKeys.join(', '));
    }
    if (mapChanged) {
        await chrome.storage.local.set({ komfyProjectMap: projectMap });
    }

    let cachedProjectId = projectMap[targetProjectName] || null;

    // ★ DEDUP: Mot projectId chi duoc thuoc VE MOT project name.
    // Neu cung 1 ID xuat hien o nhieu key → cache bi nhiem (cross-contaminated) → xoa het, de slow path verify lai
    if (cachedProjectId) {
        const conflictKeys = Object.keys(projectMap).filter(k => k !== targetProjectName && projectMap[k] === cachedProjectId);
        if (conflictKeys.length > 0) {
            console.warn('[Komfy] ⚠️ ProjectId ' + cachedProjectId.substring(0, 12) + ' cached under MULTIPLE names:', [targetProjectName, ...conflictKeys].join(', '), '→ clearing all duplicates');
            for (const ck of conflictKeys) delete projectMap[ck];
            // Khong tin cache entry nay — de slow path scan DOM de xac dinh project that
            delete projectMap[targetProjectName];
            cachedProjectId = null;
            await chrome.storage.local.set({ komfyProjectMap: projectMap });
        }
    }

    // ★ VALIDATE: Neu tab dang o project khac voi cachedProjectId, va URL co project ID khac
    // thi khong nen tin sessionData.projectId — clear no di
    const urlProjectMatch = currentUrl.match(/\/project\/([a-zA-Z0-9_-]+)/);
    const urlProjectId = urlProjectMatch ? urlProjectMatch[1] : null;
    if (urlProjectId && cachedProjectId && urlProjectId !== cachedProjectId) {
        console.log('[Komfy] Tab dang o project', urlProjectId.substring(0, 12), 'nhung can project', cachedProjectId.substring(0, 12), '→ se navigate');
    }

    const homeUrl = `https://labs.google/fx${storedLocale}/tools/flow`;

    // =========================================================
    // === FAST PATH: Co cached projectId → navigate thang ===
    // =========================================================
    if (cachedProjectId) {
        const projectUrl = `https://labs.google/fx${storedLocale}/tools/flow/project/${cachedProjectId}`;
        const alreadyOnProject = currentUrl.includes(`/project/${cachedProjectId}`);

        let projectDeleted = false;

        if (alreadyOnProject) {
            // ★ Credentials khop + project da duoc verify gan day → skip reload (bao ve task dang gen)
            // Staleness check: neu chua verify trong 5 phut, phai verify lai (project co the bi xoa)
            const VERIFY_STALE_MS = 5 * 60 * 1000;
            const lastVerified = _projectVerifiedAt[cachedProjectId] || 0;
            const isStale = Date.now() - lastVerified > VERIFY_STALE_MS;

            if (sessionData.bearerToken && sessionData.projectId === cachedProjectId && !isStale) {
                console.log('[Komfy] ✅ [Fast Path] Tab dang o dung project + credentials khop + verified recently → SKIP reload.');
                return await chrome.tabs.get(tabId).catch(() => tab);
            }
            if (sessionData.bearerToken && sessionData.projectId === cachedProjectId && isStale) {
                // Credentials khop nhung chua verify gan day → verify nhanh (khong reload)
                console.log('[Komfy] [Fast Path] Credentials khop nhung project stale (>' + Math.round(VERIFY_STALE_MS / 60000) + 'min) → verifying...');
                const quickVerify = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: () => {
                        const url = window.location.href;
                        if (!url.includes('/project/')) return { ok: false, reason: 'no-project-url' };
                        const hasTextbox = !!document.querySelector('[role="textbox"], textarea, [contenteditable="true"]');
                        if (!hasTextbox) return { ok: false, reason: 'no-textbox' };
                        return { ok: true };
                    },
                }).catch(() => [{ result: { ok: true } }]);

                if (quickVerify?.[0]?.result?.ok) {
                    _projectVerifiedAt[cachedProjectId] = Date.now();
                    console.log('[Komfy] ✅ [Fast Path] Project still alive! Updated verification timestamp.');
                    return await chrome.tabs.get(tabId).catch(() => tab);
                } else {
                    const reason = quickVerify?.[0]?.result?.reason || 'unknown';
                    console.warn('[Komfy] ⚠️ [Fast Path] Project DELETED! (' + reason + ') → skip fast path, go to slow path');
                    await clearProjectCache(targetProjectName);
                    delete _projectVerifiedAt[cachedProjectId];
                    projectDeleted = true;
                    // → Skip fast path entirely, fall through to SLOW PATH below
                }
            }

            if (!projectDeleted) {
                // ProjectId khong khop hoac chua co credentials → reload de lay dung credentials
                if (sessionData.projectId && sessionData.projectId !== cachedProjectId) {
                    console.log('[Komfy] [Fast Path] sessionData.projectId (' + sessionData.projectId.substring(0, 12) + ') khong khop cachedProjectId (' + cachedProjectId.substring(0, 12) + ') → Clear stale projectId');
                    sessionData.projectId = null;
                }
                console.log('[Komfy] Tab dang o dung project nhung chua co credentials hop le → Reload de lay credentials...');
                await chrome.tabs.reload(tabId);
            }
        } else if (!projectDeleted) {
            // Navigating to a DIFFERENT project → clear stale projectId to avoid false positive in credential wait
            if (sessionData.projectId && sessionData.projectId !== cachedProjectId) {
                console.log('[Komfy] [Fast Path] Clearing stale projectId before navigating to new project');
                sessionData.projectId = null;
            }
            console.log('[Komfy] Navigate toi cached project:', projectUrl.substring(0, 80));
            await chrome.tabs.update(tabId, { url: projectUrl });
        }

        if (projectDeleted) {
            // Project bi xoa → skip toan bo fast path, nhay thang xuong slow path
            console.log('[Komfy] [Fast Path] Project deleted → skipping to SLOW PATH');
        } else {
        await waitForTabLoad(tabId, 20000).catch(e => console.warn('[Komfy]', e.message));

        // Inject scripts
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});

        // Cho credentials (fast path toi da 20s)
        // CHI CHAP NHAN credentials neu projectId KHOP voi cachedProjectId (tranh dung nham project cu)
        console.log('[Komfy] [Fast Path] Cho credentials (expected projectId:', cachedProjectId.substring(0, 12) + '...)');
        const fastStart = Date.now();
        while (Date.now() - fastStart < 20000) {
            if (sessionData.bearerToken && sessionData.projectId === cachedProjectId) {
                console.log('[Komfy] [Fast Path] Credentials captured + projectId khop. Verifying project exists...');

                // ★ VERIFY PROJECT EXISTS: Check if page shows error/deleted state
                // When navigating to a deleted project, Google Flow may:
                // - Show error page but keep URL as /project/{id}
                // - Redirect to home page
                // - Show empty project with error indicators
                // Wait a moment for any redirects to complete
                await sleep(1500);
                const verifyResult = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: (expectedProjectId) => {
                        const url = window.location.href;
                        // If redirected to home (no /project/ in URL) → project deleted
                        if (!url.includes('/project/')) return { exists: false, reason: 'redirected-to-home', url: url.substring(0, 80) };
                        // If URL has /project/ but with DIFFERENT ID → suspicious
                        if (expectedProjectId && !url.includes(expectedProjectId))
                            return { exists: false, reason: 'different-project-id', url: url.substring(0, 80) };
                        // Check for error indicators on page
                        const bodyText = document.body?.innerText || '';
                        const errorKeywords = ['not found', 'deleted', 'does not exist', 'no longer available',
                                               'không tìm thấy', 'đã bị xóa', 'không tồn tại', 'error 404',
                                               'back to projects'];
                        for (const kw of errorKeywords) {
                            if (bodyText.toLowerCase().includes(kw)) return { exists: false, reason: 'error-page: ' + kw };
                        }
                        // Check if there's a prompt textbox (functional project MUST have one)
                        const hasTextbox = !!document.querySelector('[role="textbox"], textarea, [contenteditable="true"]');
                        if (!hasTextbox) return { exists: false, reason: 'no-textbox' };
                        return { exists: true };
                    },
                    args: [cachedProjectId],
                }).catch(() => [{ result: { exists: true } }]); // If script fails, assume OK

                const projectExists = verifyResult?.[0]?.result?.exists;
                if (projectExists) {
                    console.log('[Komfy] ✅ [Fast Path] Project verified!');
                    _projectVerifiedAt[cachedProjectId] = Date.now();
                    const freshMap = (await new Promise(r => chrome.storage.local.get(['komfyProjectMap'], r))).komfyProjectMap || {};
                    freshMap[targetProjectName] = sessionData.projectId;
                    await chrome.storage.local.set({ komfyProjectMap: freshMap });
                    return await chrome.tabs.get(tabId).catch(() => tab);
                } else {
                    const reason = verifyResult?.[0]?.result?.reason || 'unknown';
                    console.warn('[Komfy] ⚠️ [Fast Path] Project NOT found! Reason:', reason, '→ falling through to SLOW PATH');
                    await clearProjectCache(targetProjectName);
                    delete _projectVerifiedAt[cachedProjectId];
                    break; // Exit fast path loop → fall through to SLOW PATH
                }
            }
            await sleep(500);
        }

        // Credentials khong capture duoc trong 20s hoac project khong ton tai
        console.warn('[Komfy] ⚠️ [Fast Path] Failed → falling through to SLOW PATH');
        await clearProjectCache(targetProjectName);
        // Fall through to SLOW PATH below
        } // end !projectDeleted else block
    }

    // =========================================================
    // === SLOW PATH: Navigate home → scan → navigate/create  ===
    // =========================================================
    // Clear stale projectId truoc khi slow path — tranh credential wait nhan nham project cu
    sessionData.projectId = null;

    // Re-read current URL (may have changed during fast path navigation/redirect)
    const slowPathTab = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
    const slowPathUrl = slowPathTab.url || '';
    console.log('[Komfy] [Slow Path] Current URL:', slowPathUrl.substring(0, 80), '→ Navigate ve home:', homeUrl);
    const alreadyAtHome = slowPathUrl.includes('/tools/flow') && !slowPathUrl.includes('/project/');
    if (alreadyAtHome) {
        await chrome.tabs.reload(tabId);
    } else {
        await chrome.tabs.update(tabId, { url: homeUrl });
    }
    await waitForTabLoad(tabId, 20000).catch(e => console.warn('[Komfy]', e.message));

    // Detect locale tu URL thuc sau redirect
    const postHomeInfo = await chrome.tabs.get(tabId).catch(() => ({ url: homeUrl }));
    const postHomeUrl = postHomeInfo.url || homeUrl;
    const localeMatch = postHomeUrl.match(/\/fx(\/[a-z]{2}(?:-[a-z]{2})?)?\/tools\/flow/);
    const localePrefix = localeMatch?.[1] || storedLocale || '';
    await chrome.storage.local.set({ komfyLocale: localePrefix });

    // Inject scripts tren home page de bat credentials
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});

    // Doi React render project list (with human-like jitter)
    await humanDelay(2500, 4000);

    // Scan: tim project theo ID truoc (neu co), roi theo ten
    const freshCached = (await new Promise(r => chrome.storage.local.get(['komfyProjectMap'], r))).komfyProjectMap?.[targetProjectName] || null;
    console.log('[Komfy] Scan home page... (freshCached ID:', freshCached?.substring(0, 12) || 'none', ')');
    const foundProjectUrl = await scanHomeForProject(tabId, targetProjectName, freshCached);

    if (foundProjectUrl) {
        // Tim thay → navigate toi project
        console.log('[Komfy] Navigate toi project:', foundProjectUrl.substring(0, 80));
        await chrome.tabs.update(tabId, { url: foundProjectUrl });
        await waitForTabLoad(tabId, 20000).catch(e => console.warn('[Komfy]', e.message));
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});

        // Cap nhat cache voi fresh ID
        const freshIdMatch = foundProjectUrl.match(/\/project\/([a-zA-Z0-9_-]+)/);
        if (freshIdMatch) {
            const freshId = freshIdMatch[1];
            const latestMap = (await new Promise(r => chrome.storage.local.get(['komfyProjectMap'], r))).komfyProjectMap || {};
            latestMap[targetProjectName] = freshId;
            await chrome.storage.local.set({ komfyProjectMap: latestMap });
            console.log('[Komfy] Cache updated:', freshId.substring(0, 16) + '...');
        }
    } else {
        // Khong tim thay → tao project moi
        console.log('[Komfy] Khong tim thay project "' + targetProjectName + '" → Tao moi...');
        await createAndRenameProject(tabId, targetProjectName);
    }

    // --- Cho credentials (toi da 25s) ---
    // Xac dinh projectId mong doi tu URL hien tai (neu da navigate toi project)
    const postNavTab = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
    const postNavUrl = postNavTab.url || '';
    const expectedIdMatch = postNavUrl.match(/\/project\/([a-zA-Z0-9_-]+)/);
    const expectedProjectId = expectedIdMatch ? expectedIdMatch[1] : null;
    console.log('[Komfy] Cho credentials... (expected projectId from URL:', (expectedProjectId || 'unknown').substring(0, 12) + ')');

    const start = Date.now();
    while (Date.now() - start < 25000) {
        // Validate: projectId phai khop voi URL (tranh nhan nham project cu)
        const pidOk = sessionData.projectId && (!expectedProjectId || sessionData.projectId === expectedProjectId);
        if (sessionData.bearerToken && pidOk) {
            console.log('[Komfy] ✅ Da co credentials! projectId:', sessionData.projectId.substring(0, 12));
            const latestMap2 = (await new Promise(r => chrome.storage.local.get(['komfyProjectMap'], r))).komfyProjectMap || {};
            if (latestMap2[targetProjectName] !== sessionData.projectId) {
                latestMap2[targetProjectName] = sessionData.projectId;
                await chrome.storage.local.set({ komfyProjectMap: latestMap2 });
            }
            break;
        }
        await sleep(500);
    }

    if (!sessionData.bearerToken) throw new Error('Khong co Google session. Hay dang nhap vao Google Flow truoc.');
    if (!sessionData.projectId) throw new Error('Khong lay duoc Project ID. Vui long mo Google Flow va vao 1 project.');

    return await chrome.tabs.get(tabId).catch(() => tab);
}
