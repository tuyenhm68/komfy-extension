// direct-generate.js — Thin Shell (Phase 2B)
// ★ Core IP (generateImage, generateVideo, uploadImage, pollVideoStatus)
//   đã chuyển sang Electron FlowBroker (_handleFlowAction).
// Extension chỉ giữ lại:
//   - getFreshRecaptchaToken() — PHẢI chạy trong Chrome page context
//   - downloadImageData()      — download kết quả về local
//   - Entry functions         — orchestrate + delegate sang Electron

// ============================================================
// SECTION 1: Constants
// ============================================================

const FLOW_API_BASE = 'https://aisandbox-pa.googleapis.com/v1';
const RECAPTCHA_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
const VIDEO_POLL_MAX_MS    = 15 * 60 * 1000;
const VIDEO_POLL_INTERVAL_MS = 11000;
const VIDEO_POLL_JITTER_MS   = 3000;

// ============================================================
// SECTION 2: reCAPTCHA (MUST stay in Extension — Chrome page context)
// ============================================================

async function getFreshRecaptchaToken(tabId, action) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: async (siteKey, actionName) => {
                if (window.grecaptcha?.enterprise) {
                    try { return await window.grecaptcha.enterprise.execute(siteKey, { action: actionName }); }
                    catch (e) { return null; }
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

async function refreshRecaptcha(tabId, action) {
    const token = await getFreshRecaptchaToken(tabId, action);
    if (token) sessionData.xbv = token;
    return token;
}

// ============================================================
// SECTION 3: Download Helpers (MUST stay — chrome.scripting for signed URLs)
// ============================================================

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
            } catch (e) { return { error: e.message }; }
        },
        args: [signedUrl],
    });
    return results?.[0]?.result || { error: 'No script result' };
}

async function downloadImageData(tabId, parsedBody) {
    if (parsedBody?.method === 'direct-api-url' && parsedBody?.imageUrl) {
        const dlResult = await downloadSignedUrl(tabId, parsedBody.imageUrl);
        if (dlResult?.base64) {
            return { ok: true, body: JSON.stringify({ base64: dlResult.base64, mimeType: dlResult.mimeType || 'image/jpeg', size: dlResult.size || 0, method: 'direct-api' }) };
        }
        // Fallback: Service Worker fetch
        try {
            const swRes = await fetch(parsedBody.imageUrl);
            if (swRes.ok) {
                const buf = await swRes.arrayBuffer();
                const u8 = new Uint8Array(buf);
                let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
                return { ok: true, body: JSON.stringify({ base64: btoa(s), mimeType: swRes.headers.get('content-type') || 'image/jpeg', size: buf.byteLength, method: 'direct-api' }) };
            }
        } catch (_) {}
        throw new Error('DIRECT_API_DOWNLOAD_FAILED:signed-url');
    }
    return null;
}

// ============================================================
// SECTION 4: Model & Aspect Ratio Mapping (config-driven)
// ============================================================

function mapImageModelKey(modelName, cfg) {
    const lower = (modelName || '').toLowerCase();
    const map = cfg?.imageModels || {};
    for (const [key, val] of Object.entries(map)) {
        if (lower.includes(key)) return val;
    }
    return 'NARWHAL'; // default: Nano Banana 2
}

function mapImageAspectRatio(ratio, cfg) {
    const r = (ratio || '').toLowerCase().replace(/\s/g, '');
    const map = cfg?.imageAspectRatios || {};
    for (const [key, val] of Object.entries(map)) {
        if (r === key) return val;
    }
    if (r.includes('LANDSCAPE') || r.includes('PORTRAIT') || r.includes('SQUARE')) return ratio;
    return 'IMAGE_ASPECT_RATIO_LANDSCAPE';
}

function toR2VModelKey(modelKey) {
    if (!modelKey) return modelKey;
    let mk = modelKey.replace('t2v', 'r2v');
    if (!mk.includes('_ultra')) mk += '_ultra';
    return mk;
}

function toT2VModelKey(modelKey) {
    if (!modelKey) return modelKey;
    return modelKey.replace('r2v', 't2v');
}

// ============================================================
// SECTION 5: IMAGE GENERATION — Delegate to Electron
// ============================================================

async function directGenerateImage(task) {
    const body = typeof task.body === 'string' ? JSON.parse(task.body) : task.body;
    const prompt = body.prompt || body.textInput?.structuredPrompt?.parts?.[0]?.text || 'A beautiful image';
    const aspectRatio = body.aspectRatio || '16:9';
    const modelName = body.modelName || 'Nano Banana 2';
    const cfg = await loadFlowConfig();

    console.log('[Komfy Direct] Image | model:', modelName, '| aspect:', aspectRatio, '| prompt:', prompt.substring(0, 40));

    const imageModelName = mapImageModelKey(modelName, cfg);
    const imageAspectRatio = mapImageAspectRatio(aspectRatio, cfg);
    const projectId = sessionData.projectId;

    if (!projectId) throw new Error('DIRECT_API_NO_PROJECT');

    // reCAPTCHA phải lấy từ Chrome tab (không thể ở Electron)
    const tab = await ensureFlowTab(false, body.projectName);
    await humanDelay(800, 2000);
    const recaptchaToken = await refreshRecaptcha(tab.id, 'image_generation');
    await humanDelay(300, 800);

    // Delegate generate sang Electron
    console.log('[Komfy Direct] Delegate generateImage → Electron FlowBroker...');
    const result = await callFlowAction('generateImage', {
        projectId,
        prompt,
        imageModelName,
        imageAspectRatio,
        referenceMediaIds: body.referenceMediaIds || [],
        seed: Math.floor(Math.random() * 1000000),
        // reCAPTCHA token được truyền vào params nhưng Electron sẽ cần nó trong clientContext
        recaptchaToken: recaptchaToken || sessionData.xbv,
    });

    if (!result?.ok) {
        // Retry không có refs nếu là 404/400
        if ((result?.status === 404 || result?.status === 400) && (body.referenceMediaIds || []).length > 0) {
            console.log('[Komfy Direct] Stale mediaIds → retrying WITHOUT refs via Electron...');
            const retryResult = await callFlowAction('generateImage', {
                projectId,
                prompt,
                imageModelName,
                imageAspectRatio,
                referenceMediaIds: [],
                seed: Math.floor(Math.random() * 1000000),
                recaptchaToken: await refreshRecaptcha(tab.id, 'image_generation') || sessionData.xbv,
            });
            if (!retryResult?.ok) {
                throw new Error('DIRECT_API_FAILED:' + retryResult?.status + ':retry-failed');
            }
            return _processImageResult(retryResult, tab.id);
        }
        throw new Error('DIRECT_API_FAILED:' + result?.status + ':' + (result?.error || 'unknown'));
    }

    return _processImageResult(result, tab.id);
}

async function _processImageResult(result, tabId) {
    if (result.base64) {
        return { ok: true, body: JSON.stringify({ base64: result.base64, mimeType: result.mimeType || 'image/png', method: 'direct-api' }) };
    }
    if (result.imageUrl) {
        const downloaded = await downloadImageData(tabId, { method: 'direct-api-url', imageUrl: result.imageUrl });
        if (downloaded) return downloaded;
    }
    if (result.mediaId) {
        // mediaId → tRPC redirect (proxy qua Electron)
        return { ok: true, body: JSON.stringify({ generationId: result.mediaId, mediaId: result.mediaId, method: 'direct-api-media' }) };
    }
    if (result.raw) {
        return { ok: true, body: result.raw };
    }
    return { ok: false, error: 'Unknown image result format' };
}

// ============================================================
// SECTION 6: VIDEO GENERATION — Delegate to Electron
// ============================================================

function buildVideoApiBody(body, projectId, recaptchaToken) {
    const prompt = body.requests?.[0]?.textInput?.structuredPrompt?.parts?.[0]?.text
        || (typeof body.prompt === 'string' ? body.prompt : 'A beautiful scene');
    const aspectRatio = body.requests?.[0]?.aspectRatio || body.uiAspectRatio || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
    const videoModelKey = body.requests?.[0]?.videoModelKey || null;

    const apiBody = {
        mediaGenerationContext: { batchId: crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).substring(2) + Date.now().toString(36)) },
        clientContext: {
            projectId,
            tool: 'PINHOLE',
            userPaygateTier: 'PAYGATE_TIER_TWO',
            sessionId: ';' + Date.now(),
            recaptchaContext: { token: recaptchaToken || '', applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
        },
        requests: [{
            aspectRatio,
            seed: body.requests?.[0]?.seed || Math.floor(Math.random() * 100000),
            textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
            videoModelKey,
            metadata: {},
        }],
        useV2ModelConfig: true,
    };

    if (body.requests?.[0]?.startImage) {
        apiBody.requests[0].startImage = {
            mediaId: body.requests[0].startImage.mediaId || body.requests[0].startImage,
            cropCoordinates: body.requests[0].startImage.cropCoordinates || { top: 0, left: 0, bottom: 1, right: 1 }
        };
    }
    if (body.requests?.[0]?.endImage) {
        apiBody.requests[0].endImage = {
            mediaId: body.requests[0].endImage.mediaId || body.requests[0].endImage,
            cropCoordinates: body.requests[0].endImage.cropCoordinates || { top: 0, left: 0, bottom: 1, right: 1 }
        };
    }

    return apiBody;
}

async function directGenerateVideo(task) {
    const body = typeof task.body === 'string' ? JSON.parse(task.body) : task.body;
    const endpoint = task.endpoint;
    const prompt = body.requests?.[0]?.textInput?.structuredPrompt?.parts?.[0]?.text
        || (typeof body.prompt === 'string' ? body.prompt : 'A beautiful scene');
    const videoModelKey = body.requests?.[0]?.videoModelKey || null;

    console.log('[Komfy Direct] Video | endpoint:', endpoint, '| model:', videoModelKey, '| prompt:', prompt.substring(0, 40));
    const projectId = sessionData.projectId;
    if (!projectId) throw new Error('DIRECT_API_NO_PROJECT');

    // reCAPTCHA phải lấy từ Chrome tab
    const tab = await ensureFlowTab(false, body.projectName);
    await humanDelay(1000, 2500);
    const recaptchaToken = await refreshRecaptcha(tab.id, 'video_generation');
    await humanDelay(300, 800);

    // Build API body (có thể chứa frames, refs)
    const apiBody = buildVideoApiBody(body, projectId, recaptchaToken);

    // Apply ingredient images
    const referenceMediaIds = body.referenceMediaIds || [];
    const ingredientImages = body.imageInputs || [];
    let actualEndpoint = endpoint;

    if (referenceMediaIds.length > 0) {
        actualEndpoint = '/video:batchAsyncGenerateVideoReferenceImages';
        apiBody.requests[0].referenceImages = referenceMediaIds.map(mediaId => ({
            mediaId, imageUsageType: 'IMAGE_USAGE_TYPE_ASSET'
        }));
        apiBody.requests[0].videoModelKey = toR2VModelKey(apiBody.requests[0].videoModelKey);
    } else if (ingredientImages.length > 0) {
        actualEndpoint = '/video:batchAsyncGenerateVideoReferenceImages';
        apiBody.requests[0].referenceImages = ingredientImages
            .filter(url => url?.startsWith('data:'))
            .map(url => ({
                imageBytes: url.split(',')[1],
                mimeType: url.match(/^data:([^;]+);/)?.[1] || 'image/png',
                imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
            }));
        apiBody.requests[0].videoModelKey = toR2VModelKey(apiBody.requests[0].videoModelKey);
    }

    const ep = (actualEndpoint || 'batchAsyncGenerateVideoStartAndEndImage').replace(/^\/video:/, '');

    // Delegate generate sang Electron
    console.log('[Komfy Direct] Delegate generateVideo → Electron FlowBroker, ep:', ep);
    let result = await callFlowAction('generateVideo', { projectId, apiBody, endpoint: ep });

    if (!result?.ok) {
        // Retry I2V nếu stale mediaIds
        if ((result?.status === 404 || result?.status === 400) && (body.startFrameDataUrl || body.endFrameDataUrl)) {
            console.log('[Komfy Direct] I2V stale → re-uploading frames via Electron...');
            if (body.startFrameDataUrl) {
                const r = await callFlowAction('uploadImage', {
                    projectId,
                    imageBytes: body.startFrameDataUrl.split(',')[1],
                    mimeType: 'image/jpeg',
                    fileName: 'start_frame.jpg',
                    isHidden: true,
                });
                if (r?.ok && r?.mediaId) {
                    apiBody.requests[0].startImage = { mediaId: r.mediaId, cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 } };
                }
            }
            if (body.endFrameDataUrl) {
                const r = await callFlowAction('uploadImage', {
                    projectId,
                    imageBytes: body.endFrameDataUrl.split(',')[1],
                    mimeType: 'image/jpeg',
                    fileName: 'end_frame.jpg',
                    isHidden: true,
                });
                if (r?.ok && r?.mediaId) {
                    apiBody.requests[0].endImage = { mediaId: r.mediaId, cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 } };
                }
            }
            const freshToken = await refreshRecaptcha(tab.id, 'video_generation');
            if (freshToken) apiBody.clientContext.recaptchaContext.token = freshToken;
            result = await callFlowAction('generateVideo', { projectId, apiBody, endpoint: ep });
        }

        if (!result?.ok) {
            throw new Error('DIRECT_API_FAILED:' + result?.status + ':' + (result?.error || 'unknown'));
        }
    }

    const mediaId = result.mediaId;
    console.log('[Komfy Direct] Video submitted! pollId:', mediaId);

    // Poll video status — Electron polls, Extension waits
    return await _pollVideoViaElectron(mediaId, projectId);
}

async function _pollVideoViaElectron(mediaId, projectId) {
    const cfg = await loadFlowConfig();
    const pollStart = Date.now();
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    while (Date.now() - pollStart < VIDEO_POLL_MAX_MS) {
        await sleep(VIDEO_POLL_INTERVAL_MS + Math.random() * VIDEO_POLL_JITTER_MS);

        const pollResult = await callFlowAction('pollVideoStatus', { mediaId, projectId });
        if (!pollResult?.ok) {
            console.warn('[Komfy Direct] Poll error:', pollResult?.error);
            continue;
        }

        const elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);
        console.log('[Komfy Direct] Poll status:', pollResult.status, '| elapsed:', elapsed + 's');

        if (pollResult.isDone) {
            if (pollResult.videoUrl) {
                return { ok: true, body: JSON.stringify({ generationId: 'DIRECT:' + pollResult.videoUrl, method: 'direct-api' }) };
            }
            return { ok: true, body: JSON.stringify({ generationId: mediaId, method: 'direct-api' }) };
        }

        if (pollResult.isFailed) {
            throw new Error('DIRECT_API_VIDEO_FAILED:' + (pollResult.failureReason || pollResult.status));
        }
    }

    throw new Error('DIRECT_API_VIDEO_TIMEOUT:15min');
}
