const isElectron = (typeof process !== 'undefined') && process.versions && process.versions.electron;
const ipcRenderer = isElectron ? require('electron').ipcRenderer : null;

const SERVER_URL = 'http://108.61.222.248:3000';

let currentConfig = {
    steamId: "",
    refreshRate: 60,
    opacity: 100,
    showMainMapStats: false,
    showProfile: true,
    showZoneBar: true,
    showRankCard: true,
    showProfileStats: true,
    showDetailedStats: true,
    autoFollowStage: true,
    horizontalLayout: false,
    theme: {}
};

let refreshInterval = null;
let timerInterval = null;
let lastRefreshTime = 0;
let isUpdating = false;
let hasInitialized = false;

let currentZone = null;
let currentMap = null;
let displayedStageZone = null; // Tracks which zone the stage panel is actually showing

const zoneCache = new Map();
let browsingZone = null;

const ui = {
    avatar: document.getElementById('player-avatar'),
    playerName: document.getElementById('player-name'),
    playerNameText: document.getElementById('player-name-text'),
    playerFlag: document.getElementById('player-flag'),
    mapName: document.getElementById('map-name'),
    mapSpinner: document.getElementById('map-spinner'),
    statusIndicator: document.getElementById('status-indicator'),
    updateTimer: document.getElementById('update-timer'),
    serverName: document.getElementById('server-name'),
    serverPlayers: document.getElementById('server-players'),
    playersModal: document.getElementById('players-modal'),
    playersList: document.getElementById('players-list'),
    
    time: document.getElementById('stat-time'),
    zone: document.getElementById('stat-zone'),
    wrTime: document.getElementById('stat-wr-time'),
    wrDiff: document.getElementById('stat-wr-diff'),
    completions: document.getElementById('stat-completions'),
    attempts: document.getElementById('stat-attempts'),
    groupLabel: document.getElementById('stat-group-label'),
    compRate: document.getElementById('stat-comprate'),
    avgVel: document.getElementById('stat-avgvel'),
    totalTime: document.getElementById('stat-totaltime'),
    firstDate: document.getElementById('stat-firstdate'),
    startVel: document.getElementById('stat-startvel'),
    endVel: document.getElementById('stat-endvel'),

    profileSection: document.getElementById('profile-section'),
    profileDivider: document.getElementById('profile-divider'),
    profileRankTitle: document.getElementById('profile-rank-title'),
    profileRankSub: document.getElementById('profile-rank-sub'),
    profilePoints: document.getElementById('profile-points'),
    profileGlobalRank: document.getElementById('profile-global-rank'),
    profileCountryRank: document.getElementById('profile-country-rank'),
    profileCompletion: document.getElementById('profile-completion'),
    profileMaps: document.getElementById('profile-maps'),
    profileStages: document.getElementById('profile-stages'),
    profileBonuses: document.getElementById('profile-bonuses'),
    profileWrs: document.getElementById('profile-wrs'),
    profileWrcps: document.getElementById('profile-wrcps'),
    profileWrbs: document.getElementById('profile-wrbs'),
    profileTop10s: document.getElementById('profile-top10s'),
    profileGroups: document.getElementById('profile-groups'),
    profilePlaytime: document.getElementById('profile-playtime'),

    mainMapSection: document.getElementById('main-map-section'),
    sectionDivider: document.getElementById('section-divider'),
    stageNav: document.getElementById('stage-nav'),
    stageSectionLabel: document.getElementById('stage-section-label'),
    stageNavLeft: document.getElementById('stage-nav-left'),
    stageNavRight: document.getElementById('stage-nav-right'),
    stageContent: document.getElementById('stage-content'),
    mainStatTime: document.getElementById('main-stat-time'),
    mainStatRank: document.getElementById('main-stat-rank'),
    mainStatWrTime: document.getElementById('main-stat-wr-time'),
    mainStatWrDiff: document.getElementById('main-stat-wr-diff'),
    mainStatCompletions: document.getElementById('main-stat-completions'),
    mainStatAttempts: document.getElementById('main-stat-attempts'),
    mainStatGroupLabel: document.getElementById('main-stat-group-label'),
    mainStatCompRate: document.getElementById('main-stat-comprate'),
    mainStatAvgVel: document.getElementById('main-stat-avgvel'),
    mainStatTotalTime: document.getElementById('main-stat-totaltime'),
    mainStatFirstDate: document.getElementById('main-stat-firstdate'),
    zoneBarContainer: document.getElementById('zone-bar-container'),
    zoneBarStages: document.getElementById('zone-bar-stages'),
    zoneBarBonuses: document.getElementById('zone-bar-bonuses'),
    zoneBarTooltip: document.getElementById('zone-bar-tooltip'),

    mainStatStartVel: document.getElementById('main-stat-startvel'),
    mainStatEndVel: document.getElementById('main-stat-endvel')
};

function getBaseUrl() {
    return SERVER_URL;
}

function broadcastBrowseState(zone) {
    fetch(`${getBaseUrl()}/api/browse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone: zone })
    }).catch(() => {});
}

ui.stageNavLeft.addEventListener('click', () => navigateZone(-1));
ui.stageNavRight.addEventListener('click', () => navigateZone(1));

ui.mapName.addEventListener('click', () => {
    const mapText = ui.mapName.innerText;
    if (!mapText || mapText.includes('loading')) return;
    navigator.clipboard.writeText(mapText).then(() => {
        ui.mapName.classList.add('copied');
        const orig = ui.mapName.innerText;
        ui.mapName.innerText = 'Copied!';
        setTimeout(() => {
            ui.mapName.innerText = orig;
            ui.mapName.classList.remove('copied');
        }, 1000);
    }).catch(() => {});
});

ui.serverPlayers.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = ui.playersModal.style.display === 'block';
    ui.playersModal.style.display = isOpen ? 'none' : 'block';
});

document.addEventListener('click', (e) => {
    if (!ui.playersModal.contains(e.target) && e.target !== ui.serverPlayers) {
        ui.playersModal.style.display = 'none';
    }
});

function navigateZone(direction) {
    const zones = getSortedCachedZones();
    if (zones.length === 0) return;

    const viewingZone = browsingZone !== null ? browsingZone : (displayedStageZone !== null ? displayedStageZone : currentZone);
    const idx = zones.indexOf(viewingZone);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= zones.length) return;

    const newZone = zones[newIdx];
    const slideDir = direction > 0 ? 'left' : 'right';
    
    browsingZone = newZone;
    displayedStageZone = newZone;
    broadcastBrowseState(newZone);
    const cached = zoneCache.get(newZone);
    if (cached) {
        slideStageContent(slideDir, () => {
            populateZoneStats(cached);
            ui.stageSectionLabel.innerText = formatZone(newZone, cached.mapInfo);
            updateNavButtons();
            updateZoneBarActive();
        });
    }
}

function getSortedCachedZones() {
    const all = Array.from(zoneCache.keys()).sort((a, b) => a - b);
    if (currentConfig.showMainMapStats) {
        return all.filter(z => z !== 0);
    }
    return all;
}

function updateNavButtons() {
    const zones = getSortedCachedZones();
    const viewingZone = browsingZone !== null ? browsingZone : (displayedStageZone !== null ? displayedStageZone : currentZone);
    const idx = zones.indexOf(viewingZone);
    ui.stageNavLeft.disabled = (idx <= 0);
    ui.stageNavRight.disabled = (idx >= zones.length - 1);
}

function slideStageContent(direction, populateCallback) {
    const el = ui.stageContent;
    const outClass = direction === 'left' ? 'slide-out-left' : 'slide-out-right';
    const inClass = direction === 'left' ? 'slide-in-right' : 'slide-in-left';

    el.classList.add(outClass);
    el.addEventListener('animationend', function handler() {
        el.removeEventListener('animationend', handler);
        el.classList.remove(outClass);
        populateCallback();
        el.classList.add(inClass);
        el.addEventListener('animationend', function handler2() {
            el.removeEventListener('animationend', handler2);
            el.classList.remove(inClass);
        });
    });
}

function animateTimeChange(element, newText) {
    const oldText = element.innerText;
    if (oldText === newText || oldText === "--:--.--") {
        element.innerText = newText;
        return;
    }

    element.innerHTML = '';
    for (let i = 0; i < newText.length; i++) {
        const span = document.createElement('span');
        span.className = 'time-char';
        span.textContent = newText[i];
        if (i < oldText.length && oldText[i] !== newText[i]) {
            span.classList.add('roll-down');
        }
        element.appendChild(span);
    }
}

if (ipcRenderer) {
    ipcRenderer.on('config-updated', (event, config) => {
        const prev = { ...currentConfig };
        currentConfig = { ...currentConfig, ...config };
        applyConfig();
        
        const steamIdChanged = currentConfig.steamId !== prev.steamId;
        const rateChanged = currentConfig.refreshRate !== prev.refreshRate;
        const layoutChanged = currentConfig.showMainMapStats !== prev.showMainMapStats || currentConfig.autoFollowStage !== prev.autoFollowStage || currentConfig.horizontalLayout !== prev.horizontalLayout || currentConfig.showProfile !== prev.showProfile || currentConfig.showZoneBar !== prev.showZoneBar || currentConfig.showRankCard !== prev.showRankCard || currentConfig.showProfileStats !== prev.showProfileStats || currentConfig.showDetailedStats !== prev.showDetailedStats;

        if (!hasInitialized || steamIdChanged) {
            if (steamIdChanged) { profileCache = null; lastProfileFetch = 0; }
            hasInitialized = true;
            startPolling(true);
        } else if (rateChanged) {
            startPolling(false);
        }

        if (layoutChanged && hasInitialized) {
            refreshLayoutFromCache();
        }
    });

    ipcRenderer.send('get-config');
} else {
    (async function initBrowserMode() {
        try {
            const resp = await fetch('/api/config');
            if (resp.ok) {
                const serverCfg = await resp.json();
                if (serverCfg.steamId) currentConfig.steamId = serverCfg.steamId;
                if (serverCfg.refreshRate) currentConfig.refreshRate = serverCfg.refreshRate;
                if (serverCfg.showMainMapStats) currentConfig.showMainMapStats = true;
                if (serverCfg.showProfile !== undefined) currentConfig.showProfile = serverCfg.showProfile;
                if (serverCfg.showZoneBar !== undefined) currentConfig.showZoneBar = serverCfg.showZoneBar;
                if (serverCfg.showRankCard !== undefined) currentConfig.showRankCard = serverCfg.showRankCard;
                if (serverCfg.showProfileStats !== undefined) currentConfig.showProfileStats = serverCfg.showProfileStats;
                if (serverCfg.showDetailedStats !== undefined) currentConfig.showDetailedStats = serverCfg.showDetailedStats;
                if (serverCfg.autoFollowStage !== undefined) currentConfig.autoFollowStage = serverCfg.autoFollowStage;
                if (serverCfg.horizontalLayout !== undefined) currentConfig.horizontalLayout = serverCfg.horizontalLayout;
                if (serverCfg.theme) currentConfig.theme = serverCfg.theme;
            }
        } catch (e) {
            console.warn("Could not fetch server config, using URL params only", e);
        }

        const params = new URLSearchParams(window.location.search);
        if (params.get('steamId') || params.get('steamid')) {
            currentConfig.steamId = params.get('steamId') || params.get('steamid');
        }
        if (params.get('refreshRate')) {
            currentConfig.refreshRate = parseInt(params.get('refreshRate')) || 60;
        }
        if (params.get('showMainMapStats') === 'true' || params.get('showMainMapStats') === '1') {
            currentConfig.showMainMapStats = true;
        }
        const theme = {};
        if (params.get('bgColor')) theme.bgColor = params.get('bgColor');
        if (params.get('textColor')) theme.textColor = params.get('textColor');
        if (params.get('accentColor')) theme.accentColor = params.get('accentColor');
        if (params.get('borderColor')) theme.borderColor = params.get('borderColor');
        if (Object.keys(theme).length > 0) currentConfig.theme = { ...currentConfig.theme, ...theme };

        applyConfig();
        hasInitialized = true;
        startPolling(true);
    })();
}

function applyConfig() {
    const root = document.documentElement;
    if (currentConfig.theme) {
         if (currentConfig.theme.accentColor) root.style.setProperty('--accent-color', currentConfig.theme.accentColor);
         if (currentConfig.theme.textColor) root.style.setProperty('--text-color', currentConfig.theme.textColor);
         if (currentConfig.theme.bgColor) root.style.setProperty('--bg-color', currentConfig.theme.bgColor);
         if (currentConfig.theme.borderColor) root.style.setProperty('--border-color', currentConfig.theme.borderColor);
    }
    
    const card = document.getElementById('card');
    const layout = document.getElementById('cards-layout');
    if (currentConfig.horizontalLayout) {
        card.classList.add('wide-layout');
        layout.classList.add('horizontal');
    } else {
        card.classList.remove('wide-layout');
        layout.classList.remove('horizontal');
    }

    // ── Profile section visibility ─────────────────────────────
    const showRankCard = currentConfig.showRankCard !== false;
    const showProfileStats = currentConfig.showProfileStats !== false;
    const showAnyProfile = showRankCard || showProfileStats;

    const rankCard = document.getElementById('profile-rank-card');
    const profileStatsGrids = document.getElementById('profile-stats-grids');
    if (rankCard) rankCard.style.display = showRankCard ? '' : 'none';
    if (profileStatsGrids) profileStatsGrids.style.display = showProfileStats ? '' : 'none';

    if (showAnyProfile && profileCache) {
        populateProfile(profileCache);
    } else if (!showAnyProfile) {
        hideProfile();
    }

    // ── Zone bar visibility ─────────────────────────────────────
    // Re-render zone bar when toggling on, hide when toggling off
    if (currentConfig.showZoneBar !== false && hasInitialized && currentMap) {
        // Find mapInfo from any cached zone entry
        const anyZone = zoneCache.values().next().value;
        if (anyZone && anyZone.mapInfo) {
            updateMapCompletionStatus(anyZone.mapInfo);
        }
    } else if (currentConfig.showZoneBar === false) {
        ui.zoneBarContainer.style.display = 'none';
    }

    // ── Detailed stats visibility ───────────────────────────────
    const detailedEls = document.querySelectorAll('.detailed-stats');
    for (const el of detailedEls) {
        el.style.display = currentConfig.showDetailedStats !== false ? '' : 'none';
    }

    if (!currentConfig.steamId) {
        ui.playerNameText.innerText = "No SteamID";
        setPlayerFlag(null);
        ui.statusIndicator.innerHTML = '<span class="status-dot"></span>SETUP';
        ui.statusIndicator.className = "status-badge offline";
    }

    resizeOverlay();
}

function applyRemoteConfig(cfg) {
    let changed = false;

    if (cfg.showMainMapStats !== undefined && cfg.showMainMapStats !== currentConfig.showMainMapStats) {
        currentConfig.showMainMapStats = cfg.showMainMapStats;
        changed = true;
    }
    if (cfg.autoFollowStage !== undefined && cfg.autoFollowStage !== currentConfig.autoFollowStage) {
        currentConfig.autoFollowStage = cfg.autoFollowStage;
        changed = true;
    }
    if (cfg.horizontalLayout !== undefined && cfg.horizontalLayout !== currentConfig.horizontalLayout) {
        currentConfig.horizontalLayout = cfg.horizontalLayout;
        changed = true;
    }
    if (cfg.showProfile !== undefined && cfg.showProfile !== currentConfig.showProfile) {
        currentConfig.showProfile = cfg.showProfile;
        changed = true;
    }
    if (cfg.showZoneBar !== undefined && cfg.showZoneBar !== currentConfig.showZoneBar) {
        currentConfig.showZoneBar = cfg.showZoneBar;
        changed = true;
    }
    if (cfg.showRankCard !== undefined && cfg.showRankCard !== currentConfig.showRankCard) {
        currentConfig.showRankCard = cfg.showRankCard;
        changed = true;
    }
    if (cfg.showProfileStats !== undefined && cfg.showProfileStats !== currentConfig.showProfileStats) {
        currentConfig.showProfileStats = cfg.showProfileStats;
        changed = true;
    }
    if (cfg.showDetailedStats !== undefined && cfg.showDetailedStats !== currentConfig.showDetailedStats) {
        currentConfig.showDetailedStats = cfg.showDetailedStats;
        changed = true;
    }
    if (cfg.theme) {
        const t = currentConfig.theme;
        if (cfg.theme.accentColor !== t.accentColor || cfg.theme.textColor !== t.textColor ||
            cfg.theme.bgColor !== t.bgColor || cfg.theme.borderColor !== t.borderColor) {
            currentConfig.theme = cfg.theme;
            changed = true;
        }
    }

    if (changed) {
        applyConfig();
        if (hasInitialized && currentMap) {
            refreshLayoutFromCache();
        }
    }
}

let browseInterval = null;

function startPolling(forceImmediate = false) {
    if (refreshInterval) clearInterval(refreshInterval);
    if (timerInterval) clearInterval(timerInterval);
    if (browseInterval) clearInterval(browseInterval);
    
    if (!currentConfig.steamId) return;

    if (forceImmediate) {
        fetchStats();
    }

    const rate = Math.max(currentConfig.refreshRate || 60, 60); // minimum 60s to avoid spamming KSF API
    refreshInterval = setInterval(fetchStats, rate * 1000);
    timerInterval = setInterval(updateFooterTimer, 1000);

    if (!ipcRenderer) {
        browseInterval = setInterval(pollBrowseState, 5000); // 5s instead of 1.5s to reduce load
    }
}

async function pollBrowseState() {
    try {
        const resp = await fetch(`${getBaseUrl()}/api/browse`);
        if (resp.ok) {
            const data = await resp.json();
            if (data.config) {
                applyRemoteConfig(data.config);
            }
            applyRemoteBrowseState(data.zone);
        }
    } catch (e) {}
}

function updateFooterTimer() {
    if (!lastRefreshTime) {
        ui.updateTimer.innerText = "waiting...";
        return;
    }
    
    const rate = Math.max(currentConfig.refreshRate || 60, 60);
    const nextUpdate = lastRefreshTime + (rate * 1000);
    const now = Date.now();
    const diff = Math.ceil((nextUpdate - now) / 1000);
    
    if (diff > 0) {
        ui.updateTimer.innerText = `fetching data in ${diff}s`;
    } else {
        ui.updateTimer.innerText = "fetching data...";
    }
}

async function fetchStats() {
    if (isUpdating) return;
    if (!currentConfig.steamId) return;

    isUpdating = true;
    
    try {
        const baseUrl = getBaseUrl();
        const response = await fetch(`${baseUrl}/api/player/${encodeURIComponent(currentConfig.steamId)}`);
        
        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }
        
        const data = await response.json();
        updateUI(data);
        fetchProfile();
        lastRefreshTime = Date.now();

        if (!ipcRenderer) {
            try {
                const browseResp = await fetch(`${baseUrl}/api/browse`);
                if (browseResp.ok) {
                    const browseData = await browseResp.json();
                    applyRemoteBrowseState(browseData.zone);
                }
            } catch (e) {}
        }
        
    } catch (error) {
        console.error("Fetch failed:", error);
        ui.statusIndicator.innerHTML = '<span class="status-dot"></span>NET ERROR';
        ui.statusIndicator.className = "status-badge offline";
        showLoadingState();
    } finally {
        isUpdating = false;
    }
}

function applyRemoteBrowseState(remoteZone) {
    if (remoteZone === null || remoteZone === undefined) {
        if (browsingZone !== null) {
            const cached = zoneCache.get(currentZone);
            if (cached) {
                browsingZone = null;
                populateZoneStats(cached);
                ui.stageSectionLabel.innerText = formatZone(currentZone, cached.mapInfo);
                updateNavButtons();
                updateZoneBarActive();
            }
        }
        return;
    }

    const zone = parseInt(remoteZone);
    if (isNaN(zone)) return;
    if (zone === browsingZone) return;

    const cached = zoneCache.get(zone);
    if (!cached) return;

    const prevViewing = browsingZone !== null ? browsingZone : currentZone;
    const slideDir = (zone > prevViewing) ? 'left' : 'right';
    browsingZone = zone;
    displayedStageZone = zone;

    slideStageContent(slideDir, () => {
        populateZoneStats(cached);
        ui.stageSectionLabel.innerText = formatZone(zone, cached.mapInfo);
        updateNavButtons();
        updateZoneBarActive();
    });
}

function formatTime(secondsStr) {
    if (!secondsStr || secondsStr === "N/A") return "--:--.--";
    const totalSeconds = parseFloat(secondsStr);
    if (isNaN(totalSeconds)) return secondsStr;

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const milliseconds = Math.floor((totalSeconds % 1) * 1000);
    const pad = (num, size) => num.toString().padStart(size, '0');
    return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(milliseconds, 3)}`;
}

function formatTotalTime(secondsStr) {
    if (!secondsStr) return "-";
    const totalSeconds = parseFloat(secondsStr);
    if (isNaN(totalSeconds)) return "-";

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

function formatDate(dateVal) {
    if (!dateVal || dateVal === "0") return "-";
    
    let ts = parseInt(dateVal);
    if (!isNaN(ts)) {
        if (ts < 1e12) ts *= 1000;
        const date = new Date(ts);
        if (!isNaN(date.getTime())) {
            return date.toLocaleDateString();
        }
    }
    return "-";
}

function updateMapCompletionStatus(mapInfo) {
    if (!mapInfo) {
        ui.zoneBarContainer.style.display = 'none';
        return;
    }

    const mapType = parseInt(mapInfo.type); // 0 = staged, 1 = linear
    const totalStages = parseInt(mapInfo.cpCount) || 0;
    const totalBonuses = parseInt(mapInfo.bCount) || 0;
    const isLinear = mapType === 1;
    const hasBonuses = totalBonuses > 0;

    // Toggle class for taller boxes when no bonuses
    if (hasBonuses) {
        ui.zoneBarContainer.classList.remove('no-bonuses');
    } else {
        ui.zoneBarContainer.classList.add('no-bonuses');
    }

    // Build stages row
    ui.zoneBarStages.innerHTML = '';
    if (isLinear) {
        // Linear map: single box for the main map (zone 0)
        const box = createZoneBox(0, 'Main', mapInfo);
        ui.zoneBarStages.appendChild(box);
    } else {
        // Staged map: one box per stage
        for (let i = 1; i <= totalStages; i++) {
            const box = createZoneBox(i, `Stage ${i}`, mapInfo);
            ui.zoneBarStages.appendChild(box);
        }
    }

    // Build bonuses row
    ui.zoneBarBonuses.innerHTML = '';
    if (hasBonuses) {
        for (let i = 1; i <= totalBonuses; i++) {
            const zoneId = 30 + i;
            const box = createZoneBox(zoneId, `Bonus ${i}`, mapInfo);
            ui.zoneBarBonuses.appendChild(box);
        }
    }

    // Highlight the currently viewed zone
    updateZoneBarActive();

    ui.zoneBarContainer.style.display = currentConfig.showZoneBar !== false ? 'block' : 'none';
}

function createZoneBox(zoneId, label, mapInfo) {
    const box = document.createElement('div');
    box.className = 'zone-box';
    box.dataset.zoneId = zoneId;

    const z = zoneCache.get(zoneId);
    if (z && parseInt(z.completions) > 0) {
        box.classList.add('completed');
    } else if (z) {
        box.classList.add('not-completed');
    } else {
        box.classList.add('no-data');
    }

    // Hover tooltip
    box.addEventListener('mouseenter', (e) => {
        const tooltip = ui.zoneBarTooltip;
        tooltip.innerText = label;
        tooltip.style.display = 'block';

        // Position tooltip above the box
        const containerRect = ui.zoneBarContainer.getBoundingClientRect();
        const boxRect = box.getBoundingClientRect();
        const centerX = boxRect.left + boxRect.width / 2 - containerRect.left;
        tooltip.style.left = centerX + 'px';
        tooltip.style.bottom = '';
        tooltip.style.top = '';

        // Position above the row
        const rowRect = box.parentElement.getBoundingClientRect();
        const tooltipBottom = containerRect.bottom - rowRect.top + 6;
        tooltip.style.bottom = tooltipBottom + 'px';
        tooltip.style.top = 'auto';
    });

    box.addEventListener('mouseleave', () => {
        ui.zoneBarTooltip.style.display = 'none';
    });

    // Click to navigate to this zone
    box.addEventListener('click', () => {
        const cached = zoneCache.get(zoneId);
        if (!cached) return;

        // Determine slide direction
        const currentViewing = browsingZone !== null ? browsingZone : (displayedStageZone !== null ? displayedStageZone : currentZone);
        const slideDir = (zoneId > currentViewing) ? 'left' : (zoneId < currentViewing ? 'right' : null);

        browsingZone = zoneId;
        displayedStageZone = zoneId;
        broadcastBrowseState(zoneId);

        if (slideDir) {
            slideStageContent(slideDir, () => {
                populateZoneStats(cached);
                ui.stageSectionLabel.innerText = formatZone(zoneId, mapInfo);
                updateNavButtons();
                updateZoneBarActive();
            });
        } else {
            populateZoneStats(cached);
            ui.stageSectionLabel.innerText = formatZone(zoneId, mapInfo);
            updateNavButtons();
            updateZoneBarActive();
        }
    });

    return box;
}

function updateZoneBarActive() {
    const activeZone = browsingZone !== null ? browsingZone : (displayedStageZone !== null ? displayedStageZone : currentZone);
    
    // Remove active from all boxes
    const allBoxes = ui.zoneBarContainer.querySelectorAll('.zone-box');
    for (const box of allBoxes) {
        box.classList.remove('active');
        if (parseInt(box.dataset.zoneId) === activeZone) {
            box.classList.add('active');
        }
    }
}

function formatZone(zoneId, mapInfo) {
    const zid = parseInt(zoneId);
    if (isNaN(zid)) return "Unknown";
    
    if (zid === 0) return "Main";
    if (mapInfo && mapInfo.type == 1 && zid === 1) return "Main";
    if (zid >= 1 && zid <= 30) return `Stage ${zid}`;
    if (zid >= 31 && zid <= 40) return `Bonus ${zid - 30}`;
    
    return `Zone ${zid}`;
}

function setWrDisplay(wrTimeEl, wrDiffEl, playerTime, wrDiff) {
    const time = parseFloat(playerTime);
    const diff = parseFloat(wrDiff);

    if (!isNaN(time) && !isNaN(diff)) {
        const wrTime = time - diff;
        wrTimeEl.innerText = formatTime(wrTime.toString());

        const sign = diff > 0 ? "+" : "";
        wrDiffEl.innerText = `${sign}${formatTime(Math.abs(diff).toString())}`;
        wrDiffEl.style.color = (diff > 0) ? "var(--accent-color)" : (diff < 0 ? "#2ecc71" : "inherit");
    } else {
        wrTimeEl.innerText = "--:--.--";
        wrDiffEl.innerText = "-";
        wrDiffEl.style.color = "inherit";
    }
}

function formatCompRate(completions, attempts) {
    const c = parseInt(completions);
    const a = parseInt(attempts);
    if (isNaN(c) || isNaN(a) || a <= 0) return "-";
    const rate = (c / a) * 100;
    return `${rate.toFixed(1)}%`;
}

function getGroupInfo(group, completions) {
    const c = parseInt(completions);
    const hasCompletion = !isNaN(c) && c > 0;

    if (!hasCompletion) return { text: "No Completion", css: "group-no-comp" };

    if (!group || group === "-") {
        return { text: "-", css: "" };
    }

    let label = group;
    if (/^\d+$/.test(group)) label = `Group ${group}`;

    const g = label.toLowerCase();

    if (g === "no group") return { text: "No Group", css: "group-no-group" };
    if (g === "wr") return { text: "WR Holder", css: "group-wr" };
    if (g === "top 10") return { text: "Top 10", css: "group-top10" };
    if (g === "group 1") return { text: "Group 1", css: "group-g1" };
    if (g === "group 2") return { text: "Group 2", css: "group-g2" };
    if (g === "group 3") return { text: "Group 3", css: "group-g3" };
    if (g === "group 4") return { text: "Group 4", css: "group-g4" };
    if (g === "group 5") return { text: "Group 5", css: "group-g5" };
    if (g === "group 6") return { text: "Group 6", css: "group-g6" };

    return { text: label, css: "" };
}

function applyGroupLabel(element, group, completions) {
    const info = getGroupInfo(group, completions);
    element.innerText = info.text;
    element.className = "sub-value group-label";
    if (info.css) element.classList.add(info.css);
}

function clearStats() {
    ui.time.innerText = "--:--.--";
    ui.zone.innerText = "-/-";
    ui.wrTime.innerText = "--:--.--";
    ui.wrDiff.innerText = "-";
    ui.wrDiff.style.color = "inherit";
    ui.completions.innerText = "-";
    ui.attempts.innerText = "-";
    applyGroupLabel(ui.groupLabel, null, null);
    ui.compRate.innerText = "-";
    ui.avgVel.innerText = "-";
    ui.totalTime.innerText = "-";
    ui.firstDate.innerText = "-";
    ui.startVel.innerText = "-";
    ui.endVel.innerText = "-";
}

function showLoadingState() {
    clearStats();
    ui.mainMapSection.style.display = 'none';
    ui.mainMapSection.classList.remove('expanded');
    ui.sectionDivider.style.display = 'none';
    ui.stageNav.style.display = 'none';
    ui.zoneBarContainer.style.display = 'none';
    ui.mapName.innerHTML = '<span id="map-spinner" class="spinner" style="display: inline-block;"></span> loading map data...';
    ui.mapSpinner = document.getElementById('map-spinner');
}

function hasCompletions(completions) {
    const c = parseInt(completions);
    return !isNaN(c) && c > 0;
}

function formatRank(rank, totalRanks, completions) {
    if (!hasCompletions(completions)) {
        return totalRanks ? `-/${totalRanks}` : "-/-";
    }
    if (rank && totalRanks) {
        return `${rank}/${totalRanks}`;
    }
    return "-/-";
}

function populateMainMapStats(d) {
    ui.mainStatTime.innerText = formatTime(d.time);
    ui.mainStatRank.innerText = formatRank(d.rank, d.totalRanks, d.completions);

    setWrDisplay(ui.mainStatWrTime, ui.mainStatWrDiff, d.time, d.wrDiff);

    ui.mainStatCompletions.innerText = d.completions || "-";
    ui.mainStatAttempts.innerText = d.attempts || "-";
    applyGroupLabel(ui.mainStatGroupLabel, d.group, d.completions);
    ui.mainStatCompRate.innerText = formatCompRate(d.completions, d.attempts);
    ui.mainStatAvgVel.innerText = d.avgVel ? Math.round(parseFloat(d.avgVel)) : "-";

    ui.mainStatTotalTime.innerText = formatTotalTime(d.totalTime);
    ui.mainStatFirstDate.innerText = formatDate(d.firstDate);

    ui.mainStatStartVel.innerText = d.startVel ? Math.round(parseFloat(d.startVel)) : "-";
    ui.mainStatEndVel.innerText = d.endVel ? Math.round(parseFloat(d.endVel)) : "-";
}

function populateZoneStats(data) {
    const newTime = formatTime(data.time);
    const oldTime = ui.time.innerText;

    const newSec = parseFloat(data.time);
    let timeImproved = false;
    if (oldTime !== "--:--.--" && oldTime !== newTime && !isNaN(newSec)) {
        const oldParts = oldTime.match(/(\d+):(\d+)\.(\d+)/);
        if (oldParts) {
            const oldSec = parseInt(oldParts[1]) * 60 + parseInt(oldParts[2]) + parseInt(oldParts[3]) / 1000;
            if (newSec < oldSec) {
                timeImproved = true;
            }
        }
    }

    if (timeImproved) {
        animateTimeChange(ui.time, newTime);
    } else {
        ui.time.innerText = newTime;
    }

    ui.zone.innerText = formatRank(data.rank, data.totalRanks, data.completions);

    setWrDisplay(ui.wrTime, ui.wrDiff, data.time, data.wrDiff);
    
    ui.completions.innerText = data.completions || "-";
    ui.attempts.innerText = data.attempts || "-";
    applyGroupLabel(ui.groupLabel, data.group, data.completions);
    ui.compRate.innerText = formatCompRate(data.completions, data.attempts);
    ui.avgVel.innerText = data.avgVel ? Math.round(parseFloat(data.avgVel)) : "-";
    
    ui.totalTime.innerText = formatTotalTime(data.totalTime);
    ui.firstDate.innerText = formatDate(data.firstDate);
    ui.startVel.innerText = data.startVel ? Math.round(parseFloat(data.startVel)) : "-";
    ui.endVel.innerText = data.endVel ? Math.round(parseFloat(data.endVel)) : "-";
}

let profileCache = null;
let lastProfileFetch = 0;
const PROFILE_CACHE_TTL = 300000;

async function fetchProfile() {
    if (!currentConfig.showProfile || !currentConfig.steamId) return;

    const now = Date.now();
    if (profileCache && (now - lastProfileFetch) < PROFILE_CACHE_TTL) {
        populateProfile(profileCache);
        return;
    }

    try {
        const resp = await fetch(`${getBaseUrl()}/api/profile/${encodeURIComponent(currentConfig.steamId)}`);
        if (resp.ok) {
            const data = await resp.json();
            profileCache = data;
            lastProfileFetch = now;
            populateProfile(data);
        }
    } catch (e) {}
}

function formatPlaytime(seconds) {
    const s = parseInt(seconds);
    if (isNaN(s)) return "-";
    const hours = Math.floor(s / 3600);
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const rem = hours % 24;
        return `${days.toLocaleString()}d ${rem}h`;
    }
    return `${hours}h`;
}

function getRankTitleCss(rankTitle) {
    if (!rankTitle) return "";
    const r = rankTitle.toLowerCase();
    if (r.includes("rank 1:") || r.includes("rank 2:") || r.includes("rank 3:")) return "rank-top3";
    if (r.includes("master")) return "rank-master";
    if (r === "elite") return "rank-elite";
    if (r === "veteran") return "rank-veteran";
    if (r === "pro") return "rank-pro";
    if (r === "expert") return "rank-expert";
    if (r === "hotshot") return "rank-hotshot";
    if (r === "exceptional") return "rank-exceptional";
    if (r === "seasoned") return "rank-seasoned";
    if (r === "experienced") return "rank-experienced";
    if (r === "accomplished") return "rank-accomplished";
    if (r === "adept") return "rank-adept";
    if (r === "proficient") return "rank-proficient";
    if (r === "skilled") return "rank-skilled";
    if (r === "casual") return "rank-casual";
    if (r === "beginner") return "rank-beginner";
    if (r === "rookie") return "rank-rookie";
    return "";
}

function populateProfile(d) {
    ui.profileRankTitle.innerText = d.rankTitle || "-";
    ui.profileRankTitle.className = "profile-rank-title";
    const rankCss = getRankTitleCss(d.rankTitle);
    if (rankCss) ui.profileRankTitle.classList.add(rankCss);

    ui.profileRankSub.innerText = `Global #${d.surfRank || "-"} of ${parseInt(d.surfTotalRank || 0).toLocaleString()}`;
    ui.profilePoints.innerText = parseInt(d.points?.points || 0).toLocaleString();
    ui.profileGlobalRank.innerText = d.surfRank ? `#${d.surfRank}` : "-";
    ui.profileCountryRank.innerText = d.countryRank ? `#${d.countryRank} (${d.country || "?"})` : "-";
    ui.profileCompletion.innerText = d.percentCompletion ? `${d.percentCompletion}%` : "-";
    ui.profilePlaytime.innerText = formatPlaytime(d.onlineTime);

    if (d.completedZones && d.totalZones) {
        ui.profileMaps.innerText = `${d.completedZones.map || 0}/${d.totalZones.TotalMaps || 0}`;
        ui.profileStages.innerText = `${d.completedZones.stage || 0}/${d.totalZones.TotalStages || 0}`;
        ui.profileBonuses.innerText = `${d.completedZones.bonus || 0}/${d.totalZones.TotalBonuses || 0}`;
    }

    ui.profileWrs.innerText = d.wrZones?.wr || "0";
    ui.profileWrcps.innerText = d.wrZones?.wrcp || "0";
    ui.profileWrbs.innerText = d.wrZones?.wrb || "0";
    ui.profileTop10s.innerText = d.top10Groups?.top10 || "0";
    ui.profileGroups.innerText = d.top10Groups?.groups || "0";

    // Respect visibility toggles
    const rankCard = document.getElementById('profile-rank-card');
    const profileStatsGrids = document.getElementById('profile-stats-grids');
    if (rankCard) rankCard.style.display = currentConfig.showRankCard !== false ? '' : 'none';
    if (profileStatsGrids) profileStatsGrids.style.display = currentConfig.showProfileStats !== false ? '' : 'none';

    // Show profile section if at least one sub-section is visible
    const showAny = currentConfig.showRankCard !== false || currentConfig.showProfileStats !== false;
    ui.profileSection.style.display = showAny ? 'block' : 'none';
    ui.profileDivider.style.display = showAny ? 'block' : 'none';
    resizeOverlay();
}

function hideProfile() {
    ui.profileSection.style.display = 'none';
    ui.profileDivider.style.display = 'none';
}

let mapStatsFetching = null;

async function fetchMapStats(map, baseData) {
    if (!currentConfig.steamId || !map) return;
    if (mapStatsFetching === map) return;
    mapStatsFetching = map;

    try {
        const resp = await fetch(`${getBaseUrl()}/api/mapstats/${encodeURIComponent(currentConfig.steamId)}/${encodeURIComponent(map)}`);
        if (!resp.ok) return;
        const result = await resp.json();

        if (!result.zones || currentMap !== map) return;

        for (const [zoneIdStr, zoneData] of Object.entries(result.zones)) {
            const zoneId = parseInt(zoneIdStr);
            if (isNaN(zoneId)) continue;
            if (zoneCache.has(zoneId)) continue;

            zoneCache.set(zoneId, {
                ...zoneData,
                map: map,
                mapInfo: baseData.mapInfo,
                playerName: baseData.playerName,
                avatarUrl: baseData.avatarUrl,
                steamId64: baseData.steamId64,
                status: baseData.status
            });
        }

        updateNavButtons();
        updateMapCompletionStatus(baseData.mapInfo);
        resizeOverlay();
    } catch (e) {}
    finally {
        if (mapStatsFetching === map) mapStatsFetching = null;
    }
}

const COUNTRY_CODES = {
    'United States': 'us', 'Canada': 'ca', 'United Kingdom': 'gb', 'Germany': 'de',
    'France': 'fr', 'Sweden': 'se', 'Norway': 'no', 'Denmark': 'dk', 'Finland': 'fi',
    'Netherlands': 'nl', 'Belgium': 'be', 'Australia': 'au', 'New Zealand': 'nz',
    'Brazil': 'br', 'Russia': 'ru', 'Poland': 'pl', 'Spain': 'es', 'Italy': 'it',
    'Portugal': 'pt', 'Japan': 'jp', 'South Korea': 'kr', 'China': 'cn', 'India': 'in',
    'Mexico': 'mx', 'Argentina': 'ar', 'Chile': 'cl', 'Colombia': 'co', 'Peru': 'pe',
    'Turkey': 'tr', 'Ukraine': 'ua', 'Czech Republic': 'cz', 'Austria': 'at',
    'Switzerland': 'ch', 'Ireland': 'ie', 'Romania': 'ro', 'Hungary': 'hu',
    'Slovakia': 'sk', 'Croatia': 'hr', 'Bulgaria': 'bg', 'Serbia': 'rs',
    'Lithuania': 'lt', 'Latvia': 'lv', 'Estonia': 'ee', 'Slovenia': 'si',
    'Greece': 'gr', 'Israel': 'il', 'South Africa': 'za', 'Thailand': 'th',
    'Philippines': 'ph', 'Malaysia': 'my', 'Singapore': 'sg', 'Indonesia': 'id',
    'Vietnam': 'vn', 'Taiwan': 'tw', 'Hong Kong': 'hk', 'Iceland': 'is',
    'Luxembourg': 'lu', 'Malta': 'mt', 'Cyprus': 'cy', 'Georgia': 'ge',
    'Kazakhstan': 'kz', 'Belarus': 'by', 'Moldova': 'md', 'Albania': 'al',
    'North Macedonia': 'mk', 'Montenegro': 'me', 'Bosnia and Herzegovina': 'ba',
    'Uruguay': 'uy', 'Paraguay': 'py', 'Ecuador': 'ec', 'Venezuela': 've',
    'Costa Rica': 'cr', 'Panama': 'pa', 'Dominican Republic': 'do',
    'Puerto Rico': 'pr', 'Jamaica': 'jm', 'Trinidad and Tobago': 'tt',
    'Egypt': 'eg', 'Morocco': 'ma', 'Nigeria': 'ng', 'Kenya': 'ke',
    'Pakistan': 'pk', 'Bangladesh': 'bd', 'Sri Lanka': 'lk',
    'United Arab Emirates': 'ae', 'Saudi Arabia': 'sa', 'Qatar': 'qa',
    'Kuwait': 'kw', 'Bahrain': 'bh', 'Oman': 'om', 'Jordan': 'jo', 'Lebanon': 'lb'
};

function setPlayerFlag(country) {
    const code = country ? COUNTRY_CODES[country] : null;
    if (code) {
        ui.playerFlag.src = `https://flagcdn.com/w40/${code}.png`;
        ui.playerFlag.style.display = 'inline';
    } else {
        ui.playerFlag.style.display = 'none';
    }
}

// Centralized function to show/hide the Main Map panel.
// Called from updateUI and from applyConfig/applyRemoteConfig on toggle.
function showMainMapPanel(show, mainMapData) {
    if (show && mainMapData) {
        ui.mainMapSection.style.display = 'block';
        requestAnimationFrame(() => ui.mainMapSection.classList.add('expanded'));
        ui.sectionDivider.style.display = 'block';
        ui.sectionDivider.style.opacity = '1';
        populateMainMapStats(mainMapData);
    } else {
        ui.mainMapSection.classList.remove('expanded');
        setTimeout(() => {
            if (!ui.mainMapSection.classList.contains('expanded')) {
                ui.mainMapSection.style.display = 'none';
            }
        }, 400);
        ui.sectionDivider.style.opacity = '0';
        setTimeout(() => {
            ui.sectionDivider.style.display = 'none';
        }, 400);
    }
}

// Re-render the full layout from cached data (used when config toggles change).
function refreshLayoutFromCache() {
    const mainMapData = zoneCache.get(0) || null;
    const showMainMap = currentConfig.showMainMapStats && mainMapData;
    showMainMapPanel(showMainMap, mainMapData);

    // Re-render the stage panel with the correct zone
    const liveZone = browsingZone !== null ? browsingZone : currentZone;
    let stageZoneId = liveZone;
    if (showMainMap && stageZoneId === 0) {
        const nonZeroZones = getSortedCachedZones();
        stageZoneId = nonZeroZones.length > 0 ? nonZeroZones[0] : 0;
    }
    displayedStageZone = stageZoneId;
    const cached = zoneCache.get(stageZoneId);
    if (cached) {
        populateZoneStats(cached);
        ui.stageSectionLabel.innerText = formatZone(stageZoneId, cached.mapInfo);
        updateNavButtons();
        updateZoneBarActive();
    }
    resizeOverlay();
}

function updateUI(data) {
    if (data.avatarUrl) {
        ui.avatar.style.backgroundImage = `url('${data.avatarUrl}')`;
    } else if (data.steamId64) {
        ui.avatar.style.backgroundImage = `url('https://avatars.steamstatic.com/${data.steamId64}_full.jpg')`;
    }

    if (data.status === 'online') {
        ui.statusIndicator.innerHTML = '<span class="status-dot"></span>ONLINE';
        ui.statusIndicator.className = "status-badge online";
        
        ui.mapSpinner.style.display = 'none';
        ui.mapName.innerText = data.map || "Unknown Map";

        if (data.serverName) {
            const otherCount = (data.serverPlayers ? data.serverPlayers.length : 1) - 1;
            ui.serverName.innerText = data.serverName;
            ui.serverPlayers.innerText = otherCount > 0 ? `playing with ${otherCount} other${otherCount > 1 ? 's' : ''}` : 'playing solo';
            ui.serverName.style.display = 'block';
            ui.serverPlayers.style.display = 'block';

            ui.playersList.innerHTML = '';
            if (data.serverPlayers) {
                for (const p of data.serverPlayers) {
                    const item = document.createElement('div');
                    item.className = 'player-list-item';
                    item.title = `Click to view ${p.name}'s stats`;
                    
                    const flagCode = p.country ? COUNTRY_CODES[p.country] : null;
                    const flagHtml = flagCode 
                        ? `<img class="player-list-flag" src="https://flagcdn.com/w40/${flagCode}.png">` 
                        : '<span class="player-list-flag"></span>';
                    
                    item.innerHTML = `${flagHtml}<span class="player-list-name">${p.name}</span><span class="player-list-points">${parseInt(p.points || 0).toLocaleString()} pts</span>`;
                    
                    item.addEventListener('click', () => {
                        currentConfig.steamId = p.steamid;
                        profileCache = null;
                        lastProfileFetch = 0;
                        zoneCache.clear();
                        currentMap = null;
                        browsingZone = null;
                        ui.playersModal.style.display = 'none';
                        fetchStats();
                        fetchProfile();
                    });
                    
                    ui.playersList.appendChild(item);
                }
            }
        } else {
            ui.serverName.style.display = 'none';
            ui.serverPlayers.style.display = 'none';
        }

        if (data.map && data.map !== currentMap) {
            zoneCache.clear();
            browsingZone = null;
            displayedStageZone = null;
            currentMap = data.map;
            fetchMapStats(data.map, data);
        }

        const zoneId = data.zone !== undefined ? parseInt(data.zone) : null;
        if (zoneId !== null && !isNaN(zoneId)) {
            zoneCache.set(zoneId, { ...data });
        }

        if (data.mainMapStats) {
            zoneCache.set(0, {
                ...data.mainMapStats,
                zone: 0,
                map: data.map,
                mapInfo: data.mapInfo,
                playerName: data.playerName,
                avatarUrl: data.avatarUrl,
                steamId64: data.steamId64,
                status: data.status
            });
        }

        // ── Main Map panel logic ─────────────────────────────────────
        // Show the dedicated Main Map panel whenever the setting is on
        // and we have zone 0 data, regardless of current zone.
        const mainMapData = data.mainMapStats || zoneCache.get(0) || null;
        const showMainMap = currentConfig.showMainMapStats && mainMapData;
        showMainMapPanel(showMainMap, mainMapData);

        // ── Map completion status in header ──────────────────────────
        updateMapCompletionStatus(data.mapInfo);

        // ── Stage/Bonus panel logic ──────────────────────────────────
        ui.stageNav.style.display = 'flex';

        const prevZone = currentZone;
        currentZone = zoneId;
        const zoneChanged = prevZone !== null && prevZone !== zoneId && zoneId !== null;

        // Determine which zone the stage panel should display.
        // When showMainMapStats is on, the stage panel never shows zone 0
        // (that's what the Main Map panel is for).
        let stageZoneId = zoneId;
        if (showMainMap && stageZoneId === 0) {
            // Player is on zone 0 but main map panel is showing it.
            // Show the first available non-zero zone, or fall back to zone 0.
            const nonZeroZones = getSortedCachedZones();
            stageZoneId = nonZeroZones.length > 0 ? nonZeroZones[0] : 0;
        }

        const stageData = zoneCache.get(stageZoneId) || data;
        displayedStageZone = stageZoneId;

        if (currentConfig.autoFollowStage) {
            browsingZone = null;
            broadcastBrowseState(null);

            if (zoneChanged && stageZoneId === zoneId) {
                const slideDir = (zoneId > prevZone) ? 'left' : 'right';
                slideStageContent(slideDir, () => {
                    populateZoneStats(stageData);
                    ui.stageSectionLabel.innerText = formatZone(stageZoneId, data.mapInfo);
                    updateNavButtons();
                    updateZoneBarActive();
                });
            } else {
                populateZoneStats(stageData);
                ui.stageSectionLabel.innerText = formatZone(stageZoneId, data.mapInfo);
                updateNavButtons();
                updateZoneBarActive();
            }
        } else {
            if (browsingZone === null || browsingZone === zoneId) {
                populateZoneStats(stageData);
                ui.stageSectionLabel.innerText = formatZone(stageZoneId, data.mapInfo);
                updateNavButtons();
                updateZoneBarActive();
            } else {
                updateNavButtons();
                updateZoneBarActive();
            }
        }
        
        if (data.playerName) {
            ui.playerNameText.innerText = data.playerName;
            const country = data.country || (profileCache ? profileCache.country : null);
            setPlayerFlag(country);
        }

    } else {
        ui.statusIndicator.innerHTML = '<span class="status-dot"></span>OFFLINE';
        ui.statusIndicator.className = "status-badge offline";
        clearStats();
        ui.mainMapSection.style.display = 'none';
        ui.mainMapSection.classList.remove('expanded');
        ui.sectionDivider.style.display = 'none';
        ui.stageNav.style.display = 'none';
        ui.mapName.innerText = "Player is offline";
        ui.zoneBarContainer.style.display = 'none';
        ui.serverName.style.display = 'none';
        ui.serverPlayers.style.display = 'none';

        if (data.playerName) {
            ui.playerNameText.innerText = data.playerName;
        } else if (data.rawStatus?.name) {
            ui.playerNameText.innerText = data.rawStatus.name;
        }
    }

    resizeOverlay();
}

function resizeOverlay() {
    if (!ipcRenderer) return;
    setTimeout(() => {
        requestAnimationFrame(() => {
            const card = document.getElementById('card');
            if (card) {
                const width = card.scrollWidth + 40;
                const height = card.scrollHeight + 40;
                ipcRenderer.send('resize-overlay', { width, height });
            }
        });
    }, 450);
}
