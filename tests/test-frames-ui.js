// ============================================================
// test-frames-ui.js — Diagnostic script for Frames mode UI
// Run from extension service worker console:
//   await testFramesUI()
// ============================================================

async function testFramesUI() {
    console.log('=== [TEST] Frames UI Diagnostic ===');

    // 1. Find Flow tab
    const tabs = await chrome.tabs.query({ url: '*://labs.google/fx/*' });
    const tab = tabs.find(t => t.url.includes('/tools/flow'));
    if (!tab) { console.error('[TEST] No Flow tab found!'); return; }
    console.log('[TEST] Tab:', tab.id, tab.url);

    // 2. Attach debugger
    try { await chrome.debugger.attach({ tabId: tab.id }, '1.3'); } catch (e) {
        if (!e.message.includes('Already attached')) { console.error('[TEST] Attach failed:', e); return; }
    }
    const send = (method, params) => chrome.debugger.sendCommand({ tabId: tab.id }, method, params || {});
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    try {
        // 3. Dump current bottom bar state
        console.log('\n--- [TEST] STEP 1: Bottom bar state ---');
        const barState = await send('Runtime.evaluate', {
            expression: `(function(){
                var btns = document.querySelectorAll('button,[role="button"]');
                var bottomBar = [];
                for (var i = 0; i < btns.length; i++) {
                    var r = btns[i].getBoundingClientRect();
                    if (r.bottom > window.innerHeight - 200 && r.width > 30) {
                        bottomBar.push({
                            tag: btns[i].tagName,
                            text: (btns[i].textContent||'').trim().substring(0,50),
                            x: Math.round(r.x), y: Math.round(r.y),
                            w: Math.round(r.width), h: Math.round(r.height),
                            aria: btns[i].getAttribute('aria-label') || ''
                        });
                    }
                }
                return bottomBar;
            })()`,
            returnByValue: true,
        });
        console.log('[TEST] Bottom bar elements:', JSON.stringify(barState?.result?.value, null, 2));

        // 4. Check Frames mode: look for Start/End slots and Swap button
        console.log('\n--- [TEST] STEP 2: Frames slots detection ---');
        const framesState = await send('Runtime.evaluate', {
            expression: `(function(){
                var result = { swapBtn: false, startSlot: null, endSlot: null, allSlotDivs: [] };

                // Swap button
                var swapBtn = document.querySelector('button[aria-label="Swap first and last frames"]');
                result.swapBtn = !!swapBtn;
                if (swapBtn) {
                    var parent = swapBtn.parentElement;
                    if (parent) {
                        result.swapParentTag = parent.tagName;
                        result.swapParentChildren = parent.children.length;
                        result.swapParentChildDetails = [];
                        for (var i = 0; i < parent.children.length; i++) {
                            var ch = parent.children[i];
                            var r = ch.getBoundingClientRect();
                            result.swapParentChildDetails.push({
                                tag: ch.tagName,
                                text: (ch.textContent||'').trim().substring(0,30),
                                hasImg: !!ch.querySelector('img'),
                                w: Math.round(r.width), h: Math.round(r.height),
                                x: Math.round(r.x), y: Math.round(r.y),
                                classes: (ch.className||'').substring(0,60),
                                role: ch.getAttribute('role') || '',
                                tabindex: ch.getAttribute('tabindex') || ''
                            });
                        }
                    }
                }

                // Find all leaf divs with "Start" or "End" text in bottom half
                var allDivs = [...document.querySelectorAll('div')];
                for (var j = 0; j < allDivs.length; j++) {
                    var div = allDivs[j];
                    var dt = (div.textContent||'').trim();
                    if ((dt === 'Start' || dt === 'End') && div.children.length === 0) {
                        var dr = div.getBoundingClientRect();
                        if (dr.width > 0 && dr.top > window.innerHeight * 0.3) {
                            var info = {
                                text: dt,
                                x: Math.round(dr.x), y: Math.round(dr.y),
                                w: Math.round(dr.width), h: Math.round(dr.height),
                                parentTag: div.parentElement?.tagName || 'none',
                                parentRole: div.parentElement?.getAttribute('role') || '',
                                parentClasses: (div.parentElement?.className||'').substring(0,60),
                                gpTag: div.parentElement?.parentElement?.tagName || 'none',
                                gpClasses: (div.parentElement?.parentElement?.className||'').substring(0,60)
                            };
                            result.allSlotDivs.push(info);
                            if (dt === 'Start') result.startSlot = info;
                            if (dt === 'End') result.endSlot = info;
                        }
                    }
                }

                // Also check for slot containers that have images (filled slots)
                var slotImgs = [...document.querySelectorAll('img')].filter(function(img){
                    var r = img.getBoundingClientRect();
                    return r.width >= 20 && r.height >= 20
                        && r.top > window.innerHeight * 0.5
                        && r.left > 50 && r.left < window.innerWidth - 50;
                }).map(function(img){
                    var r = img.getBoundingClientRect();
                    return {
                        src: (img.src||'').slice(-50),
                        x: Math.round(r.x), y: Math.round(r.y),
                        w: Math.round(r.width), h: Math.round(r.height)
                    };
                });
                result.bottomHalfImgs = slotImgs;

                return result;
            })()`,
            returnByValue: true,
        });
        console.log('[TEST] Frames state:', JSON.stringify(framesState?.result?.value, null, 2));

        // 5. Test clicking Start slot
        console.log('\n--- [TEST] STEP 3: Click Start slot ---');
        const startClick = await send('Runtime.evaluate', {
            expression: `(function(){
                var targetText = 'Start';
                // Strategy 1: Swap button anchor
                var swapBtn = document.querySelector('button[aria-label="Swap first and last frames"]');
                if (swapBtn && swapBtn.parentElement) {
                    var children = swapBtn.parentElement.children;
                    for (var i = 0; i < children.length; i++) {
                        var ch = children[i];
                        var t = (ch.textContent||'').trim();
                        if (t === targetText || t.includes(targetText)) {
                            var r = ch.getBoundingClientRect();
                            if (r.width > 0) {
                                return { found: true, method: 'swap-anchor', text: t, x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), tag: ch.tagName };
                            }
                        }
                    }
                }
                // Strategy 2: Leaf div
                var allDivs = [...document.querySelectorAll('div')];
                for (var j = 0; j < allDivs.length; j++) {
                    var div = allDivs[j];
                    var dt = (div.textContent||'').trim();
                    if (dt !== targetText || div.children.length > 0) continue;
                    var dr = div.getBoundingClientRect();
                    if (dr.width === 0 || dr.top < window.innerHeight * 0.3) continue;
                    var parent = div.parentElement || div;
                    var pr = parent.getBoundingClientRect();
                    return { found: true, method: 'leaf-div', text: dt, x: Math.round(pr.x+pr.width/2), y: Math.round(pr.y+pr.height/2), tag: parent.tagName, parentClasses: (parent.className||'').substring(0,60) };
                }
                return { found: false };
            })()`,
            returnByValue: true,
        });
        const startInfo = startClick?.result?.value;
        console.log('[TEST] Start slot:', JSON.stringify(startInfo));

        if (startInfo?.found) {
            // Click via CDP mouse event
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startInfo.x, y: startInfo.y, button: 'left', clickCount: 1 });
            await sleep(60);
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startInfo.x, y: startInfo.y, button: 'left', clickCount: 1 });
            console.log('[TEST] Clicked Start at', startInfo.x, startInfo.y);

            // Wait for picker
            await sleep(2000);

            // Check picker state
            const pickerState = await send('Runtime.evaluate', {
                expression: `(function(){
                    var result = { imgs: [], panels: [], dialogs: [], overlays: [] };

                    // All visible images
                    var allImgs = [...document.querySelectorAll('img')].filter(function(img){
                        var r = img.getBoundingClientRect();
                        return r.width >= 20 && r.height >= 20 && r.top > 0 && r.top < window.innerHeight;
                    });
                    result.imgs = allImgs.map(function(img){
                        var r = img.getBoundingClientRect();
                        return { src: (img.src||'').slice(-40), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
                    });

                    // Panels/dialogs
                    var panels = document.querySelectorAll('[role="dialog"],[role="listbox"],[class*="picker"],[class*="gallery"],[class*="panel"],[class*="modal"],[class*="overlay"],[class*="sidebar"],[data-radix-popper-content-wrapper]');
                    result.panels = [...panels].map(function(p){
                        var r = p.getBoundingClientRect();
                        return { tag: p.tagName, role: p.getAttribute('role')||'', classes: (p.className||'').substring(0,60), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), visible: r.width > 0 };
                    });

                    // Search inputs (picker feature)
                    var searchInputs = document.querySelectorAll('input[type="text"],input[type="search"],input[placeholder]');
                    result.searchInputs = [...searchInputs].filter(function(i){ return i.getBoundingClientRect().width > 0; }).map(function(i){
                        return { placeholder: i.getAttribute('placeholder')||'', type: i.type, value: i.value };
                    });

                    // Buttons in top half (picker area)
                    var topBtns = [...document.querySelectorAll('button')].filter(function(b){
                        var r = b.getBoundingClientRect();
                        return r.width > 20 && r.top > 0 && r.top < window.innerHeight * 0.6;
                    }).map(function(b){
                        var r = b.getBoundingClientRect();
                        return { text: (b.textContent||'').trim().substring(0,30), x: Math.round(r.x), y: Math.round(r.y), aria: b.getAttribute('aria-label')||'' };
                    });
                    result.topButtons = topBtns.slice(0, 20);

                    return result;
                })()`,
                returnByValue: true,
            });
            console.log('[TEST] Picker state after Start click:', JSON.stringify(pickerState?.result?.value, null, 2));

            // Close picker with Escape
            console.log('[TEST] Pressing Escape to close picker...');
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
            await sleep(1000);

            // Check state AFTER Escape
            console.log('\n--- [TEST] STEP 4: State after Escape ---');
            const afterEscape = await send('Runtime.evaluate', {
                expression: `(function(){
                    var result = {};
                    // Check if Start/End text divs still exist
                    var allDivs = [...document.querySelectorAll('div')];
                    result.startDivExists = false;
                    result.endDivExists = false;
                    for (var j = 0; j < allDivs.length; j++) {
                        var div = allDivs[j];
                        var dt = (div.textContent||'').trim();
                        if (div.children.length > 0) continue;
                        var dr = div.getBoundingClientRect();
                        if (dr.width === 0 || dr.top < window.innerHeight * 0.3) continue;
                        if (dt === 'Start') result.startDivExists = true;
                        if (dt === 'End') result.endDivExists = true;
                    }

                    // Check swap button still exists
                    result.swapBtnExists = !!document.querySelector('button[aria-label="Swap first and last frames"]');

                    // Check bottom bar
                    var btns = document.querySelectorAll('button,[role="button"]');
                    var bottomBar = [];
                    for (var i = 0; i < btns.length; i++) {
                        var r = btns[i].getBoundingClientRect();
                        if (r.bottom > window.innerHeight - 200 && r.width > 30) {
                            bottomBar.push((btns[i].textContent||'').trim().substring(0,50));
                        }
                    }
                    result.bottomBar = bottomBar;

                    // Check all role=tab
                    var tabs = document.querySelectorAll('[role="tab"]');
                    result.visibleTabs = [...tabs].filter(function(t){ return t.getBoundingClientRect().width > 0; })
                        .map(function(t){ return { text: (t.textContent||'').trim().substring(0,20), selected: t.getAttribute('aria-selected') }; });

                    return result;
                })()`,
                returnByValue: true,
            });
            console.log('[TEST] After Escape:', JSON.stringify(afterEscape?.result?.value, null, 2));
        }

        // 6. Test clicking End slot
        console.log('\n--- [TEST] STEP 5: Click End slot ---');
        const endClick = await send('Runtime.evaluate', {
            expression: `(function(){
                var targetText = 'End';
                var swapBtn = document.querySelector('button[aria-label="Swap first and last frames"]');
                if (swapBtn && swapBtn.parentElement) {
                    var children = swapBtn.parentElement.children;
                    for (var i = 0; i < children.length; i++) {
                        var ch = children[i];
                        var t = (ch.textContent||'').trim();
                        if (t === targetText || t.includes(targetText)) {
                            var r = ch.getBoundingClientRect();
                            if (r.width > 0) {
                                return { found: true, method: 'swap-anchor', text: t, x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), tag: ch.tagName, classes: (ch.className||'').substring(0,60) };
                            }
                        }
                    }
                }
                var allDivs = [...document.querySelectorAll('div')];
                for (var j = 0; j < allDivs.length; j++) {
                    var div = allDivs[j];
                    var dt = (div.textContent||'').trim();
                    if (dt !== targetText || div.children.length > 0) continue;
                    var dr = div.getBoundingClientRect();
                    if (dr.width === 0 || dr.top < window.innerHeight * 0.3) continue;
                    var parent = div.parentElement || div;
                    var pr = parent.getBoundingClientRect();
                    return { found: true, method: 'leaf-div', text: dt, x: Math.round(pr.x+pr.width/2), y: Math.round(pr.y+pr.height/2), tag: parent.tagName, parentClasses: (parent.className||'').substring(0,60) };
                }
                return { found: false };
            })()`,
            returnByValue: true,
        });
        const endInfo = endClick?.result?.value;
        console.log('[TEST] End slot:', JSON.stringify(endInfo));

        if (endInfo?.found) {
            // Try CDP mouse click
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: endInfo.x, y: endInfo.y, button: 'left', clickCount: 1 });
            await sleep(60);
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endInfo.x, y: endInfo.y, button: 'left', clickCount: 1 });
            console.log('[TEST] Clicked End at', endInfo.x, endInfo.y);

            await sleep(2000);

            // Check picker state for End
            const endPickerState = await send('Runtime.evaluate', {
                expression: `(function(){
                    var result = {};

                    // All visible images
                    var allImgs = [...document.querySelectorAll('img')].filter(function(img){
                        var r = img.getBoundingClientRect();
                        return r.width >= 20 && r.height >= 20 && r.top > 0 && r.top < window.innerHeight;
                    });
                    result.imgCount = allImgs.length;
                    result.imgs = allImgs.map(function(img){
                        var r = img.getBoundingClientRect();
                        return { src: (img.src||'').slice(-40), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
                    });

                    // Panels/dialogs
                    var panels = document.querySelectorAll('[role="dialog"],[role="listbox"],[class*="picker"],[class*="gallery"],[class*="panel"],[class*="modal"],[class*="overlay"],[class*="sidebar"],[data-radix-popper-content-wrapper]');
                    result.panelCount = panels.length;
                    result.panels = [...panels].filter(function(p){ return p.getBoundingClientRect().width > 0; }).map(function(p){
                        var r = p.getBoundingClientRect();
                        return { tag: p.tagName, role: p.getAttribute('role')||'', classes: (p.className||'').substring(0,60), w: Math.round(r.width), h: Math.round(r.height) };
                    });

                    // Check entire DOM for any new visible element
                    var newElements = [...document.querySelectorAll('*')].filter(function(el){
                        var r = el.getBoundingClientRect();
                        return r.width > 100 && r.height > 100 && r.top > 0 && r.top < window.innerHeight * 0.7
                            && el.tagName !== 'HTML' && el.tagName !== 'BODY' && el.tagName !== 'MAIN'
                            && !el.closest('[role="textbox"]');
                    }).slice(0, 10).map(function(el){
                        var r = el.getBoundingClientRect();
                        return { tag: el.tagName, id: (el.id||'').substring(0,30), classes: (el.className||'').substring(0,40), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
                    });
                    result.largeElements = newElements;

                    return result;
                })()`,
                returnByValue: true,
            });
            console.log('[TEST] Picker state after End click:', JSON.stringify(endPickerState?.result?.value, null, 2));

            // Also try: click directly on the End slot div (not parent)
            console.log('\n--- [TEST] STEP 6: Try direct JS click on End div ---');
            const directClick = await send('Runtime.evaluate', {
                expression: `(function(){
                    var allDivs = [...document.querySelectorAll('div')];
                    for (var j = 0; j < allDivs.length; j++) {
                        var div = allDivs[j];
                        var dt = (div.textContent||'').trim();
                        if (dt !== 'End' || div.children.length > 0) continue;
                        var dr = div.getBoundingClientRect();
                        if (dr.width === 0 || dr.top < window.innerHeight * 0.3) continue;

                        // Try clicking at multiple levels
                        var results = [];

                        // Click self
                        div.click();
                        results.push('clicked-self');

                        // Click parent
                        if (div.parentElement) {
                            div.parentElement.click();
                            results.push('clicked-parent:' + div.parentElement.tagName);
                        }

                        // Click grandparent
                        if (div.parentElement?.parentElement) {
                            div.parentElement.parentElement.click();
                            results.push('clicked-grandparent:' + div.parentElement.parentElement.tagName);
                        }

                        // Dispatch pointer events
                        var rect = div.parentElement ? div.parentElement.getBoundingClientRect() : dr;
                        var cx = rect.x + rect.width/2;
                        var cy = rect.y + rect.height/2;
                        ['pointerdown', 'pointerup', 'click'].forEach(function(evtType){
                            div.parentElement.dispatchEvent(new PointerEvent(evtType, {
                                bubbles: true, cancelable: true, clientX: cx, clientY: cy,
                                pointerId: 1, pointerType: 'mouse'
                            }));
                        });
                        results.push('dispatched-pointer-events');

                        return { clicked: true, methods: results, x: Math.round(cx), y: Math.round(cy) };
                    }
                    return { clicked: false };
                })()`,
                returnByValue: true,
            });
            console.log('[TEST] Direct click result:', JSON.stringify(directClick?.result?.value));

            await sleep(2000);

            // Check picker state again
            const afterDirectClick = await send('Runtime.evaluate', {
                expression: `(function(){
                    var allImgs = [...document.querySelectorAll('img')].filter(function(img){
                        var r = img.getBoundingClientRect();
                        return r.width >= 20 && r.height >= 20 && r.top > 0 && r.top < window.innerHeight;
                    });
                    var panels = [...document.querySelectorAll('[role="dialog"],[role="listbox"],[class*="picker"],[class*="gallery"],[data-radix-popper-content-wrapper]')].filter(function(p){ return p.getBoundingClientRect().width > 0; });
                    return { imgCount: allImgs.length, panelCount: panels.length };
                })()`,
                returnByValue: true,
            });
            console.log('[TEST] After direct click:', JSON.stringify(afterDirectClick?.result?.value));
        }

        console.log('\n=== [TEST] Done! ===');
    } finally {
        try { await chrome.debugger.detach({ tabId: tab.id }); } catch(e) {}
    }
}
