// =============================================================
// SNIPPET 1 - Chay trong Console cua Flow tab
// Kiem tra: Bottom bar buttons
// =============================================================
Array.from(document.querySelectorAll('button,[role="button"]')).filter(b=>{var r=b.getBoundingClientRect();return r.bottom>window.innerHeight-150&&r.height>0&&r.width>0;}).map((b,i)=>{var r=b.getBoundingClientRect();return {i,w:Math.round(r.width),aria:(b.getAttribute('aria-label')||'').substring(0,30),text:(b.textContent||'').trim().substring(0,30)};})
