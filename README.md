# KSF Stats App

Real-time KSF surf timer stats app for desktop and OBS.

## Download

Grab the latest release from the [Releases page](https://github.com/callmebussin/ksf-stats-app/releases).

## Setup

### Desktop Overlay
1. Download `ksf-stats-app-v1.0.1.exe` from Releases
2. Run the exe
3. Enter your SteamID or custom URL username in Settings

### OBS Browser Source
1. Add a **Browser** source in OBS
2. Set the URL to `http://108.61.222.248:3000?steamId=YOUR_STEAMID`
   - Example: `http://108.61.222.248:3000?steamId=ericcristian`
   - Accepts SteamID (`STEAM_0:1:12345678`) or custom URL username

## Configuration
- Enter your **SteamID** (e.g. `STEAM_0:1:12345678`) or Steam custom URL username
- Toggle **Always On Top** for in-game use
- Toggle **Show Map Stats Separately** to display main map and stage/bonus as separate cards
- Toggle **Auto-Follow Current Stage** to track the player's active zone
- Toggle **Wide Layout** for side-by-side cards
- Choose a **Preset Theme** (Dark, Light, Glass Blue) or customize colors
- Adjust **Overlay Opacity**

## Features
- Real-time KSF stats with automatic updates
- Stage/bonus navigation with slide animations
- Time improvement detection with roll animation
- Steam avatar and online status display
- Synced browsing between desktop and OBS browser source
- Draggable, transparent, always-on-top overlay window
