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

    // === Strategy 1b: tRPC via executeScript trong tab context (co cookie) ===
    // Service worker KHONG co Google session cookies → 401
    // Nhung tab Flow page CO cookies → goi tu tab context se thanh cong
    if (flowTab && rawId) {
        try {
            console.log('[Komfy] Trying tRPC via tab context (has cookies)...');
            const tRpcResults = await chrome.scripting.executeScript({
                target: { tabId: flowTab.id },
                world: 'MAIN',
                func: async (mediaId) => {
                    const trpcUrl = '/fx/api/trpc/media.getMediaUrlRedirect?name='
                        + encodeURIComponent(mediaId) + '&batch=1';
                    try {
                        const r = await fetch(trpcUrl, {
                            credentials: 'include',
                            redirect: 'follow',
                            headers: { 'accept': 'application/json' },
                        });
                        // If redirected to GCS, return the final URL
                        if (r.url && r.url.includes('storage.googleapis.com')) {
                            return { gcsUrl: r.url, method: 'tab-trpc-redirect' };
                        }
                        if (r.ok) {
                            const txt = await r.text();
                            const d = JSON.parse(txt);
                            const url = d?.[0]?.result?.data?.url || d?.[0]?.result?.data?.redirectUrl || d?.url;
                            if (url) return { gcsUrl: url, method: 'tab-trpc-json' };
                            // Extract from text
                            const m = txt.match(/"(https:\/\/[^"]*storage\.googleapis\.com[^"]*)"/);
                            if (m) return { gcsUrl: m[1], method: 'tab-trpc-regex' };
                        }
                        return { error: r.status + ': ' + (await r.text()).substring(0, 100) };
                    } catch (e) { return { error: e.message }; }
                },
                args: [rawId],
            });

            const tRpcResult = tRpcResults?.[0]?.result;
            console.log('[Komfy] tRPC via tab result:', JSON.stringify(tRpcResult)?.substring(0, 200));

            if (tRpcResult?.gcsUrl) {
                const gcsUrl = tRpcResult.gcsUrl;
                console.log('[Komfy] tRPC GCS URL (tab context) [' + tRpcResult.method + ']:', gcsUrl.substring(0, 100));
                const vr = await fetch(gcsUrl, { redirect: 'follow' });
                if (vr.ok) {
                    const buf = await vr.arrayBuffer();
                    const u8 = new Uint8Array(buf);
                    let b = ''; const C = 8192;
                    for (let i = 0; i < u8.length; i += C) b += String.fromCharCode.apply(null, u8.subarray(i, i + C));
                    console.log('[Komfy] tRPC tab-context download OK:', (buf.byteLength / 1024 / 1024).toFixed(2), 'MB ✅');
                    return { ok: true, status: 200, body: JSON.stringify({ base64: btoa(b), mimeType: 'video/mp4', size: buf.byteLength }) };
                }
            }
        } catch (e) {
            console.warn('[Komfy] tRPC tab-context error:', e.message);
        }
    }

    // === Strategy 2: Service Worker fetch voi Bearer + tRPC ===
    if (rawId) {
        const trpcUrl = 'https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name='
            + encodeURIComponent(rawId) + '&batch=1';
        try {
            console.log('[Komfy] SW tRPC fetch:', trpcUrl.substring(0, 100));
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 25000);

            const r1 = await fetch(trpcUrl, {
                credentials: 'include',
                redirect: 'follow',
                signal: ctrl.signal,
                headers: {
                    'authorization': sessionData.bearerToken || '',
                    'x-browser-validation': sessionData.xbv || '',
                    'accept': 'application/json',
                    'referer': 'https://labs.google/',
                    'origin': 'https://labs.google',
                },
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

