// MAIN world - co quyen truy cap vao page context cua labs.google
// Thuc hien UI automation de tao video thay vi goi API truc tiep

// Guard: tranh inject nhieu lan (background co the inject lai khi restart)
if (window.__KOMFY_LOADED__) {
    console.log('[Komfy] content_main.js already loaded, skipping re-init');
} else {
window.__KOMFY_LOADED__ = true;
console.log('[Komfy] content_main.js loaded v1.8');

function getProjectIdFromUrl() {
    const match = window.location.href.match(/\/project\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

// Gui state ban dau
setTimeout(() => {
    window.postMessage({ type: 'KOMFY_STATE', projectId: getProjectIdFromUrl() }, '*');
    // Kich hoat 1 request ngam de chrome.webRequest ben background.js bat duoc Token ngay lap tuc
    // Ma khong can nguoi dung phai tu thao tac hay bam "Op Dong Bo"
    fetch('https://labs.google/fx/api/trpc/user.get?batch=1', { method: 'GET' }).catch(() => {});
}, 1000);

// =====================================================
// UI AUTOMATION: Type prompt + Click Create button
// =====================================================
async function typePromptAndCreate(prompt) {
    const log = (msg) => window.postMessage({ type: 'KOMFY_DEBUG', msg }, '*');

    // 1. Tim textbox
    const textbox = document.querySelector('[role="textbox"], textarea, [contenteditable="true"]');
    if (!textbox) {
        log('ERROR: Khong tim thay textbox!');
        const allEditable = document.querySelectorAll('*[contenteditable], textarea, input[type="text"]');
        log('So phan tu editable: ' + allEditable.length);
        throw new Error('Khong tim thay textbox tren trang Flow!');
    }
    log('Tim thay textbox: ' + (textbox.tagName + '.' + textbox.className).substring(0, 60));

    // 2. Focus va clear
    textbox.focus();
    textbox.click();
    await sleep(300);

    // Select all + delete
    textbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, composed: true }));
    await sleep(100);
    textbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, composed: true }));
    await sleep(100);

    // 3. Type prompt via InputEvent (Slate.js dung beforeinput)
    textbox.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: prompt,
        bubbles: true,
        cancelable: true,
        composed: true,
    }));
    await sleep(200);

    // Fallback execCommand
    if (!textbox.textContent?.trim()) {
        document.execCommand('insertText', false, prompt);
        await sleep(200);
    }

    textbox.dispatchEvent(new Event('input', { bubbles: true }));
    textbox.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(500);
    log('Content: "' + textbox.textContent?.substring(0, 80) + '"');

    // 4. Tim nut submit
    await sleep(300);
    const allBtns = [...document.querySelectorAll('button')];
    log('Buttons: ' + allBtns.length);
    allBtns.slice(0, 12).forEach((btn, i) => {
        const label = btn.getAttribute('aria-label') || '';
        const text = btn.textContent?.trim().substring(0, 20) || '';
        log(`  [${i}] label="${label}" text="${text}" disabled=${btn.disabled}`);
    });

    let submitBtn = null;

    // Chien luoc 1: aria-label
    for (const btn of allBtns) {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('create') || label.includes('generate') || label.includes('send') || label.includes('submit')) {
            submitBtn = btn;
            log('Found by aria-label: "' + label + '"');
            break;
        }
    }

    // Chien luoc 2: nut enabled gan textbox nhat
    if (!submitBtn) {
        const tbRect = textbox.getBoundingClientRect();
        let closestDist = Infinity;
        for (const btn of allBtns) {
            if (btn.disabled) continue;
            const rect = btn.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const dist = Math.hypot(rect.left - tbRect.right, rect.top - tbRect.bottom);
            if (dist < closestDist && dist < 200) {
                closestDist = dist;
                submitBtn = btn;
            }
        }
        if (submitBtn) log('Found closest button (dist=' + Math.round(closestDist) + 'px)');
    }

    // Chien luoc 3: Enter key
    if (!submitBtn) {
        log('No button found, trying Enter key...');
        textbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, composed: true }));
        await sleep(100);
        textbox.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, composed: true }));
        await sleep(500);
        log('Enter key sent');
        return;
    }

    // Click voi full MouseEvent
    const rect = submitBtn.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    log('Clicking at (' + Math.round(cx) + ',' + Math.round(cy) + ')');
    ['mousedown', 'mouseup', 'click'].forEach(type => {
        submitBtn.dispatchEvent(new MouseEvent(type, {
            view: window, bubbles: true, cancelable: true,
            clientX: cx, clientY: cy, screenX: cx, screenY: cy
        }));
    });

    await sleep(500);
    log('Click done, waiting for generationId...');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =====================================================
// Lang nghe lenh tu Extension Isolated World
// =====================================================
window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'KOMFY_XBV_TOKEN') {
        try {
            chrome.runtime.sendMessage({ action: 'UPDATE_XBV', xbv: event.data.xbv, projectId: event.data.projectId });
        } catch(e) {}
    }

    if (event.data.type === 'KOMFY_GENERATE_UI') {
        const { requestId, prompt } = event.data;
        try {
            // === INJECT FETCH INTERCEPTOR TRUOC KHI CLICK ===
            // Override window.fetch de bat generationId tu response cua Flow
            const originalFetch = window.fetch;
            let fetchRestored = false;

            window.fetch = async function(...args) {
                const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                const result = await originalFetch.apply(this, args);

                if (!fetchRestored && url.includes('batchAsyncGenerateVideoText')) {
                    try {
                        const clone = result.clone();
                        const data = await clone.json();
                        const genId = data?.generationResults?.[0]?.generationId;
                        if (genId) {
                            fetchRestored = true;
                            window.fetch = originalFetch; // Restore
                            window.postMessage({ type: 'KOMFY_GENERATION_CAPTURED', generationId: genId }, '*');
                        }
                    } catch(e) {}
                }
                return result;
            };

            // Lang nghe generationId
            const capturePromise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    window.fetch = originalFetch;
                    reject(new Error('Timeout 55s cho generationId'));
                }, 55000);
                window.addEventListener('message', function handler(e) {
                    if (e.data?.type === 'KOMFY_GENERATION_CAPTURED') {
                        clearTimeout(timer);
                        window.removeEventListener('message', handler);
                        resolve(e.data.generationId);
                    }
                });
            });

            // Thuc hien UI automation
            await typePromptAndCreate(prompt);

            // Doi generationId
            const generationId = await capturePromise;
            window.postMessage({ type: 'KOMFY_UI_RESULT', requestId, success: true, generationId }, '*');
        } catch (e) {
            window.postMessage({ type: 'KOMFY_UI_RESULT', requestId, success: false, error: e.message }, '*');
        }
    }
});

// =====================================================
// LAY RECAPTCHA TOKEN (de Export XBV)
// =====================================================
let isSending = false;
async function grabRecaptcha() {
    if (isSending) return;
    if (window.grecaptcha && window.grecaptcha.enterprise) {
        isSending = true;
        try {
            const token = await window.grecaptcha.enterprise.execute(
                '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV',
                { action: 'video_generation' }
            );
            window.postMessage({ type: 'KOMFY_XBV_TOKEN', xbv: token, projectId: getProjectIdFromUrl() }, '*');
        } catch (err) {
            console.error('[Komfy] reCaptcha error:', err);
        }
        isSending = false;
    }
}

setTimeout(grabRecaptcha, 2000);
setInterval(grabRecaptcha, 120000);

} // end if (!window.__KOMFY_LOADED__)
