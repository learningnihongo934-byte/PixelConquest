# Pixel Conquest

Pixel Conquest is a real-time pixel-art strategy game in the browser. You grow a nation on a real world map, then build, ally, betray and conquer, against friends online and against AI nations.

**Play it:** https://pixelconquest.web.app

## Features

- **Real world map.** The map is 640×238 tiles baked from Natural Earth (public domain) coastlines, mountain ranges, deserts, rivers and lakes. Terrain changes how fast you expand and how well land defends.
- **20 structures in 4 tech tiers.** Science from Research Labs unlocks each tier:
  - **Economy:** Farm, Mine, Market, Oil Derrick, Research Lab
  - **Defense:** Bunker, Fortress, Watchtower, Radar, Shield Dome
  - **Military:** Barracks, Artillery, Rail Hub, Field Hospital
  - **Reach:** Harbor (troop boats), Naval Yard (warships), Airbase (paradrops), Spy HQ (sabotage), Missile Silo (strike, EMP, nuke)
- **PvP tools:**
  - **Directed attacks:** troops push toward the point you click, and clicking again steers them.
  - **Abilities:** Blitz, Entrench and Rally.
  - **Retreat:** recall your attacks.
  - **Fog of war:** enemy structures are hidden, and enemy troop counts are estimates.
  - **Alliances:** capped at 3, and breaking one gives a 10-second warning and a traitor penalty.
  - **Communication:** quick-chat emotes and ally pings.
- **Modes:** free for all or 2, 3 or 4 teams. You can win by land share, by being last standing, or on a time limit.
- **AI nations:** four difficulties (Easy, Normal, Hard, Brutal) and three personalities (economist, warmonger, turtle). They expand, build, form and break alliances, invade by sea and air, and fire missiles.
- **Multiplayer with friends:**
  - Create a lobby, share the code or invite link, and fill the empty slots with AI.
  - Matches run in **deterministic lockstep**: every browser simulates the same game, and the host relays commands as numbered turns through Firebase Realtime Database.
  - If a player disconnects, an AI takes over their nation. If the host leaves, the next player becomes host.
- **Art and sound:**
  - Every icon is drawn in Pixeter (`art/icons.pixeter` → `public/art/icons.png`).
  - Sound effects and music are synthesized live with Web Audio, so there are no audio files to license.

## Layout

| Path | What |
| --- | --- |
| `public/js/sim.js` | Deterministic simulation (territory, attacks, economy, naval, air, missiles, diplomacy) |
| `public/js/ai.js` | AI nations (run inside the sim so every client agrees) |
| `public/js/data.js` | Terrain, structures, missiles, abilities, balance numbers |
| `public/js/render.js` | Canvas renderer (one pixel per tile + Pixeter icons) |
| `public/js/net.js` | `LocalNet` (solo) and `OnlineNet` (Firebase lockstep, presence, host migration) |
| `public/js/main.js` | Menus, lobby, HUD, input, game loop |
| `public/js/sfx.js` | Synthesized sound effects and music |
| `tools/bake_map.py` | Builds `public/data/world.bin` from Natural Earth |
| `tools/simtest.mjs` | Headless test: speed + lockstep determinism |
| `database.rules.json` | Realtime Database security rules |

## Build

```bash
./build.sh serve    # play locally at http://localhost:8768
./build.sh test     # headless sim test (must print "deterministic: OK")
./build.sh map      # re-bake the map (needs data/raw/*.geojson from Natural Earth)
./build.sh deploy   # test, then deploy hosting + database rules to Firebase
```

Online play needs a Firebase project with **Anonymous** sign-in and a **Realtime Database** enabled. Put its web config in `public/js/firebase-config.js`. Solo play works without it.

## Controls

- **Left-click:** expand into land or attack it.
- **Right-click** (long-press on phones): every other action.
- **Hotkeys:**
  - `1`–`8`, `Q`–`T`, `A`–`H` build.
  - `Z`/`X`/`C` use abilities.
  - `V` retreats.
  - `[` `]` change the send %.
  - `Space` jumps home.
- **Camera:** drag to pan, scroll to zoom.

Made by **Virat Reddy Kaukuntla** ([@learningnihongo934-byte](https://github.com/learningnihongo934-byte))
