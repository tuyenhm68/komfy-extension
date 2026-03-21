// Content script chay tai document_start de intercept fetch TRUOC khi Flow load
// Muc dich: Bat ket qua API (generationId) tu chinh Flow UI gui di

(function() {
    const RESULTS_KEY = '__komfy_results__';
    window[RESULTS_KEY] = [];

    // Store captured video download URLs (GCS signed URLs)
    window.__komfy_video_urls__ = window.__komfy_video_urls__ || {};

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (url.includes('aisandbox') && (url.includes('video') || url.includes('image') || url.includes('batchGenerate'))) {
            try {
                const reqInit = args[1];
                let bodyStr = reqInit?.body ? (typeof reqInit.body === 'string' ? reqInit.body : 'Non-string body') : 'No body';
                // Strip recaptcha token (rat dai) de thay body structure that
                bodyStr = bodyStr.replace(/"token":"[^"]{50,}"/, '"token":"[RECAPTCHA_STRIPPED]"');
                window.postMessage({
                    type: 'KOMFY_DEBUG_FETCH',
                    url: url,
                    body: bodyStr.length > 4000 ? bodyStr.substring(0, 4000) + '...[truncated]' : bodyStr
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
                if (generationId) {
                    console.log('[Komfy Interceptor] ✅ Captured genId:', generationId);
                    window.postMessage({
                        type: 'KOMFY_GENERATION_CAPTURED',
                        generationId,
                        timestamp: Date.now()
                    }, '*');
                }
            } catch(e) {}
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
