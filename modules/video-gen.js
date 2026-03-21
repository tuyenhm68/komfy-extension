// ============================================================
// video-gen.js — Orchestrator (refactored)
// Phu thuoc (load truoc trong background.js):
//   importScripts('modules/video-gen-settings.js')
//   importScripts('modules/video-gen-frames.js')
//   importScripts('modules/video-gen-poll.js')
// ============================================================

// UI Mutex: dam bao chi 1 task dung Flow UI tai 1 thoi diem (phase B0 → submit)
let __videoUiMutexTail = Promise.resolve();

// CDP Session Mutex: khai bao du phong neu image-gen.js chua load
if (typeof __cdpSessionMutexTail === 'undefined') {
    var __cdpSessionMutexTail = Promise.resolve();
}

// DOM Snapshot expression: chup trang thai video/ids truoc khi submit
const SNAPSHOT_EXPR = `
(function() {
    const ids = new Set();
    const videoSrcs = new Set();

    document.querySelectorAll('[data-generation-id]').forEach(el => ids.add(el.getAttribute('data-generation-id')));

    document.querySelectorAll('video').forEach(function(v) {
        [v.src, v.currentSrc, v.getAttribute('src')].forEach(function(src) {
            if (!src || src.length < 10) return;
            if (src.includes('media.getMediaUrlRedirect?name=')) {
                videoSrcs.add(src); // Them full url de ignore chinh xac trong DOM scan
                try {
                    var u = new URL(src);
                    var n = u.searchParams.get('name');
                    if (n) { ids.add('MEDIA:' + n); videoSrcs.add('MEDIA:' + n); }
                } catch(e) {}
                return;
            }
            var m2 = src.match(/ai-sandbox-videofx\\/(?:image|video)\\/([a-f0-9-]{32,36})/);
            if (m2) { ids.add(m2[1]); videoSrcs.add(src); videoSrcs.add(m2[1]); return; }
            var m = src.match(/generations\\/([a-zA-Z0-9_-]+)/);
            if (m) { ids.add(m[1]); videoSrcs.add(m[1]); return; }
            if (src.startsWith('blob:')) { videoSrcs.add(src); return; }
            if (src.startsWith('http')) { videoSrcs.add(src); }
        });
    });

    document.querySelectorAll('video source').forEach(s => {
        const src = s.getAttribute('src') || '';
        if (src && src.length > 10) videoSrcs.add(src);
    });

    const videoCount = document.querySelectorAll('video').length;
    const roleImgCount = document.querySelectorAll('[role="img"]').length;
    var gridContainer = document.querySelector('[class*="project"],[class*="grid"],[class*="gallery"],[class*="generation"]');
    var containerChildCount = gridContainer ? gridContainer.children.length : 0;

    return { ids: [...ids], videoSrcs: [...videoSrcs], videoCount, roleImgCount, containerChildCount };
})()
`;

async function generateViaUI(
    prompt,
    aspectRatio,
    projectName = null,
    videoModelKey = null,
    i2vData = null,
    targetVideoModelParam = null,
    videoType = 'Ingredients',
    imageInputs = [],
    requestId = null,
    resolutionMultiplier = 'x1'
) {
    // --- Resolve target model BEFORE mutex ---
    let targetVideoModel;
    if (targetVideoModelParam) {
        targetVideoModel = targetVideoModelParam;
    } else if (videoModelKey) {
        const key = videoModelKey.toLowerCase();
        targetVideoModel = key.includes('quality') ? 'Veo 3.1 - Quality' : 'Veo 3.1 - Fast';
    } else {
        targetVideoModel = 'Veo 3.1 - Fast';
    }

    const resolvedVideoType = (i2vData && (i2vData.startImage || i2vData.endImage))
        ? 'Frames'
        : (videoType || 'Ingredients');

    // aspectRatio is now direct (16:9, 9:16) — no orientation mapping needed

    // --- Acquire UI Mutex ---
    let releaseMutex;
    const mutexAcquired = new Promise(resolve => { releaseMutex = resolve; });
    const prevTail = __videoUiMutexTail;
    __videoUiMutexTail = mutexAcquired;
    console.log('[Komfy Video] [UI-Mutex] Waiting...');
    await prevTail;
    console.log('[Komfy Video] [UI-Mutex] ✅ Acquired.');

    // --- Acquire CDP Session Mutex ---
    let releaseCdpMutex;
    const cdpAcquired = new Promise(resolve => { releaseCdpMutex = resolve; });
    const prevCdpTail = __cdpSessionMutexTail;
    __cdpSessionMutexTail = cdpAcquired;
    console.log('[Komfy Video] [CDP-Mutex] Waiting...');
    await prevCdpTail;
    console.log('[Komfy Video] [CDP-Mutex] ✅ Acquired.');

    // --- ensureFlowTab SAU KHI co ca 2 mutex ---
    const tab = await ensureFlowTab(false, projectName);
    const tabId = tab.id;

    console.log('[Komfy Video] CDP tab:', tabId, 'orient:', aspectRatio, 'model:', targetVideoModel, 'prompt:', prompt.substring(0, 40));

    // Activate tab within window (CDP needs active tab for mouse/keyboard events)
    // Do NOT focus the Chrome window — avoid stealing OS focus from user
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));

    // --- Attach debugger ---
    try {
        await chrome.debugger.attach({ tabId }, '1.3');
    } catch (attachErr) {
        const msg = attachErr?.message || String(attachErr);
        if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('attached')) {
            console.warn('[Komfy Video] CDP already attached, detach first...');
            await chrome.debugger.detach({ tabId }).catch(() => {});
            await new Promise(r => setTimeout(r, 500));
            await chrome.debugger.attach({ tabId }, '1.3');
        } else {
            throw attachErr;
        }
    }

    const send  = (method, params) => new Promise((res, rej) => {
        chrome.debugger.sendCommand({ tabId }, method, params || {}, result => {
            if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
            else res(result);
        });
    });
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    try {
        // =============================================
        // Phase 0: Pre-check — bao dam dang o project GALLERY view
        // (KHONG PHAI image/video detail view)
        //
        // Sau khi generate, Flow UI co the navigate vao detail view
        // (click vao result hoac ingredient) → bottom bar hien "Nano Banana Pro"
        // thay vi "Veo" → submit se tao ANH thay vi VIDEO.
        //
        // Fix: Detect detail view → click Done/Back bang CDP mouse events
        //      (JS .click() KHONG trigger React event handlers)
        // =============================================
        console.log('[Komfy Video] Pre-check: Reset page state...');

        for (let esc = 0; esc < 3; esc++) {
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
            await send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Escape', code: 'Escape' });
            await sleep(200);
        }

        // ★ ENSURE GALLERY VIEW
        // Sau khi generate, Flow co the navigate vao detail view (image/video).
        // Approach don gian: kiem tra URL co extra segments sau /project/{id} khong.
        // Neu co → navigate ve base project URL (gallery view).
        // Khong can detect button phuc tap — URL la indicator chinh xac nhat.
        const navResult = await send('Runtime.evaluate', {
            expression: `(function(){
                var url = window.location.href;
                // Match: /project/{id} co the theo sau boi /image/ hoac /video/ hoac bat ky sub-path nao
                var m = url.match(/(.*\\/project\\/[a-zA-Z0-9_-]+)(\\/.+)?/);
                if (!m) return { action: 'none', url: url.substring(0, 120), reason: 'not on project page' };
                var baseUrl = m[1];
                var extra = m[2] || '';
                if (extra && extra !== '/' && extra.length > 1) {
                    return { action: 'navigate', baseUrl: baseUrl, extra: extra, url: url.substring(0, 120) };
                }
                return { action: 'none', url: url.substring(0, 120), reason: 'already on gallery' };
            })()`,
            returnByValue: true,
        });
        const nav = navResult?.result?.value || {};
        console.log('[Komfy Video] Gallery check:', JSON.stringify(nav));

        if (nav.action === 'navigate') {
            console.log('[Komfy Video] ⚠️ Not on gallery! Navigating back from', nav.extra, '→', nav.baseUrl);
            await send('Runtime.evaluate', {
                expression: `window.location.href = ${JSON.stringify(nav.baseUrl)};`,
                awaitPromise: false,
            });
            // Doi page load xong
            await sleep(2000);
            for (let w = 0; w < 15; w++) {
                const ready = await send('Runtime.evaluate', {
                    expression: `!!(document.querySelector('[role="textbox"],[contenteditable="true"]') || document.querySelectorAll('button,[role="button"]').length > 3)`,
                    returnByValue: true,
                }).catch(() => null);
                if (ready?.result?.value) {
                    console.log('[Komfy Video] ✅ Gallery loaded after', (w * 500 + 2000), 'ms');
                    break;
                }
                await sleep(500);
            }
            await sleep(500);
        }

        // ★ DETECT DETAIL VIEW BY DOM
        // Flow UI can be in Image/Video Detail View with the SAME URL as gallery.
        // Detail view has a "Done" button in top-right corner, and/or a back arrow "←".
        // Bottom bar in detail view shows the image model (e.g. "Nano Banana Pro")
        // and its popover shows ONLY aspect ratio tabs — NO Image/Video tabs.
        // This causes the Video tab selection to fail completely.
        const detailViewCheck = await send('Runtime.evaluate', {
            expression: `(function(){
                var btns = document.querySelectorAll('button,[role="button"]');
                // Method 1: Look for "Done" button in top part of page
                for (var i = 0; i < btns.length; i++) {
                    var text = (btns[i].textContent||'').trim();
                    var r = btns[i].getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    if ((text === 'Done' || text === 'Xong') && r.top < 80) {
                        return { inDetailView: true, method: 'done-btn', x: r.left+r.width/2, y: r.top+r.height/2, text: text };
                    }
                }
                // Method 2: Look for back arrow / "←" in top-left
                for (var i = 0; i < btns.length; i++) {
                    var text = (btns[i].textContent||'').trim();
                    var ariaLabel = (btns[i].getAttribute('aria-label')||'').toLowerCase();
                    var r = btns[i].getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    if (r.top < 60 && r.left < 80 && (text === 'arrow_back' || text === '←' || ariaLabel.includes('back'))) {
                        return { inDetailView: true, method: 'back-btn', x: r.left+r.width/2, y: r.top+r.height/2, text: text };
                    }
                }
                // Method 3: Check for "Download" button (only in detail view)
                for (var i = 0; i < btns.length; i++) {
                    var text = (btns[i].textContent||'').trim().toLowerCase();
                    var r = btns[i].getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    if (r.top < 60 && (text.includes('download') || text === 'tải xuống')) {
                        for (var j = 0; j < btns.length; j++) {
                            var t2 = (btns[j].textContent||'').trim();
                            var r2 = btns[j].getBoundingClientRect();
                            if ((t2 === 'Done' || t2 === 'Xong') && r2.width > 0) {
                                return { inDetailView: true, method: 'download-found-done', x: r2.left+r2.width/2, y: r2.top+r2.height/2, text: t2 };
                            }
                        }
                        return { inDetailView: true, method: 'download-no-done', x: 0, y: 0 };
                    }
                }
                // Method 4: Check for play_circle (video player) — only present in video detail view
                var hasPlayCircle = false;
                for (var i = 0; i < btns.length; i++) {
                    var text = (btns[i].textContent||'').trim().toLowerCase();
                    if (text.includes('play_circle') || text.includes('play_arrow')) { hasPlayCircle = true; break; }
                }
                // Method 5: Check for "Extend" button (keyboard_double_arrow_right) — video detail view
                var hasExtend = false;
                for (var i = 0; i < btns.length; i++) {
                    var text = (btns[i].textContent||'').trim().toLowerCase();
                    if (text.includes('extend') || text.includes('keyboard_double_arrow_right')) { hasExtend = true; break; }
                }
                // Method 6: Check for "Hide history" / "Show history" (detail view sidebar)
                var hasHistoryBtn = false;
                for (var i = 0; i < btns.length; i++) {
                    var text = (btns[i].textContent||'').trim().toLowerCase();
                    if (text.includes('hide history') || text.includes('show history') || text.includes('ẩn lịch sử')) { hasHistoryBtn = true; break; }
                }
                // ★ FIX: play_circle va extend cung xuat hien o gallery view (video preview, extend button).
                // Chi tin tuong khi co >= 2 signals VA khong co textbox (detail view khong co prompt box).
                // hasHistoryBtn la signal manh nhat (chi co trong detail view sidebar).
                var signals = (hasPlayCircle ? 1 : 0) + (hasExtend ? 1 : 0) + (hasHistoryBtn ? 1 : 0);
                if (signals >= 2) {
                    var hasTb = !!(document.querySelector('[role="textbox"],[contenteditable="true"]'));
                    if (!hasTb) {
                        return { inDetailView: true, method: 'video-detail-signals', signals: signals, hasPlayCircle: hasPlayCircle, hasExtend: hasExtend, hasHistoryBtn: hasHistoryBtn, hasTb: hasTb, x: 0, y: 0 };
                    }
                }
                return { inDetailView: false };
            })()`,
            returnByValue: true,
        });
        const detailView = detailViewCheck?.result?.value || {};
        console.log('[Komfy Video] Detail view check:', JSON.stringify(detailView));

        if (detailView.inDetailView) {
            console.log('[Komfy Video] ⚠️ DETAIL VIEW detected! method:', detailView.method, '| Clicking', detailView.text, 'to return to gallery...');

            if (detailView.x > 0 && detailView.y > 0) {
                // Click the Done/Back button via CDP mouse events (JS .click() doesn't work on Flow)
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: detailView.x, y: detailView.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
                await sleep(80);
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: detailView.x, y: detailView.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
                await sleep(1500);
                console.log('[Komfy Video] ✅ Clicked "' + detailView.text + '" — waiting for gallery to load...');
            } else {
                // Fallback: press Escape multiple times + navigate to base URL
                console.log('[Komfy Video] No clickable button found, using Escape + URL navigation fallback...');
                for (let esc = 0; esc < 5; esc++) {
                    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
                    await send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Escape', code: 'Escape' });
                    await sleep(300);
                }
                // Navigate to base project URL
                const baseUrlResult = await send('Runtime.evaluate', {
                    expression: `(function(){
                        var m = window.location.href.match(/(.*\\/project\\/[a-zA-Z0-9_-]+)/);
                        return m ? m[1] : window.location.href;
                    })()`,
                    returnByValue: true,
                });
                const baseUrl = baseUrlResult?.result?.value;
                if (baseUrl) {
                    await send('Runtime.evaluate', {
                        expression: `window.location.href = ${JSON.stringify(baseUrl)};`,
                        awaitPromise: false,
                    });
                    await sleep(2000);
                }
            }

            // Wait for gallery to be ready
            for (let gw = 0; gw < 15; gw++) {
                const galleryReady = await send('Runtime.evaluate', {
                    expression: `(function(){
                        // Gallery is ready when: textbox exists AND no "Done" button in top area
                        var hasTb = !!(document.querySelector('[role="textbox"],[contenteditable="true"]'));
                        var hasDone = false;
                        var btns = document.querySelectorAll('button,[role="button"]');
                        for (var i = 0; i < btns.length; i++) {
                            var t = (btns[i].textContent||'').trim();
                            var r = btns[i].getBoundingClientRect();
                            if ((t === 'Done' || t === 'Xong') && r.top < 80 && r.width > 0) { hasDone = true; break; }
                        }
                        return hasTb && !hasDone;
                    })()`,
                    returnByValue: true,
                }).catch(() => null);
                if (galleryReady?.result?.value) {
                    console.log('[Komfy Video] ✅ Gallery view confirmed after', gw * 500, 'ms');
                    break;
                }
                await sleep(500);
            }
            await sleep(500);
        }

        // Wait for bottom bar
        let detectedBarType = null;
        for (let w = 0; w < 10; w++) {
            const barCheck = await send('Runtime.evaluate', {
                expression: `(function(){
                    var btns = document.querySelectorAll('button, [role="button"]');
                    for (var i = 0; i < btns.length; i++) {
                        var r = btns[i].getBoundingClientRect();
                        var text = (btns[i].textContent||'').toLowerCase();
                        if (r.bottom > window.innerHeight - 120 && r.width > 50 &&
                            (text.includes('veo') || text.includes('video'))) return 'veo';
                    }
                    for (var i = 0; i < btns.length; i++) {
                        var r = btns[i].getBoundingClientRect();
                        var text = (btns[i].textContent||'').toLowerCase();
                        if (r.bottom > window.innerHeight - 120 && r.width > 50 &&
                            (text.includes('banana') || text.includes('imagen') || /x[1-4]/.test(text))) return 'image-model';
                    }
                    return !!(document.querySelector('[role="textbox"],[contenteditable="true"]')) ? 'textbox' : null;
                })()`,
                returnByValue: true,
            });
            detectedBarType = barCheck?.result?.value;
            if (detectedBarType) {
                console.log('[Komfy Video] Bottom bar ready (' + detectedBarType + ') after', w * 500, 'ms');
                break;
            }
            await sleep(500);
        }

        // After exiting detail view, bottom bar may still show image model.
        // runSettingsPhase() will switch to Video mode via popover.
        if (detectedBarType === 'image-model') {
            console.log('[Komfy Video] Bottom bar shows image model — will switch to Video via popover (no navigation needed).');
        }

        // =============================================
        // Phase B0: Settings popover
        // =============================================
        await runSettingsPhase(send, sleep, { targetVideoModel, resolvedVideoType, aspectRatio, resolutionMultiplier });

        // =============================================
        // Phase: Snapshot truoc submit
        // Chi capture IDs cua tat ca card hien co.
        // KHONG scroll — scroll tat ca elements pha vo UI state cua Flow
        // (tab containers, textbox, dropdown panels bi reset khi scroll)
        //
        // Polling gio dung exact pendingGenId match → beforeVideoSrcs khong
        // quan trong. beforeIds chi de error detection (card moi co fail msg).
        // =============================================
        // Doi cards load truoc khi snapshot — sau page navigation, gallery cards
        // co the chua render. Neu snapshot luc nay → beforeIds rong → new-card scan
        // khong phan biet duoc card cu/moi → pick video cu.
        // Doi toi da 8s cho it nhat 1 card/video/img xuat hien.
        for (let cardWait = 0; cardWait < 16; cardWait++) {
            const hasContent = await send('Runtime.evaluate', {
                expression: `(function(){
                    var cards = document.querySelectorAll('[data-generation-id]').length;
                    var videos = document.querySelectorAll('video').length;
                    var imgs = document.querySelectorAll('img[src*="media.getMediaUrlRedirect"]').length;
                    return { cards, videos, imgs, total: cards + videos + imgs };
                })()`,
                returnByValue: true,
            });
            const c = hasContent?.result?.value || {};
            if (c.total > 0) {
                console.log('[Komfy Video] Gallery content ready:', JSON.stringify(c), '| waited:', cardWait * 500, 'ms');
                break;
            }
            if (cardWait === 15) {
                console.warn('[Komfy Video] ⚠️ No gallery content after 8s — snapshot may be empty (first run?)');
            }
            await sleep(500);
        }
        await sleep(300);
        const beforeSnap = await send('Runtime.evaluate', { expression: SNAPSHOT_EXPR, returnByValue: true, awaitPromise: false });

        // Capture tat ca [data-generation-id] hien co → "fence" cho new-card scan
        const allExistingCardIds = await send('Runtime.evaluate', {
            expression: `(function(){
                var ids = new Set();
                document.querySelectorAll('[data-generation-id]').forEach(function(el) {
                    var id = el.getAttribute('data-generation-id');
                    if (id && id.trim().length > 4) ids.add(id.trim());
                });
                document.querySelectorAll('video').forEach(function(v) {
                    [v.src, v.currentSrc].forEach(function(s) {
                        if (!s || s.length < 10) return;
                        var m = s.match(/ai-sandbox-videofx\/(?:image|video)\/([a-f0-9-]{32,36})/);
                        if (m) ids.add(m[1]);
                    });
                });
                document.querySelectorAll('img[src*="media.getMediaUrlRedirect"]').forEach(function(img) {
                    try { var n = new URL(img.src).searchParams.get('name'); if (n) ids.add(n); } catch(e) {}
                });
                return [...ids];
            })()`,
            returnByValue: true,
            awaitPromise: false,
        });

        const beforeIds            = new Set(beforeSnap?.result?.value?.ids || []);
        const beforeVideoSrcs      = new Set(beforeSnap?.result?.value?.videoSrcs || []);
        const beforeVideoCount     = beforeSnap?.result?.value?.videoCount || 0;
        const beforeContainerCount = beforeSnap?.result?.value?.containerChildCount || 0;

        (allExistingCardIds?.result?.value || []).forEach(id => beforeIds.add(id));

        console.log('[Komfy] BEFORE snapshot: cardIds=', beforeIds.size, '| videoSrcs=', beforeVideoSrcs.size);

        // =============================================
        // Phase I2V: Frame selection
        // =============================================
        if (i2vData) {
            await handleI2VFrameSelection(i2vData, send, sleep);
            await reVerifyVideoModeAfterGallery(send, sleep);
        }

        // =============================================
        // Phase: Install Fetch Hook
        // =============================================
        const i2vBase64 = i2vData ? btoa(unescape(encodeURIComponent(JSON.stringify(i2vData)))) : '';
        await send('Runtime.evaluate', {
            expression: `
            (function() {
                var i2vRaw = '${i2vBase64}';
                window.__komfy_i2vData__ = i2vRaw
                    ? JSON.parse(decodeURIComponent(escape(atob(i2vRaw))))
                    : null;
            })()`,
            awaitPromise: false,
        });

        const currentSessionId = (requestId || '') + '_' + Date.now();
        // Set sessionId TRUOC khi install/check hook — hook se doc gia tri nay khi fetch fire
        await send('Runtime.evaluate', {
            expression: `window.__komfy_genId__ = null; window.__komfy_genSid__ = null; window.__komfy_genIdAt__ = null; window.__komfy_clickTime = null; window.__komfy_sessionId__ = ${JSON.stringify(currentSessionId)};`,
            awaitPromise: false,
        });

        // Force reinstall fetch hook moi lan generate — dam bao hook code luon
        // moi nhat (bao gom __komfy_clickTime gate). Dung __komfy_origFetch__ de
        // tranh double-wrapping khi reinstall.
        await send('Runtime.evaluate', {
            expression: `
            (function() {
                // Khoi phuc original fetch neu da wrap truoc do
                var origFetch = window.__komfy_origFetch__ || window.fetch;
                window.__komfy_origFetch__ = origFetch;
                window.__komfy_intercept__ = true;
                window.fetch = async function(...args) {
                    let url = typeof args[0]==='string'?args[0]:(args[0]?.url||'');

                    if (window.__komfy_i2vData__ && url.includes('batchAsyncGenerateVideoText')) {
                        const endpointSuffix = window.__komfy_i2vData__.endpoint.split(':').pop();
                        url = url.replace('batchAsyncGenerateVideoText', endpointSuffix);
                        args[0] = url;
                        if (args[1] && args[1].body) {
                            try {
                                const b = JSON.parse(args[1].body);
                                if (b.requests && b.requests[0]) {
                                    const req = b.requests[0];
                                    if (window.__komfy_i2vData__.startImage) req.startImage = { mediaId: window.__komfy_i2vData__.startImage };
                                    if (window.__komfy_i2vData__.endImage)   req.endImage   = { mediaId: window.__komfy_i2vData__.endImage };
                                    if (window.__komfy_i2vData__.videoModelKey) req.videoModelKey = window.__komfy_i2vData__.videoModelKey;
                                    args[1] = Object.assign({}, args[1], { body: JSON.stringify(b) });
                                }
                            } catch(e) { console.error('[Komfy] I2V inject err', e); }
                        }
                        console.log('[Komfy] Fetch swapped to', url);
                    }

                    const res = await origFetch.apply(this, args);
                    if (url.includes('batchAsyncGenerateVideo')) {
                        try {
                            const cloned = res.clone();
                            const activeSid = window.__komfy_sessionId__;
                            // ★ CHI capture genId SAU KHI submit da click (__komfy_clickTime != null)
                            // Truoc submit, Google Flow co the fire background fetches (status check)
                            // ma response chua genId cu → gay nham video n-1
                            const isActiveSession = !!(activeSid && activeSid.length > 0 && window.__komfy_clickTime);
                            if (!res.ok && isActiveSession) {
                                window.__komfy_genError__ = 'HTTP ' + res.status + ' - ' + res.statusText;
                                console.log('[Komfy Fetch] API error: HTTP', res.status);
                            } else if (isActiveSession) {
                                const d = await cloned.json();
                                console.log('[Komfy Fetch] batchAsyncGenerateVideo response keys:', Object.keys(d || {}));
                                const gid = d?.generationResults?.[0]?.generationId
                                    || d?.generationId || d?.operationId || d?.name
                                    || (Array.isArray(d) && d[0]?.generationId)
                                    || (Array.isArray(d) && d[0]?.name);
                                if (gid) {
                                    window.__komfy_genId__    = gid;
                                    window.__komfy_genSid__   = activeSid;
                                    window.__komfy_genIdAt__  = Date.now();
                                    console.log('[Komfy Fetch] ✅ Captured genId:', gid, '| sid:', activeSid.substring(0,20), '| at:', window.__komfy_genIdAt__);
                                } else {
                                    console.log('[Komfy Fetch] No genId in response:', JSON.stringify(d).substring(0, 200));
                                }
                                const apiErr = d?.error?.message || d?.error?.status
                                    || (d?.generationResults?.[0]?.error?.message)
                                    || (Array.isArray(d) && d[0]?.error?.message);
                                if (apiErr) window.__komfy_genError__ = String(apiErr).substring(0, 200);
                            } else if (!isActiveSession && url.includes('batchAsyncGenerateVideo')) {
                                console.log('[Komfy Fetch] Ignored pre-submit fetch (clickTime not set)');
                            }
                        } catch(e) {
                            console.log('[Komfy Fetch] Parse error:', e.message);
                        }
                    }
                    return res;
                };
                console.log('[Komfy Fetch] Hook (re)installed, sessionId:', window.__komfy_sessionId__);
            })()`,
            awaitPromise: false,
        });

        // Force update i2vData + reset session state
        await send('Runtime.evaluate', {
            expression: `
            (function() {
                var i2vRaw2 = '${i2vBase64}';
                window.__komfy_i2vData__ = i2vRaw2
                    ? JSON.parse(decodeURIComponent(escape(atob(i2vRaw2))))
                    : null;
                window.__komfy_genId__  = null;
                window.__komfy_genSid__ = window.__komfy_sessionId__;
            })()`,
            awaitPromise: false,
        });

        // ★ FALLBACK: Lang nghe message KOMFY_GENERATION_CAPTURED tu content_fetch_interceptor
        // Sau page reload, Flow's JS co the save reference den window.fetch TRUOC khi
        // fetch hook cua chung ta duoc install → fetch hook bi bypass.
        // content_fetch_interceptor.js (run_at document_start) luon intercept duoc
        // va post message KOMFY_GENERATION_CAPTURED → listener nay capture genId.
        await send('Runtime.evaluate', {
            expression: `
            (function() {
                // Remove old listener neu co (tranh duplicate)
                if (window.__komfy_msgListener__) {
                    window.removeEventListener('message', window.__komfy_msgListener__);
                }
                window.__komfy_msgListener__ = function(event) {
                    if (event.data && event.data.type === 'KOMFY_GENERATION_CAPTURED' && event.data.generationId) {
                        // Chi capture SAU khi submit (clickTime != null)
                        if (!window.__komfy_clickTime) {
                            console.log('[Komfy Msg] Ignored pre-submit genId:', event.data.generationId.substring(0,25));
                            return;
                        }
                        // Khong ghi de neu fetch hook da capture (fetch hook co priority cao hon)
                        if (window.__komfy_genId__ && window.__komfy_genIdAt__) {
                            console.log('[Komfy Msg] genId already captured by fetch hook, skipping message');
                            return;
                        }
                        window.__komfy_genId__   = event.data.generationId;
                        window.__komfy_genSid__  = window.__komfy_sessionId__;
                        window.__komfy_genIdAt__ = Date.now();
                        console.log('[Komfy Msg] ✅ Captured genId via message fallback:', event.data.generationId.substring(0,30));
                    }
                };
                window.addEventListener('message', window.__komfy_msgListener__);
                console.log('[Komfy Msg] Message listener installed for KOMFY_GENERATION_CAPTURED');
            })()`,
            awaitPromise: false,
        });

        // Reset error capture
        const scriptEval = async (func, args = []) => {
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId }, world: 'MAIN', func, args,
                });
                return results?.[0]?.result;
            } catch (e) {
                console.warn('[Komfy Video] scriptEval error:', e.message);
                return undefined;
            }
        };
        await scriptEval(() => { window.__komfy_genError__ = null; });

        // =============================================
        // Phase: Assert Video mode BEFORE paste (SAFETY GATE)
        // Phai chay TRUOC khi paste images — neu chay SAU, openPopover()
        // co the reset UI state va xoa tat ca images vua paste.
        // =============================================
        await assertVideoMode(send, sleep, { resolvedVideoType });

        // =============================================
        // Phase 1: Focus textbox (can truoc khi paste images)
        // =============================================
        let tbFound = false;
        for (let tb = 0; tb < 6; tb++) {
            const focusOk = (await send('Runtime.evaluate', {
                expression: `(function(){
                    var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
                    if (!tb) return false;
                    tb.focus();
                    return true;
                })()`,
                returnByValue: true, awaitPromise: false,
            }))?.result?.value;
            if (focusOk) { tbFound = true; break; }
            console.log('[Komfy Video] Textbox not ready (' + (tb + 1) + '/6)');
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
            await send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Escape', code: 'Escape' });
            await sleep(500);
        }
        if (!tbFound) throw new Error('Khong tim thay textbox sau 3s retry!');
        await sleep(200);

        // =============================================
        // Phase 2: PASTE IMAGES TRƯỚC (nếu có)
        // Thu tu dung: paste anh → doi upload → verify →
        //              type prompt → submit NGAY.
        // Neu type prompt truoc roi paste anh sau, co race condition
        // khien submit xay ra truoc khi anh san sang.
        // =============================================
        const isVideoIngredients = (resolvedVideoType === 'Ingredients');
        const expectedImageCount = (imageInputs && imageInputs.length > 0) ? imageInputs.length : 0;

        if (expectedImageCount > 0) {
            console.log('[Komfy Video] [STEP 2] Pasting', expectedImageCount, 'image(s) BEFORE typing prompt...');

            if (typeof clearExistingIngredients === 'function') {
                await clearExistingIngredients(send, sleep);
            }

            const baselineCount = isVideoIngredients ? await getIngredientCount(send) : 0;
            const targetCount = baselineCount + expectedImageCount;

            const payloads = imageInputs.map(imgData => {
                if (!imgData || !imgData.startsWith('data:')) return null;
                const imgBase64 = imgData.split(',')[1];
                const mimeMatch = imgData.match(/^data:([^;]+);/);
                const imgMime = mimeMatch ? mimeMatch[1] : 'image/png';
                return { b64: imgBase64, mime: imgMime };
            }).filter(Boolean);

            if (payloads.length === 0) {
                console.warn('[Komfy Video] [STEP 2] ⚠️ No valid image payloads! Skipping paste.');
            } else {
                // Click vat ly vao textbox truoc khi paste
                const tbCoordRes = await send('Runtime.evaluate', {
                    expression: `(function(){
                        var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
                        if (tb) { var r = tb.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; }
                        return null;
                    })()`,
                    returnByValue: true
                });
                const tbCoord = tbCoordRes?.result?.value;
                if (tbCoord && tbCoord.x && tbCoord.y) {
                    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tbCoord.x, y: tbCoord.y, button: 'left', clickCount: 1 });
                    await sleep(60);
                    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tbCoord.x, y: tbCoord.y, button: 'left', clickCount: 1 });
                    await sleep(200);
                }

                // Bulk paste tat ca images cung luc
                const pasteResult = await send('Runtime.evaluate', {
                    expression: `(async function(){
                        try {
                            var dt = new DataTransfer();
                            var payloads = ${JSON.stringify(payloads)};
                            for (var i=0; i<payloads.length; i++) {
                                var p = payloads[i];
                                var byteChars = atob(p.b64);
                                var arr = new Uint8Array(byteChars.length);
                                for (var j=0; j<byteChars.length; j++) arr[j] = byteChars.charCodeAt(j);
                                var blob = new Blob([arr], {type: p.mime});
                                var ext = p.mime.split('/')[1] || 'png';
                                var file = new File([blob], 'ingredient_' + Date.now() + '_' + i + '.' + ext, {type: p.mime, lastModified: Date.now()});
                                dt.items.add(file);
                            }
                            var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
                            if (!tb) return 'no-textbox';
                            tb.focus();
                            tb.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
                            return 'pasted ' + payloads.length + ' image(s)';
                        } catch(e) { return 'error: ' + e.message; }
                    })()`,
                    returnByValue: true,
                    awaitPromise: true,
                });
                console.log('[Komfy Video] [STEP 2] Bulk paste result:', pasteResult?.result?.value);

                // Doi upload hoan tat (90s cho mang cham)
                if (typeof waitForUploadsComplete === 'function') {
                    console.log('[Komfy Video] [STEP 2] Waiting for uploads... targetCount:', targetCount);
                    const uploadOk = await waitForUploadsComplete(send, targetCount, 90000);
                    if (!uploadOk) {
                        // Timeout — nhung kiem tra lai: neu submit button ENABLED va khong co loading
                        // thi anh da upload xong, chi la image count detection bi miss
                        const fallbackCheck = await send('Runtime.evaluate', {
                            expression: `(function(){
                                var btns = document.querySelectorAll('button,[role="button"]');
                                for (var i = 0; i < btns.length; i++) {
                                    var label = (btns[i].getAttribute('aria-label')||'').toLowerCase();
                                    var text = (btns[i].textContent||'').toLowerCase().trim();
                                    if (label.includes('create') || label.includes('send') || label.includes('generate') ||
                                        text.includes('arrow_forward') || text.includes('send')) {
                                        var disabled = btns[i].disabled || btns[i].getAttribute('aria-disabled') === 'true';
                                        return { found: true, disabled: disabled, text: text.substring(0,30) };
                                    }
                                }
                                return { found: false };
                            })()`,
                            returnByValue: true,
                        });
                        const fb = fallbackCheck?.result?.value || {};
                        if (fb.found && !fb.disabled) {
                            console.warn('[Komfy Video] [STEP 2] ⚠️ Upload timeout but submit button ENABLED — proceeding (images likely uploaded, detection missed)');
                        } else {
                            throw new Error('Timeout: Chua upload du ' + targetCount + ' anh sau 90s. Submit button: ' +
                                (fb.found ? (fb.disabled ? 'DISABLED' : 'enabled') : 'not found') + '. Da huy phien tao.');
                        }
                    }
                    console.log('[Komfy Video] [STEP 2] ✅ All ingredient uploads complete.');
                    await sleep(500);
                } else {
                    console.warn('[Komfy Video] [STEP 2] ⚠️ Missing waitForUploadsComplete, fallback sleep.');
                    await sleep(5000);
                }

                // PRE-SUBMIT GATE: Xac nhan so anh thuc te tren UI
                let gatePass = false;
                for (let gateAttempt = 0; gateAttempt < 3 && !gatePass; gateAttempt++) {
                    const actualCount = await getIngredientCount(send);
                    console.log('[Komfy Video] [PRE-SUBMIT GATE] attempt', gateAttempt,
                        '| actual:', actualCount, '| expected:', expectedImageCount);

                    if (actualCount >= expectedImageCount) {
                        gatePass = true;
                        console.log('[Komfy Video] [PRE-SUBMIT GATE] ✅ All', expectedImageCount, 'image(s) confirmed on UI.');
                    } else {
                        console.warn('[Komfy Video] [PRE-SUBMIT GATE] ⚠️ Only', actualCount, '/', expectedImageCount,
                            'images — waiting 3s...');
                        await sleep(3000);

                        // Retry paste o lan thu 2
                        if (gateAttempt === 1) {
                            console.log('[Komfy Video] [PRE-SUBMIT GATE] Retrying bulk paste...');
                            await send('Runtime.evaluate', {
                                expression: `(function(){
                                    var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
                                    if (tb) { tb.focus(); return true; } return false;
                                })()`,
                                returnByValue: true,
                            });
                            await sleep(200);
                            await send('Runtime.evaluate', {
                                expression: `(async function(){
                                    try {
                                        var dt = new DataTransfer();
                                        var payloads = ${JSON.stringify(payloads)};
                                        for (var i=0; i<payloads.length; i++) {
                                            var p = payloads[i];
                                            var byteChars = atob(p.b64);
                                            var arr = new Uint8Array(byteChars.length);
                                            for (var j=0; j<byteChars.length; j++) arr[j] = byteChars.charCodeAt(j);
                                            var blob = new Blob([arr], {type: p.mime});
                                            var ext = p.mime.split('/')[1] || 'png';
                                            var file = new File([blob], 'retry_' + Date.now() + '_' + i + '.' + ext, {type: p.mime, lastModified: Date.now()});
                                            dt.items.add(file);
                                        }
                                        var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
                                        if (!tb) return 'no-textbox';
                                        tb.focus();
                                        tb.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
                                        return 'retried ' + payloads.length;
                                    } catch(e) { return 'error: ' + e.message; }
                                })()`,
                                returnByValue: true,
                                awaitPromise: true,
                            });
                            if (typeof waitForUploadsComplete === 'function') {
                                await waitForUploadsComplete(send, expectedImageCount, 30000);
                            } else {
                                await sleep(5000);
                            }
                        }
                    }
                }

                if (!gatePass) {
                    const finalCount = await getIngredientCount(send);
                    if (finalCount < expectedImageCount) {
                        // Fallback: kiem tra submit button — neu enabled thi anh da upload xong
                        const submitCheck = await send('Runtime.evaluate', {
                            expression: `(function(){
                                var btns = document.querySelectorAll('button,[role="button"]');
                                for (var i = 0; i < btns.length; i++) {
                                    var label = (btns[i].getAttribute('aria-label')||'').toLowerCase();
                                    var text = (btns[i].textContent||'').toLowerCase().trim();
                                    if (label.includes('create') || label.includes('send') || label.includes('generate') ||
                                        text.includes('arrow_forward') || text.includes('send')) {
                                        return { found: true, disabled: !!(btns[i].disabled || btns[i].getAttribute('aria-disabled') === 'true') };
                                    }
                                }
                                return { found: false };
                            })()`,
                            returnByValue: true,
                        });
                        const sc = submitCheck?.result?.value || {};
                        if (sc.found && !sc.disabled) {
                            console.warn('[Komfy Video] [PRE-SUBMIT GATE] ⚠️ Only', finalCount, '/', expectedImageCount,
                                'images detected but submit button ENABLED — proceeding anyway');
                        } else {
                            throw new Error(
                                'PRE-SUBMIT GATE FAILED: Chi co ' + finalCount + '/' + expectedImageCount +
                                ' anh tren Google Flow UI. Vui long thu lai.'
                            );
                        }
                    }
                }
            }
        }

        // =============================================
        // Phase 3: TYPE PROMPT (ngay truoc submit)
        // Type prompt CUOI CUNG — sau khi images da san sang —
        // de dam bao submit gui ca prompt + images cung luc.
        // =============================================
        // Re-focus textbox (paste co the da thay doi focus)
        await send('Runtime.evaluate', {
            expression: `(function(){
                var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
                if (tb) { tb.focus(); return true; } return false;
            })()`,
            returnByValue: true, awaitPromise: false,
        });
        await sleep(200);

        // Clear text + type prompt
        // ★ Khi co ingredient images: KHONG dung Ctrl+A + Backspace (se xoa ca images!)
        // Thay vao do: dung JS xoa text nodes, giu lai image elements
        if (expectedImageCount > 0) {
            await send('Runtime.evaluate', {
                expression: `(function(){
                    var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
                    if (!tb) return 'no-textbox';
                    // Di chuyen cursor ve cuoi textbox (sau images)
                    var sel = window.getSelection();
                    var range = document.createRange();
                    range.selectNodeContents(tb);
                    range.collapse(false); // collapse to end
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return 'cursor-at-end';
                })()`,
                returnByValue: true,
            });
            await sleep(100);
        } else {
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'a', code: 'KeyA', modifiers: 2 });
            await sleep(100);
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
            await send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Backspace', code: 'Backspace' });
            await sleep(100);
        }
        await send('Input.insertText', { text: prompt });
        await sleep(500);
        console.log('[Komfy Video] [STEP 3] Typed prompt:', prompt.substring(0, 40),
            '| images:', expectedImageCount);

        // =============================================
        // Phase 4: Submit (prompt + images da san sang)
        // =============================================

        // ★ INSTALL MutationObserver TRUOC submit — approach robust nhat de detect video moi.
        // Khong phu thuoc vao fetch hook hay beforeIds.
        // Observer ghi lai src cua video elements moi duoc add vao DOM SAU submit.
        // ★ SESSION ISOLATION: Moi task dung key rieng (__komfy_newVideoSrc_{sessionId})
        //   de tranh cross-task interference khi 2 task chay tren cung 1 page.
        const obsInstall = await send('Runtime.evaluate', {
            expression: `(function(){
                try {
                    var sessionKey = ${JSON.stringify(currentSessionId)};
                    // Snapshot tat ca video src hien tai truoc submit
                    var existingVideoSrcs = new Set();
                    document.querySelectorAll('video').forEach(function(v) {
                        [v.src, v.currentSrc, v.getAttribute('src')].forEach(function(s) {
                            if (s && s.length > 10) existingVideoSrcs.add(s);
                        });
                        v.querySelectorAll('source').forEach(function(src) {
                            var ss = src.getAttribute('src');
                            if (ss && ss.length > 10) existingVideoSrcs.add(ss);
                        });
                    });
                    // Cung snapshot media IDs tu src URLs (de so sanh du format khac nhau)
                    var existingMediaIds = new Set();
                    existingVideoSrcs.forEach(function(s) {
                        var m1 = s.match(/name=([^&]+)/);
                        if (m1) existingMediaIds.add(m1[1]);
                        var m2 = s.match(/ai-sandbox-videofx\\/(?:image|video)\\/([a-f0-9-]{32,36})/);
                        if (m2) existingMediaIds.add(m2[1]);
                    });
                    window.__komfy_preSubmitVideoSrcs__ = existingVideoSrcs;
                    window.__komfy_preSubmitMediaIds__ = existingMediaIds;
                    // Session-specific result keys
                    window['__komfy_newVideoSrc_' + sessionKey] = null;
                    window['__komfy_newVideoAt_' + sessionKey] = null;
                    // Also clear legacy shared key (backward compat)
                    window.__komfy_newVideoSrc__ = null;
                    window.__komfy_newVideoAt__ = null;

                    // Disconnect old observers
                    if (window.__komfy_videoObserver__) window.__komfy_videoObserver__.disconnect();
                    if (window.__komfy_videoAttrObserver__) window.__komfy_videoAttrObserver__.disconnect();

                    // Helper: check if a video src is NEW (not in pre-submit snapshot)
                    function isNewVideoSrc(src) {
                        if (!src || src.length < 10) return false;
                        if (existingVideoSrcs.has(src)) return false;
                        // Check media ID extraction
                        var m1 = src.match(/name=([^&]+)/);
                        if (m1 && existingMediaIds.has(m1[1])) return false;
                        var m2 = src.match(/ai-sandbox-videofx\\/(?:image|video)\\/([a-f0-9-]{32,36})/);
                        if (m2 && existingMediaIds.has(m2[1])) return false;
                        return true;
                    }

                    // Helper: check video/source elements for new src
                    function checkVideoElement(vid) {
                        var srcs = [vid.src, vid.currentSrc, vid.getAttribute('src')];
                        vid.querySelectorAll('source').forEach(function(s) { srcs.push(s.getAttribute('src')); });
                        for (var i = 0; i < srcs.length; i++) {
                            if (isNewVideoSrc(srcs[i])) return srcs[i];
                        }
                        return null;
                    }

                    // Helper: set result for THIS session (session-isolated)
                    function setResult(src) {
                        window['__komfy_newVideoSrc_' + sessionKey] = src;
                        window['__komfy_newVideoAt_' + sessionKey] = Date.now();
                        // Also set shared key for backward compat (last-write-wins)
                        window.__komfy_newVideoSrc__ = src;
                        window.__komfy_newVideoAt__ = Date.now();
                    }

                    // Observe new elements added to DOM
                    window.__komfy_videoObserver__ = new MutationObserver(function(mutations) {
                        if (window['__komfy_newVideoSrc_' + sessionKey]) return;
                        for (var m = 0; m < mutations.length; m++) {
                            var nodes = mutations[m].addedNodes;
                            for (var n = 0; n < nodes.length; n++) {
                                var node = nodes[n];
                                if (!node.querySelectorAll) continue;
                                var videos = node.tagName === 'VIDEO' ? [node] : Array.from(node.querySelectorAll('video'));
                                for (var v = 0; v < videos.length; v++) {
                                    var newSrc = checkVideoElement(videos[v]);
                                    if (newSrc) {
                                        setResult(newSrc);
                                        console.log('[Komfy Observer] ✅ New video element [' + sessionKey.substring(0,15) + ']:', newSrc.substring(0, 80));
                                        return;
                                    }
                                }
                                var sources = node.tagName === 'SOURCE' ? [node] : Array.from(node.querySelectorAll('source'));
                                for (var s = 0; s < sources.length; s++) {
                                    var ssrc = sources[s].getAttribute('src');
                                    if (isNewVideoSrc(ssrc)) {
                                        setResult(ssrc);
                                        console.log('[Komfy Observer] ✅ New source element [' + sessionKey.substring(0,15) + ']:', ssrc.substring(0, 80));
                                        return;
                                    }
                                }
                            }
                        }
                    });
                    window.__komfy_videoObserver__.observe(document.body, { childList: true, subtree: true });

                    // Observe src attribute changes on video AND source elements
                    window.__komfy_videoAttrObserver__ = new MutationObserver(function(mutations) {
                        if (window['__komfy_newVideoSrc_' + sessionKey]) return;
                        for (var m = 0; m < mutations.length; m++) {
                            var mut = mutations[m];
                            if (mut.type !== 'attributes' || mut.attributeName !== 'src') continue;
                            var tag = mut.target.tagName;
                            if (tag !== 'VIDEO' && tag !== 'SOURCE') continue;
                            var src = mut.target.src || mut.target.getAttribute('src');
                            if (isNewVideoSrc(src)) {
                                setResult(src);
                                console.log('[Komfy Observer] ✅ New src attr on ' + tag + ' [' + sessionKey.substring(0,15) + ']:', src.substring(0, 80));
                                return;
                            }
                        }
                    });
                    window.__komfy_videoAttrObserver__.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['src'] });

                    console.log('[Komfy Observer] Installed. Pre-submit videos:', existingVideoSrcs.size, '| mediaIds:', existingMediaIds.size);
                    return { ok: true, videoCount: existingVideoSrcs.size };
                } catch(e) {
                    console.error('[Komfy Observer] Install ERROR:', e.message);
                    return { ok: false, error: e.message };
                }
            })()`,
            returnByValue: true,
            awaitPromise: false,
        });
        console.log('[Komfy Video] Observer install result:', JSON.stringify(obsInstall?.result?.value));

        const submitTimestamp = Date.now(); // Capture TRUOC submit de dung lam temporal gate
        await send('Runtime.evaluate', {
            expression: `window.__komfy_genId__ = null; window.__komfy_genSid__ = null; window.__komfy_genIdAt__ = null; window.__komfy_clickTime = Date.now();`,
            awaitPromise: false,
        });

        const submitBtnInfo = await send('Runtime.evaluate', {
            expression: `(function(){
                var allClickable = Array.from(document.querySelectorAll('button,[role="button"]'));

                function isExcluded(text) {
                    var t = text.toLowerCase().trim();
                    if (t.startsWith('add_2') || t.startsWith('add_circle') || t === 'add' || t === 'add create' || t === 'add_2create') return true;
                    if (t === 'close' || t === '\u2715' || t === 'cancel' || t === 'x') return true;
                    return false;
                }
                function getCenter(r) { return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; }

                // Step 0: Add-Button Anchor
                var addBtnEl = null, addBtnR = null;
                for (var i = 0; i < allClickable.length; i++) {
                    var t0 = (allClickable[i].textContent || '').trim().toLowerCase();
                    var r0 = allClickable[i].getBoundingClientRect();
                    if (r0.width === 0 || r0.height === 0) continue;
                    if (t0.startsWith('add_2') || t0.startsWith('add_circle') || t0 === 'add' || t0 === 'add create' || t0 === 'add_2create') {
                        addBtnEl = allClickable[i]; addBtnR = r0; break;
                    }
                }
                if (addBtnEl && addBtnR) {
                    var addCY = addBtnR.top + addBtnR.height / 2;
                    var yTol = addBtnR.height + 30;
                    var best0 = null, bestX0 = -Infinity;
                    for (var j = 0; j < allClickable.length; j++) {
                        var r0j = allClickable[j].getBoundingClientRect();
                        if (r0j.width === 0 || r0j.height === 0) continue;
                        // ★ Gioi han height: submit button nho, gallery thumbnail lon
                        if (r0j.height > 80) continue;
                        if (Math.abs(r0j.top + r0j.height/2 - addCY) > yTol) continue;
                        if (r0j.left <= addBtnR.right) continue;
                        var t0j = (allClickable[j].textContent || '').trim();
                        if (isExcluded(t0j)) continue;
                        if (r0j.left > bestX0) { bestX0 = r0j.left; best0 = { r: r0j, text: t0j.substring(0,20) }; }
                    }
                    if (best0) { var c0 = getCenter(best0.r); return { found: true, method: 'add-anchor', text: best0.text, x: c0.x, y: c0.y }; }
                }

                // Step 1: Submit icon text
                for (var i = 0; i < allClickable.length; i++) {
                    var text = (allClickable[i].textContent || '').trim();
                    var r = allClickable[i].getBoundingClientRect();
                    if (r.width === 0 || r.height === 0 || r.height > 80 || r.top < window.innerHeight * 0.3) continue;
                    if (isExcluded(text)) continue;
                    if (text.includes('arrow_forward') || text.includes('send') || text.includes('chevron_right') || text === '>') {
                        return { found: true, method: 'submit-icon', text: text.substring(0,30), ...getCenter(r) };
                    }
                }

                // Step 2: aria-label
                for (var i = 0; i < allClickable.length; i++) {
                    var label = (allClickable[i].getAttribute('aria-label')||'').toLowerCase();
                    var text = (allClickable[i].textContent||'').trim();
                    var r = allClickable[i].getBoundingClientRect();
                    if (r.width === 0 || r.height === 0 || r.height > 80 || r.top < window.innerHeight * 0.3) continue;
                    if (isExcluded(text)) continue;
                    if (label.includes('create')||label.includes('send')||label.includes('generate')||label.includes('submit')) {
                        return { found: true, method: 'aria-label', text: text.substring(0,30), label, ...getCenter(r) };
                    }
                }

                // Step 3: Rightmost in bottom bar area (height < 80 de tranh gallery thumbnail)
                var best = null, bestX = -Infinity;
                for (var j = 0; j < allClickable.length; j++) {
                    var r = allClickable[j].getBoundingClientRect();
                    if (r.width === 0 || r.height === 0 || r.height > 80 || r.top < window.innerHeight * 0.3) continue;
                    // ★ Chi xet button o bottom bar (120px cuoi viewport)
                    if (r.bottom < window.innerHeight - 120) continue;
                    var text = (allClickable[j].textContent||'').trim();
                    if (isExcluded(text)) continue;
                    if (r.left > bestX) { bestX = r.left; best = { r, text: text.substring(0,20) }; }
                }
                if (best) { return { found: true, method: 'proximity-rightmost', text: best.text, ...getCenter(best.r) }; }

                var debugBtns = allClickable
                    .filter(function(b){ var r=b.getBoundingClientRect(); return r.top > window.innerHeight*0.3 && r.width > 0; })
                    .map(function(b){ var r=b.getBoundingClientRect(); return { tag: b.tagName.toLowerCase(), role: b.getAttribute('role')||'', text:(b.textContent||'').trim().substring(0,25), label:(b.getAttribute('aria-label')||'').substring(0,20), x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:Math.round(r.width) }; });
                return { found: false, debugBtns };
            })()`,
            returnByValue: true,
        });

        const submitBtn = submitBtnInfo?.result?.value;
        console.log('[Komfy Video] Submit btn:', JSON.stringify(submitBtn));

        if (submitBtn?.found) {
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: submitBtn.x, y: submitBtn.y, button: 'left', clickCount: 1 });
            await sleep(80);
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: submitBtn.x, y: submitBtn.y, button: 'left', clickCount: 1 });
            console.log('[Komfy Video] ✅ Submit clicked via CDP:', submitBtn.method, '| text:', submitBtn.text);
        } else {
            console.warn('[Komfy Video] ⚠️ Submit btn not found! Fallback Ctrl+Enter. debug:', JSON.stringify(submitBtn?.debugBtns));
            await send('Runtime.evaluate', { expression: `(function(){ var tb=document.querySelector('[role="textbox"],[contenteditable="true"]'); if(tb) tb.focus(); })()`, returnByValue: true });
            await sleep(200);
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 });
            await sleep(500);
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        }

        await sleep(1000);
        console.log('[Komfy Video] ✅ Generation submitted! Polling...');

        // === RELEASE UI MUTEX sau khi submit ===
        releaseMutex();
        releaseMutex = null;
        console.log('[Komfy Video] [UI-Mutex] 🔓 Released.');

        // === RELEASE CDP MUTEX ngay sau submit ===
        chrome.debugger.detach({ tabId }).catch(() => {});
        if (releaseCdpMutex) {
            releaseCdpMutex();
            releaseCdpMutex = null;
            console.log('[Komfy Video] [CDP-Mutex] 🔓 Released after submit.');
        }

        // =============================================
        // Phase: Poll ket qua
        // =============================================
        const generationId = await pollForGenerationResult(scriptEval, {
            requestId,
            currentSessionId,
            beforeIds,
            beforeVideoSrcs,
            beforeVideoCount,
            beforeContainerCount,
            submitTimestamp,
        });

        return { ok: true, status: 200, body: JSON.stringify({ generationResults: [{ generationId }] }) };

    } finally {
        // Safety: release mutexes neu chua release (loi xay ra truoc submit)
        if (releaseMutex) {
            releaseMutex();
            releaseMutex = null;
            console.log('[Komfy Video] [UI-Mutex] 🔓 Released in finally.');
        }
        chrome.debugger.detach({ tabId }).catch(() => {});
        if (releaseCdpMutex) {
            releaseCdpMutex();
            releaseCdpMutex = null;
            console.log('[Komfy Video] [CDP-Mutex] 🔓 Released in finally.');
        }
    }
}
