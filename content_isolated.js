// ISOLATED world - bridge giua MAIN world va background.js

window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    // XBV token tu page
    if (event.data.type === 'KOMFY_XBV_TOKEN') {
        try { chrome.runtime.sendMessage({ action: 'UPDATE_XBV', xbv: event.data.xbv, projectId: event.data.projectId }); } catch(e) {}
    }

    // ★ Bearer token captured from fetch interceptor
    if (event.data.type === 'KOMFY_TOKEN_CAPTURED') {
        try { chrome.runtime.sendMessage({ action: 'TOKEN_CAPTURED', token: event.data.token, projectId: event.data.projectId }); } catch(e) {}
    }

    // State (projectId)
    if (event.data.type === 'KOMFY_STATE') {
        try { chrome.runtime.sendMessage({ action: 'UPDATE_STATE', projectId: event.data.projectId }); } catch(e) {}
    }

    // Ket qua UI automation (generationId)
    if (event.data.type === 'KOMFY_UI_RESULT') {
        try { chrome.runtime.sendMessage({ action: 'UI_RESULT', requestId: event.data.requestId, success: event.data.success, generationId: event.data.generationId, error: event.data.error }); } catch(e) {}
    }

    // Debug logs tu content_main.js
    if (event.data.type === 'KOMFY_DEBUG') {
        console.log('[Komfy DEBUG]', event.data.msg);
        try { chrome.runtime.sendMessage({ action: 'DEBUG_LOG', msg: event.data.msg }); } catch(e) {}
    }

    if (event.data.type === 'KOMFY_DEBUG_FETCH') {
        try { chrome.runtime.sendMessage({ action: 'DEBUG_LOG', msg: `FETCH: ${event.data.url}\nBODY: ${event.data.body}` }); } catch(e) {}
    }
});

// Nhan lenh tu background.js de thuc hien UI automation
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'GENERATE_UI') {
        window.postMessage({
            type: 'KOMFY_GENERATE_UI',
            requestId: message.requestId,
            prompt: message.prompt,
        }, '*');

        // Lang nghe ket qua
        const handler = (event) => {
            if (!event.data || event.data.type !== 'KOMFY_UI_RESULT') return;
            if (event.data.requestId !== message.requestId) return;
            window.removeEventListener('message', handler);
            sendResponse({ generationId: event.data.generationId, error: event.data.error, success: event.data.success });
        };
        window.addEventListener('message', handler);
        return true; // async
    }
});
