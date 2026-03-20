// ============================================================
// video-gen-frames.js
// Frame selection logic for I2V (Frames mode):
//   - selectFrameFromPicker(slotType, imageDataUrl, send, sleep)
//   - handleI2VFrameSelection(i2vData, send, sleep)
//   - reVerifyVideoModeAfterGallery(send, sleep) — re-switch neu gallery reset mode
// ============================================================

/**
 * Upload anh cho First Frame (start) / Last Frame (end) slot.
 * Flow thuc te:
 *   1. Click "Start"/"End" button → page gallery hien ra
 *   2. Inject file data vao input[type="file"] (hoac click "Upload image")
 *   3. Poll thumbnail moi → click de confirm slot
 *
 * @param {string} slotType - 'start' | 'end'
 * @param {string} imageDataUrl - data:image/xxx;base64,...
 * @param {Function} send - CDP sendCommand wrapper
 * @param {Function} sleep - Promise sleep
 * @returns {boolean}
 */
async function selectFrameFromPicker(slotType, imageDataUrl, send, sleep) {
    console.log('[Komfy Video] selectFrameFromPicker:', slotType);

    if (!imageDataUrl || !imageDataUrl.startsWith('data:')) {
        console.warn('[Komfy Video] invalid imageDataUrl for', slotType);
        return false;
    }

    const imgBase64 = imageDataUrl.split(',')[1];
    const mimeMatch = imageDataUrl.match(/^data:([^;]+);/);
    const imgMime = mimeMatch ? mimeMatch[1] : 'image/png';
    const imgExt = imgMime.split('/')[1] || 'png';

    // B1: Click "Start" hoac "End" button → gallery hien ra
    let slotClicked = false;
    for (let attempt = 0; attempt < 8 && !slotClicked; attempt++) {
        const jsResult = await send('Runtime.evaluate', {
            expression: `(function(){
                var isStart = '${slotType}' === 'start';
                var targetText = isStart ? 'start' : 'end';
                var allEls = [...document.querySelectorAll('button,[role="button"],div[tabindex],span[tabindex]')];
                for (var i = 0; i < allEls.length; i++) {
                    var el = allEls[i];
                    var r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0 || r.top < window.innerHeight * 0.5) continue;
                    var t = (el.textContent || '').trim().toLowerCase();
                    var lbl = (el.getAttribute('aria-label') || '').toLowerCase();
                    if (t === targetText || lbl === targetText || lbl.includes(isStart ? 'first' : 'last')) {
                        el.click();
                        return 'js:' + t + '@' + Math.round(r.x) + ',' + Math.round(r.y);
                    }
                }
                var dbg = allEls
                    .filter(function(el){ var r = el.getBoundingClientRect(); return r.width > 0 && r.top > window.innerHeight * 0.5; })
                    .map(function(el){ var r = el.getBoundingClientRect(); return (el.textContent||'').trim().substring(0,12) + '@' + Math.round(r.x) + ',' + Math.round(r.y); })
                    .slice(0, 10);
                return 'not-found:' + dbg.join('|');
            })()`,
            returnByValue: true,
        });
        const jsVia = jsResult?.result?.value || '';
        console.log('[Komfy Video] B1 attempt', attempt, ':', jsVia.substring(0, 100));

        if (jsVia && !jsVia.startsWith('not-found')) {
            slotClicked = true;
        } else {
            const coordR = await send('Runtime.evaluate', {
                expression: `(function(){
                    var isStart = '${slotType}' === 'start';
                    var targetText = isStart ? 'start' : 'end';
                    var allEls = [...document.querySelectorAll('button,[role="button"],div[tabindex]')];
                    for (var i = 0; i < allEls.length; i++) {
                        var el = allEls[i];
                        var r = el.getBoundingClientRect();
                        if (r.width === 0 || r.top < window.innerHeight * 0.5) continue;
                        var t = (el.textContent||'').trim().toLowerCase();
                        if (t === targetText) return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) };
                    }
                    return null;
                })()`,
                returnByValue: true,
            });
            const coord = coordR?.result?.value;
            if (coord?.x) {
                await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1 });
                await sleep(60);
                await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1 });
                slotClicked = true;
                console.log('[Komfy Video] B1 CDP click:', coord.x, coord.y);
            } else {
                await sleep(500);
            }
        }
    }

    if (!slotClicked) {
        console.warn('[Komfy Video] B1 FAIL: Start/End slot not found for', slotType);
        return false;
    }

    await sleep(1500); // Cho gallery hien ra

    // B2: Inject file data vao file input
    const injectResult = await send('Runtime.evaluate', {
        expression: `(async function(){
            try {
                var base64 = ${JSON.stringify(imgBase64)};
                var mime = ${JSON.stringify(imgMime)};
                var fileName = 'frame_${slotType}.${imgExt}';
                var byteChars = atob(base64);
                var arr = new Uint8Array(byteChars.length);
                for (var i = 0; i < byteChars.length; i++) arr[i] = byteChars.charCodeAt(i);
                var blob = new Blob([arr], {type: mime});
                var file = new File([blob], fileName, {type: mime, lastModified: Date.now()});
                var dt = new DataTransfer();
                dt.items.add(file);

                var inputs = [...document.querySelectorAll('input[type="file"]')];
                if (inputs.length === 0) return 'no-file-input';

                var imgInput = inputs.find(function(inp){ return (inp.accept||'').includes('image'); }) || inputs[0];
                try {
                    Object.defineProperty(imgInput, 'files', { value: dt.files, configurable: true, writable: true });
                    imgInput.dispatchEvent(new Event('change', { bubbles: true }));
                    imgInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
                    return 'file-injected:' + fileName + ' (' + byteChars.length + 'b)';
                } catch(e2) {
                    return 'inject-err:' + e2.message;
                }
            } catch(e) { return 'error:' + e.message; }
        })()`,
        returnByValue: true,
        awaitPromise: true,
    });
    console.log('[Komfy Video] B2 inject:', injectResult?.result?.value);

    // B3: Neu file inject fail, thu click "Upload image" button
    const injectVal = injectResult?.result?.value || '';
    if (injectVal.startsWith('no-file-input') || injectVal.startsWith('inject-err')) {
        console.log('[Komfy Video] B3: Tim nut Upload image...');
        const uploadBtnResult = await send('Runtime.evaluate', {
            expression: `(function(){
                var btns = [...document.querySelectorAll('button,[role="button"]')];
                for (var i = 0; i < btns.length; i++) {
                    var t = (btns[i].textContent||btns[i].getAttribute('aria-label')||'').toLowerCase();
                    var r = btns[i].getBoundingClientRect();
                    if (r.width === 0) continue;
                    if (t.includes('upload')) {
                        btns[i].click();
                        return 'upload-btn:' + t.substring(0,30) + '@' + Math.round(r.x) + ',' + Math.round(r.y);
                    }
                }
                return 'no-upload-btn';
            })()`,
            returnByValue: true,
        });
        console.log('[Komfy Video] B3 upload btn:', uploadBtnResult?.result?.value);
        await sleep(800);

        // Retry inject sau khi click upload
        const retryInject = await send('Runtime.evaluate', {
            expression: `(async function(){
                var base64 = ${JSON.stringify(imgBase64)};
                var mime = ${JSON.stringify(imgMime)};
                var file = new File([Uint8Array.from(atob(base64), c=>c.charCodeAt(0))], 'frame_${slotType}.${imgExt}', {type:mime, lastModified:Date.now()});
                var dt = new DataTransfer(); dt.items.add(file);
                var inputs = [...document.querySelectorAll('input[type="file"]')];
                if (!inputs.length) return 'still-no-input';
                var inp = inputs.find(function(i){ return (i.accept||'').includes('image'); }) || inputs[0];
                try {
                    Object.defineProperty(inp, 'files', { value: dt.files, configurable: true, writable: true });
                    inp.dispatchEvent(new Event('change', {bubbles:true}));
                    return 'retry-ok';
                } catch(e) { return 'retry-err:' + e.message; }
            })()`,
            returnByValue: true,
            awaitPromise: true,
        });
        console.log('[Komfy Video] B3 retry inject:', retryInject?.result?.value);
    }

    // B4: Poll cho thumbnail moi → click de confirm slot
    console.log('[Komfy Video] B4 Cho upload...');
    await sleep(3000);

    let newThumbClicked = false;
    for (let poll = 0; poll < 12 && !newThumbClicked; poll++) {
        const thumbResult = await send('Runtime.evaluate', {
            expression: `(function(){
                var allImgs = [...document.querySelectorAll('img')].filter(function(img){
                    var r = img.getBoundingClientRect();
                    return r.width >= 40 && r.height >= 40 && r.top < window.innerHeight * 0.7 && r.top > 60;
                });
                if (allImgs.length === 0) return 'no-img:count=0';
                var target = allImgs[0];
                var el = target;
                for (var i = 0; i < 5; i++) {
                    if (!el.parentElement) break;
                    el = el.parentElement;
                    var tag = el.tagName.toLowerCase();
                    if (tag === 'button' || el.getAttribute('role') === 'button' || el.getAttribute('tabindex') === '0') break;
                }
                el.click();
                var r = target.getBoundingClientRect();
                return 'clicked-img:src=' + (target.src||'').slice(-30) + '@' + Math.round(r.x) + ',' + Math.round(r.y);
            })()`,
            returnByValue: true,
        });
        const thumbVal = thumbResult?.result?.value || '';
        console.log('[Komfy Video] B4 poll', poll, ':', thumbVal.substring(0, 80));
        if (thumbVal.startsWith('clicked-img')) {
            newThumbClicked = true;
        } else {
            await sleep(2000);
        }
    }

    if (!newThumbClicked) {
        console.warn('[Komfy Video] B4 FAIL: No thumbnail found after upload for', slotType);
        return false;
    }

    // B5: Verify slot da duoc gan anh
    await sleep(500);
    const verifyResult = await send('Runtime.evaluate', {
        expression: `(function(){
            var isStart = '${slotType}' === 'start';
            var targetText = isStart ? 'start' : 'end';
            var allEls = [...document.querySelectorAll('button,[role="button"],div[tabindex]')];
            for (var i = 0; i < allEls.length; i++) {
                var el = allEls[i];
                var t = (el.textContent||'').trim().toLowerCase();
                if (t === targetText) {
                    var r = el.getBoundingClientRect();
                    var hasImg = el.querySelector('img') !== null;
                    return 'slot:' + targetText + ':hasImg=' + hasImg;
                }
            }
            return 'slot-not-visible'; // da duoc assign → hien thumbnail
        })()`,
        returnByValue: true,
    });
    console.log('[Komfy Video] B5 verify:', verifyResult?.result?.value);
    console.log('[Komfy Video] done:', slotType);
    return true;
}

/**
 * Xu ly I2V frame selection cho both start va end.
 * @param {object} i2vData
 * @param {Function} send
 * @param {Function} sleep
 */
async function handleI2VFrameSelection(i2vData, send, sleep) {
    if (!i2vData) return;

    const startDataUrl = i2vData.startImageDataUrl || null;
    const endDataUrl   = i2vData.endImageDataUrl   || null;

    if (startDataUrl) {
        console.log('[Komfy Video] Setting Start frame via paste...');
        const ok = await selectFrameFromPicker('start', startDataUrl, send, sleep);
        if (!ok) console.warn('[Komfy Video] Start frame paste failed!');
        await sleep(500);
    } else if (i2vData.startImage) {
        console.log('[Komfy Video] Start frame: mediaId available but no dataUrl, skipping UI paste');
    }

    if (endDataUrl) {
        console.log('[Komfy Video] Setting End frame via paste...');
        const ok = await selectFrameFromPicker('end', endDataUrl, send, sleep);
        if (!ok) console.warn('[Komfy Video] End frame paste failed!');
        await sleep(500);
    } else if (i2vData.endImage) {
        console.log('[Komfy Video] End frame: mediaId available but no dataUrl, skipping UI paste');
    }

    await sleep(500);
}

/**
 * Sau khi gallery dong, kiem tra mode co bi reset khong.
 * Neu bi reset → re-switch sang Video tab.
 * @param {Function} send
 * @param {Function} sleep
 */
async function reVerifyVideoModeAfterGallery(send, sleep) {
    const reBarText = (await send('Runtime.evaluate', {
        expression: `(function(){
            var btns = document.querySelectorAll('button,[role="button"]');
            for (var i = 0; i < btns.length; i++) {
                var r = btns[i].getBoundingClientRect();
                var t = (btns[i].textContent||'').toLowerCase().trim();
                if (r.bottom > window.innerHeight - 150 && r.width > 60 && /x[1-4]/.test(t))
                    return t.substring(0, 60);
            }
            return '';
        })()`,
        returnByValue: true,
    }))?.result?.value || '';

    console.log('[Komfy Video] Re-verify after gallery:', reBarText);

    if (reBarText.includes('video') || reBarText.includes('veo')) return; // OK

    // Gallery reset mode! Re-switch to Video
    console.warn('[Komfy Video] Gallery reset mode! Re-switching to Video...');
    const reopenInfo = await send('Runtime.evaluate', {
        expression: `(function(){
            var btns = document.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
                var r = btns[i].getBoundingClientRect();
                var t = (btns[i].textContent||'').toLowerCase().trim();
                if (r.width < 60 || r.height < 20 || r.bottom < window.innerHeight - 120) continue;
                if (t.includes('arrow_forward') || t.startsWith('add_2')) continue;
                if (t.includes('banana') || t.includes('imagen') || t.includes('veo') || t.includes('video') || t.includes('crop') || /x[1-4]/.test(t)) {
                    return { found: true, x: r.left+r.width/2, y: r.top+r.height/2 };
                }
            }
            return { found: false };
        })()`,
        returnByValue: true,
    });
    const reopenBtn = reopenInfo?.result?.value;
    if (!reopenBtn?.found) return;

    // Open popover
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: reopenBtn.x, y: reopenBtn.y, button: 'left', clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: reopenBtn.x, y: reopenBtn.y, button: 'left', clickCount: 1 });
    await sleep(500);

    // Click Video tab
    const vtInfo = await send('Runtime.evaluate', {
        expression: `(function(){
            var scope = document.querySelector('[data-radix-popper-content-wrapper]') || document;
            var byId = scope.querySelector('[id$="-trigger-VIDEO"]');
            if (byId) { var r = byId.getBoundingClientRect(); if (r.width > 0) return { found:true, x:r.left+r.width/2, y:r.top+r.height/2 }; }
            var tabs = scope.querySelectorAll('[role="tab"]');
            for (var i = 0; i < tabs.length; i++) {
                var t = (tabs[i].textContent||'').trim();
                var r = tabs[i].getBoundingClientRect();
                if (r.width === 0) continue;
                if (t === 'Video' || t.toLowerCase() === 'video') return { found:true, x:r.left+r.width/2, y:r.top+r.height/2 };
            }
            return { found:false };
        })()`,
        returnByValue: true,
    });
    const vt = vtInfo?.result?.value;
    if (vt?.found) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: vt.x, y: vt.y, button: 'left', clickCount: 1 });
        await sleep(60);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: vt.x, y: vt.y, button: 'left', clickCount: 1 });
        await sleep(300);
        console.log('[Komfy Video] ✅ Re-switched to Video tab after gallery');
    }

    // Dong popover
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await sleep(400);
}

/**
 * Xoa tat ca cac ingredient image cu dang hien thi truoc khi them moi.
 * (Restored to ensure clean state and avoid overflowing Flow's prompt limits causing 2x runs)
 */
async function clearExistingIngredients(send, sleep) {
    console.log('[Komfy Video] Clearing existing ingredients...');
    let loop = 0;
    while (loop < 15) {
        loop++;
        const clickResult = await send('Runtime.evaluate', {
            expression: `(function(){
                var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
                if (!tb) return false;
                var tbRect = tb.getBoundingClientRect();
                
                var btns = [...document.querySelectorAll('button,[role="button"]')];
                var removeBtns = btns.filter(function(b){
                    var r = b.getBoundingClientRect();
                    var isAbove = r.bottom <= (tbRect.top + 50) && r.top > (tbRect.top - 250);
                    if (!isAbove) return false;
                    var aria = (b.getAttribute('aria-label')||'').toLowerCase();
                    return aria.includes('remove') || aria.includes('clear') || aria.includes('delete') || aria.includes('close');
                });
                
                if (removeBtns.length === 0) {
                    var imgs = [...document.querySelectorAll('img')].filter(function(img){
                        var r = img.getBoundingClientRect();
                        return r.width >= 30 && r.height >= 30 && r.width < 120 && r.height < 120 
                               && r.bottom <= (tbRect.top + 50) && r.top > (tbRect.top - 250);
                    });
                    if (imgs.length === 0) return false;
                    
                    var targetImg = imgs[0];
                    var p = targetImg.parentElement;
                    while (p && p.tagName !== 'BODY') {
                        var pbtns = [...p.querySelectorAll('button,[role="button"]')];
                        if (pbtns.length > 0 && pbtns[0] !== targetImg) {
                            removeBtns.push(pbtns[pbtns.length - 1]);
                            break;
                        }
                        p = p.parentElement;
                    }
                }
                
                if (removeBtns.length > 0) {
                    var btn = removeBtns[0];
                    btn.click();
                    var r = btn.getBoundingClientRect();
                    return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
                }
                return false;
            })()`,
            returnByValue: true
        });
        
        const val = clickResult?.result?.value;
        if (!val || !val.found) break; // Da clear sach
        
        if (val.x && val.y) {
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: val.x, y: val.y, button: 'left', clickCount: 1 });
            await sleep(40);
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: val.x, y: val.y, button: 'left', clickCount: 1 });
        }
        await sleep(500); 
    }
}
/**
 * Dem so luong ingredient thumbnail hien dang hien phia tren textbox.
 * @param {Function} send
 * @returns {number}
 */
async function getIngredientCount(send) {
    const result = await send('Runtime.evaluate', {
        expression: `(function(){
            var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
            if (!tb) return 0;
            var tbRect = tb.getBoundingClientRect();
            var imgs = [...document.querySelectorAll('img')].filter(function(img){
                var r = img.getBoundingClientRect();
                return r.width >= 30 && r.height >= 30 && r.width < 120 && r.height < 120
                    && r.bottom <= (tbRect.top + 50)
                    && r.top > (tbRect.top - 250);
            });
            return imgs.length;
        })()`,
        returnByValue: true,
        awaitPromise: false,
    });
    return result?.result?.value || 0;
}

/**
 * Them ingredient image trong Video > Ingredients mode.
 * Cach hoat dong: ghi anh vao system clipboard (navigator.clipboard.write)
 * sau do focus textbox va nhan Ctrl+V — giong cach user dan thu cong.
 * Poll cho den khi so thumbnail tren textbox dat targetCount.
 *
 * @param {string} imageDataUrl - data:image/xxx;base64,...
 * @param {number} imgIdx - index (0-based) de debug
 * @param {number} targetCount - so thumbnail can dat sau khi paste (baseline + so anh da paste)
 * @param {Function} send
 * @param {Function} sleep
 * @returns {boolean}
 */
async function addIngredientFromPicker(imageDataUrl, imgIdx, targetCount, send, sleep) {
    console.log('[Komfy Video] addIngredient idx=' + imgIdx + ' targetCount=' + targetCount);
    if (!imageDataUrl || !imageDataUrl.startsWith('data:')) {
        console.warn('[Komfy Video] invalid imageDataUrl for ingredient', imgIdx);
        return false;
    }

    const imgBase64 = imageDataUrl.split(',')[1];
    const mimeMatch = imageDataUrl.match(/^data:([^;]+);/);
    const imgMime = mimeMatch ? mimeMatch[1] : 'image/png';

    // B1: Ghi anh vao system clipboard bang navigator.clipboard.write
    const writeResult = await send('Runtime.evaluate', {
        expression: `(async function(){
            try {
                var base64 = ${JSON.stringify(imgBase64)};
                var mime = ${JSON.stringify(imgMime)};
                var arr = new Uint8Array(atob(base64).split('').map(function(c){ return c.charCodeAt(0); }));
                var blob = new Blob([arr], {type: mime});
                // Luon dung image/png vi ClipboardItem chi chap nhan loai anh pho bien
                var pngBlob = blob;
                if (mime !== 'image/png') {
                    // Convert sang PNG qua canvas
                    var img = new Image();
                    var loaded = new Promise(function(res, rej){ img.onload = res; img.onerror = rej; });
                    img.src = URL.createObjectURL(blob);
                    await loaded;
                    var canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                    canvas.getContext('2d').drawImage(img, 0, 0);
                    pngBlob = await new Promise(function(res){ canvas.toBlob(res, 'image/png'); });
                    URL.revokeObjectURL(img.src);
                }
                await navigator.clipboard.write([new ClipboardItem({'image/png': pngBlob})]);
                return 'clipboard-written:' + arr.length + 'b';
            } catch(e) { return 'clipboard-error:' + e.message; }
        })()`,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
    });
    const writeVal = writeResult?.result?.value || '';
    console.log('[Komfy Video] IngredientB1 clipboard write:', writeVal);

    if (writeVal.startsWith('clipboard-error')) {
        console.warn('[Komfy Video] IngredientB1: clipboard write failed, trying fallback ClipboardEvent...');
        // Fallback: dung ClipboardEvent (co the khong work trong video mode nhung thu truoc)
        await send('Runtime.evaluate', {
            expression: `(async function(){
                try {
                    var base64 = ${JSON.stringify(imgBase64)};
                    var mime = ${JSON.stringify(imgMime)};
                    var arr = new Uint8Array(atob(base64).split('').map(function(c){ return c.charCodeAt(0); }));
                    var blob = new Blob([arr], {type: mime});
                    var file = new File([blob], 'ingredient_${imgIdx}.${imgMime.split('/')[1] || 'png'}', {type: mime, lastModified: Date.now()});
                    var dt = new DataTransfer();
                    dt.items.add(file);
                    var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
                    if (!tb) return 'no-textbox';
                    tb.focus();
                    tb.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
                    return 'fallback-paste-dispatched';
                } catch(e) { return 'fallback-error:' + e.message; }
            })()`,
            returnByValue: true,
            awaitPromise: true,
        });
        await sleep(1500);
        return true; // proceed anyway
    }

    // B2: Focus textbox (phai CLICK vao Textbox de dam bao Flow xu ly Paste Event vao dung o nhap lieu, khong phai toan trang)
    await sleep(200);
    const tbCoordRes = await send('Runtime.evaluate', {
        expression: `(function(){
            var tb = document.querySelector('[role="textbox"],[contenteditable="true"]');
            if (tb) {
                var r = tb.getBoundingClientRect();
                return { x: r.left + r.width/2, y: r.top + r.height/2 };
            }
            return null;
        })()`,
        returnByValue: true
    });
    const tbCoord = tbCoordRes?.result?.value;
    if (tbCoord && tbCoord.x && tbCoord.y) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tbCoord.x, y: tbCoord.y, button: 'left', clickCount: 1 });
        await sleep(60);
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tbCoord.x, y: tbCoord.y, button: 'left', clickCount: 1 });
    }
    await sleep(300);

    // B3: Nhan Ctrl+V de dan anh tu clipboard vao textbox
    await send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'v', code: 'KeyV',
        modifiers: 2, // Ctrl = modifier bit 2
        windowsVirtualKeyCode: 86,
    });
    await sleep(60);
    await send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'v', code: 'KeyV',
        modifiers: 2,
        windowsVirtualKeyCode: 86,
    });
    await sleep(500); // Cho Flow bat    // B4: Poll cho ingredient count dat targetCount
    // Dua vao SO LUONG thumbnail thuc te, khong phai thoi gian.
    console.log('[Komfy Video] IngredientB4: Waiting for count >=', targetCount, '...');
    const startTime = Date.now();
    const timeout = 30000; // max 30s moi anh
    let reachedTarget = false;
    while (!reachedTarget && (Date.now() - startTime) < timeout) {
        const currentCount = await getIngredientCount(send);
        const elapsed = Math.round((Date.now() - startTime) / 100) / 10;
        console.log('[Komfy Video] IngredientB4 count=' + currentCount + '/' + targetCount + ' | ' + elapsed + 's');
        if (currentCount >= targetCount) {
            reachedTarget = true;
        } else {
            await sleep(800);
        }
    }

    if (!reachedTarget) {
        const finalCount = await getIngredientCount(send);
        console.warn('[Komfy Video] IngredientB4 TIMEOUT: count=' + finalCount + ' expected=' + targetCount + ' — proceeding anyway');
    } else {
        console.log('[Komfy Video] ✅ Ingredient ' + imgIdx + ' confirmed (count reached ' + targetCount + ')');
    }

    await sleep(300);
    return true;
}
