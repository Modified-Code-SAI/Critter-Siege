---
name: dev-playtest
description: Launch the Critter Siege local WebSocket server and Vite Three.js dev client for live browser playtesting and visual verification.
---

# Dev Playtest Workflow (`dev-playtest`)

## Trigger Description

Invoke when verifying live 3D rendering, camera modes, smooth SDF terrain carving, Play-vs-Bots sandbox, or multi-tab 4-letter room WebSocket multiplayer.

## Numbered Steps

1. Start the Node WebSocket room server (`npm run dev:server`, default port `3001`).
2. Start the Vite Three.js dev server (`npm run dev:client`, default port `5173`).
3. Open the client URL in a browser and verify:
   - Smooth sculpted 3D island renders with zero console errors or WebGL warnings.
   - Play-vs-Bots sandbox drops Mole, Norway Rat, Badger, and Glider Squirrel onto the island.
   - All 4 camera modes (Over-the-Shoulder, RMB First-Person Optic Visor, Tab Drone Recon, automatic Shot Cam) function smoothly.
   - Firing `Gale Mortar` / `Burrow Bore` carves smooth craters/tunnels and triggers knockback + Shot Cam + 5s Retreat.
   - Opening a second tab and joining via 4-letter room code syncs turns, blasts, and mutations cleanly.
