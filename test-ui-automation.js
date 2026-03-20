/**
 * KOMFY FLOW UI AUTOMATION TEST SCRIPT
 * =====================================
 * Dán script này vào Chrome DevTools Console khi đang ở tab Google Flow.
 * Mục đích: Kiểm tra tất cả các tham số UI automation trước khi tích hợp vào extension.
 *
 * Cách dùng:
 *   1. Mở tab Google Flow (labs.google/fx/tools/flow/project/...)
 *   2. Nhấn F12 → Console
 *   3. Dán toàn bộ script này vào và nhấn Enter
 *   4. Xem kết quả từng bước in ra console
 */

(async function KOMFY_UI_TEST() {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function log(label, value) {
        console.log(`%c[KOMFY TEST] ${label}`, 'color:#00bcd4;font-weight:bold', value ?? '');
    }
    function ok(label) {
        console.log(`%c[✅ OK] ${label}`, 'color:#4caf50;font-weight:bold');
    }
    function fail(label, detail) {
        console.warn(`%c[❌ FAIL] ${label}`, 'color:#f44336;font-weight:bold', detail ?? '');
    }

    // =========================================================
    // STEP 1: Kiểm tra trạng thái trang
    // =========================================================
    log('STEP 1', 'Kiem tra trang thai trang...');
    const url = window.location.href;
    if (!url.includes('/project/')) {
        fail('URL khong phai project page!', url);
        return;
    }
    ok('URL OK: ' + url.substring(0, 80));

    const textbox = document.querySelector('[role="textbox"],[contenteditable="true"]');
    if (!textbox) {
        fail('Khong tim thay textbox (trang chua load xong?)');
        return;
    }
    ok('Textbox tim thay');

    // =========================================================
    // STEP 2: Quet bottom bar - tim tat ca buttons
    // =========================================================
    log('STEP 2', 'Quet bottom bar buttons...');
    const allBtns = [...document.querySelectorAll('button, [role="button"]')];
    const bottomBtns = allBtns.filter(b => {
        const r = b.getBoundingClientRect();
        return r.bottom > window.innerHeight - 150 && r.width > 0 && r.height > 0;
    });

    const bottomMap = bottomBtns.map(b => ({
        text: (b.textContent||'').trim().substring(0, 30),
        aria: (b.getAttribute('aria-label')||'').substring(0, 40),
        x: Math.round(b.getBoundingClientRect().left),
        w: Math.round(b.getBoundingClientRect().width),
    }));
    log('Bottom bar buttons', bottomMap);

    // Tim model selector button
    const modelBtn = bottomBtns.find(b => {
        const t = (b.textContent||'').toLowerCase();
        const r = b.getBoundingClientRect();
        return r.width > 60 && /x[1-4]|video|banana|imagen|veo/.test(t);
    });
    if (!modelBtn) {
        fail('Khong tim thay model selector button!', bottomMap);
        return;
    }
    ok('Model selector found: "' + (modelBtn.textContent||'').trim().substring(0,40) + '"');

    // =========================================================
    // STEP 3: Mo popover
    // =========================================================
    log('STEP 3', 'Click mo popover...');
    modelBtn.click();
    await sleep(800);

    let popover = document.querySelector('[data-radix-popper-content-wrapper],[data-radix-popover-content],[role="dialog"],[data-state="open"]');
    if (!popover) {
        fail('Popover khong xuat hien sau 800ms, thu cach khac...');
        // Thu cach khac: Tim element nao do co position fixed/absolute vua xuat hien
        const overlays = [...document.querySelectorAll('*')].filter(el => {
            const style = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return (style.position === 'fixed' || style.position === 'absolute')
                && r.width > 100 && r.height > 50
                && r.top < window.innerHeight / 2
                && el.querySelectorAll('[role="tab"]').length > 0;
        });
        log('Overlay candidates', overlays.map(el => ({ tag: el.tagName, class: el.className.substring(0,50), tabCount: el.querySelectorAll('[role="tab"]').length })));
        popover = overlays[0] || null;
    }

    if (popover) {
        ok('Popover found: ' + popover.tagName + ' class=' + popover.className.substring(0,50));
    } else {
        fail('Popover khong tim thay! Thử document scope...');
    }

    const scope = popover || document;

    // =========================================================
    // STEP 4: Tim tat ca tabs trong popover
    // =========================================================
    log('STEP 4', 'Quet tabs trong popover...');
    const tabs = [...scope.querySelectorAll('[role="tab"]')];
    const tabInfo = tabs.map(t => ({
        text: (t.textContent||'').trim(),
        selected: t.getAttribute('aria-selected'),
        x: Math.round(t.getBoundingClientRect().left),
        y: Math.round(t.getBoundingClientRect().top),
    }));
    log('Tabs found', tabInfo);
    if (tabs.length === 0) {
        fail('Khong co tab nao trong popover!');
    } else {
        ok(tabs.length + ' tabs found');
    }

    // =========================================================
    // STEP 5: Click tab "Video"
    // =========================================================
    log('STEP 5', 'Tim va click tab Video...');
    const videoTab = tabs.find(t => {
        const text = (t.textContent||'').toLowerCase().trim();
        return text === 'video' || (text.includes('video') && !text.includes('image') && !text.includes('x'));
    });
    if (!videoTab) {
        fail('Khong tim thay Video tab!', tabInfo);
    } else {
        if (videoTab.getAttribute('aria-selected') === 'true') {
            ok('Video tab da duoc chon san');
        } else {
            videoTab.click();
            await sleep(400);
            ok('Clicked Video tab: "' + videoTab.textContent.trim() + '"');
        }
    }

    // Quet lai tabs sau khi click Video (co the thay doi)
    await sleep(300);
    const tabs2 = [...scope.querySelectorAll('[role="tab"]')];
    const tabInfo2 = tabs2.map(t => ({ text: (t.textContent||'').trim(), selected: t.getAttribute('aria-selected') }));
    log('Tabs after Video click', tabInfo2);

    // =========================================================
    // STEP 6: Tim va click Landscape/Portrait
    // =========================================================
    log('STEP 6', 'Tim tab aspect ratio (Landscape/Portrait)...');
    const arTargets = ['portrait', 'landscape'];
    for (const target of arTargets) {
        const arTab = tabs2.find(t => (t.textContent||'').toLowerCase().trim().includes(target));
        if (arTab) {
            ok('Found AR tab "' + arTab.textContent.trim() + '" selected=' + arTab.getAttribute('aria-selected'));
        } else {
            fail('Khong tim thay tab "' + target + '"');
        }
    }

    // Thu click Portrait
    const portraitTab = tabs2.find(t => (t.textContent||'').toLowerCase().includes('portrait'));
    if (portraitTab) {
        portraitTab.click();
        await sleep(300);
        ok('Clicked Portrait tab');
    }

    // =========================================================
    // STEP 7: Tim count selector (x1/x2/x3/x4)
    // =========================================================
    log('STEP 7', 'Tim count tabs (x1, x2, x3, x4)...');
    const countTabs = tabs2.filter(t => /^x[1-4]$/.test((t.textContent||'').trim()));
    log('Count tabs', countTabs.map(t => ({ text: t.textContent.trim(), selected: t.getAttribute('aria-selected') })));
    const x1Tab = countTabs.find(t => t.textContent.trim() === 'x1');
    if (x1Tab) {
        ok('Found x1 tab, selected=' + x1Tab.getAttribute('aria-selected'));
        if (x1Tab.getAttribute('aria-selected') !== 'true') {
            x1Tab.click();
            await sleep(200);
            ok('Clicked x1');
        }
    } else {
        fail('Khong tim thay x1 tab!');
    }

    // =========================================================
    // STEP 8: Tim model dropdown (Veo 3.1 Fast/Quality...)
    // =========================================================
    log('STEP 8', 'Tim model dropdown...');
    // Tim select hoac button co text "Veo"
    const modelDropdown = scope.querySelector('select, [role="listbox"], [role="combobox"]');
    const modelBtnInPopover = [...(scope.querySelectorAll('button, [role="button"]'))].find(b => {
        const t = (b.textContent||'').toLowerCase();
        return t.includes('veo') || t.includes('fast') || t.includes('quality');
    });

    if (modelDropdown) {
        log('Model dropdown (native select)', { tag: modelDropdown.tagName, value: modelDropdown.value });
        ok('Found model dropdown');
    } else if (modelBtnInPopover) {
        log('Model button in popover', { text: (modelBtnInPopover.textContent||'').trim() });
        ok('Found model button');
    } else {
        // Tim tat ca buttons trong popover
        const popBtns = [...scope.querySelectorAll('button, [role="button"], [class*="dropdown"], [class*="select"]')];
        log('All popover clickables', popBtns.map(b => ({ text: (b.textContent||'').trim().substring(0,30), tag: b.tagName })));
        fail('Khong tim thay model selector trong popover');
    }

    // =========================================================
    // STEP 9: Tim Start/End frame slots (khi o Video mode)
    // =========================================================
    log('STEP 9', 'Dong popover va tim Start/End frame slots...');
    document.body.click(); // Dong popover
    await sleep(600);

    const swapBtn = document.querySelector('[aria-label*="Swap"],[aria-label*="swap"],[aria-label*="first and last"]');
    if (swapBtn) {
        ok('Swap button found: ' + swapBtn.getAttribute('aria-label'));
        const parent = swapBtn.parentElement;
        const children = [...parent.children];
        const swapIdx = children.indexOf(swapBtn);
        log('Swap siblings', children.map((c,i) => ({
            i, tag: c.tagName,
            text: (c.textContent||'').trim().substring(0,20),
            aria: (c.getAttribute('aria-label')||'').substring(0,30),
            x: Math.round(c.getBoundingClientRect().left),
        })));
        const startSlot = swapIdx > 0 ? children[swapIdx - 1] : null;
        const endSlot = swapIdx < children.length - 1 ? children[swapIdx + 1] : null;
        if (startSlot) ok('Start slot (left of swap): "' + (startSlot.textContent||'').trim().substring(0,20) + '"');
        if (endSlot) ok('End slot (right of swap): "' + (endSlot.textContent||'').trim().substring(0,20) + '"');
    } else {
        // Fallback: Tim theo text "Start" / "End"
        const bottomBtnsNow = [...document.querySelectorAll('button, [role="button"]')].filter(b => {
            const r = b.getBoundingClientRect();
            return r.bottom > window.innerHeight - 150 && r.width > 0;
        });
        const startBtn = bottomBtnsNow.find(b => (b.textContent||'').trim().toLowerCase().includes('start'));
        const endBtn = bottomBtnsNow.find(b => (b.textContent||'').trim().toLowerCase().includes('end'));
        if (startBtn) ok('Start button by text: "' + startBtn.textContent.trim() + '"');
        else fail('Khong tim thay Start slot!');
        if (endBtn) ok('End button by text: "' + endBtn.textContent.trim() + '"');
        else fail('Khong tim thay End slot');

        // Log tat ca bottom buttons de debug
        log('All bottom buttons (for debug)', bottomBtnsNow.map(b => ({
            text: (b.textContent||'').trim().substring(0,25),
            aria: (b.getAttribute('aria-label')||'').substring(0,30),
            x: Math.round(b.getBoundingClientRect().left),
            w: Math.round(b.getBoundingClientRect().width),
        })));
    }

    // =========================================================
    // STEP 10: Final summary
    // =========================================================
    log('STEP 10', '=== TEST COMPLETE ===');
    log('Ket qua', 'Xem tat ca [OK] va [FAIL] o tren de bien soan code chinh xac');
    log('Action can lam', 'Copy cac selector da OK vao video-gen.js');

})();
