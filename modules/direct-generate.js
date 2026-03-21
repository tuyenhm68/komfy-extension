// ============================================================
// direct-generate.js — Direct API generation (bypass UI automation)
//
// Goi API truc tiep tu page context thong qua Runtime.evaluate + fetch()
// Khong can click UI, khong phu thuoc ngon ngu, khong phu thuoc layout.
//
// Dieu kien: Tab Flow phai dang mo (de lay cookies, reCAPTCHA token)
// Fallback: Neu Direct API fail (403, etc.) → tra ve loi de polling.js
//           chuyen sang UI automation (image-gen.js / video-gen.js)
// ============================================================

const FLOW_API_BASE = 'https://aisandbox-pa.googleapis.com/v1';
const RECAPTCHA_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

// --- Helper: Generate fresh reCAPTCHA token from page context ---
async function getFreshRecaptchaToken(tabId, action) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: async (siteKey, actionName) => {
                if (window.grecaptcha && window.grecaptcha.enterprise) {
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

// --- Helper: Build headers for API call ---
// Flow UI that dung text/plain de tranh CORS preflight
// reCAPTCHA token di vao body (clientContext.recaptchaContext.token), KHONG dung header
function buildApiHeaders(bearerToken) {
    return {
        'authorization': bearerToken || '',
        'content-type': 'text/plain;charset=UTF-8',
    };
}

// --- Helper: Call API from page context (bypass CORS) ---
// Goi fetch() TU TRONG PAGE de co cookies, origin, session
async function callApiFromPage(tabId, url, bodyStr, headers) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (apiUrl, apiBody, apiHeaders) => {
            try {
                const res = await fetch(apiUrl, {
                    method: 'POST',
                    headers: apiHeaders,
                    body: apiBody,
                });
                const text = await res.text();
                return { ok: res.ok, status: res.status, body: text };
            } catch (e) {
                return { ok: false, status: 0, error: e.message };
            }
        },
        args: [url, bodyStr, headers],
    });
    return results?.[0]?.result || { ok: false, status: 0, error: 'No script result' };
}

// --- Helper: Download image blob from page context ---
async function downloadImageFromPage(tabId, mediaId, projectId, bearerToken) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (mid, projId, bearer) => {
            try {
                // Strategy 1: Google aisandbox API — getMedia
                const apiUrl = 'https://aisandbox-pa.googleapis.com/v1/projects/' + projId + '/media/' + mid;
                const r = await fetch(apiUrl, {
                    headers: { 'authorization': bearer },
                });
                if (r.ok) {
                    const data = await r.json();
                    // Response co the co image.imageBytes hoac signedUrl
                    const imgBytes = data?.image?.imageBytes || data?.imageBytes;
                    if (imgBytes) {
                        return { base64: imgBytes, mimeType: data?.image?.mimeType || 'image/png', size: Math.round(imgBytes.length * 3 / 4) };
                    }
                    const signedUrl = data?.image?.uri || data?.signedUrl || data?.uri || data?.url;
                    if (signedUrl) {
                        const imgR = await fetch(signedUrl);
                        if (imgR.ok) {
                            const blob = await imgR.arrayBuffer();
                            const u8 = new Uint8Array(blob);
                            let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                            return { base64: btoa(s), mimeType: imgR.headers.get('content-type') || 'image/png', size: blob.byteLength };
                        }
                    }
                    return { error: 'getMedia ok but no image data', keys: Object.keys(data), sample: JSON.stringify(data).substring(0, 500) };
                }

                // Strategy 2: tRPC redirect (simple URL format, follow redirect to GCS)
                const trpcUrl = '/fx/api/trpc/media.getMediaUrlRedirect?name=' + encodeURIComponent(mid);
                const r2 = await fetch(trpcUrl, { credentials: 'include', redirect: 'follow' });
                // If redirected to GCS
                if (r2.ok) {
                    const ct = r2.headers.get('content-type') || '';
                    if (ct.includes('image')) {
                        const blob = await r2.arrayBuffer();
                        const u8 = new Uint8Array(blob);
                        let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                        return { base64: btoa(s), mimeType: ct, size: blob.byteLength };
                    }
                    // JSON response with URL
                    const txt = await r2.text();
                    const m = txt.match(/"(https:\/\/[^"]*storage\.googleapis\.com[^"]*)"/);
                    if (m) {
                        const imgR = await fetch(m[1]);
                        if (imgR.ok) {
                            const blob = await imgR.arrayBuffer();
                            const u8 = new Uint8Array(blob);
                            let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                            return { base64: btoa(s), mimeType: imgR.headers.get('content-type') || 'image/png', size: blob.byteLength };
                        }
                    }
                }
                return { error: 'All strategies failed. API: ' + r.status + ', tRPC: ' + r2.status };
            } catch (e) {
                return { error: e.message };
            }
        },
        args: [mediaId, projectId, bearerToken],
    });
    return results?.[0]?.result || { error: 'No script result' };
}

// --- Helper: Download image from GCS signed URL (fifeUrl) via page context ---
async function downloadSignedUrl(tabId, signedUrl) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (url) => {
            try {
                const r = await fetch(url);
                if (!r.ok) return { error: 'HTTP ' + r.status };
                const blob = await r.arrayBuffer();
                const u8 = new Uint8Array(blob);
                let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                return { base64: btoa(s), mimeType: r.headers.get('content-type') || 'image/jpeg', size: blob.byteLength };
            } catch (e) {
                return { error: e.message };
            }
        },
        args: [signedUrl],
    });
    return results?.[0]?.result || { error: 'No script result' };
}

// --- Helper: Download image via tRPC getMediaUrlRedirect (follows 307 → GCS) ---
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
                if (ct.includes('image')) {
                    const blob = await r.arrayBuffer();
                    const u8 = new Uint8Array(blob);
                    let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                    return { base64: btoa(s), mimeType: ct, size: blob.byteLength };
                }
                // JSON response — extract GCS URL and fetch it
                const txt = await r.text();
                const m = txt.match(/"(https:\/\/[^"]*storage\.googleapis\.com[^"]*)"/);
                if (m) {
                    const imgR = await fetch(m[1]);
                    if (imgR.ok) {
                        const blob = await imgR.arrayBuffer();
                        const u8 = new Uint8Array(blob);
                        let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                        return { base64: btoa(s), mimeType: imgR.headers.get('content-type') || 'image/jpeg', size: blob.byteLength };
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

// ============================================================
// IMAGE GENERATION — Direct API
// ============================================================
async function directGenerateImage(task) {
    const body = typeof task.body === 'string' ? JSON.parse(task.body) : task.body;
    const prompt = body.prompt || body.textInput?.structuredPrompt?.parts?.[0]?.text || 'A beautiful image';
    const aspectRatio = body.aspectRatio || '16:9';
    const modelName = body.modelName || 'Nano Banana 2';
    const projectName = body.projectName || null;

    console.log('[Komfy Direct] Image | model:', modelName, '| aspect:', aspectRatio, '| prompt:', prompt.substring(0, 40));

    // Map to API format
    const imageModelName = mapImageModelKey(modelName);
    const imageAspectRatio = mapImageAspectRatio(aspectRatio);

    // Ensure Flow tab + token
    const tab = await ensureFlowTab(false, projectName);
    if (!sessionData.bearerToken) throw new Error('DIRECT_API_NO_TOKEN');
    const projectId = sessionData.projectId;
    if (!projectId) throw new Error('DIRECT_API_NO_PROJECT');

    // Human-like pause before requesting reCAPTCHA (simulate user reviewing prompt)
    await humanDelay(800, 2000);

    // Fresh reCAPTCHA
    const recaptchaToken = await getFreshRecaptchaToken(tab.id, 'image_generation');
    if (recaptchaToken) sessionData.xbv = recaptchaToken;

    // Small pause after reCAPTCHA before building request (natural gap)
    await humanDelay(300, 800);

    // clientContext — giong Flow UI that (xuat hien ca top-level va trong request)
    const sessionId = ';' + Date.now();
    const clientCtx = {
        recaptchaContext: {
            token: recaptchaToken || sessionData.xbv || '',
            applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
        },
        projectId: projectId,
        tool: 'PINHOLE',
        userPaygateTier: 'PAYGATE_TIER_TWO',
        sessionId: sessionId,
    };

    // Build request item
    const requestItem = {
        clientContext: clientCtx,
        imageModelName: imageModelName,
        imageAspectRatio: imageAspectRatio,
        structuredPrompt: {
            parts: [{ text: prompt }],
        },
        seed: Math.floor(Math.random() * 1000000),
    };

    // Reference images — dung imageInputs voi IMAGE_INPUT_TYPE_REFERENCE (giong Flow UI)
    const referenceMediaIds = body.referenceMediaIds || [];
    if (referenceMediaIds.length > 0) {
        requestItem.imageInputs = referenceMediaIds.map(mediaId => ({
            imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE',
            name: mediaId,
        }));
        console.log('[Komfy Direct] Using', referenceMediaIds.length, 'cached mediaIds as imageInputs');
    }

    // Build full API body — DUNG FORMAT Flow UI that
    const batchId = crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2));
    const apiBody = {
        clientContext: clientCtx,
        mediaGenerationContext: { batchId: batchId },
        useNewMedia: true,
        requests: [requestItem],
    };

    const headers = buildApiHeaders(sessionData.bearerToken);
    const url = FLOW_API_BASE + '/projects/' + projectId + '/flowMedia:batchGenerateImages';
    const bodyStr = JSON.stringify(apiBody);

    console.log('[Komfy Direct] Calling', url.split('/v1/')[1], '|', imageModelName, '|', referenceMediaIds.length ? `${referenceMediaIds.length} mediaIds` : 'no refs');

    // Human-like pause before submitting (simulate clicking Generate button)
    await humanDelay(500, 1500);

    const response = await callApiFromPage(tab.id, url, bodyStr, headers);

    console.log('[Komfy Direct] Image API status:', response.status, response.error || '');

    if (!response.ok) {
        console.warn('[Komfy Direct] Image API failed:', response.status, '| error:', response.error, '| body:', response.body?.substring(0, 500));
        throw new Error('DIRECT_API_FAILED:' + response.status + ':' + (response.error || response.body?.substring(0, 100) || 'unknown'));
    }

    const data = JSON.parse(response.body);
    const parsed = parseImageApiResponse(data, task.requestId);

    // ★ Download image data from response
    if (parsed?.ok) {
        const parsedBody = typeof parsed.body === 'string' ? JSON.parse(parsed.body) : parsed.body;

        // Case 1: Got fifeUrl / signed URL → download directly (no auth needed)
        if (parsedBody?.method === 'direct-api-url' && parsedBody?.imageUrl) {
            console.log('[Komfy Direct] Downloading image from signed URL...', parsedBody.imageUrl.substring(0, 80));
            try {
                const dlResult = await downloadSignedUrl(tab.id, parsedBody.imageUrl);
                if (dlResult?.base64) {
                    console.log('[Komfy Direct] ✅ Image downloaded from signed URL!', ((dlResult.size || 0) / 1024).toFixed(0), 'KB');
                    return {
                        ok: true,
                        body: JSON.stringify({
                            base64: dlResult.base64,
                            mimeType: dlResult.mimeType || 'image/jpeg',
                            size: dlResult.size || 0,
                            method: 'direct-api',
                        }),
                    };
                }
                console.warn('[Komfy Direct] Signed URL download failed:', dlResult?.error);
            } catch (dlErr) {
                console.warn('[Komfy Direct] Signed URL download threw:', dlErr.message?.substring(0, 80));
            }
            // Fallback: try service worker fetch
            try {
                const swRes = await fetch(parsedBody.imageUrl);
                if (swRes.ok) {
                    const buf = await swRes.arrayBuffer();
                    const u8 = new Uint8Array(buf);
                    let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                    const b64 = btoa(s);
                    console.log('[Komfy Direct] ✅ Image downloaded via SW fetch!', (buf.byteLength / 1024).toFixed(0), 'KB');
                    return {
                        ok: true,
                        body: JSON.stringify({
                            base64: b64,
                            mimeType: swRes.headers.get('content-type') || 'image/jpeg',
                            size: buf.byteLength,
                            method: 'direct-api',
                        }),
                    };
                }
            } catch (swErr) {
                console.warn('[Komfy Direct] SW fetch fallback failed:', swErr.message?.substring(0, 80));
            }
            throw new Error('DIRECT_API_DOWNLOAD_FAILED:signed-url');
        }

        // Case 2: Only got mediaId (no image data, no URL) → try downloadBlobViaCDP
        if (parsedBody?.method === 'direct-api-media' && parsedBody?.mediaId) {
            console.log('[Komfy Direct] Only got mediaId, trying getMediaUrlRedirect...');
            // Try tRPC redirect first (works for images per investigation)
            try {
                const dlResult = await downloadViaTrpcRedirect(tab.id, parsedBody.mediaId);
                if (dlResult?.base64) {
                    console.log('[Komfy Direct] ✅ Image downloaded via tRPC redirect!', ((dlResult.size || 0) / 1024).toFixed(0), 'KB');
                    return {
                        ok: true,
                        body: JSON.stringify({
                            base64: dlResult.base64,
                            mimeType: dlResult.mimeType || 'image/jpeg',
                            size: dlResult.size || 0,
                            method: 'direct-api',
                        }),
                    };
                }
            } catch (trpcErr) {
                console.warn('[Komfy Direct] tRPC redirect failed:', trpcErr.message?.substring(0, 80));
            }
            throw new Error('DIRECT_API_DOWNLOAD_FAILED:' + parsedBody.mediaId);
        }
    }

    return parsed;
}

// ============================================================
// VIDEO GENERATION — Direct API
// ============================================================
async function directGenerateVideo(task) {
    const body = typeof task.body === 'string' ? JSON.parse(task.body) : task.body;
    const endpoint = task.endpoint; // e.g. '/video:batchAsyncGenerateVideoText'
    const prompt = body.requests?.[0]?.textInput?.structuredPrompt?.parts?.[0]?.text
        || (typeof body.prompt === 'string' ? body.prompt : 'A beautiful scene');
    const aspectRatio = body.requests?.[0]?.aspectRatio
        || body.uiAspectRatio || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
    const videoModelKey = body.requests?.[0]?.videoModelKey || null;
    const projectName = body.projectName || null;

    console.log('[Komfy Direct] Video | endpoint:', endpoint, '| model:', videoModelKey, '| prompt:', prompt.substring(0, 40));

    // Ensure Flow tab + token TRUOC khi build body
    const tab = await ensureFlowTab(false, projectName);
    if (!sessionData.bearerToken) {
        throw new Error('DIRECT_API_NO_TOKEN');
    }
    const projectId = sessionData.projectId;
    if (!projectId) {
        throw new Error('DIRECT_API_NO_PROJECT');
    }

    // Human-like pause before requesting reCAPTCHA (simulate user reviewing settings)
    await humanDelay(1000, 2500);

    // Fresh reCAPTCHA — di vao body clientContext (giong Flow UI that)
    const recaptchaToken = await getFreshRecaptchaToken(tab.id, 'video_generation');
    if (recaptchaToken) sessionData.xbv = recaptchaToken;

    // Small pause after reCAPTCHA
    await humanDelay(300, 800);

    // Build API request body — match Flow UI format exactly
    const apiBody = {
        mediaGenerationContext: {
            batchId: crypto.randomUUID(),
        },
        clientContext: {
            projectId: projectId,
            tool: 'PINHOLE',
            userPaygateTier: 'PAYGATE_TIER_TWO',
            sessionId: ';' + Date.now(),
            recaptchaContext: {
                token: recaptchaToken || sessionData.xbv || '',
                applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
            },
        },
        requests: [{
            aspectRatio: aspectRatio,
            seed: body.requests?.[0]?.seed || Math.floor(Math.random() * 100000),
            textInput: {
                structuredPrompt: { parts: [{ text: prompt }] },
            },
            videoModelKey: videoModelKey,
            metadata: {},
        }],
        useV2ModelConfig: true,
    };

    // I2V: start/end image
    if (body.requests?.[0]?.startImage) {
        apiBody.requests[0].startImage = body.requests[0].startImage;
    }
    if (body.requests?.[0]?.endImage) {
        apiBody.requests[0].endImage = body.requests[0].endImage;
    }

    // T2V Ingredient images — uu tien referenceMediaIds (da upload + cache)
    const referenceMediaIds = body.referenceMediaIds || [];
    const ingredientImages = body.imageInputs || [];
    let actualEndpoint = endpoint;

    if (referenceMediaIds.length > 0) {
        // ★ Ingredients mode: dung endpoint batchAsyncGenerateVideoReferenceImages
        // Format that (tu Flow UI): referenceImages[].{mediaId, imageUsageType}
        // Model key: r2v (reference-to-video) thay vi t2v (text-to-video)
        actualEndpoint = '/video:batchAsyncGenerateVideoReferenceImages';
        apiBody.requests[0].referenceImages = referenceMediaIds.map(mediaId => ({
            mediaId,
            imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
        }));
        // ★ Doi model key: t2v → r2v, giu nguyen suffix (fast/quality + orientation + ultra)
        if (apiBody.requests[0].videoModelKey) {
            let mk = apiBody.requests[0].videoModelKey.replace('t2v', 'r2v');
            // Them _ultra neu chua co (Flow UI luon dung ultra cho r2v)
            if (!mk.includes('_ultra')) mk += '_ultra';
            apiBody.requests[0].videoModelKey = mk;
        }
        console.log('[Komfy Direct] Using', referenceMediaIds.length, 'cached mediaIds → endpoint:', actualEndpoint, '| modelKey:', apiBody.requests[0].videoModelKey);
    } else if (ingredientImages.length > 0) {
        actualEndpoint = '/video:batchAsyncGenerateVideoReferenceImages';
        apiBody.requests[0].referenceImages = [];
        for (const imgDataUrl of ingredientImages) {
            if (!imgDataUrl || !imgDataUrl.startsWith('data:')) continue;
            const b64 = imgDataUrl.split(',')[1];
            const mimeMatch = imgDataUrl.match(/^data:([^;]+);/);
            const mime = mimeMatch ? mimeMatch[1] : 'image/png';
            apiBody.requests[0].referenceImages.push({
                imageBytes: b64,
                mimeType: mime,
                imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
            });
        }
        // Doi model key: t2v → r2v + ultra
        if (apiBody.requests[0].videoModelKey) {
            let mk = apiBody.requests[0].videoModelKey.replace('t2v', 'r2v');
            if (!mk.includes('_ultra')) mk += '_ultra';
            apiBody.requests[0].videoModelKey = mk;
        }
        console.log('[Komfy Direct] Using', apiBody.requests[0].referenceImages.length, 'raw ingredient images → endpoint:', actualEndpoint);
    }

    const headers = buildApiHeaders(sessionData.bearerToken);
    // Video URL that: /v1{endpoint} (vi du: /v1/video:batchAsyncGenerateVideoText)
    // KHONG co projects/{id}/flowMedia/ prefix — khac voi image API
    const url = FLOW_API_BASE + actualEndpoint;
    const bodyStr = JSON.stringify(apiBody);

    console.log('[Komfy Direct] Calling', url.split('/v1/')[1], '...');

    // Human-like pause before submitting video generation
    await humanDelay(800, 2000);

    const response = await callApiFromPage(tab.id, url, bodyStr, headers);

    console.log('[Komfy Direct] Video API status:', response.status, response.error || '');

    if (!response.ok) {
        console.warn('[Komfy Direct] Video API failed:', response.status, '| error:', response.error, '| body:', response.body?.substring(0, 500));

        // ★ 404 with referenceMediaIds = stale mediaIds from different project
        // Retry WITHOUT mediaIds → use T2V endpoint (text-only, no ingredients)
        if (response.status === 404 && referenceMediaIds.length > 0) {
            console.log('[Komfy Direct] 404 likely caused by stale mediaIds from different project. Retrying without mediaIds...');
            // Strip referenceImages and revert endpoint/model
            delete apiBody.requests[0].referenceImages;
            const origEndpoint = endpoint; // original T2V endpoint
            const origUrl = FLOW_API_BASE + origEndpoint;
            // Revert model key: r2v → t2v, remove _ultra
            if (apiBody.requests[0].videoModelKey) {
                let mk = apiBody.requests[0].videoModelKey.replace('r2v', 't2v').replace('_ultra', '');
                apiBody.requests[0].videoModelKey = mk;
            }
            // Fresh reCAPTCHA token for retry (old one consumed by 404 request)
            try {
                const freshToken = await getFreshRecaptchaToken(tab.id, 'video_generation');
                if (freshToken) {
                    apiBody.clientContext.recaptchaContext.token = freshToken;
                    sessionData.xbv = freshToken;
                }
            } catch (rcErr) {
                console.warn('[Komfy Direct] Could not refresh reCAPTCHA for retry:', rcErr.message?.substring(0, 60));
            }
            const retryBodyStr = JSON.stringify(apiBody);
            console.log('[Komfy Direct] Retrying as T2V (no refs):', origEndpoint, '| model:', apiBody.requests[0].videoModelKey);
            await humanDelay(1000, 2500);
            const retryRes = await callApiFromPage(tab.id, origUrl, retryBodyStr, headers);
            if (retryRes.ok) {
                console.log('[Komfy Direct] ✅ Retry T2V success!');
                // Continue with retry response
                const retryData = JSON.parse(retryRes.body);
                const retryMediaId = retryData?.operations?.[0]?.operation?.name
                    || retryData?.operations?.[0]?.name
                    || retryData?.media?.[0]?.name;
                if (retryMediaId) {
                    // Fall through to polling below with retryMediaId
                    // We need to reassign and skip the original parse
                    response.ok = true;
                    response.body = retryRes.body;
                } else {
                    throw new Error('DIRECT_API_FAILED:' + response.status + ':retry-no-mediaId');
                }
            } else {
                throw new Error('DIRECT_API_FAILED:' + retryRes.status + ':' + (retryRes.error || retryRes.body?.substring(0, 100) || 'retry-failed'));
            }
        } else {
            throw new Error('DIRECT_API_FAILED:' + response.status + ':' + (response.error || response.body?.substring(0, 100) || 'unknown'));
        }
    }

    // Parse response — extract mediaId for polling
    // ★ Uu tien operations[0].operation.name (generation ID)
    // media[0].name co the la placeholder → "Media not found" khi poll
    const data = JSON.parse(response.body);
    const mediaId = data?.operations?.[0]?.operation?.name
        || data?.operations?.[0]?.name
        || data?.media?.[0]?.name;

    if (!mediaId) {
        console.warn('[Komfy Direct] Video: no mediaId in response:', JSON.stringify(data).substring(0, 500));
        return parseVideoApiResponse(data, task.requestId);
    }

    const altMediaId = data?.media?.[0]?.name;
    console.log('[Komfy Direct] Video submitted! pollId:', mediaId,
        '| altId:', altMediaId !== mediaId ? altMediaId : 'same',
        '| Polling for completion...');

    // ★ POLL video generation status — video can 2-5 phut de tao xong
    const pollUrl = FLOW_API_BASE + '/video:batchCheckAsyncVideoGenerationStatus';
    const pollBody = JSON.stringify({
        media: [{ name: mediaId, projectId }],
    });
    const maxPollMs = 15 * 60 * 1000; // 15 phut
    const pollStart = Date.now();

    while (Date.now() - pollStart < maxPollMs) {
        // Randomized poll interval: 8-14s (avoid fixed pattern that bots use)
        await humanDelayNatural(11000, 3000);

        const pollRes = await callApiFromPage(tab.id, pollUrl, pollBody, headers);
        if (!pollRes.ok) {
            console.warn('[Komfy Direct] Video poll error:', pollRes.status, pollRes.error);
            continue;
        }

        const pollData = JSON.parse(pollRes.body);
        const mediaStatus = pollData?.media?.[0];
        const opsStatus = pollData?.operations?.[0];
        // Real path: media[0].mediaMetadata.mediaStatus.mediaGenerationStatus
        const status = mediaStatus?.mediaMetadata?.mediaStatus?.mediaGenerationStatus
            || mediaStatus?.status
            || opsStatus?.status
            || 'UNKNOWN';
        const elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);

        // Log chi tiet lan dau de debug structure
        if (elapsed <= 15) {
            console.log('[Komfy Direct] Video poll response keys:', Object.keys(pollData),
                '| media[0] keys:', mediaStatus ? Object.keys(mediaStatus) : 'N/A',
                '| media[0] sample:', mediaStatus ? JSON.stringify(mediaStatus).substring(0, 400) : 'N/A');
        }
        console.log('[Komfy Direct] Video poll:', status, '|', elapsed + 's');

        if (status.includes('COMPLETE') || status.includes('SUCCESS')) {
            // Extract video URL from poll response
            // Structure: media[0].video.generatedVideo / media[0].video.operation
            const videoData = mediaStatus?.video;
            const genVideo = videoData?.generatedVideo;
            const operation = videoData?.operation;

            // Try multiple paths for video URL
            const videoUrl = genVideo?.uri || genVideo?.url || genVideo?.downloadUri || genVideo?.videoUri
                || operation?.uri || operation?.url
                || videoData?.uri || videoData?.url || videoData?.downloadUri
                || mediaStatus?.mediaMetadata?.mediaUri?.uri
                || mediaStatus?.mediaMetadata?.mediaUri?.url;

            // Deep log the full structure (truncated) for debugging
            console.log('[Komfy Direct] Video DONE! mediaId:', mediaId,
                '| videoUrl:', videoUrl ? videoUrl.substring(0, 100) : 'none',
                '| video keys:', videoData ? Object.keys(videoData) : 'N/A',
                '| generatedVideo keys:', genVideo ? Object.keys(genVideo) : 'N/A',
                '| operation keys:', operation ? Object.keys(operation) : 'N/A',
                '| generatedVideo:', genVideo ? JSON.stringify(genVideo).substring(0, 500) : 'N/A',
                '| operation:', operation ? JSON.stringify(operation).substring(0, 500) : 'N/A');

            // If we have a direct video URL, return it immediately
            if (videoUrl) {
                return {
                    ok: true,
                    body: JSON.stringify({
                        generationId: 'DIRECT:' + videoUrl,
                        method: 'direct-api',
                    }),
                };
            }

            // No URL in poll response → download.js will use getMedia API to extract encodedVideo
            console.log('[Komfy Direct] No video URL in poll response. Returning mediaId for download.js getMedia strategy.');
            return {
                ok: true,
                body: JSON.stringify({
                    generationId: mediaId,
                    method: 'direct-api',
                }),
            };
        }

        if (status.includes('FAIL') || status.includes('ERROR') || status.includes('CANCEL')) {
            const errMsg = mediaStatus?.mediaMetadata?.mediaStatus?.error?.message
                || mediaStatus?.mediaMetadata?.mediaStatus?.failureReasons?.[0]
                || mediaStatus?.error?.message || status;
            console.warn('[Komfy Direct] Video generation failed:', errMsg);
            throw new Error('DIRECT_API_VIDEO_FAILED:' + errMsg);
        }
    }

    throw new Error('DIRECT_API_VIDEO_TIMEOUT:15min');
}

// ============================================================
// Response Parsers
// ============================================================

function parseImageApiResponse(data, requestId) {
    console.log('[Komfy Direct] Image response keys:', Object.keys(data));

    // Format 1: flowMedia response — { media: [{ name, workflowId, image: {...} }], workflows: [...] }
    const mediaList = data?.media;
    if (mediaList && mediaList.length > 0) {
        const first = mediaList[0];
        const img = first?.image;
        console.log('[Komfy Direct] media[0] keys:', Object.keys(first), '| name:', first?.name?.substring(0, 30));
        if (img) {
            console.log('[Komfy Direct] media[0].image keys:', Object.keys(img));
        }

        // image co the chua imageBytes (base64), encodedImage, hoac uri/url
        if (img) {
            const imageBytes = img.imageBytes || img.encodedImage || img.bytesBase64Encoded;
            if (imageBytes) {
                const mimeType = img.mimeType || 'image/png';
                console.log('[Komfy Direct] ✅ Got image base64 from media[0].image |', (imageBytes.length / 1024).toFixed(0), 'KB');
                return {
                    ok: true,
                    body: JSON.stringify({
                        base64: imageBytes,
                        mimeType: mimeType,
                        size: Math.round(imageBytes.length * 3 / 4),
                        method: 'direct-api',
                    }),
                };
            }
            // image co uri/url
            const imgUrl = img.uri || img.url || img.gcsUri;
            if (imgUrl) {
                console.log('[Komfy Direct] ✅ Got image URL from media[0].image');
                return {
                    ok: true,
                    body: JSON.stringify({
                        imageUrl: imgUrl,
                        method: 'direct-api-url',
                    }),
                };
            }
        }

        // Check generatedImage sub-object for URL or image data
        if (img?.generatedImage) {
            const gi = img.generatedImage;
            // Some responses include image URL inside generatedImage
            const giUrl = gi.fifeUrl || gi.uri || gi.url || gi.gcsUri || gi.imageUrl || gi.signedUrl;
            if (giUrl) {
                console.log('[Komfy Direct] ✅ Got image URL from generatedImage:', giUrl.substring(0, 80));
                return {
                    ok: true,
                    body: JSON.stringify({ imageUrl: giUrl, method: 'direct-api-url' }),
                };
            }
            const giBytes = gi.imageBytes || gi.encodedImage || gi.bytesBase64Encoded;
            if (giBytes) {
                console.log('[Komfy Direct] ✅ Got image base64 from generatedImage |', (giBytes.length / 1024).toFixed(0), 'KB');
                return {
                    ok: true,
                    body: JSON.stringify({ base64: giBytes, mimeType: gi.mimeType || 'image/png', size: Math.round(giBytes.length * 3 / 4), method: 'direct-api' }),
                };
            }
        }

        // Fallback: chi co name (mediaId) → tra ve de renderer download
        const mediaId = first?.name;
        if (mediaId) {
            // Log FULL response de debug (truncated)
            console.log('[Komfy Direct] Only got mediaId, no image data.');
            console.log('[Komfy Direct] FULL media[0]:', JSON.stringify(first).substring(0, 500));
            if (img) console.log('[Komfy Direct] FULL image:', JSON.stringify(img).substring(0, 500));
            return {
                ok: true,
                body: JSON.stringify({
                    generationId: mediaId,
                    mediaId: mediaId,
                    method: 'direct-api-media',
                }),
            };
        }
    }

    // Format 2: generatedImages
    const genImages = data?.generatedImages || data?.generated_images;
    if (genImages && genImages.length > 0) {
        const first = genImages[0];
        const imageBytes = first?.image?.imageBytes || first?.imageBytes;
        const mimeType = first?.image?.mimeType || first?.mimeType || 'image/png';
        if (imageBytes) {
            return {
                ok: true,
                body: JSON.stringify({
                    base64: imageBytes,
                    mimeType: mimeType,
                    size: Math.round(imageBytes.length * 3 / 4),
                    method: 'direct-api',
                }),
            };
        }
    }

    // Format 3: Tra ve nhu raw
    console.log('[Komfy Direct] Image response format unknown, full:', JSON.stringify(data).substring(0, 500));
    return {
        ok: true,
        body: JSON.stringify(data),
    };
}

function parseVideoApiResponse(data, requestId) {
    // Video API tra ve generationId — polling se check trang thai
    // ReferenceImages endpoint tra ve: { operations: [...], remainingCredits, workflows, media }
    const generationId = data?.generationResults?.[0]?.generationId
        || data?.generationId || data?.operationId || data?.name
        || data?.operations?.[0]?.name || data?.operations?.[0]?.generationId
        || (Array.isArray(data) && data[0]?.generationId)
        || (Array.isArray(data) && data[0]?.name);

    if (generationId) {
        console.log('[Komfy Direct] Video generationId:', generationId);
        return {
            ok: true,
            body: JSON.stringify({
                generationId: generationId,
                method: 'direct-api',
            }),
        };
    }

    // Check for API error in response
    const apiErr = data?.error?.message || data?.error?.status
        || data?.generationResults?.[0]?.error?.message;
    if (apiErr) {
        return {
            ok: false,
            status: 200,
            error: 'API error: ' + String(apiErr).substring(0, 200),
        };
    }

    // Deep search: try to find generationId anywhere in response
    // Log chi tiet de debug
    const ops0 = data?.operations?.[0];
    const media0 = data?.media?.[0];
    console.log('[Komfy Direct] Video response keys:', Object.keys(data),
        '| ops[0] keys:', ops0 ? Object.keys(ops0) : 'N/A',
        '| ops[0] sample:', ops0 ? JSON.stringify(ops0).substring(0, 300) : 'N/A',
        '| media[0] keys:', media0 ? Object.keys(media0) : 'N/A');

    // Try deeper extraction
    const deepId = ops0?.metadata?.generationId || ops0?.response?.generationId
        || ops0?.operationId || ops0?.id
        || media0?.name || media0?.generationId || media0?.mediaGenerationId;
    if (deepId) {
        console.log('[Komfy Direct] Video generationId (deep):', deepId);
        return {
            ok: true,
            body: JSON.stringify({
                generationId: deepId,
                method: 'direct-api',
            }),
        };
    }

    console.warn('[Komfy Direct] Video response: could not extract generationId. Full:', JSON.stringify(data).substring(0, 800));
    return {
        ok: true,
        body: JSON.stringify(data),
    };
}

// ============================================================
// Model & Aspect Ratio Mapping
// ============================================================

function mapImageModelKey(modelName) {
    // Model names from Flow UI intercepted requests:
    // Nano Banana 2 → NARWHAL, Pro → GEM_PIX_2
    const lower = (modelName || '').toLowerCase();
    if (lower.includes('pro')) return 'GEM_PIX_2';
    if (lower.includes('banana 2') || lower.includes('nano banana')) return 'NARWHAL';
    if (lower.includes('banana')) return 'GEM_PIX_0';
    return 'NARWHAL';
}

function mapImageAspectRatio(ratio) {
    // Flow API dung format: IMAGE_ASPECT_RATIO_LANDSCAPE, IMAGE_ASPECT_RATIO_PORTRAIT, IMAGE_ASPECT_RATIO_SQUARE
    const r = (ratio || '').toLowerCase().replace(/\s/g, '');
    if (r === '16:9' || r === 'landscape') return 'IMAGE_ASPECT_RATIO_LANDSCAPE';
    if (r === '9:16' || r === 'portrait') return 'IMAGE_ASPECT_RATIO_PORTRAIT';
    if (r === '1:1' || r === 'square') return 'IMAGE_ASPECT_RATIO_SQUARE';
    if (r.includes('LANDSCAPE')) return r;
    if (r.includes('PORTRAIT')) return r;
    if (r.includes('SQUARE')) return r;
    return 'IMAGE_ASPECT_RATIO_LANDSCAPE';
}
