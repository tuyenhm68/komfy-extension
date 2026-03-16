document.addEventListener('DOMContentLoaded', () => {
    const btnSync      = document.getElementById('btn-sync');
    const dotStudio    = document.getElementById('dot-studio');
    const studioStatus = document.getElementById('studio-status');
    const dotToken     = document.getElementById('dot-token');
    const tokenStatus  = document.getElementById('token-status');
    const projectIdEl  = document.getElementById('project-id');
    const lastSyncEl   = document.getElementById('last-sync');
    const hintEl       = document.getElementById('hint-text');

    const updateBanner  = document.getElementById('update-banner');
    const updateVersion = document.getElementById('update-version');
    const updateLink    = document.getElementById('update-link');
    const btnOpenFlow   = document.getElementById('btn-open-flow');

    // Nut mo Flow Tab
    if (btnOpenFlow) {
        btnOpenFlow.addEventListener('click', () => {
            chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow', active: true });
            window.close(); // Dong popup
        });
    }

    // Kiem tra co ban cap nhat khong
    chrome.storage.local.get(['extensionUpdateAvailable', 'latestVersion', 'updateUrl'], (res) => {
        if (res.extensionUpdateAvailable) {
            updateBanner.style.display = 'block';
            updateVersion.textContent = res.latestVersion || '?';
            const defaultUrl = 'https://github.com/vibe-project/komfy-studio-public/tree/main/chrome-extension';
            const dlUrl = res.updateUrl || defaultUrl;
            updateLink.onclick = () => { chrome.tabs.create({ url: dlUrl }); };
        }
    });

    function timeAgo(ms) {
        const s = Math.floor((Date.now() - ms) / 1000);
        if (s < 60)  return s + 's ago';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        return Math.floor(s / 3600) + 'h ago';
    }

    function updateUI(data) {
        // Google Session token
        if (data.bearerToken) {
            dotToken.className = 'dot green';
            tokenStatus.textContent = 'Active';
        } else {
            dotToken.className = 'dot red';
            tokenStatus.textContent = 'No token';
            if (hintEl) hintEl.style.display = 'block';
        }

        // Project ID
        projectIdEl.textContent = data.projectId
            ? data.projectId.substring(0, 24) + (data.projectId.length > 24 ? '...' : '')
            : '—';

        // Last sync / Studio connection
        if (data.lastSync) {
            const ago = Math.floor((Date.now() - data.lastSync) / 1000);
            dotStudio.className = ago < 30 ? 'dot green' : ago < 60 ? 'dot yellow' : 'dot red';
            studioStatus.textContent = ago < 30 ? 'Connected' : timeAgo(data.lastSync);
            lastSyncEl.textContent = timeAgo(data.lastSync);
            if (data.syncError) {
                dotStudio.className = 'dot red';
                studioStatus.textContent = 'Disconnected';
            }
        } else if (data.syncError) {
            dotStudio.className = 'dot red';
            studioStatus.textContent = 'Disconnected';
            lastSyncEl.textContent = '—';
        } else {
            dotStudio.className = 'dot yellow';
            studioStatus.textContent = 'Waiting...';
            lastSyncEl.textContent = '—';
        }
    }

    // Load initial state
    chrome.runtime.sendMessage({ action: 'GET_STATE' }, (response) => {
        if (response) updateUI(response);
    });

    // Sync button
    btnSync.addEventListener('click', () => {
        btnSync.textContent = 'Syncing...';
        btnSync.disabled = true;
        chrome.runtime.sendMessage({ action: 'FORCE_SYNC' }, (response) => {
            if (response) updateUI(response);
            btnSync.classList.add('success');
            btnSync.textContent = '✓ Synced';
            setTimeout(() => {
                btnSync.classList.remove('success');
                btnSync.textContent = '↻ Force Sync';
                btnSync.disabled = false;
            }, 2000);
        });
    });
});
