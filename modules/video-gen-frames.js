// ============================================================
// video-gen-frames.js
// Frame selection logic for I2V (Frames mode):
//   - selectFrameFromPicker(slotType, imageDataUrl, send, sleep)
//   - handleI2VFrameSelection(i2vData, send, sleep)
//   - reVerifyVideoModeAfterGallery(send, sleep) — re-switch neu gallery reset mode
// ============================================================

/**
 * Chon anh cho First Frame (start) / Last Frame (end) slot.
 *
 * FLOW:
 *   1. Click "Start"/"End" slot → Asset Picker panel mo ra (sidebar)
 *   2. Chon anh RECENTLY UPLOADED (dau tien) trong picker
 *   3. Verify slot da duoc gan anh (thumbnail hien)
 *
 * Dieu kien: Anh DA DUOC UPLOAD len project truoc do (qua UPLOAD_IMAGE API).
 * Asset Picker hien danh sach tat ca anh trong project, sort "Recent" → anh moi upload o dau.
 *
 * @param {string} slotType - 'start' | 'end'
 * @param {string} imageDataUrl - data:image/xxx;base64,... (backup, ko dung de upload)
 * @param {Function} send - CDP sendCommand wrapper
 * @param {Function} sleep - Promise sleep
 * @returns {boolean}
 */
async function selectFrameFromPicker(slotType, imageDataUrl, send, sleep) {
    console.log('[Komfy Video] selectFrameFromPicker:', slotType);

    // =========================================================
    // B1: Click "Start"/"End" slot → Asset Picker panel mo ra
    // =========================================================
    // LUON dung CDP mouse events — JS .click() khong trigger React event handlers
    // dung cach (dac biet sau khi DOM thay doi do fill slot truoc do).
    let slotClicked = false;
    for (let attempt = 0; attempt < 8 && !slotClicked; attempt++) {
        // Tim toa do slot qua JS, click qua CDP
        const coordR = await send('Runtime.evaluate', {
            expression: `(function(){
                var isStart = '${slotType}' === 'start';
                var targetText = isStart ? 'Start' : 'End';

                // Strategy 1: Swap button anchor → sibling container
                var swapBtn = document.querySelector('button[aria-label="Swap first and last frames"]');
                if (swapBtn && swapBtn.parentElement) {
                    var children = swapBtn.parentElement.children;
                    for (var i = 0; i < children.length; i++) {
                        var ch = children[i];
                        var t = (ch.textContent||'').trim();
                        if (t === targetText) {
                            var r = ch.getBoundingClientRect();
                            if (r.width > 0) {
                                return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), via: 'swap-anchor:'+t };
                            }
                        }
                    }
                    // Slot da co anh (khong co text "Start"/"End" nua)?
                    // Start = first non-swap child, End = last non-swap child
                    var nonSwap = [];
                    for (var i = 0; i < children.length; i++) {
                        if (children[i] !== swapBtn) nonSwap.push(children[i]);
                    }
                    var slotEl = isStart ? nonSwap[0] : nonSwap[nonSwap.length - 1];
                    if (slotEl) {
                        var sr = slotEl.getBoundingClientRect();
                        if (sr.width > 0) {
                            return { x: Math.round(sr.x+sr.width/2), y: Math.round(sr.y+sr.height/2), via: 'swap-positional:'+slotEl.tagName };
                        }
                    }
                }

                // Strategy 2: Leaf div with text "Start"/"End"
                var allDivs = [...document.querySelectorAll('div')];
                for (var j = 0; j < allDivs.length; j++) {
                    var div = allDivs[j];
                    var dt = (div.textContent||'').trim();
                    if (dt !== targetText || div.children.length > 0) continue;
                    var dr = div.getBoundingClientRect();
                    if (dr.width === 0 || dr.width > 100 || dr.top < window.innerHeight * 0.4) continue;
                    // Walk up to find closest clickable ancestor (button, [role=button], add_circle_outline)
                    var clickTarget = div;
                    for (var up = 0; up < 6; up++) {
                        var p = clickTarget.parentElement;
                        if (!p) break;
                        var pTag = p.tagName.toLowerCase();
                        if (pTag === 'button' || p.getAttribute('role') === 'button' || p.getAttribute('tabindex') !== null) {
                            clickTarget = p;
                            break;
                        }
                        var pr = p.getBoundingClientRect();
                        // Stop if parent is too large (probably a container, not a slot)
                        if (pr.width > 300 || pr.height > 300) break;
                        clickTarget = p;
                    }
                    var cr = clickTarget.getBoundingClientRect();
                    return { x: Math.round(cr.x+cr.width/2), y: Math.round(cr.y+cr.height/2), via: 'div-text:'+dt+'@'+Math.round(dr.x)+','+Math.round(dr.y)+' click:'+clickTarget.tagName+'@'+Math.round(cr.x)+','+Math.round(cr.y)+' size:'+Math.round(cr.width)+'x'+Math.round(cr.height) };
                }

                // Debug info
                var dbg = [...document.querySelectorAll('button,[role="button"],div')]
                    .filter(function(el){ var r = el.getBoundingClientRect(); return r.width > 20 && r.width < 200 && r.top > window.innerHeight * 0.4 && el.children.length <= 2; })
                    .map(function(el){ var r = el.getBoundingClientRect(); return el.tagName + ':' + (el.textContent||'').trim().substring(0,15) + '@' + Math.round(r.x) + ',' + Math.round(r.y); })
                    .slice(0, 10);
                return { x: 0, y: 0, via: 'not-found:' + dbg.join('|') };
            })()`,
            returnByValue: true,
        });
        const coord = coordR?.result?.value;
        console.log('[Komfy Video] B1 attempt', attempt, ':', coord?.via?.substring(0, 100), '| x:', coord?.x, 'y:', coord?.y);

        if (coord?.x > 0 && coord?.y > 0) {
            // LUON dung CDP mouse events — co PointerEvent pipeline day du
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: coord.x, y: coord.y });
            await sleep(100);
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1 });
            await sleep(80);
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1 });
            slotClicked = true;
            console.log('[Komfy Video] B1 CDP click:', coord.x, coord.y);
        } else {
            await sleep(500);
        }
    }

    if (!slotClicked) {
        console.warn('[Komfy Video] B1 FAIL: Start/End slot not found for', slotType);
        return false;
    }

    // =========================================================
    // B2: Cho Asset Picker mo ra → click anh dau tien (most recent)
    // =========================================================
    // Asset Picker la mot panel/sidebar hien danh sach anh trong project.
    // Anh da upload (qua UPLOAD_IMAGE API) se xuat hien o dau neu sort "Recent".
    // Cau truc: panel co nhieu row, moi row co thumbnail (img) + ten.
    // Ta click vao row dau tien (anh moi nhat) de gan vao slot.
    console.log('[Komfy Video] B2: Waiting for Asset Picker...');
    await sleep(2000);

    let pickerImageClicked = false;
    for (let poll = 0; poll < 15 && !pickerImageClicked; poll++) {
        // Tim anh trong picker — TRA VE TOA DO de click qua CDP
        const pickerResult = await send('Runtime.evaluate', {
            expression: `(function(){
                // Tim tat ca <img> visible (picker, gallery, overlay)
                var allImgs = [...document.querySelectorAll('img')].filter(function(img){
                    var r = img.getBoundingClientRect();
                    return r.width >= 30 && r.height >= 30
                        && r.top > 50 && r.top < window.innerHeight * 0.85
                        && r.left > 50;
                });

                if (allImgs.length === 0) {
                    // Debug: dialogs, panels, radix poppers
                    var panels = [...document.querySelectorAll('[role="dialog"],[role="listbox"],[class*="picker"],[class*="gallery"],[class*="asset"],[data-radix-popper-content-wrapper]')]
                        .filter(function(p){ return p.getBoundingClientRect().width > 0; });
                    var searchInput = document.querySelector('input[placeholder*="Search"]');
                    // Also log any buttons that appeared (could be upload/browse button)
                    var newBtns = [...document.querySelectorAll('button')].filter(function(b){
                        var r = b.getBoundingClientRect();
                        return r.width > 30 && r.top > 50 && r.top < window.innerHeight * 0.7;
                    }).map(function(b){
                        return (b.textContent||'').trim().substring(0,20) + '@' + Math.round(b.getBoundingClientRect().x) + ',' + Math.round(b.getBoundingClientRect().y);
                    }).slice(0, 5);
                    return { found: false, panels: panels.length, search: !!searchInput, btns: newBtns };
                }

                // Return coordinates of first image (most recent upload)
                var img = allImgs[0];
                var r = img.getBoundingClientRect();

                // Tim parent clickable de lay toa do chinh xac hon
                var el = img;
                for (var p = 0; p < 8; p++) {
                    if (!el.parentElement) break;
                    el = el.parentElement;
                    var tag = el.tagName.toLowerCase();
                    if (tag === 'button' || el.getAttribute('role') === 'button'
                        || el.getAttribute('role') === 'listitem' || el.getAttribute('role') === 'option'
                        || el.getAttribute('tabindex') === '0' || el.getAttribute('tabindex') === '-1') break;
                    if (tag === 'div' && el.children.length >= 1 && el.children.length <= 5) {
                        var elR = el.getBoundingClientRect();
                        if (elR.width > 60 && elR.height > 30 && elR.height < 200) break;
                    }
                }
                var clickR = el.getBoundingClientRect();

                return {
                    found: true,
                    x: Math.round(clickR.x + clickR.width/2),
                    y: Math.round(clickR.y + clickR.height/2),
                    src: (img.src||'').slice(-40),
                    imgCount: allImgs.length,
                    el: el.tagName + '[' + (el.className||'').substring(0,30) + ']'
                };
            })()`,
            returnByValue: true,
        });
        const pickerVal = pickerResult?.result?.value;
        console.log('[Komfy Video] B2 poll', poll, ':', JSON.stringify(pickerVal)?.substring(0, 150));

        if (pickerVal?.found && pickerVal.x > 0) {
            // Click qua CDP — khong dung JS .click()
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pickerVal.x, y: pickerVal.y });
            await sleep(100);
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pickerVal.x, y: pickerVal.y, button: 'left', clickCount: 1 });
            await sleep(80);
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pickerVal.x, y: pickerVal.y, button: 'left', clickCount: 1 });
            console.log('[Komfy Video] B2 CDP click picker image:', pickerVal.x, pickerVal.y);
            pickerImageClicked = true;
        } else {
            await sleep(1500);
        }
    }

    if (!pickerImageClicked) {
        console.warn('[Komfy Video] B2 TOTAL FAIL for', slotType);
        return false;
    }

    // =========================================================
    // B3: Verify slot da duoc gan anh (thumbnail hien)
    // =========================================================
    await sleep(1500); // Cho UI update

    const verifyResult = await send('Runtime.evaluate', {
        expression: `(function(){
            var isStart = '${slotType}' === 'start';
            var targetText = isStart ? 'Start' : 'End';

            // Strategy 1: Tim qua Swap button anchor → check sibling slot co img khong
            var swapBtn = document.querySelector('button[aria-label="Swap first and last frames"]');
            if (swapBtn) {
                var parent = swapBtn.parentElement;
                if (parent) {
                    var children = parent.children;
                    // Start = first child, End = last child (Swap o giua)
                    var slotIdx = isStart ? 0 : children.length - 1;
                    var slot = children[slotIdx];
                    if (slot) {
                        var slotImg = slot.querySelector('img');
                        var slotText = (slot.textContent||'').trim();
                        if (slotImg) {
                            return 'slot-verified:hasImg=true,src=' + (slotImg.src||'').slice(-30);
                        }
                        // Slot still shows text → not assigned yet
                        if (slotText === targetText) {
                            return 'slot-empty:text=' + slotText;
                        }
                        // Slot has different content (maybe thumbnail replacing text)
                        return 'slot-changed:text=' + slotText.substring(0,20) + ',hasImg=false';
                    }
                }
            }

            // Strategy 2: Tim div with text "Start"/"End" (if still visible = NOT assigned)
            var allDivs = [...document.querySelectorAll('div')];
            for (var j = 0; j < allDivs.length; j++) {
                var div = allDivs[j];
                var dt = (div.textContent||'').trim();
                if (dt !== targetText || div.children.length > 0) continue;
                var dr = div.getBoundingClientRect();
                if (dr.width === 0 || dr.top < window.innerHeight * 0.5) continue;
                return 'slot-still-shows-text:' + targetText;
            }

            // Khong tim thay text "Start"/"End" → co the da duoc replace boi thumbnail
            return 'slot-text-gone:likely-assigned';
        })()`,
        returnByValue: true,
    });
    const verifyVal = verifyResult?.result?.value || '';
    console.log('[Komfy Video] B3 verify:', verifyVal);

    // Nhan ket qua
    const isSuccess = verifyVal.includes('hasImg=true') || verifyVal.includes('likely-assigned') || verifyVal.includes('slot-changed');
    if (!isSuccess) {
        console.warn('[Komfy Video] B3 verify uncertain for', slotType, '- continuing anyway');
    }

    console.log('[Komfy Video] Done:', slotType, isSuccess ? '✅' : '⚠️');
    return true; // Return true de khong block flow — Direct API se xu ly mediaId
}

/**
 * Upload 1 frame image (dataUrl) len Google Flow API → tra ve mediaId moi.
 * ★ Phase 2B: Delegate sang Electron FlowBroker (bearer token ảo trong ASAR).
 * @param {string} dataUrl - data:image/xxx;base64,...
 * @returns {string|null} - fresh mediaId or null
 */
async function uploadFrameImage(dataUrl) {
    if (!dataUrl || !sessionData.projectId) {
        console.warn('[Komfy Video] uploadFrameImage: missing dataUrl/projectId');
        return null;
    }

    try {
        const imageBytes = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        const mimeMatch = dataUrl.match(/^data:([^;]+);/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

        console.log('[Komfy Video] Uploading frame via Electron | size:', (imageBytes.length / 1024).toFixed(0), 'KB');

        const result = await callFlowAction('uploadImage', {
            projectId: sessionData.projectId,
            imageBytes,
            mimeType,
            fileName: 'komfy_frame.jpg',
            isHidden: true,
        });

        if (result?.ok && result?.mediaId) {
            console.log('[Komfy Video] ✅ Frame uploaded via Electron! mediaId:', result.mediaId);
            return result.mediaId;
        }

        console.warn('[Komfy Video] ⚠️ Electron upload failed:', result?.error || result?.status);
        return null;
    } catch (e) {
        console.error('[Komfy Video] uploadFrameImage error:', e.message);
        return null;
    }
}



/**
 * Xu ly I2V frame selection cho both start va end.
 * ★ CHIẾN LƯỢC MỚI:
 *   1. Re-upload ảnh từ dataUrl → lấy mediaIds MỚI (tránh stale cache)
 *   2. Cập nhật i2vData.startImage/endImage với mediaIds mới
 *   3. Fetch hook sẽ inject mediaIds mới vào API body khi submit
 *   4. UI slot click vẫn thử nhưng KHÔNG critical — fetch hook là chính
 *
 * @param {object} i2vData
 * @param {Function} send
 * @param {Function} sleep
 */
async function handleI2VFrameSelection(i2vData, send, sleep) {
    if (!i2vData) return;

    const startDataUrl = i2vData.startImageDataUrl || null;
    const endDataUrl   = i2vData.endImageDataUrl   || null;

    // ★ STRATEGY: Upload frames → lay fresh mediaIds.
    // Interceptor se REBUILD body hoan toan moi cho I2V endpoint.
    // KHONG fill UI slots — Asset Picker automation pha vo Video mode.

    if (startDataUrl) {
        console.log('[Komfy Video] Uploading Start frame for fresh mediaId...');
        const freshStartId = await uploadFrameImage(startDataUrl);
        if (freshStartId) {
            console.log('[Komfy Video] Start frame mediaId:', freshStartId.substring(0, 20));
            i2vData.startImage = freshStartId;
        } else {
            console.warn('[Komfy Video] Start frame upload failed, keeping old:', i2vData.startImage?.substring(0, 20));
        }
    }

    if (endDataUrl) {
        console.log('[Komfy Video] Uploading End frame for fresh mediaId...');
        const freshEndId = await uploadFrameImage(endDataUrl);
        if (freshEndId) {
            console.log('[Komfy Video] End frame mediaId:', freshEndId.substring(0, 20));
            i2vData.endImage = freshEndId;
        } else {
            console.warn('[Komfy Video] End frame upload failed, keeping old:', i2vData.endImage?.substring(0, 20));
        }
    }

    console.log('[Komfy Video] Frame mediaIds for interceptor: start=', i2vData.startImage?.substring(0, 20), '| end=', i2vData.endImage?.substring(0, 20));
    await sleep(300);
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
