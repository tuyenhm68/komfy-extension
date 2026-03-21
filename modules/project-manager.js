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
    // Human-like pause before clicking (simulate user looking for button)
    await humanDelay(1000, 2500);
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

            // Click vao title de focus/mo che do edit (human-like click timing)
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: titleInfo.x, y: titleInfo.y, button: 'left', clickCount: 1 });
            await humanDelay(60, 150); // realistic mouse button hold time
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: titleInfo.x, y: titleInfo.y, button: 'left', clickCount: 1 });
            await humanDelay(400, 800);

            // Neu la span/button, click lan nua co the mo input mode
            if (titleInfo.isSpan) {
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: titleInfo.x, y: titleInfo.y, button: 'left', clickCount: 1 });
                await humanDelay(60, 150);
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: titleInfo.x, y: titleInfo.y, button: 'left', clickCount: 1 });
                await humanDelay(400, 800);
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

            // SET VALUE VIA REACT-COMPATIBLE METHOD
            // React controlled inputs ignore native insertText — must use
            // Object.getOwnPropertyDescriptor to set value and dispatch 'input' event
            const setResult = await send('Runtime.evaluate', {
                expression: `(function(newName){
                    var inputs = document.querySelectorAll('input');
                    for (var i = 0; i < inputs.length; i++) {
                        var inp = inputs[i];
                        var r = inp.getBoundingClientRect();
                        if (r.top < 80 && r.width > 50 && r.width < 500) {
                            inp.focus();
                            // React overrides input.value setter — use native setter to bypass
                            var nativeSetter = Object.getOwnPropertyDescriptor(
                                window.HTMLInputElement.prototype, 'value'
                            ).set;
                            nativeSetter.call(inp, newName);
                            // Dispatch events that React listens to
                            inp.dispatchEvent(new Event('input', { bubbles: true }));
                            inp.dispatchEvent(new Event('change', { bubbles: true }));
                            return { ok: true, value: inp.value };
                        }
                    }
                    return { ok: false, reason: 'no input found' };
                })(${JSON.stringify(projectName)})`,
                returnByValue: true,
                awaitPromise: false,
            });
            console.log('[Komfy] React setValue result:', JSON.stringify(setResult?.result?.value));
            await sleep(300);

            // Enter to confirm + blur to trigger save
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
            await sleep(300);

            // Click outside to blur
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 400, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 500, y: 400, button: 'left', clickCount: 1 });
            await sleep(500);

            // Verify: check if title was saved
            const verifyResult = await send('Runtime.evaluate', {
                expression: `(function(){
                    // Check input first
                    var inputs = document.querySelectorAll('input');
                    for (var i = 0; i < inputs.length; i++) {
                        var r = inputs[i].getBoundingClientRect();
                        if (r.top < 80 && r.width > 50 && r.width < 500)
                            return { source: 'input', value: inputs[i].value };
                    }
                    // Check header text (title may have reverted to span after blur)
                    var spans = document.querySelectorAll('button, span, div');
                    for (var j = 0; j < spans.length; j++) {
                        var el = spans[j];
                        var r2 = el.getBoundingClientRect();
                        if (r2.top < 80 && r2.left < 400 && r2.left > 30 && r2.width > 40 && el.textContent.trim().length > 3 && el.textContent.trim().length < 50)
                            return { source: 'span', value: el.textContent.trim() };
                    }
                    return { source: 'none' };
                })()`,
                returnByValue: true,
                awaitPromise: false,
            });
            const verified = verifyResult?.result?.value;
            console.log('[Komfy] Title verify after save:', JSON.stringify(verified));

            // FALLBACK: If React setter didn't work, try tRPC API rename
            const titleMismatch = !verified || !verified.value || !verified.value.includes(projectName);
            if (titleMismatch) {
                console.log('[Komfy] Title mismatch after React setter, trying tRPC API rename...');
                const pidMatch = (await chrome.tabs.get(tabId).catch(() => ({ url: '' }))).url?.match(/\/project\/([a-zA-Z0-9_-]+)/);
                if (pidMatch) {
                    // Try multiple tRPC endpoint patterns (Flow may use different names)
                    const renameResult = await send('Runtime.evaluate', {
                        expression: `(async function(pid, newName){
                            var endpoints = [
                                'project.updateProjectTitle',
                                'project.renameProject',
                                'project.updateProject',
                                'project.update',
                                'project.setTitle'
                            ];
                            var payloads = [
                                { '0': { json: { projectId: pid, title: newName } } },
                                { '0': { json: { projectId: pid, name: newName } } },
                                { '0': { json: { id: pid, title: newName } } },
                                { '0': { json: { id: pid, name: newName } } },
                            ];
                            for (var ep of endpoints) {
                                for (var payload of payloads) {
                                    try {
                                        var res = await fetch('/fx/api/trpc/' + ep + '?batch=1', {
                                            method: 'POST',
                                            headers: { 'content-type': 'application/json' },
                                            credentials: 'include',
                                            body: JSON.stringify(payload)
                                        });
                                        if (res.ok) {
                                            var text = await res.text();
                                            return { ok: true, endpoint: ep, status: res.status, body: text.substring(0, 300) };
                                        }
                                    } catch(e) {}
                                }
                            }
                            return { ok: false, error: 'All tRPC endpoints failed' };
                        })(${JSON.stringify(pidMatch[1])}, ${JSON.stringify(projectName)})`,
                        returnByValue: true,
                        awaitPromise: true,
                    });
                    console.log('[Komfy] tRPC rename result:', JSON.stringify(renameResult?.result?.value));

                    // If tRPC also failed, try CDP keyboard approach as last resort
                    if (!renameResult?.result?.value?.ok) {
                        console.log('[Komfy] tRPC failed, trying CDP keyboard approach...');
                        // Click on title to enter edit mode
                        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editTarget.x, y: editTarget.y, button: 'left', clickCount: 3 });
                        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editTarget.x, y: editTarget.y, button: 'left', clickCount: 3 });
                        await sleep(300);
                        // Ctrl+A to select all
                        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
                        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
                        await sleep(100);
                        // Delete selected text
                        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
                        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
                        await sleep(100);
                        // Type character by character with human-like typing speed
                        for (const ch of projectName) {
                            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch });
                            await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
                            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
                            // 50-180ms per char (realistic typing speed ~60-100 WPM)
                            await new Promise(r => setTimeout(r, 50 + Math.random() * 130));
                        }
                        await sleep(300);
                        // Enter + blur
                        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
                        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
                        await sleep(200);
                        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 400, button: 'left', clickCount: 1 });
                        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 500, y: 400, button: 'left', clickCount: 1 });
                        await sleep(500);
                        console.log('[Komfy] CDP keyboard rename completed');
                    }
                }
            }

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
        // Cap nhat komfyProjectMap (de lan sau navigate truc tiep khong can scan home page)
        const updatedMap = (await new Promise(r => chrome.storage.local.get(['komfyProjectMap'], r))).komfyProjectMap || {};
        updatedMap[projectName] = newProjectId;
        await chrome.storage.local.set({ komfyProjectMap: updatedMap });
        console.log('[Komfy] ✅ Cached projectId cho "' + projectName + '":', newProjectId.substring(0, 16) + '...');
    }
}

/**
 * Rename an existing project on Google Flow.
 * Tab must be on the project page (ensured via projectId in URL).
 *
 * @param {string} newName - New project name (e.g. "[KS] Quảng cáo ABC")
 * @param {string} projectId - Project UUID to navigate to
 */
async function renameProjectOnFlow(newName, projectId) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const tab = await findFlowTab();
    if (!tab) throw new Error('No Flow tab found');
    const tabId = tab.id;

    // Navigate to the project if not already there
    const currentUrl = tab.url || '';
    if (!currentUrl.includes('/project/' + projectId)) {
        const projectUrl = 'https://labs.google/fx/tools/flow/project/' + projectId;
        await chrome.tabs.update(tabId, { url: projectUrl });
        await waitForTabLoad(tabId, 15000).catch(() => {});
        await sleep(2000);
    }

    // Reuse the same rename logic as createAndRenameProject
    console.log('[Komfy] Renaming project to "' + newName + '"...');
    try {
        await chrome.debugger.attach({ tabId }, '1.3');
        const send = (method, params) => new Promise((res, rej) => {
            chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
                if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
                else res(result);
            });
        });

        // Try tRPC API rename first (fastest, no UI interaction needed)
        const renameResult = await send('Runtime.evaluate', {
            expression: `(async function(pid, newName){
                var endpoints = [
                    'project.updateProjectTitle',
                    'project.renameProject',
                    'project.updateProject',
                    'project.update',
                    'project.setTitle'
                ];
                var payloads = [
                    { '0': { json: { projectId: pid, title: newName } } },
                    { '0': { json: { projectId: pid, name: newName } } },
                    { '0': { json: { id: pid, title: newName } } },
                    { '0': { json: { id: pid, name: newName } } },
                ];
                for (var ep of endpoints) {
                    for (var payload of payloads) {
                        try {
                            var res = await fetch('/fx/api/trpc/' + ep + '?batch=1', {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                credentials: 'include',
                                body: JSON.stringify(payload)
                            });
                            if (res.ok) {
                                var text = await res.text();
                                return { ok: true, endpoint: ep, status: res.status };
                            }
                        } catch(e) {}
                    }
                }
                return { ok: false, error: 'All tRPC endpoints failed' };
            })(${JSON.stringify(projectId)}, ${JSON.stringify(newName)})`,
            returnByValue: true,
            awaitPromise: true,
        });

        if (renameResult?.result?.value?.ok) {
            console.log('[Komfy] ✅ Project renamed via tRPC:', renameResult.result.value.endpoint);
            return;
        }

        // Fallback: React setter + CDP keyboard (same as createAndRenameProject)
        console.log('[Komfy] tRPC rename failed, trying UI approach...');
        const setResult = await send('Runtime.evaluate', {
            expression: `(function(newName){
                var inputs = document.querySelectorAll('input');
                for (var i = 0; i < inputs.length; i++) {
                    var inp = inputs[i];
                    var r = inp.getBoundingClientRect();
                    if (r.top < 80 && r.width > 50 && r.width < 500) {
                        inp.focus();
                        var nativeSetter = Object.getOwnPropertyDescriptor(
                            window.HTMLInputElement.prototype, 'value'
                        ).set;
                        nativeSetter.call(inp, newName);
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                        return { ok: true, value: inp.value };
                    }
                }
                return { ok: false, reason: 'no input found' };
            })(${JSON.stringify(newName)})`,
            returnByValue: true,
            awaitPromise: false,
        });

        if (setResult?.result?.value?.ok) {
            await sleep(300);
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
            await sleep(300);
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500, y: 400, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 500, y: 400, button: 'left', clickCount: 1 });
            await sleep(300);
            console.log('[Komfy] ✅ Project renamed via React setter');
        } else {
            console.warn('[Komfy] Could not rename project — no title input found');
        }
    } finally {
        chrome.debugger.detach({ tabId }).catch(() => {});
    }
}
