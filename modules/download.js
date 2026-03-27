// Media download (blob via CDP) and direct API calls.

/**
 * Download video blob.
 * Strategy 1: chrome.scripting.executeScript (KHONG dung debugger, khong conflict CDP mutex)
 *   → Lay signed GCS URL truc tiep tu DOM (video da render san trong Flow tab)
 *   → Signed URL khong can auth header → download truc tiep
 * Strategy 2: Service Worker fetch voi Bearer token (fallback)
 */
async function downloadBlobViaCDP(mediaId) {
    console.log('[Komfy] Download blob:', mediaId, '| bearer:', sessionData.bearerToken ? 'YES' : 'NO');

    // Strip prefix
    const rawId = mediaId.startsWith('MEDIA:') ? mediaId.slice(6)
                : mediaId.startsWith('DIRECT:') ? null
                : mediaId;

    // === Strategy 0: DIRECT URL (generationId la URL san) ===
    if (mediaId.startsWith('DIRECT:')) {
        const directUrl = mediaId.slice(7);
        try {
            console.log('[Komfy] DIRECT URL download:', directUrl.substring(0, 100));
            const r = await fetch(directUrl, { credentials: 'include', redirect: 'follow' });
            if (r.ok) {
                const buf = await r.arrayBuffer();
                const u8 = new Uint8Array(buf);
                let b = ''; const C = 8192;
                for (let i = 0; i < u8.length; i += C) b += String.fromCharCode.apply(null, u8.subarray(i, i + C));
                console.log('[Komfy] DIRECT download OK:', (buf.byteLength / 1024 / 1024).toFixed(2), 'MB');
                return { ok: true, status: 200, body: JSON.stringify({ base64: btoa(b), mimeType: 'video/mp4', size: buf.byteLength }) };
            }
            console.warn('[Komfy] DIRECT URL failed:', r.status);
        } catch (e) { console.warn('[Komfy] DIRECT error:', e.message); }
    }

    // === Strategy 1: chrome.scripting.executeScript ===
    // Lay signed GCS URL tu DOM - video da render san = URL hop le khong can auth
    // chrome.scripting KHONG conflict voi CDP mutex (khac voi chrome.debugger)
    const flowTab = await findFlowTab();
    if (flowTab && rawId) {
        try {
            console.log('[Komfy] Trying chrome.scripting to extract video src from DOM...');
            const results = await chrome.scripting.executeScript({
                target: { tabId: flowTab.id },
                world: 'MAIN',
                func: (searchId) => {
                    // Tim tat ca video/source elements
                    const allMedia = [
                        ...Array.from(document.querySelectorAll('video[src]')),
                        ...Array.from(document.querySelectorAll('source[src]')),
                    ];
                    const allSrcs = allMedia.map(el => el.src || el.getAttribute('src') || '').filter(Boolean);

                    // Candidate 1: src chứa rawId (exact match)
                    for (const s of allSrcs) {
                        if (s && s.includes(searchId)) return { url: s, method: 'exact-id' };
                    }

                    // KHÔNG dùng fallback lấy video bất kỳ trong DOM vì:
                    // - Khi có nhiều video, DOM luôn chứa video cũ đã render
                    // - Lấy video cuối = lấy nhầm video cũ
                    // → Fall through Strategy 1b (tRPC từ tab context, có cookies)
                    return { url: null, debugSrcs: allSrcs.slice(0, 5) };
                },
                args: [rawId],
            });

            const domResult = results?.[0]?.result;
            console.log('[Komfy] DOM result:', JSON.stringify(domResult).substring(0, 200));

            if (domResult?.url) {
                const gcsUrl = domResult.url;
                console.log('[Komfy] Found signed GCS URL via DOM [' + domResult.method + ']:', gcsUrl.substring(0, 100));

                // Download signed URL (khong can auth)
                const vr = await fetch(gcsUrl, { redirect: 'follow' });
                if (vr.ok) {
                    const buf = await vr.arrayBuffer();
                    const u8 = new Uint8Array(buf);
                    let b = ''; const C = 8192;
                    for (let i = 0; i < u8.length; i += C) b += String.fromCharCode.apply(null, u8.subarray(i, i + C));
                    console.log('[Komfy] Scripting download OK:', (buf.byteLength / 1024 / 1024).toFixed(2), 'MB ✅');
                    return { ok: true, status: 200, body: JSON.stringify({ base64: btoa(b), mimeType: 'video/mp4', size: buf.byteLength }) };
                }
                console.warn('[Komfy] GCS fetch failed:', vr.status);
            }
        } catch (e) {
            console.warn('[Komfy] chrome.scripting error:', e.message);
        }
    }

    // === Strategy 1b: aisandbox API via SERVICE WORKER fetch (bypasses CORS) ===
    if (rawId && sessionData.bearerToken) {
        const swHeaders = {
            'authorization': sessionData.bearerToken,
            'content-type': 'application/json',
            'origin': 'https://labs.google',
            'referer': 'https://labs.google/',
        };
        // Add google extension headers if available
        if (sessionData.googExts) {
            for (const k of Object.keys(sessionData.googExts)) swHeaders[k] = sessionData.googExts[k];
        }

        const endpoints = [
            {
                // ★ getMedia: video returns encodedVideo, image may return imageBytes
                name: 'getMedia',
                url: 'https://aisandbox-pa.googleapis.com/v1/media/' + rawId,
                method: 'GET',
                body: null,
            },
            {
                // ★ getMedia-project: image media are project-scoped, this may work better for images
                name: 'getMedia-project',
                url: 'https://aisandbox-pa.googleapis.com/v1/projects/' + sessionData.projectId + '/media/' + rawId,
                method: 'GET',
                body: null,
            },
            {
                name: 'exportMedia',
                url: 'https://aisandbox-pa.googleapis.com/v1/media:exportMedia',
                method: 'POST',
                body: JSON.stringify({ mediaName: rawId, projectId: sessionData.projectId }),
            },
            {
                name: 'getSignedUrl',
                url: 'https://aisandbox-pa.googleapis.com/v1/media/' + rawId + ':getSignedUrl',
                method: 'POST',
                body: JSON.stringify({ projectId: sessionData.projectId }),
            },
            {
                name: 'batchGetMedia',
                url: 'https://aisandbox-pa.googleapis.com/v1/media:batchGetMedia',
                method: 'POST',
                body: JSON.stringify({ mediaNames: [rawId], projectId: sessionData.projectId }),
            },
            {
                name: 'exportVideo',
                url: 'https://aisandbox-pa.googleapis.com/v1/video:exportVideo',
                method: 'POST',
                body: JSON.stringify({ name: rawId, projectId: sessionData.projectId }),
            },
        ];

        let epIndex = 0;
        for (const ep of endpoints) {
            // Human-like pause between endpoint attempts (avoid rapid-fire API probing)
            if (epIndex > 0) await humanDelay(800, 2000);
            epIndex++;
            try {
                console.log('[Komfy] SW trying', ep.name, '...');
                const ctrl = new AbortController();
                // getMedia/getMedia-project returns full base64 data in body → needs longer timeout
                const timeoutMs = ep.name.startsWith('getMedia') ? 120000 : 15000;
                const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
                const fetchOpts = {
                    method: ep.method,
                    headers: swHeaders,
                    signal: ctrl.signal,
                    redirect: 'follow',
                };
                if (ep.body) fetchOpts.body = ep.body;

                const epRes = await fetch(ep.url, fetchOpts);
                clearTimeout(timeout);

                // Check if redirected to video file
                if (epRes.url && (epRes.url.includes('storage.googleapis.com') || epRes.url.includes('googleusercontent.com'))) {
                    console.log('[Komfy] ✅', ep.name, 'redirected to:', epRes.url.substring(0, 100));
                    if (epRes.ok) {
                        const buf = await epRes.arrayBuffer();
                        const u8 = new Uint8Array(buf);
                        let b = ''; const C = 8192;
                        for (let i = 0; i < u8.length; i += C) b += String.fromCharCode.apply(null, u8.subarray(i, i + C));
                        console.log('[Komfy]', ep.name, 'download OK:', (buf.byteLength / 1024 / 1024).toFixed(2), 'MB ✅');
                        return { ok: true, status: 200, body: JSON.stringify({ base64: btoa(b), mimeType: 'video/mp4', size: buf.byteLength }) };
                    }
                }

                const txt = await epRes.text();
                console.log('[Komfy]', ep.name, 'status:', epRes.status, '| body:', txt.substring(0, 400));

                if (epRes.ok && txt) {
                    // Check for encoded media data directly in response (base64)
                    try {
                        const d = JSON.parse(txt);

                        // === VIDEO: encodedVideo (base64 MP4) ===
                        const encVideo = d?.video?.encodedVideo || d?.media?.[0]?.video?.encodedVideo;
                        if (encVideo) {
                            const size = Math.round(encVideo.length * 3 / 4);
                            console.log('[Komfy]', ep.name, 'encodedVideo found!', (size / 1024 / 1024).toFixed(2), 'MB ✅');
                            return { ok: true, status: 200, body: JSON.stringify({ base64: encVideo, mimeType: 'video/mp4', size }) };
                        }

                        // === IMAGE: imageBytes / encodedImage (base64 PNG/JPEG) ===
                        const imgData = d?.image || d?.media?.[0]?.image;
                        const encImage = imgData?.imageBytes || imgData?.encodedImage || imgData?.bytesBase64Encoded;
                        if (encImage) {
                            const mimeType = imgData?.mimeType || 'image/png';
                            const size = Math.round(encImage.length * 3 / 4);
                            console.log('[Komfy]', ep.name, 'imageBytes found!', (size / 1024).toFixed(0), 'KB ✅');
                            return { ok: true, status: 200, body: JSON.stringify({ base64: encImage, mimeType, size }) };
                        }
                    } catch(e) {}

                    // Search for any video URL in response
                    const gcsMatch = txt.match(/"(https:\/\/[^"]*storage\.googleapis\.com[^"]*)"/);
                    const ucMatch = txt.match(/"(https:\/\/[^"]*googleusercontent\.com[^"]*)"/);
                    let foundUrl = null;
                    try {
                        const d = JSON.parse(txt);
                        foundUrl = d?.signedUrl || d?.url || d?.downloadUrl || d?.uri || d?.exportUri
                            || d?.media?.[0]?.signedUrl || d?.media?.[0]?.url || d?.media?.[0]?.uri;
                    } catch(e) {}
                    foundUrl = foundUrl || gcsMatch?.[1] || ucMatch?.[1];

                    if (foundUrl) {
                        console.log('[Komfy] ✅ Found video URL via', ep.name, ':', foundUrl.substring(0, 100));
                        const vr = await fetch(foundUrl, { redirect: 'follow' });
                        if (vr.ok) {
                            const buf = await vr.arrayBuffer();
                            const u8 = new Uint8Array(buf);
                            let b2 = ''; const C2 = 8192;
                            for (let i = 0; i < u8.length; i += C2) b2 += String.fromCharCode.apply(null, u8.subarray(i, i + C2));
                            console.log('[Komfy]', ep.name, 'download OK:', (buf.byteLength / 1024 / 1024).toFixed(2), 'MB ✅');
                            return { ok: true, status: 200, body: JSON.stringify({ base64: btoa(b2), mimeType: 'video/mp4', size: buf.byteLength }) };
                        }
                    }
                }
            } catch (epErr) {
                if (epErr.name === 'AbortError') {
                    console.log('[Komfy]', ep.name, 'timeout');
                } else {
                    console.log('[Komfy]', ep.name, 'error:', epErr.message);
                }
            }
        }
    }

    // === Strategy 1c: tRPC via tab context (correct batch format) ===
    if (flowTab && rawId) {
        // Pause before switching to tRPC strategy
        await humanDelay(500, 1200);
        try {
            console.log('[Komfy] Trying tRPC via tab context (batch format)...');
            const tRpcResults = await chrome.scripting.executeScript({
                target: { tabId: flowTab.id },
                world: 'MAIN',
                func: async (mediaId, projectId) => {
                    // Try multiple tRPC endpoints with correct batch format
                    const endpoints = [
                        { name: 'media.getMediaUrlRedirect', payload: { name: mediaId } },
                        { name: 'media.getMediaUrlRedirect', payload: { mediaName: mediaId, projectId } },
                        { name: 'media.getMediaUrl', payload: { name: mediaId, projectId } },
                        { name: 'media.getMedia', payload: { name: mediaId, projectId } },
                        { name: 'media.get', payload: { name: mediaId } },
                    ];

                    for (const ep of endpoints) {
                        try {
                            // tRPC batch POST format
                            const r = await fetch('/fx/api/trpc/' + ep.name + '?batch=1', {
                                method: 'POST',
                                credentials: 'include',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ '0': { json: ep.payload } }),
                            });
                            const txt = await r.text();
                            if (r.ok) {
                                // Check for redirect URL in response
                                const gcs = txt.match(/"(https:\/\/[^"]*storage\.googleapis\.com[^"]*)"/);
                                const uc = txt.match(/"(https:\/\/[^"]*googleusercontent\.com[^"]*)"/);
                                if (gcs || uc) return { gcsUrl: (gcs || uc)[1], method: 'trpc-' + ep.name };
                                // Check JSON response
                                try {
                                    const d = JSON.parse(txt);
                                    const url = d?.[0]?.result?.data?.json?.url || d?.[0]?.result?.data?.json?.redirectUrl
                                        || d?.[0]?.result?.data?.url || d?.[0]?.result?.data?.redirectUrl;
                                    if (url) return { gcsUrl: url, method: 'trpc-' + ep.name };
                                } catch(e) {}
                            }
                            // Log for debugging
                            if (r.status !== 404) {
                                return { error: ep.name + ': ' + r.status + ' ' + txt.substring(0, 150) };
                            }
                        } catch(e) {}
                    }
                    return { error: 'All tRPC endpoints failed' };
                },
                args: [rawId, sessionData.projectId],
            });

            const tRpcResult = tRpcResults?.[0]?.result;
            console.log('[Komfy] tRPC via tab result:', JSON.stringify(tRpcResult)?.substring(0, 300));

            if (tRpcResult?.gcsUrl) {
                console.log('[Komfy] tRPC GCS URL [' + tRpcResult.method + ']:', tRpcResult.gcsUrl.substring(0, 100));
                const vr = await fetch(tRpcResult.gcsUrl, { redirect: 'follow' });
                if (vr.ok) {
                    const buf = await vr.arrayBuffer();
                    const u8 = new Uint8Array(buf);
                    let b = ''; const C = 8192;
                    for (let i = 0; i < u8.length; i += C) b += String.fromCharCode.apply(null, u8.subarray(i, i + C));
                    console.log('[Komfy] tRPC download OK:', (buf.byteLength / 1024 / 1024).toFixed(2), 'MB ✅');
                    return { ok: true, status: 200, body: JSON.stringify({ base64: btoa(b), mimeType: 'video/mp4', size: buf.byteLength }) };
                }
            }
        } catch (e) {
            console.warn('[Komfy] tRPC tab-context error:', e.message);
        }
    }

    // === Strategy 2: Service Worker fetch voi Bearer + tRPC (POST batch format) ===
    if (rawId) {
        await humanDelay(500, 1000);
        const trpcUrl = 'https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?batch=1';
        try {
            console.log('[Komfy] SW tRPC POST fetch:', trpcUrl.substring(0, 100));
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 25000);

            const r1 = await fetch(trpcUrl, {
                method: 'POST',
                credentials: 'include',
                redirect: 'follow',
                signal: ctrl.signal,
                headers: {
                    'authorization': sessionData.bearerToken || '',
                    'x-browser-validation': sessionData.xbv || '',
                    'content-type': 'application/json',
                    'referer': 'https://labs.google/',
                    'origin': 'https://labs.google',
                },
                body: JSON.stringify({ '0': { json: { name: rawId, projectId: sessionData.projectId } } }),
            });
            clearTimeout(t);
            console.log('[Komfy] tRPC status:', r1.status, 'finalUrl:', r1.url.substring(0, 80));

            let gcsUrl = null;
            if (r1.url && r1.url.includes('storage.googleapis.com')) {
                gcsUrl = r1.url;
            }
            if (!gcsUrl && r1.ok) {
                try {
                    const txt = await r1.text();
                    console.log('[Komfy] tRPC body:', txt.substring(0, 300));
                    const d = JSON.parse(txt);
                    gcsUrl = d?.[0]?.result?.data?.url || d?.[0]?.result?.data?.redirectUrl || d?.url;
                    if (!gcsUrl) {
                        const m = txt.match(/"(https:\/\/[^"]*storage\.googleapis\.com[^"]*)"/);
                        if (m) gcsUrl = m[1];
                    }
                } catch (e) { console.warn('[Komfy] tRPC parse:', e.message); }
            }

            if (gcsUrl) {
                console.log('[Komfy] tRPC GCS URL:', gcsUrl.substring(0, 100));
                const vr = await fetch(gcsUrl, { redirect: 'follow' });
                if (vr.ok) {
                    const buf = await vr.arrayBuffer();
                    const u8 = new Uint8Array(buf);
                    let b = ''; const C = 8192;
                    for (let i = 0; i < u8.length; i += C) b += String.fromCharCode.apply(null, u8.subarray(i, i + C));
                    console.log('[Komfy] tRPC download OK:', (buf.byteLength / 1024 / 1024).toFixed(2), 'MB ✅');
                    return { ok: true, status: 200, body: JSON.stringify({ base64: btoa(b), mimeType: 'video/mp4', size: buf.byteLength }) };
                }
                console.warn('[Komfy] tRPC GCS failed:', vr.status);
            }
        } catch (e) {
            console.warn('[Komfy] SW tRPC error:', e.message);
        }
    }

    throw new Error('Khong download duoc video. MediaId: ' + mediaId + ' rawId: ' + rawId);
}


/**
 * Kiem tra trang thai video truc tiep tu background
 */
async function checkStatusDirect(endpoint, body) {
    const FLOW_API = 'https://aisandbox-pa.googleapis.com/v1';
    const url = FLOW_API + endpoint;
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    console.log('[Komfy Status] I2V URL:', url);

    // Method 1: Generate fresh reCAPTCHA token before fetch to avoid "Token burnt" 403 error
    const tab = await findFlowTab();
    if (tab) {
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                func: async () => {
                    if (window.grecaptcha && window.grecaptcha.enterprise) {
                        try {
                            return await window.grecaptcha.enterprise.execute(
                                '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV',
                                { action: 'video_generation' }
                            );
                        } catch(e) { return null; }
                    }
                    return null;
                }
            });
            const freshXbv = results?.[0]?.result;
            if (freshXbv) {
                sessionData.xbv = freshXbv;
                console.log('[Komfy Status] Grabbed fresh reCAPTCHA token successfully');
            }
        } catch (e) {
            console.warn('[Komfy Status] Failed to grab fresh reCAPTCHA:', e.message);
        }
    }

    // Fetch from service worker (can bypass CORS safely if it has cookies)
    console.log('[Komfy Status] SW sending API request...');
    const swHeaders = {
        'authorization': sessionData.bearerToken || '',
        'x-browser-validation': sessionData.xbv || '',
        'content-type': 'application/json', // Flow uses application/json
        'origin': 'https://labs.google',
        'referer': 'https://labs.google/',
    };
    if (sessionData.googExts) {
        for (const k of Object.keys(sessionData.googExts)) swHeaders[k] = sessionData.googExts[k];
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: swHeaders,
        body: bodyStr,
    });
    const text = await response.text();
    console.log('[Komfy Status] API responded with status:', response.status);
    return { ok: response.ok, status: response.status, body: text };
}

// Resolve project name from lock or projectMap reverse lookup
function _resolveProjectName(projectMap) {
    // 1. Active lock name (task dang chay)
    if (typeof _projectLock !== 'undefined' && _projectLock?.activeName) return _projectLock.activeName;
    // 2. Reverse lookup: find project name for current sessionData.projectId
    if (sessionData.projectId && projectMap) {
        for (const [name, id] of Object.entries(projectMap)) {
            if (id === sessionData.projectId) return name;
        }
    }
    return null;
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
    // ★ Token captured from page fetch interceptor (content_fetch_interceptor.js → content_isolated.js)
    if (message.action === 'TOKEN_CAPTURED' && message.token) {
        if (sessionData.bearerToken !== message.token) {
            sessionData.bearerToken = message.token;
            if (message.projectId) sessionData.projectId = message.projectId;
            console.log('[Komfy] ✅ Token captured from page fetch interceptor' + (message.projectId ? ' (project: ' + message.projectId.substring(0, 12) + ')' : ''));
            persistToken();
            sendToProxy().catch(() => {});
        }
    }
    if (message.action === 'GET_STATE') {
        // Resolve project name: active lock name, or reverse lookup from projectMap
        chrome.storage.local.get(['komfyProjectMap'], (stored) => {
            const pName = _resolveProjectName(stored.komfyProjectMap);
            sendResponse(Object.assign({}, sessionData, { projectName: pName }));
        });
        return true;
    }
    if (message.action === 'CLEAR_PROJECT_CACHE') {
        clearProjectCache().then(() => {
            sendResponse({ ok: true });
        });
        return true;
    }
    if (message.action === 'FORCE_SYNC') {
        sendToProxy().finally(() => {
            chrome.storage.local.get(['komfyProjectMap'], (stored) => {
                const pName = _resolveProjectName(stored.komfyProjectMap);
                sendResponse(Object.assign({}, sessionData, { projectName: pName }));
            });
        });
        return true;
    }
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

