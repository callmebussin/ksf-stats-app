const isElectron = (typeof process !== 'undefined') && process.versions && process.versions.electron;
const ipcRenderer = isElectron ? require('electron').ipcRenderer : null;

const SERVER_URL = 'http://108.61.222.248:3000';

let currentConfig = {
    steamId: "",
    refreshRate: 60,
    opacity: 100,
    showMainMapStats: false,
    showProfile: true,
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

const zoneCache = new Map();
let browsingZone = null;

const ui = {
    avatar: document.getElementById('player-avatar'),
    playerName: document.getElementById('player-name'),
    mapName: document.getElementById('map-name'),
    mapSpinner: document.getElementById('map-spinner'),
    statusIndicator: document.getElementById('status-indicator'),
    updateTimer: document.getElementById('update-timer'),
    
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

function navigateZone(direction) {
    const zones = getSortedCachedZones();
    if (zones.length === 0) return;

    const viewingZone = browsingZone !== null ? browsingZone : currentZone;
    const idx = zones.indexOf(viewingZone);
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= zones.length) return;

    const newZone = zones[newIdx];
    const slideDir = direction > 0 ? 'left' : 'right';
    
    browsingZone = newZone;
    broadcastBrowseState(newZone);
    const cached = zoneCache.get(newZone);
    if (cached) {
        slideStageContent(slideDir, () => {
            populateZoneStats(cached);
            ui.stageSectionLabel.innerText = formatZone(newZone, cached.mapInfo);
            updateNavButtons();
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
    const viewingZone = browsingZone !== null ? browsingZone : currentZone;
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
        const prevSteamId = currentConfig.steamId;
        const prevRefreshRate = currentConfig.refreshRate;
        const prevShowMainMap = currentConfig.showMainMapStats;
        const prevAutoFollow = currentConfig.autoFollowStage;
        const prevHorizontal = currentConfig.horizontalLayout;
        const prevShowProfile = currentConfig.showProfile;
        currentConfig = { ...currentConfig, ...config };
        applyConfig();
        
        const steamIdChanged = config.steamId !== prevSteamId;
        const rateChanged = config.refreshRate !== prevRefreshRate;
        const layoutChanged = config.showMainMapStats !== prevShowMainMap || config.autoFollowStage !== prevAutoFollow || config.horizontalLayout !== prevHorizontal || config.showProfile !== prevShowProfile;

        if (!hasInitialized || steamIdChanged) {
            if (steamIdChanged) { profileCache = null; lastProfileFetch = 0; }
            hasInitialized = true;
            startPolling(true);
        } else if (rateChanged) {
            startPolling(false);
        }

        if (layoutChanged && hasInitialized) {
            const liveZone = browsingZone !== null ? browsingZone : currentZone;
            const cached = liveZone !== null ? zoneCache.get(liveZone) : null;
            if (cached) {
                updateUI(cached);
            } else {
                resizeOverlay();
            }
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

    if (currentConfig.showProfile) {
        if (profileCache) populateProfile(profileCache);
    } else {
        hideProfile();
    }

    if (!currentConfig.steamId) {
        ui.playerName.innerText = "No SteamID";
        ui.statusIndicator.innerText = "SETUP";
        ui.statusIndicator.className = "status offline";
    }
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
        const liveZone = browsingZone !== null ? browsingZone : currentZone;
        const cached = liveZone !== null ? zoneCache.get(liveZone) : null;
        if (cached) {
            updateUI(cached);
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

    const rate = Math.max(currentConfig.refreshRate || 60, 30);
    refreshInterval = setInterval(fetchStats, rate * 1000);
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
            applyRemoteBrowseState(data.zone);
        }
    } catch (e) {}
}

function updateFooterTimer() {
    if (!lastRefreshTime) {
        ui.updateTimer.innerText = "Waiting...";
        return;
    }
    
    const rate = Math.max(currentConfig.refreshRate || 60, 30);
    const nextUpdate = lastRefreshTime + (rate * 1000);
    const now = Date.now();
    const diff = Math.ceil((nextUpdate - now) / 1000);
    
    if (diff > 0) {
        ui.updateTimer.innerText = `Next update: ${diff}s`;
    } else {
        ui.updateTimer.innerText = "Updating...";
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
        ui.statusIndicator.innerText = "NET ERROR";
        ui.statusIndicator.className = "status offline";
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

    slideStageContent(slideDir, () => {
        populateZoneStats(cached);
        ui.stageSectionLabel.innerText = formatZone(zone, cached.mapInfo);
        updateNavButtons();
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
    ui.mapName.innerHTML = '<span id="map-spinner" class="spinner" style="display: inline-block;"></span> loading map data...';
    ui.mapSpinner = document.getElementById('map-spinner');
}

function populateMainMapStats(d) {
    ui.mainStatTime.innerText = formatTime(d.time);

    if (d.rank && d.totalRanks) {
        ui.mainStatRank.innerText = `${d.rank}/${d.totalRanks}`;
    } else {
        ui.mainStatRank.innerText = "-/-";
    }

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

    if (data.rank && data.totalRanks) {
        const r = parseInt(data.rank);
        const t = parseInt(data.totalRanks);
        if (!isNaN(r) && !isNaN(t) && r > t) {
            ui.zone.innerText = "N/A";
        } else {
            ui.zone.innerText = `${data.rank || "-"}/${data.totalRanks || "-"}`;
        }
    } else {
        ui.zone.innerText = "-/-";
    }

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

    ui.profileSection.style.display = 'block';
    ui.profileDivider.style.display = 'block';
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
        resizeOverlay();
    } catch (e) {}
    finally {
        if (mapStatsFetching === map) mapStatsFetching = null;
    }
}

function updateUI(data) {
    if (data.avatarUrl) {
        ui.avatar.style.backgroundImage = `url('${data.avatarUrl}')`;
    } else if (data.steamId64) {
        ui.avatar.style.backgroundImage = `url('https://avatars.steamstatic.com/${data.steamId64}_full.jpg')`;
    }

    if (data.status === 'online') {
        ui.statusIndicator.innerText = "ONLINE";
        ui.statusIndicator.className = "status online";
        
        ui.mapSpinner.style.display = 'none';
        ui.mapName.innerText = data.map || "Unknown Map";

        if (data.map && data.map !== currentMap) {
            zoneCache.clear();
            browsingZone = null;
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

        const showMainMap = currentConfig.showMainMapStats && data.mainMapStats && data.zone !== 0;
        if (showMainMap) {
            ui.mainMapSection.style.display = 'block';
            requestAnimationFrame(() => ui.mainMapSection.classList.add('expanded'));
            ui.sectionDivider.style.display = 'block';
            ui.sectionDivider.style.opacity = '1';
            populateMainMapStats(data.mainMapStats);
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

        ui.stageNav.style.display = 'flex';

        const prevZone = currentZone;
        currentZone = zoneId;
        const zoneChanged = prevZone !== null && prevZone !== zoneId && zoneId !== null;

        if (currentConfig.autoFollowStage) {
            browsingZone = null;
            broadcastBrowseState(null);

            if (zoneChanged) {
                const slideDir = (zoneId > prevZone) ? 'left' : 'right';
                slideStageContent(slideDir, () => {
                    populateZoneStats(data);
                    ui.stageSectionLabel.innerText = formatZone(zoneId, data.mapInfo);
                    updateNavButtons();
                });
            } else {
                populateZoneStats(data);
                ui.stageSectionLabel.innerText = formatZone(zoneId, data.mapInfo);
                updateNavButtons();
            }
        } else {
            if (browsingZone === null || browsingZone === zoneId) {
                populateZoneStats(data);
                ui.stageSectionLabel.innerText = formatZone(zoneId, data.mapInfo);
                updateNavButtons();
            } else {
                updateNavButtons();
            }
        }
        
        if (data.playerName) ui.playerName.innerText = data.playerName;

    } else {
        ui.statusIndicator.innerText = "OFFLINE";
        ui.statusIndicator.className = "status offline";
        showLoadingState();
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
