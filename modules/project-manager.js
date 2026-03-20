// Project management: create & rename projects on Google Flow.

/**
 * Tao project moi tren Google Flow va dat ten.
 * Flow 1: Click nut "+ Dự án mới" tren home page
 * Flow 2: Doi project page load → rename title thanh projectName
 *
 * @param {number} tabId - Tab ID dang o trang home Flow
 * @param {string} projectName - Ten project can dat (vd: "komfy-studio")
 */
async function createAndRenameProject(tabId, projectName) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // --- Buoc 1: Click nut "Dự án mới" / "New project" ---
    console.log('[Komfy] Tim nut "Dự án mới" / "New project"...');
    const clickResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            // Keywords cho ca tieng Viet va tieng Anh
            const keywords = ['dự án mới', 'new project', 'tạo dự án', 'create project', 'new flow'];

            // Tim tat ca interactive elements (button, a, div voi role, ...)
            const candidates = [...document.querySelectorAll('button, a, [role="button"], [tabindex]')];
            
            // Strategy 1: Tim theo textContent
            for (const el of candidates) {
                const text = (el.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
                for (const kw of keywords) {
                    if (text.includes(kw)) {
                        el.click();
                        return { clicked: true, text: el.textContent.trim().substring(0, 50), strategy: 'text' };
                    }
                }
            }

            // Strategy 2: Tim theo aria-label
            for (const el of candidates) {
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                for (const kw of keywords) {
                    if (label.includes(kw)) {
                        el.click();
                        return { clicked: true, text: label, strategy: 'aria-label' };
                    }
                }
                // Them keywords chung
                if (label.includes('new') || label.includes('create') || label.includes('mới') || label.includes('tạo')) {
                    el.click();
                    return { clicked: true, text: label, strategy: 'aria-label-generic' };
                }
            }

            // Strategy 3: Tim tat ca elements (ke ca div, span) co text khop
            const allEls = [...document.querySelectorAll('*')];
            for (const el of allEls) {
                const text = (el.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
                const r = el.getBoundingClientRect();
                // Chi lay cac phan tu nho (button-like), khong phai container lon
                if (r.width > 0 && r.width < 300 && r.height > 20 && r.height < 100) {
                    for (const kw of keywords) {
                        if (text.includes(kw)) {
                            el.click();
                            return { clicked: true, text: el.textContent.trim().substring(0, 50), strategy: 'any-element', tag: el.tagName };
                        }
                    }
                }
            }

            // Debug: log cac button tim thay de diagnose
            const debugBtns = candidates.slice(0, 15).map(b => ({
                tag: b.tagName,
                text: (b.textContent || '').trim().substring(0, 40),
                label: b.getAttribute('aria-label'),
            }));
            return { clicked: false, debug: debugBtns };
        }
    }).catch(e => [{ result: { clicked: false, error: e.message } }]);

    const wasClicked = clickResult?.[0]?.result?.clicked;
    if (!wasClicked) {
        const debugInfo = clickResult?.[0]?.result?.debug || clickResult?.[0]?.result?.error || 'no debug info';
        console.error('[Komfy] ⚠ Khong tim thay nut tao project! Debug:', JSON.stringify(debugInfo));
        throw new Error('Khong tim thay nut "Dự án mới" / "New project" tren trang Flow. Vui long tao project thu cong.');
    }
    console.log('[Komfy] Da click nut tao project moi:', clickResult[0].result.text, '(strategy:', clickResult[0].result.strategy + ')');

    // --- Buoc 2: Doi project page load (URL se chuyen sang /project/{id}) ---
    await waitForTabLoad(tabId, 20000).catch(e => console.warn('[Komfy]', e.message));
    await sleep(3000); // Cho SPA render xong

    // Inject scripts vao project page moi
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_main.js'], world: 'MAIN' }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_isolated.js'], world: 'ISOLATED' }).catch(() => {});

    // Xac nhan da navigate thanh cong
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    const currentUrl = currentTab?.url || '';
    if (!currentUrl.includes('/project/')) {
        console.warn('[Komfy] ⚠ Khong navigate duoc toi project page. URL hien tai:', currentUrl);
        throw new Error('Khong tao duoc project moi. Vui long thu lai.');
    }
    console.log('[Komfy] Project moi da tao, URL:', currentUrl);

    // --- Buoc 3: Dat ten project bang CDP ---
    console.log('[Komfy] Dat ten project thanh "' + projectName + '"...');
    try {
        await chrome.debugger.attach({ tabId }, '1.3');

        const send = (method, params) => new Promise((res, rej) => {
            chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
                if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
                else res(result);
            });
        });

        // Tim input title tren header (input co ten project hien tai, vd: "Mar 16 - 04:21")
        const titleResult = await send('Runtime.evaluate', {
            expression: `(function(){
                // Tim input trong header area
                var inputs = document.querySelectorAll('input');
                for (var i = 0; i < inputs.length; i++) {
                    var inp = inputs[i];
                    var r = inp.getBoundingClientRect();
                    // Title input thuong nam o top-left, nho va nam trong header
                    if (r.top < 80 && r.width > 50 && r.width < 500) {
                        return { x: r.left + r.width / 2, y: r.top + r.height / 2, found: true, value: inp.value };
                    }
                }
                // Fallback: Tim button hoac span co text giong title project
                var spans = document.querySelectorAll('button, span, div');
                for (var j = 0; j < spans.length; j++) {
                    var el = spans[j];
                    var r2 = el.getBoundingClientRect();
                    // Phan tu nam o header, nho, co text
                    if (r2.top < 80 && r2.left < 400 && r2.left > 30 && r2.width > 40 && el.textContent.trim().length > 3 && el.textContent.trim().length < 50) {
                        return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2, found: true, value: el.textContent.trim(), isSpan: true };
                    }
                }
                return { found: false };
            })()`,
            returnByValue: true,
            awaitPromise: false,
        });

        const titleInfo = titleResult?.result?.value;
        if (!titleInfo || !titleInfo.found) {
            console.warn('[Komfy] Khong tim thay title input. Project se giu ten mac dinh.');
        } else {
            console.log('[Komfy] Tim thay title:', titleInfo.value, 'isSpan:', !!titleInfo.isSpan);

            // Click vao title de focus/mo che do edit
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: titleInfo.x, y: titleInfo.y, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: titleInfo.x, y: titleInfo.y, button: 'left', clickCount: 1 });
            await sleep(500);

            // Neu la span/button, click lan nua co the mo input mode
            if (titleInfo.isSpan) {
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: titleInfo.x, y: titleInfo.y, button: 'left', clickCount: 1 });
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: titleInfo.x, y: titleInfo.y, button: 'left', clickCount: 1 });
                await sleep(500);
            }

            // Re-find input element (co the da xuat hien sau khi click span)
            const inputRefind = await send('Runtime.evaluate', {
                expression: `(function(){
                    var inputs = document.querySelectorAll('input');
                    for (var i = 0; i < inputs.length; i++) {
                        var inp = inputs[i];
                        var r = inp.getBoundingClientRect();
                        if (r.top < 80 && r.width > 50 && r.width < 500) {
                            // Focus vao input
                            inp.focus();
                            inp.select();
                            return { x: r.left + r.width / 2, y: r.top + r.height / 2, found: true, value: inp.value, isInput: true };
                        }
                    }
                    return { found: false };
                })()`,
                returnByValue: true,
                awaitPromise: false,
            });
            const inputInfo = inputRefind?.result?.value;
            const editTarget = (inputInfo && inputInfo.found) ? inputInfo : titleInfo;
            if (inputInfo && inputInfo.found) {
                console.log('[Komfy] Re-found input element, value:', inputInfo.value);
            }

            // Triple-click de select all text (dang tin cay hon Ctrl+A cho input fields)
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editTarget.x, y: editTarget.y, button: 'left', clickCount: 3 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editTarget.x, y: editTarget.y, button: 'left', clickCount: 3 });
            await sleep(200);

            // Them Ctrl+A de dam bao chon het (belt and suspenders)
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
            await sleep(200);

            // XOA TEXT CU: Backspace de xoa hoan toan text da select
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
            await sleep(200);

            // Xac nhan input da rong
            if (editTarget.isInput) {
                const emptyCheck = await send('Runtime.evaluate', {
                    expression: `(function(){
                        var inputs = document.querySelectorAll('input');
                        for (var i = 0; i < inputs.length; i++) {
                            var r = inputs[i].getBoundingClientRect();
                            if (r.top < 80 && r.width > 50 && r.width < 500) return inputs[i].value;
                        }
                        return '?';
                    })()`,
                    returnByValue: true,
                });
                console.log('[Komfy] Input after clear:', JSON.stringify(emptyCheck?.result?.value));
            }

            // GO TEN MOI
            await send('Input.insertText', { text: projectName });
            await sleep(500);

            // Xac nhan ten da duoc go dung
            if (editTarget.isInput) {
                const verifyCheck = await send('Runtime.evaluate', {
                    expression: `(function(){
                        var inputs = document.querySelectorAll('input');
                        for (var i = 0; i < inputs.length; i++) {
                            var r = inputs[i].getBoundingClientRect();
                            if (r.top < 80 && r.width > 50 && r.width < 500) return inputs[i].value;
                        }
                        return '?';
                    })()`,
                    returnByValue: true,
                });
                console.log('[Komfy] Input after type:', JSON.stringify(verifyCheck?.result?.value));
            }

            // Enter de confirm
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
            await sleep(300);

            // Click ngoai de blur (trigger save)
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 400, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 500, y: 400, button: 'left', clickCount: 1 });
            await sleep(500);

            console.log('[Komfy] ✅ Da dat ten project thanh "' + projectName + '"');
        }
    } catch (e) {
        console.warn('[Komfy] Loi khi dat ten project:', e.message);
        // Khong throw - project da duoc tao, chi la chua doi ten
    } finally {
        chrome.debugger.detach({ tabId }).catch(() => {});
    }

    // --- Buoc 4: Lay projectId tu URL va cache ---
    const finalTab = await chrome.tabs.get(tabId).catch(() => null);
    const finalUrl = finalTab?.url || '';
    const projectIdMatch = finalUrl.match(/\/project\/([a-zA-Z0-9_-]+)/);
    if (projectIdMatch) {
        const newProjectId = projectIdMatch[1];
        sessionData.projectId = newProjectId;
        // Cap nhat ca komfyProjectId (legacy) va komfyProjectMap (moi)
        // De lan sau navigate truc tiep khong can scan home page
        const updatedMap = (await new Promise(r => chrome.storage.local.get(['komfyProjectMap'], r))).komfyProjectMap || {};
        updatedMap[projectName] = newProjectId;
        await chrome.storage.local.set({ komfyProjectId: newProjectId, komfyProjectMap: updatedMap });
        console.log('[Komfy] ✅ Cached projectId cho "' + projectName + '":', newProjectId.substring(0, 16) + '...');
    }
}
