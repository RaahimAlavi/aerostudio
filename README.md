# AERO Studio

Wireless spatial motion playground that turns up to 4 smartphones (iOS & Android) into real-time Wii-style motion controllers — locally over 200Hz LAN UDP or globally on Cloudflare Workers + Durable Objects with Synced Remote Screens.

## Experiences
- **Blade Arena** — Competitive 3-life survival katana duel with combos, spike mines, KO elimination, podium, and persistent high scores.
- **Sculpt 3D** — Collaborative Three.js 3D clay, lacquer, and chrome sculpting studio with rounded brush caps, 3D eraser, 360° turntable orbit, and co-op consensus clear voting.
- **Strike Table** — Motion air hockey (1v1, 2v2, or vs Mochi AI, first to 7 goals).
- **Air Sketch** — Secret-prompt Party Draw & Guess with a hi-res dual-layer canvas (Pen, Calligraphic Brush, Flood-Fill Bucket, Eraser) and live guessing from friends' phones.

## Local Quick Start (Home Wi-Fi — 200Hz Native LAN UDP)
```bash
npm install
npm start
```
- Open `http://localhost:3000` on your PC.
- `server.js` automatically starts a free Cloudflare Trusted HTTPS tunnel so friends can scan the QR without certificate warnings (or join from anywhere via **Remote PC Link**).
- Android phones automatically see the **Open in App / Download APK** banner for raw 200Hz LAN UDP (`public/downloads/aero-remote.apk`).

## Free Permanent Cloud Deploy — Cloudflare Workers + Durable Objects ($0, No Credit Card)
```bash
npx wrangler login
npm run cf:deploy
```
Or connect this GitHub repo directly in the **Cloudflare Dashboard → Workers & Pages → Create → Import a repository** with:
- **Build command:** `npm run cf:prepare`
- **Deploy command:** `npx wrangler deploy`

Gives you a permanent 24/7 HTTPS URL (`https://aero-studio.<your-subdomain>.workers.dev`) with zero cold-start sleep, global edge CDN, WebSocket Hibernation Durable Objects, Synced Remote Screens, and APK hosting.

## Rebuilding the Native Android APK (Optional)
Requires JDK 17 and Android SDK (`platforms/android-34`, `build-tools/34.0.0`):
```powershell
powershell -ExecutionPolicy Bypass -File .\android-remote\build-apk.ps1
```
