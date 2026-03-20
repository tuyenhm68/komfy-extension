// KOMFY TEST - Paste TOAN BO vao Console, bam Enter 1 lan
// Moi thu nam trong 1 IIFE, khong co khai bao ngoai

(async function KOMFY_TEST() {
    var P = 0, F = 0;
    function ok(s,m)   { console.log('\u2705 [PASS] '+s+': '+m); P++; }
    function fail(s,m) { console.error('\u274c [FAIL] '+s+': '+m); F++; }
    function info(m)   { console.log('\u2139\ufe0f '+m); }
    function sep(t)    { console.log('--- '+t+' ---'); }
    function sleep(ms) { return new Promise(function(r){setTimeout(r,ms);}); }

    function triggerClick(el) {
        if (!el) return;
        el.dispatchEvent(new PointerEvent('pointerover',  {bubbles:true,composed:true}));
        el.dispatchEvent(new PointerEvent('pointerenter', {bubbles:true,composed:true}));
        el.dispatchEvent(new PointerEvent('pointerdown',  {bubbles:true,cancelable:true,composed:true,isPrimary:true}));
        el.dispatchEvent(new MouseEvent('mousedown',      {bubbles:true,cancelable:true,button:0}));
        el.dispatchEvent(new PointerEvent('pointerup',    {bubbles:true,cancelable:true,composed:true,isPrimary:true}));
        el.dispatchEvent(new MouseEvent('mouseup',        {bubbles:true,cancelable:true,button:0}));
        el.dispatchEvent(new MouseEvent('click',          {bubbles:true,cancelable:true,button:0}));
    }

    // ===== S1: URL =====
    sep('S1: URL');
    if (location.href.includes('/project/')) ok('url','Project page OK');
    else { fail('url','Not a project page: '+location.href); return; }

    // ===== S2: Bottom bar survey =====
    sep('S2: Bottom bar buttons');
    var bottomBtns = Array.from(document.querySelectorAll('button,[role="button"]')).filter(function(b){
        var r = b.getBoundingClientRect();
        return r.bottom > window.innerHeight-150 && r.height > 0 && r.width > 0;
    });
    info('Count: '+bottomBtns.length);
    bottomBtns.forEach(function(b,i){
        var r = b.getBoundingClientRect();
        info('['+i+'] w='+Math.round(r.width)+' aria="'+(b.getAttribute('aria-label')||'')+'" text="'+(b.textContent||'').trim().substring(0,30)+'"');
    });

    var modelBtn = bottomBtns.find(function(b){
        var t = (b.textContent||'').toLowerCase();
        var a = (b.getAttribute('aria-label')||'').toLowerCase();
        return b.getBoundingClientRect().width > 60 && !t.includes('arrow_forward') && !a.includes('create') && !t.includes('create');
    });
    if (modelBtn) ok('modelBtn','"'+(modelBtn.textContent||'').trim().substring(0,40)+'"');
    else { fail('modelBtn','Not found!'); }

    // ===== S3: Swap button =====
    sep('S3: Swap button');
    var swapEl = document.querySelector('[aria-label*="Swap"],[aria-label*="swap"],[aria-label*="first and last"]');
    if (swapEl) {
        ok('swap.aria','"'+(swapEl.getAttribute('aria-label')||'')+'"');
    } else {
        info('aria-label not found, trying text...');
        swapEl = bottomBtns.find(function(b){
            var t = (b.textContent||'').trim().toLowerCase();
            return t.includes('swap') || t.includes('horiz');
        });
        if (swapEl) ok('swap.text','"'+(swapEl.textContent||'').trim().substring(0,30)+'"');
        else fail('swap','Not found by any method!');
    }

    if (swapEl) {
        var siblings = Array.from(swapEl.parentElement.children);
        var si = siblings.indexOf(swapEl);
        info('Parent children: '+siblings.length+', swapIdx: '+si);
        siblings.forEach(function(c,i){
            info('  ['+i+']: tag='+c.tagName+' text="'+(c.textContent||'').trim().substring(0,20)+'"');
        });
        var sStart = si > 0 ? siblings[si-1] : null;
        var sEnd   = si < siblings.length-1 ? siblings[si+1] : null;
        if (sStart) ok('slot.start','"'+(sStart.textContent||'').trim().substring(0,20)+'"');
        else fail('slot.start','No left sibling');
        if (sEnd)   ok('slot.end',  '"'+(sEnd.textContent||'').trim().substring(0,20)+'"');
        else fail('slot.end',  'No right sibling');
    }

    // ===== S4: Open popover =====
    sep('S4: Open popover (triggerClick)');
    if (!modelBtn) { fail('S4','Skip'); } else {
        info('triggerClick on "' + (modelBtn.textContent||'').trim().substring(0,30) + '"');
        triggerClick(modelBtn);
        await sleep(1000);

        var pop = document.querySelector('[data-radix-popper-content-wrapper]');
        if (pop) {
            ok('popover.open','Opened!');
            var tabs = Array.from(pop.querySelectorAll('[role="tab"]'));
            info('Tabs ('+tabs.length+'): '+tabs.map(function(t){return '"'+(t.textContent||'').trim()+'"';}).join(', '));

            var vTab = tabs.find(function(t){return (t.textContent||'').trim().toLowerCase()==='video';});
            if (vTab) ok('tab.video','selected='+vTab.getAttribute('aria-selected'));
            else fail('tab.video','Not found');

            var pTab = tabs.find(function(t){return (t.textContent||'').trim().toLowerCase()==='portrait';});
            if (pTab) ok('tab.portrait','OK');
            else fail('tab.portrait','Not found');

            var veoBtn = Array.from(pop.querySelectorAll('button')).find(function(b){
                return (b.textContent||'').toLowerCase().includes('veo');
            });
            if (veoBtn) ok('veo.btn','"'+(veoBtn.textContent||'').replace(/arrow_drop_down/gi,'').trim().substring(0,40)+'"');
            else {
                fail('veo.btn','Not found');
                info('Popover btns: '+Array.from(pop.querySelectorAll('button')).map(function(b){return '"'+(b.textContent||'').trim().substring(0,20)+'"';}).join(','));
            }

            document.body.click();
            await sleep(500);
            if (!document.querySelector('[data-radix-popper-content-wrapper]')) ok('popover.close','Closed OK');
            else fail('popover.close','Still open!');

        } else {
            fail('popover.open','NOT opened after 1s');
            info('Try Space key...');
            modelBtn.focus();
            modelBtn.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));
            await sleep(700);
            if (document.querySelector('[data-radix-popper-content-wrapper]')) ok('popover.space','Space key worked!');
            else fail('popover.space','Space key also failed');
            document.body.click();
        }
    }

    // ===== S5: Click Start slot =====
    sep('S5: Click Start slot -> gallery');
    if (!swapEl) { fail('S5','Skip'); } else {
        var sib5 = Array.from(swapEl.parentElement.children);
        var si5  = sib5.indexOf(swapEl);
        var slot5 = si5 > 0 ? sib5[si5-1] : null;
        if (!slot5) { fail('S5.slot','No start'); } else {
            info('Clicking: "' + (slot5.textContent||'').trim().substring(0,20) + '"');
            triggerClick(slot5);
            await sleep(1300);

            var imgs = Array.from(document.querySelectorAll('img')).filter(function(img){
                var r = img.getBoundingClientRect();
                return r.top < window.innerHeight*0.85 && r.width > 40 && r.height > 40;
            });
            if (imgs.length > 0) {
                ok('S5.gallery','Gallery open! '+imgs.length+' images');
                document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
                await sleep(400);
            } else {
                fail('S5.gallery','No images after click');
                var overlays = Array.from(document.querySelectorAll('[role="dialog"],[data-state="open"]'));
                info('Open overlays: '+overlays.map(function(o){return o.tagName+'['+o.getAttribute('role')+']';}).join(','));
                document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
            }
        }
    }

    // ===== RESULT =====
    sep('RESULT: '+P+' PASS, '+F+' FAIL / '+(P+F)+' total');
    if (F===0) console.log('%c ALL PASSED!','color:#4caf50;font-size:16px;font-weight:bold');

}).call(this);
