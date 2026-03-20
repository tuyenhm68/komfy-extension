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
    delete staleMap[targetProjectName];
    await chrome.storage.local.set({ komfyProjectMap: staleMap, komfyProjectId: '' });
    await chrome.storage.session.set({ komfyProjectId: '' }).catch(() => {});
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

                // === STRATEGY 2: scan ten (fallback khi khong co ID hoac ID het hieu luc) ===
                const target = targetName.toLowerCase().trim();
                const projectEntries = [];

                for (const link of projectLinks) {
                    let name = '';

                    // Thu lay ten tu sibling (Flow DOM: link → sibling text/element)
                    let sibling = link.nextSibling;
                    for (let i = 0; i < 5 && sibling; i++) {
                        if (sibling.nodeType === 3) {
                            const txt = sibling.textContent.trim();
                            if (txt.length > 0) { name = txt; break; }
                        } else if (sibling.nodeType === 1) {
                            const tag = sibling.tagName.toLowerCase();
                            if (tag !== 'button' && tag !== 'a' && tag !== 'svg') {
                                const txt = sibling.textContent.trim();
                                if (txt.length > 0 && txt.length < 200) { name = txt; break; }
                            }
                            // Neu gap sibling la parent element, thu tim ben trong
                            if (tag === 'div' || tag === 'span' || tag === 'p') {
                                const innerText = sibling.textContent.trim();
                                if (innerText.length > 0 && innerText.length < 200) { name = innerText; break; }
                            }
                            break;
                        }
                        sibling = sibling.nextSibling;
                    }

                    // Fallback: aria-label, title, link text
                    if (!name) {
                        name = link.getAttribute('aria-label') || link.getAttribute('title') || link.textContent.trim() || '';
                    }

                    // Fallback 2: parent element chua link
                    if (!name) {
                        const parent = link.parentElement;
                        if (parent) {
                            const allText = parent.textContent.trim();
                            if (allText.length > 0 && allText.length < 200) name = allText;
                        }
                    }

                    projectEntries.push({ name: name.trim(), url: link.href });
                }

                // Exact match
                for (const entry of projectEntries) {
                    if (entry.name.toLowerCase() === target) {
                        return { url: entry.url, found: true, strategy: 'exact', name: entry.name };
                    }
                }

                // Includes match (xu ly ca truong hop 'komfy-studio' vs 'komfy studio')
                const targetNoHyphen = target.replace(/-/g, ' ');
                for (const entry of projectEntries) {
                    const nameLow = entry.name.toLowerCase();
                    if (nameLow.includes(target) || nameLow.includes(targetNoHyphen)) {
                        return { url: entry.url, found: true, strategy: 'includes', name: entry.name };
                    }
                }

                return {
                    found: false,
                    total: projectLinks.length,
                    names: projectEntries.map(e => e.name || '(no-name)').slice(0, 10),
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
            await sleep(2000);
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
async function ensureFlowTab(focusTab = true, projectName = null) {
    const targetProjectName = projectName || KOMFY_PROJECT_NAME;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // --- Buoc 1: Tim hoac tao Flow tab ---
    let tab = await findFlowTab();
    let tabId;

    if (tab) {
        tabId = tab.id;
        console.log('[Komfy] Tim thay tab Flow:', tab.url?.substring(0, 80));
        if (focusTab) {
            await chrome.tabs.update(tabId, { active: true }).catch(() => {});
            await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
    } else {
        console.log('[Komfy] Mo Flow home page...');
        tab = await chrome.tabs.create({ url: FLOW_URL, active: true });
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

    // Migration: komfyProjectId cu → projectMap moi
    if (storedData.komfyProjectId && !projectMap[KOMFY_PROJECT_NAME]) {
        projectMap[KOMFY_PROJECT_NAME] = storedData.komfyProjectId;
        await chrome.storage.local.set({ komfyProjectMap: projectMap });
    }
    const cachedProjectId = projectMap[targetProjectName] || null;

    const homeUrl = `https://labs.google/fx${storedLocale}/tools/flow`;

    // =========================================================
    // === FAST PATH: Co cached projectId → navigate thang ===
    // =========================================================
    if (cachedProjectId) {
        const projectUrl = `https://labs.google/fx${storedLocale}/tools/flow/project/${cachedProjectId}`;
        const alreadyOnProject = currentUrl.includes(`/project/${cachedProjectId}`);

        if (alreadyOnProject) {
            // ★ SUA BUG NGHIEM TRONG: chrome.tabs.reload() kill JS context cua task dang chay!
            // Neu task A (Node 1) dang o polling phase, reload se xoa toan bo fetch interceptor
            // va __komfy_imgResultMap__ cua Node 1 → Node 1 timeout sau 5 phut.
            //
            // FIX: Neu DA CO credentials (bearerToken + projectId), KHONG can reload.
            // Content script da chay, credentials da duoc capture. Return ngay.
            if (sessionData.bearerToken && sessionData.projectId) {
                console.log('[Komfy] ✅ [Fast Path] Tab dang o dung project + da co credentials → SKIP reload (bao ve task dang gen).');
                return await chrome.tabs.get(tabId).catch(() => tab);
            }
            // Chi reload neu CHUA CO credentials (can fresh content script)
            console.log('[Komfy] Tab dang o dung project nhung chua co credentials → Reload de lay credentials...');
            await chrome.tabs.reload(tabId);
        } else {
            console.log('[Komfy] Navigate toi cached project:', projectUrl.substring(0, 80));
            await chrome.tabs.update(tabId, { url: projectUrl });
        }
        await waitForTabLoad(tabId, 20000).catch(e => console.warn('[Komfy]', e.message));

        // Inject scripts
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});

        // Cho credentials (fast path toi da 20s)
        console.log('[Komfy] [Fast Path] Cho credentials...');
        const fastStart = Date.now();
        while (Date.now() - fastStart < 20000) {
            if (sessionData.bearerToken && sessionData.projectId) {
                console.log('[Komfy] ✅ [Fast Path] Da co credentials!');
                // Update cache voi fresh ID (co the project ID duoc confirm lai boi content script)
                const freshMap = (await new Promise(r => chrome.storage.local.get(['komfyProjectMap'], r))).komfyProjectMap || {};
                freshMap[targetProjectName] = sessionData.projectId;
                await chrome.storage.local.set({ komfyProjectMap: freshMap, komfyProjectId: sessionData.projectId });
                await chrome.storage.session.set({ komfyProjectId: sessionData.projectId }).catch(() => {});
                return await chrome.tabs.get(tabId).catch(() => tab);
            }
            await sleep(500);
        }

        // Credentials khong capture duoc trong 20s → co the project bi xoa hoac loi
        console.warn('[Komfy] ⚠️ [Fast Path] Credentials timeout (20s). Project co the bi xoa. Kiem tra home page...');
        await clearProjectCache(targetProjectName);
        // Fall through to SLOW PATH below
    }

    // =========================================================
    // === SLOW PATH: Navigate home → scan → navigate/create  ===
    // =========================================================
    console.log('[Komfy] [Slow Path] Navigate ve home:', homeUrl);
    const alreadyAtHome = currentUrl.includes('/tools/flow') && !currentUrl.includes('/project/');
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

    // Doi React render project list
    await sleep(3000);

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
            await chrome.storage.local.set({ komfyProjectMap: latestMap, komfyProjectId: freshId });
            await chrome.storage.session.set({ komfyProjectId: freshId }).catch(() => {});
            console.log('[Komfy] Cache updated:', freshId.substring(0, 16) + '...');
        }
    } else {
        // Khong tim thay → tao project moi
        console.log('[Komfy] Khong tim thay project "' + targetProjectName + '" → Tao moi...');
        await createAndRenameProject(tabId, targetProjectName);
    }

    // --- Cho credentials (toi da 25s) ---
    console.log('[Komfy] Cho credentials...');
    const start = Date.now();
    while (Date.now() - start < 25000) {
        if (sessionData.bearerToken && sessionData.projectId) {
            console.log('[Komfy] ✅ Da co credentials!');
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
