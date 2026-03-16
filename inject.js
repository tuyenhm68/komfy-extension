let isSending = false;
async function grabRecaptcha() {
    if (isSending) return;
    if (window.grecaptcha && window.grecaptcha.enterprise) {
        isSending = true;
        try {
            const token = await window.grecaptcha.enterprise.execute('6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV', { action: 'video_generation' });
            
            // Gui noi bo ve Content Script qua postMessage
            window.postMessage({ type: "KOMFY_XBV_TOKEN", xbv: token }, "*");
            
        } catch (err) {
            console.error("[Komfy Extension] Khong the lay Recaptcha:", err);
        }
        isSending = false;
    }
}

// Lay token ngay khi trang tai xong
setTimeout(grabRecaptcha, 2000);
// Tu dong lay token moi lien tuc moi 2 phut (Tranh het han)
setInterval(grabRecaptcha, 120000);
