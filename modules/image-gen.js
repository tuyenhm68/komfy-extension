// Image generation via UI automation (CDP) + reference image upload via API.

/**
 * Wait for all pasted images to finish uploading before proceeding to generate.
 * Polls 3 signals: loading indicators, image count, submit button disabled state.
 * @param {Function} send - CDP send function
 * @param {number} expectedCount - Number of images expected to be uploaded
 * @param {number} maxWaitMs - Maximum wait time in ms (default 30s)
 * @returns {boolean} true if all uploads completed, false if timed out
 */
async function waitForUploadsComplete(send, expectedCount, maxWaitMs = 30000) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const startTime = Date.now();
    let lastLog = 0;
    let stableCount = 0; // Track consecutive "ready" checks

    while (Date.now() - startTime < maxWaitMs) {
        const status = await send('Runtime.evaluate', {
            expression: `(function() {
                var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
                var parent = tb ? (tb.closest('form') || tb.parentElement?.parentElement?.parentElement || tb.parentElement) : document.body;

                // 1. Check loading indicators in prompt area
                var loadingSelectors = [
                    '[class*="loading"]', '[class*="spinner"]', '[class*="progress"]',
                    '[role="progressbar"]', '[class*="upload"]', '[class*="pending"]',
                    '[class*="Processing"]', '[class*="processing"]'
                ];
                var hasLoading = false;
                for (var s = 0; s < loadingSelectors.length; s++) {
                    var els = parent.querySelectorAll(loadingSelectors[s]);
                    for (var i = 0; i < els.length; i++) {
                        var r = els[i].getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) { hasLoading = true; break; }
                    }
                    if (hasLoading) break;
                }

                // 2. Check SVG circular progress spinners
                if (!hasLoading) {
                    var circles = parent.querySelectorAll('svg circle[stroke-dasharray], svg [class*="circular"]');
                    for (var i = 0; i < circles.length; i++) {
                        var r = circles[i].closest('svg')?.getBoundingClientRect() || circles[i].getBoundingClientRect();
                        if (r.width > 0 && r.height > 0 && r.width < 60) { hasLoading = true; break; }
                    }
                }

                // 3. Count image thumbnails in the prompt/input area
                var imgNodeSet = new Set();
                var pImgs = parent.querySelectorAll('img[src]');
                for(var i=0; i<pImgs.length; i++){
                    var r = pImgs[i].getBoundingClientRect();
                    if(r.width > 5 && r.height > 5 && r.width < 150 && r.height < 150) imgNodeSet.add(pImgs[i]);
                }
                if (tb) {
                    var allImgs = document.querySelectorAll('img[src]');
                    var tbRect = tb.getBoundingClientRect();
                    for(var i=0; i<allImgs.length; i++){
                        var r = allImgs[i].getBoundingClientRect();
                        if(r.width >= 30 && r.height >= 30 && r.width < 150 && r.height < 150) {
                            if(r.bottom <= (tbRect.top + 50) && r.top > (tbRect.top - 300)) {
                                imgNodeSet.add(allImgs[i]);
                            }
                        }
                    }
                }
                var imgCount = imgNodeSet.size;
                var imgDetails = [];

                // 4. Check submit button disabled state
                var btns = document.querySelectorAll('button, div[role="button"]');
                var submitDisabled = false;
                var submitFound = false;
                for (var i = 0; i < btns.length; i++) {
                    var label = (btns[i].getAttribute('aria-label') || '').toLowerCase();
                    var tooltip = (btns[i].getAttribute('mattooltip') || '').toLowerCase();
                    if (label.includes('create') || label.includes('send') || label.includes('generate') || label.includes('tạo') || label.includes('submit') || tooltip.includes('submit')) {
                        submitFound = true;
                        submitDisabled = btns[i].disabled || btns[i].getAttribute('aria-disabled') === 'true';
                        break;
                    }
                }
                // Fallback: check nearest button to textbox
                if (!submitFound && tb) {
                    var tbR = tb.getBoundingClientRect();
                    for (var i = 0; i < btns.length; i++) {
                        var r = btns[i].getBoundingClientRect();
                        if (r.width > 0 && r.bottom > window.innerHeight - 150 && r.left > tbR.right - 100) {
                            submitDisabled = btns[i].disabled || btns[i].getAttribute('aria-disabled') === 'true';
                            submitFound = true;
                            break;
                        }
                    }
                }
                
                return {
                    hasLoading: hasLoading,
                    imgCount: imgCount,
                    submitDisabled: submitDisabled,
                    submitFound: submitFound,
                    imgDetails: imgDetails.slice(0, 5),
                };
            })()`,
            returnByValue: true,
        });

        const s = status?.result?.value || {};
        const elapsed = Date.now() - startTime;

        // Log every 3s
        if (elapsed - lastLog > 3000) {
            console.log('[Komfy] Upload check:', JSON.stringify(s),
                '| expected:', expectedCount, '| elapsed:', (elapsed / 1000).toFixed(1) + 's');
            lastLog = elapsed;
        }

        // Ready conditions:
        // - No loading indicators visible
        // - Submit button not disabled (or button not found — don't block)
        // - Image count >= expected
        // - Must have >= expectedCount images (khong cho phep 0 khi expected > 0)
        const hasEnoughImages = s.imgCount >= expectedCount && (expectedCount === 0 || s.imgCount > 0);
        const isReady = !s.hasLoading &&
            (!s.submitDisabled || !s.submitFound) &&
            hasEnoughImages;

        if (isReady) {
            stableCount++;
            // Require 3 consecutive "ready" checks (1s apart) for stability
            // Tang tu 2 → 3 de giam false-positive khi images chua thuc su upload xong
            if (stableCount >= 3) {
                console.log('[Komfy] ✅ All', expectedCount, 'images uploaded! (' +
                    (elapsed / 1000).toFixed(1) + 's, imgs:', s.imgCount + ')');
                return true;
            }
        } else {
            stableCount = 0;
        }

        await sleep(1000);
    }

    console.warn('[Komfy] ⚠️ Upload wait timeout after', (maxWaitMs / 1000) + 's!');
    return false;
}

// ============================================================
// UI INPUT MUTEX
// Dam bao chi 1 task dung Flow UI tai 1 thoi diem (phase B1→2g)
// Sau khi submit xong → release mutex → task ke tiep co the bat dau UI input
// trong khi task hien tai dang poll cho anh (concurrent polling)
// ============================================================
let __uiInputMutexTail = Promise.resolve();

// ============================================================
// CDP SESSION MUTEX (shared global scope voi video-gen.js)
// Chrome chi cho phep 1 debugger attach vao 1 tab cung luc.
// Mutex nay serialize toan bo attach → detach, doc lap voi UI mutex.
// Video task giu CDP trong khi poll ket qua, Image task phai cho.
// ============================================================
if (typeof __cdpSessionMutexTail === 'undefined') {
    var __cdpSessionMutexTail = Promise.resolve();
}

async function generateImageViaUI(prompt, aspectRatio, imageType, modelName, projectName = null, imageInputs = [], requestId = null) {
    // Acquire UI mutex — cho den khi task truoc do xong phase submit
    let releaseMutex;
    const mutexAcquired = new Promise(resolve => { releaseMutex = resolve; });
    const prevTail = __uiInputMutexTail;
    __uiInputMutexTail = mutexAcquired;
    console.log('[Komfy] [UI-Mutex] Waiting for UI input lock...');
    await prevTail; // doi task truoc release
    console.log('[Komfy] [UI-Mutex] ✅ UI input lock acquired.');

    // Acquire CDP Session mutex — Chrome chi cho phep 1 debugger attach 1 tab cung luc
    let releaseCdpMutex;
    const cdpAcquired = new Promise(resolve => { releaseCdpMutex = resolve; });
    const prevCdpTail = __cdpSessionMutexTail;
    __cdpSessionMutexTail = cdpAcquired;
    console.log('[Komfy] [CDP-Mutex] Waiting for CDP session lock...');
    await prevCdpTail;
    console.log('[Komfy] [CDP-Mutex] ✅ CDP session lock acquired.');

    const tab = await ensureFlowTab(true, projectName);
    const tabId = tab.id;
    console.log('[Komfy] Image CDP tab:', tabId, 'aspect:', aspectRatio, 'model:', modelName, 'images:', imageInputs.length, 'prompt:', prompt.substring(0, 40));

    // Focus Chrome window + tab truoc khi bat dau automation
    // Electron co the da steal focus → can re-focus Chrome
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await new Promise(r => setTimeout(r, 500)); // cho focus settle

    await chrome.debugger.attach({ tabId }, '1.3');


    const send = (method, params) => new Promise((res, rej) => {
        chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
            if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
            else res(result);
        });
    });

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    try {
        // === Buoc 0: Thoat edit mode bang NAVIGATE truc tiep ===
        const urlCheck = await send('Runtime.evaluate', {
            expression: 'window.location.href',
            returnByValue: true,
        });
        const currentPageUrl = urlCheck?.result?.value || '';
        console.log('[Komfy] Current URL:', currentPageUrl);
        
        if (currentPageUrl.includes('/edit/')) {
            const projectUrl = currentPageUrl.replace(/\/edit\/.*$/, '');
            console.log('[Komfy] Dang o EDIT MODE! Navigate ve project:', projectUrl);
            await send('Page.navigate', { url: projectUrl });
            
            for (let w = 0; w < 15; w++) {
                await sleep(1000);
                const recheck = await send('Runtime.evaluate', {
                    expression: 'window.location.href',
                    returnByValue: true,
                });
                const newUrl = recheck?.result?.value || '';
                if (!newUrl.includes('/edit/')) {
                    console.log('[Komfy] ✅ Da thoat edit mode:', newUrl);
                    break;
                }
                if (w === 14) console.warn('[Komfy] Timeout thoat edit mode!');
            }
            await sleep(2000);
        }

        // === Buoc 1: Mo popover model selector + chon Image tab + chon model ===
        const targetModel = (modelName || 'Nano Banana 2').toLowerCase();
        console.log('[Komfy] Target model:', targetModel);

        // B1: Mo popover bang CDP mouse event THAT (khong phai JS .click())
        // Radix UI can mouse event that (mousedown/mouseup) de trigger popover
        // RETRY toi da 15s cho SPA render xong bottom bar
        let popoverOpened = false;
        for (let attempt = 0; attempt < 30 && !popoverOpened; attempt++) {
            // Buoc 1.1: Tim toa do cua bottom bar button
            const btnInfo = await send('Runtime.evaluate', {
                expression: `(function(){
                    var btns = document.querySelectorAll('button, [role="button"]');
                    for (var i = 0; i < btns.length; i++) {
                        var text = (btns[i].textContent || '').toLowerCase().trim();
                        var r = btns[i].getBoundingClientRect();
                        // Bottom bar: gan day trang, du rong, chua ten model
                        if (r.bottom > window.innerHeight - 120 && r.width > 50 && r.height > 0 &&
                            (text.includes('banana') || text.includes('imagen') || text.includes('gemini') ||
                             text.includes('veo') || text.includes('video') || /x[1-4]/.test(text))) {
                            return {
                                found: true,
                                x: Math.round(r.left + r.width / 2),
                                y: Math.round(r.top + r.height / 2),
                                text: text.substring(0, 60),
                                rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), width: Math.round(r.width) }
                            };
                        }
                    }
                    // Fallback: tim bat ky button nao o bottom bar
                    var fallback = [];
                    for (var i = 0; i < btns.length; i++) {
                        var r = btns[i].getBoundingClientRect();
                        if (r.bottom > window.innerHeight - 120 && r.width > 50 && r.height > 0) {
                            fallback.push({ text: (btns[i].textContent || '').trim().substring(0, 40), w: Math.round(r.width), bottom: Math.round(r.bottom) });
                        }
                    }
                    return { found: false, fallbackButtons: fallback.slice(0, 5), innerHeight: window.innerHeight };
                })()`,
                returnByValue: true,
            });

            const btn = btnInfo?.result?.value;
            if (!btn?.found) {
                if (attempt % 6 === 0) {
                    console.log('[Komfy] B1 Popover btn not ready, retry', attempt,
                        '| innerH:', btn?.innerHeight,
                        '| fallback:', JSON.stringify(btn?.fallbackButtons));
                }
                await sleep(500);
                continue;
            }

            console.log('[Komfy] B1 Found model btn at', btn.x, btn.y, '| text:', btn.text, '| rect:', JSON.stringify(btn.rect));

            // Buoc 1.2: Dispatch REAL mouse events qua CDP (khong phai JS .click())
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
            await sleep(80);
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
            await sleep(600); // Cho Radix animation

            // Buoc 1.3: Verify popover da mo (check DOM)
            const popoverCheck = await send('Runtime.evaluate', {
                expression: `(function(){
                    var popover = document.querySelector('[data-radix-popper-content-wrapper]');
                    if (popover) {
                        var r = popover.getBoundingClientRect();
                        return { opened: true, w: Math.round(r.width), h: Math.round(r.height) };
                    }
                    // Fallback: kiem tra co tab Image/Video khong (sign of popover open)
                    var tabs = document.querySelectorAll('[role="tab"]');
                    var tabTexts = [];
                    for (var i = 0; i < tabs.length; i++) {
                        var t = (tabs[i].textContent || '').toLowerCase().trim();
                        if (t.includes('image') || t.includes('video') || t.includes('hình')) tabTexts.push(t);
                    }
                    return { opened: tabTexts.length > 0, tabsFound: tabTexts, noRadixWrapper: true };
                })()`,
                returnByValue: true,
            });
            const popoverStatus = popoverCheck?.result?.value;
            popoverOpened = !!popoverStatus?.opened;

            if (popoverOpened) {
                console.log('[Komfy] B1 ✅ Popover opened:', JSON.stringify(popoverStatus));
            } else {
                console.log('[Komfy] B1 Popover NOT confirmed, retry', attempt, '| status:', JSON.stringify(popoverStatus));
                await sleep(300);
            }
        }
        if (!popoverOpened) {
            console.warn('[Komfy] ⚠️ Popover failed to open after 15s! Proceeding anyway...');
        }
        await sleep(400);



        // B2: Click tab "Image" trong popover bang CDP mouse event THAT
        // Tuong tu B1/B6: JS tim element, lay toa do → CDP dispatch mouse event
        {
            const imgTabInfo = await send('Runtime.evaluate', {
                expression: `(function(){
                    // Uu tien: tim theo ID suffix "-trigger-IMAGE" (Radix tab chac chan nhat)
                    var byId = document.querySelector('[id$="-trigger-IMAGE"]');
                    if (byId) {
                        var r = byId.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                            // Kiem tra xem da duoc chon chua
                            var isSelected = byId.getAttribute('aria-selected') === 'true';
                            return { found: true, method: 'id-suffix', id: byId.id,
                                x: r.left + r.width/2, y: r.top + r.height/2,
                                alreadySelected: isSelected };
                        }
                    }
                    // Fallback: tim theo text "image" trong role=tab
                    var tabs = document.querySelectorAll('[role="tab"]');
                    for (var i = 0; i < tabs.length; i++) {
                        var text = (tabs[i].textContent || '').toLowerCase().trim();
                        var r = tabs[i].getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        if (text === 'image' || text === 'hình ảnh' || text === 'images') {
                            var isSelected = tabs[i].getAttribute('aria-selected') === 'true';
                            return { found: true, method: 'text', text: text, id: tabs[i].id,
                                x: r.left + r.width/2, y: r.top + r.height/2,
                                alreadySelected: isSelected };
                        }
                    }
                    // Debug: liet ke tat ca tabs
                    var allTabs = Array.from(tabs).filter(function(t){ return t.getBoundingClientRect().width > 0; })
                        .map(function(t){ return { id: t.id, text: (t.textContent||'').trim().substring(0,20) }; });
                    return { found: false, allTabs: allTabs };
                })()`,
                returnByValue: true,
            });
            const imgTab = imgTabInfo?.result?.value;
            console.log('[Komfy] B2 Image tab info:', JSON.stringify(imgTab));

            if (imgTab?.found) {
                if (imgTab.alreadySelected) {
                    console.log('[Komfy] B2 Image tab already selected ✅');
                } else {
                    // CDP mouse event that - khong JS .click()
                    await send('Input.dispatchMouseEvent', {
                        type: 'mousePressed', x: imgTab.x, y: imgTab.y, button: 'left', clickCount: 1
                    });
                    await sleep(60);
                    await send('Input.dispatchMouseEvent', {
                        type: 'mouseReleased', x: imgTab.x, y: imgTab.y, button: 'left', clickCount: 1
                    });
                    await sleep(400);
                    console.log('[Komfy] B2 ✅ Image tab clicked via CDP:', imgTab.method, '| id:', imgTab.id);
                }
            } else {
                console.warn('[Komfy] B2 ⚠️ Image tab NOT found! allTabs:', JSON.stringify(imgTab?.allTabs));
            }
        }
        await sleep(300);





        // B3: Tim va doc model hien tai tu dropdown trong popover
        // Dropdown co icon ▼ (arrow_drop_down material icon) va ten model nhu "🍌 Nano Banana 2"
        const currentModelCheck = await send('Runtime.evaluate', {
            expression: `(function(){
                // Tim popover content wrapper
                var popover = document.querySelector('[data-radix-popper-content-wrapper]');
                var scope = popover || document;
                // Tim button co icon dropdown (arrow_drop_down) trong popover
                var btns = scope.querySelectorAll('button');
                for (var i = 0; i < btns.length; i++) {
                    var text = (btns[i].textContent || '').trim();
                    var r = btns[i].getBoundingClientRect();
                    // Model dropdown: visible, co chieu rong lon, co ten model
                    if (r.width > 100 && r.height > 20 && r.height < 60 && r.bottom < window.innerHeight - 80) {
                        var lc = text.toLowerCase();
                        if (lc.includes('banana') || lc.includes('imagen') || lc.includes('gemini') || lc.includes('veo')) {
                            // Loc bo icon text (arrow_drop_down, emoji)
                            var clean = text.replace(/arrow_drop_down/g, '').replace(/[^a-zA-Z0-9 .]/g, '').trim().toLowerCase();
                            return { currentModel: clean, rawText: text.substring(0, 60) };
                        }
                    }
                }
                return { currentModel: 'unknown' };
            })()`,
            returnByValue: true,
        });
        const currentModel = currentModelCheck?.result?.value?.currentModel || 'unknown';
        console.log('[Komfy] Current model:', currentModel, '| raw:', currentModelCheck?.result?.value?.rawText, '| target:', targetModel);

        // B4: LUON chon lai model tu node setting - khong skip du dang dung model nao
        // Tranh truong hop Flow nho lai model cu (VD: Pro) khi node dang la Banana 2
        console.log('[Komfy] Force re-select model:', targetModel, '(current:', currentModel + ')');
        {
            // B4a: Mo model dropdown bang CDP mouse event
            const dropdownInfo = await send('Runtime.evaluate', {
                expression: `(function(){
                    var btns = document.querySelectorAll('button');
                    // Uu tien: nut co icon arrow_drop_down + ten model
                    for (var i = 0; i < btns.length; i++) {
                        var text = (btns[i].textContent || '').trim();
                        var r = btns[i].getBoundingClientRect();
                        if (r.width < 60 || r.height < 20) continue;
                        var lc = text.toLowerCase();
                        if (text.includes('arrow_drop_down') && (lc.includes('banana') || lc.includes('imagen') || lc.includes('gemini') || lc.includes('veo'))) {
                            return { found: true, method: 'arrow_icon', text: text.substring(0, 50),
                                x: r.left + r.width/2, y: r.top + r.height/2 };
                        }
                    }
                    // Fallback: chi can chua ten model
                    for (var i = 0; i < btns.length; i++) {
                        var text = (btns[i].textContent || '').trim();
                        var r = btns[i].getBoundingClientRect();
                        if (r.width < 80 || r.height < 20 || r.height > 70) continue;
                        var lc = text.toLowerCase().replace(/arrow_drop_down/g,'').trim();
                        if (lc.includes('banana') || lc.includes('imagen') || lc.includes('gemini') || lc.includes('veo')) {
                            return { found: true, method: 'model_name', text: text.substring(0, 50),
                                x: r.left + r.width/2, y: r.top + r.height/2 };
                        }
                    }
                    return { found: false };
                })()`,
                returnByValue: true,
            });
            const dropdown = dropdownInfo?.result?.value;
            console.log('[Komfy] B4a Model dropdown info:', JSON.stringify(dropdown));
            if (dropdown?.found) {
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dropdown.x, y: dropdown.y, button: 'left', clickCount: 1 });
                await sleep(60);
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dropdown.x, y: dropdown.y, button: 'left', clickCount: 1 });
                console.log('[Komfy] B4a ✅ Model dropdown opened via CDP');
            } else {
                console.warn('[Komfy] B4a ⚠️ Model dropdown NOT found!');
            }
            await sleep(500);

            // B4b: Chon model tu menu bang CDP mouse event
            const modelItemInfo = await send('Runtime.evaluate', {
                expression: `(function(){
                    var target = '${targetModel}';
                    var selectors = ['[role="menuitem"]', '[role="option"]', '[role="listbox"] > *', '[data-radix-collection-item]'];
                    var allItems = [];
                    for (var s = 0; s < selectors.length; s++) {
                        var items = document.querySelectorAll(selectors[s]);
                        for (var i = 0; i < items.length; i++) allItems.push(items[i]);
                    }
                    var seen = new Set();
                    allItems = allItems.filter(function(el) { if (seen.has(el)) return false; seen.add(el); return true; });
                    for (var i = 0; i < allItems.length; i++) {
                        var text = (allItems[i].textContent || '').toLowerCase().trim();
                        var r = allItems[i].getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        if (text.includes(target)) {
                            return { found: true, text: text.substring(0, 40),
                                x: r.left + r.width/2, y: r.top + r.height/2 };
                        }
                    }
                    // Fallback: broad search
                    var all = document.querySelectorAll('div, button, span, li');
                    for (var i = 0; i < all.length; i++) {
                        var text = (all[i].textContent || '').toLowerCase().trim();
                        var r = all[i].getBoundingClientRect();
                        if (r.width === 0 || r.height === 0 || text.length > 60 || r.height > 60) continue;
                        if (text.includes(target)) {
                            return { found: true, method: 'fallback', text: text.substring(0, 40),
                                x: r.left + r.width/2, y: r.top + r.height/2 };
                        }
                    }
                    return { found: false, target: target };
                })()`,
                returnByValue: true,
            });
            const modelItem = modelItemInfo?.result?.value;
            console.log('[Komfy] B4b Model item info:', JSON.stringify(modelItem));
            if (modelItem?.found) {
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: modelItem.x, y: modelItem.y, button: 'left', clickCount: 1 });
                await sleep(60);
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: modelItem.x, y: modelItem.y, button: 'left', clickCount: 1 });
                console.log('[Komfy] B4b ✅ Model selected via CDP:', modelItem.text);
            } else {
                console.warn('[Komfy] B4b ⚠️ Model item NOT found! target:', targetModel);
            }
            await sleep(500);
        }


        // === GIAI DOAN 1: CAU HINH SETTINGS TRONG POPOVER ===
        // Thu tu: Mo popover → Image tab → Chon model → Sample count x1 → Orientation → Dong popover
        // Tat ca settings duoc thiet lap TRUOC khi cham vao textbox hay enter bat ky gi

        // B4.5: REOPEN POPOVER neu bi dong sau khi chon model
        // Sau khi chon model tu dropdown, popover co the da dong → can mo lai de set sample count va orientation
        {
            const reopenCheck = await send('Runtime.evaluate', {
                expression: `(function(){
                    // Kiem tra popover con mo khong - dung class flow_tab_slider_trigger
                    var sliderTabs = document.querySelectorAll('.flow_tab_slider_trigger');
                    var hasSampleTabs = sliderTabs.length > 0;
                    // Also check orientation via id
                    var tabs = document.querySelectorAll('[role="tab"]');
                    var hasOrientationTabs = false;
                    for (var i = 0; i < tabs.length; i++) {
                        var tid = (tabs[i].id || '').toUpperCase();
                        var t = (tabs[i].textContent || '').trim().toLowerCase();
                        if (tid.includes('PORTRAIT') || tid.includes('LANDSCAPE') ||
                            t === 'portrait' || t === 'landscape') hasOrientationTabs = true;
                    }
                    return { popoverOpen: hasSampleTabs || hasOrientationTabs, hasSampleTabs, hasOrientationTabs,
                             sliderCount: sliderTabs.length };
                })()`,
                returnByValue: true,
            });
            const reopenStatus = reopenCheck?.result?.value;
            console.log('[Komfy] B4.5 Popover status after model select:', JSON.stringify(reopenStatus));

            if (!reopenStatus?.popoverOpen) {
                console.log('[Komfy] B4.5 Popover closed after model select → REOPEN via CDP mouse event');
                // Tim va click lai bottom bar button de mo popover
                let reopened = false;
                for (let ra = 0; ra < 6 && !reopened; ra++) {
                    const btnInfo2 = await send('Runtime.evaluate', {
                        expression: `(function(){
                            var btns = document.querySelectorAll('button, [role="button"]');
                            for (var i = 0; i < btns.length; i++) {
                                var text = (btns[i].textContent || '').toLowerCase().trim();
                                var r = btns[i].getBoundingClientRect();
                                if (r.bottom > window.innerHeight - 120 && r.width > 50 && r.height > 0 &&
                                    (text.includes('banana') || text.includes('imagen') || text.includes('gemini') ||
                                     text.includes('veo') || /x[1-4]/.test(text))) {
                                    return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), text: text.substring(0, 40) };
                                }
                            }
                            return { found: false };
                        })()`,
                        returnByValue: true,
                    });
                    const btn2 = btnInfo2?.result?.value;
                    if (btn2?.found) {
                        console.log('[Komfy] B4.5 Reopen btn at', btn2.x, btn2.y, '| text:', btn2.text);
                        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn2.x, y: btn2.y, button: 'left', clickCount: 1 });
                        await sleep(80);
                        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn2.x, y: btn2.y, button: 'left', clickCount: 1 });
                        await sleep(700);
                        // Verify lai
                        const verifyReopen = await send('Runtime.evaluate', {
                            expression: `(function(){
                                var tabs = document.querySelectorAll('[role="tab"]');
                                var found = [];
                                for (var i = 0; i < tabs.length; i++) {
                                    var t = (tabs[i].textContent || '').trim();
                                    found.push(t);
                                }
                                return { tabs: found.slice(0, 10) };
                            })()`,
                            returnByValue: true,
                        });
                        const tabs = verifyReopen?.result?.value?.tabs || [];
                        reopened = tabs.some(t => /^x[1-4]$/.test(t) || t.toLowerCase() === 'portrait' || t.toLowerCase() === 'landscape');
                        console.log('[Komfy] B4.5 Reopen verify tabs:', JSON.stringify(tabs), '| reopened:', reopened);
                    } else {
                        console.log('[Komfy] B4.5 No bottom btn found, retry', ra);
                        await sleep(500);
                    }
                }
                if (!reopened) console.warn('[Komfy] B4.5 ⚠️ Could not reopen popover!');
            } else {
                console.log('[Komfy] B4.5 Popover still open ✅ hasSample:', reopenStatus.hasSampleTabs, 'hasOrientation:', reopenStatus.hasOrientationTabs);
            }
        }
        await sleep(300);

        // B5: Reset sample count ve x1 (dung class 'flow_tab_slider_trigger' de loc chinh xac)
        // x1/x2/x3/x4 tabs trong Flow UI dung class nay, tranh nham voi Video/Image/Orientation tabs
        {
            let x1Done = false;
            for (let x1Retry = 0; x1Retry < 3 && !x1Done; x1Retry++) {
                const x1TabInfo = await send('Runtime.evaluate', {
                    expression: `(function(){
                        // Loc chinh xac bang class 'flow_tab_slider_trigger' (chi x1/x2/x3/x4)
                        var sliderTabs = document.querySelectorAll('.flow_tab_slider_trigger');
                        if (sliderTabs.length === 0) {
                            // Fallback: tat ca role=tab
                            sliderTabs = document.querySelectorAll('[role="tab"]');
                        }
                        for (var i = 0; i < sliderTabs.length; i++) {
                            var text = (sliderTabs[i].textContent || '').trim();
                            var r = sliderTabs[i].getBoundingClientRect();
                            if (r.width === 0 || r.height === 0) continue;
                            if (text === 'x1') {
                                return {
                                    found: true,
                                    x: r.left + r.width / 2,
                                    y: r.top + r.height / 2,
                                    selected: sliderTabs[i].getAttribute('aria-selected') === 'true',
                                    dataState: sliderTabs[i].getAttribute('data-state')
                                };
                            }
                        }
                        // Debug: list tat ca slider tabs tim duoc
                        var debug = [];
                        for (var i = 0; i < sliderTabs.length; i++) {
                            var r = sliderTabs[i].getBoundingClientRect();
                            if (r.width > 0) debug.push((sliderTabs[i].textContent||'').trim().substring(0, 10));
                        }
                        return { found: false, debug: debug };
                    })()`,
                    returnByValue: true,
                });
                const x1Tab = x1TabInfo?.result?.value;
                console.log('[Komfy] B5 x1 attempt', x1Retry, ':', JSON.stringify(x1Tab));

                if (x1Tab?.found) {
                    if (x1Tab.selected || x1Tab.dataState === 'active') {
                        console.log('[Komfy] B5 ✅ x1 already selected');
                        x1Done = true;
                    } else {
                        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1Tab.x, y: x1Tab.y, button: 'left', clickCount: 1 });
                        await sleep(60);
                        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1Tab.x, y: x1Tab.y, button: 'left', clickCount: 1 });
                        await sleep(300);
                        console.log('[Komfy] B5 ✅ x1 clicked at', Math.round(x1Tab.x), Math.round(x1Tab.y));
                        x1Done = true;
                    }
                } else {
                    console.warn('[Komfy] B5 x1 not found (attempt ' + x1Retry + '), debug:', JSON.stringify(x1Tab?.debug));
                    await sleep(500);
                }
            }
        }
        await sleep(200);





        // B6: Select Aspect Ratio pill (16:9, 4:3, 1:1, 3:4, 9:16)
        // Flow UI uses pill buttons with text matching the ratio
        const targetAspectRatio = aspectRatio || '16:9';
        console.log('[Komfy] B6 Target aspect ratio:', targetAspectRatio);

        const aspectBtnInfo = await send('Runtime.evaluate', {
            expression: `(function(){
                var target = '${targetAspectRatio}';
                // Flow UI pills are [role="tab"] elements — textContent includes icon + ratio text
                // e.g. "⬜ 16:9" so we use includes() instead of exact match
                var allTabs = document.querySelectorAll('[role="tab"]');
                for (var i = 0; i < allTabs.length; i++) {
                    var t = (allTabs[i].textContent || '').trim();
                    var r = allTabs[i].getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    if (t === target || t.includes(target)) {
                        return {
                            found: true, method: 'text-match',
                            id: allTabs[i].id, text: t,
                            x: r.left + r.width / 2,
                            y: r.top + r.height / 2
                        };
                    }
                }
                // Fallback: match by ID containing the ratio string (e.g. "16:9" -> "16-9")
                var ratioId = target.replace(':', '-');
                for (var i = 0; i < allTabs.length; i++) {
                    var elId = (allTabs[i].id || '');
                    var r = allTabs[i].getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    if (elId.includes(ratioId) || elId.includes(target)) {
                        return {
                            found: true, method: 'id-match',
                            id: allTabs[i].id,
                            x: r.left + r.width / 2,
                            y: r.top + r.height / 2
                        };
                    }
                }
                var debugTabs = [];
                for (var i = 0; i < allTabs.length; i++) {
                    var r = allTabs[i].getBoundingClientRect();
                    if (r.width > 0) debugTabs.push({ id: allTabs[i].id, text: (allTabs[i].textContent||'').trim().substring(0,30), selected: allTabs[i].getAttribute('aria-selected') });
                }
                return { found: false, target: target, debugTabs: debugTabs };
            })()`,
            returnByValue: true,
        });

        const aspectBtn = aspectBtnInfo?.result?.value;
        console.log('[Komfy] B6 Aspect ratio btn:', JSON.stringify(aspectBtn));

        if (aspectBtn?.found) {
            await send('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: aspectBtn.x, y: aspectBtn.y, button: 'left', clickCount: 1
            });
            await sleep(60);
            await send('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: aspectBtn.x, y: aspectBtn.y, button: 'left', clickCount: 1
            });
            await sleep(300);
            console.log('[Komfy] B6 ✅ Aspect ratio clicked:', aspectBtn.method, aspectBtn.text || aspectBtn.id);
        } else {
            console.warn('[Komfy] B6 ⚠️ Aspect ratio pill NOT found! debugTabs:', JSON.stringify(aspectBtn?.debugTabs));
        }

        // B6b: Select Image Type subtype (Ingredients / Frames)
        // Vietnamese: "Ingredients" = "Thành phần", "Frames" = "Khung hình"
        const targetImageType = imageType || 'Ingredients';
        const imageTypeVariants = {
            'ingredients': ['ingredients', 'thành phần'],
            'frames': ['frames', 'khung hình'],
        };
        const typeMatchTexts = imageTypeVariants[targetImageType.toLowerCase()] || [targetImageType.toLowerCase()];
        console.log('[Komfy] B6b Target image type:', targetImageType, '| matchTexts:', JSON.stringify(typeMatchTexts));

        const typeBtnInfo = await send('Runtime.evaluate', {
            expression: `(function(){
                var matchTexts = ${JSON.stringify(typeMatchTexts)};
                var allTabs = document.querySelectorAll('[role="tab"]');
                for (var i = 0; i < allTabs.length; i++) {
                    var t = (allTabs[i].textContent || '').trim().toLowerCase();
                    var r = allTabs[i].getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    for (var m = 0; m < matchTexts.length; m++) {
                        if (t === matchTexts[m] || t.includes(matchTexts[m])) {
                            return {
                                found: true, method: 'text-match',
                                id: allTabs[i].id, text: (allTabs[i].textContent||'').trim(),
                                x: r.left + r.width / 2,
                                y: r.top + r.height / 2
                            };
                        }
                    }
                }
                return { found: false, target: matchTexts[0] };
            })()`,
            returnByValue: true,
        });

        const typeBtn = typeBtnInfo?.result?.value;
        console.log('[Komfy] B6b Image type btn:', JSON.stringify(typeBtn));

        if (typeBtn?.found) {
            await send('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: typeBtn.x, y: typeBtn.y, button: 'left', clickCount: 1
            });
            await sleep(60);
            await send('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: typeBtn.x, y: typeBtn.y, button: 'left', clickCount: 1
            });
            await sleep(300);
            console.log('[Komfy] B6b ✅ Image type clicked:', typeBtn.text);
        } else {
            console.warn('[Komfy] B6b ⚠️ Image type pill NOT found for:', targetImageType);
        }

        // B7: DONG POPOVER - chi dung Escape key
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
        await sleep(400);
        console.log('[Komfy] B7 Popover closed. Settings: model=' + targetModel + ' aspect=' + targetAspectRatio + ' type=' + targetImageType);

        // Safety check: dam bao khong bi vao edit mode sau khi dong popover
        const postMenuUrl = await send('Runtime.evaluate', {
            expression: 'window.location.href',
            returnByValue: true,
        });
        if ((postMenuUrl?.result?.value || '').includes('/edit/')) {
            const projectUrl = (postMenuUrl.result.value).replace(/\/edit\/.*$/, '');
            console.log('[Komfy] Bi vao edit mode sau dong popover! Navigate lai:', projectUrl);
            await send('Page.navigate', { url: projectUrl });
            await sleep(3000);
        }

        // === GIAI DOAN 2: NHAP DATA VA SUBMIT ===
        // Thu tu: Close modals → Setup interceptor → Focus textbox → Nhap prompt → Paste anh → Click submit

        // === BUOC 0: DONG MO MODAL NAO DANG MO (PHONG THU) ===
        // Truoc khi lam bat cu gi trong Giai doan 2, dam bao khong co dialog/modal/picker nao mo
        {
            const modalCheck = await send('Runtime.evaluate', {
                expression: `(function(){
                    // Kiem tra co modal/dialog/asset-picker nao dang mo khong
                    var dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
                    var visibleDialogs = [];
                    for (var i = 0; i < dialogs.length; i++) {
                        var r = dialogs[i].getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                            visibleDialogs.push({ tag: dialogs[i].tagName, class: (dialogs[i].className||'').substring(0,40) });
                        }
                    }
                    // Kiem tra asset picker (Google Flow specific)
                    var assetSearch = document.querySelector('[placeholder="Search for Assets"]') ||
                                     document.querySelector('[data-testid="asset-picker"]');
                    return { dialogs: visibleDialogs.length, assetPickerOpen: !!assetSearch };
                })()`,
                returnByValue: true,
            });
            const modalStatus = modalCheck?.result?.value;
            console.log('[Komfy] Buoc 0: Modal check before phase2:', JSON.stringify(modalStatus));

            if (modalStatus?.dialogs > 0 || modalStatus?.assetPickerOpen) {
                console.log('[Komfy] Buoc 0: ⚠️ Modal detected! Closing with Escape...');
                await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
                await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
                await sleep(300);
                // Second Escape for nested modals
                await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
                await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
                await sleep(500);
            } else {
                console.log('[Komfy] Buoc 0: No modals open ✅');
            }
        }


        // Buoc 2a: Setup fetch interceptor truoc khi nhap bat cu gi
        // SUA V4: Dung UNIQUE slot ID per task (requestId + timestamp)
        // BUG V3: Nhieu task co CUNG requestId (vd task_1774001) → imgResultMap[key]
        //         bi ghi de, pendingSlots chua nhieu entry cung key → nham ket qua.
        // FIX V4: Moi task tao slotId rieng = requestId + '_' + timestamp
        //         Dam bao FIFO queue va result map khong bao gio bi trung key.
        const imgSlotId = (requestId || 'img') + '_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        await send('Runtime.evaluate', {
            expression: `(function(rid) {
                window.__komfy_imgResultMap__ = window.__komfy_imgResultMap__ || {};
                window.__komfy_imgResultMap__[rid] = null;
                // FIFO queue: moi task push UNIQUE slotId vao cuoi hang doi
                window.__komfy_pendingSlots__ = window.__komfy_pendingSlots__ || [];
                window.__komfy_pendingSlots__.push(rid);
                // Dung __komfy_imgInterceptV2__ (tranh flag cu tu session truoc)
                if (!window.__komfy_imgInterceptV2__) {
                    window.__komfy_imgInterceptV2__ = true;
                    const origFetch = window.fetch;
                    window.fetch = async function(...args) {
                        const url = typeof args[0]==='string'?args[0]:(args[0]?.url||'');
                        const res = await origFetch.apply(this, args);
                        if (url.includes('batchGenerateImages')) {
                            try {
                                var slots = window.__komfy_pendingSlots__;
                                window.__komfy_imgResultMap__ = window.__komfy_imgResultMap__ || {};
                                // ★ FIX: Capture ca error response (HTTP error hoac API error)
                                // Neu khong capture error → slot khong bao gio duoc shift()
                                // → tat ca task sau bi block (FIFO queue ket)
                                if (!res.ok) {
                                    // HTTP error (4xx, 5xx)
                                    if (slots && slots.length > 0) {
                                        var slot = slots.shift();
                                        window.__komfy_imgResultMap__[slot] = { error: { message: 'HTTP ' + res.status + ' ' + res.statusText, status: res.status } };
                                    }
                                    console.log('[Komfy Fetch] batchGenerateImages HTTP error:', res.status);
                                } else {
                                    const d = await res.clone().json();
                                    // FIFO: lay slot DAU TIEN trong hang doi
                                    if (slots && slots.length > 0) {
                                        var slot = slots.shift();
                                        window.__komfy_imgResultMap__[slot] = d;
                                    }
                                }
                            } catch(e){
                                // Parse error — still shift slot de khong block queue
                                var slots2 = window.__komfy_pendingSlots__;
                                if (slots2 && slots2.length > 0) {
                                    var slot2 = slots2.shift();
                                    window.__komfy_imgResultMap__ = window.__komfy_imgResultMap__ || {};
                                    window.__komfy_imgResultMap__[slot2] = { error: { message: 'Parse error: ' + e.message } };
                                }
                            }
                        }
                        return res;
                    };
                }
            })(${JSON.stringify(imgSlotId)})`,
            awaitPromise: false,
        });
        console.log('[Komfy] Buoc 2a: Fetch interceptor V4 FIFO setup done (slot:', imgSlotId.substring(0,25), ')');

        // === Buoc 3: Paste anh truoc, roi type text, roi generate ===
        const preTypeUrl = await send('Runtime.evaluate', {
            expression: `({url: window.location.href, placeholder: (document.querySelector('[role="textbox"]')?.getAttribute('data-placeholder') || '')})`,
            returnByValue: true,
        });
        const preTypeInfo = preTypeUrl?.result?.value || {};
        console.log('[Komfy] Pre-type check - URL:', (preTypeInfo.url || '').substring(0, 80), '| placeholder:', preTypeInfo.placeholder);
        if ((preTypeInfo.url || '').includes('/edit/')) {
            const projUrl = preTypeInfo.url.replace(/\/edit\/.*$/, '');
            console.log('[Komfy] WARN: Van o edit mode truoc khi type! Force navigate:', projUrl);
            await send('Page.navigate', { url: projUrl });
            await sleep(3000);
        }

        // Buoc 2b: Focus textbox (retry toi da 10 lan)
        let tbInfo = null;
        for (let retry = 0; retry < 10; retry++) {
            const urlCheck = await send('Runtime.evaluate', {
                expression: 'window.location.href',
                returnByValue: true,
            });
            const currentUrl = urlCheck?.result?.value || '';
            if (currentUrl.includes('/edit/')) {
                const projUrl = currentUrl.replace(/\/edit\/.*$/, '');
                console.log('[Komfy] Retry', retry, ': Dang o edit mode, navigate ve:', projUrl);
                await send('Page.navigate', { url: projUrl });
                await sleep(3000);
                continue;
            }

            const focusResult = await send('Runtime.evaluate', {
                expression: `(function(){
                    const tb=document.querySelector('[role="textbox"],[contenteditable="true"]');
                    if(!tb)return null;
                    tb.focus(); // Chi focus, KHONG click - tranh mo asset modal
                    return{found:true};
                })()`,
                returnByValue: true, awaitPromise: false,
            });
            tbInfo = focusResult && focusResult.result && focusResult.result.value;
            if (tbInfo && tbInfo.found) {
                console.log('[Komfy] Buoc 2b: Textbox focused on retry', retry);
                break;
            }
            console.log('[Komfy] Textbox not found, retry', retry, '- URL:', currentUrl.substring(0, 60));
            await sleep(2000);
        }
        if (!tbInfo || !tbInfo.found) throw new Error('Khong tim thay textbox sau 10 lan thu!');

        // KHONG CDP click vao textbox - tb.focus() trong JS la du de Input.insertText hoat dong
        // CDP click du offset sang phai van co the hit "+" button vi DOM element co the include vung do
        await sleep(300);



        // Buoc 2c: Clear textbox
        const platformRes = await send('Runtime.evaluate', {
            expression: `navigator.platform`,
            returnByValue: true,
        });
        const isMac = (platformRes?.result?.value || '').toLowerCase().includes('mac');
        const selectAllMod = isMac ? 4 : 2; // 4=Meta(Cmd), 2=Ctrl
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: selectAllMod });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: selectAllMod });
        await sleep(100);
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' });
        await sleep(500);
        console.log('[Komfy] Buoc 2c: Textbox cleared.');

        // Buoc 2d: Nhap prompt
        await send('Input.insertText', { text: prompt });
        await sleep(1000);
        console.log('[Komfy] Buoc 2d: Prompt typed:', prompt.substring(0, 40));

        // Buoc 2e: Paste anh (neu co) SAU khi da co text
        if (imageInputs && imageInputs.length > 0) {
            console.log('[Komfy] Buoc 2e: Pasting', imageInputs.length, 'reference image(s)...');
            for (let imgIdx = 0; imgIdx < imageInputs.length; imgIdx++) {
                const dataUrl = imageInputs[imgIdx];
                if (!dataUrl || !dataUrl.startsWith('data:')) continue;
                const imgBase64 = dataUrl.split(',')[1];
                if (!imgBase64) continue;
                const mimeMatch = dataUrl.match(/^data:([^;]+);/);
                const imgMime = mimeMatch ? mimeMatch[1] : 'image/png';
                const pasteResult = await send('Runtime.evaluate', {
                    expression: `(async function(){
                        try {
                            var base64 = ${JSON.stringify(imgBase64)};
                            var mime = ${JSON.stringify(imgMime)};
                            var byteChars = atob(base64);
                            var arr = new Uint8Array(byteChars.length);
                            for (var i = 0; i < byteChars.length; i++) arr[i] = byteChars.charCodeAt(i);
                            var blob = new Blob([arr], {type: mime});
                            var file = new File([blob], 'ref_${imgIdx}.' + mime.split('/')[1], {type: mime, lastModified: Date.now()});
                            var dt = new DataTransfer();
                            dt.items.add(file);
                            var textbox = document.querySelector('[role="textbox"],[contenteditable="true"]');
                            if (!textbox) return 'no textbox';
                            textbox.focus();
                            var pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
                            textbox.dispatchEvent(pasteEvent);
                            return 'pasted (size: ' + byteChars.length + ' bytes)';
                        } catch(e) { return 'error: ' + e.message; }
                    })()`,
                    returnByValue: true,
                    awaitPromise: true,
                });
                console.log('[Komfy] Image', imgIdx + 1, 'paste:', pasteResult?.result?.value);
                await sleep(2000);
            }
            console.log('[Komfy] Polling upload status for', imageInputs.length, 'image(s)...');
            const uploadOk = await waitForUploadsComplete(send, imageInputs.length, 30000);
            if (!uploadOk) {
                console.warn('[Komfy] ⚠️ Upload may not be complete — proceeding anyway');
                await sleep(3000);
            }
        }

        // Buoc 2f: Xac nhan noi dung truoc khi submit
        const finalVerify = await send('Runtime.evaluate', {
            expression: `(function(){
                var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
                if (!tb) return { text: '', imgs: 0 };
                var text = tb.textContent || '';
                var parent = tb.closest('form') || tb.parentElement?.parentElement || tb.parentElement;
                var imgs = parent ? parent.querySelectorAll('img') : [];
                return { text: text.substring(0, 60), imgs: imgs.length };
            })()`,
            returnByValue: true,
        });
        console.log('[Komfy] Buoc 2f: Final verify before submit:', JSON.stringify(finalVerify?.result?.value));

        // === Snapshot truoc khi generate ===
        const preSnap = await send('Runtime.evaluate', {
            expression: `(function(){
                var imgs = document.querySelectorAll('img[src]');
                var urls = [];
                for (var k = 0; k < imgs.length; k++) {
                    var src = imgs[k].src || '';
                    if (src.includes('storage.googleapis.com') || src.includes('ai-sandbox') || src.includes('lh3.googleusercontent.com')) urls.push(src);
                }
                return urls;
            })()`,
            returnByValue: true,
        });
        const existingImgUrls = new Set(preSnap?.result?.value || []);
        console.log('[Komfy] Pre-gen snapshot:', existingImgUrls.size, 'existing images');

        // Reset slot rieng cua task nay (KHONG reset slot cua task khac)
        await send('Runtime.evaluate', {
            expression: `(function(rid) {
                window.__komfy_imgResultMap__ = window.__komfy_imgResultMap__ || {};
                window.__komfy_imgResultMap__[rid] = null;
                window.__komfy_currentImgReqId__ = rid;
            })(${JSON.stringify(imgSlotId)})`,
            awaitPromise: false,
        });

        // Buoc 2g: Click submit button bang CDP mouse event THAT
        // Code goc (da hoat dong tot voi Banana) - KHONG thay doi
        const submitBtnInfo = await send('Runtime.evaluate', {
            expression: `(function(){
                var btns = document.querySelectorAll('button');
                var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
                var tbR = tb ? tb.getBoundingClientRect() : null;

                function isAddButton(text) {
                    var t = text.toLowerCase().trim();
                    return t.startsWith('add_2') || t.startsWith('add_circle') ||
                           t === 'add' || t === 'add create' || t === 'add_2create';
                }

                // Step 1: arrow_forward icon
                for (var i = 0; i < btns.length; i++) {
                    var text = (btns[i].textContent || '').trim();
                    var r = btns[i].getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    if (isAddButton(text)) continue;
                    if (text.includes('arrow_forward')) {
                        return { found: true, method: 'arrow_forward', text: text.substring(0, 30),
                            x: r.left + r.width / 2, y: r.top + r.height / 2 };
                    }
                }

                // Step 2: aria-label
                for (var i = 0; i < btns.length; i++) {
                    var label = (btns[i].getAttribute('aria-label') || '').toLowerCase();
                    var text = (btns[i].textContent || '').trim();
                    var r = btns[i].getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    if (isAddButton(text)) continue;
                    if (label.includes('create') || label.includes('send') ||
                        label.includes('generate') || label.includes('submit')) {
                        return { found: true, method: 'aria-label', text: text.substring(0, 30), label: label,
                            x: r.left + r.width / 2, y: r.top + r.height / 2 };
                    }
                }

                // Step 3: Proximity - phai nhat o BEN PHAI textbox, trong bottom bar
                // QUAN TRONG: r.left >= tbR.right - 10 dam bao chi lay button NGOAI textbox
                // Tranh nham voi settings/model button (nam trong textbox)
                if (tbR) {
                    var best = null, bestX = -Infinity;
                    for (var j = 0; j < btns.length; j++) {
                        var r = btns[j].getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) continue;
                        if (r.bottom < window.innerHeight - 120) continue;
                        var text = (btns[j].textContent || '').trim();
                        if (isAddButton(text)) continue;
                        if (r.left >= tbR.right - 10 && r.left > bestX) {
                            bestX = r.left;
                            best = { r: r, text: text.substring(0, 20) };
                        }
                    }
                    if (best) {
                        return { found: true, method: 'proximity-rightmost', text: best.text,
                            x: best.r.left + best.r.width / 2, y: best.r.top + best.r.height / 2 };
                    }
                }

                var debugBtns = Array.from(btns)
                    .filter(function(b){ var r = b.getBoundingClientRect(); return r.bottom > window.innerHeight - 120 && r.width > 0; })
                    .map(function(b){ var r = b.getBoundingClientRect();
                        return { text: (b.textContent||'').trim().substring(0,30), label: b.getAttribute('aria-label'),
                            x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), w: Math.round(r.width) }; });
                return { found: false, debugBtns: debugBtns };
            })()`,
            returnByValue: true,
        });

        const submitBtn = submitBtnInfo?.result?.value;
        console.log('[Komfy] Buoc 2g Submit btn info:', JSON.stringify(submitBtn));

        if (submitBtn?.found) {
            await send('Input.dispatchMouseEvent', {
                type: 'mousePressed', x: submitBtn.x, y: submitBtn.y, button: 'left', clickCount: 1
            });
            await sleep(80);
            await send('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: submitBtn.x, y: submitBtn.y, button: 'left', clickCount: 1
            });
            console.log('[Komfy] Buoc 2g ✅ Submit clicked via CDP:', submitBtn.method, '| text:', submitBtn.text);
        } else {
            // Fallback: Enter key (goc, hoat dong tot voi Banana)
            console.warn('[Komfy] Buoc 2g ⚠️ Submit btn not found! Fallback Enter key. debugBtns:', JSON.stringify(submitBtn?.debugBtns));
            await send('Runtime.evaluate', {
                expression: `(function(){ var tb = document.querySelector('[role="textbox"]'); if(tb) tb.focus(); })()`,
                returnByValue: true,
            });
            await sleep(200);
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        }

        await sleep(1000);
        console.log('[Komfy] ✅ Generation submitted! Polling...');

        // === RELEASE UI MUTEX SAU KHI SUBMIT ===
        releaseMutex();
        releaseMutex = null;
        console.log('[Komfy] [UI-Mutex] 🔓 Mutex released after submit. Next task can start UI input.');

        // === RELEASE CDP MUTEX NGAY SAU SUBMIT ===
        // Polling + download dung chrome.scripting (khong can debugger attach)
        // → Banana ke tiep co the bat dau CDP session cua no ngay bay gio
        chrome.debugger.detach({ tabId }).catch(() => {});
        if (releaseCdpMutex) {
            releaseCdpMutex();
            releaseCdpMutex = null;
            console.log('[Komfy] [CDP-Mutex] 🔓 CDP released after submit → parallel tasks can start.');
        }

        // === Helper: scripting eval (thay the send() trong polling/download) ===
        const scriptEval = async (func, args = []) => {
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId },
                    world: 'MAIN',
                    func,
                    args,
                });
                return results?.[0]?.result;
            } catch (e) {
                console.warn('[Komfy] scriptEval error:', e.message);
                return undefined;
            }
        };

        // === Buoc 4: Poll cho ket qua ===
        let imageUrl = null;

        const PROXY_PROGRESS_URL_IMG = 'http://127.0.0.1:3120/api/internal/gen-progress';

        for (let i = 0; i < 150; i++) {  // 150 * 2s = 5 phut toi da
            await sleep(2000);

            // ★ ERROR DETECTION: Detect Flow UI errors immediately
            //   (policy violation, generation failed, blocked by safety, etc.)
            //   Thay vi cho 5 phut timeout, detect loi ngay va fail fast.
            //   Chi detect loi SPECIFIC cho task nay:
            //   1. Alert/toast tren page (scoped: chi khi ko co progress bar active)
            //   2. Error trong fetch interceptor response
            if (i >= 2) { // Cho 4s sau submit truoc khi bat dau check error (tranh false positive)
                const errorInfo = await scriptEval((rid) => {
                    // Check 1: API response co error khong (tu fetch interceptor)
                    var map = window.__komfy_imgResultMap__;
                    if (map && map[rid]) {
                        var r = map[rid];
                        // Kiem tra response co error field
                        if (r.error) return { type: 'api', msg: r.error.message || r.error.status || JSON.stringify(r.error).substring(0, 200) };
                        if (r.status === 'FAILED' || r.status === 'ERROR') return { type: 'api', msg: r.message || r.status };
                        // Kiem tra generationResults co error
                        var results = r.generationResults || r.results || [];
                        for (var j = 0; j < results.length; j++) {
                            if (results[j].error) return { type: 'api', msg: results[j].error.message || JSON.stringify(results[j].error).substring(0, 200) };
                            if (results[j].blocked || results[j].filteredReason) return { type: 'api', msg: 'Blocked: ' + (results[j].filteredReason || 'safety filter') };
                        }
                    }

                    // Check 2: Flow UI alert/toast (scoped — only count if no active progress bars)
                    var hasActiveProgress = false;
                    var styled = document.querySelectorAll('[style*="width"]');
                    for (var i = 0; i < styled.length; i++) {
                        var sw = styled[i].style.width;
                        if (!sw || sw.indexOf('%') < 0) continue;
                        var pf = parseFloat(sw);
                        if (isNaN(pf) || pf <= 1 || pf >= 100) continue;
                        var rect = styled[i].getBoundingClientRect();
                        if (rect.height > 0 && rect.height < 15 && rect.width > 10) { hasActiveProgress = true; break; }
                    }

                    // Neu van con progress bar active → co task khac dang chay → khong detect global error
                    // Chi detect khi KHONG co progress bar nao → loi nay chac chan la cua task hien tai
                    var strictKeywords = [
                        'might violate', 'violate our policies', 'generation failed',
                        'blocked by safety', 'quota exceeded', 'rate limit exceeded',
                        'unable to generate', 'failed to generate', 'content policy'
                    ];
                    var alertEls = document.querySelectorAll('[role="alert"],[aria-live="assertive"]');
                    for (var a = 0; a < alertEls.length; a++) {
                        var t = (alertEls[a].textContent || '').toLowerCase().trim();
                        if (!t || t.length < 10 || t.length > 500) continue;
                        for (var k = 0; k < strictKeywords.length; k++) {
                            if (t.includes(strictKeywords[k])) {
                                return { type: 'toast', msg: (alertEls[a].textContent || '').trim().substring(0, 200), hasActiveProgress: hasActiveProgress };
                            }
                        }
                    }
                    return null;
                }, [imgSlotId]);

                if (errorInfo) {
                    if (errorInfo.type === 'toast' && errorInfo.hasActiveProgress) {
                        if (i % 10 === 2) {
                            console.warn('[Komfy] ⚠️ Toast error detected but other tasks still running — continuing poll:', errorInfo.msg?.substring(0, 60));
                        }
                    } else {
                        console.error('[Komfy] ❌ Image generation failed:', errorInfo.type, '|', errorInfo.msg);
                        await scriptEval((rid) => {
                            if (window.__komfy_pendingSlots__) {
                                var idx = window.__komfy_pendingSlots__.indexOf(rid);
                                if (idx !== -1) window.__komfy_pendingSlots__.splice(idx, 1);
                            }
                            if (window.__komfy_imgResultMap__) delete window.__komfy_imgResultMap__[rid];
                        }, [imgSlotId]).catch(() => {});
                        throw new Error('Image generation failed: ' + (errorInfo.msg || 'Unknown error from Flow'));
                    }
                }
            }

            // ★ RECOVERY: Detect page refresh (JS context bị reset)
            // Khi Page khac (Node 2) goi chrome.tabs.reload(), __komfy_imgInterceptV2__ bi xoa.
            // Neu detect → re-setup interceptor + cho DOM load → DOM diff se tim duoc anh.
            const interceptorAlive = await scriptEval(() => window.__komfy_imgInterceptV2__ === true);
            if (!interceptorAlive) {
                console.warn('[Komfy] ⚠️ Page refresh detected! Re-setting up interceptor for recovery...');
                // Cho trang load xong truoc khi re-setup
                const pageReady = await scriptEval(() => document.readyState === 'complete');
                if (!pageReady) {
                    console.log('[Komfy] Page still loading after refresh, waiting...');
                    await sleep(3000); // Cho them
                }
                // Re-setup interceptor voi requestId nay (de bat ket qua neu API goi lai)
                try {
                    const cdpEnabled2 = await new Promise(r => chrome.debugger.attach({ tabId }, '1.3', () => r(!chrome.runtime.lastError)));
                    if (cdpEnabled2) {
                        const sendRecovery = (method, params) => new Promise((res, rej) => {
                            chrome.debugger.sendCommand({ tabId }, method, params || {}, r => {
                                if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
                                res(r);
                            });
                        });
                        await sendRecovery('Runtime.evaluate', {
                            expression: `(function(rid) {
                                window.__komfy_imgResultMap__ = window.__komfy_imgResultMap__ || {};
                                window.__komfy_imgResultMap__[rid] = null;
                                // FIFO: push requestId vao hang doi (neu chua co)
                                window.__komfy_pendingSlots__ = window.__komfy_pendingSlots__ || [];
                                if (window.__komfy_pendingSlots__.indexOf(rid) === -1) {
                                    window.__komfy_pendingSlots__.unshift(rid); // FRONT (vi task nay can ket qua truoc)
                                }
                                if (!window.__komfy_imgInterceptV2__) {
                                    window.__komfy_imgInterceptV2__ = true;
                                    const origFetch = window.fetch;
                                    window.fetch = async function(...args) {
                                        const url = typeof args[0]==='string'?args[0]:(args[0]?.url||'');
                                        const res2 = await origFetch.apply(this, args);
                                        if (url.includes('batchGenerateImages')) {
                                            try {
                                                var slots = window.__komfy_pendingSlots__;
                                                window.__komfy_imgResultMap__=window.__komfy_imgResultMap__||{};
                                                if (!res2.ok) {
                                                    if (slots && slots.length > 0) { var slot = slots.shift();
                                                        window.__komfy_imgResultMap__[slot] = { error: { message: 'HTTP ' + res2.status } }; }
                                                } else {
                                                    const d = await res2.clone().json();
                                                    if (slots && slots.length > 0) { var slot = slots.shift();
                                                        window.__komfy_imgResultMap__[slot]=d; }
                                                }
                                            } catch(e){
                                                var slots2 = window.__komfy_pendingSlots__;
                                                if (slots2 && slots2.length > 0) { var slot2 = slots2.shift();
                                                    window.__komfy_imgResultMap__=window.__komfy_imgResultMap__||{}; window.__komfy_imgResultMap__[slot2]={ error: { message: e.message } }; }
                                            }
                                        }
                                        return res2;
                                    };
                                }
                            })(${JSON.stringify(imgSlotId)})`,
                            awaitPromise: false,
                        });
                        chrome.debugger.detach({ tabId }).catch(() => {});
                        console.log('[Komfy] ✅ Interceptor re-setup after page refresh. DOM diff will pick up generated image.');
                    }
                } catch(recovErr) {
                    console.warn('[Komfy] Recovery CDP error:', recovErr.message);
                }
                // Dom diff se bat anh moi sau khi trang load xong (existingImgUrls van the hien baseline)
                await sleep(2000);
                continue; // Skip check nay, doi trang load va render hinh
            }

            // Check fetch interceptor (per-requestId slot)
            const fUrl = await scriptEval((rid) => {
                var map = window.__komfy_imgResultMap__;
                if (!map || !map[rid]) return null;
                var r = map[rid];
                var media = (r.media || (r.result && r.result.media) || []);
                for (var j = 0; j < media.length; j++) {
                    var m = media[j];
                    if (m.generatedImage && m.generatedImage.fifeUrl) return m.generatedImage.fifeUrl;
                    if (m.generatedImage && m.generatedImage.url) return m.generatedImage.url;
                    if (m.fifeUrl) return m.fifeUrl;
                    if (m.url) return m.url;
                    if (m.gcsUri) return m.gcsUri;
                }
                if (r.fifeUrl) return r.fifeUrl;
                if (r.imageUrl) return r.imageUrl;
                var str = JSON.stringify(r);
                var storageMatch = str.match(/"(https?:\/\/[^"]*(?:storage\.googleapis\.com|ai-sandbox)[^"]*)"/);
                if (storageMatch) return storageMatch[1];
                return 'RAW:' + str.substring(0, 800);
            }, [imgSlotId]);

            if (fUrl && !fUrl.startsWith('RAW:')) {
                imageUrl = fUrl;
                console.log('[Komfy] Image URL from interceptor:', imageUrl.substring(0, 80));
                fetch(PROXY_PROGRESS_URL_IMG, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId: sessionData.clientId, requestId, percent: 100, message: '' }) }).catch(() => {});
                break;
            }
            if (fUrl && fUrl.startsWith('RAW:')) {
                console.log('[Komfy] Image raw response:', fUrl.substring(0, 200));
            }

            // Fallback: scan DOM cho anh MOI
            const allImgUrls = await scriptEval(() => {
                var imgs = document.querySelectorAll('img[src]');
                var results = [];
                for (var k = 0; k < imgs.length; k++) {
                    var src = imgs[k].src || '';
                    if (src.includes('storage.googleapis.com') || src.includes('ai-sandbox') || src.includes('lh3.googleusercontent.com')) {
                        results.push(src);
                    }
                }
                return results;
            }) || [];

            const newImgs = allImgUrls.filter(u => !existingImgUrls.has(u));
            if (newImgs.length > 0) {
                imageUrl = newImgs[newImgs.length - 1];
                console.log('[Komfy] NEW image from DOM diff:', imageUrl.substring(0, 80), '(', newImgs.length, 'new)');
                fetch(PROXY_PROGRESS_URL_IMG, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ percent: 100, message: 'Image ready' }) }).catch(() => {});
                break;
            }

            // Push progress on each cycle
            try {
                const pd = await scriptEval(() => {
                    var best = 0, src = '';
                    var styled = document.querySelectorAll('[style*="width"]');
                    for (var i = 0; i < styled.length; i++) {
                        var sw = styled[i].style.width;
                        if (!sw || sw.indexOf('%') < 0) continue;
                        var pf = parseFloat(sw);
                        if (isNaN(pf) || pf <= 1 || pf > 99) continue;
                        var r = styled[i].getBoundingClientRect();
                        if (r.height < 1 || r.height > 12 || r.width < 1) continue;
                        if (pf > best) { best = pf; src = 'style-width'; }
                    }
                    if (best > 0) return { pct: Math.round(best), src: src };
                    var els = document.querySelectorAll('div, span');
                    for (var i = 0; i < els.length; i++) {
                        if (els[i].children.length > 2) continue;
                        var t = (els[i].textContent || '').trim();
                        if (t.length > 8) continue;
                        var m = t.match(/^(\d{1,2})\s*%$/);
                        if (!m) continue;
                        var p = parseInt(m[1], 10);
                        if (p < 1 || p > 99) continue;
                        var r = els[i].getBoundingClientRect();
                        if (r.width <= 0) continue;
                        if (p > best) { best = p; src = 'elem-text'; }
                    }
                    if (best > 0) return { pct: Math.round(best), src: src };
                    return null;
                });
                if (pd && typeof pd.pct === 'number') {
                    fetch(PROXY_PROGRESS_URL_IMG, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ clientId: sessionData.clientId, requestId, percent: pd.pct, message: '' }) }).catch(() => {});
                    console.log(`[Komfy] Image progress: ${pd.pct}% (src: ${pd.src})`);
                } else {
                    const elapsed = i * 2;
                    const estimated = Math.min(10 + Math.round(elapsed / 20 * 80), 90);
                    fetch(PROXY_PROGRESS_URL_IMG, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ clientId: sessionData.clientId, requestId, percent: estimated, message: '' }) }).catch(() => {});
                }
            } catch (_) { /* non-fatal */ }

            if (i % 5 === 0) console.log('[Komfy] Image polling...', i * 2, 's, existing:', existingImgUrls.size, 'current:', allImgUrls.length);
        }

        if (!imageUrl) {
            // Cleanup: xoa slot khoi pendingSlots neu van con (task that bai)
            await scriptEval((rid) => {
                if (window.__komfy_pendingSlots__) {
                    var idx = window.__komfy_pendingSlots__.indexOf(rid);
                    if (idx !== -1) window.__komfy_pendingSlots__.splice(idx, 1);
                }
            }, [imgSlotId]).catch(() => {});
            throw new Error('Timeout 5min - khong tim thay anh moi!');
        }

        // === Buoc 5: Download image VIA chrome.scripting (with retry) ===
        console.log('[Komfy] Downloading image via scripting...');
        let dlData = null;
        for (let dlRetry = 0; dlRetry < 3; dlRetry++) {
            dlData = await scriptEval(async (url) => {
                try {
                    const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
                    if (!res.ok) return { error: 'HTTP ' + res.status };
                    const blob = await res.blob();
                    const mimeType = blob.type || 'image/png';
                    const size = blob.size;
                    return await new Promise(function(resolve) {
                        var reader = new FileReader();
                        reader.onloadend = function() { resolve({ dataUrl: reader.result, mimeType: mimeType, size: size }); };
                        reader.readAsDataURL(blob);
                    });
                } catch(e) {
                    return { error: e.message };
                }
            }, [imageUrl]);
            if (dlData && dlData.dataUrl) break;
            console.warn('[Komfy] Download attempt', dlRetry + 1, 'failed:', dlData?.error, '— retrying in 3s...');
            await sleep(3000);
        }

        if (dlData && dlData.dataUrl) {
            const b64Match = dlData.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (b64Match) {
                console.log('[Komfy] ✅ Image downloaded:', (dlData.size / 1024).toFixed(1), 'KB, type:', dlData.mimeType);
                return {
                    ok: true,
                    status: 200,
                    body: JSON.stringify({
                        base64: b64Match[2],
                        mimeType: b64Match[1],
                        size: dlData.size,
                        imageUrl: imageUrl,
                    })
                };
            }
            console.log('[Komfy] ✅ Image downloaded as dataUrl, size:', dlData?.size);
            return {
                ok: true,
                status: 200,
                body: JSON.stringify({
                    dataUrl: dlData.dataUrl,
                    mimeType: dlData.mimeType,
                    size: dlData.size,
                    imageUrl: imageUrl,
                })
            };
        }

        console.warn('[Komfy] Page download failed:', dlData?.error || 'unknown');
        return {
            ok: true,
            status: 200,
            body: JSON.stringify({ imageUrl: imageUrl })
        };

    } finally {
        // === Safety: Release mutex neu chua release (loi xay ra truoc submit) ===
        if (releaseMutex) {
            releaseMutex();
            releaseMutex = null;
            console.log('[Komfy] [UI-Mutex] 🔓 Mutex released in finally (task failed before submit).');
        }
        // Safety: release CDP neu chua release (loi xay ra truoc submit)
        chrome.debugger.detach({ tabId }).catch(() => { });
        if (releaseCdpMutex) {
            releaseCdpMutex();
            releaseCdpMutex = null;
            console.log('[Komfy] [CDP-Mutex] 🔓 CDP released in finally.');
        }
    }
}

