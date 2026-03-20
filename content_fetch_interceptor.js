// Content script chay tai document_start de intercept fetch TRUOC khi Flow load
// Muc dich: Bat ket qua API (generationId) tu chinh Flow UI gui di

(function() {
    const RESULTS_KEY = '__komfy_results__';
    window[RESULTS_KEY] = [];

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (url.includes('aisandbox') && url.includes('video')) {
            try {
                const reqInit = args[1];
                const bodyStr = reqInit?.body ? (typeof reqInit.body === 'string' ? reqInit.body : 'Non-string body') : 'No body';
                window.postMessage({
                    type: 'KOMFY_DEBUG_FETCH',
                    url: url,
                    body: bodyStr
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

        return result;
    };
})();
