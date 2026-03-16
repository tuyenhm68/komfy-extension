// Content script chay tai document_start de intercept fetch TRUOC khi Flow load
// Muc dich: Bat ket qua API (generationId) tu chinh Flow UI gui di

(function() {
    const RESULTS_KEY = '__komfy_results__';
    window[RESULTS_KEY] = [];

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        const result = await originalFetch.apply(this, args);

        // Intercept response video generation
        if (url.includes('aisandbox-pa.googleapis.com') && 
            url.includes('batchAsyncGenerateVideoText')) {
            try {
                const clone = result.clone();
                const data = await clone.json();
                const generationId = data.generationResults?.[0]?.generationId;
                if (generationId) {
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
