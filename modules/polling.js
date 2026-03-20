// Task polling loop + webRequest token capture.

// =========================================================
// LONG-POLL: Nhan lenh tu server
// =========================================================
// =========================================================
// TASK PROCESSOR (chay song song, mutex trong extension serializes UI)
// =========================================================
async function processTask(task) {
    let result;
    try {
        if (task.endpoint === 'UPLOAD_IMAGE') {
            // Upload image to Google Flow project
            if (!sessionData.bearerToken) {
                console.log('[Komfy] UPLOAD: Chua co token → ensureFlowTab de lay...');
                await ensureFlowTab(false); // Mo/reload tab de capture token
                // Cho them neu can
                const started = Date.now();
                while (!sessionData.bearerToken && Date.now() - started < 15000) {
                    await new Promise(r => setTimeout(r, 500));
                }
                if (!sessionData.bearerToken) {
                    throw new Error('Khong co Google session token. Vui long mo tab Google Flow va dang nhap.');
                }
            }
            const body = typeof task.body === 'string' ? JSON.parse(task.body) : task.body;
            const projectId = body.projectId || sessionData.projectId;
            const imageBytes = body.imageBytes;
            if (!imageBytes) throw new Error('UPLOAD_IMAGE: Khong co imageBytes');

            console.log('[Komfy] Upload image | projectId:', projectId, '| size:', (imageBytes.length / 1024).toFixed(0), 'KB');

            const uploadBody = JSON.stringify({
                clientContext: {
                    projectId: projectId,
                    tool: 'PINHOLE',
                },
                imageBytes: imageBytes,
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

            const uploadRes = await fetch(FLOW_API + '/flow/uploadImage', {
                method: 'POST',
                headers: {
                    'authorization': sessionData.bearerToken || '',
                    'x-browser-validation': sessionData.xbv || '',
                    'content-type': 'text/plain;charset=UTF-8',
                    'accept': '*/*',
                    'origin': 'https://labs.google',
                    'referer': 'https://labs.google/',
                },
                body: uploadBody,
            });

            const uploadText = await uploadRes.text();
            console.log('[Komfy] Upload response status:', uploadRes.status);

            if (!uploadRes.ok) {
                throw new Error('Upload failed: HTTP ' + uploadRes.status + ' - ' + uploadText.substring(0, 200));
            }

            result = { ok: true, status: uploadRes.status, body: uploadText };

        } else if (task.endpoint.includes('batchAsyncGenerateVideoText')) {
            // Video generation (T2V): ensureFlowTab() tu dong mo tab + cho token neu can
            const body = JSON.parse(task.body);
            const parts = body.requests && body.requests[0] && body.requests[0].textInput &&
                body.requests[0].textInput.structuredPrompt && body.requests[0].textInput.structuredPrompt.parts;
            const prompt = (parts && parts[0] && parts[0].text) || 'A beautiful scene';
            // V2: aspectRatio nam truc tiep trong requests[0], fallback sang videoGenerationConfig (compat)
            const aspectRatio = (body.requests[0] && body.requests[0].aspectRatio) ||
                (body.requests[0] && body.requests[0].videoGenerationConfig && body.requests[0].videoGenerationConfig.aspectRatio) ||
                'VIDEO_ASPECT_RATIO_LANDSCAPE';
            const pName = body.projectName || (body.clientContext && body.clientContext.projectName) || null;
            const videoModelKey = (body.requests[0] && body.requests[0].videoModelKey) || null;
            // Map videoModelKey -> targetVideoModel label for Flow UI popover
            const targetVideoModel = body.targetVideoModel || (videoModelKey?.toLowerCase().includes('quality') ? 'Veo 3.1 - Quality' : 'Veo 3.1 - Fast');
            // imageInputs: reference/ingredient images (data URLs)
            const videoImageInputs = body.imageInputs || [];
            console.log('[Komfy] Video task | project:', pName, '| aspectRatio:', aspectRatio, '| model:', videoModelKey, '| target:', targetVideoModel, '| ingredients:', videoImageInputs.length, '| prompt:', prompt.substring(0, 40));
            result = await generateViaUI(prompt, aspectRatio, pName, videoModelKey, null, targetVideoModel, 'Ingredients', videoImageInputs, task.requestId);

        } else if (task.endpoint.includes('batchAsyncGenerateVideoStartImage') ||
                   task.endpoint.includes('batchAsyncGenerateVideoEndImage') ||
                   task.endpoint.includes('batchAsyncGenerateVideoStartEndImage')) {
            // I2V / Last Frame / Interpolation: Su dung UI Automation + Fetch Interceptor thay vi API truc tiep de vut sach 403
            if (!sessionData.bearerToken) {
                console.log('[Komfy] I2V: Chua co token → ensureFlowTab...');
                await ensureFlowTab(false);
                const started = Date.now();
                while (!sessionData.bearerToken && Date.now() - started < 15000) {
                    await new Promise(r => setTimeout(r, 500));
                }
                if (!sessionData.bearerToken) {
                    throw new Error('Khong co Google session token. Vui long mo tab Google Flow va dang nhap.');
                }
            }
            
            const body = JSON.parse(task.body);
            const prompt = body.requests?.[0]?.textInput?.structuredPrompt?.parts?.[0]?.text || 'A beautiful scene';
            const aspectRatio = body.requests?.[0]?.aspectRatio || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
            // body.projectName duoc set boi flow-broker-api.js (vd: "Test - komfy-studio")
            const pName = body.projectName || null;
            const videoModelKey = body.requests?.[0]?.videoModelKey || null;
            
            // Prepare I2V specific payload
            const targetVideoModel2 = body.targetVideoModel || (videoModelKey?.toLowerCase().includes('quality') ? 'Veo 3.1 - Quality' : 'Veo 3.1 - Fast');
            const videoType2 = (body.requests[0]?.startImage || body.requests[0]?.endImage) ? 'Frames' : 'Ingredients';

            const i2vPayload = {
                endpoint: task.endpoint,
                startImage: body.requests[0]?.startImage?.mediaId || null,
                endImage: body.requests[0]?.endImage?.mediaId || null,
                // Data URLs cho selectFrameFromPicker (paste truc tiep vao modal)
                startImageDataUrl: body.startFrameDataUrl || null,
                endImageDataUrl: body.endFrameDataUrl || null,
                videoModelKey: videoModelKey
            };
            
            console.log('[Komfy] I2V task via UI | endpoint:', task.endpoint, '| model:', targetVideoModel2, '| type:', videoType2);
            result = await generateViaUI(prompt, aspectRatio, pName, videoModelKey, i2vPayload, targetVideoModel2, videoType2, body.imageInputs || [], task.requestId);


        } else if (task.endpoint.includes('batchGenerateImages')) {
            // Image generation (Nano Banana 2 / Pro): tu dong chuyen sang Image mode
            const body = JSON.parse(task.body);
            const prompt = body.prompt || body.textInput?.structuredPrompt?.parts?.[0]?.text || 'A beautiful image';
            const aspectRatio = body.aspectRatio || 'Auto';
            const modelName = body.modelName || 'Nano Banana 2';
            const pName = body.projectName || null;
            const imageInputs = body.imageInputs || []; // Array of data URLs
            console.log('[Komfy] Image task | project:', pName, '| model:', modelName, '| images:', imageInputs.length, '| prompt:', prompt.substring(0, 40));
            result = await generateImageViaUI(prompt, aspectRatio, modelName, pName, imageInputs, task.requestId);

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
    }

    // Gui ket qua ve FlowBroker
    fetch(PROXY_EXECUTE_URL + '/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: task.requestId, clientId: sessionData.clientId, result }),
    }).catch(() => {});
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
                    processTask(task).catch(e => console.error('[Komfy] processTask unhandled:', e.message));
                }
            }
        } catch (e) {
            if (!e.message || !e.message.includes('aborted')) console.warn('[Komfy Poll]', e.message);
            await new Promise(r => setTimeout(r, 500)); // Giam tu 2s xuong 500ms
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
            // Luu projectId vao storage de khoi phuc sau khi reload/restart
            chrome.storage.local.set({ komfyProjectId: match[1] });
            console.log('[Komfy] ProjectId captured & cached:', match[1].substring(0, 16) + '...');
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

