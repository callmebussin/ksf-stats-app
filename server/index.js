require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');

// ── File Logger ──────────────────────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function getLogFilePath() {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return path.join(LOG_DIR, `server-${date}.log`);
}

function writeToLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a, null, 2); } catch { return String(a); }
    }).join(' ');
    const line = `[${timestamp}] [${level}] ${message}\n`;
    try {
        fs.appendFileSync(getLogFilePath(), line);
    } catch (e) { /* ignore write errors */ }
}

const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
const originalWarn = console.warn.bind(console);

console.log = (...args) => { originalLog(...args); writeToLog('INFO', ...args); };
console.error = (...args) => { originalError(...args); writeToLog('ERROR', ...args); };
console.warn = (...args) => { originalWarn(...args); writeToLog('WARN', ...args); };

// ── Config ───────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
let serverConfig = {
    port: 3000,
    ksfApiUrl: 'http://surftimer.com/api2',
    rateLimit: { windowMs: 60000, maxRequests: 100 },
    timeouts: { ksfApiFetch: 5000, steamIdResolve: 5000 },
    steamApiKey: "",
    ksfCacheTTL: 30000  // cache KSF responses for 30s
};

try {
    if (fs.existsSync(CONFIG_PATH)) {
        const data = fs.readFileSync(CONFIG_PATH);
        serverConfig = { ...serverConfig, ...JSON.parse(data) };
        console.log("Loaded server config:", serverConfig);
    }
} catch (e) {
    console.error("Failed to load config.json, using defaults", e);
}

console.log(`Log file: ${getLogFilePath()}`);

const app = express();
const PORT = process.env.PORT || serverConfig.port;
const KSF_API_TOKEN = process.env.KSF_API_TOKEN;

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false
}));
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        if (req.originalUrl.startsWith('/api/browse')) return;
        const duration = Date.now() - start;
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        console.log(`[REQ] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${duration}ms (from ${ip})`);
    });
    next();
});

const limiter = rateLimit({
    windowMs: serverConfig.rateLimit.windowMs,
    max: serverConfig.rateLimit.maxRequests,
    message: { error: "Too many requests, please try again later." }
});
// Only rate-limit the heavy KSF-proxied endpoints, not lightweight local sync endpoints
// like /api/browse (polled every 1.5s by OBS) and /api/config
app.use('/api', (req, res, next) => {
    if (req.path === '/browse' || req.path === '/config') return next();
    return limiter(req, res, next);
});

const CLIENT_PUBLIC_PATH = path.join(__dirname, '..', 'client', 'public');
app.use(express.static(CLIENT_PUBLIC_PATH, { etag: false, lastModified: false, maxAge: 0 }));

const KSF_BASE_URL = serverConfig.ksfApiUrl;
const STEAM_API_KEY = process.env.STEAM_API_KEY || serverConfig.steamApiKey;

const steamIdCache = new Map();
const avatarCache = new Map();
const countryCache = new Map();
const STEAMID_CACHE_TTL = 3600000;
const AVATAR_CACHE_TTL = 1800000;

// ── KSF Response Cache ──────────────────────────────────────────────────────
// Prevents duplicate requests to KSF API within the TTL window
const ksfResponseCache = new Map();
const KSF_CACHE_TTL = serverConfig.ksfCacheTTL || 30000; // 30s default

// Track KSF API call stats
let ksfCallStats = { total: 0, cached: 0, errors: 0, lastReset: Date.now() };

function getKsfStats() {
    const elapsed = ((Date.now() - ksfCallStats.lastReset) / 1000).toFixed(0);
    return `[KSF STATS] total=${ksfCallStats.total} cached=${ksfCallStats.cached} errors=${ksfCallStats.errors} over ${elapsed}s`;
}

// Log stats every 5 minutes
setInterval(() => {
    console.log(getKsfStats());
    ksfCallStats = { total: 0, cached: 0, errors: 0, lastReset: Date.now() };
}, 300000);

// Inflight dedup: if the same URL is already being fetched, reuse the promise
const ksfInflight = new Map();

async function fetchKSFData(url) {
    ksfCallStats.total++;

    // Check cache first
    const cached = ksfResponseCache.get(url);
    if (cached && (Date.now() - cached.timestamp) < KSF_CACHE_TTL) {
        ksfCallStats.cached++;
        console.log(`[KSF] CACHE HIT (${((Date.now() - cached.timestamp) / 1000).toFixed(1)}s old) ${url}`);
        return cached.data;
    }

    // Dedup inflight requests to the same URL
    if (ksfInflight.has(url)) {
        console.log(`[KSF] DEDUP (waiting on inflight request) ${url}`);
        ksfCallStats.cached++;
        return ksfInflight.get(url);
    }

    const promise = (async () => {
        const start = Date.now();
        try {
            console.log(`[KSF] -> GET ${url}`);
            const response = await axios.get(url, {
                headers: { 'discord-bot-token': KSF_API_TOKEN },
                timeout: serverConfig.timeouts.ksfApiFetch
            });
            const duration = Date.now() - start;

            // Detailed response logging
            console.log(`[KSF] <- ${response.status} ${duration}ms ${url}`);
            console.log(`[KSF]    All Headers: ${JSON.stringify(response.headers)}`);
            console.log(`[KSF]    Response status field: ${response.data?.status || 'N/A'}`);

            // Only cache responses that have actual data (don't cache soft rate-limit "offline" responses)
            const isOnlineStatusCall = url.includes('/onlinestatus');
            const looksLikeRateLimit = isOnlineStatusCall && 
                response.data?.data?.onlineStatus === 'offline' && 
                response.data?.data?.player === null;
            
            if (looksLikeRateLimit) {
                console.warn(`[KSF]    SUSPICIOUS: onlinestatus returned offline with null player - possible soft rate limit. NOT caching.`);
            } else {
                ksfResponseCache.set(url, { data: response.data, timestamp: Date.now() });
            }

            return response.data;
        } catch (error) {
            ksfCallStats.errors++;
            const duration = Date.now() - start;
            console.error(`[KSF] ERROR ${duration}ms ${url}: ${error.message}`);
            if (error.response) {
                console.error(`[KSF]    HTTP Status: ${error.response.status}`);
                console.error(`[KSF]    Response Body: ${JSON.stringify(error.response.data).substring(0, 500)}`);
                if (error.response.status === 429) {
                    console.error(`[KSF]    RATE LIMITED! Retry-After: ${error.response.headers['retry-after'] || 'unknown'}`);
                }
            }
            return null;
        } finally {
            ksfInflight.delete(url);
        }
    })();

    ksfInflight.set(url, promise);
    return promise;
}

// ── Player API response cache ───────────────────────────────────────────────
// Caches the full /api/player response so switching between players on the
// same server is instant (no KSF API calls needed).
const playerResponseCache = new Map();
const PLAYER_CACHE_TTL = KSF_CACHE_TTL; // same as KSF cache TTL

function getPlayerCacheKey(steamid, gameType, surfType) {
    return `${steamid}:${gameType}:${surfType}`;
}

function cachePlayerResponse(steamid, gameType, surfType, payload) {
    const key = getPlayerCacheKey(steamid, gameType, surfType);
    playerResponseCache.set(key, { data: payload, timestamp: Date.now() });
}

function getCachedPlayerResponse(steamid, gameType, surfType) {
    const key = getPlayerCacheKey(steamid, gameType, surfType);
    const cached = playerResponseCache.get(key);
    if (cached && (Date.now() - cached.timestamp) < PLAYER_CACHE_TTL) {
        return cached.data;
    }
    return null;
}

// Periodically clean expired cache entries
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [url, entry] of ksfResponseCache) {
        if (now - entry.timestamp > KSF_CACHE_TTL * 2) {
            ksfResponseCache.delete(url);
            cleaned++;
        }
    }
    for (const [key, entry] of playerResponseCache) {
        if (now - entry.timestamp > PLAYER_CACHE_TTL * 2) {
            playerResponseCache.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[CACHE] Cleaned ${cleaned} expired entries. KSF=${ksfResponseCache.size} Player=${playerResponseCache.size}`);
    }
}, 60000);

function steamIdTo64(steamId) {
    const match = steamId.match(/^STEAM_0:([01]):(\d+)$/);
    if (!match) return null;
    
    const y = BigInt(match[1]);
    const z = BigInt(match[2]);
    const base = 76561197960265728n;
    const w = z * 2n + y;
    return (base + w).toString();
}

async function resolveSteamID(input) {
    const steamIdRegex = /^(STEAM_\d:\d:\d+|U:\d:\d+)$/;
    if (steamIdRegex.test(input)) {
        return input;
    }

    const cached = steamIdCache.get(input.toLowerCase());
    if (cached && (Date.now() - cached.timestamp) < STEAMID_CACHE_TTL) {
        return cached.steamid;
    }

    try {
        const profileUrl = `https://steamcommunity.com/id/${input}`;
        const response = await axios.get(profileUrl, {
            timeout: serverConfig.timeouts.steamIdResolve
        });
        const html = response.data;
        
        const match = html.match(/"steamid":"(\d+)"/);
        if (match && match[1]) {
            const steamID64 = BigInt(match[1]);
            const base = 76561197960265728n;
            const w = steamID64 - base;
            const y = w % 2n;
            const z = (w - y) / 2n;
            
            const steamid = `STEAM_0:${y}:${z}`;
            steamIdCache.set(input.toLowerCase(), { steamid, timestamp: Date.now() });
            return steamid;
        }
    } catch (e) {
        console.error("Failed to resolve SteamID from username", e.message);
    }
    return null;
}

async function fetchSteamAvatar(steamId64) {
    if (!STEAM_API_KEY) return null;
    
    const cached = avatarCache.get(steamId64);
    if (cached && (Date.now() - cached.timestamp) < AVATAR_CACHE_TTL) {
        return cached.url;
    }

    try {
        const url = `http://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${STEAM_API_KEY}&steamids=${steamId64}`;
        const response = await axios.get(url, { timeout: serverConfig.timeouts.steamIdResolve });
        
        if (response.data?.response?.players?.length > 0) {
            const avatarUrl = response.data.response.players[0].avatarfull;
            avatarCache.set(steamId64, { url: avatarUrl, timestamp: Date.now() });
            return avatarUrl;
        }
    } catch (e) {
        console.error("Failed to fetch Steam avatar", e.message);
    }
    return null;
}

function calculateGroup(rank, totalRanks, completions) {
    if (!rank || !totalRanks) return null;
    const r = parseInt(rank);
    const t = parseInt(totalRanks);
    if (isNaN(r) || isNaN(t) || t <= 0 || r <= 0) return null;

    const c = parseInt(completions);
    if (isNaN(c) || c <= 0) return null;

    if (r === 1) return "WR";
    if (r <= 10) return "Top 10";

    const percentile = (r / t) * 100;
    if (percentile <= 2) return "Group 1";
    if (percentile <= 4) return "Group 2";
    if (percentile <= 8) return "Group 3";
    if (percentile <= 16) return "Group 4";
    if (percentile <= 33) return "Group 5";
    if (percentile <= 66) return "Group 6";
    return "No Group";
}

function calculateSurfRank(rank, points) {
    const r = parseInt(rank);
    const p = parseInt(points);
    if (!isNaN(r) && r >= 1) {
        if (r === 1) return "Rank 1: (pointwhoreB1)";
        if (r === 2) return "Rank 2: (synklgaming)";
        if (r === 3) return "Rank 3: (master)";
        if (r <= 10) return `Rank ${r}: Master`;
        if (r <= 25) return "Elite";
        if (r <= 50) return "Veteran";
        if (r <= 100) return "PRO";
        if (r <= 200) return "Expert";
        if (r <= 300) return "Hotshot";
        if (r <= 500) return "Exceptional";
        if (r <= 750) return "Seasoned";
        if (r <= 1500) return "Experienced";
    }
    if (!isNaN(p)) {
        if (p >= 13000) return "Accomplished";
        if (p >= 9000) return "Adept";
        if (p >= 6000) return "Proficient";
        if (p >= 4000) return "Skilled";
        if (p >= 2500) return "Casual";
        if (p >= 1000) return "Beginner";
    }
    return "Rookie";
}

function mapRecordData(rData) {
    const payload = {
        time: rData.time,
        completions: rData.count,
        attempts: rData.attempts,
        rank: rData.rank,
        totalRanks: rData.totalRanks,
        group: rData.group,
        wrDiff: rData.wrDiff,
        wrTime: rData.wrTime || rData.wr_time || null,
        r2Diff: rData.r2Diff,
        avgVel: rData.avgvel,
        startVel: rData.startvel,
        endVel: rData.endvel,
        dateLastPlayed: rData.date_lastplayed,
        firstDate: rData.first_date,
        totalTime: rData.total_time
    };
    
    if (rData.basicInfo) {
        payload.country = rData.basicInfo.country;
        if (rData.basicInfo.steamID && rData.basicInfo.country) {
            countryCache.set(rData.basicInfo.steamID, rData.basicInfo.country);
        }
    }
    return payload;
}

app.get('/api/player/:input', async (req, res) => {
    const { input } = req.params;
    const gameType = req.query.game || serverConfig.defaultGame || 'css';
    const surfType = parseInt(req.query.surfType) || 0; // 0=FW, 1=SW, 2=HSW, 3=BW

    if (!input) {
        return res.status(400).json({ error: "Missing SteamID or Username" });
    }

    try {
        const steamid = await resolveSteamID(input);
        if (!steamid) {
             return res.status(404).json({ error: "Could not resolve SteamID" });
        }

        // Check player response cache first (instant response for recently-fetched players)
        // Also check the alternate gameType since auto-detection may have stored under a different key
        const cachedResponse = getCachedPlayerResponse(steamid, gameType, surfType);
        if (cachedResponse) {
            console.log(`[PLAYER] CACHE HIT for ${steamid} (${gameType}/${surfType})`);
            return res.json(cachedResponse);
        }
        const altGameTypeForCache = gameType === 'css' ? 'css100t' : 'css';
        const altCachedResponse = getCachedPlayerResponse(steamid, altGameTypeForCache, surfType);
        if (altCachedResponse) {
            console.log(`[PLAYER] CACHE HIT (alt gameType) for ${steamid} (${altGameTypeForCache}/${surfType})`);
            return res.json(altCachedResponse);
        }

        // Auto-detect: try the requested gameType first
        let detectedGameType = gameType;
        const statusUrl = `${KSF_BASE_URL}/${gameType}/steamid/${steamid}/onlinestatus`;
        let statusResponse = await fetchKSFData(statusUrl);

        // If offline on the requested gameType, try the other one for auto-detection
        const altGameType = gameType === 'css' ? 'css100t' : 'css';
        if (statusResponse && statusResponse.status === 'OK' && statusResponse.data?.onlineStatus !== 'online') {
            const altUrl = `${KSF_BASE_URL}/${altGameType}/steamid/${steamid}/onlinestatus`;
            const altResponse = await fetchKSFData(altUrl);
            if (altResponse && altResponse.status === 'OK' && altResponse.data?.onlineStatus === 'online') {
                statusResponse = altResponse;
                detectedGameType = altGameType;
            }
        }

        if (!statusResponse || statusResponse.status !== 'OK') {
            return res.status(502).json({ error: "Failed to fetch status from KSF API" });
        }

        // Log full response structure to diagnose issues
        console.log(`[PLAYER] Raw KSF response keys for ${steamid}: ${JSON.stringify(Object.keys(statusResponse || {}))}`);
        console.log(`[PLAYER] Raw KSF response.data snippet for ${steamid}: ${JSON.stringify(statusResponse.data || {}).substring(0, 500)}`);

        const statusData = statusResponse.data;
        console.log(`[PLAYER] Parsed status for ${steamid}: onlineStatus=${statusData?.onlineStatus} hasServer=${!!statusData?.server}`);

        const steamId64 = steamIdTo64(steamid);
        const avatarUrl = await fetchSteamAvatar(steamId64);

        let responsePayload = {
            steamid,
            steamId64,
            avatarUrl,
            gameType: detectedGameType,
            surfType,
            status: "offline",
            lastUpdated: new Date().toISOString(),
            rawStatus: statusData
        };

        if (statusData.onlineStatus === 'online' && statusData.server) {
            responsePayload.status = "online";
            responsePayload.map = statusData.server.currentmap;
            responsePayload.mapInfo = {
                type: statusData.server.maptype,
                cpCount: statusData.server.cp_count,
                bCount: statusData.server.b_count,
                tier: statusData.server.tier || null
            };
            responsePayload.serverName = statusData.server.surftimer_servername || statusData.server.hostname || null;
            responsePayload.serverPlayers = [];
            if (statusData.server.players && Array.isArray(statusData.server.players)) {
                responsePayload.serverPlayers = statusData.server.players.map(p => ({
                    name: p.playername,
                    steamid: p.steamid,
                    rank: p.rank,
                    points: p.points,
                    country: countryCache.get(p.steamid) || null
                }));
            }

            let playerObj = statusData.player;
            if (!playerObj && statusData.server.players && Array.isArray(statusData.server.players)) {
                playerObj = statusData.server.players.find(p => p.steamid === steamid);
            }

            if (playerObj) {
                let rawZone = parseInt(playerObj.zone);
                if (isNaN(rawZone) || rawZone < 0) rawZone = 0;
                let zone = rawZone;
                
                if (statusData.server.maptype == 1 && zone >= 1) {
                    zone = 0;
                }

                console.log(`[PLAYER] ${playerObj.playername} on ${statusData.server.currentmap} | maptype=${statusData.server.maptype} rawZone=${rawZone} resolvedZone=${zone}`);

                responsePayload.zone = zone;
                responsePayload.playerName = playerObj.playername;
                responsePayload.timeConnected = playerObj.timeconnected;
                responsePayload.country = null;
            } else {
                 responsePayload.zone = 0;
            }

            const recordUrl = `${KSF_BASE_URL}/${detectedGameType}/map/${responsePayload.map}/zone/${responsePayload.zone}/steamid/${steamid}/recordinfo/${surfType}`;
            const recordResponse = await fetchKSFData(recordUrl);

            if (recordResponse && recordResponse.status === 'OK' && recordResponse.data) {
                Object.assign(responsePayload, mapRecordData(recordResponse.data));
                responsePayload.group = calculateGroup(responsePayload.rank, responsePayload.totalRanks, responsePayload.completions);
            }

            if (responsePayload.zone !== 0) {
                 const mainMapUrl = `${KSF_BASE_URL}/${detectedGameType}/map/${responsePayload.map}/zone/0/steamid/${steamid}/recordinfo/${surfType}`;
                 const mainMapResponse = await fetchKSFData(mainMapUrl);
                 
                 if (mainMapResponse && mainMapResponse.status === 'OK' && mainMapResponse.data) {
                     responsePayload.mainMapStats = mapRecordData(mainMapResponse.data);
                 }
            }

            // Pre-cache online status for all players on this server.
            // When the user clicks another player from the lobby list, their
            // /onlinestatus KSF call will be a cache hit instead of a fresh API call.
            if (statusData.server.players && Array.isArray(statusData.server.players)) {
                for (const p of statusData.server.players) {
                    if (p.steamid && p.steamid !== steamid) {
                        // Build a synthetic onlinestatus response for each co-player.
                        // The server info is the same; only the player field differs.
                        const syntheticResponse = {
                            status: 'OK',
                            data: {
                                onlineStatus: 'online',
                                player: p,
                                server: statusData.server
                            }
                        };
                        const pStatusUrl = `${KSF_BASE_URL}/${detectedGameType}/steamid/${p.steamid}/onlinestatus`;
                        // Only populate if not already cached (don't overwrite fresher data)
                        const existing = ksfResponseCache.get(pStatusUrl);
                        if (!existing || (Date.now() - existing.timestamp) > KSF_CACHE_TTL) {
                            ksfResponseCache.set(pStatusUrl, { data: syntheticResponse, timestamp: Date.now() });
                            console.log(`[PLAYER] Pre-cached onlinestatus for co-player ${p.playername} (${p.steamid})`);
                        }
                    }
                }
            }
        }

        // Cache this player's full response under both the requested and detected gameType
        // so lookups for either key hit the cache
        cachePlayerResponse(steamid, detectedGameType, surfType, responsePayload);
        if (detectedGameType !== gameType) {
            cachePlayerResponse(steamid, gameType, surfType, responsePayload);
        }

        res.json(responsePayload);

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ 
            error: "Internal Server Error", 
            details: error.message 
        });
    }
});

app.get('/api/mapstats/:input/:map', async (req, res) => {
    const { input, map } = req.params;
    const gameType = req.query.game || serverConfig.defaultGame || 'css';
    const surfType = parseInt(req.query.surfType) || 0;

    if (!input || !map) {
        return res.status(400).json({ error: "Missing SteamID or map name" });
    }

    try {
        const steamid = await resolveSteamID(input);
        if (!steamid) {
            return res.status(404).json({ error: "Could not resolve SteamID" });
        }

        const url = `${KSF_BASE_URL}/${gameType}/steamid/${steamid}/prinfo/map/${map}/${surfType}`;
        const response = await fetchKSFData(url);

        if (!response || response.status !== 'OK' || !response.data) {
            return res.status(502).json({ error: "Failed to fetch map stats from KSF API" });
        }

        const d = response.data;
        const zones = {};

        if (d.PRInfo && Array.isArray(d.PRInfo)) {
            for (const pr of d.PRInfo) {
                const zoneId = parseInt(pr.zoneID);
                if (isNaN(zoneId)) continue;

                const group = calculateGroup(pr.rank, pr.totalRanks, pr.count);

                zones[zoneId] = {
                    zone: zoneId,
                    time: pr.surfTime,
                    rank: pr.rank,
                    totalRanks: pr.totalRanks,
                    completions: pr.count,
                    attempts: pr.attempts,
                    avgVel: pr.avgVel,
                    startVel: pr.startVel,
                    endVel: pr.endVel,
                    totalTime: pr.totalSurfTime,
                    firstDate: pr.firstDate,
                    dateLastPlayed: pr.dateLastPlayed,
                    group: group || null,
                    wrDiff: null
                };
            }
        }

        res.json({
            map,
            tier: d.Tier,
            zones
        });

    } catch (error) {
        console.error("MapStats Error:", error);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

app.get('/api/profile/:input', async (req, res) => {
    const { input } = req.params;
    const gameType = req.query.game || serverConfig.defaultGame || 'css';
    const surfType = parseInt(req.query.surfType) || 0;

    if (!input) {
        return res.status(400).json({ error: "Missing SteamID or Username" });
    }

    try {
        const steamid = await resolveSteamID(input);
        if (!steamid) {
            return res.status(404).json({ error: "Could not resolve SteamID" });
        }

        const url = `${KSF_BASE_URL}/${gameType}/steamid/${steamid}/playerinfo/${surfType}`;
        const response = await fetchKSFData(url);

        if (!response || response.status !== 'OK' || !response.data) {
            return res.status(502).json({ error: "Failed to fetch player info from KSF API" });
        }

        const d = response.data;

        // Rank title is always based on FW (surfType 0) stats for the current gameType.
        // Other surf styles don't have their own rank — it's determined by the gameType's FW rank/points.
        let rankTitle;
        if (surfType === 0) {
            const surfRank = parseInt(d.SurfRank);
            const points = parseInt(d.playerPoints?.points);
            rankTitle = calculateSurfRank(surfRank, points);
        } else {
            // Fetch the FW profile to get the correct rank title
            try {
                const fwUrl = `${KSF_BASE_URL}/${gameType}/steamid/${steamid}/playerinfo/0`;
                const fwResponse = await fetchKSFData(fwUrl);
                if (fwResponse && fwResponse.status === 'OK' && fwResponse.data) {
                    const fwRank = parseInt(fwResponse.data.SurfRank);
                    const fwPoints = parseInt(fwResponse.data.playerPoints?.points);
                    rankTitle = calculateSurfRank(fwRank, fwPoints);
                } else {
                    rankTitle = "Rookie";
                }
            } catch (e) {
                rankTitle = "Rookie";
            }
        }

        if (d.basicInfo?.steamID && d.basicInfo?.country) {
            countryCache.set(d.basicInfo.steamID, d.basicInfo.country);
        }

        res.json({
            name: d.basicInfo?.name,
            country: d.basicInfo?.country,
            surfRank: d.SurfRank,
            surfTotalRank: d.SurfTotalRank,
            countryRank: d.SurfCountryRank,
            countryTotalRank: d.SurfCountryTotalRank,
            rankTitle,
            percentCompletion: d.percentCompletion,
            points: d.playerPoints,
            completedZones: d.CompletedZones,
            totalZones: d.TotalZones,
            top10Groups: d.Top10Groups,
            wrZones: d.WRZones,
            onlineTime: d.basicInfo?.onlineTime,
            totalConnections: d.basicInfo?.totalConnections,
            firstOnline: d.basicInfo?.firstOnline
        });

    } catch (error) {
        console.error("Profile Error:", error);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

const OVERLAY_CONFIG_PATH = path.join(__dirname, 'overlay-config.json');
app.get('/api/config', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    try {
        if (fs.existsSync(OVERLAY_CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(OVERLAY_CONFIG_PATH));
            return res.json(data);
        }
    } catch (e) {
        console.error("Failed to read overlay config:", e.message);
    }
    res.json({ steamId: "", refreshRate: 60, gameType: "css", surfType: 0, showMainMapStats: false, showZoneBar: true, showRankCard: true, showProfileStats: true, showDetailedStats: true, showMapInfo: true, showPointsBreakdown: true, showHeader: true, showStagePanel: true, showFooter: true, theme: {} });
});

// ── Diagnostic endpoints ─────────────────────────────────────────────────────
// Raw KSF API test - hit this to see exactly what the server gets back
app.get('/api/debug/ksf-raw/:steamid', async (req, res) => {
    const { steamid } = req.params;
    const gameType = req.query.game || serverConfig.defaultGame || 'css';
    
    try {
        const resolved = await resolveSteamID(steamid);
        if (!resolved) {
            return res.status(404).json({ error: "Could not resolve SteamID" });
        }
        
        const url = `${KSF_BASE_URL}/${gameType}/steamid/${resolved}/onlinestatus`;
        console.log(`[DEBUG] Raw KSF test -> ${url}`);
        
        const response = await axios.get(url, {
            headers: { 'discord-bot-token': KSF_API_TOKEN },
            timeout: serverConfig.timeouts.ksfApiFetch
        });
        
        res.json({
            resolvedSteamId: resolved,
            requestUrl: url,
            httpStatus: response.status,
            responseHeaders: response.headers,
            responseBody: response.data,
            serverIP: require('os').networkInterfaces(),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            error: error.message,
            httpStatus: error.response?.status,
            responseHeaders: error.response?.headers,
            responseBody: error.response?.data
        });
    }
});

app.get('/api/debug/stats', (req, res) => {
    const elapsed = ((Date.now() - ksfCallStats.lastReset) / 1000).toFixed(0);
    res.json({
        ksfCalls: { ...ksfCallStats, elapsedSeconds: elapsed },
        cacheSize: ksfResponseCache.size,
        cacheTTL: KSF_CACHE_TTL,
        inflightRequests: ksfInflight.size,
        steamIdCacheSize: steamIdCache.size,
        avatarCacheSize: avatarCache.size,
        countryCacheSize: countryCache.size
    });
});

let browseState = { zone: null, gameType: undefined, surfType: undefined };

// ── Config sync endpoint (Electron -> overlay-config.json) ──────────────────
app.post('/api/config', (req, res) => {
    try {
        const cfg = req.body;
        if (cfg && typeof cfg === 'object') {
            fs.writeFileSync(OVERLAY_CONFIG_PATH, JSON.stringify(cfg, null, 2));
        }
        res.json({ ok: true });
    } catch (e) {
        console.error("Failed to write overlay config:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/browse', (req, res) => {
    browseState = {
        zone: req.body.zone !== undefined ? req.body.zone : null,
        gameType: req.body.gameType !== undefined ? req.body.gameType : browseState.gameType,
        surfType: req.body.surfType !== undefined ? req.body.surfType : browseState.surfType
    };
    res.json({ ok: true });
});

app.get('/api/browse', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    let config = {};
    try {
        if (fs.existsSync(OVERLAY_CONFIG_PATH)) {
            config = JSON.parse(fs.readFileSync(OVERLAY_CONFIG_PATH));
        }
    } catch (e) {}
    res.json({
        zone: browseState.zone,
        gameType: browseState.gameType,
        surfType: browseState.surfType,
        config
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on 0.0.0.0:${PORT}`);
});
