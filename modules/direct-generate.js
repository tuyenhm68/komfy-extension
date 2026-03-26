// ============================================================
// direct-generate.js — Direct API generation (bypass UI automation)
//
// Goi API truc tiep tu page context thong qua chrome.scripting + fetch()
// Khong can click UI, khong phu thuoc ngon ngu, khong phu thuoc layout.
//
// Dieu kien: Tab Flow phai dang mo (de lay cookies, reCAPTCHA token)
// Fallback: Neu Direct API fail → polling.js chuyen sang UI automation
// ============================================================

// ============================================================
// SECTION 1: Constants & Configuration
// ============================================================

const FLOW_API_BASE = 'https://aisandbox-pa.googleapis.com/v1';
const RECAPTCHA_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const VIDEO_POLL_MAX_MS = 15 * 60 * 1000; // 15 phut
const VIDEO_POLL_INTERVAL_MS = 11000;      // ~11s ± jitter
const VIDEO_POLL_JITTER_MS = 3000;

// ============================================================
// SECTION 2: Low-level Helpers (fetch, encode, reCAPTCHA)
// ============================================================

/** Build API headers — dung text/plain de tranh CORS preflight */
function buildApiHeaders(bearerToken) {
    const h = {
        'authorization': bearerToken || '',
        'content-type': 'text/plain;charset=UTF-8',
    };
    if (sessionData.xbv) h['x-browser-validation'] = sessionData.xbv;
    return h;
}

/** Build SW (Service Worker) headers — them TAT CA session headers cho cross-origin
 *  ★ Image upload (uploadFrameImage) thanh cong vi co x-browser-validation.
 *  Video generation can THEM x-client-data va x-goog-ext-* de server khong tra 404.
 */
function buildSwHeaders(bearerToken) {
    const h = {
        'authorization': bearerToken || '',
        'content-type': 'text/plain;charset=UTF-8',
        'accept': '*/*',
        'origin': 'https://labs.google',
        'referer': 'https://labs.google/',
    };
    // ★ Add all captured session headers
    if (sessionData.xbv) h['x-browser-validation'] = sessionData.xbv;
    if (sessionData.xClientData) h['x-client-data'] = sessionData.xClientData;
    if (sessionData.googExts) {
        for (const [key, val] of Object.entries(sessionData.googExts)) {
            if (val) h[key] = val;
        }
    }
    return h;
}

/** Generate UUID (compatible voi ca browser va SW) */
function generateUUID() {
    return crypto.randomUUID
        ? crypto.randomUUID()
        : (Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2));
}

/** Build clientContext chung cho moi API call */
function buildClientContext(projectId, recaptchaToken) {
    return {
        projectId,
        tool: 'PINHOLE',
        userPaygateTier: 'PAYGATE_TIER_TWO',
        sessionId: ';' + Date.now(),
        recaptchaContext: {
            token: recaptchaToken || '',
            applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
        },
    };
}

/** Tao result object thanh cong (tranh lap di lap lai) */
function successResult(data) {
    return { ok: true, body: JSON.stringify(data) };
}

// --- reCAPTCHA ---

async function getFreshRecaptchaToken(tabId, action) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: async (siteKey, actionName) => {
                if (window.grecaptcha?.enterprise) {
                    try {
                        return await window.grecaptcha.enterprise.execute(siteKey, { action: actionName });
                    } catch (e) { return null; }
                }
                return null;
            },
            args: [RECAPTCHA_SITE_KEY, action],
        });
        return results?.[0]?.result || null;
    } catch (e) {
        console.warn('[Komfy Direct] reCAPTCHA error:', e.message);
        return null;
    }
}

/** Refresh reCAPTCHA token va cap nhat sessionData */
async function refreshRecaptcha(tabId, action) {
    const token = await getFreshRecaptchaToken(tabId, action);
    if (token) sessionData.xbv = token;
    return token;
}

// --- Page Context Fetch via CDP ---

/**
 * Goi API tu page context qua CDP Runtime.evaluate (bypass CSP).
 * chrome.scripting.executeScript bi CSP cua labs.google block → dung CDP thay the.
 * CDP Runtime.evaluate chay trong page JS context, co cookies va session.
 * Co retry 1 lan + SW fallback neu page context fail.
 */
async function callApiFromPage(tabId, url, bodyStr, headers, _retryCount = 0) {
    console.log('[Komfy Direct] callApiFromPage attempt', _retryCount, '| url:', url.substring(0, 80), '| bodyLen:', bodyStr.length, '| auth:', (headers['authorization'] || '').substring(0, 20) + '...');

    let result = { ok: false, status: 0, error: 'No result' };

    try {
        // ★ Dung chrome.scripting.executeScript thay cho chrome.debugger
        // Advantages: bypass CSP, co cookies, co session, va KHONG HIEN THONG BAO "Started debugging"
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: async (url, headers, bodyStr) => {
                try {
                    var nativeFetch = window.__komfy_nativeFetch__ || window.__komfy_origFetch__ || window.fetch;
                    var fetchName = window.__komfy_nativeFetch__ ? 'nativeFetch' : (window.__komfy_origFetch__ ? 'origFetch' : 'window.fetch');
                    console.log('[Komfy Direct API] Using:', fetchName, '| url:', url.substring(0, 60));
                    var res = await nativeFetch.call(window, url, {
                        method: 'POST',
                        headers: headers,
                        body: bodyStr,
                        credentials: 'include'
                    });
                    var text = await res.text();
                    console.log('[Komfy Direct API] Response:', res.status, res.ok, '| bodyLen:', text.length);
                    return JSON.stringify({ ok: res.ok, status: res.status, body: text, fetchUsed: fetchName });
                } catch (e) {
                    console.error('[Komfy Direct API] FETCH ERROR:', e.message);
                    return JSON.stringify({ ok: false, status: 0, error: e.message, detail: e.toString() });
                }
            },
            args: [url, headers, bodyStr]
        });

        const rawVal = results?.[0]?.result;
        if (rawVal) {
            try {
                result = JSON.parse(rawVal);
            } catch (pe) {
                result = { ok: false, status: 0, error: 'Script result parse error: ' + pe.message, body: String(rawVal).substring(0, 200) };
            }
        } else {
            result = { ok: false, status: 0, error: 'Script injection yielded no result.' };
        }

    } catch (injErr) {
        console.error('[Komfy Direct] Script injection error:', injErr.message);
        result = { ok: false, status: 0, error: 'Injection error: ' + injErr.message };
    }

    console.log('[Komfy Direct] callApiFromPage result:', 'status=' + result.status, 'ok=' + result.ok, 'fetchUsed=' + (result.fetchUsed || 'N/A'), 'error=' + (result.error || 'none'), 'bodyPreview=' + (result.body || '').substring(0, 200));

    // Retry 1 lan: "Failed to fetch" thuong do tab chua san sang
    if (!result.ok && result.status === 0 && _retryCount < 1) {
        console.warn('[Komfy Direct] Page fetch failed (status 0):', result.error, '→ retry in 2s');
        await new Promise(r => setTimeout(r, 2000));
        return callApiFromPage(tabId, url, bodyStr, headers, _retryCount + 1);
    }

    // Fallback: Service Worker fetch (khong bi CORS nho host_permissions)
    if (!result.ok && result.status === 0) {
        console.warn('[Komfy Direct] Page fetch FAILED after retry → trying SW fallback...');
        try {
            const swRes = await fetch(url, {
                method: 'POST',
                headers: buildSwHeaders(headers['authorization'] || headers['Authorization']),
                body: bodyStr,
            });
            const swText = await swRes.text();
            console.log('[Komfy Direct] SW fetch status:', swRes.status);
            return { ok: swRes.ok, status: swRes.status, body: swText };
        } catch (swErr) {
            console.warn('[Komfy Direct] SW fetch also failed:', swErr.message);
            return { ok: false, status: 0, error: `All fetch failed: CDP(${result.error}) + SW(${swErr.message})` };
        }
    }

    return result;
}

// --- Ensure tab + credentials ---

async function ensureTabAndCredentials(projectName) {
    const tab = await ensureFlowTab(false, projectName);
    if (!sessionData.bearerToken) throw new Error('DIRECT_API_NO_TOKEN');
    if (!sessionData.projectId) throw new Error('DIRECT_API_NO_PROJECT');
    return { tab, projectId: sessionData.projectId };
}

/** Log tab state before API call (debug helper) */
async function logTabState(tabId) {
    try {
        const info = await chrome.tabs.get(tabId);
        console.log('[Komfy Direct] Tab:', info.status, '| url:', info.url?.substring(0, 60),
            '| token:', sessionData.bearerToken ? 'yes' : 'NONE');
    } catch (e) { /* tab may not exist */ }
}

// ============================================================
// SECTION 3: Download Helpers
// ============================================================

/** Download image tu signed URL (chay trong page context) */
async function downloadSignedUrl(tabId, signedUrl) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (url) => {
            try {
                const r = await fetch(url);
                if (!r.ok) return { error: 'HTTP ' + r.status };
                const buf = await r.arrayBuffer();
                const u8 = new Uint8Array(buf);
                let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                return { base64: btoa(s), mimeType: r.headers.get('content-type') || 'image/jpeg', size: buf.byteLength };
            } catch (e) {
                return { error: e.message };
            }
        },
        args: [signedUrl],
    });
    return results?.[0]?.result || { error: 'No script result' };
}

/** Download image qua tRPC getMediaUrlRedirect (follow 307 → GCS) */
async function downloadViaTrpcRedirect(tabId, mediaId) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (mid) => {
            try {
                const trpcUrl = '/fx/api/trpc/media.getMediaUrlRedirect?name=' + encodeURIComponent(mid) + '&batch=1';
                const r = await fetch(trpcUrl, { credentials: 'include', redirect: 'follow' });
                if (!r.ok) return { error: 'tRPC HTTP ' + r.status };

                const ct = r.headers.get('content-type') || '';
                // Direct image response
                if (ct.includes('image')) {
                    const buf = await r.arrayBuffer();
                    const u8 = new Uint8Array(buf);
                    let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                    return { base64: btoa(s), mimeType: ct, size: buf.byteLength };
                }

                // JSON response — extract GCS URL
                const txt = await r.text();
                const m = txt.match(/"(https:\/\/[^"]*storage\.googleapis\.com[^"]*)"/);
                if (m) {
                    const imgR = await fetch(m[1]);
                    if (imgR.ok) {
                        const buf = await imgR.arrayBuffer();
                        const u8 = new Uint8Array(buf);
                        let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                        return { base64: btoa(s), mimeType: imgR.headers.get('content-type') || 'image/jpeg', size: buf.byteLength };
                    }
                }
                return { error: 'No image in tRPC response' };
            } catch (e) {
                return { error: e.message };
            }
        },
        args: [mediaId],
    });
    return results?.[0]?.result || { error: 'No script result' };
}

/**
 * Download image data tu nhieu strategy khac nhau.
 * @param {number} tabId
 * @param {object} parsedBody - { method, imageUrl?, mediaId? }
 * @returns {object} - { ok, body } hoac throw
 */
async function downloadImageData(tabId, parsedBody) {
    // Strategy 1: Signed URL (fifeUrl)
    if (parsedBody?.method === 'direct-api-url' && parsedBody?.imageUrl) {
        console.log('[Komfy Direct] Downloading from signed URL...', parsedBody.imageUrl.substring(0, 80));

        // Try page context first
        const dlResult = await downloadSignedUrl(tabId, parsedBody.imageUrl);
        if (dlResult?.base64) {
            console.log('[Komfy Direct] ✅ Image from signed URL!', ((dlResult.size || 0) / 1024).toFixed(0), 'KB');
            return successResult({
                base64: dlResult.base64,
                mimeType: dlResult.mimeType || 'image/jpeg',
                size: dlResult.size || 0,
                method: 'direct-api',
            });
        }
        console.warn('[Komfy Direct] Signed URL page download failed:', dlResult?.error);

        // Fallback: SW fetch
        try {
            const swRes = await fetch(parsedBody.imageUrl);
            if (swRes.ok) {
                const buf = await swRes.arrayBuffer();
                const u8 = new Uint8Array(buf);
                let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                console.log('[Komfy Direct] ✅ Image via SW fetch!', (buf.byteLength / 1024).toFixed(0), 'KB');
                return successResult({
                    base64: btoa(s),
                    mimeType: swRes.headers.get('content-type') || 'image/jpeg',
                    size: buf.byteLength,
                    method: 'direct-api',
                });
            }
        } catch (swErr) {
            console.warn('[Komfy Direct] SW fetch fallback failed:', swErr.message?.substring(0, 80));
        }
        throw new Error('DIRECT_API_DOWNLOAD_FAILED:signed-url');
    }

    // Strategy 2: mediaId → tRPC redirect
    if (parsedBody?.method === 'direct-api-media' && parsedBody?.mediaId) {
        console.log('[Komfy Direct] Downloading via tRPC redirect, mediaId:', parsedBody.mediaId.substring(0, 20));
        const dlResult = await downloadViaTrpcRedirect(tabId, parsedBody.mediaId);
        if (dlResult?.base64) {
            console.log('[Komfy Direct] ✅ Image via tRPC!', ((dlResult.size || 0) / 1024).toFixed(0), 'KB');
            return successResult({
                base64: dlResult.base64,
                mimeType: dlResult.mimeType || 'image/jpeg',
                size: dlResult.size || 0,
                method: 'direct-api',
            });
        }
        throw new Error('DIRECT_API_DOWNLOAD_FAILED:' + parsedBody.mediaId);
    }

    return null; // Khong can download (da co data san)
}

// ============================================================
// SECTION 4: Model & Aspect Ratio Mapping
// ============================================================

function mapImageModelKey(modelName) {
    const lower = (modelName || '').toLowerCase();
    if (lower.includes('pro')) return 'GEM_PIX_2';
    if (lower.includes('banana 2') || lower.includes('nano banana')) return 'NARWHAL';
    if (lower.includes('banana')) return 'GEM_PIX_0';
    return 'NARWHAL';
}

function mapImageAspectRatio(ratio) {
    const r = (ratio || '').toLowerCase().replace(/\s/g, '');
    if (r === '16:9' || r === 'landscape') return 'IMAGE_ASPECT_RATIO_LANDSCAPE';
    if (r === '9:16' || r === 'portrait') return 'IMAGE_ASPECT_RATIO_PORTRAIT';
    if (r === '1:1' || r === 'square') return 'IMAGE_ASPECT_RATIO_SQUARE';
    // Already in API format
    if (r.includes('LANDSCAPE') || r.includes('PORTRAIT') || r.includes('SQUARE')) return ratio;
    return 'IMAGE_ASPECT_RATIO_LANDSCAPE';
}

/** Chuyen videoModelKey tu t2v sang r2v + them _ultra neu chua co */
function toR2VModelKey(modelKey) {
    if (!modelKey) return modelKey;
    let mk = modelKey.replace('t2v', 'r2v');
    if (!mk.includes('_ultra')) mk += '_ultra';
    return mk;
}

/** Chuyen videoModelKey tu r2v ve t2v */
function toT2VModelKey(modelKey) {
    if (!modelKey) return modelKey;
    return modelKey.replace('r2v', 't2v');
}

/** Parse ingredient data URLs → referenceImages array */
function parseIngredientImages(imageDataUrls) {
    const refs = [];
    for (const imgDataUrl of imageDataUrls) {
        if (!imgDataUrl || !imgDataUrl.startsWith('data:')) continue;
        const b64 = imgDataUrl.split(',')[1];
        const mimeMatch = imgDataUrl.match(/^data:([^;]+);/);
        refs.push({
            imageBytes: b64,
            mimeType: mimeMatch ? mimeMatch[1] : 'image/png',
            imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
        });
    }
    return refs;
}

// ============================================================
// SECTION 5: Response Parsers
// ============================================================

/** Tim image data hoac URL tu API response */
function parseImageApiResponse(data) {
    console.log('[Komfy Direct] Image response keys:', Object.keys(data));

    // Format 1: flowMedia response — { media: [{ image: {...} }] }
    const first = data?.media?.[0];
    if (first) {
        const img = first.image;
        console.log('[Komfy Direct] media[0] keys:', Object.keys(first), '| name:', first.name?.substring(0, 30));

        if (img) {
            // Base64 truc tiep
            const imageBytes = img.imageBytes || img.encodedImage || img.bytesBase64Encoded;
            if (imageBytes) {
                console.log('[Komfy Direct] ✅ Base64 from media[0].image |', (imageBytes.length / 1024).toFixed(0), 'KB');
                return successResult({ base64: imageBytes, mimeType: img.mimeType || 'image/png', size: Math.round(imageBytes.length * 3 / 4), method: 'direct-api' });
            }

            // Signed URL
            const imgUrl = img.uri || img.url || img.gcsUri;
            if (imgUrl) {
                console.log('[Komfy Direct] ✅ URL from media[0].image');
                return successResult({ imageUrl: imgUrl, method: 'direct-api-url' });
            }

            // generatedImage sub-object
            if (img.generatedImage) {
                const gi = img.generatedImage;
                const giUrl = gi.fifeUrl || gi.uri || gi.url || gi.gcsUri || gi.imageUrl || gi.signedUrl;
                if (giUrl) {
                    console.log('[Komfy Direct] ✅ URL from generatedImage:', giUrl.substring(0, 80));
                    return successResult({ imageUrl: giUrl, method: 'direct-api-url' });
                }
                const giBytes = gi.imageBytes || gi.encodedImage || gi.bytesBase64Encoded;
                if (giBytes) {
                    console.log('[Komfy Direct] ✅ Base64 from generatedImage |', (giBytes.length / 1024).toFixed(0), 'KB');
                    return successResult({ base64: giBytes, mimeType: gi.mimeType || 'image/png', size: Math.round(giBytes.length * 3 / 4), method: 'direct-api' });
                }
            }
        }

        // Fallback: chi co mediaId
        if (first.name) {
            console.log('[Komfy Direct] Only mediaId, no image data. FULL:', JSON.stringify(first).substring(0, 500));
            return successResult({ generationId: first.name, mediaId: first.name, method: 'direct-api-media' });
        }
    }

    // Format 2: generatedImages array
    const genImg = (data?.generatedImages || data?.generated_images)?.[0];
    if (genImg) {
        const bytes = genImg.image?.imageBytes || genImg.imageBytes;
        if (bytes) {
            return successResult({ base64: bytes, mimeType: genImg.image?.mimeType || genImg.mimeType || 'image/png', size: Math.round(bytes.length * 3 / 4), method: 'direct-api' });
        }
    }

    // Format 3: Unknown → raw
    console.log('[Komfy Direct] Unknown image response format:', JSON.stringify(data).substring(0, 500));
    return { ok: true, body: JSON.stringify(data) };
}

/** Tim generationId tu video API response */
function parseVideoApiResponse(data) {
    // Common paths
    const generationId = data?.generationResults?.[0]?.generationId
        || data?.generationId || data?.operationId || data?.name
        || data?.operations?.[0]?.name || data?.operations?.[0]?.generationId
        || (Array.isArray(data) && data[0]?.generationId)
        || (Array.isArray(data) && data[0]?.name);

    if (generationId) {
        console.log('[Komfy Direct] Video generationId:', generationId);
        return successResult({ generationId, method: 'direct-api' });
    }

    // API error in response body
    const apiErr = data?.error?.message || data?.error?.status || data?.generationResults?.[0]?.error?.message;
    if (apiErr) {
        return { ok: false, status: 200, error: 'API error: ' + String(apiErr).substring(0, 200) };
    }

    // Deep extraction
    const ops0 = data?.operations?.[0];
    const media0 = data?.media?.[0];
    console.log('[Komfy Direct] Video response keys:', Object.keys(data),
        '| ops[0]:', ops0 ? JSON.stringify(ops0).substring(0, 300) : 'N/A',
        '| media[0]:', media0 ? Object.keys(media0) : 'N/A');

    const deepId = ops0?.metadata?.generationId || ops0?.response?.generationId
        || ops0?.operationId || ops0?.id
        || media0?.name || media0?.generationId || media0?.mediaGenerationId;

    if (deepId) {
        console.log('[Komfy Direct] Video generationId (deep):', deepId);
        return successResult({ generationId: deepId, method: 'direct-api' });
    }

    console.warn('[Komfy Direct] Could not extract generationId:', JSON.stringify(data).substring(0, 800));
    return { ok: true, body: JSON.stringify(data) };
}

/** Extract mediaId tu video generate response */
function extractVideoMediaId(data) {
    return data?.operations?.[0]?.operation?.name
        || data?.operations?.[0]?.name
        || data?.media?.[0]?.name
        || null;
}

/** Extract video URL tu poll response */
function extractVideoUrl(mediaStatus) {
    const v = mediaStatus?.video;
    const gv = v?.generatedVideo;
    const op = v?.operation;
    return gv?.uri || gv?.url || gv?.downloadUri || gv?.videoUri
        || op?.uri || op?.url
        || v?.uri || v?.url || v?.downloadUri
        || mediaStatus?.mediaMetadata?.mediaUri?.uri
        || mediaStatus?.mediaMetadata?.mediaUri?.url
        || null;
}

// ============================================================
// SECTION 6: IMAGE GENERATION — Direct API
// ============================================================

async function directGenerateImage(task) {
    const body = typeof task.body === 'string' ? JSON.parse(task.body) : task.body;
    const prompt = body.prompt || body.textInput?.structuredPrompt?.parts?.[0]?.text || 'A beautiful image';
    const aspectRatio = body.aspectRatio || '16:9';
    const modelName = body.modelName || 'Nano Banana 2';

    console.log('[Komfy Direct] Image | model:', modelName, '| aspect:', aspectRatio, '| prompt:', prompt.substring(0, 40));

    const imageModelName = mapImageModelKey(modelName);
    const imageAspectRatio = mapImageAspectRatio(aspectRatio);

    // Setup: tab + credentials + reCAPTCHA
    const { tab, projectId } = await ensureTabAndCredentials(body.projectName);
    await humanDelay(800, 2000);
    const recaptchaToken = await refreshRecaptcha(tab.id, 'image_generation');
    await humanDelay(300, 800);

    // Build request
    const clientCtx = buildClientContext(projectId, recaptchaToken || sessionData.xbv);
    const requestItem = {
        clientContext: clientCtx,
        imageModelName,
        imageAspectRatio,
        structuredPrompt: { parts: [{ text: prompt }] },
        seed: Math.floor(Math.random() * 1000000),
    };

    // Reference images (cached mediaIds)
    const referenceMediaIds = body.referenceMediaIds || [];
    if (referenceMediaIds.length > 0) {
        requestItem.imageInputs = referenceMediaIds.map(mediaId => ({
            imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE',
            name: mediaId,
        }));
        console.log('[Komfy Direct] Using', referenceMediaIds.length, 'cached mediaIds');
    }

    const apiBody = {
        clientContext: clientCtx,
        mediaGenerationContext: { batchId: generateUUID() },
        useNewMedia: true,
        requests: [requestItem],
    };

    const headers = buildApiHeaders(sessionData.bearerToken);
    const url = FLOW_API_BASE + '/projects/' + projectId + '/flowMedia:batchGenerateImages';

    console.log('[Komfy Direct] Calling', url.split('/v1/')[1], '|', imageModelName);
    await humanDelay(500, 1500);

    // Call API
    let response = await callApiFromPage(tab.id, url, JSON.stringify(apiBody), headers);
    console.log('[Komfy Direct] Image API status:', response.status, response.error || '');

    // Retry: stale mediaIds → remove refs
    if (!response.ok && (response.status === 404 || response.status === 400)
        && referenceMediaIds.length > 0 && (body.imageInputs || []).length > 0) {
        console.log('[Komfy Direct] Stale mediaIds → retrying WITHOUT refs...');
        delete requestItem.imageInputs;
        const freshToken = await refreshRecaptcha(tab.id, 'image_generation');
        if (freshToken) {
            apiBody.clientContext.recaptchaContext.token = freshToken;
            requestItem.clientContext.recaptchaContext.token = freshToken;
        }
        await humanDelay(500, 1500);
        response = await callApiFromPage(tab.id, url, JSON.stringify(apiBody), headers);
        if (!response.ok) {
            throw new Error('DIRECT_API_FAILED:' + response.status + ':retry-' + (response.body?.substring(0, 80) || 'failed'));
        }
        console.log('[Komfy Direct] ✅ Image retry success!');
    } else if (!response.ok) {
        throw new Error('DIRECT_API_FAILED:' + response.status + ':' + (response.error || response.body?.substring(0, 100) || 'unknown'));
    }

    // Parse + Download
    const parsed = parseImageApiResponse(JSON.parse(response.body));
    if (parsed?.ok) {
        const parsedBody = typeof parsed.body === 'string' ? JSON.parse(parsed.body) : parsed.body;
        const downloaded = await downloadImageData(tab.id, parsedBody);
        if (downloaded) return downloaded;
    }
    return parsed;
}

// ============================================================
// SECTION 7: VIDEO GENERATION — Direct API
// ============================================================

/** Build video API request body */
function buildVideoApiBody(body, projectId, recaptchaToken) {
    const prompt = body.requests?.[0]?.textInput?.structuredPrompt?.parts?.[0]?.text
        || (typeof body.prompt === 'string' ? body.prompt : 'A beautiful scene');
    const aspectRatio = body.requests?.[0]?.aspectRatio || body.uiAspectRatio || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
    const videoModelKey = body.requests?.[0]?.videoModelKey || null;

    // ★ DEBUG: Log input body structure for I2V diagnosis
    console.log('[Komfy Direct] [DEBUG] buildVideoApiBody INPUT:',
        '| body.requests[0].startImage:', JSON.stringify(body.requests?.[0]?.startImage || null),
        '| body.requests[0].endImage:', JSON.stringify(body.requests?.[0]?.endImage || null),
        '| body.startFrameDataUrl:', body.startFrameDataUrl ? 'YES(' + body.startFrameDataUrl.substring(0, 30) + ')' : 'null',
        '| body.endFrameDataUrl:', body.endFrameDataUrl ? 'YES(' + body.endFrameDataUrl.substring(0, 30) + ')' : 'null',
        '| videoModelKey:', videoModelKey
    );

    const apiBody = {
        mediaGenerationContext: { batchId: generateUUID() },
        clientContext: buildClientContext(projectId, recaptchaToken || sessionData.xbv),
        requests: [{
            aspectRatio,
            seed: body.requests?.[0]?.seed || Math.floor(Math.random() * 100000),
            textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
            videoModelKey,
            metadata: {},
        }],
        useV2ModelConfig: true,
    };

    // I2V: start/end image (mediaId references)
    if (body.requests?.[0]?.startImage) apiBody.requests[0].startImage = {
        mediaId: body.requests[0].startImage.mediaId || body.requests[0].startImage,
        cropCoordinates: body.requests[0].startImage.cropCoordinates || { top: 0, left: 0, bottom: 1, right: 1 }
    };
    if (body.requests?.[0]?.endImage) apiBody.requests[0].endImage = {
        mediaId: body.requests[0].endImage.mediaId || body.requests[0].endImage,
        cropCoordinates: body.requests[0].endImage.cropCoordinates || { top: 0, left: 0, bottom: 1, right: 1 }
    };

    // ★ DEBUG: Confirm final apiBody has frames
    console.log('[Komfy Direct] [DEBUG] buildVideoApiBody OUTPUT:',
        '| apiBody.requests[0].startImage:', JSON.stringify(apiBody.requests[0].startImage || null),
        '| apiBody.requests[0].endImage:', JSON.stringify(apiBody.requests[0].endImage || null),
        '| apiBody.requests[0].videoModelKey:', apiBody.requests[0].videoModelKey
    );

    return apiBody;
}

/** Apply ingredient images (referenceMediaIds hoac raw dataUrls) vao apiBody */
function applyIngredientImages(apiBody, body) {
    const referenceMediaIds = body.referenceMediaIds || [];
    const ingredientImages = body.imageInputs || [];
    let actualEndpoint = null; // null = khong doi endpoint

    if (referenceMediaIds.length > 0) {
        actualEndpoint = '/video:batchAsyncGenerateVideoReferenceImages';
        apiBody.requests[0].referenceImages = referenceMediaIds.map(mediaId => ({
            mediaId,
            imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
        }));
        apiBody.requests[0].videoModelKey = toR2VModelKey(apiBody.requests[0].videoModelKey);
        console.log('[Komfy Direct] Using', referenceMediaIds.length, 'cached mediaIds → R2V | key:', apiBody.requests[0].videoModelKey);
    } else if (ingredientImages.length > 0) {
        actualEndpoint = '/video:batchAsyncGenerateVideoReferenceImages';
        apiBody.requests[0].referenceImages = parseIngredientImages(ingredientImages);
        apiBody.requests[0].videoModelKey = toR2VModelKey(apiBody.requests[0].videoModelKey);
        console.log('[Komfy Direct] Using', apiBody.requests[0].referenceImages.length, 'raw ingredient images → R2V');
    }

    return actualEndpoint;
}

/** Retry video API khi 404 (stale mediaIds) */
async function retryVideoAfterStaleIds(tab, apiBody, body, endpoint, headers) {
    const ingredientImages = body.imageInputs || [];

    // Fresh reCAPTCHA
    const freshToken = await refreshRecaptcha(tab.id, 'video_generation');
    if (freshToken) apiBody.clientContext.recaptchaContext.token = freshToken;

    let retryUrl;
    if (ingredientImages.length > 0) {
        apiBody.requests[0].referenceImages = parseIngredientImages(ingredientImages);
        retryUrl = FLOW_API_BASE + '/video:batchAsyncGenerateVideoReferenceImages';
        console.log('[Komfy Direct] Retrying R2V with', apiBody.requests[0].referenceImages.length, 'raw images');
    } else {
        delete apiBody.requests[0].referenceImages;
        apiBody.requests[0].videoModelKey = toT2VModelKey(apiBody.requests[0].videoModelKey);
        retryUrl = FLOW_API_BASE + endpoint;
        console.log('[Komfy Direct] Retrying as T2V (no refs)');
    }

    await humanDelay(1000, 2500);
    const retryRes = await callApiFromPage(tab.id, retryUrl, JSON.stringify(apiBody), headers);
    if (!retryRes.ok) {
        throw new Error('DIRECT_API_FAILED:' + retryRes.status + ':' + (retryRes.error || retryRes.body?.substring(0, 100) || 'retry-failed'));
    }

    const retryData = JSON.parse(retryRes.body);
    if (!extractVideoMediaId(retryData)) {
        throw new Error('DIRECT_API_FAILED:retry-no-mediaId');
    }
    console.log('[Komfy Direct] ✅ Retry success!');
    return retryRes;
}

/** Poll video generation status cho den khi hoan thanh */
async function pollVideoStatus(tabId, mediaId, projectId, headers) {
    const pollUrl = FLOW_API_BASE + '/video:batchCheckAsyncVideoGenerationStatus';
    const pollBody = JSON.stringify({ media: [{ name: mediaId, projectId }] });
    const pollStart = Date.now();

    while (Date.now() - pollStart < VIDEO_POLL_MAX_MS) {
        await humanDelayNatural(VIDEO_POLL_INTERVAL_MS, VIDEO_POLL_JITTER_MS);

        const pollRes = await callApiFromPage(tabId, pollUrl, pollBody, headers);
        if (!pollRes.ok) {
            console.warn('[Komfy Direct] Poll error:', pollRes.status, pollRes.error);
            continue;
        }

        const pollData = JSON.parse(pollRes.body);
        const media = pollData?.media?.[0];
        const status = media?.mediaMetadata?.mediaStatus?.mediaGenerationStatus
            || media?.status || pollData?.operations?.[0]?.status || 'UNKNOWN';
        const elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);

        // Verbose logging first poll
        if (elapsed <= 15) {
            console.log('[Komfy Direct] Poll detail:', media ? JSON.stringify(media).substring(0, 400) : 'N/A');
        }
        console.log('[Komfy Direct] Poll:', status, '|', elapsed + 's');

        // Success
        if (status.includes('COMPLETE') || status.includes('SUCCESS')) {
            const videoUrl = extractVideoUrl(media);
            console.log('[Komfy Direct] Video DONE! url:', videoUrl ? videoUrl.substring(0, 100) : 'none');

            if (videoUrl) {
                return successResult({ generationId: 'DIRECT:' + videoUrl, method: 'direct-api' });
            }
            // No URL → download.js se dung getMedia strategy
            console.log('[Komfy Direct] No video URL → returning mediaId for download strategy');
            return successResult({ generationId: mediaId, method: 'direct-api' });
        }

        // Failed
        if (status.includes('FAIL') || status.includes('ERROR') || status.includes('CANCEL')) {
            const errMsg = media?.mediaMetadata?.mediaStatus?.error?.message
                || media?.mediaMetadata?.mediaStatus?.failureReasons?.[0]
                || media?.error?.message || status;
            throw new Error('DIRECT_API_VIDEO_FAILED:' + errMsg);
        }
    }

    throw new Error('DIRECT_API_VIDEO_TIMEOUT:15min');
}

/** Main entry: Video generation via Direct API */
async function directGenerateVideo(task) {
    const body = typeof task.body === 'string' ? JSON.parse(task.body) : task.body;
    const endpoint = task.endpoint;
    const prompt = body.requests?.[0]?.textInput?.structuredPrompt?.parts?.[0]?.text
        || (typeof body.prompt === 'string' ? body.prompt : 'A beautiful scene');
    const videoModelKey = body.requests?.[0]?.videoModelKey || null;

    console.log('[Komfy Direct] Video | endpoint:', endpoint, '| model:', videoModelKey, '| prompt:', prompt.substring(0, 40));
    console.log('[Komfy Direct] Video task.body keys:', Object.keys(body), '| hasStartImage:', !!(body.requests?.[0]?.startImage), '| hasEndImage:', !!(body.requests?.[0]?.endImage));

    // Setup
    const { tab, projectId } = await ensureTabAndCredentials(body.projectName);
    console.log('[Komfy Direct] Tab:', tab.id, '| project:', projectId?.substring(0, 16));
    await humanDelay(1000, 2500);
    const recaptchaToken = await refreshRecaptcha(tab.id, 'video_generation');
    console.log('[Komfy Direct] reCAPTCHA:', recaptchaToken ? 'OK(' + recaptchaToken.substring(0, 10) + '...)' : 'NONE');
    await humanDelay(300, 800);

    // Build request body
    const apiBody = buildVideoApiBody(body, projectId, recaptchaToken);
    console.log('[Komfy Direct] apiBody keys:', Object.keys(apiBody), '| req[0] keys:', Object.keys(apiBody.requests?.[0] || {}));
    console.log('[Komfy Direct] apiBody.requests[0].startImage:', JSON.stringify(apiBody.requests?.[0]?.startImage || null));
    console.log('[Komfy Direct] apiBody.requests[0].endImage:', JSON.stringify(apiBody.requests?.[0]?.endImage || null));
    console.log('[Komfy Direct] apiBody.requests[0].videoModelKey:', apiBody.requests?.[0]?.videoModelKey);

    // Apply ingredient images (may change endpoint)
    const ingredientEndpoint = applyIngredientImages(apiBody, body);
    const actualEndpoint = ingredientEndpoint || endpoint;
    const url = FLOW_API_BASE + actualEndpoint;

    console.log('[Komfy Direct] FULL URL:', url);
    console.log('[Komfy Direct] FULL BODY (truncated):', JSON.stringify(apiBody).substring(0, 600));
    await humanDelay(800, 2000);
    await logTabState(tab.id);

    // Call API
    const headers = buildApiHeaders(sessionData.bearerToken);
    console.log('[Komfy Direct] Bearer token:', sessionData.bearerToken ? sessionData.bearerToken.substring(0, 25) + '...' : 'MISSING!');

    // ★ DEBUG: Log ALL headers + session state for 404 diagnosis
    console.log('[Komfy Direct] [DEBUG] API Headers:', JSON.stringify(headers));
    console.log('[Komfy Direct] [DEBUG] Session state:',
        '| xClientData:', sessionData.xClientData ? 'YES(' + sessionData.xClientData.substring(0, 20) + ')' : 'MISSING',
        '| googExts:', sessionData.googExts ? JSON.stringify(Object.keys(sessionData.googExts)) : 'NONE',
        '| xbv:', sessionData.xbv ? 'YES(' + sessionData.xbv.substring(0, 15) + ')' : 'MISSING'
    );

    let response = await callApiFromPage(tab.id, url, JSON.stringify(apiBody), headers);

    console.log('[Komfy Direct] Video API status:', response.status, '| ok:', response.ok, '| fetchUsed:', response.fetchUsed || 'N/A',
        '| error:', response.error || 'none', '| bodyPreview:', (response.body || '').substring(0, 300));

    // Handle errors
    if (!response.ok) {
        console.warn('[Komfy Direct] Video API failed:', response.status, '| body:', response.body?.substring(0, 500));

        // 404 + stale mediaIds → retry
        if (response.status === 404 && (body.referenceMediaIds || []).length > 0) {
            response = await retryVideoAfterStaleIds(tab, apiBody, body, endpoint, headers);
        } else {
            throw new Error('DIRECT_API_FAILED:' + response.status + ':' + (response.error || response.body?.substring(0, 100) || 'unknown'));
        }
    }

    // Parse response → extract mediaId → poll
    const data = JSON.parse(response.body);
    const mediaId = extractVideoMediaId(data);

    if (!mediaId) {
        console.warn('[Komfy Direct] No mediaId in response:', JSON.stringify(data).substring(0, 500));
        return parseVideoApiResponse(data);
    }

    const altMediaId = data?.media?.[0]?.name;
    console.log('[Komfy Direct] Video submitted! pollId:', mediaId,
        '| altId:', altMediaId !== mediaId ? altMediaId : 'same');

    return await pollVideoStatus(tab.id, mediaId, projectId, headers);
}
