// Task polling loop + webRequest token capture.

// =========================================================
// IMAGE UPLOAD CACHE — tranh upload lai anh da co mediaId
// Key: hash cua imageBytes (dau + cuoi + length)
// Value: { mediaId, projectId, timestamp }
// =========================================================
const __uploadCache = new Map();
const UPLOAD_CACHE_MAX_AGE = 4 * 60 * 60 * 1000; // 4 gio

function computeImageHash(imageBytes) {
    // Fast hash: length + first 64 chars + last 64 chars
    // Du de phan biet cac anh khac nhau ma khong can crypto
    const len = imageBytes.length;
    const head = imageBytes.substring(0, 64);
    const tail = imageBytes.substring(Math.max(0, len - 64));
    return len + ':' + head + ':' + tail;
}

function getCachedMediaId(imageBytes, projectId) {
    const hash = computeImageHash(imageBytes);
    const cached = __uploadCache.get(hash);
    if (!cached) return null;
    // Check: cung project + chua het han
    if (cached.projectId !== projectId) return null;
    if (Date.now() - cached.timestamp > UPLOAD_CACHE_MAX_AGE) {
        __uploadCache.delete(hash);
        return null;
    }
    return cached.mediaId;
}

function setCachedMediaId(imageBytes, projectId, mediaId) {
    const hash = computeImageHash(imageBytes);
    __uploadCache.set(hash, { mediaId, projectId, timestamp: Date.now() });
    // Gioi han cache size
    if (__uploadCache.size > 200) {
        const oldest = __uploadCache.keys().next().value;
        __uploadCache.delete(oldest);
    }
}

// =========================================================
// LONG-POLL: Nhan lenh tu server
// =========================================================
// =========================================================
// TASK PROCESSOR (chay song song, mutex trong extension serializes UI)
// =========================================================
async function processTask(task) {
    // ★ Extract projectName from task body for project lock
    let lockProjectName = null;
    try {
        const _body = typeof task.body === 'string' ? JSON.parse(task.body) : (task.body || {});
        lockProjectName = _body.projectName || null;
    } catch(e) {}

    // Acquire project lock — waits if a different project is active with running tasks
    await acquireProjectLock(lockProjectName);

    let result;
    try {
        if (task.endpoint === 'RELOAD_EXTENSION') {
            // Remote reload — ExtensionManager calls this after auto-update
            console.log('[Komfy] 🔄 RELOAD_EXTENSION received — reloading in 600ms...');
            result = { ok: true, status: 200, body: '{"reloading":true}' };
            // Delay slightly so this response can be sent back before SW terminates
            setTimeout(() => chrome.runtime.reload(), 600);

        } else if (task.endpoint === 'PREPARE_PROJECT') {

            // ★ Pre-warm: verify/create project BEFORE any upload/generate task
            const body = typeof task.body === 'string' ? JSON.parse(task.body) : task.body;
            const pName = body.projectName || null;
            if (pName) {
                console.log('[Komfy] PREPARE_PROJECT:', pName);
                await ensureFlowTab(false, pName);
                const pid = sessionData.projectId;
                console.log('[Komfy] PREPARE_PROJECT ✅', pName, '→', pid ? pid.substring(0, 16) : 'no-id');
                result = { ok: true, status: 200, body: JSON.stringify({ projectId: pid, projectName: pName }) };
            } else {
                result = { ok: true, status: 200, body: '{"skipped":"no projectName"}' };
            }

        } else if (task.endpoint === 'RENAME_PROJECT') {
            // ★ Rename: update cache + rename on Google Flow
            const body = typeof task.body === 'string' ? JSON.parse(task.body) : task.body;
            const oldName = body.oldProjectName || null;
            const newName = body.newProjectName || null;
            console.log('[Komfy] RENAME_PROJECT:', oldName, '→', newName);

            if (oldName && newName && oldName !== newName) {
                // Update projectMap cache
                const mapData = await new Promise(r => chrome.storage.local.get(['komfyProjectMap'], r));
                const projectMap = mapData.komfyProjectMap || {};
                const projectId = projectMap[oldName];
                if (projectId) {
                    projectMap[newName] = projectId;
                    delete projectMap[oldName];
                    await chrome.storage.local.set({ komfyProjectMap: projectMap });
                    console.log('[Komfy] RENAME_PROJECT cache updated:', projectId.substring(0, 16));

                    // Rename on Google Flow UI
                    try {
                        await renameProjectOnFlow(newName, projectId);
                        console.log('[Komfy] RENAME_PROJECT ✅ Flow project renamed');
                    } catch (renameErr) {
                        console.warn('[Komfy] RENAME_PROJECT Flow rename failed (cache still updated):', renameErr.message?.substring(0, 80));
                    }
                    result = { ok: true, status: 200, body: JSON.stringify({ projectId, oldName, newName }) };
                } else {
                    console.log('[Komfy] RENAME_PROJECT: old name not in cache, will create on next task');
                    result = { ok: true, status: 200, body: '{"skipped":"old name not cached"}' };
                }
            } else {
                result = { ok: true, status: 200, body: '{"skipped":"invalid names"}' };
            }

        } else if (task.endpoint === 'UPLOAD_IMAGE') {
            // Upload image to Google Flow project
            // ★ Always verify project + credentials before upload
            const body = typeof task.body === 'string' ? JSON.parse(task.body) : task.body;
            const imageBytes = body.imageBytes;
            if (!imageBytes) throw new Error('UPLOAD_IMAGE: Khong co imageBytes');

            await ensureFlowTab(false, lockProjectName || null);
            if (!sessionData.bearerToken) {
                const started = Date.now();
                while (!sessionData.bearerToken && Date.now() - started < 15000) {
                    await new Promise(r => setTimeout(r, 500));
                }
                if (!sessionData.bearerToken) {
                    throw new Error('Khong co Google session token. Vui long mo tab Google Flow va dang nhap.');
                }
            }
            // Use verified projectId from session (not stale body.projectId)
            const projectId = sessionData.projectId || body.projectId;
            if (!projectId) throw new Error('UPLOAD_IMAGE: Khong co projectId');
            console.log('[Komfy] UPLOAD: verified projectId:', projectId.substring(0, 16));

            // ★ CHECK CACHE — skip upload neu anh da co mediaId
            const cachedId = getCachedMediaId(imageBytes, projectId);
            if (cachedId) {
                console.log('[Komfy] Upload CACHE HIT! mediaId:', cachedId.substring(0, 20), '| size:', (imageBytes.length / 1024).toFixed(0), 'KB');
                result = { ok: true, status: 200, body: JSON.stringify({ media: { name: cachedId } }) };
            } else {
                console.log('[Komfy] Upload image | projectId:', projectId, '| size:', (imageBytes.length / 1024).toFixed(0), 'KB');

                const uploadBody = JSON.stringify({
                    clientContext: {
                        projectId: projectId,
                        tool: 'PINHOLE',
                    },
                    imageBytes: imageBytes,
                    isUserUploaded: true,
                    isHidden: false,
                    mimeType: 'image/jpeg',
                    fileName: 'komfy_ingredient.jpg'
                });

                const FLOW_API = 'https://aisandbox-pa.googleapis.com/v1';

                // Generate fresh reCAPTCHA token
                const tab = await findFlowTab();
                if (tab) {
                    try {
                        const results = await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            world: 'MAIN',
                            func: async () => {
                                if (window.grecaptcha && window.grecaptcha.enterprise) {
                                    try { return await window.grecaptcha.enterprise.execute('6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV', { action: 'upload_image' }); } catch(e) { return null; }
                                }
                                return null;
                            }
                        });
                        if (results?.[0]?.result) sessionData.xbv = results[0].result;
                    } catch(e) {}
                }

                // Human-like pause before upload (simulate user selecting file)
                await humanDelay(600, 1500);

                let uploadRes = await fetch(FLOW_API + '/flow/uploadImage', {
                    method: 'POST',
                    headers: {
                        'authorization': sessionData.bearerToken || '',
                        'x-browser-validation': sessionData.xbv || '',
                        'content-type': 'application/json',
                        'accept': '*/*',
                        'origin': 'https://labs.google',
                        'referer': 'https://labs.google/',
                    },
                    body: uploadBody,
                });

                let uploadText = await uploadRes.text();
                console.log('[Komfy] Upload response status:', uploadRes.status);

                // ★ RETRY LOGIC FOR STALE CREDENTIALS (401 / 403)
                if (!uploadRes.ok && (uploadRes.status === 401 || uploadRes.status === 403)) {
                    console.warn(`[Komfy] Upload failed ${uploadRes.status} (Stale credentials). Forcing reload and retry...`);
                    // Force refresh tab to get new bearer token
                    await ensureFlowTab(true, lockProjectName || null); 
                    await humanDelay(2000, 3000); // Give time for page to settle

                    // Refresh recaptcha using the new tab
                    const newTab = await findFlowTab();
                    if (newTab) {
                        try {
                            const results = await chrome.scripting.executeScript({
                                target: { tabId: newTab.id },
                                world: 'MAIN',
                                func: async () => {
                                    if (window.grecaptcha && window.grecaptcha.enterprise) {
                                        try { return await window.grecaptcha.enterprise.execute('6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV', { action: 'upload_image' }); } catch(e) { return null; }
                                    }
                                    return null;
                                }
                            });
                            if (results?.[0]?.result) sessionData.xbv = results[0].result;
                        } catch(e) {}
                    }

                    // Retry Fetch
                    uploadRes = await fetch(FLOW_API + '/flow/uploadImage', {
                        method: 'POST',
                        headers: {
                            'authorization': sessionData.bearerToken || '',
                            'x-browser-validation': sessionData.xbv || '',
                            'content-type': 'application/json',
                            'accept': '*/*',
                            'origin': 'https://labs.google',
                            'referer': 'https://labs.google/',
                        },
                        body: uploadBody,
                    });
                    
                    uploadText = await uploadRes.text();
                    console.log('[Komfy] Upload retry response status:', uploadRes.status);
                }

                if (!uploadRes.ok) {
                    throw new Error('Upload failed: HTTP ' + uploadRes.status + ' - ' + uploadText.substring(0, 200));
                }

                // ★ CACHE mediaId tu response
                try {
                    const parsed = JSON.parse(uploadText);
                    const mediaId = parsed?.media?.name || parsed?.mediaId;
                    if (mediaId) {
                        setCachedMediaId(imageBytes, projectId, mediaId);
                        console.log('[Komfy] Upload cached! mediaId:', mediaId.substring(0, 20));
                    }
                } catch(e) {}

                result = { ok: true, status: uploadRes.status, body: uploadText };
            }

        } else if (task.endpoint.includes('batchAsyncGenerateVideoText')) {
            // Video generation (T2V)
            // ★ DIRECT API FIRST — khong phu thuoc UI, ngon ngu, layout
            const videoBody = JSON.parse(task.body);
            const videoImageInputs = videoBody.imageInputs || [];
            const videoRefMediaIds = videoBody.referenceMediaIds || [];
            const hasIngredientImages = videoImageInputs.length > 0;
            const hasMediaIds = videoRefMediaIds.length > 0;

            // Direct API: ho tro T2V thuan + T2V co ingredient images (qua referenceMediaIds)
            if (!hasIngredientImages || hasMediaIds) {
                try {
                    console.log('[Komfy] Video T2V → trying Direct API first...', hasMediaIds ? `(${videoRefMediaIds.length} mediaIds)` : '(no ingredients)');
                    result = await directGenerateVideo(task);
                    console.log('[Komfy] Video T2V ✅ Direct API success!');
                } catch (directErr) {
                    const errMsg = directErr.message || String(directErr);
                    console.warn('[Komfy] Video T2V Direct API failed:', errMsg, '→ fallback to UI automation');
                    result = null;
                }
            }

            if (!result) {
                // UI automation fallback (hoac ingredient images)
                const parts = videoBody.requests && videoBody.requests[0] && videoBody.requests[0].textInput &&
                    videoBody.requests[0].textInput.structuredPrompt && videoBody.requests[0].textInput.structuredPrompt.parts;
                const prompt = (parts && parts[0] && parts[0].text) || 'A beautiful scene';
                const aspectRatio = (videoBody.requests[0] && videoBody.requests[0].aspectRatio) ||
                    (videoBody.requests[0] && videoBody.requests[0].videoGenerationConfig && videoBody.requests[0].videoGenerationConfig.aspectRatio) ||
                    'VIDEO_ASPECT_RATIO_LANDSCAPE';
                const pName = videoBody.projectName || (videoBody.clientContext && videoBody.clientContext.projectName) || null;
                const videoModelKey = (videoBody.requests[0] && videoBody.requests[0].videoModelKey) || null;
                const targetVideoModel = videoModelKey?.toLowerCase().includes('quality') ? 'Veo 3.1 - Quality' : 'Veo 3.1 - Fast';
                console.log('[Komfy] Video task (UI) | project:', pName, '| aspectRatio:', aspectRatio, '| model:', videoModelKey, '| target:', targetVideoModel, '| ingredients:', videoImageInputs.length, '| prompt:', prompt.substring(0, 40));
                result = await generateViaUI(prompt, aspectRatio, pName, videoModelKey, null, targetVideoModel, 'Ingredients', videoImageInputs, task.requestId);
            }

        } else if (task.endpoint.includes('batchAsyncGenerateVideoStartImage') ||
                   task.endpoint.includes('batchAsyncGenerateVideoEndImage') ||
                   task.endpoint.includes('batchAsyncGenerateVideoStartAndEndImage')) {
            // I2V / Last Frame / Interpolation
            // ★ DIRECT API FIRST — I2V co startImage/endImage mediaId trong body
            const i2vBody = JSON.parse(task.body);
            const hasMediaId = !!(i2vBody.requests?.[0]?.startImage?.mediaId || i2vBody.requests?.[0]?.endImage?.mediaId);

            // ★ DEBUG: Full I2V data trace at entry point
            console.log('[Komfy] [DEBUG] I2V task entry:',
                '| hasMediaId:', hasMediaId,
                '| startImage:', JSON.stringify(i2vBody.requests?.[0]?.startImage || null),
                '| endImage:', JSON.stringify(i2vBody.requests?.[0]?.endImage || null),
                '| startFrameDataUrl:', i2vBody.startFrameDataUrl ? 'YES(' + i2vBody.startFrameDataUrl.length + ' chars)' : 'null',
                '| endFrameDataUrl:', i2vBody.endFrameDataUrl ? 'YES(' + i2vBody.endFrameDataUrl.length + ' chars)' : 'null',
                '| videoModelKey:', i2vBody.requests?.[0]?.videoModelKey
            );

            if (hasMediaId) {
                try {
                    console.log('[Komfy] I2V → trying Direct API first...');
                    result = await directGenerateVideo(task);
                    console.log('[Komfy] I2V ✅ Direct API success!');
                } catch (directErr) {
                    console.warn('[Komfy] I2V Direct API failed:', directErr.message, '→ fallback to UI automation');
                    result = null;
                }
            }

            if (!result) {
                // UI automation fallback
                // Extract params truoc de dung cho ensureFlowTab
                const prompt = i2vBody.requests?.[0]?.textInput?.structuredPrompt?.parts?.[0]?.text || 'A beautiful scene';
                const aspectRatio = i2vBody.uiAspectRatio || i2vBody.requests?.[0]?.aspectRatio || '16:9';
                const resolutionMultiplier = i2vBody.resolutionMultiplier || 'x1';
                const pName = i2vBody.projectName || null;
                const videoModelKey = i2vBody.requests?.[0]?.videoModelKey || null;

                if (!sessionData.bearerToken) {
                    // ★ Goi ensureFlowTab VOI project name de navigate toi project + capture credentials
                    console.log('[Komfy] I2V: Chua co token → ensureFlowTab (project:', pName, ')...');
                    await ensureFlowTab(false, pName);
                    const started = Date.now();
                    while (!sessionData.bearerToken && Date.now() - started < 15000) {
                        await new Promise(r => setTimeout(r, 500));
                    }
                    if (!sessionData.bearerToken) {
                        throw new Error('Khong co Google session token. Vui long mo tab Google Flow va dang nhap.');
                    }
                }

                const targetVideoModel2 = i2vBody.targetVideoModel || (videoModelKey?.toLowerCase().includes('quality') ? 'Veo 3.1 - Quality' : 'Veo 3.1 - Fast');
                const videoType2 = (i2vBody.requests[0]?.startImage || i2vBody.requests[0]?.endImage) ? 'Frames' : 'Ingredients';

                const i2vPayload = {
                    endpoint: task.endpoint,
                    startImage: i2vBody.requests[0]?.startImage?.mediaId || null,
                    startCrop: i2vBody.requests[0]?.startImage?.cropCoordinates || null,
                    endImage: i2vBody.requests[0]?.endImage?.mediaId || null,
                    endCrop: i2vBody.requests[0]?.endImage?.cropCoordinates || null,
                    startImageDataUrl: i2vBody.startFrameDataUrl || null,
                    endImageDataUrl: i2vBody.endFrameDataUrl || null,
                    videoModelKey: videoModelKey
                };

                console.log('[Komfy] I2V task via UI | endpoint:', task.endpoint, '| model:', targetVideoModel2, '| type:', videoType2, '| aspect:', aspectRatio, '| res:', resolutionMultiplier);
                result = await generateViaUI(prompt, aspectRatio, pName, videoModelKey, i2vPayload, targetVideoModel2, videoType2, i2vBody.imageInputs || [], task.requestId, resolutionMultiplier);
            }


        } else if (task.endpoint.includes('batchGenerateImages')) {
            // Image generation — Direct API first (response contains fifeUrl signed URL)
            const imgBody = typeof task.body === 'string' ? JSON.parse(task.body) : task.body;
            const imgImageInputs = imgBody.imageInputs || [];
            const prompt = imgBody.prompt || imgBody.textInput?.structuredPrompt?.parts?.[0]?.text || 'A beautiful image';
            const aspectRatio = imgBody.aspectRatio || '16:9';
            const imageType = imgBody.imageType || 'Ingredients';
            const modelName = imgBody.modelName || 'Nano Banana 2';
            const pName = imgBody.projectName || null;

            let skipUiFallback = false;
            try {
                console.log('[Komfy] Image → Direct API via Electron...');
                result = await directGenerateImage(task);
                console.log('[Komfy] Image ✅ Direct API success!');
            } catch (directErr) {
                const errMsg = directErr.message || String(directErr);
                if (errMsg.includes('DIRECT_API_DOWNLOAD_FAILED')) {
                    console.warn('[Komfy] Image created but download failed:', errMsg.substring(0, 100), '→ NO UI fallback (avoid duplicate)');
                    skipUiFallback = true;
                    result = { ok: false, status: 0, error: 'Image generated but download failed.' };
                } else {
                    console.warn('[Komfy] Image Direct API failed:', errMsg.substring(0, 100), '→ fallback to UI (CDP)');
                    result = null;
                }
            }

            if (!result && !skipUiFallback) {
                console.log('[Komfy] Image task (UI fallback CDP) | project:', pName, '| model:', modelName, '| aspect:', aspectRatio);
                result = await generateImageViaUI(prompt, aspectRatio, imageType, modelName, pName, imgImageInputs, task.requestId);
            }


        } else if (task.endpoint === 'DOWNLOAD_MEDIA_BLOB') {
            if (!sessionData.bearerToken) {
                console.log('[Komfy] DOWNLOAD: Chua co token → ensureFlowTab...');
                await ensureFlowTab(false);
                const started = Date.now();
                while (!sessionData.bearerToken && Date.now() - started < 15000) {
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
    } finally {
        // ★ Release project lock — allows queued tasks for other projects to proceed
        releaseProjectLock(lockProjectName);
        activeTaskIds.delete(task.requestId);
    }

    // Gui ket qua ve FlowBroker (retry 3 lan neu fail)
    const respondBody = JSON.stringify({ requestId: task.requestId, clientId: sessionData.clientId, result });
    for (let retry = 0; retry < 3; retry++) {
        try {
            const resp = await fetch(PROXY_EXECUTE_URL + '/respond', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: respondBody,
            });
            if (resp.ok) {
                console.log('[Komfy] ✅ Respond sent:', task.endpoint, '| requestId:', task.requestId?.substring(0, 12));
                break;
            }
            console.warn('[Komfy] Respond HTTP', resp.status, '| retry', retry + 1);
        } catch (respondErr) {
            console.warn('[Komfy] Respond failed (retry', retry + 1 + '):', respondErr.message?.substring(0, 60));
            if (retry < 2) await new Promise(r => setTimeout(r, 500 * (retry + 1)));
        }
    }
}

// =========================================================
// LONG-POLL: Nhan lenh tu server
// Poll loop khong bi block boi task — moi task chay song song
// UI Mutex (trong image-gen.js/video-gen.js) serialize viec tuong tac UI
// =========================================================
const activeTaskIds = new Set();

async function pollForApiRequests() {
    while (true) {
        try {
            if (!sessionData.clientId) { await new Promise(r => setTimeout(r, 1000)); continue; }
            const res = await fetch(PROXY_EXECUTE_URL + '/poll?clientId=' + sessionData.clientId, {
                method: 'GET',
                signal: AbortSignal.timeout(8000), // Khop voi POLL_TIMEOUT_MS=5s + buffer
            });

            if (res.ok) {
                const task = await res.json();
                if (task && task.requestId) {
                    if (activeTaskIds.has(task.requestId)) {
                        continue; // Bo qua task bi gui lap lai (thuong do Proxy Server resend vi task chay qua trau)
                    }
                    activeTaskIds.add(task.requestId);
                    
                    console.log('[Komfy] Task received:', task.endpoint, '| requestId:', task.requestId?.substring(0, 12));
                    // ★ FIRE AND FORGET: Khong await processTask
                    // Poll loop NGAY LAP TUC co the nhan task tiep theo
                    // Extension se xu ly song song, serialize UI qua mutex
                    // Human-like stagger: random delay before starting task (avoid burst pattern)
                    const taskDelay = 500 + Math.random() * 1500;
                    setTimeout(() => {
                        processTask(task).catch(e => console.error('[Komfy] processTask unhandled:', e.message));
                    }, taskDelay);
                }
            }
        } catch (e) {
            if (!e.message || !e.message.includes('aborted')) console.warn('[Komfy Poll]', e.message);
            await new Promise(r => setTimeout(r, 300 + Math.random() * 700)); // Jitter 300-1000ms
        }
    }
}

// pollForApiRequests() is called from background.js entry point

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
        // Also capture reCAPTCHA and metadata headers necessary for Google APIs
        const xClientData = details.requestHeaders.find(h => h.name.toLowerCase() === 'x-client-data');
        if (xClientData && sessionData.xClientData !== xClientData.value) {
            sessionData.xClientData = xClientData.value;
            needsSync = true;
        }

        const extHeader = details.requestHeaders.find(h => h.name.toLowerCase().startsWith('x-goog-ext-'));
        if (extHeader) {
            if (!sessionData.googExts) sessionData.googExts = {};
            const key = extHeader.name.toLowerCase();
            if (sessionData.googExts[key] !== extHeader.value) {
                sessionData.googExts[key] = extHeader.value;
                needsSync = true;
            }
        }

        const match = details.url.match(/projects\/([^\/]+)\/locations/);
        if (match && sessionData.projectId !== match[1]) {
            sessionData.projectId = match[1];
            needsSync = true;
            console.log('[Komfy] ProjectId captured:', match[1].substring(0, 16) + '...');
        }

        // Chi goi sendToProxy 1 lan neu co thay doi (tranh spam nhieu call trong 1 request)
        if (needsSync) {
            persistToken(); // Luu token vao session storage
            sendToProxy().catch(() => {});
        }

        return { requestHeaders: details.requestHeaders };
    },
    { urls: TOKEN_CAPTURE_URLS },
    ['requestHeaders', 'extraHeaders']
);

