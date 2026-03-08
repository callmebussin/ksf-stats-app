const isElectron = (typeof process !== 'undefined') && process.versions && process.versions.electron;
const ipcRenderer = isElectron ? require('electron').ipcRenderer : null;

const SERVER_URL = 'http://108.61.222.248:3000';

let currentConfig = {
    steamId: "",
    refreshRate: 60,
    opacity: 100,
    gameType: "css",
    surfType: 0,
    showMainMapStats: false,
    hideStages: false,
    showZoneBar: true,
    showRankCard: true,
    showProfileStats: true,
    showDetailedStats: true,
    showMapInfo: true,
    showMapImage: true,
    showPointsBreakdown: true,
    showHeader: true,
    showPillToggles: true,
    showStagePanel: true,
    showFooter: true,
    autoFollowStage: true,
    horizontalLayout: false,
    theme: {},
    zoneCompletedColor: "#2ecc71",
    zoneNotCompletedColor: "#e74c3c",
    mapNameColor: "#ffffff"
};

let refreshInterval = null;
let timerInterval = null;
let deferredFetchTimeout = null; // Track deferred fetch from startPolling cooldown
let lastRefreshTime = 0;
let isUpdating = false;
let hasInitialized = false;
let currentFetchController = null; // AbortController for in-flight fetches
let viewingOtherPlayer = null; // When set, we're viewing another player's stats (not our own)
let userExplicitPillChoice = false; // True when user clicked a pill — suppresses auto-detect
let lastFetchData = null; // Last successful fetch response, used for caching on player switch

// Per-player data cache for instant switching between online players.
// Keys: "steamid:gameType:surfType", Values: { data, profile, timestamp }
const playerDataCache = new Map();
const PLAYER_DATA_CACHE_TTL = 300000; // 5 minutes — survives time spent viewing other players

function cachePlayerData(steamid, data, profile) {
    const key = `${steamid}:${currentConfig.gameType}:${currentConfig.surfType}`;
    playerDataCache.set(key, { data, profile, timestamp: Date.now() });
}

function getCachedPlayerData(steamid) {
    const key = `${steamid}:${currentConfig.gameType}:${currentConfig.surfType}`;
    const cached = playerDataCache.get(key);
    if (cached && (Date.now() - cached.timestamp) < PLAYER_DATA_CACHE_TTL) {
        return cached;
    }
    return null;
}

// Persist lastRefreshTime across reloads AND full app restarts.
// Uses both localStorage (fast, survives Ctrl+R) and Electron IPC (survives full restart).
function saveLastRefreshTime(timestamp) {
    lastRefreshTime = timestamp;
    try { localStorage.setItem('ksf_lastRefreshTime', timestamp.toString()); } catch (e) {}
    // Persist to Electron config file for full app restart survival
    if (ipcRenderer && timestamp > 0) {
        ipcRenderer.send('save-refresh-time', timestamp);
    }
}

function loadLastRefreshTime() {
    // Try localStorage first (fastest)
    try {
        const stored = localStorage.getItem('ksf_lastRefreshTime');
        if (stored) {
            const ts = parseInt(stored);
            if (!isNaN(ts) && ts > 0) {
                lastRefreshTime = ts;
                return ts;
            }
        }
    } catch (e) {}
    // Fall back to Electron config (survives full app restarts)
    if (ipcRenderer) {
        try {
            const ts = ipcRenderer.sendSync('get-refresh-time');
            if (ts && ts > 0) {
                lastRefreshTime = ts;
                return ts;
            }
        } catch (e) {}
    }
    return 0;
}

let currentZone = null;
let currentMap = null;
let displayedStageZone = null; // Tracks which zone the stage panel is actually showing

const zoneCache = new Map();
let browsingZone = null;

// ── Persistent local cache ──────────────────────────────────────────────────
// Saves player state to localStorage so data survives app restarts.
const LOCAL_CACHE_KEY = 'ksf_playerCache';
const LOCAL_CACHE_MAX_AGE = 600000; // 10 minutes

function saveLocalCache() {
    try {
        const key = `${currentConfig.steamId}:${currentConfig.gameType}:${currentConfig.surfType}`;
        if (!currentConfig.steamId || zoneCache.size === 0) return;

        const allCaches = JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || '{}');
        allCaches[key] = {
            zoneCache: Object.fromEntries(zoneCache),
            profileCache: profileCache,
            lastProfileFetch,
            currentMap,
            currentZone,
            lastRefreshTime,
            headerName: ui.playerNameText.innerText,
            headerAvatar: ui.avatar.style.backgroundImage,
            headerFlag: ui.playerFlag.src,
            headerFlagVisible: ui.playerFlag.style.display !== 'none',
            timestamp: Date.now()
        };

        // Prune old entries to avoid unbounded growth
        for (const [k, v] of Object.entries(allCaches)) {
            if (Date.now() - v.timestamp > LOCAL_CACHE_MAX_AGE) delete allCaches[k];
        }
        localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(allCaches));
    } catch (e) {}
}

function loadLocalCache() {
    try {
        const key = `${currentConfig.steamId}:${currentConfig.gameType}:${currentConfig.surfType}`;
        const allCaches = JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY) || '{}');
        const snap = allCaches[key];
        if (!snap) return false;
        if (Date.now() - snap.timestamp > LOCAL_CACHE_MAX_AGE) return false;

        // Restore state
        zoneCache.clear();
        for (const [k, v] of Object.entries(snap.zoneCache)) zoneCache.set(parseInt(k), v);
        profileCache = snap.profileCache;
        lastProfileFetch = snap.lastProfileFetch;
        currentMap = snap.currentMap;
        currentZone = snap.currentZone;
        // Restore refresh time so the countdown picks up where it left off
        lastRefreshTime = snap.lastRefreshTime || snap.timestamp;
        // Restore header
        if (snap.headerName) ui.playerNameText.innerText = snap.headerName;
        if (snap.headerAvatar) ui.avatar.style.backgroundImage = snap.headerAvatar;
        if (snap.headerFlag && snap.headerFlagVisible) {
            ui.playerFlag.src = snap.headerFlag;
            ui.playerFlag.style.display = 'inline';
        }
        return true;
    } catch (e) {}
    return false;
}

// ── Per-gameType/surfType snapshot cache ─────────────────────────────────────
// Stores full UI state snapshots keyed by "gameType:surfType" so switching
// pills restores instantly without hitting the API.
const pillSnapshotCache = new Map();

function pillCacheKey(gameType, surfType, steamId) {
    return `${steamId || currentConfig.steamId}:${gameType || 'css'}:${surfType || 0}`;
}

function savePillSnapshot() {
    const key = pillCacheKey(currentConfig.gameType, currentConfig.surfType);
    pillSnapshotCache.set(key, {
        zoneCache: new Map(zoneCache),
        profileCache: profileCache ? { ...profileCache } : null,
        lastProfileFetch,
        currentMap,
        currentZone,
        browsingZone,
        displayedStageZone,
        // Store header display state so it can be restored on pill switch
        headerName: ui.playerNameText.innerText,
        headerAvatar: ui.avatar.style.backgroundImage,
        headerFlag: ui.playerFlag.src,
        headerFlagVisible: ui.playerFlag.style.display !== 'none',
        timestamp: Date.now()
    });
}

function loadPillSnapshot(gameType, surfType) {
    const key = pillCacheKey(gameType, surfType);
    const snap = pillSnapshotCache.get(key);
    if (!snap) return false;
    // Expire snapshots after 5 minutes
    if (Date.now() - snap.timestamp > 300000) {
        pillSnapshotCache.delete(key);
        return false;
    }
    // Restore state
    zoneCache.clear();
    for (const [k, v] of snap.zoneCache) zoneCache.set(k, v);
    profileCache = snap.profileCache;
    lastProfileFetch = snap.lastProfileFetch;
    currentMap = snap.currentMap;
    currentZone = snap.currentZone;
    browsingZone = snap.browsingZone;
    displayedStageZone = snap.displayedStageZone;
    // Restore header display state (name, avatar, flag)
    if (snap.headerName) ui.playerNameText.innerText = snap.headerName;
    if (snap.headerAvatar) ui.avatar.style.backgroundImage = snap.headerAvatar;
    if (snap.headerFlag && snap.headerFlagVisible) {
        ui.playerFlag.src = snap.headerFlag;
        ui.playerFlag.style.display = 'inline';
    } else if (snap.headerFlagVisible === false) {
        ui.playerFlag.style.display = 'none';
    }
    return true;
}

const ui = {
    avatar: document.getElementById('player-avatar'),
    playerName: document.getElementById('player-name'),
    playerNameText: document.getElementById('player-name-text'),
    playerFlag: document.getElementById('player-flag'),
    headerPoints: null, // removed — rank label replaced points
    mapName: document.getElementById('map-name'),
    mapSpinner: document.getElementById('map-spinner'),
    mapTierStat: document.getElementById('map-tier-stat'),
    mapMapperName: document.getElementById('map-mapper-name'),
    mapStageStat: document.getElementById('map-stage-stat'),
    mapBonusStat: document.getElementById('map-bonus-stat'),
    mapPlaytimeStat: document.getElementById('map-playtime-stat'),
    mapInfoBg: document.getElementById('map-info-bg'),
    statusIndicator: document.getElementById('status-indicator'),
    updateTimer: document.getElementById('update-timer'),
    playingOnLabel: document.getElementById('playing-on-label'),
    serverInfo: document.getElementById('server-info'),
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
    profileDivider: null, // removed from DOM
    profileRowTop: document.getElementById('profile-row-top'),
    profileRowBottom: document.getElementById('profile-row-bottom'),
    profileRankTitle: document.getElementById('profile-rank-title'),
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

    header: document.getElementById('header'),
    footer: document.getElementById('footer'),
    emptyState: document.getElementById('empty-state'),
    cardsLayout: document.getElementById('cards-layout'),
    mapInfoCard: document.getElementById('map-info-card'),
    completionsCard: document.getElementById('completions-card'),
    recordsCard: document.getElementById('records-card'),
    pointsBreakdownCard: document.getElementById('points-breakdown-card'),

    mainMapSection: document.getElementById('main-map-section'),
    sectionDivider: document.getElementById('section-divider'),
    stageNav: document.getElementById('stage-nav'),
    stageSectionLabel: document.getElementById('stage-section-label'),
    stageSectionLabelText: document.getElementById('stage-section-label-text'),
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
    mainStatEndVel: document.getElementById('main-stat-endvel'),
    stagePanel: document.querySelector('.stage-panel'),

    // Map detail & browser views
    mapDetailView: document.getElementById('map-detail-view'),
    mapDetailClose: document.getElementById('map-detail-close'),
    mapDetailBrowseBtn: document.getElementById('map-detail-browse-btn'),
    mapDetailHeroBg: document.getElementById('map-detail-hero-bg'),
    mapDetailTier: document.getElementById('map-detail-tier'),
    mapDetailName: document.getElementById('map-detail-name'),
    mapDetailMapper: document.getElementById('map-detail-mapper'),
    mapDetailStageStat: document.getElementById('map-detail-stage-stat'),
    mapDetailBonusStat: document.getElementById('map-detail-bonus-stat'),
    mapDetailPlaytime: document.getElementById('map-detail-playtime'),
    mapDetailZoneBar: document.getElementById('map-detail-zone-bar'),
    mapDetailZoneBarStages: document.getElementById('map-detail-zone-bar-stages'),
    mapDetailZoneBarBonuses: document.getElementById('map-detail-zone-bar-bonuses'),
    mapDetailWr: document.getElementById('map-detail-wr'),
    mapDetailZones: document.getElementById('map-detail-zones'),
    compareInput: document.getElementById('compare-input'),
    compareSection: document.getElementById('compare-section'),
    comparePlayerLeft: document.getElementById('compare-player-left'),
    comparePlayerRight: document.getElementById('compare-player-right'),
    compareRows: document.getElementById('compare-rows'),
    mapsBrowserView: document.getElementById('maps-browser-view'),
    mapsBrowserClose: document.getElementById('maps-browser-close'),
    mapsSearch: document.getElementById('maps-search'),
    mapsBrowserList: document.getElementById('maps-browser-list')
};

// ── Map background image cache ──────────────────────────────────────────────
const mapImageCache = new Map(); // mapName -> blob URL

function formatMapDisplayName(mapName) {
    if (!mapName) return mapName;
    return mapName.replace(/^surf_/i, '');
}

function setMapBackground(mapName) {
    if (!mapName || currentConfig.showMapImage === false) {
        ui.mapInfoBg.style.backgroundImage = '';
        ui.mapInfoBg.classList.remove('loaded');
        return;
    }

    // Check cache first
    const cached = mapImageCache.get(mapName);
    if (cached) {
        ui.mapInfoBg.style.backgroundImage = `url('${cached}')`;
        ui.mapInfoBg.classList.add('loaded');
        return;
    }

    // Use the image URL directly (avoids CORS/canvas issues in browser mode)
    const imgUrl = `https://ksf.surf/images/${encodeURIComponent(mapName)}.jpg`;
    const img = new Image();
    img.onload = () => {
        mapImageCache.set(mapName, imgUrl);
        if (currentMap === mapName) {
            ui.mapInfoBg.style.backgroundImage = `url('${imgUrl}')`;
            ui.mapInfoBg.classList.add('loaded');
        }
    };
    img.onerror = () => {
        // Image not available — just leave it blank
        mapImageCache.set(mapName, ''); // cache the miss
    };
    img.src = imgUrl;
}

// ── Pill Toggle UI ──────────────────────────────────────────────────────────
function initPillToggles() {
    const gameTypePill = document.getElementById('gametype-pill');
    const surfTypePill = document.getElementById('surftype-pill');

    if (gameTypePill) {
        const btns = gameTypePill.querySelectorAll('.pill-option');
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                const val = btn.dataset.value;
                if (val === currentConfig.gameType) return;
                const prevGame = currentConfig.gameType;
                const prevSurf = currentConfig.surfType;
                currentConfig.gameType = val;
                userExplicitPillChoice = true; // User chose this — don't auto-detect away
                updatePillUI(gameTypePill, val);
                onGameOrSurfTypeChanged(prevGame, prevSurf);
            });
        });
    }

    if (surfTypePill) {
        const btns = surfTypePill.querySelectorAll('.pill-option');
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                const val = parseInt(btn.dataset.value);
                if (val === currentConfig.surfType) return;
                const prevGame = currentConfig.gameType;
                const prevSurf = currentConfig.surfType;
                currentConfig.surfType = val;
                userExplicitPillChoice = true; // User chose this — don't auto-detect away
                updatePillUI(surfTypePill, val.toString());
                onGameOrSurfTypeChanged(prevGame, prevSurf);
            });
        });
    }
}

function updatePillUI(pillGroup, activeValue) {
    const btns = pillGroup.querySelectorAll('.pill-option');
    const indicator = pillGroup.querySelector('.pill-indicator');
    let activeBtn = null;

    btns.forEach(btn => {
        if (btn.dataset.value === activeValue) {
            btn.classList.add('active');
            activeBtn = btn;
        } else {
            btn.classList.remove('active');
        }
    });

    if (activeBtn && indicator) {
        indicator.style.left = activeBtn.offsetLeft + 'px';
        indicator.style.width = activeBtn.offsetWidth + 'px';
    }
}

function syncPillsFromConfig() {
    const gameTypePill = document.getElementById('gametype-pill');
    const surfTypePill = document.getElementById('surftype-pill');
    if (gameTypePill) updatePillUI(gameTypePill, currentConfig.gameType || 'css');
    if (surfTypePill) updatePillUI(surfTypePill, (currentConfig.surfType || 0).toString());
}

function onGameOrSurfTypeChanged(prevGameType, prevSurfType) {
    // Save snapshot of current state before switching
    const prevKey = pillCacheKey(prevGameType, prevSurfType);
    // Temporarily set config back to save under the old key
    const newGameType = currentConfig.gameType;
    const newSurfType = currentConfig.surfType;
    currentConfig.gameType = prevGameType;
    currentConfig.surfType = prevSurfType;
    savePillSnapshot();
    currentConfig.gameType = newGameType;
    currentConfig.surfType = newSurfType;

    // Save to config if in Electron
    if (ipcRenderer) {
        ipcRenderer.send('save-config', {
            gameType: currentConfig.gameType,
            surfType: currentConfig.surfType
        });
    }

    // Broadcast to OBS browser source
    broadcastPillState();

    // Cancel any in-flight requests from the old gameType/surfType
    if (currentFetchController) {
        currentFetchController.abort();
        currentFetchController = null;
    }
    isUpdating = false;
    mapStatsFetching = null;

    // Try to restore from cache for the new combo
    const restored = loadPillSnapshot(newGameType, newSurfType);

    if (restored) {
        // We have cached data — just re-render the UI from it
        if (profileCache) populateProfile(profileCache);
        refreshLayoutFromCache();
        // Update lastRefreshTime so footer timer doesn't show "waiting..."
        saveLastRefreshTime(Date.now());
        resizeOverlay();
    } else {
        // No cache — clear and fetch fresh
        zoneCache.clear();
        profileCache = null;
        lastProfileFetch = 0;
        currentMap = null;
        browsingZone = null;
        displayedStageZone = null;
        // Don't reset lastRefreshTime to 0 — instead keep it so footer shows
        // a countdown. fetchStats will update it when the fetch completes.
        fetchStats();
    }
}

function broadcastPillState() {
    fetch(`${getBaseUrl()}/api/browse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            zone: browsingZone,
            gameType: currentConfig.gameType,
            surfType: currentConfig.surfType
        })
    }).catch(() => {});
}

// Push display config to the server so OBS web view stays in sync
function broadcastConfigToServer() {
    const cfg = {
        steamId: currentConfig.steamId,
        refreshRate: currentConfig.refreshRate,
        showMainMapStats: currentConfig.showMainMapStats,
        hideStages: currentConfig.hideStages,
        showZoneBar: currentConfig.showZoneBar,
        showRankCard: currentConfig.showRankCard,
        showProfileStats: currentConfig.showProfileStats,
        showDetailedStats: currentConfig.showDetailedStats,
        showMapInfo: currentConfig.showMapInfo,
        showMapImage: currentConfig.showMapImage,
        showPointsBreakdown: currentConfig.showPointsBreakdown,
        showHeader: currentConfig.showHeader,
        showPillToggles: currentConfig.showPillToggles,
        showStagePanel: currentConfig.showStagePanel,
        showFooter: currentConfig.showFooter,
        autoFollowStage: currentConfig.autoFollowStage,
        horizontalLayout: currentConfig.horizontalLayout,
        gameType: currentConfig.gameType,
        surfType: currentConfig.surfType,
        theme: currentConfig.theme,
        zoneCompletedColor: currentConfig.zoneCompletedColor,
        zoneNotCompletedColor: currentConfig.zoneNotCompletedColor
    };
    fetch(`${getBaseUrl()}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg)
    }).catch(() => {});
}

// Build query string for API calls
function apiQuery() {
    const params = new URLSearchParams();
    params.set('game', currentConfig.gameType || 'css');
    params.set('surfType', (currentConfig.surfType || 0).toString());
    return params.toString();
}

// Initialize pill toggles after DOM is ready
initPillToggles();

// Sync pill positions after layout settles (fonts loaded etc)
requestAnimationFrame(() => syncPillsFromConfig());

function getBaseUrl() {
    return SERVER_URL;
}

function broadcastBrowseState(zone) {
    fetch(`${getBaseUrl()}/api/browse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            zone: zone,
            gameType: currentConfig.gameType,
            surfType: currentConfig.surfType
        })
    }).catch(() => {});
}

ui.stageNavLeft.addEventListener('click', () => navigateZone(-1));
ui.stageNavRight.addEventListener('click', () => navigateZone(1));

ui.mapName.addEventListener('click', () => {
    // Copy the full map name (with surf_ prefix) for use in game chat
    const mapText = currentMap || ui.mapName.innerText;
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

ui.serverInfo.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = ui.playersModal.style.display === 'block';
    ui.playersModal.style.display = isOpen ? 'none' : 'block';
});

document.addEventListener('click', (e) => {
    if (!ui.playersModal.contains(e.target) && e.target !== ui.serverInfo) {
        ui.playersModal.style.display = 'none';
    }
});

// Direct fetch + render for instant player switching.
// Hits the server (which has pre-cached co-player data) and renders immediately.
let directFetchController = null;

async function directFetchAndRender(steamId) {
    // Abort any previous direct fetch (rapid clicking)
    if (directFetchController) {
        directFetchController.abort();
        directFetchController = null;
    }
    const controller = new AbortController();
    directFetchController = controller;

    try {
        const baseUrl = getBaseUrl();
        const response = await fetch(`${baseUrl}/api/player/${encodeURIComponent(steamId)}?${apiQuery()}`, { signal: controller.signal });
        if (!response.ok) return false;
        const data = await response.json();
        // Discard if player changed while we were fetching
        if (currentConfig.steamId !== steamId) return false;
        lastFetchData = data;
        updateUI(data);
        fetchProfile();
        saveLastRefreshTime(Date.now());
        savePillSnapshot();
        saveLocalCache();
        return true;
    } catch (e) {
        if (e.name === 'AbortError') return false;
        return false;
    } finally {
        if (directFetchController === controller) directFetchController = null;
    }
}

// Click player name to switch back to own stats when viewing another player
ui.playerName.addEventListener('click', () => {
    if (!viewingOtherPlayer) return; // Not viewing someone else — nothing to do

    // Abort any in-flight requests
    if (currentFetchController) { currentFetchController.abort(); currentFetchController = null; }
    if (directFetchController) { directFetchController.abort(); directFetchController = null; }
    isUpdating = false;
    mapStatsFetching = null;

    // Cache current viewed player's data before switching away
    savePillSnapshot();
    cachePlayerData(currentConfig.steamId, lastFetchData, profileCache);

    // Restore our own steamId
    const ownSteamId = viewingOtherPlayer;
    currentConfig.steamId = ownSteamId;
    viewingOtherPlayer = null;

    profileCache = null;
    lastProfileFetch = 0;
    zoneCache.clear();
    currentMap = null;
    currentZone = null;
    browsingZone = null;
    displayedStageZone = null;

    // Show cached data instantly while fetching fresh data
    const cached = getCachedPlayerData(ownSteamId);
    if (cached) {
        updateUI(cached.data);
        if (cached.profile) {
            profileCache = cached.profile;
            populateProfile(cached.profile);
        }
    }

    // Direct fetch from server (hits server cache = instant) then start polling
    directFetchAndRender(ownSteamId).then(() => {
        saveLastRefreshTime(Date.now());
        startPolling(false);
    });
});

function navigateZone(direction) {
    const zones = getSortedCachedZones();
    if (zones.length === 0) return;

    const viewingZone = browsingZone !== null ? browsingZone : (displayedStageZone !== null ? displayedStageZone : currentZone);
    const idx = zones.indexOf(viewingZone);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= zones.length) return;

    const newZone = zones[newIdx];
    
    browsingZone = newZone;
    displayedStageZone = newZone;
    broadcastBrowseState(newZone);
    const cached = zoneCache.get(newZone);
    if (cached) {
        populateZoneStats(cached);
        ui.stageSectionLabelText.innerText = formatZone(newZone, cached.mapInfo);
        updateNavButtons();
        updateZoneBarActive();
    }
}

function getSortedCachedZones() {
    const all = Array.from(zoneCache.keys()).sort((a, b) => a - b);
    const anyZone = zoneCache.values().next().value;
    const isLinear = anyZone && anyZone.mapInfo && parseInt(anyZone.mapInfo.type) === 1;

    if (currentConfig.showMainMapStats) {
        // When main map panel is shown, exclude zone 0 from stage navigation.
        // On linear maps, also exclude zone 1 since it's the same as the main map.
        if (isLinear) {
            return all.filter(z => z !== 0 && z !== 1);
        }
        return all.filter(z => z !== 0);
    }

    // When hideStages is on (and showMainMapStats is off), only show zone 0 and bonuses (31+).
    // This keeps the main map time cycling through with bonuses but skips individual stages.
    if (currentConfig.hideStages) {
        return all.filter(z => z === 0 || z >= 31);
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

// slideStageContent removed — stage navigation now updates instantly

// ── Smooth number counting animation (stopwatch effect) ─────────────────────
const ANIM_DURATION = 400; // ms
const ANIM_STEPS = 20;
const activeAnimations = new WeakMap();

function animateValue(element, newText) {
    if (!element) return;
    const oldText = element.innerText;
    if (oldText === newText) return;

    // Cancel any running animation on this element
    const existing = activeAnimations.get(element);
    if (existing) cancelAnimationFrame(existing);

    // Try to extract numeric value from both old and new text
    const oldNum = parseDisplayNumber(oldText);
    const newNum = parseDisplayNumber(newText);

    const fmt = getNumberFormat(newText);
    // Only animate when format matches AND format is safe to interpolate
    // Skip fractions (N/M) — both parts change between maps, interpolation is meaningless
    const animatable = fmt !== 'frac';
    if (animatable && oldNum !== null && newNum !== null && oldNum !== newNum && getNumberFormat(oldText) === fmt) {
        const startTime = performance.now();
        const format = getNumberFormat(newText);

        function step(now) {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / ANIM_DURATION, 1);
            // Ease out cubic for smooth deceleration
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = oldNum + (newNum - oldNum) * eased;
            element.innerText = formatAnimatedNumber(current, newText, format);
            if (progress < 1) {
                activeAnimations.set(element, requestAnimationFrame(step));
            } else {
                element.innerText = newText; // Ensure exact final value
                activeAnimations.delete(element);
            }
        }
        activeAnimations.set(element, requestAnimationFrame(step));
    } else {
        element.innerText = newText;
    }
}

function parseDisplayNumber(text) {
    if (!text || text === '-' || text === '--:--.--' || text.includes('loading')) return null;
    // Time format: MM:SS.mmm
    const timeMatch = text.match(/^(\d+):(\d+)\.(\d+)$/);
    if (timeMatch) {
        return parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]) + parseInt(timeMatch[3]) / 1000;
    }
    // Rank format: N/M or -/M
    const rankMatch = text.match(/^(-?\d[\d,]*)\s*\/\s*(-?\d[\d,]*)$/);
    if (rankMatch) return parseFloat(rankMatch[1].replace(/,/g, ''));
    // Hash-prefixed: #4068
    const hashMatch = text.match(/^#([\d,]+)$/);
    if (hashMatch) return parseFloat(hashMatch[1].replace(/,/g, ''));
    // Percentage: 8.77%
    const pctMatch = text.match(/^([\d,.]+)%$/);
    if (pctMatch) return parseFloat(pctMatch[1].replace(/,/g, ''));
    // Fraction: 108/925
    const fracMatch = text.match(/^([\d,]+)\/([\d,]+)$/);
    if (fracMatch) return parseFloat(fracMatch[1].replace(/,/g, ''));
    // Plus/minus prefix: +00:04.600
    if (text.startsWith('+') || text.startsWith('-')) {
        const inner = parseDisplayNumber(text.slice(1));
        if (inner !== null) return (text.startsWith('-') ? -1 : 1) * inner;
    }
    // Plain number: 9,174 or 82
    const plain = text.replace(/,/g, '');
    const num = parseFloat(plain);
    return isNaN(num) ? null : num;
}

function getNumberFormat(text) {
    if (/^\d+:\d+\.\d+$/.test(text)) return 'time';
    if (/^#[\d,]+$/.test(text)) return 'hash';
    if (/^[\d,.]+%$/.test(text)) return 'pct';
    // Rank format: N/M (animate numerator, keep denominator)
    if (/^-?[\d,]+\/-?[\d,]+$/.test(text)) return 'rank';
    if (/^[+-]?\d/.test(text) && text.includes(':')) return 'time_diff';
    return 'plain';
}

function formatAnimatedNumber(value, template, format) {
    // Check if the template uses commas for thousands separators
    const useCommas = /\d,\d{3}/.test(template);

    function intStr(v) {
        return useCommas ? Math.round(v).toLocaleString() : Math.round(v).toString();
    }

    switch (format) {
        case 'time': {
            const mins = Math.floor(value / 60);
            const secs = Math.floor(value % 60);
            const ms = Math.floor((value % 1) * 1000);
            return `${mins.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}.${ms.toString().padStart(3,'0')}`;
        }
        case 'rank': {
            const parts = template.match(/^(-?[\d,]+)\/([\d,]+)$/);
            const total = parts ? parts[2] : '';
            return `${intStr(value)}/${total}`;
        }
        case 'hash':
            return `#${intStr(value)}`;
        case 'pct':
            return `${value.toFixed(2)}%`;
        case 'plain':
        default:
            if (template.includes('.')) return value.toFixed((template.split('.')[1] || '').length);
            return intStr(value);
    }
}

if (ipcRenderer) {
    ipcRenderer.on('config-updated', (event, config) => {
        const prev = { ...currentConfig };

        // If we're viewing another player's stats, preserve the viewed steamId
        // instead of letting the persisted config overwrite it.
        // Only allow steamId changes from config when:
        //   1. We're NOT viewing another player (viewingOtherPlayer is null), OR
        //   2. The config steamId actually changed (user changed their own steamId in settings)
        const persistedSteamIdChanged = config.steamId && config.steamId !== prev.steamId && !viewingOtherPlayer;
        const ownSteamIdChanged = config.steamId && viewingOtherPlayer && config.steamId !== viewingOtherPlayer;

        if (persistedSteamIdChanged) {
            savePillSnapshot();
        }

        // Preserve the current steamId when viewing another player
        const preservedSteamId = viewingOtherPlayer ? currentConfig.steamId : null;
        currentConfig = { ...currentConfig, ...config };
        if (preservedSteamId) {
            currentConfig.steamId = preservedSteamId;
        }
        // But always track the "own" steamId from config for switching back
        if (config.steamId) {
            viewingOtherPlayer = viewingOtherPlayer || null; // keep current viewing state
        }

        applyConfig();

        // Always push config to server so OBS web view stays in sync
        // (fires on initial load AND on every subsequent change)
        broadcastConfigToServer();
        
        const steamIdChanged = persistedSteamIdChanged || ownSteamIdChanged;
        const rateChanged = currentConfig.refreshRate !== prev.refreshRate;
        const gameTypeChanged = currentConfig.gameType !== prev.gameType || currentConfig.surfType !== prev.surfType;
        const layoutChanged = currentConfig.showMainMapStats !== prev.showMainMapStats || currentConfig.hideStages !== prev.hideStages || currentConfig.autoFollowStage !== prev.autoFollowStage || currentConfig.horizontalLayout !== prev.horizontalLayout || currentConfig.showZoneBar !== prev.showZoneBar || currentConfig.showRankCard !== prev.showRankCard || currentConfig.showProfileStats !== prev.showProfileStats || currentConfig.showDetailedStats !== prev.showDetailedStats || currentConfig.showMapInfo !== prev.showMapInfo || currentConfig.showMapImage !== prev.showMapImage || currentConfig.showPointsBreakdown !== prev.showPointsBreakdown || currentConfig.showHeader !== prev.showHeader || currentConfig.showPillToggles !== prev.showPillToggles || currentConfig.showStagePanel !== prev.showStagePanel || currentConfig.showFooter !== prev.showFooter;

        syncPillsFromConfig();

        if (!hasInitialized || steamIdChanged) {
            if (steamIdChanged) {
                viewingOtherPlayer = null; // Reset viewing state on real steamId change
                profileCache = null;
                lastProfileFetch = 0;
                zoneCache.clear();
                currentMap = null;
                currentZone = null;
                browsingZone = null;
                displayedStageZone = null;
                // Clear stored refresh time so new player data is fetched immediately
                saveLastRefreshTime(0);
            }
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
                if (serverCfg.showMainMapStats !== undefined) currentConfig.showMainMapStats = serverCfg.showMainMapStats;
                if (serverCfg.hideStages !== undefined) currentConfig.hideStages = serverCfg.hideStages;
                if (serverCfg.showProfileStats !== undefined) currentConfig.showProfileStats = serverCfg.showProfileStats;
                if (serverCfg.showZoneBar !== undefined) currentConfig.showZoneBar = serverCfg.showZoneBar;
                if (serverCfg.showRankCard !== undefined) currentConfig.showRankCard = serverCfg.showRankCard;
                if (serverCfg.showProfileStats !== undefined) currentConfig.showProfileStats = serverCfg.showProfileStats;
                if (serverCfg.showDetailedStats !== undefined) currentConfig.showDetailedStats = serverCfg.showDetailedStats;
                if (serverCfg.showMapInfo !== undefined) currentConfig.showMapInfo = serverCfg.showMapInfo;
                if (serverCfg.showMapImage !== undefined) currentConfig.showMapImage = serverCfg.showMapImage;
                if (serverCfg.showPointsBreakdown !== undefined) currentConfig.showPointsBreakdown = serverCfg.showPointsBreakdown;
                if (serverCfg.showHeader !== undefined) currentConfig.showHeader = serverCfg.showHeader;
                if (serverCfg.showPillToggles !== undefined) currentConfig.showPillToggles = serverCfg.showPillToggles;
                if (serverCfg.showStagePanel !== undefined) currentConfig.showStagePanel = serverCfg.showStagePanel;
                if (serverCfg.showFooter !== undefined) currentConfig.showFooter = serverCfg.showFooter;
                if (serverCfg.autoFollowStage !== undefined) currentConfig.autoFollowStage = serverCfg.autoFollowStage;
                if (serverCfg.horizontalLayout !== undefined) currentConfig.horizontalLayout = serverCfg.horizontalLayout;
                if (serverCfg.gameType) currentConfig.gameType = serverCfg.gameType;
                if (serverCfg.surfType !== undefined) currentConfig.surfType = serverCfg.surfType;
                if (serverCfg.theme) currentConfig.theme = serverCfg.theme;
                if (serverCfg.zoneCompletedColor) currentConfig.zoneCompletedColor = serverCfg.zoneCompletedColor;
                if (serverCfg.zoneNotCompletedColor) currentConfig.zoneNotCompletedColor = serverCfg.zoneNotCompletedColor;
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
        if (params.get('gameType') || params.get('game')) {
            currentConfig.gameType = params.get('gameType') || params.get('game');
        }
        if (params.get('surfType')) {
            currentConfig.surfType = parseInt(params.get('surfType')) || 0;
        }
        const theme = {};
        if (params.get('bgColor')) theme.bgColor = params.get('bgColor');
        if (params.get('textColor')) theme.textColor = params.get('textColor');
        if (params.get('accentColor')) theme.accentColor = params.get('accentColor');
        if (params.get('borderColor')) theme.borderColor = params.get('borderColor');
        if (Object.keys(theme).length > 0) currentConfig.theme = { ...currentConfig.theme, ...theme };

        applyConfig();
        syncPillsFromConfig();
        hasInitialized = true;
        startPolling(true);
    })();
}

function applyConfig() {
    // Don't modify main view visibility if a sub-view (map detail / maps browser) is active
    const inSubView = typeof activeView !== 'undefined' && activeView !== 'main';

    const root = document.documentElement;
    if (currentConfig.theme) {
         if (currentConfig.theme.accentColor) root.style.setProperty('--accent-color', currentConfig.theme.accentColor);
         if (currentConfig.theme.textColor) root.style.setProperty('--text-color', currentConfig.theme.textColor);
         if (currentConfig.theme.bgColor) root.style.setProperty('--bg-color', currentConfig.theme.bgColor);
         if (currentConfig.theme.borderColor) root.style.setProperty('--border-color', currentConfig.theme.borderColor);
    }
    if (currentConfig.zoneCompletedColor) root.style.setProperty('--zone-completed', currentConfig.zoneCompletedColor);
    if (currentConfig.zoneNotCompletedColor) root.style.setProperty('--zone-not-completed', currentConfig.zoneNotCompletedColor);
    if (currentConfig.mapNameColor) root.style.setProperty('--map-name-color', currentConfig.mapNameColor);
    
    const card = document.getElementById('card');
    const layout = document.getElementById('cards-layout');
    if (currentConfig.horizontalLayout) {
        card.classList.add('wide-layout');
        layout.classList.add('horizontal');
    } else {
        card.classList.remove('wide-layout');
        layout.classList.remove('horizontal');
    }

    // Skip all element visibility management when a sub-view is active
    if (inSubView) { resizeOverlay(); return; }

    // ── Profile section visibility ─────────────────────────────
    const showRankCard = currentConfig.showRankCard !== false;
    const showProfileStats = currentConfig.showProfileStats !== false;
    const showMapInfo = currentConfig.showMapInfo !== false;
    const showPointsBreakdown = currentConfig.showPointsBreakdown !== false;
    const showAnyProfile = showRankCard || showProfileStats || showPointsBreakdown;

    // Always set sub-element visibility
    const rankCard = document.getElementById('profile-rank-card');
    if (rankCard) rankCard.style.display = showRankCard ? '' : 'none';
    if (ui.completionsCard) ui.completionsCard.style.display = showProfileStats ? '' : 'none';
    if (ui.recordsCard) ui.recordsCard.style.display = showProfileStats ? '' : 'none';
    // Map info card is now outside profile-section, managed independently
    if (ui.mapInfoCard) ui.mapInfoCard.style.display = showMapInfo && currentMap ? '' : 'none';
    // Map background image toggle
    if (currentConfig.showMapImage === false) {
        ui.mapInfoBg.style.backgroundImage = '';
        ui.mapInfoBg.classList.remove('loaded');
    } else if (currentMap) {
        setMapBackground(currentMap);
    }
    if (ui.pointsBreakdownCard) ui.pointsBreakdownCard.style.display = showPointsBreakdown ? '' : 'none';

    // Show/hide row containers
    if (ui.profileRowTop) ui.profileRowTop.style.display = (showRankCard || showProfileStats) ? '' : 'none';
    if (ui.profileRowBottom) ui.profileRowBottom.style.display = (showProfileStats || showPointsBreakdown) ? '' : 'none';

    // Show/hide the wrapper section
    if (showAnyProfile) {
        if (profileCache) {
            ui.profileSection.style.display = 'block';
            populateProfile(profileCache);
        } else if (currentConfig.steamId && hasInitialized) {
            // Profile data not yet fetched — trigger a fetch now
            fetchProfile();
        }
    } else {
        hideProfile();
    }

    // ── Zone bar visibility (inside map card, depends on showMapInfo) ──
    if (currentConfig.showZoneBar !== false && showMapInfo && hasInitialized && currentMap) {
        // Find mapInfo from any cached zone entry
        const anyZone = zoneCache.values().next().value;
        if (anyZone && anyZone.mapInfo) {
            updateMapCompletionStatus(anyZone.mapInfo);
        }
    } else if (currentConfig.showZoneBar === false || !showMapInfo) {
        ui.zoneBarContainer.style.display = 'none';
    }

    // ── Detailed stats visibility ───────────────────────────────
    const detailedEls = document.querySelectorAll('.detailed-stats');
    for (const el of detailedEls) {
        el.style.display = currentConfig.showDetailedStats !== false ? '' : 'none';
    }

    // ── Header visibility ───────────────────────────────────────
    if (ui.header) ui.header.style.display = currentConfig.showHeader !== false ? '' : 'none';

    // ── Pill toggles visibility (only if header is enabled) ─────
    const pillToggles = document.getElementById('pill-toggles');
    if (pillToggles) {
        const showPills = currentConfig.showHeader !== false && currentConfig.showPillToggles !== false;
        pillToggles.style.display = showPills ? '' : 'none';
        if (showPills) requestAnimationFrame(() => syncPillsFromConfig());
    }

    // ── Footer visibility ───────────────────────────────────────
    const showFooter = currentConfig.showFooter !== false;
    if (ui.footer) ui.footer.style.display = showFooter ? '' : 'none';
    card.classList.toggle('footer-hidden', !showFooter);

    // ── Stage panel (main map + stage/bonus sections) visibility ─
    const showStage = currentConfig.showStagePanel !== false;
    if (ui.cardsLayout) ui.cardsLayout.style.display = showStage ? '' : 'none';

    if (!currentConfig.steamId) {
        ui.playerNameText.innerText = "No SteamID";
        setPlayerFlag(null);
        ui.statusIndicator.innerHTML = '<span class="status-dot"></span>SETUP';
        ui.statusIndicator.className = "status-badge offline";
    }

    // ── Empty state when everything is disabled ─────────────────
    // Only check top-level options — sub-options don't independently show content
    const allOff = currentConfig.showHeader === false
        && currentConfig.showFooter === false
        && currentConfig.showStagePanel === false
        && currentConfig.showRankCard === false
        && currentConfig.showProfileStats === false
        && currentConfig.showMapInfo === false
        && currentConfig.showPointsBreakdown === false;
    if (ui.emptyState) ui.emptyState.style.display = allOff ? '' : 'none';

    resizeOverlay();
}

function applyRemoteConfig(cfg) {
    let changed = false;

    if (cfg.showMainMapStats !== undefined && cfg.showMainMapStats !== currentConfig.showMainMapStats) {
        currentConfig.showMainMapStats = cfg.showMainMapStats;
        changed = true;
    }
    if (cfg.hideStages !== undefined && cfg.hideStages !== currentConfig.hideStages) {
        currentConfig.hideStages = cfg.hideStages;
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
    if (cfg.showProfileStats !== undefined && cfg.showProfileStats !== currentConfig.showProfileStats) {
        currentConfig.showProfileStats = cfg.showProfileStats;
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
    if (cfg.showMapInfo !== undefined && cfg.showMapInfo !== currentConfig.showMapInfo) {
        currentConfig.showMapInfo = cfg.showMapInfo;
        changed = true;
    }
    if (cfg.showMapImage !== undefined && cfg.showMapImage !== currentConfig.showMapImage) {
        currentConfig.showMapImage = cfg.showMapImage;
        changed = true;
    }
    if (cfg.showPointsBreakdown !== undefined && cfg.showPointsBreakdown !== currentConfig.showPointsBreakdown) {
        currentConfig.showPointsBreakdown = cfg.showPointsBreakdown;
        changed = true;
    }
    if (cfg.showHeader !== undefined && cfg.showHeader !== currentConfig.showHeader) {
        currentConfig.showHeader = cfg.showHeader;
        changed = true;
    }
    if (cfg.showPillToggles !== undefined && cfg.showPillToggles !== currentConfig.showPillToggles) {
        currentConfig.showPillToggles = cfg.showPillToggles;
        changed = true;
    }
    if (cfg.showStagePanel !== undefined && cfg.showStagePanel !== currentConfig.showStagePanel) {
        currentConfig.showStagePanel = cfg.showStagePanel;
        changed = true;
    }
    if (cfg.showFooter !== undefined && cfg.showFooter !== currentConfig.showFooter) {
        currentConfig.showFooter = cfg.showFooter;
        changed = true;
    }
    if (cfg.gameType !== undefined && cfg.gameType !== currentConfig.gameType) {
        currentConfig.gameType = cfg.gameType;
        changed = true;
    }
    if (cfg.surfType !== undefined && cfg.surfType !== currentConfig.surfType) {
        currentConfig.surfType = cfg.surfType;
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
    if (cfg.zoneCompletedColor && cfg.zoneCompletedColor !== currentConfig.zoneCompletedColor) {
        currentConfig.zoneCompletedColor = cfg.zoneCompletedColor;
        changed = true;
    }
    if (cfg.zoneNotCompletedColor && cfg.zoneNotCompletedColor !== currentConfig.zoneNotCompletedColor) {
        currentConfig.zoneNotCompletedColor = cfg.zoneNotCompletedColor;
        changed = true;
    }
    if (cfg.mapNameColor && cfg.mapNameColor !== currentConfig.mapNameColor) {
        currentConfig.mapNameColor = cfg.mapNameColor;
        changed = true;
    }

    if (changed) {
        syncPillsFromConfig();
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
    if (deferredFetchTimeout) { clearTimeout(deferredFetchTimeout); deferredFetchTimeout = null; }
    
    if (!currentConfig.steamId) return;

    const rate = Math.max(currentConfig.refreshRate || 60, 60); // minimum 60s to avoid spamming KSF API
    const rateMs = rate * 1000;

    // Restore persisted timer to prevent Ctrl+R reload spam
    const storedTime = loadLastRefreshTime();

    // Try to restore cached data from localStorage immediately
    if (zoneCache.size === 0) {
        const restored = loadLocalCache();
        if (restored) {
            if (profileCache) populateProfile(profileCache);
            refreshLayoutFromCache();
            if (currentMap) setMapBackground(currentMap);
            resizeOverlay();
        }
    }

    if (forceImmediate) {
        const elapsed = Date.now() - storedTime;
        if (storedTime > 0 && elapsed < rateMs) {
            // Still within cooldown — schedule fetch for remaining time instead of fetching now
            const remaining = rateMs - elapsed;
            console.log(`[POLL] Reload detected. Waiting ${Math.ceil(remaining / 1000)}s before next fetch.`);
            deferredFetchTimeout = setTimeout(() => {
                deferredFetchTimeout = null;
                fetchStats();
                // Start the regular interval aligned to this deferred fetch
                if (refreshInterval) clearInterval(refreshInterval);
                refreshInterval = setInterval(fetchStats, rateMs);
            }, remaining);
            // Don't start the regular interval yet — the timeout above will start it
        } else {
            fetchStats();
            refreshInterval = setInterval(fetchStats, rateMs);
        }
    } else {
        refreshInterval = setInterval(fetchStats, rateMs);
    }
    timerInterval = setInterval(updateFooterTimer, 1000);

    if (!ipcRenderer) {
        browseInterval = setInterval(pollBrowseState, 1500);
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
            // Sync gameType/surfType from browse state (set by Electron overlay)
            let needRefetch = false;
            if (data.gameType !== undefined && data.gameType !== currentConfig.gameType) {
                currentConfig.gameType = data.gameType;
                syncPillsFromConfig();
                needRefetch = true;
            }
            if (data.surfType !== undefined && data.surfType !== currentConfig.surfType) {
                currentConfig.surfType = data.surfType;
                syncPillsFromConfig();
                needRefetch = true;
            }
            if (needRefetch) {
                zoneCache.clear();
                profileCache = null;
                lastProfileFetch = 0;
                currentMap = null;
                fetchStats();
            }
            applyRemoteBrowseState(data.zone);
        }
    } catch (e) {}
}

function updateFooterTimer() {
    if (isUpdating) {
        ui.updateTimer.innerHTML = '<span class="spinner" style="width:8px;height:8px;margin-right:4px;vertical-align:middle;"></span>updating';
        return;
    }
    
    if (!lastRefreshTime) {
        ui.updateTimer.innerHTML = '<span class="spinner" style="width:8px;height:8px;margin-right:4px;vertical-align:middle;"></span>updating';
        return;
    }
    
    const rate = Math.max(currentConfig.refreshRate || 60, 60);
    const nextUpdate = lastRefreshTime + (rate * 1000);
    const now = Date.now();
    const diff = Math.ceil((nextUpdate - now) / 1000);
    
    if (diff > 0) {
        ui.updateTimer.innerText = `fetching data in ${diff}s`;
    } else {
        ui.updateTimer.innerHTML = '<span class="spinner" style="width:8px;height:8px;margin-right:4px;vertical-align:middle;"></span>updating';
    }
}

async function fetchStats() {
    if (isUpdating) return;
    if (!currentConfig.steamId) return;

    // Abort any previous in-flight request
    if (currentFetchController) currentFetchController.abort();
    currentFetchController = new AbortController();
    const signal = currentFetchController.signal;
    const fetchId = currentFetchController; // Track which fetch this is

    isUpdating = true;
    
    // Separate network fetch from UI update to avoid UI errors showing as "NET ERROR"
    let data;
    try {
        const baseUrl = getBaseUrl();
        const response = await fetch(`${baseUrl}/api/player/${encodeURIComponent(currentConfig.steamId)}?${apiQuery()}`, { signal });
        
        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }
        
        data = await response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            // Fetch was cancelled by a pill switch — not an error, don't touch isUpdating
            // (the new fetch or pill switch handler already reset it)
            return;
        }
        console.error("Fetch failed:", error);
        // Only show error if this fetch is still the current one (not superseded)
        if (currentFetchController === fetchId) {
            ui.statusIndicator.innerHTML = '<span class="status-dot"></span>NET ERROR';
            ui.statusIndicator.className = "status-badge offline";
            // Don't call showLoadingState() — preserve existing data on transient errors
            // Just update the status badge. Data will refresh on next poll cycle.
            saveLastRefreshTime(Date.now());
            isUpdating = false;
        }
        return;
    }

    // If this fetch was superseded by another, discard results
    if (currentFetchController !== fetchId) {
        return;
    }

    // UI update phase — errors here are JS bugs, not network issues
    try {
        // Auto-detect gameType from server response — but only if the user
        // didn't explicitly pick a pill.  When they click 100t they want 100t
        // stats even though the player is online on a 66t server.
        if (!userExplicitPillChoice && data.gameType && data.gameType !== currentConfig.gameType) {
            currentConfig.gameType = data.gameType;
            syncPillsFromConfig();
            if (ipcRenderer) {
                ipcRenderer.send('save-config', { gameType: data.gameType });
            }
        }

        lastFetchData = data;
        updateUI(data);
        fetchProfile();
        saveLastRefreshTime(Date.now());
        // Update pill snapshot cache with fresh data
        savePillSnapshot();
        // Persist to localStorage for app restart recovery
        saveLocalCache();

        if (!ipcRenderer) {
            try {
                const baseUrl = getBaseUrl();
                const browseResp = await fetch(`${baseUrl}/api/browse`);
                if (browseResp.ok) {
                    const browseData = await browseResp.json();
                    applyRemoteBrowseState(browseData.zone);
                }
            } catch (e) {}
        }
    } catch (uiError) {
        // Log UI errors for debugging but don't show "NET ERROR" — the data fetched fine
        console.error("UI update error:", uiError);
        saveLastRefreshTime(Date.now());
    } finally {
        // Only clear isUpdating if this fetch is still the current one
        if (currentFetchController === fetchId) {
            isUpdating = false;
        }
    }
}

function applyRemoteBrowseState(remoteZone) {
    if (remoteZone === null || remoteZone === undefined) {
        if (browsingZone !== null) {
            const cached = zoneCache.get(currentZone);
            if (cached) {
                browsingZone = null;
                populateZoneStats(cached);
                ui.stageSectionLabelText.innerText = formatZone(currentZone, cached.mapInfo);
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

    browsingZone = zone;
    displayedStageZone = zone;

    populateZoneStats(cached);
    ui.stageSectionLabelText.innerText = formatZone(zone, cached.mapInfo);
    updateNavButtons();
    updateZoneBarActive();
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

function formatTimeDiff(secondsStr) {
    const formatted = formatTime(secondsStr);
    if (formatted === "--:--.--") return formatted;
    // Strip leading "00:" for diffs under 60 seconds
    return formatted.replace(/^00:/, '');
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

let currentMapTier = null;

// Tier colors: T1 (green) -> T8 (dark red) gradient
const TIER_COLORS = {
    1: '#2ecc71',  // green
    2: '#6dbd45',  // yellow-green
    3: '#a8b032',  // olive
    4: '#d4a830',  // gold
    5: '#e8963b',  // orange
    6: '#d46a36',  // red-orange
    7: '#c0392b',  // red
    8: '#8e1a1a',  // dark red
};

function setTierBadge(tier) {
    const t = parseInt(tier);
    if (!t || t < 1 || t > 8) {
        ui.mapTierStat.innerText = 'T-';
        ui.mapTierStat.style.color = '';
        ui.mapTierStat.style.background = '';
        return;
    }
    currentMapTier = t;
    ui.mapTierStat.innerText = `T${t}`;
    ui.mapTierStat.style.color = '#fff';
    ui.mapTierStat.style.background = TIER_COLORS[t] || '';
}

let currentMapInfoData = null; // Cached mapinfo response for current map

// ── Fetch Map Info (mappers, WR time, etc.) ─────────────────────────────────
let mapInfoFetching = null;

async function fetchMapInfo(map) {
    if (!map) return;
    if (mapInfoFetching === map) return;
    mapInfoFetching = map;
    
    try {
        const resp = await fetch(`${getBaseUrl()}/api/mapinfo/${encodeURIComponent(map)}?game=${currentConfig.gameType}`);
        if (!resp.ok) return;
        const data = await resp.json();
        
        if (currentMap !== map) return; // Map changed while fetching
        
        currentMapInfoData = data;
        
        // Update mapper display
        if (ui.mapMapperName) {
            ui.mapMapperName.innerText = data.mappersDisplay ? `by ${data.mappersDisplay}` : '';
        }
        
        // Update tier badge if we got tier from mapinfo
        if (data.tier) {
            setTierBadge(data.tier);
        }
    } catch (e) {
        console.error('[MAPINFO] Error:', e);
    } finally {
        if (mapInfoFetching === map) mapInfoFetching = null;
    }
}

function updateMapPlaytime() {
    // Use zone 0 totalTime (map-specific playtime)
    const zone0 = zoneCache.get(0);
    if (zone0 && zone0.totalTime) {
        ui.mapPlaytimeStat.innerText = formatTotalTime(zone0.totalTime);
    } else {
        ui.mapPlaytimeStat.innerText = "-";
    }
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

    // Update map info card stage/bonus counts
    ui.mapStageStat.innerText = isLinear ? 'Linear' : `${totalStages} Stages`;
    ui.mapBonusStat.innerText = `${totalBonuses} Bonuses`;

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

    const showBar = currentConfig.showZoneBar !== false && currentConfig.showMapInfo !== false;
    ui.zoneBarContainer.style.display = showBar ? 'block' : 'none';
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

        // If main map panel is already showing, don't switch stage panel to main map zone
        if (currentConfig.showMainMapStats) {
            const isLinear = mapInfo && parseInt(mapInfo.type) === 1;
            if (zoneId === 0 || (isLinear && zoneId === 1)) return;
        }

        browsingZone = zoneId;
        displayedStageZone = zoneId;
        broadcastBrowseState(zoneId);

        populateZoneStats(cached);
        ui.stageSectionLabelText.innerText = formatZone(zoneId, mapInfo);
        updateNavButtons();
        updateZoneBarActive();
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

function setWrDisplay(wrTimeEl, wrDiffEl, playerTime, wrDiff, wrTimeVal) {
    const time = parseFloat(playerTime);
    const diff = parseFloat(wrDiff);

    if (!isNaN(time) && !isNaN(diff) && time > 0) {
        const wrTime = time - diff;
        animateValue(wrTimeEl, formatTime(wrTime.toString()));

        const sign = diff > 0 ? "+" : "";
        animateValue(wrDiffEl, `${sign}${formatTimeDiff(Math.abs(diff).toString())}`);
        wrDiffEl.style.color = (diff > 0) ? "var(--accent-color)" : (diff < 0 ? "#2ecc71" : "inherit");
    } else if (wrTimeVal && parseFloat(wrTimeVal) > 0) {
        animateValue(wrTimeEl, formatTime(wrTimeVal));
        wrDiffEl.innerText = "";
        wrDiffEl.style.color = "inherit";
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
    ui.mapName.innerHTML = '<span id="map-spinner" class="spinner" style="display: inline-block;"></span> loading...';
    ui.mapSpinner = document.getElementById('map-spinner');
    ui.mapTierStat.innerText = 'T-';
    ui.mapTierStat.style.color = '';
    ui.mapTierStat.style.background = '';
    if (ui.mapMapperName) ui.mapMapperName.innerText = '';
    currentMapInfoData = null;
    ui.mapStageStat.innerText = '- Stages';
    ui.mapBonusStat.innerText = '- Bonuses';
    ui.mapPlaytimeStat.innerText = '-';
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
    animateValue(ui.mainStatTime, formatTime(d.time));
    animateValue(ui.mainStatRank, formatRank(d.rank, d.totalRanks, d.completions));

    setWrDisplay(ui.mainStatWrTime, ui.mainStatWrDiff, d.time, d.wrDiff, d.wrTime);

    animateValue(ui.mainStatCompletions, d.completions || "-");
    animateValue(ui.mainStatAttempts, d.attempts || "-");
    applyGroupLabel(ui.mainStatGroupLabel, d.group, d.completions);
    animateValue(ui.mainStatCompRate, formatCompRate(d.completions, d.attempts));
    animateValue(ui.mainStatAvgVel, d.avgVel ? Math.round(parseFloat(d.avgVel)).toString() : "-");

    ui.mainStatTotalTime.innerText = formatTotalTime(d.totalTime);
    ui.mainStatFirstDate.innerText = formatDate(d.firstDate);

    animateValue(ui.mainStatStartVel, d.startVel ? Math.round(parseFloat(d.startVel)).toString() : "-");
    animateValue(ui.mainStatEndVel, d.endVel ? Math.round(parseFloat(d.endVel)).toString() : "-");
}

function populateZoneStats(data) {
    animateValue(ui.time, formatTime(data.time));
    animateValue(ui.zone, formatRank(data.rank, data.totalRanks, data.completions));

    setWrDisplay(ui.wrTime, ui.wrDiff, data.time, data.wrDiff, data.wrTime);
    
    animateValue(ui.completions, data.completions || "-");
    animateValue(ui.attempts, data.attempts || "-");
    applyGroupLabel(ui.groupLabel, data.group, data.completions);
    animateValue(ui.compRate, formatCompRate(data.completions, data.attempts));
    animateValue(ui.avgVel, data.avgVel ? Math.round(parseFloat(data.avgVel)).toString() : "-");
    
    ui.totalTime.innerText = formatTotalTime(data.totalTime);
    ui.firstDate.innerText = formatDate(data.firstDate);
    animateValue(ui.startVel, data.startVel ? Math.round(parseFloat(data.startVel)).toString() : "-");
    animateValue(ui.endVel, data.endVel ? Math.round(parseFloat(data.endVel)).toString() : "-");
}

let profileCache = null;
let lastProfileFetch = 0;

async function fetchProfile() {
    // Always fetch profile data even if cards are hidden, so data is ready when toggled on.
    // Profile is re-fetched every poll cycle so stage/bonus/WR counts stay current.
    if (!currentConfig.steamId) return;

    const steamIdAtStart = currentConfig.steamId;
    try {
        const resp = await fetch(`${getBaseUrl()}/api/profile/${encodeURIComponent(steamIdAtStart)}?${apiQuery()}`);
        if (resp.ok) {
            const data = await resp.json();
            // Discard if player changed while we were fetching
            if (currentConfig.steamId !== steamIdAtStart) return;
            profileCache = data;
            lastProfileFetch = Date.now();
            populateProfile(data);
            // Update player data cache with fresh profile
            if (lastFetchData) cachePlayerData(steamIdAtStart, lastFetchData, data);
            saveLocalCache();
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
    // Rank title under username
    const rankCss = getRankTitleCss(d.rankTitle);
    ui.profileRankTitle.innerText = d.rankTitle || "-";
    ui.profileRankTitle.className = "header-rank-label";
    if (rankCss) ui.profileRankTitle.classList.add(rankCss);

    // Rank card: Points, Global Rank, Country Rank, PC%
    animateValue(ui.profilePoints, d.points?.points ? Math.round(d.points.points).toLocaleString() : "-");
    animateValue(ui.profileGlobalRank, d.surfRank ? `#${d.surfRank}` : "-");
    animateValue(ui.profileCountryRank, d.countryRank ? `#${d.countryRank}` : "-");
    animateValue(ui.profileCompletion, d.percentCompletion ? `${d.percentCompletion}%` : "-");

    if (d.completedZones && d.totalZones) {
        animateValue(ui.profileMaps, `${d.completedZones.map || 0}/${d.totalZones.TotalMaps || 0}`);
        animateValue(ui.profileStages, `${d.completedZones.stage || 0}/${d.totalZones.TotalStages || 0}`);
        animateValue(ui.profileBonuses, `${d.completedZones.bonus || 0}/${d.totalZones.TotalBonuses || 0}`);
    }

    animateValue(ui.profileWrs, d.wrZones?.wr || "0");
    animateValue(ui.profileWrcps, d.wrZones?.wrcp || "0");
    animateValue(ui.profileWrbs, d.wrZones?.wrb || "0");
    animateValue(ui.profileTop10s, d.top10Groups?.top10 || "0");
    animateValue(ui.profileGroups, d.top10Groups?.groups || "0");

    // Points breakdown card
    populatePointsBreakdown(d.points);

    // Respect visibility toggles
    const showRank = currentConfig.showRankCard !== false;
    const showComps = currentConfig.showProfileStats !== false;
    const showRecs = currentConfig.showProfileStats !== false;
    const showPB = currentConfig.showPointsBreakdown !== false;

    const rankCard = document.getElementById('profile-rank-card');
    if (rankCard) rankCard.style.display = showRank ? '' : 'none';
    ui.completionsCard.style.display = showComps ? '' : 'none';
    ui.recordsCard.style.display = showRecs ? '' : 'none';
    // Map info card is outside profile-section, managed separately
    ui.mapInfoCard.style.display = (currentConfig.showMapInfo !== false && currentMap) ? '' : 'none';
    ui.pointsBreakdownCard.style.display = showPB ? '' : 'none';

    // Show/hide row containers based on which cards are visible
    if (ui.profileRowTop) ui.profileRowTop.style.display = (showRank || showComps) ? '' : 'none';
    if (ui.profileRowBottom) ui.profileRowBottom.style.display = (showRecs || showPB) ? '' : 'none';

    // Show profile section if at least one sub-section is visible
    const showAny = showRank || showComps || showRecs || showPB;
    ui.profileSection.style.display = showAny ? 'block' : 'none';
    resizeOverlay();
}

function populatePointsBreakdown(points) {
    if (!points) {
        ui.pointsBreakdownCard.innerHTML = '<div class="info-card-title">Points Breakdown</div>';
        return;
    }

    // Categories to display (label -> key), skip 'points' (total) as it's shown elsewhere
    const categories = [
        { key: 'top10', label: 'Top 10' },
        { key: 'groups', label: 'Groups' },
        { key: 'map', label: 'Map' },
        { key: 'stage', label: 'Stage' },
        { key: 'bonus', label: 'Bonus' },
        { key: 'wrcp', label: 'WRCP' },
        { key: 'wrb', label: 'WRB' }
    ];

    const items = [];
    for (const cat of categories) {
        const val = parseFloat(points[cat.key]);
        if (!isNaN(val) && val > 0) {
            items.push({ label: cat.label, value: val });
        }
    }

    if (items.length === 0) {
        ui.pointsBreakdownCard.innerHTML = '<div class="info-card-title">Points Breakdown</div>';
        ui.pointsBreakdownCard.style.display = 'none';
        return;
    }

    // Reuse existing stat elements for smooth animation
    const existingStats = ui.pointsBreakdownCard.querySelectorAll('.info-card-stat');
    const existingMap = {};
    existingStats.forEach(el => {
        const label = el.querySelector('.info-card-label');
        if (label) existingMap[label.textContent] = el;
    });

    // Ensure title exists
    if (!ui.pointsBreakdownCard.querySelector('.info-card-title')) {
        ui.pointsBreakdownCard.insertAdjacentHTML('afterbegin', '<div class="info-card-title">Points Breakdown</div>');
    }

    // Remove stats that are no longer present
    const newLabels = new Set(items.map(i => i.label));
    existingStats.forEach(el => {
        const label = el.querySelector('.info-card-label');
        if (label && !newLabels.has(label.textContent)) el.remove();
    });

    for (const item of items) {
        const existing = existingMap[item.label];
        if (existing) {
            const valueEl = existing.querySelector('.info-card-value');
            if (valueEl) animateValue(valueEl, Math.round(item.value).toLocaleString());
        } else {
            const stat = document.createElement('div');
            stat.className = 'info-card-stat';
            stat.innerHTML = `<span class="info-card-label">${item.label}</span><span class="info-card-value">${Math.round(item.value).toLocaleString()}</span>`;
            ui.pointsBreakdownCard.appendChild(stat);
        }
    }
}

function hideProfile() {
    ui.profileSection.style.display = 'none';
}

let mapStatsFetching = null;

async function fetchMapStats(map, baseData) {
    if (!currentConfig.steamId || !map) return;
    // Guard: include steamId so switching players on the same map triggers a re-fetch
    const fetchKey = `${currentConfig.steamId}:${map}`;
    if (mapStatsFetching === fetchKey) return;
    mapStatsFetching = fetchKey;

    const steamIdAtStart = currentConfig.steamId;

    // Immediately create placeholder entries for ALL zones on this map so
    // navigation arrows and zone-bar clicks work even before the API responds
    // (and for zones the player has never completed).
    ensureAllZonesInCache(map, baseData);

    try {
        const resp = await fetch(`${getBaseUrl()}/api/mapstats/${encodeURIComponent(steamIdAtStart)}/${encodeURIComponent(map)}?${apiQuery()}`);
        if (!resp.ok) {
            console.error(`[MAPSTATS] Failed: ${resp.status} for ${map}`);
            return;
        }
        const result = await resp.json();

        // Discard if player or map changed while we were fetching
        if (!result.zones || currentMap !== map || currentConfig.steamId !== steamIdAtStart) {
            console.warn(`[MAPSTATS] Discarded stale response`);
            return;
        }

        let loaded = 0;
        for (const [zoneIdStr, zoneData] of Object.entries(result.zones)) {
            const zoneId = parseInt(zoneIdStr);
            if (isNaN(zoneId)) continue;

            // Overwrite placeholder (or live zone) with real PR data
            const existing = zoneCache.get(zoneId);
            zoneCache.set(zoneId, {
                ...(existing || {}),
                ...zoneData,
                map: map,
                mapInfo: baseData.mapInfo,
                playerName: baseData.playerName,
                avatarUrl: baseData.avatarUrl,
                steamId64: baseData.steamId64,
                status: baseData.status
            });
            loaded++;
        }
        console.log(`[MAPSTATS] Loaded ${loaded} zones for ${map} (total cached: ${zoneCache.size})`);

        updateNavButtons();
        updateMapCompletionStatus(baseData.mapInfo);
        // Set tier from mapstats response
        if (result.tier) setTierBadge(result.tier);
        // Update map-specific playtime from zone 0 data
        updateMapPlaytime();
        saveLocalCache();
        resizeOverlay();
    } catch (e) {
        console.error(`[MAPSTATS] Error fetching ${map}:`, e);
    }
    finally {
        if (mapStatsFetching === fetchKey) mapStatsFetching = null;
    }
}

// Create placeholder zone cache entries for every stage and bonus on the map.
// This ensures zone-bar clicks and arrow navigation work even for zones the
// player has never completed (which the KSF PRInfo endpoint doesn't return).
function ensureAllZonesInCache(map, baseData) {
    if (!baseData.mapInfo) return;
    const mapType = parseInt(baseData.mapInfo.type); // 0 = staged, 1 = linear
    const totalStages = parseInt(baseData.mapInfo.cpCount) || 0;
    const totalBonuses = parseInt(baseData.mapInfo.bCount) || 0;
    const isLinear = mapType === 1;

    const placeholder = {
        map: map,
        mapInfo: baseData.mapInfo,
        playerName: baseData.playerName,
        avatarUrl: baseData.avatarUrl,
        steamId64: baseData.steamId64,
        status: baseData.status,
        time: null,
        rank: null,
        totalRanks: null,
        completions: 0,
        attempts: null,
        group: null,
        wrDiff: null,
        wrTime: null
    };

    // Zone 0 = main map
    if (!zoneCache.has(0)) {
        zoneCache.set(0, { ...placeholder, zone: 0 });
    }

    if (isLinear) {
        // Linear maps: zone 1 = the single stage (same as main map)
        if (!zoneCache.has(1)) {
            zoneCache.set(1, { ...placeholder, zone: 1 });
        }
    } else {
        // Staged maps: zones 1..totalStages
        for (let i = 1; i <= totalStages; i++) {
            if (!zoneCache.has(i)) {
                zoneCache.set(i, { ...placeholder, zone: i });
            }
        }
    }

    // Bonuses: zones 31..30+totalBonuses
    for (let i = 1; i <= totalBonuses; i++) {
        const zoneId = 30 + i;
        if (!zoneCache.has(zoneId)) {
            zoneCache.set(zoneId, { ...placeholder, zone: zoneId });
        }
    }

    // Update nav and zone bar immediately with placeholders
    updateNavButtons();
    updateMapCompletionStatus(baseData.mapInfo);
    resizeOverlay();
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

// Check if the current map is linear with no bonuses (i.e. only a main map zone).
function isLinearNoBonuses(mapInfo) {
    if (!mapInfo) return false;
    const isLinear = parseInt(mapInfo.type) === 1;
    const bonuses = parseInt(mapInfo.bCount) || 0;
    return isLinear && bonuses === 0;
}

// Show or hide the stage/bonus panel.
// When showMainMapStats is on AND the map is linear-only (no bonuses),
// there's nothing for the stage panel to show, so hide it.
function updateStagePanelVisibility(mapInfo) {
    if (!ui.stagePanel) return;
    if (currentConfig.showMainMapStats && isLinearNoBonuses(mapInfo)) {
        ui.stagePanel.style.display = 'none';
        ui.sectionDivider.style.display = 'none';
    } else {
        ui.stagePanel.style.display = '';
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

    // Re-render map info card from cached data
    if (currentMap) {
        ui.mapName.innerText = formatMapDisplayName(currentMap);
        if (currentConfig.showMapInfo !== false) {
            ui.mapInfoCard.style.display = '';
        }
        setMapBackground(currentMap);
        updateMapPlaytime();

        // Re-render zone bar + map info stats from cached mapInfo
        const anyZone = zoneCache.values().next().value;
        if (anyZone && anyZone.mapInfo) {
            if (anyZone.mapInfo.tier) setTierBadge(anyZone.mapInfo.tier);
            updateMapCompletionStatus(anyZone.mapInfo);
            // Hide stage panel on linear-only maps when main map is separate
            updateStagePanelVisibility(anyZone.mapInfo);
        }

        // Restore mapper info and tier badges
        if (currentMapInfoData) {
            if (ui.mapMapperName) {
                ui.mapMapperName.innerText = currentMapInfoData.mappersDisplay ? `by ${currentMapInfoData.mappersDisplay}` : '';
            }
        } else {
            // Re-fetch mapinfo if not cached
            fetchMapInfo(currentMap);
        }

        // Show stage nav
        ui.stageNav.style.display = 'flex';
    }

    // Re-render the stage panel with the correct zone
    const liveZone = browsingZone !== null ? browsingZone : currentZone;
    let stageZoneId = liveZone;
    const anyZoneData = zoneCache.values().next().value;
    const isLinearMap = anyZoneData && anyZoneData.mapInfo && parseInt(anyZoneData.mapInfo.type) === 1;
    if (showMainMap && (stageZoneId === 0 || (isLinearMap && stageZoneId === 1))) {
        const nonMainZones = getSortedCachedZones();
        stageZoneId = nonMainZones.length > 0 ? nonMainZones[0] : (isLinearMap ? 1 : 0);
    } else if (!showMainMap && currentConfig.hideStages && stageZoneId >= 1 && stageZoneId <= 30) {
        const allowedZones = getSortedCachedZones();
        stageZoneId = allowedZones.length > 0 ? allowedZones[0] : 0;
    }
    displayedStageZone = stageZoneId;
    const cached = zoneCache.get(stageZoneId);
    if (cached) {
        populateZoneStats(cached);
        ui.stageSectionLabelText.innerText = formatZone(stageZoneId, cached.mapInfo);
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

    // When a sub-view (map detail / maps browser) is active, update data caches
    // but don't touch main view DOM elements — they're hidden.
    const mainViewActive = activeView === 'main';

    if (data.status === 'online') {
        if (mainViewActive) {
            ui.statusIndicator.innerHTML = '<span class="status-dot"></span>ONLINE';
            ui.statusIndicator.className = "status-badge online";
        }
        
        if (mainViewActive) {
            if (ui.mapSpinner) ui.mapSpinner.style.display = 'none';
            ui.mapName.innerText = formatMapDisplayName(data.map) || "Unknown Map";
        }

        // Set tier from mapInfo (if available from server status)
        if (data.mapInfo && data.mapInfo.tier) {
            setTierBadge(data.mapInfo.tier);
        }

        // Show map info card if toggle is on (it's now a standalone card outside profile-section)
        if (mainViewActive) {
            if (currentConfig.showMapInfo !== false) {
                ui.mapInfoCard.style.display = '';
            } else {
                ui.mapInfoCard.style.display = 'none';
            }
        }

        // Set map background image
        if (mainViewActive) setMapBackground(data.map);

        if (mainViewActive && data.serverName) {
            const totalOnline = data.serverPlayers ? data.serverPlayers.length : 1;
            ui.playingOnLabel.style.display = 'block';
            ui.serverInfo.innerText = `${data.serverName} \u2022 ${totalOnline} online`;
            ui.serverInfo.style.display = 'block';

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
                        // Abort any in-flight requests for the previous player
                        if (currentFetchController) { currentFetchController.abort(); currentFetchController = null; }
                        if (directFetchController) { directFetchController.abort(); directFetchController = null; }
                        isUpdating = false;
                        mapStatsFetching = null;

                        // Save current player's state before switching
                        savePillSnapshot();
                        // Cache current player's data for instant switch-back
                        cachePlayerData(currentConfig.steamId, lastFetchData, profileCache);

                        // Track whether we're viewing another player or switching back to our own.
                        // viewingOtherPlayer stores our "own" steamId when viewing someone else.
                        if (!viewingOtherPlayer) {
                            viewingOtherPlayer = currentConfig.steamId;
                        }
                        
                        currentConfig.steamId = p.steamid;

                        profileCache = null;
                        lastProfileFetch = 0;
                        zoneCache.clear();
                        currentMap = null;
                        currentZone = null;
                        browsingZone = null;
                        displayedStageZone = null;

                        ui.playersModal.style.display = 'none';

                        // Show cached data instantly if available
                        const cached = getCachedPlayerData(p.steamid);
                        if (cached) {
                            updateUI(cached.data);
                            if (cached.profile) {
                                profileCache = cached.profile;
                                populateProfile(cached.profile);
                            }
                        }

                        // Direct fetch from server (hits server cache = instant) then start polling
                        directFetchAndRender(p.steamid).then(() => {
                            saveLastRefreshTime(Date.now());
                            startPolling(false);
                        });
                    });
                    
                    ui.playersList.appendChild(item);
                }
            }
        } else if (mainViewActive) {
            ui.playingOnLabel.style.display = 'none';
            ui.serverInfo.style.display = 'none';
        }

        if (data.map && data.map !== currentMap) {
            console.log(`[UI] Map changed: ${currentMap} -> ${data.map}, fetching map stats`);
            zoneCache.clear();
            browsingZone = null;
            displayedStageZone = null;
            currentMapInfoData = null;
            mapInfoFetching = null;
            currentMap = data.map;
            fetchMapStats(data.map, data);
            fetchMapInfo(data.map); // Fetch mapper info, WR times, etc.
        } else if (data.map) {
            // Re-fetch all zone stats on every poll so stages/bonuses stay current
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

        // Update map-specific playtime from zone 0 data
        updateMapPlaytime();

        // ── Main Map panel logic ─────────────────────────────────────
        const mainMapData = data.mainMapStats || zoneCache.get(0) || null;
        const showMainMap = currentConfig.showMainMapStats && mainMapData;
        if (mainViewActive) {
            showMainMapPanel(showMainMap, mainMapData);
            updateMapCompletionStatus(data.mapInfo);
            updateStagePanelVisibility(data.mapInfo);
            ui.stageNav.style.display = 'flex';
        }

        const prevZone = currentZone;
        currentZone = zoneId;
        const zoneChanged = prevZone !== null && prevZone !== zoneId && zoneId !== null;

        if (mainViewActive) {
            // Determine which zone the stage panel should display.
            let stageZoneId = zoneId;
            const isLinear = data.mapInfo && parseInt(data.mapInfo.type) === 1;
            if (showMainMap && (stageZoneId === 0 || (isLinear && stageZoneId === 1))) {
                const nonMainZones = getSortedCachedZones();
                stageZoneId = nonMainZones.length > 0 ? nonMainZones[0] : (isLinear ? 1 : 0);
            } else if (!showMainMap && currentConfig.hideStages && stageZoneId >= 1 && stageZoneId <= 30) {
                const allowedZones = getSortedCachedZones();
                stageZoneId = allowedZones.length > 0 ? allowedZones[0] : 0;
            }

            const stageData = zoneCache.get(stageZoneId) || data;
            displayedStageZone = stageZoneId;

            if (currentConfig.autoFollowStage) {
                browsingZone = null;
                broadcastBrowseState(null);
                populateZoneStats(stageData);
                ui.stageSectionLabelText.innerText = formatZone(stageZoneId, data.mapInfo);
                updateNavButtons();
                updateZoneBarActive();
            } else {
                if (browsingZone === null || browsingZone === zoneId) {
                    populateZoneStats(stageData);
                    ui.stageSectionLabelText.innerText = formatZone(stageZoneId, data.mapInfo);
                    updateNavButtons();
                    updateZoneBarActive();
                } else {
                    updateNavButtons();
                    updateZoneBarActive();
                }
            }
        }
        
        if (mainViewActive && data.playerName) {
            ui.playerNameText.innerText = data.playerName;
            const country = data.country || (profileCache ? profileCache.country : null);
            setPlayerFlag(country);
        }

        if (mainViewActive) {
            // Visual indicator when viewing another player's stats
            if (viewingOtherPlayer) {
                ui.playerName.classList.add('viewing-other');
                ui.playerName.title = 'Click to return to your stats';
            } else {
                ui.playerName.classList.remove('viewing-other');
                ui.playerName.title = '';
            }
        }

    } else if (mainViewActive) {
        ui.statusIndicator.innerHTML = '<span class="status-dot"></span>OFFLINE';
        ui.statusIndicator.className = "status-badge offline";
        clearStats();
        ui.mainMapSection.style.display = 'none';
        ui.mainMapSection.classList.remove('expanded');
        ui.sectionDivider.style.display = 'none';
        ui.stageNav.style.display = 'none';
        if (ui.stagePanel) ui.stagePanel.style.display = '';
        ui.mapName.innerText = "Offline";
        ui.mapTierStat.innerText = 'T-';
        ui.mapTierStat.style.color = '';
        ui.mapTierStat.style.background = '';
        if (ui.mapMapperName) ui.mapMapperName.innerText = '';
        currentMapInfoData = null;
        ui.mapStageStat.innerText = '- Stages';
        ui.mapBonusStat.innerText = '- Bonuses';
        ui.mapPlaytimeStat.innerText = '-';
        ui.mapInfoBg.style.backgroundImage = '';
        ui.mapInfoBg.classList.remove('loaded');
        ui.mapInfoCard.style.display = 'none';
        ui.zoneBarContainer.style.display = 'none';
        ui.playingOnLabel.style.display = 'none';
        ui.serverInfo.style.display = 'none';

        if (data.playerName) {
            ui.playerNameText.innerText = data.playerName;
        } else if (data.rawStatus?.name) {
            ui.playerNameText.innerText = data.rawStatus.name;
        }

        if (viewingOtherPlayer) {
            ui.playerName.classList.add('viewing-other');
            ui.playerName.title = 'Click to return to your stats';
        } else {
            ui.playerName.classList.remove('viewing-other');
            ui.playerName.title = '';
        }
    }

    if (mainViewActive) resizeOverlay();
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

// ── Map Detail & Maps Browser Views ─────────────────────────────────────────

let activeView = 'main'; // 'main' | 'detail' | 'browser'
let mapsListCache = null;
let mapsListFetching = false;

// Elements that make up the "main" view — hidden when a sub-view is active
function getMainViewElements() {
    return [
        ui.header, ui.cardsLayout, ui.mapInfoCard,
        ui.profileSection, ui.footer, ui.emptyState
    ];
}

function showView(view) {
    activeView = view;
    const mainEls = getMainViewElements();

    if (view === 'main') {
        // Restore main view
        mainEls.forEach(el => { if (el) el.style.removeProperty('display'); });
        ui.mapDetailView.style.display = 'none';
        ui.mapsBrowserView.style.display = 'none';
        // Re-apply config visibility (some sections may be toggled off)
        applyConfig();
    } else if (view === 'detail') {
        mainEls.forEach(el => { if (el) el.style.display = 'none'; });
        ui.mapDetailView.style.display = 'block';
        ui.mapsBrowserView.style.display = 'none';
    } else if (view === 'browser') {
        mainEls.forEach(el => { if (el) el.style.display = 'none'; });
        ui.mapDetailView.style.display = 'none';
        ui.mapsBrowserView.style.display = 'block';
    }
    resizeOverlay();
}

// ── Map Detail View ─────────────────────────────────────────────────────────

function openMapDetail(mapName) {
    if (!mapName) return;
    showView('detail');
    populateMapDetail(mapName);
}

let mapDetailMapName = null; // Track which map the detail view is showing

async function populateMapDetail(mapName) {
    mapDetailMapName = mapName;

    // Hero bg image with fade
    const imgUrl = `https://ksf.surf/images/${encodeURIComponent(mapName)}.jpg`;
    ui.mapDetailHeroBg.classList.remove('loaded');
    const img = new Image();
    img.onload = () => {
        if (mapDetailMapName === mapName) {
            ui.mapDetailHeroBg.style.backgroundImage = `url('${imgUrl}')`;
            ui.mapDetailHeroBg.classList.add('loaded');
        }
    };
    img.src = imgUrl;

    // Reset
    ui.mapDetailName.innerText = formatMapDisplayName(mapName);
    ui.mapDetailTier.innerText = 'T-';
    ui.mapDetailTier.style.background = '';
    ui.mapDetailMapper.innerText = '';
    ui.mapDetailStageStat.innerText = '- Stages';
    ui.mapDetailBonusStat.innerText = '- Bonuses';
    ui.mapDetailPlaytime.innerText = '-';
    ui.mapDetailWr.innerText = '-';
    ui.mapDetailZones.innerHTML = '';
    ui.mapDetailZoneBar.style.display = 'none';
    ui.compareSection.style.display = 'none';
    ui.compareInput.value = '';
    ui.mapDetailZones.style.display = '';

    // Immediately populate from maps.json cache
    const localMap = mapsListCache && mapsListCache.find(m => m.name === mapName);
    if (localMap) {
        const t = parseInt(localMap.tier);
        if (t >= 1 && t <= 8) {
            ui.mapDetailTier.innerText = `T${t}`;
            ui.mapDetailTier.style.background = TIER_COLORS[t] || '';
            ui.mapDetailTier.style.color = '#fff';
        }
        if (localMap.mapper) ui.mapDetailMapper.innerText = `by ${localMap.mapper}`;
        const isLin = localMap.type === 'linear';
        ui.mapDetailStageStat.innerText = isLin ? 'Linear' : `${localMap.stages} Stages`;
        ui.mapDetailBonusStat.innerText = `${localMap.bonuses} Bonuses`;
    }

    // Build zone bar from zoneCache (if this is the current map)
    buildDetailZoneBar(mapName, localMap);

    // Fetch full mapinfo from API for WR time
    let info = currentMapInfoData;
    if (!info || info.map !== mapName) {
        try {
            const resp = await fetch(`${getBaseUrl()}/api/mapinfo/${encodeURIComponent(mapName)}?game=${currentConfig.gameType}`);
            if (resp.ok) info = await resp.json();
        } catch (e) {}
    }

    if (info) {
        const t = parseInt(info.tier);
        if (t >= 1 && t <= 8) {
            ui.mapDetailTier.innerText = `T${t}`;
            ui.mapDetailTier.style.background = TIER_COLORS[t] || '';
            ui.mapDetailTier.style.color = '#fff';
        }
        if (info.mappersDisplay) ui.mapDetailMapper.innerText = `by ${info.mappersDisplay}`;
        const isLin = info.mapType === 1;
        ui.mapDetailStageStat.innerText = isLin ? 'Linear' : `${info.cpCount || 0} Stages`;
        ui.mapDetailBonusStat.innerText = `${info.bCount || 0} Bonuses`;
        if (info.wrTime) ui.mapDetailWr.innerText = formatTime(info.wrTime.toString());
    }

    // Playtime from zone 0
    const zone0 = zoneCache.get(0);
    if (zone0 && zone0.totalTime && currentMap === mapName) {
        ui.mapDetailPlaytime.innerText = formatTotalTime(zone0.totalTime);
    }

    // Populate zone rows from zoneCache (player's data for this map)
    populateDetailZoneRows(mapName, info);
    resizeOverlay();
}

function buildDetailZoneBar(mapName, localMap) {
    ui.mapDetailZoneBarStages.innerHTML = '';
    ui.mapDetailZoneBarBonuses.innerHTML = '';
    if (currentMap !== mapName || zoneCache.size === 0) {
        ui.mapDetailZoneBar.style.display = 'none';
        return;
    }

    // Use mapInfo from zone cache to get stage/bonus counts
    const anyZone = zoneCache.values().next().value;
    const mapInfo = anyZone && anyZone.mapInfo;
    if (!mapInfo && !localMap) {
        ui.mapDetailZoneBar.style.display = 'none';
        return;
    }

    const mapType = mapInfo ? parseInt(mapInfo.type) : (localMap && localMap.type === 'linear' ? 1 : 0);
    const totalStages = mapInfo ? (parseInt(mapInfo.cpCount) || 0) : (localMap ? localMap.stages : 0);
    const totalBonuses = mapInfo ? (parseInt(mapInfo.bCount) || 0) : (localMap ? localMap.bonuses : 0);
    const isLinear = mapType === 1;

    if (isLinear) {
        const box = createZoneBox(0, 'Main', mapInfo);
        ui.mapDetailZoneBarStages.appendChild(box);
    } else {
        for (let i = 1; i <= totalStages; i++) {
            const box = createZoneBox(i, `S${i}`, mapInfo);
            ui.mapDetailZoneBarStages.appendChild(box);
        }
    }

    if (totalBonuses > 0) {
        for (let i = 1; i <= totalBonuses; i++) {
            const box = createZoneBox(30 + i, `B${i}`, mapInfo);
            ui.mapDetailZoneBarBonuses.appendChild(box);
        }
    }

    ui.mapDetailZoneBar.style.display = 'block';
}

function populateDetailZoneRows(mapName, info) {
    ui.mapDetailZones.innerHTML = '';
    if (currentMap !== mapName || zoneCache.size === 0) return;

    const sortedZones = Array.from(zoneCache.entries()).sort(([a], [b]) => a - b);

    for (const [zoneId, zd] of sortedZones) {
        const row = document.createElement('div');
        row.className = 'map-detail-zone-row';

        const label = document.createElement('span');
        label.className = 'zone-label';
        label.innerText = formatZone(zoneId, info || (zd && zd.mapInfo));

        const time = document.createElement('span');
        time.className = 'zone-time';
        time.innerText = zd.time ? formatTime(zd.time) : '--:--.--';

        const rank = document.createElement('span');
        rank.className = 'zone-rank';
        rank.innerText = zd.rank && zd.totalRanks ? `${zd.rank}/${zd.totalRanks}` : '-/-';

        row.appendChild(label);
        row.appendChild(time);
        row.appendChild(rank);
        ui.mapDetailZones.appendChild(row);
    }
}

// ── Compare Stats ───────────────────────────────────────────────────────────
let compareFetching = false;

async function compareWithPlayer(input) {
    if (!input || !mapDetailMapName || compareFetching) return;
    compareFetching = true;
    ui.compareSection.style.display = 'block';
    ui.comparePlayerRight.innerText = input;
    ui.compareRows.innerHTML = '<div class="maps-browser-loading">Loading...</div>';
    resizeOverlay();

    try {
        // Fetch the other player's map stats
        const resp = await fetch(`${getBaseUrl()}/api/mapstats/${encodeURIComponent(input)}/${encodeURIComponent(mapDetailMapName)}?${apiQuery()}`);
        if (!resp.ok) {
            ui.compareRows.innerHTML = '<div class="maps-browser-loading">Player not found</div>';
            return;
        }
        const result = await resp.json();
        if (!result.zones) {
            ui.compareRows.innerHTML = '<div class="maps-browser-loading">No data for this map</div>';
            return;
        }

        // Set left player name
        const playerName = lastFetchData && lastFetchData.playerName ? lastFetchData.playerName : 'You';
        ui.comparePlayerLeft.innerText = playerName;

        // Build compare rows
        ui.compareRows.innerHTML = '';
        ui.mapDetailZones.style.display = 'none'; // hide regular zone rows

        // Get all zones from both players
        const allZoneIds = new Set([
            ...Array.from(zoneCache.keys()),
            ...Object.keys(result.zones).map(Number)
        ]);
        const sortedIds = [...allZoneIds].sort((a, b) => a - b);

        const anyZone = zoneCache.values().next().value;
        const mapInfo = anyZone && anyZone.mapInfo;

        for (const zoneId of sortedIds) {
            const myZone = zoneCache.get(zoneId);
            const theirZone = result.zones[zoneId];
            const myTime = myZone && myZone.time ? parseFloat(myZone.time) : null;
            const theirTime = theirZone && theirZone.time ? parseFloat(theirZone.time) : null;

            const row = document.createElement('div');
            row.className = 'compare-row';

            // Left (my time)
            const left = document.createElement('span');
            left.className = 'cr-left';
            if (myTime != null) {
                const isFaster = theirTime != null && myTime < theirTime;
                const isSlower = theirTime != null && myTime > theirTime;
                left.classList.add(isFaster ? 'cr-faster' : isSlower ? 'cr-slower' : 'cr-neutral');
                left.innerHTML = formatTime(myTime.toString());
                if (theirTime != null && myTime !== theirTime) {
                    const diff = myTime - theirTime;
                    left.innerHTML += `<span class="cr-diff">${diff > 0 ? '+' : ''}${diff.toFixed(3)}</span>`;
                }
            } else {
                left.classList.add('cr-neutral');
                left.innerText = '--:--.--';
            }

            // Zone label
            const zone = document.createElement('span');
            zone.className = 'cr-zone';
            zone.innerText = formatZone(zoneId, mapInfo);

            // Right (their time)
            const right = document.createElement('span');
            right.className = 'cr-right';
            if (theirTime != null) {
                const isFaster = myTime != null && theirTime < myTime;
                const isSlower = myTime != null && theirTime > myTime;
                right.classList.add(isFaster ? 'cr-faster' : isSlower ? 'cr-slower' : 'cr-neutral');
                right.innerHTML = formatTime(theirTime.toString());
                if (myTime != null && myTime !== theirTime) {
                    const diff = theirTime - myTime;
                    right.innerHTML += `<span class="cr-diff">${diff > 0 ? '+' : ''}${diff.toFixed(3)}</span>`;
                }
            } else {
                right.classList.add('cr-neutral');
                right.innerText = '--:--.--';
            }

            row.appendChild(left);
            row.appendChild(zone);
            row.appendChild(right);
            ui.compareRows.appendChild(row);
        }
    } catch (e) {
        console.error('[COMPARE] Error:', e);
        ui.compareRows.innerHTML = '<div class="maps-browser-loading">Error loading stats</div>';
    } finally {
        compareFetching = false;
        resizeOverlay();
    }
}

// ── Maps Browser View ───────────────────────────────────────────────────────

function openMapsBrowser() {
    showView('browser');
    ui.mapsSearch.value = '';
    ui.mapsBrowserList.innerHTML = '<div class="maps-browser-loading">Loading maps...</div>';
    fetchMapsList();
}

async function fetchMapsList() {
    if (mapsListFetching) return;
    mapsListFetching = true;

    try {
        const resp = await fetch(`${getBaseUrl()}/api/maps?game=${currentConfig.gameType}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const maps = await resp.json();
        mapsListCache = maps;
        renderMapsList(maps);
    } catch (e) {
        console.error('[MAPS] Error fetching maps list:', e);
        ui.mapsBrowserList.innerHTML = '<div class="maps-browser-loading">Failed to load maps</div>';
    } finally {
        mapsListFetching = false;
    }
}

function renderMapsList(maps) {
    ui.mapsBrowserList.innerHTML = '';
    if (!maps || maps.length === 0) {
        ui.mapsBrowserList.innerHTML = '<div class="maps-browser-loading">No maps found</div>';
        return;
    }

    for (const m of maps) {
        const card = document.createElement('div');
        card.className = 'maps-browser-card';
        card.dataset.mapName = m.name;

        const tierBadge = document.createElement('span');
        tierBadge.className = 'map-card-tier';
        tierBadge.innerText = `T${m.tier}`;
        tierBadge.style.background = TIER_COLORS[m.tier] || 'rgba(255,255,255,0.1)';

        const name = document.createElement('span');
        name.className = 'map-card-name';
        name.innerText = formatMapDisplayName(m.name);

        const type = document.createElement('span');
        type.className = 'map-card-type';
        type.innerText = m.type || '';

        const meta = document.createElement('span');
        meta.className = 'map-card-meta';
        const parts = [];
        if (m.stages) parts.push(`${m.stages}s`);
        if (m.bonuses) parts.push(`${m.bonuses}b`);
        meta.innerText = parts.join(' ');

        card.appendChild(tierBadge);
        card.appendChild(name);
        card.appendChild(type);
        card.appendChild(meta);

        // Show mapper if available
        if (m.mapper) {
            const mapper = document.createElement('span');
            mapper.className = 'map-card-mapper';
            mapper.innerText = m.mapper;
            card.appendChild(mapper);
        }

        card.addEventListener('click', () => {
            openMapDetail(m.name);
        });

        ui.mapsBrowserList.appendChild(card);
    }
    resizeOverlay();
}

function filterMapsList(query) {
    if (!mapsListCache) return;
    const q = query.toLowerCase().trim();
    if (!q) {
        renderMapsList(mapsListCache);
        return;
    }
    const filtered = mapsListCache.filter(m => {
        const nameMatch = m.name.toLowerCase().includes(q);
        const mapperMatch = m.mapper && m.mapper.toLowerCase().includes(q);
        return nameMatch || mapperMatch;
    });
    renderMapsList(filtered);
}

// ── Event Handlers for Views ────────────────────────────────────────────────

// Click on map info card opens detail view
ui.mapInfoCard.addEventListener('click', (e) => {
    // Don't open detail when clicking the map name (that's copy-to-clipboard)
    if (e.target.closest('.map-name-clickable')) return;
    // Don't open from zone bar clicks
    if (e.target.closest('.zone-bar-container')) return;
    if (!currentMap) return;
    openMapDetail(currentMap);
});

// Close map detail
ui.mapDetailClose.addEventListener('click', () => {
    showView('main');
});

// View Maps button
ui.mapDetailBrowseBtn.addEventListener('click', () => {
    openMapsBrowser();
});

// Close maps browser — go back to detail if we came from there, else main
ui.mapsBrowserClose.addEventListener('click', () => {
    showView('main');
});

// Search input
ui.mapsSearch.addEventListener('input', (e) => {
    filterMapsList(e.target.value);
});

// Compare input — trigger on Enter
ui.compareInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const val = ui.compareInput.value.trim();
        if (val) compareWithPlayer(val);
    }
});
