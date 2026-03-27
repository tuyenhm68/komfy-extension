document.addEventListener('DOMContentLoaded', () => {
    const btnSync      = document.getElementById('btn-sync');
    const dotStudio    = document.getElementById('dot-studio');
    const studioStatus = document.getElementById('studio-status');
    const dotToken     = document.getElementById('dot-token');
    const tokenStatus  = document.getElementById('token-status');
    const projectNameEl = document.getElementById('project-name');
    const projectIdEl  = document.getElementById('project-id');
    const lastSyncEl   = document.getElementById('last-sync');

    const btnReload    = document.getElementById('btn-reload');

    // Show version from manifest dynamically
    const versionTag = document.getElementById('version-tag');
    const verSpan = document.getElementById('ver');
    const manifest = chrome.runtime.getManifest();
    if (versionTag) versionTag.textContent = 'v' + manifest.version;
    if (verSpan) verSpan.textContent = manifest.version;

    // Nut Reload thu cong - luon hoat dong sau khi update code
    const btnReloadManual = document.getElementById('btn-reload-manual');
    if (btnReloadManual) {
        btnReloadManual.addEventListener('click', () => {
            btnReloadManual.textContent = '⏳ Reloading...';
            btnReloadManual.disabled = true;
            chrome.runtime.reload();
        });
    }

    // Nut Reload extension (chi hien khi co update tu Komfy Studio)
    chrome.storage.local.get(['extensionUpdateAvailable'], (res) => {
        if (res.extensionUpdateAvailable && btnReload) {
            btnReload.style.display = 'block';
        }
    });
    if (btnReload) {
        btnReload.addEventListener('click', () => {
            chrome.storage.local.set({ extensionUpdateAvailable: false });
            chrome.runtime.reload();
        });
    }

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
        }

        // Project name + ID
        projectNameEl.textContent = data.projectName || '—';
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

    // Double-click to clear project cache
    projectIdEl.addEventListener('dblclick', () => {
        if (confirm('Clear cached Project ID? This will force Komfy Studio to create a new project.')) {
            chrome.runtime.sendMessage({ action: 'CLEAR_PROJECT_CACHE' }, (response) => {
                projectIdEl.textContent = 'Cleared! Syncing...';
                setTimeout(() => {
                    chrome.runtime.sendMessage({ action: 'FORCE_SYNC' }, (res) => {
                        if (res) updateUI(res);
                    });
                }, 1000);
            });
        }
    });
    projectIdEl.style.cursor = 'pointer';
    projectIdEl.title = 'Double-click to clear project cache';

    // Clear Cache Button
    const btnClear = document.getElementById('btn-clear');
    if (btnClear) {
        btnClear.addEventListener('click', () => {
            if (confirm('Clear cached Project ID? This will force Komfy Studio to create a new project.')) {
                btnClear.textContent = '...';
                btnClear.disabled = true;
                chrome.runtime.sendMessage({ action: 'CLEAR_PROJECT_CACHE' }, (response) => {
                    btnClear.textContent = '✓';
                    projectIdEl.textContent = 'Cleared! Syncing...';
                    setTimeout(() => {
                        chrome.runtime.sendMessage({ action: 'FORCE_SYNC' }, (res) => {
                            if (res) updateUI(res);
                        });
                        btnClear.textContent = '🗑️ Clear';
                        btnClear.disabled = false;
                    }, 1000);
                });
            }
        });
    }

    // Sync button
    btnSync.addEventListener('click', () => {
        btnSync.textContent = '...';
        btnSync.disabled = true;
        chrome.runtime.sendMessage({ action: 'FORCE_SYNC' }, (response) => {
            if (response) updateUI(response);
            btnSync.classList.add('success');
            btnSync.textContent = '✓';
            setTimeout(() => {
                btnSync.classList.remove('success');
                btnSync.textContent = '↻ Sync';
                btnSync.disabled = false;
            }, 2000);
        });
    });
});
