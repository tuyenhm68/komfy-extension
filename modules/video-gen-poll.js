// ============================================================
// video-gen-poll.js
// Phase polling: sau khi submit, poll DOM + progress + error detect
// Giao dien: pollForGenerationResult(scriptEval, opts) -> generationId
// ============================================================

const PROXY_PROGRESS_URL = 'http://127.0.0.1:3120/api/internal/gen-progress';

async function pollForGenerationResult(scriptEval, opts) {
    const { requestId, beforeIds, beforeVideoSrcs, beforeVideoCount, beforeContainerCount, currentSessionId } = opts;

    let generationId = null;
    let pendingGenId = null;
    let pendingGenIdAt = 0;
    let pollCount = 0;
    let lastProgressPct = 0;   // Gia tri progress thuc te cuoi cung (tu Flow UI)
    let lastProgressTime = Date.now();
    const genStartTime = Date.now();
    const STALL_WARN_MS  = 5 * 60 * 1000;
    const STALL_ERROR_MS = 12 * 60 * 1000;

    // Neu co pendingGenId nhung khong tim duoc exact card doi toi da
    const MAX_WAIT_AFTER_GENID_MS = 8 * 60 * 1000;

    // New-card scan chi bat dau sau 90s (dam bao video moi DA RENDER xong)
    // Truoc do: 30s qua som — video chua san sang (chi 30% progress) nhung scan
    // van chay va pick video cu vi URL format thay doi sau re-render.
    // Gio uu tien: genId exact-match (tu content_fetch_interceptor message)
    //              + MutationObserver (tu pre-submit video snapshot)
    // New-card scan chi la FALLBACK cuoi cung.
    const NEW_CARD_SCAN_AFTER_MS = 90 * 1000;

    while (true) {
        const now = Date.now();
        const stalledMs = now - lastProgressTime;
        const elapsedMs = now - genStartTime;
        const sleepMs = lastProgressPct > 0 ? 2000 : 3000;
        await new Promise(r => setTimeout(r, sleepMs));
        pollCount++;

        // ===================================================================
        // 1. Detect loi tu Flow UI
        // ===================================================================
        const errorInfo = await scriptEval((beforeIdsArr, sessionKey) => {
            // ★ Fetch hook error — DAY la error cua CHINH task nay (session-scoped)
            if (window.__komfy_genError__) return { type: 'fetch', msg: window.__komfy_genError__, scoped: true };

            // ★ SCOPING: Kiem tra co progress bar active khong
            // Neu co nhieu task chay concurrent, 1 task fail hien toast
            // → toast la GLOBAL, co the la cua task KHAC → khong nen fail task nay
            // Chi trust global toast khi KHONG co progress bar active nao khac
            var activeProgressCount = 0;
            var styled = document.querySelectorAll('[style*="width"]');
            for (var p = 0; p < styled.length; p++) {
                var sw = styled[p].style.width;
                if (!sw || sw.indexOf('%') < 0) continue;
                var pf = parseFloat(sw);
                if (isNaN(pf) || pf <= 1 || pf >= 100) continue;
                var rect = styled[p].getBoundingClientRect();
                if (rect.height > 0 && rect.height < 15 && rect.width > 10) activeProgressCount++;
            }

            const strictKeywords = [
                'audio generation failed', 'video generation failed', 'generation failed',
                'blocked by safety', 'quota exceeded', 'rate limit exceeded', 'unable to generate',
                'might violate', 'violate our policies', 'content policy',
            ];
            var alertEls = [
                ...document.querySelectorAll('[role="alert"]'),
                ...document.querySelectorAll('[aria-live="assertive"]'),
            ];
            for (var i = 0; i < alertEls.length; i++) {
                var t = (alertEls[i].textContent || '').toLowerCase().trim();
                if (!t || t.length < 10 || t.length > 500) continue;
                for (var k = 0; k < strictKeywords.length; k++) {
                    if (t.includes(strictKeywords[k])) {
                        return { type: 'toast', msg: (alertEls[i].textContent || '').trim().substring(0, 200),
                                 activeProgressCount: activeProgressCount, scoped: false };
                    }
                }
            }
            // Card-level error detection — DAY la SCOPED (chi check card MOI, khong trong beforeIds)
            var beforeSet = new Set(beforeIdsArr || []);
            var allCards = document.querySelectorAll('[data-generation-id]');
            for (var c = 0; c < allCards.length; c++) {
                var genId = allCards[c].getAttribute('data-generation-id');
                if (beforeSet.has(genId)) continue;
                var cardText = (allCards[c].textContent || '').toLowerCase();
                var cardFailKeywords = ['audio generation failed', 'video generation failed', 'generation failed', 'failed to generate'];
                for (var kk = 0; kk < cardFailKeywords.length; kk++) {
                    if (cardText.includes(cardFailKeywords[kk])) {
                        return { type: 'card', msg: (allCards[c].textContent || '').replace(/\s+/g, ' ').trim().substring(0, 300), scoped: true };
                    }
                }
            }
            return null;
        }, [...beforeIds], currentSessionId);

        if (errorInfo) {
            if (errorInfo.scoped) {
                // Error ro rang la cua task nay → fail ngay
                throw new Error(`Video generation failed: ${errorInfo.msg || 'Unknown error from Flow'}`);
            } else if (errorInfo.activeProgressCount <= 1) {
                // Toast error va chi co 0-1 progress bar (cua chinh task nay) → likely loi cua task nay
                throw new Error(`Video generation failed: ${errorInfo.msg || 'Unknown error from Flow'}`);
            } else {
                // Toast error NHUNG co nhieu progress bar active → co the la loi cua task KHAC
                // Chi log warning, khong fail
                if (pollCount % 10 === 1) {
                    console.warn(`[Komfy Video] ⚠️ Toast error detected but ${errorInfo.activeProgressCount} progress bars active — may be from another task:`, errorInfo.msg?.substring(0, 60));
                }
            }
        }

        // ===================================================================
        // 2. Capture pendingGenId tu fetch hook
        //    3 lop bao ve chong nham genId cu:
        //    (a) Hook chi capture khi __komfy_clickTime != null (sau submit)
        //    (b) Poll kiem tra __komfy_genIdAt__ > submitTimestamp (temporal)
        //    (c) Poll kiem tra genId NOT IN beforeIds (khong phai card cu)
        // ===================================================================
        if (!pendingGenId) {
            const freshData = await scriptEval((sid, submitTs) => {
                if (!window.__komfy_genId__) return null;
                // (a) Neu sessionId khong match → tu session cu, bo qua
                if (window.__komfy_genSid__ && window.__komfy_genSid__ !== sid) return null;
                // (b) Neu genId duoc capture TRUOC submit → stale, bo qua
                if (window.__komfy_genIdAt__ && submitTs && window.__komfy_genIdAt__ < submitTs) {
                    console.log('[Komfy Poll] Rejected stale genId (captured before submit):', window.__komfy_genId__?.substring(0,25));
                    return null;
                }
                return { genId: window.__komfy_genId__, capturedAt: window.__komfy_genIdAt__ || 0 };
            }, [opts.currentSessionId, opts.submitTimestamp || 0]);

            if (freshData?.genId) {
                const freshGenId = freshData.genId;
                // (c) Kiem tra genId khong nam trong beforeIds (card da ton tai truoc submit)
                const isInBefore = beforeIds.has(freshGenId);
                // Kiem tra them phan cuoi cua genId (UUID part)
                let lastPart = freshGenId;
                if (freshGenId.includes('/')) {
                    const parts = freshGenId.split('/');
                    lastPart = parts[parts.length - 1];
                }
                const isLastPartInBefore = lastPart !== freshGenId && lastPart.length > 8 && beforeIds.has(lastPart);

                if (isInBefore || isLastPartInBefore) {
                    console.warn(`[Komfy Video] ⚠️ Rejected stale genId (in beforeIds): "${freshGenId.substring(0,25)}" | lastPart="${lastPart.substring(0,15)}"`);
                    // Clear stale genId de khong bi reject lai o vong poll tiep theo
                    await scriptEval(() => { window.__komfy_genId__ = null; window.__komfy_genIdAt__ = null; });
                } else {
                    pendingGenId = freshGenId;
                    pendingGenIdAt = Date.now();
                    lastProgressTime = Date.now();
                    console.log(`[Komfy Video] 📌 pendingGenId: "${pendingGenId}" | capturedAt: ${freshData.capturedAt}`);
                }
            }
        }

        // ===================================================================
        // 3. VIDEO DETECTION
        // Strategy uu tien:
        //   3a) Exact card match: [data-generation-id === pendingGenId]
        //   3b) New-card scan: card MOI (id khong trong beforeIds) co video
        //       Chi chay khi: elapsedMs > NEW_CARD_SCAN_AFTER_MS
        //       Khong can pendingGenId, an toan vi beforeIds da capture het card cu
        //       (scroll tat ca custom containers truoc snapshot)
        //
        // Sau fix nay, "nham video cu" khong the xay ra vi:
        //   - beforeIds chứa TAT CA card IDs hien tai (scroll tat ca containers)
        //   - New-card chi accept ID CHUA CO trong beforeIds
        // ===================================================================

        // 3a) Exact card match (khi co pendingGenId)
        if (pendingGenId) {
            // Timeout: neu doi qua lau → tra pendingGenId truc tiep
            const waitedSinceGenId = Date.now() - pendingGenIdAt;
            if (waitedSinceGenId > MAX_WAIT_AFTER_GENID_MS) {
                generationId = pendingGenId;
                console.warn(`[Komfy Video] ⚠️ Timeout ${(waitedSinceGenId/60000).toFixed(1)}min: using pendingGenId directly.`);
                fetch(PROXY_PROGRESS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId: sessionData.clientId, requestId, percent: 100, message: '' }) }).catch(() => {});
                break;
            }

            const cardState = await scriptEval(function(expectedGenId) {
                function readSrc(el) { return (el && (el.src || el.getAttribute('src'))) || ''; }

                // Normalized: thu match ca UUID hoan chinh va path cuoi
                var tryIds = [expectedGenId];
                if (expectedGenId && expectedGenId.includes('/')) {
                    var parts = expectedGenId.split('/');
                    var last = parts[parts.length - 1];
                    if (last && last.length > 8) tryIds.push(last);
                }

                var card = null;
                for (var t = 0; t < tryIds.length && !card; t++) {
                    var safeId = tryIds[t].replace(/"/g, '\\"');
                    card = document.querySelector('[data-generation-id="' + safeId + '"]')
                        || document.querySelector('[data-generation-id*="' + tryIds[t].substring(0, 16) + '"]');
                }

                if (!card) {
                    // Debug: list first 5 card IDs de so sanh format
                    var dbgCards = [];
                    document.querySelectorAll('[data-generation-id]').forEach(function(el) {
                        if (dbgCards.length < 5) dbgCards.push(el.getAttribute('data-generation-id'));
                    });
                    return { found: false, cardExists: false, debug: dbgCards };
                }

                var video = card.querySelector('video[src]');
                if (video && video.src && video.src.length > 10) {
                    return { found: true, videoSrc: video.src };
                }
                var source = card.querySelector('source[src]');
                if (source) {
                    var s = source.getAttribute('src');
                    if (s && s.length > 10) return { found: true, videoSrc: s };
                }
                return { found: false, cardExists: true };
            }, pendingGenId);

            if (cardState?.found) {
                // Extract proper generationId tu videoSrc
                var rawSrc = cardState.videoSrc;
                var finalId = pendingGenId;
                if (rawSrc.includes('media.getMediaUrlRedirect')) {
                    try { var n = new URL(rawSrc).searchParams.get('name'); if (n) finalId = 'MEDIA:' + n; } catch(e) {}
                } else {
                    var m2 = rawSrc.match(/ai-sandbox-videofx\/(?:image|video)\/([a-f0-9-]{32,36})/);
                    if (m2) finalId = m2[1];
                }
                generationId = finalId;
                console.log(`[Komfy Video] ✅ Exact card match! pendingGenId=${pendingGenId.substring(0,25)} → id=${generationId.substring(0,40)} | ${((Date.now()-genStartTime)/1000).toFixed(0)}s`);
                fetch(PROXY_PROGRESS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId: sessionData.clientId, requestId, percent: 100, message: '' }) }).catch(() => {});
                break;
            }

            if (pollCount % 5 === 0) {
                const dbg = cardState?.debug ? `domCards=[${cardState.debug.map(id => id?.substring(0,15)).join(',')}]` : `cardExists=${cardState?.cardExists}`;
                console.log(`[Komfy Video] Polling exact-card... pendingGenId=${pendingGenId.substring(0,20)} | pct=${lastProgressPct}% | ${dbg}`);
            }
        }

        // 3b-pre) MutationObserver fallback: kiem tra session-specific __komfy_newVideoSrc_{sessionId}
        //   Observer duoc install TRUOC submit voi snapshot chinh xac cua tat ca video src
        //   → khong phu thuoc beforeIds (co the rong sau page reload)
        //   → khong phu thuoc fetch hook (co the bi bypass)
        //   ★ SESSION ISOLATION: doc tu key rieng cua session nay, tranh cross-task interference
        if (!pendingGenId && !generationId && elapsedMs > 5000) {
            const obsResult = await scriptEval((sessionKey) => {
                var src = window['__komfy_newVideoSrc_' + sessionKey];
                if (!src) return null;
                // Extract media ID tu URL
                var mediaId = null;
                if (src.includes('media.getMediaUrlRedirect')) {
                    try { var m = src.match(/name=([^&]+)/); if (m) mediaId = 'MEDIA:' + m[1]; } catch(e) {}
                }
                if (!mediaId) {
                    var m2 = src.match(/ai-sandbox-videofx\/(?:image|video)\/([a-f0-9-]{32,36})/);
                    if (m2) mediaId = m2[1];
                }
                return { src: src, mediaId: mediaId, capturedAt: window['__komfy_newVideoAt_' + sessionKey] };
            }, [currentSessionId]);
            if (obsResult?.src) {
                // Neu co mediaId → dung mediaId (download module tim trong DOM)
                // Neu khong → dung DIRECT:url (download module fetch truc tiep)
                generationId = obsResult.mediaId || ('DIRECT:' + obsResult.src);
                console.log(`[Komfy Video] ✅ MutationObserver detected new video! id=${generationId.substring(0,40)} | src=${obsResult.src.substring(0,60)} | elapsed=${(elapsedMs/1000).toFixed(0)}s`);
                fetch(PROXY_PROGRESS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId: sessionData.clientId, requestId, percent: 100, message: '' }) }).catch(() => {});
                break;
            }
        }

        // 3b) New-card scan: CHI chay khi CHUA co pendingGenId
        //     Khi da co pendingGenId, CHI dung exact-card match (3a) de tranh
        //     nham video cu (URL thay doi sau re-render khi tao video moi).
        //     Fallback: neu khong co pendingGenId sau 30s → scan card moi.
        if (!pendingGenId && elapsedMs > NEW_CARD_SCAN_AFTER_MS) {
            const newCard = await scriptEval(function(beforeIdsArr, beforeSrcsArr) {
                var beforeSet = new Set(beforeIdsArr || []);
                var beforeSrcs = new Set(beforeSrcsArr || []);
                
                // Thu 1: Quet tat ca cac the video/source tren DOM (chi lay the lon hon 120px - bo qua thumbnail)
                var allVideos = document.querySelectorAll('video');
                for (var v = 0; v < allVideos.length; v++) {
                    var vid = allVideos[v];
                    var r = vid.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0 && r.width < 120 && r.height < 120) continue; // Bo qua thumbnail Ingredient nho xiu
                    
                    var src = vid.src || vid.currentSrc || vid.getAttribute('src');
                    var isNew = false;
                    var extractMediaId = function(url) {
                        if (!url || typeof url !== 'string') return null;
                        if (url.includes('media.getMediaUrlRedirect')) {
                            try { var m = url.match(/name=([^&]+)/); if (m) return 'MEDIA:' + m[1]; } catch(e){}
                        }
                        var m2 = url.match(/ai-sandbox-videofx\/(?:image|video)\/([a-f0-9-]{32,36})/);
                        if (m2) return m2[1];
                        return null;
                    };

                    if (src && src.length > 10) {
                        var id1 = extractMediaId(src);
                        if (id1 && beforeSet.has(id1)) isNew = false;
                        else if (!beforeSrcs.has(src)) isNew = true;
                    }
                    if (!isNew) {
                        var source = vid.querySelector('source[src]');
                        if (source) {
                            var ssrc = source.getAttribute('src');
                            if (ssrc && ssrc.length > 10) {
                                var id2 = extractMediaId(ssrc);
                                if (id2 && beforeSet.has(id2)) isNew = false;
                                else if (!beforeSrcs.has(ssrc)) { src = ssrc; isNew = true; }
                            }
                        }
                    }
                    if (isNew) {
                        // Da tim thay 1 URL video moi! Thu tim card chua no de lay ID.
                        var p = vid.parentElement;
                        var cardId = 'MEDIA_' + Date.now(); // default
                        while (p && p.tagName !== 'BODY') {
                            var id = p.getAttribute('data-generation-id');
                            if (id && id.length > 4) { cardId = id; break; }
                            p = p.parentElement;
                        }
                        if (beforeSet.has(cardId)) continue; // Xung dot
                        return { cardId: cardId, videoSrc: src };
                    }
                }
                
                // Thu 2: Fallback nhu cu tim the card
                var cards = document.querySelectorAll('[data-generation-id]');
                var found = null;
                for (var c = 0; c < cards.length; c++) {
                    var cardId = (cards[c].getAttribute('data-generation-id') || '').trim();
                    if (!cardId || cardId.length < 4 || beforeSet.has(cardId)) continue;
                    var tagVid = cards[c].querySelector('video');
                    if (!tagVid) continue;
                    var csrc = tagVid.src || tagVid.getAttribute('src') || (tagVid.querySelector('source') && tagVid.querySelector('source').getAttribute('src'));
                    if (!csrc || csrc.length < 10) continue;
                    if (!found) found = { cardId, videoSrc: csrc };
                }
                return found;
            }, [...beforeIds], [...beforeVideoSrcs]);

            if (newCard) {
                var rawSrc = newCard.videoSrc;
                var finalId = newCard.cardId;
                if (rawSrc.includes('media.getMediaUrlRedirect')) {
                    try { var n = new URL(rawSrc).searchParams.get('name'); if (n) finalId = 'MEDIA:' + n; } catch(e) {}
                } else {
                    var m = rawSrc.match(/ai-sandbox-videofx\/(?:image|video)\/([a-f0-9-]{32,36})/);
                    if (m) finalId = m[1];
                }
                generationId = finalId;
                console.log(`[Komfy Video] ✅ New-card scan: cardId=${newCard.cardId.substring(0,20)} → id=${generationId.substring(0,40)} | elapsed=${(elapsedMs/1000).toFixed(0)}s | pendingGenId=${pendingGenId ? pendingGenId.substring(0,15) : 'N/A'}`);
                fetch(PROXY_PROGRESS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId: sessionData.clientId, requestId, percent: 100, message: '' }) }).catch(() => {});
                break;
            }

            if (!pendingGenId && elapsedMs > 45000 && lastProgressPct === 0) {
                // Check no-start
                const uiActivity = await scriptEval(() => {
                    var spinners = document.querySelectorAll('[class*="loading"],[class*="spinner"],[class*="progress"],[class*="generating"]');
                    var progressBars = [];
                    document.querySelectorAll('[style*="width"]').forEach(el => {
                        var sw = el.style.width;
                        if (sw && sw.includes('%') && parseFloat(sw) > 0 && parseFloat(sw) < 100) {
                            var r = el.getBoundingClientRect();
                            if (r.height > 0 && r.height < 12) progressBars.push(sw);
                        }
                    });
                    return { hasSpinner: spinners.length > 0, hasProgressBar: progressBars.length > 0 };
                }) || {};

                if (!uiActivity.hasSpinner && !uiActivity.hasProgressBar) {
                    throw new Error('Video generation failed: Generation was not started. Please retry.');
                }
                if (pollCount % 5 === 0) console.warn(`[Komfy Video] ⚠️ 45s no genId, no new card, but UI active...`);
            }
        }

        // ===================================================================
        // 4. Doc progress THUC TE tu Flow UI DOM
        //    KHONG dung time-based estimate.
        //    Neu khong tim duoc progress bar → giu nguyen % cu (khong tang ao)
        // ===================================================================
        try {
            const progressData = await scriptEval(function() {
                var best = 0, bestSrc = '';

                // Method A: aria-valuenow (role=progressbar)
                var ariaEls = document.querySelectorAll('[aria-valuenow]');
                for (var a = 0; a < ariaEls.length; a++) {
                    var role = ariaEls[a].getAttribute('role') || '';
                    if (role !== 'progressbar' && role !== 'slider') continue;
                    var av = parseFloat(ariaEls[a].getAttribute('aria-valuenow') || '');
                    var amax = parseFloat(ariaEls[a].getAttribute('aria-valuemax') || '100');
                    if (isNaN(av) || av <= 0 || isNaN(amax) || amax <= 0) continue;
                    var apct = Math.round((av / amax) * 100);
                    if (apct <= 1 || apct >= 100) continue;
                    if (apct > best) { best = apct; bestSrc = 'aria'; }
                }

                // Method B: style="width: X%"
                if (best === 0) {
                    var styled = document.querySelectorAll('[style*="width"]');
                    for (var i = 0; i < styled.length; i++) {
                        var el = styled[i];
                        var sw = el.style.width;
                        if (!sw || sw.indexOf('%') < 0) continue;
                        var pf = parseFloat(sw);
                        if (isNaN(pf) || pf <= 1 || pf >= 100) continue;
                        var r = el.getBoundingClientRect();
                        if (r.height < 1 || r.height > 20 || r.width < 5) continue;
                        var cls = (el.className || '').toLowerCase();
                        var isProgressLike = /progress|loading|fill|bar|track|indicator/.test(cls);
                        if (!isProgressLike) continue; // Chi lay thanh co class progress-like, bo qua generic width
                        var ipct = Math.round(pf);
                        if (ipct > best) { best = ipct; bestSrc = 'style:' + cls.substring(0, 20); }
                    }
                }

                // Method C: Text containing "X%" in small elements
                if (best === 0) {
                    var spans = document.querySelectorAll('span, div, p, text, label');
                    for (var i = 0; i < spans.length; i++) {
                        var txt = (spans[i].textContent || '').trim();
                        var m = txt.match(/^(\d{1,3})\s*%$/); // Tim text dung dang "45%" hoac "45 %"
                        if (m) {
                            var val = parseInt(m[1], 10);
                            if (val > 0 && val < 100 && val > best) {
                                best = val; bestSrc = 'text';
                            }
                        }
                    }
                }

                // Method D: SVG Circular Progress (stroke-dashoffset)
                if (best === 0) {
                    var circles = document.querySelectorAll('circle[stroke-dasharray]');
                    for (var i = 0; i < circles.length; i++) {
                        var array = parseFloat(circles[i].getAttribute('stroke-dasharray'));
                        var offsetRaw = circles[i].getAttribute('stroke-dashoffset') || circles[i].style.strokeDashoffset;
                        var offset = parseFloat(offsetRaw);
                        if (array > 0 && !isNaN(offset)) {
                            // offset chay tu array (0%) den 0 (100%)
                            var val = Math.round(((array - Math.max(0, offset)) / array) * 100);
                            if (val > 0 && val < 100 && val > best) {
                                best = val; bestSrc = 'svg-circle';
                            }
                        }
                    }
                }

                if (best > 0) return { pct: best, src: bestSrc };
                return null;
            });

            if (progressData && progressData.pct > 0) {
                // Chi update neu progress tang len (bao ve khong bi gat lui)
                if (progressData.pct > lastProgressPct) {
                    lastProgressPct = progressData.pct;
                    lastProgressTime = Date.now();
                    console.log('[Komfy Video] 📊 Progress (real): ' + progressData.pct + '% via ' + progressData.src);
                    
                    // Cap tai 99% cho den khi video thuc su confirmed
                    const reportPct = Math.min(lastProgressPct, 99);
                    fetch(PROXY_PROGRESS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ clientId: sessionData?.clientId, requestId, percent: reportPct, message: '' }) }).catch(() => {});
                }
            }
            // KHONG gui bat ky estimated progress nao khi khong co progress bar thuc te
            // → Node se giu nguyen % cu, khong chay "tuan tu" gia tao
        } catch (pe) { /* Non-fatal */ }

        // ===================================================================
        // 5. Stall detection
        // ===================================================================
        if (stalledMs > STALL_ERROR_MS) {
            const uiState = await scriptEval(() => {
                var progressEls = document.querySelectorAll('[style*="width"][style*="%"]');
                var hasBar = false;
                for (var i = 0; i < progressEls.length; i++) {
                    var h = progressEls[i].getBoundingClientRect().height;
                    if (h > 0 && h < 12) { hasBar = true; break; }
                }
                var spinners = document.querySelectorAll('[class*="loading"],[class*="spinner"],[class*="progress"]');
                return { hasBar, hasSpinner: spinners.length > 0 };
            }) || {};
            const elapsedMin = (stalledMs / 60000).toFixed(1);
            if (!uiState.hasBar && !uiState.hasSpinner) {
                throw new Error(`Video generation stalled after ${elapsedMin} minutes.`);
            } else {
                console.log(`[Komfy Video] Stall ${elapsedMin}min but UI still active.`);
                lastProgressTime = Date.now() - STALL_WARN_MS;
            }
        } else if (stalledMs > STALL_WARN_MS && pollCount % 10 === 0) {
            console.warn(`[Komfy Video] ⏳ Slow: ${(stalledMs / 60000).toFixed(1)}min no progress`);
        }
    } // end while

    if (!generationId) {
        if (pendingGenId) {
            generationId = pendingGenId;
            console.warn('[Komfy Video] Using pendingGenId as final result.');
        } else {
            throw new Error('Video generation ended without result. Please check Google Flow.');
        }
    }

    return generationId;
}
