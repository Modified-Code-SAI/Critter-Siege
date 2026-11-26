# Critter Siege

A 3D multiplayer tactical artillery and hero-critter evolution game in the browser, featuring smooth sculpted destructible islands, four camera perspectives, procedural audio, and 2–4 player rooms.

**Play Live:** [https://modified-code-sai.github.io/Critter-Siege/](https://modified-code-sai.github.io/Critter-Siege/)

> **Play vs Bots** works anytime directly in your browser with zero server setup.

## Controls (Quick Guide)

| Action | Input |
| --- | --- |
| Move | `WASD` or Arrow Keys |
| Jump / Backflip | `Space` / `2× Space` |
| Free Mouse-Look | Click canvas (`ESC` to release cursor) |
| Keyboard Turn | `Q` / `E` |
| Optic Visor / Recon Drone | Hold `RMB` or `V` / `Tab` |
| Charge & Fire | Hold Click, Hold `Enter`, or `HOLD TO FIRE` button (`RMB` cancels) |
| Switch Gear | `1`–`7` |
| Mute Audio / Controls Help | `M` / `?` |

## Local Development

Requires Node.js 22+ and npm 11+.

```bash
npm install
npm run dev:server   # Starts authoritative WebSocket room server on :3001 (/ws, /health)
npm run dev:client   # Starts Vite Three.js dev server on :5173 (proxies /ws -> :3001)
```

Run the full verification suite (typecheck, lint, Vitest unit tests, production build):

```bash
npm run verify
```

## Online Friend Play (GitHub Pages + Remote WebSocket)

GitHub Pages serves the static 3D client. To host online 4-letter rooms for friends anywhere:

### Option 1: 1-Command Cloudflare Tunnel (No Account Needed)

Start your local room server and expose it over HTTPS/WSS:

```bash
npm run build -w shared && npm run build -w server
node server/dist/server/src/index.js
cloudflared tunnel --url http://localhost:3001
```

Open the live site with your tunnel URL attached:

```text
https://modified-code-sai.github.io/Critter-Siege/?server=https://<your-subdomain>.trycloudflare.com
```

Create a 4-letter room and click **Invite** — the copied link automatically preserves both `?room=CODE` and `&server=...` for your friends.

### Option 2: Free Cloud Deployment on Render

This repo includes a [`render.yaml`](./render.yaml) blueprint for Render's free Node web service tier:

1. Create a new Render Web Service / Blueprint pointing at this repository.
2. Once deployed (e.g. `https://critter-siege-server.onrender.com`), open:
   `https://modified-code-sai.github.io/Critter-Siege/?server=wss://critter-siege-server.onrender.com/ws`
3. Optionally set the GitHub Actions repository variable `VITE_WS_URL` to your `wss://.../ws` endpoint so GitHub Pages builds connect automatically without `?server=`.
