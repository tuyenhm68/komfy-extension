// ============================================================
// video-gen-settings.js
// Phase B0: Settings popover automation
// Bao gom: open popover, chon Video tab, subtype, orientation,
//          x1, model, dong popover, verify Video mode.
// Tat ca ham nhan (send, sleep) lam tham so — no side effects.
// ============================================================

// --- B0.1: Mo popover bang CDP + JS PointerEvent ---
async function openPopover(send, sleep) {
    let opened = false;

    const tryOnce = async () => {
        for (let attempt = 0; attempt < 10 && !opened; attempt++) {
            const btnInfo = await send('Runtime.evaluate', {
                expression: `(function(){
                    var btns = Array.from(document.querySelectorAll('button,[role="button"]'));
                    var allBottomBtns = [];
                    for (var i = 0; i < btns.length; i++) {
                        var r = btns[i].getBoundingClientRect();
                        var t = (btns[i].textContent||'').toLowerCase().trim();
                        if (r.width < 50 || r.height < 20) continue;
                        // ★ Gioi han chieu cao: bottom bar button < 80px, gallery thumbnail > 100px
                        if (r.height > 80) continue;
                        var inBottom = r.bottom > window.innerHeight - 120;
                        var inLower70 = r.top > window.innerHeight * 0.3;
                        if (!inBottom && !inLower70) continue;
                        if (t.includes('arrow_forward') || t === '>' || t.startsWith('add_2') || t.startsWith('add_circle') || t === 'add') continue;
                        if (t === 'close' || t === 'cancel' || t === '\u2715') continue;
                        if (t.includes('play_circle') || t.includes('play_arrow') || t.includes('pause') || t.includes('replay')) continue;
                        if (t.includes('extend') || t.includes('keyboard_double_arrow') || t.includes('download') || t.includes('hide history') || t.includes('show history')) continue;
                        // ★ Uu tien button co text model (bottom bar selector)
                        var hasModelText = t.includes('veo') || t.includes('banana') || t.includes('imagen') || t.includes('gemini') || t.includes('crop') || t.includes('arrow_drop_down') || /x[1-4]/.test(t);
                        allBottomBtns.push({ w: r.width, x: r.left+r.width/2, y: r.top+r.height/2, text: t.substring(0,40), inBottom, hasModelText });
                    }
                    if (!allBottomBtns.length) return { found: false };
                    // ★ Uu tien: bottom + co model text > bottom > lower70
                    var bottomModel = allBottomBtns.filter(function(b){ return b.inBottom && b.hasModelText; });
                    var bottomOnly = allBottomBtns.filter(function(b){ return b.inBottom; });
                    var pool = bottomModel.length > 0 ? bottomModel : (bottomOnly.length > 0 ? bottomOnly : allBottomBtns);
                    pool.sort(function(a,b){ return b.w - a.w; });
                    var best = pool[0];
                    return { found: true, x: best.x, y: best.y, text: best.text, totalBtns: pool.length, hasModelText: best.hasModelText };
                })()`,
                returnByValue: true,
            });
            const btn = btnInfo?.result?.value;

            if (!btn?.found) {
                if (attempt % 2 === 0) console.log('[Komfy Video] B0.1 No bottom btn found (attempt', attempt, ')');
                await sleep(300);
                continue;
            }

            console.log('[Komfy Video] B0.1 attempt', attempt, '| btns:', btn.totalBtns, '| widest:', btn.text);

            if (attempt % 2 === 0) {
                // JS PointerEvent (Radix UI responds best)
                await send('Runtime.evaluate', {
                    expression: `(function(){
                        var btns = Array.from(document.querySelectorAll('button,[role="button"]'));
                        var candidates = [];
                        for (var i = 0; i < btns.length; i++) {
                            var r = btns[i].getBoundingClientRect();
                            var t = (btns[i].textContent||'').toLowerCase().trim();
                            if (r.width < 50 || r.height < 20) continue;
                            // ★ Gioi han chieu cao: bottom bar < 80px, gallery thumbnail > 100px
                            if (r.height > 80) continue;
                            var inBottom = r.bottom > window.innerHeight - 120;
                            var inLower70 = r.top > window.innerHeight * 0.3;
                            if (!inBottom && !inLower70) continue;
                            if (t.includes('arrow_forward') || t === '>' || t.startsWith('add_2') || t.startsWith('add_circle') || t === 'add') continue;
                            if (t === 'close' || t === 'cancel' || t === '\u2715') continue;
                            if (t.includes('play_circle') || t.includes('play_arrow') || t.includes('pause') || t.includes('replay')) continue;
                            if (t.includes('extend') || t.includes('keyboard_double_arrow') || t.includes('download') || t.includes('hide history') || t.includes('show history')) continue;
                            var hasModelText = t.includes('veo') || t.includes('banana') || t.includes('imagen') || t.includes('gemini') || t.includes('crop') || t.includes('arrow_drop_down') || /x[1-4]/.test(t);
                            candidates.push({ el: btns[i], w: r.width, inBottom: inBottom, hasModelText: hasModelText });
                        }
                        // ★ Uu tien: bottom + model text > bottom > lower70
                        var bottomModel = candidates.filter(function(c){ return c.inBottom && c.hasModelText; });
                        var bottomOnly = candidates.filter(function(c){ return c.inBottom; });
                        var pool = bottomModel.length > 0 ? bottomModel : (bottomOnly.length > 0 ? bottomOnly : candidates);
                        pool.sort(function(a,b){ return b.w - a.w; });
                        var best = pool.length > 0 ? pool[0].el : null;
                        if (!best) return 'not found';
                        best.dispatchEvent(new PointerEvent('pointerover', {bubbles:true, composed:true}));
                        best.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, composed:true, isPrimary:true, button:0}));
                        best.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true, button:0}));
                        best.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, cancelable:true, composed:true, isPrimary:true, button:0}));
                        best.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, cancelable:true, button:0}));
                        best.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, button:0}));
                        return 'js-pointer: ' + (best.textContent||'').trim().substring(0,30);
                    })()`,
                    returnByValue: true,
                    awaitPromise: false,
                });
                console.log('[Komfy Video] B0.1 JS PointerEvent dispatched');
            } else {
                // CDP mouse event
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
                await sleep(60);
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
                console.log('[Komfy Video] B0.1 CDP mouseEvent at', Math.round(btn.x), Math.round(btn.y));
            }

            await sleep(600);

            const isOpen = await send('Runtime.evaluate', {
                expression: `(function(){
                    var w = document.querySelector('[data-radix-popper-content-wrapper]');
                    if (!w) return false;
                    var r = w.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                })()`,
                returnByValue: true,
            });
            if (isOpen?.result?.value) {
                opened = true;
                console.log('[Komfy Video] B0.1 ✅ Popover opened (attempt', attempt, ')');
            } else {
                console.log('[Komfy Video] B0.1 Popover not open yet (attempt', attempt, '), retry...');
                await sleep(300);
            }
        }
    };

    await tryOnce();

    if (!opened) {
        console.warn('[Komfy Video] B0.1 Popover failed → refreshing Flow tab and retrying...');
        try {
            await send('Page.reload', { ignoreCache: true });
            console.log('[Komfy Video] B0.1 Tab reloaded, waiting for page...');
            // ★ Wait for bottom bar specifically (not just any button)
            await sleep(3000); // Initial wait for page load
            let pageReady = false;
            for (let w = 0; w < 20; w++) {
                const barCheck = await send('Runtime.evaluate', {
                    expression: `(function(){
                        var btns = Array.from(document.querySelectorAll('button,[role="button"]'));
                        for (var i = 0; i < btns.length; i++) {
                            var r = btns[i].getBoundingClientRect();
                            var t = (btns[i].textContent||'').toLowerCase();
                            if (r.bottom > window.innerHeight - 120 && r.width > 50 &&
                                (t.includes('veo') || t.includes('banana') || t.includes('imagen') || t.includes('video') || t.includes('arrow_drop_down')))
                                return 'bottom-bar';
                        }
                        if (document.querySelector('[role="textbox"],[contenteditable="true"]')) return 'textbox';
                        for (var i = 0; i < btns.length; i++) {
                            var r = btns[i].getBoundingClientRect();
                            if (r.width > 50 && r.height > 20) return 'some-btn';
                        }
                        return false;
                    })()`,
                    returnByValue: true,
                });
                const val = barCheck?.result?.value;
                if (val) {
                    console.log('[Komfy Video] B0.1 Page ready after reload: ' + val + ' (' + (w * 500 + 3000) + 'ms)');
                    pageReady = true;
                    if (val === 'bottom-bar') break; // Best case — bottom bar found
                    // For textbox/some-btn, keep waiting a bit for bottom bar
                    if (w < 15) { await sleep(500); continue; }
                    break;
                }
                await sleep(500);
            }
            await sleep(1000);
            await tryOnce();
        } catch (reloadErr) {
            console.warn('[Komfy Video] B0.1 Reload error:', reloadErr.message);
        }
    }

    if (!opened) throw new Error('[Komfy Video] Khong mo duoc popover! (da thu refresh tab)');
}

// --- B0.2: Chon tab VIDEO ---
async function selectVideoTab(send, sleep) {
    const videoTabInfo = await send('Runtime.evaluate', {
        expression: `(function(){
            var scope = document.querySelector('[data-radix-popper-content-wrapper]') || document;
            var allTabs = [...scope.querySelectorAll('[role="tab"]')].map(function(t) {
                var r = t.getBoundingClientRect();
                return { id: t.id, text: (t.textContent||'').trim(), selected: t.getAttribute('aria-selected'), w: r.width, x: r.left+r.width/2, y: r.top+r.height/2 };
            });
            var byId = scope.querySelector('[id$="-trigger-VIDEO"],[id$="-trigger-video"],[id$="-trigger-Video"]');
            if (byId) {
                var r = byId.getBoundingClientRect();
                if (r.width > 0) return { found: true, method: 'id-suffix', x: r.left+r.width/2, y: r.top+r.height/2, allTabs, alreadySelected: byId.getAttribute('aria-selected') === 'true' };
            }
            for (var i = 0; i < allTabs.length; i++) {
                if (allTabs[i].text === 'Video' || allTabs[i].text.toLowerCase() === 'video') {
                    return { found: true, method: 'text', x: allTabs[i].x, y: allTabs[i].y, allTabs, alreadySelected: allTabs[i].selected === 'true' };
                }
            }
            return { found: false, allTabs };
        })()`,
        returnByValue: true,
    });
    const videoTab = videoTabInfo?.result?.value;
    console.log('[Komfy Video] B0.2 Video tab:', JSON.stringify({ found: videoTab?.found, method: videoTab?.method, alreadySelected: videoTab?.alreadySelected }));

    if (!videoTab?.found) {
        console.warn('[Komfy Video] B0.2 ⚠️ Video tab NOT FOUND! allTabs:', JSON.stringify(videoTab?.allTabs));
        return;
    }
    if (videoTab.alreadySelected) {
        console.log('[Komfy Video] B0.2 Video tab already selected ✅');
        await sleep(600);
        return;
    }

    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: videoTab.x, y: videoTab.y, button: 'left', clickCount: 1 });
    await sleep(80);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: videoTab.x, y: videoTab.y, button: 'left', clickCount: 1 });
    await sleep(300);

    const verifyVideo = await send('Runtime.evaluate', {
        expression: `(function(){
            var scope = document.querySelector('[data-radix-popper-content-wrapper]') || document;
            var tabs = scope.querySelectorAll('[role="tab"]');
            for (var i = 0; i < tabs.length; i++) {
                var t = (tabs[i].textContent||'').trim();
                if (t === 'Video' || t.toLowerCase() === 'video') return tabs[i].getAttribute('aria-selected') === 'true';
            }
            return false;
        })()`,
        returnByValue: true,
    });

    if (verifyVideo?.result?.value) {
        console.log('[Komfy Video] B0.2 ✅ Video tab selected via CDP');
    } else {
        console.warn('[Komfy Video] B0.2 CDP failed, JS PointerEvent fallback...');
        await send('Runtime.evaluate', {
            expression: `(function(){
                var scope = document.querySelector('[data-radix-popper-content-wrapper]') || document;
                var tabs = [...scope.querySelectorAll('[role="tab"]')];
                var tab = tabs.find(function(t){ return (t.textContent||'').trim().toLowerCase() === 'video'; });
                if (!tab) return 'not found';
                tab.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,composed:true}));
                tab.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,composed:true,isPrimary:true}));
                tab.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0}));
                tab.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,composed:true,isPrimary:true}));
                tab.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0}));
                tab.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}));
                return 'dispatched: ' + (tab.textContent||'').trim();
            })()`,
            returnByValue: true,
        });
        await sleep(300);
    }
    await sleep(600); // Wait for subtype tabs to render
}

// --- B0.3: Chon subtype (Frames / Ingredients) ---
// Vietnamese locale: "Frames" = "Khung hình", "Ingredients" = "Thành phần"
async function selectSubtype(send, sleep, targetSubtype) {
    let confirmed = false;

    // Build list of text variants to match (English + Vietnamese)
    const subtypeVariants = {
        'frames': ['frames', 'khung hình'],
        'ingredients': ['ingredients', 'thành phần'],
    };
    const targetLower = targetSubtype.toLowerCase();
    const matchTexts = subtypeVariants[targetLower] || [targetLower];

    const verify = async () => {
        const v = await send('Runtime.evaluate', {
            expression: `(function(){
                var matchTexts = ${JSON.stringify(matchTexts)};
                var tabs = document.querySelectorAll('[role="tab"]');
                for (var i = 0; i < tabs.length; i++) {
                    var t = (tabs[i].textContent||'').trim().toLowerCase();
                    for (var m = 0; m < matchTexts.length; m++) {
                        if (t === matchTexts[m] || t.includes(matchTexts[m])) {
                            return { selected: tabs[i].getAttribute('aria-selected') === 'true', text: (tabs[i].textContent||'').trim().substring(0,30) };
                        }
                    }
                }
                return null;
            })()`,
            returnByValue: true,
        });
        return v?.result?.value;
    };

    for (let stry = 0; stry < 12 && !confirmed; stry++) {
        const tabInfoResult = await send('Runtime.evaluate', {
            expression: `(function(){
                var matchTexts = ${JSON.stringify(matchTexts)};
                var allTabs = [...document.querySelectorAll('[role="tab"]')].map(function(t) {
                    var r = t.getBoundingClientRect();
                    return { text: (t.textContent||'').trim().substring(0,30), selected: t.getAttribute('aria-selected'), visible: r.width > 0 && r.height > 0, x: r.left+r.width/2, y: r.top+r.height/2 };
                });
                var visible = allTabs.filter(function(t){ return t.visible; });
                var match = null;
                for (var m = 0; m < matchTexts.length && !match; m++) {
                    match = visible.find(function(t){ return t.text.toLowerCase() === matchTexts[m]; });
                }
                if (!match) {
                    for (var m = 0; m < matchTexts.length && !match; m++) {
                        match = visible.find(function(t){ return t.text.toLowerCase().includes(matchTexts[m]); });
                    }
                }
                return { match, allVisible: visible.map(function(t){ return t.text + ':' + t.selected; }) };
            })()`,
            returnByValue: true,
        });
        const tabInfo = tabInfoResult?.result?.value;
        const match = tabInfo?.match;

        if (stry === 0 || !match) {
            console.log('[Komfy Video] B0.3 attempt', stry, '| target:', targetSubtype, '| match:', JSON.stringify(match), '| allVisible:', JSON.stringify(tabInfo?.allVisible));
        }

        if (!match) { await sleep(300); continue; }
        if (match.selected === 'true') {
            console.log('[Komfy Video] B0.3 ✅ "' + targetSubtype + '" confirmed (attempt ' + stry + ')');
            confirmed = true;
            break;
        }

        const method = stry < 4 ? 'jsclick' : (stry < 8 ? 'cdp' : 'pointer');
        console.log('[Komfy Video] B0.3 attempt', stry, '| "' + targetSubtype + '" not selected → try', method);

        if (method === 'jsclick') {
            await send('Runtime.evaluate', {
                expression: `(function(){
                    var matchTexts = ${JSON.stringify(matchTexts)};
                    var tabs = [...document.querySelectorAll('[role="tab"]')];
                    var tab = null;
                    for (var m = 0; m < matchTexts.length && !tab; m++) {
                        tab = tabs.find(function(t){ var tt=(t.textContent||'').trim().toLowerCase(); return tt===matchTexts[m]||tt.includes(matchTexts[m]); });
                    }
                    if (tab && tab.getBoundingClientRect().width > 0) { tab.click(); return 'clicked:' + (tab.textContent||'').trim(); }
                    return 'not found';
                })()`,
                returnByValue: true,
            });
        } else if (method === 'cdp') {
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: match.x, y: match.y, button: 'left', clickCount: 1 });
            await sleep(60);
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: match.x, y: match.y, button: 'left', clickCount: 1 });
        } else {
            await send('Runtime.evaluate', {
                expression: `(function(){
                    var matchTexts = ${JSON.stringify(matchTexts)};
                    var tabs = [...document.querySelectorAll('[role="tab"]')];
                    var tab = null;
                    for (var m = 0; m < matchTexts.length && !tab; m++) {
                        tab = tabs.find(function(t){ var tt=(t.textContent||'').trim().toLowerCase(); return tt===matchTexts[m]||tt.includes(matchTexts[m]); });
                    }
                    if (!tab) return 'not found';
                    ['pointerover','pointerenter'].forEach(function(n){ tab.dispatchEvent(new PointerEvent(n,{bubbles:true,composed:true})); });
                    tab.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,composed:true,isPrimary:true}));
                    tab.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0}));
                    tab.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,composed:true,isPrimary:true}));
                    tab.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:0}));
                    tab.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}));
                    return 'PE:' + (tab.textContent||'').trim().substring(0,20);
                })()`,
                returnByValue: true,
            });
        }
        await sleep(300);
    }

    if (!confirmed) {
        const finalV = await verify();
        if (finalV?.selected) {
            console.log('[Komfy Video] B0.3 ✅ "' + targetSubtype + '" confirmed after all attempts');
        } else {
            console.warn('[Komfy Video] B0.3 ⚠️ Could not confirm "' + targetSubtype + '" selected! Current:', JSON.stringify(finalV));
        }
    }
    await sleep(200);
}

// --- B0.4: Chon aspect ratio pill (16:9, 9:16) ---
async function selectAspectRatio(send, sleep, aspectRatio) {
    // Map old orientation values to new aspect ratios for backward compat
    let targetRatio = aspectRatio || '16:9';
    if (targetRatio.includes('PORTRAIT') || targetRatio === 'portrait') targetRatio = '9:16';
    if (targetRatio.includes('LANDSCAPE') || targetRatio === 'landscape') targetRatio = '16:9';

    const ratioBtnInfo = await send('Runtime.evaluate', {
        expression: `(function(){
            var target = '${targetRatio}';
            var scope = document.querySelector('[data-radix-popper-content-wrapper]') || document;
            var tabs = scope.querySelectorAll('[role="tab"]');
            for (var i = 0; i < tabs.length; i++) {
                var t = (tabs[i].textContent||'').trim();
                var r = tabs[i].getBoundingClientRect();
                if (r.width === 0) continue;
                if (t === target || t.includes(target)) return { found: true, x: r.left+r.width/2, y: r.top+r.height/2, text: t };
            }
            // Fallback: ID match
            var ratioId = target.replace(':', '-');
            for (var i = 0; i < tabs.length; i++) {
                var elId = (tabs[i].id||'');
                var r = tabs[i].getBoundingClientRect();
                if (r.width === 0) continue;
                if (elId.includes(ratioId) || elId.includes(target)) return { found: true, x: r.left+r.width/2, y: r.top+r.height/2, id: elId };
            }
            return { found: false };
        })()`,
        returnByValue: true,
    });
    const ratioBtn = ratioBtnInfo?.result?.value;
    if (ratioBtn?.found) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ratioBtn.x, y: ratioBtn.y, button: 'left', clickCount: 1 });
        await sleep(60);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ratioBtn.x, y: ratioBtn.y, button: 'left', clickCount: 1 });
        await sleep(300);
        console.log('[Komfy Video] B0.4 ✅ Aspect ratio:', targetRatio);
    } else {
        console.warn('[Komfy Video] B0.4 ⚠️ Aspect ratio pill not found:', targetRatio);
    }
}

// --- B0.5: Chon resolution multiplier (x1, x2, x3, x4) ---
async function selectResolutionMultiplier(send, sleep, resMultiplier) {
    const target = resMultiplier || 'x1';
    let done = false;
    for (let retry = 0; retry < 3 && !done; retry++) {
        const tabInfo = await send('Runtime.evaluate', {
            expression: `(function(){
                var target = '${target}';
                var sliderTabs = document.querySelectorAll('.flow_tab_slider_trigger');
                if (sliderTabs.length === 0) sliderTabs = document.querySelectorAll('[role="tab"]');
                for (var i = 0; i < sliderTabs.length; i++) {
                    var t = (sliderTabs[i].textContent||'').trim();
                    var r = sliderTabs[i].getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    if (t === target) return { found: true, x: r.left+r.width/2, y: r.top+r.height/2, selected: sliderTabs[i].getAttribute('aria-selected') === 'true', dataState: sliderTabs[i].getAttribute('data-state') };
                }
                var debug = [];
                for (var i = 0; i < sliderTabs.length; i++) {
                    var r = sliderTabs[i].getBoundingClientRect();
                    if (r.width > 0) debug.push((sliderTabs[i].textContent||'').trim().substring(0,10));
                }
                return { found: false, debug };
            })()`,
            returnByValue: true,
        });
        const tab = tabInfo?.result?.value;
        console.log('[Komfy Video] B0.5 attempt', retry, '| target:', target, '| result:', JSON.stringify(tab));
        if (tab?.found) {
            if (tab.selected || tab.dataState === 'active') {
                console.log('[Komfy Video] B0.5 ✅', target, 'already selected');
                done = true;
            } else {
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tab.x, y: tab.y, button: 'left', clickCount: 1 });
                await sleep(60);
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tab.x, y: tab.y, button: 'left', clickCount: 1 });
                await sleep(300);
                console.log('[Komfy Video] B0.5 ✅', target, 'clicked');
                done = true;
            }
        } else {
            console.warn('[Komfy Video] B0.5', target, 'not found, debug:', JSON.stringify(tab?.debug));
            await sleep(400);
        }
    }
}

// --- B0.6: Chon model Veo ---
async function selectModel(send, sleep, targetVideoModel) {
    const targetModelLower = targetVideoModel.toLowerCase().replace('veo 3.1 - ', '');

    const modelDropInfo = await send('Runtime.evaluate', {
        expression: `(function(){
            var scope = document.querySelector('[data-radix-popper-content-wrapper]') || document;
            var btns = scope.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
                var t = (btns[i].textContent||'').toLowerCase();
                var r = btns[i].getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                if (t.includes('veo') && (t.includes('arrow_drop_down') || !t.includes('arrow_forward'))) {
                    return { found: true, x: r.left+r.width/2, y: r.top+r.height/2, text: t.substring(0,40) };
                }
            }
            return { found: false };
        })()`,
        returnByValue: true,
    });
    const modelDrop = modelDropInfo?.result?.value;
    console.log('[Komfy Video] B0.6a Model dropdown:', JSON.stringify(modelDrop));

    if (!modelDrop?.found) {
        console.warn('[Komfy Video] B0.6a ⚠️ Model dropdown not found!');
        return;
    }

    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: modelDrop.x, y: modelDrop.y, button: 'left', clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: modelDrop.x, y: modelDrop.y, button: 'left', clickCount: 1 });
    await sleep(500);

    const modelItemInfo = await send('Runtime.evaluate', {
        expression: `(function(){
            var want = '${targetModelLower}';
            var selectors = ['[role="menuitem"]','[role="option"]','[role="listbox"] > *','[data-radix-collection-item]'];
            var allItems = [];
            for (var s = 0; s < selectors.length; s++) {
                var items = document.querySelectorAll(selectors[s]);
                for (var i = 0; i < items.length; i++) allItems.push(items[i]);
            }
            var seen = new Set();
            allItems = allItems.filter(function(el){ if (seen.has(el)) return false; seen.add(el); return true; });
            for (var i = 0; i < allItems.length; i++) {
                var t = (allItems[i].textContent||'').toLowerCase().trim();
                var r = allItems[i].getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                if (t.includes('veo') && t.includes(want)) return { found: true, text: t.substring(0,40), x: r.left+r.width/2, y: r.top+r.height/2 };
            }
            return { found: false, want };
        })()`,
        returnByValue: true,
    });
    const modelItem = modelItemInfo?.result?.value;
    console.log('[Komfy Video] B0.6b Model item:', JSON.stringify(modelItem));

    if (modelItem?.found) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: modelItem.x, y: modelItem.y, button: 'left', clickCount: 1 });
        await sleep(60);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: modelItem.x, y: modelItem.y, button: 'left', clickCount: 1 });
        await sleep(300);
        console.log('[Komfy Video] B0.6b ✅ Model selected:', modelItem.text);
    } else {
        console.warn('[Komfy Video] B0.6b ⚠️ Model item not found! want:', targetModelLower);
    }
    await sleep(300);
}

// --- B0.7: Dong popover ---
async function closePopover(send, sleep) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Escape', code: 'Escape' });
    await sleep(300);

    // Focus vao textbox prompt ngay sau Escape — khong click vao page de tranh hit search bar
    await send('Runtime.evaluate', {
        expression: `(function(){
            var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
            if (tb) { tb.focus(); return 'focused'; }
            return 'no-textbox';
        })()`,
        returnByValue: true,
        awaitPromise: false,
    });
    await sleep(200);
}

// --- B0.8: Kiem tra + FIX Video mode tu bottom bar ---
// Tra ve true neu dang o Video mode, false neu dang o Image mode.
// Neu mode sai, tu dong mo popover lai va chon Video tab.
async function assertVideoMode(send, sleep, retrySettings) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const barResult = await send('Runtime.evaluate', {
            expression: `(function(){
                var btns = document.querySelectorAll('button,[role="button"]');
                var found = [];
                for (var i = 0; i < btns.length; i++) {
                    var r = btns[i].getBoundingClientRect();
                    if (r.bottom > window.innerHeight - 150 && r.width > 60) {
                        found.push((btns[i].textContent||'').trim().substring(0,80));
                    }
                }
                return found.join(' | ');
            })()`,
            returnByValue: true,
        });
        const finalBar = barResult?.result?.value || '';
        const barLower = finalBar.toLowerCase();
        // ★ FIX: "crop" keyword alone is NOT enough — Nano Banana Pro's detail view
        //   shows "crop_9_16" or "crop_square" which falsely matches.
        //   Must ALSO verify that the model is actually Veo, not Banana/Imagen.
        const hasVeoIndicator = barLower.includes('veo') || barLower.includes('video');
        const hasCropOnly = barLower.includes('crop');
        const isImageModel = barLower.includes('banana') || barLower.includes('imagen') || barLower.includes('nano');
        const inVideoMode = hasVeoIndicator || (hasCropOnly && !isImageModel);

        if (inVideoMode) {
            console.log('[Komfy Video] ✅ Video mode confirmed (attempt ' + attempt + '): ' + finalBar.substring(0, 50));
            return true;
        }

        console.warn('[Komfy Video] ⚠️ NOT in Video mode (attempt ' + attempt + ')! Bottom bar: "' + finalBar.substring(0, 60) + '" — Re-selecting Video tab...');

        // Mo popover va chon lai Video tab
        await openPopover(send, sleep);
        await selectVideoTab(send, sleep);
        if (retrySettings) {
            // Cung chon lai subtype neu duoc yeu cau
            await selectSubtype(send, sleep, retrySettings.resolvedVideoType);
        }
        await closePopover(send, sleep);
        await sleep(500);
    }

    console.warn('[Komfy Video] ❌ Could not confirm Video mode after 3 attempts — continuing anyway');
    return false;
}

// Backward compat alias
async function verifyVideoMode(send, sleep) {
    return assertVideoMode(send, sleep, null);
}

// --- Facade: Chay toan bo settings phase B0 ---
async function runSettingsPhase(send, sleep, { targetVideoModel, resolvedVideoType, aspectRatio, resolutionMultiplier }) {
    console.log('[Komfy Video] B0 Setup popover settings...');
    await openPopover(send, sleep);
    await selectVideoTab(send, sleep);
    await selectSubtype(send, sleep, resolvedVideoType);
    await selectAspectRatio(send, sleep, aspectRatio);
    await selectResolutionMultiplier(send, sleep, resolutionMultiplier || 'x1');
    await selectModel(send, sleep, targetVideoModel);

    await closePopover(send, sleep);
    console.log('[Komfy Video] B0.7 Popover closed. Settings: model=' + targetVideoModel + ' aspect=' + aspectRatio + ' res=' + (resolutionMultiplier || 'x1') + ' type=' + resolvedVideoType);
    // Verify va tu dong fix neu mode sai
    await assertVideoMode(send, sleep, { resolvedVideoType });
}
