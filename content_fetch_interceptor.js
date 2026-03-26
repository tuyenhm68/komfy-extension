// Content script chay tai document_start de intercept fetch TRUOC khi Flow load
// Muc dich: Bat ket qua API (generationId) tu chinh Flow UI gui di

(function() {
    const RESULTS_KEY = '__komfy_results__';
    window[RESULTS_KEY] = [];

    // Store captured video download URLs (GCS signed URLs)
    window.__komfy_video_urls__ = window.__komfy_video_urls__ || {};

    const originalFetch = window.fetch;
    // ★ Store native fetch reference for Direct API (callApiFromPage)
    // Direct API needs unmodified fetch for cross-origin requests
    window.__komfy_nativeFetch__ = window.__komfy_nativeFetch__ || originalFetch;
    console.log('[Komfy Interceptor] Initialized. nativeFetch stored:', !!window.__komfy_nativeFetch__);
    window.fetch = async function(...args) {
        let url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

        // ★ I2V Frame Injection — KHÔNG đổi URL (CORS chặn endpoint khác)
        // Giữ nguyên URL batchAsyncGenerateVideoText, chỉ thêm startImage/endImage
        // + đổi videoModelKey trong body. API sẽ route dựa trên body content.
        if (window.__komfy_i2vData__ && url.includes('batchAsyncGenerateVideoText')) {
            var i2v = window.__komfy_i2vData__;
            if (i2v.startImage || i2v.endImage) {
                try {
                    var reqInit = args[1] || {};
                    var bodyStr = typeof reqInit.body === 'string' ? reqInit.body : null;
                    if (bodyStr) {
                        var bodyObj = JSON.parse(bodyStr);
                        if (bodyObj.requests && bodyObj.requests[0]) {
                            var req0 = bodyObj.requests[0];
                            // Thêm startImage/endImage vào body với cropCoordinates (bắt buộc theo API mới)
                            var defaultCrop = { top: 0, left: 0, bottom: 1, right: 1 };
                            if (i2v.startImage) req0.startImage = { mediaId: i2v.startImage, cropCoordinates: i2v.startCrop || defaultCrop };
                            if (i2v.endImage) req0.endImage = { mediaId: i2v.endImage, cropCoordinates: i2v.endCrop || defaultCrop };
                            // Đổi videoModelKey sang I2V model
                            if (i2v.videoModelKey) req0.videoModelKey = i2v.videoModelKey;
                        }
                        var newBody = JSON.stringify(bodyObj);
                        console.log('[Komfy Interceptor] I2V INJECT (same URL):',
                            url.substring(url.lastIndexOf('/') + 1),
                            '| start:', (i2v.startImage || 'none').substring(0, 15),
                            '| end:', (i2v.endImage || 'none').substring(0, 15),
                            '| model:', i2v.videoModelKey || 'unchanged');
                        window.postMessage({
                            type: 'KOMFY_DEBUG_FETCH',
                            url: '[I2V-INJECT] ' + url.substring(url.lastIndexOf('/') + 1) + ' (URL unchanged)',
                            body: 'startImage=' + (i2v.startImage || 'none').substring(0, 25)
                                + ' | endImage=' + (i2v.endImage || 'none').substring(0, 25)
                                + ' | model=' + (i2v.videoModelKey || 'unchanged')
                                + ' | bodyLen=' + newBody.length
                        }, '*');
                        // KHÔNG đổi URL — chỉ đổi body
                        args[1] = Object.assign({}, reqInit, { body: newBody });
                        window.__komfy_i2vData__ = null;
                    }
                } catch(swapErr) {
                    console.error('[Komfy Interceptor] I2V inject error:', swapErr.message);
                    window.postMessage({
                        type: 'KOMFY_DEBUG_FETCH',
                        url: '[I2V-INTERCEPTOR-ERROR]',
                        body: 'inject error: ' + swapErr.message
                    }, '*');
                }
            }
        }
        // ★ Log khi URL la batchAsyncGenerateVideoText nhung KHONG co i2vData
        else if (!window.__komfy_i2vData__ && url.includes('batchAsyncGenerateVideoText')) {
            window.postMessage({
                type: 'KOMFY_DEBUG_FETCH',
                url: '[I2V-INTERCEPTOR-NO-DATA] batchAsyncGenerateVideoText called but __komfy_i2vData__ is NULL!',
                body: 'This means I2V swap did NOT happen — request sent as plain Text-to-Video'
            }, '*');
        }

        // ★ Fetch counter — track all aisandbox fetches after submit for diagnostics
        if (window.__komfy_clickTime && url.includes('aisandbox')) {
            window.__komfy_fetchCount__ = (window.__komfy_fetchCount__ || 0) + 1;
            window.__komfy_fetchUrls__ = window.__komfy_fetchUrls__ || [];
            window.__komfy_fetchUrls__.push(url.substring(url.lastIndexOf('/') + 1).substring(0, 50));
        }

        // ★ Capture Bearer token from ANY googleapis/Google API request
        // OAuth2 access token (ya29.xxx) works across Google APIs — capture from any source
        if (url.includes('googleapis.com') || url.includes('google.com/') || url.includes('labs.google/')) {
            try {
                const reqInit = args[1] || {};
                const headers = reqInit.headers || {};
                // Headers can be Headers object, array, or plain object
                let authValue = null;
                if (headers instanceof Headers) {
                    authValue = headers.get('authorization') || headers.get('Authorization');
                } else if (Array.isArray(headers)) {
                    const entry = headers.find(h => h[0]?.toLowerCase() === 'authorization');
                    if (entry) authValue = entry[1];
                } else {
                    authValue = headers['authorization'] || headers['Authorization'];
                }
                if (authValue && authValue.startsWith('Bearer ')) {
                    // Extract projectId from URL (e.g., /projects/{id}/locations/)
                    const projMatch = url.match(/projects\/([^\/]+)\/locations/);
                    window.postMessage({
                        type: 'KOMFY_TOKEN_CAPTURED',
                        token: authValue,
                        projectId: projMatch ? projMatch[1] : null
                    }, '*');
                }
            } catch(e) {}
        }

        if (url.includes('aisandbox') && (url.includes('video') || url.includes('image') || url.includes('batchGenerate'))) {
            try {
                const reqInit = args[1];
                let bodyStr = reqInit?.body ? (typeof reqInit.body === 'string' ? reqInit.body : 'Non-string body') : 'No body';
                // Strip recaptcha token (rat dai) de thay body structure that
                bodyStr = bodyStr.replace(/"token":"[^"]{50,}"/, '"token":"[RECAPTCHA_STRIPPED]"');

                // ★ DEBUG: Extract frame info from original body for I2V diagnosis
                let frameInfo = '';
                try {
                    const parsedBody = JSON.parse(reqInit?.body || '{}');
                    const req0 = parsedBody?.requests?.[0];
                    if (req0) {
                        frameInfo = ' | startImage:' + (req0.startImage ? JSON.stringify(req0.startImage) : 'NONE')
                                  + ' | endImage:' + (req0.endImage ? JSON.stringify(req0.endImage) : 'NONE')
                                  + ' | modelKey:' + (req0.videoModelKey || 'N/A');
                    }
                } catch(pe) {}

                window.postMessage({
                    type: 'KOMFY_DEBUG_FETCH',
                    url: url,
                    body: '[ORIGINAL PRE-CDP]' + frameInfo + '\n' + (bodyStr.length > 4000 ? bodyStr.substring(0, 4000) + '...[truncated]' : bodyStr)
                }, '*');
            } catch(e) {}
        }

        const result = await originalFetch.apply(this, args);

        // Intercept response video generation
        // Match BOTH batchAsyncGenerateVideoText AND batchAsyncGenerateVideoReferenceImages
        // (Ingredients mode uses ReferenceImages endpoint)
        if (url.includes('aisandbox-pa.googleapis.com') &&
            url.includes('batchAsyncGenerateVideo')) {
            try {
                const clone = result.clone();
                const data = await clone.json();
                const generationId = data.generationResults?.[0]?.generationId
                    || data.generationId || data.operationId || data.name
                    || (Array.isArray(data) && data[0]?.generationId)
                    || (Array.isArray(data) && data[0]?.name);

                const apiError = data?.error?.message || data?.error?.status
                    || data?.generationResults?.[0]?.error?.message
                    || (Array.isArray(data) && data[0]?.error?.message);

                const shortData = JSON.stringify(data).substring(0, 400);
                const keys = JSON.stringify(Object.keys(data || {}));

                // ★ Forward ALL response info via postMessage → SW log file
                window.postMessage({
                    type: 'KOMFY_DEBUG_FETCH',
                    url: url + ' [RESPONSE status=' + result.status + ']',
                    body: 'genId=' + (generationId || 'none') + ' | error=' + (apiError || 'none') + ' | keys=' + keys + ' | data=' + shortData
                }, '*');

                if (generationId) {
                    window.postMessage({
                        type: 'KOMFY_GENERATION_CAPTURED',
                        generationId,
                        timestamp: Date.now()
                    }, '*');
                }
            } catch(e) {
                window.postMessage({
                    type: 'KOMFY_DEBUG_FETCH',
                    url: url + ' [RESPONSE_PARSE_ERROR status=' + result.status + ']',
                    body: 'parseError=' + e.message
                }, '*');
            }
        }

        // ★ Capture GCS video URLs from any response (when Flow loads project media)
        // Flow fetches video data via tRPC or aisandbox API → response contains GCS signed URL
        if (url.includes('storage.googleapis.com') || url.includes('googleusercontent.com')) {
            // Direct fetch to GCS — the URL itself is the video URL
            if (!url.includes('gstatic.com') && !url.includes('/website/flow/')) {
                window.__komfy_video_urls__['_direct_gcs_' + Date.now()] = url;
            }
        }
        // Capture video URLs from tRPC/API responses
        if ((url.includes('trpc') && url.includes('media')) ||
            (url.includes('aisandbox') && !url.includes('batchAsyncGenerateVideo') && !url.includes('batchCheckAsync'))) {
            try {
                const clone = result.clone();
                const txt = await clone.text();
                // Find GCS URLs in response
                const gcsMatches = txt.matchAll(/"(https:\/\/[^"]*storage\.googleapis\.com[^"]*)"/g);
                for (const m of gcsMatches) {
                    window.__komfy_video_urls__['_resp_' + Date.now()] = m[1];
                }
                const ucMatches = txt.matchAll(/"(https:\/\/[^"]*googleusercontent\.com\/[^"]*video[^"]*)"/gi);
                for (const m of ucMatches) {
                    window.__komfy_video_urls__['_uc_' + Date.now()] = m[1];
                }
            } catch(e) {}
        }

        return result;
    };

    // ★ Also intercept XMLHttpRequest (some media loads may use XHR)
    const origXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__komfy_url = url;
        return origXHROpen.call(this, method, url, ...rest);
    };
    const origXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            const url = this.__komfy_url || '';
            if (url.includes('storage.googleapis.com') || url.includes('googleusercontent.com')) {
                if (!url.includes('gstatic.com')) {
                    window.__komfy_video_urls__['_xhr_' + Date.now()] = url;
                }
            }
        });
        return origXHRSend.apply(this, args);
    };
})();
