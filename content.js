// 1. Inject Script thong qua file (tranh loi CSP unsafe-inline)
const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
script.onload = function() {
    this.remove(); // Xoa khoi DOM sau khi inject xong
};
(document.head || document.documentElement).appendChild(script);

// 2. Content Script (chay trong moi truong Extension) lang nghe Injected Script
window.addEventListener("message", (event) => {
    // Chi nhan nhung thong diep chinh chu
    if (event.source !== window || !event.data || event.data.type !== "KOMFY_XBV_TOKEN") return;
    
    // Gui luong token sang Background Script de Background gui qua Server Proxy
    try {
        chrome.runtime.sendMessage({ action: "UPDATE_XBV", xbv: event.data.xbv });
    } catch(e) {}
});
