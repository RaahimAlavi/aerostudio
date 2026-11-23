const http = require('http');
const https = require('https');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const selfsigned = require('selfsigned');

const HTTP_PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const UDP_PORT = Number(process.env.UDP_PORT || 41234);
const IS_CLOUD = Boolean(
  process.env.CLOUD_MODE === '1' ||
  process.env.RENDER ||
  process.env.RAILWAY_ENVIRONMENT ||
  process.env.FLY_APP_NAME ||
  process.env.K_SERVICE
);
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');
const APK_PATH = path.join(PUBLIC_DIR, 'downloads', 'aero-remote.apk');
const THREE_DIR = path.join(__dirname, 'node_modules', 'three', 'build');
const FONT_JAKARTA_DIR = path.join(__dirname, 'node_modules', '@fontsource', 'plus-jakarta-sans', 'files');
const FONT_MONO_DIR = path.join(__dirname, 'node_modules', '@fontsource', 'jetbrains-mono', 'files');
const ICONS_DIR = path.join(__dirname, 'node_modules', '@phosphor-icons', 'core', 'assets', 'bold');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.apk': 'application/vnd.android.package-archive',
};

const PLAYER_PROFILES = [
  { slot: 0, label: 'P1', name: 'COBALT', color: '#2563EB', glow: 'rgba(37, 99, 235, 0.35)', soft: '#93C5FD' },
  { slot: 1, label: 'P2', name: 'CORAL', color: '#E11D48', glow: 'rgba(225, 29, 72, 0.35)', soft: '#FDA4AF' },
  { slot: 2, label: 'P3', name: 'EMERALD', color: '#059669', glow: 'rgba(5, 150, 105, 0.35)', soft: '#6EE7B7' },
  { slot: 3, label: 'P4', name: 'AMBER', color: '#D97706', glow: 'rgba(217, 119, 6, 0.35)', soft: '#FCD34D' },
];

let tunnelUrl = null;
let cloudflaredProc = null;

function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'cloudflared';
}

function startCloudflareTunnel() {
  if (process.env.DISABLE_TUNNEL === '1') return;
  const bin = findCloudflared();
  try {
    const proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${HTTP_PORT}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    cloudflaredProc = proc;

    const scanLine = (chunk) => {
      const text = chunk.toString('utf8');
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !tunnelUrl) {
        tunnelUrl = match[0];
        console.log(`   Trusted HTTPS (Cloudflare): ${tunnelUrl}`);
        // Push immediately to any already-open PC Host screens so their QR auto-upgrades!
        for (const room of rooms.values()) {
          broadcastToHosts(room, { type: 'tunnel_ready', tunnelUrl });
        }
      }
    };

    proc.stdout.on('data', scanLine);
    proc.stderr.on('data', scanLine);
    proc.on('error', () => {
      cloudflaredProc = null;
    });
    proc.on('exit', () => {
      cloudflaredProc = null;
    });
  } catch (_) {}
}

function cleanupTunnel() {
  if (cloudflaredProc) {
    try {
      cloudflaredProc.kill();
    } catch (_) {}
    cloudflaredProc = null;
  }
}

process.on('exit', cleanupTunnel);
process.on('SIGINT', () => {
  cleanupTunnel();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupTunnel();
  process.exit(0);
});

function getLocalIPv4s() {
  const nets = os.networkInterfaces();
  const list = [];

  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;

      const lower = name.toLowerCase();
      let priority = 50;
      if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wlan')) priority = 100;
      else if (lower.includes('ethernet') || lower.includes('en0') || lower.includes('eth')) priority = 90;
      if (
        lower.includes('vethernet') ||
        lower.includes('wsl') ||
        lower.includes('docker') ||
        lower.includes('vmware') ||
        lower.includes('virtualbox') ||
        lower.includes('tailscale') ||
        lower.includes('zerotier') ||
        lower.includes('hyper-v') ||
        lower.includes('loopback')
      ) {
        priority = 10;
      }
      if (addr.address.startsWith('192.168.')) priority += 15;
      else if (addr.address.startsWith('10.')) priority += 10;

      list.push({ name, ip: addr.address, priority });
    }
  }

  list.sort((a, b) => b.priority - a.priority);
  if (list.length === 0) {
    list.push({ name: 'localhost', ip: '127.0.0.1', priority: 0 });
  }
  return list;
}

async function ensureCerts(ips) {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const metaPath = path.join(CERT_DIR, 'meta.json');

  const ipSetKey = [...new Set(ips.map((i) => i.ip))].sort().join(',');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const ageDays = (Date.now() - (meta.createdAt || 0)) / (1000 * 60 * 60 * 24);
      if (meta.ipSetKey === ipSetKey && ageDays < 300) {
        return {
          key: fs.readFileSync(keyPath, 'utf8'),
          cert: fs.readFileSync(certPath, 'utf8'),
        };
      }
    } catch (_) {}
  }

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];
  for (const entry of ips) {
    if (entry.ip !== '127.0.0.1') {
      altNames.push({ type: 7, ip: entry.ip });
    }
  }

  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: ips[0]?.ip || 'localhost' }],
    {
      keyType: 'rsa',
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: notBefore,
      notAfterDate: notAfter,
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    }
  );

  fs.writeFileSync(keyPath, pems.private, 'utf8');
  fs.writeFileSync(certPath, pems.cert, 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify({ ipSetKey, createdAt: Date.now() }, null, 2), 'utf8');

  return { key: pems.private, cert: pems.cert };
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

const rooms = new Map();

function getOrCreateRoom(code) {
  let clean = (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!clean) {
    clean = makeRoomCode();
    while (rooms.has(clean)) clean = makeRoomCode();
  }
  if (!rooms.has(clean)) {
    rooms.set(clean, {
      code: clean,
      primaryHost: null,
      hosts: new Set(),
      controllers: new Map(),
      lastUdpSeq: new Map(), // slot -> uint16
      currentMode: 'hub',
      createdAt: Date.now(),
    });
  }
  return rooms.get(clean);
}

function getDefaultActiveRoom() {
  let newest = null;
  for (const room of rooms.values()) {
    if (room.hosts.size > 0) {
      if (!newest || room.createdAt >= newest.createdAt) newest = room;
    }
  }
  if (newest) return newest;
  const all = [...rooms.values()];
  return all.length ? all[all.length - 1] : getOrCreateRoom();
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcastToHosts(room, obj) {
  if (!room || room.hosts.size === 0) return;
  const payload = JSON.stringify(obj);
  for (const host of room.hosts) {
    if (host.readyState === 1) host.send(payload);
  }
}

function broadcastToOtherHosts(room, senderWs, payloadOrObj) {
  if (!room || room.hosts.size <= 1) return;
  const payload = typeof payloadOrObj === 'string' ? payloadOrObj : JSON.stringify(payloadOrObj);
  for (const host of room.hosts) {
    if (host !== senderWs && host.readyState === 1 && host.bufferedAmount < 65536) {
      host.send(payload);
    }
  }
}

function broadcastToControllers(room, obj, excludeSlot = -1) {
  if (!room || room.controllers.size === 0) return;
  const payload = JSON.stringify(obj);
  for (const [slot, ctrl] of room.controllers.entries()) {
    if (slot === excludeSlot) continue;
    if (ctrl.ws.readyState === 1) ctrl.ws.send(payload);
  }
}

function getPlayersSnapshot(room) {
  const players = [];
  for (const [slot, ctrl] of room.controllers.entries()) {
    players.push({
      slot,
      id: ctrl.id,
      profile: ctrl.profile,
      name: ctrl.name,
      sensorMode: ctrl.sensorMode || 'pending',
    });
  }
  players.sort((a, b) => a.slot - b.slot);
  return players;
}

function serveStaticFile(res, baseDir, relFile, cacheControl = 'no-cache') {
  const safePath = path.normalize(relFile).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(baseDir, safePath);
  if (!fullPath.startsWith(baseDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
    };
    if (ext === '.apk') {
      headers['Content-Disposition'] = 'attachment; filename="aero-remote.apk"';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function isLocalHostname(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

async function handleRequest(req, res, isHttps) {
  const forwardedHost = req.headers['x-forwarded-host'];
  const forwardedProto = req.headers['x-forwarded-proto'];
  const hostHeader = forwardedHost || req.headers.host || `localhost:${isHttps ? HTTPS_PORT : HTTP_PORT}`;
  const proto = forwardedProto || (isHttps ? 'https' : 'http');
  const reqUrl = new URL(req.url, `${proto}://${hostHeader}`);
  const pathname = reqUrl.pathname;

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, cloud: IS_CLOUD, rooms: rooms.size }));
    return;
  }

  if (pathname === '/api/info') {
    const ips = getLocalIPv4s();
    const activeRoom = getDefaultActiveRoom();
    const requestedRoom = reqUrl.searchParams.get('room');
    const roomCode = requestedRoom ? requestedRoom.toUpperCase() : activeRoom.code;
    const isRemoteTunnel = IS_CLOUD || !isLocalHostname(reqUrl.hostname);

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        ips,
        primaryIp: ips[0].ip,
        httpPort: HTTP_PORT,
        httpsPort: HTTPS_PORT,
        udpPort: UDP_PORT,
        roomCode,
        tunnelUrl,
        isRemoteTunnel,
        isCloud: IS_CLOUD,
        apkAvailable: fs.existsSync(APK_PATH),
        publicOrigin: isRemoteTunnel ? `${proto}://${hostHeader}` : tunnelUrl,
      })
    );
    return;
  }

  if (pathname === '/api/qr') {
    const ips = getLocalIPv4s();
    const ip = reqUrl.searchParams.get('ip') || ips[0].ip;
    const room = (reqUrl.searchParams.get('room') || '').toUpperCase();
    const mode = reqUrl.searchParams.get('mode') || 'auto'; // 'auto' | 'lan'
    const isRemoteTunnel = IS_CLOUD || !isLocalHostname(reqUrl.hostname);

    const qs = new URLSearchParams();
    if (room) qs.set('room', room);
    if (!IS_CLOUD) {
      qs.set('lan', ip);
      qs.set('port', String(HTTP_PORT));
      qs.set('udp', String(UDP_PORT));
    }

    let origin;
    let sourceKind = 'lan';

    if (isRemoteTunnel) {
      const publicProto = IS_CLOUD ? 'https' : proto;
      origin = `${publicProto}://${hostHeader}`;
      sourceKind = 'trusted';
    } else if (mode !== 'lan' && tunnelUrl) {
      origin = tunnelUrl;
      sourceKind = 'trusted';
    } else {
      origin = `https://${ip}:${HTTPS_PORT}`;
      sourceKind = 'lan';
    }

    const targetUrl = `${origin}/controller?${qs.toString()}`;
    const watchUrl = room ? `${origin}/?room=${encodeURIComponent(room)}` : `${origin}/`;

    try {
      const svg = await QRCode.toString(targetUrl, {
        type: 'svg',
        margin: 1,
        width: 240,
        color: {
          dark: '#111318',
          light: '#00000000',
        },
        errorCorrectionLevel: 'M',
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          url: targetUrl,
          watchUrl,
          svg,
          sourceKind,
          hasTunnel: !IS_CLOUD && Boolean(tunnelUrl),
          isCloud: IS_CLOUD,
        })
      );
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname.startsWith('/vendor/three/')) {
    serveStaticFile(res, THREE_DIR, pathname.slice('/vendor/three/'.length), 'public, max-age=86400');
    return;
  }
  if (pathname.startsWith('/vendor/fonts/jakarta/')) {
    serveStaticFile(res, FONT_JAKARTA_DIR, pathname.slice('/vendor/fonts/jakarta/'.length), 'public, max-age=604800');
    return;
  }
  if (pathname.startsWith('/vendor/fonts/mono/')) {
    serveStaticFile(res, FONT_MONO_DIR, pathname.slice('/vendor/fonts/mono/'.length), 'public, max-age=604800');
    return;
  }
  if (pathname.startsWith('/vendor/icons/')) {
    serveStaticFile(res, ICONS_DIR, pathname.slice('/vendor/icons/'.length), 'public, max-age=604800');
    return;
  }

  let relPath = pathname;
  if (relPath === '/' || relPath === '/host') relPath = '/index.html';
  else if (relPath === '/controller' || relPath === '/remote' || relPath === '/c') relPath = '/controller.html';

  serveStaticFile(res, PUBLIC_DIR, relPath, 'no-cache');
}

// ============================================================================
// RAW 240Hz LAN UDP RECEIVER (FOR NATIVE ANDROID COMPANION APK!)
// 24-byte packet: [4-byte room ASCII][18-byte motion pkt][2-byte uint16 seq]
// ============================================================================
function startNativeUdpServer() {
  const udp = dgram.createSocket('udp4');

  udp.on('error', (err) => {
    console.warn('UDP receiver warning:', err.message);
  });

  udp.on('message', (msg) => {
    if (msg.length < 24 || msg[4] !== 0x01) return;

    // Extract 4-char ASCII room code (or fallback to active default room)
    const rawRoom = msg.subarray(0, 4).toString('ascii').replace(/\0/g, '').trim().toUpperCase();
    const room = rawRoom && rooms.has(rawRoom) ? rooms.get(rawRoom) : getDefaultActiveRoom();
    if (!room || room.hosts.size === 0) return;

    const slot = msg[5];
    const seq = msg.readUInt16LE(22);

    // Drop stale out-of-order UDP datagrams (handles uint16 wrap cleanly)
    const prevSeq = room.lastUdpSeq.get(slot);
    if (prevSeq !== undefined) {
      const diff = (seq - prevSeq + 65536) & 0xffff;
      if (diff === 0 || diff > 32768) return;
    }
    room.lastUdpSeq.set(slot, seq);

    // Acknowledge LAN UDP pierce back to the native Android app once
    const ctrl = room.controllers.get(slot);
    if (ctrl && !ctrl.udpConfirmed) {
      ctrl.udpConfirmed = true;
      safeSend(ctrl.ws, { type: 'udp_confirmed' });
    }

    // Extract inner 18-byte motion frame & set bit 3 (0x08 = NATIVE_UDP)
    const inner = Buffer.from(msg.subarray(4, 22));
    inner[2] = inner[2] | 0x08;

    for (const host of room.hosts) {
      if (host.readyState === 1 && host.bufferedAmount < 4096) {
        host.send(inner, { binary: true });
      }
    }
  });

  udp.bind(UDP_PORT, '0.0.0.0', () => {
    console.log(`   Native 240Hz LAN UDP:       udp://0.0.0.0:${UDP_PORT}`);
  });
}

async function start() {
  const ips = getLocalIPv4s();
  const httpServer = http.createServer((req, res) => handleRequest(req, res, false));

  const disableNagle = (socket) => {
    try {
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10000);
    } catch (_) {}
  };
  httpServer.on('connection', disableNagle);

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  function handleUpgrade(req, socket, head) {
    disableNagle(socket);
    const reqUrl = new URL(req.url, 'http://localhost');
    if (reqUrl.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, reqUrl);
    });
  }

  httpServer.on('upgrade', handleUpgrade);

  let httpsServer = null;
  if (!IS_CLOUD) {
    const creds = await ensureCerts(ips);
    httpsServer = https.createServer(creds, (req, res) => handleRequest(req, res, true));
    httpsServer.on('connection', disableNagle);
    httpsServer.on('upgrade', handleUpgrade);
  }

  wss.on('connection', (ws, req, reqUrl) => {
    const role = reqUrl.searchParams.get('role') || 'host';
    const requestedRoom = (reqUrl.searchParams.get('room') || '').toUpperCase();

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    if (role === 'host') {
      const room = getOrCreateRoom(requestedRoom || undefined);
      const isPrimary = !room.primaryHost;
      if (isPrimary) room.primaryHost = ws;
      room.hosts.add(ws);
      ws._role = 'host';
      ws._room = room;
      ws._isPrimary = isPrimary;

      const viewerCount = Math.max(0, room.hosts.size - 1);

      safeSend(ws, {
        type: 'host_welcome',
        roomCode: room.code,
        players: getPlayersSnapshot(room),
        mode: room.currentMode,
        tunnelUrl,
        isPrimaryHost: isPrimary,
        viewerCount,
        isCloud: IS_CLOUD,
      });

      if (!isPrimary && room.primaryHost) {
        safeSend(room.primaryHost, { type: 'viewers_changed', viewerCount });
        safeSend(room.primaryHost, { type: 'sync_request' });
      }

      ws.on('message', (raw) => {
        const rawStr = typeof raw === 'string' ? raw : raw.toString('utf8');
        let msg;
        try {
          msg = JSON.parse(rawStr);
        } catch {
          return;
        }

        if (msg.type === 'state_sync' || msg.type === 'event_sync') {
          if (ws._isPrimary) {
            broadcastToOtherHosts(room, ws, rawStr);
          }
          return;
        }

        if (msg.type === 'mode_change') {
          if (!ws._isPrimary) return;
          room.currentMode = msg.mode || 'hub';
          broadcastToControllers(room, {
            type: 'mode',
            mode: room.currentMode,
            hints: msg.hints || null,
          });
          broadcastToOtherHosts(room, ws, {
            type: 'mode_sync',
            mode: room.currentMode,
          });
        } else if (msg.type === 'feedback' || msg.type === 'to_controller' || msg.type === 'rtc_signal') {
          if (!ws._isPrimary) return;
          if (typeof msg.slot === 'number') {
            const ctrl = room.controllers.get(msg.slot);
            if (ctrl) safeSend(ctrl.ws, msg);
          } else {
            broadcastToControllers(room, msg, typeof msg.excludeSlot === 'number' ? msg.excludeSlot : -1);
          }
        } else if (msg.type === 'ping') {
          safeSend(ws, { type: 'pong', t: msg.t });
        }
      });

      ws.on('close', () => {
        room.hosts.delete(ws);
        if (room.primaryHost === ws) {
          const next = room.hosts.values().next().value || null;
          room.primaryHost = next;
          if (next) {
            next._isPrimary = true;
            safeSend(next, {
              type: 'host_role',
              isPrimaryHost: true,
              viewerCount: Math.max(0, room.hosts.size - 1),
            });
          }
        } else if (room.primaryHost) {
          safeSend(room.primaryHost, {
            type: 'viewers_changed',
            viewerCount: Math.max(0, room.hosts.size - 1),
          });
        }

        if (room.hosts.size === 0 && room.controllers.size === 0) {
          setTimeout(() => {
            if (room.hosts.size === 0 && room.controllers.size === 0) {
              rooms.delete(room.code);
            }
          }, 15000);
        }
      });
    } else {
      const room = requestedRoom && rooms.has(requestedRoom) ? rooms.get(requestedRoom) : getDefaultActiveRoom();

      let slot = -1;
      for (let i = 0; i < 4; i++) {
        if (!room.controllers.has(i)) {
          slot = i;
          break;
        }
      }

      if (slot === -1) {
        safeSend(ws, { type: 'error', code: 'ROOM_FULL', message: 'All 4 controller slots are occupied.' });
        ws.close();
        return;
      }

      const profile = PLAYER_PROFILES[slot];
      const ctrl = {
        ws,
        id: `p${slot + 1}-${Date.now().toString(36).slice(-4)}`,
        slot,
        profile,
        name: reqUrl.searchParams.get('name') || `Player ${slot + 1}`,
        sensorMode: reqUrl.searchParams.get('native') === '1' ? 'native_udp' : 'pending',
        connectedAt: Date.now(),
      };
      room.controllers.set(slot, ctrl);
      room.lastUdpSeq.delete(slot);
      ws._role = 'controller';
      ws._room = room;
      ws._slot = slot;

      safeSend(ws, {
        type: 'controller_welcome',
        roomCode: room.code,
        slot,
        profile,
        mode: room.currentMode,
        udpPort: UDP_PORT,
      });

      broadcastToHosts(room, {
        type: 'player_joined',
        player: {
          slot,
          id: ctrl.id,
          profile,
          name: ctrl.name,
          sensorMode: ctrl.sensorMode,
        },
        players: getPlayersSnapshot(room),
      });

      ws.on('message', (raw, isBinary) => {
        if (isBinary && Buffer.isBuffer(raw) && raw.length === 18 && raw[0] === 0x01) {
          raw[1] = slot;
          if (room.hosts.size > 0) {
            for (const host of room.hosts) {
              if (host.readyState === 1 && host.bufferedAmount < 4096) {
                host.send(raw, { binary: true });
              }
            }
          }
          return;
        }

        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }

        if (msg.type === 'ping') {
          safeSend(ws, { type: 'pong', t: msg.t });
          return;
        }

        if (msg.type === 'sensor_status') {
          ctrl.sensorMode = msg.sensorMode || 'gyro';
          broadcastToHosts(room, {
            type: 'player_status',
            slot,
            sensorMode: ctrl.sensorMode,
          });
          return;
        }

        msg.slot = slot;
        broadcastToHosts(room, msg);
      });

      ws.on('close', () => {
        if (room.controllers.get(slot)?.ws === ws) {
          room.controllers.delete(slot);
          room.lastUdpSeq.delete(slot);
          broadcastToHosts(room, {
            type: 'player_left',
            slot,
            players: getPlayersSnapshot(room),
          });
        }
      });
    }
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);

  wss.on('close', () => clearInterval(heartbeat));

  if (IS_CLOUD) {
    httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
      console.log('');
      console.log('  ============================================================');
      console.log('   AERO STUDIO // Cloud Global Multiplayer Server');
      console.log('  ============================================================');
      console.log(`   Listening on:               http://0.0.0.0:${HTTP_PORT}`);
      console.log('   Health check:               GET /healthz');
      console.log('  ============================================================');
    });
    return;
  }

  startNativeUdpServer();

  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log('');
      console.log('  ============================================================');
      console.log('   AERO STUDIO // Spatial Motion Playground');
      console.log('  ============================================================');
      console.log(`   PC Screen:                  http://localhost:${HTTP_PORT}`);
      console.log(`   Direct LAN HTTPS:           https://${ips[0].ip}:${HTTPS_PORT}/controller`);
      console.log('   Starting Cloudflare Trusted HTTPS tunnel...');
      console.log('  ============================================================');
      startCloudflareTunnel();
    });
  });
}

start().catch((err) => {
  console.error('Failed to start AERO server:', err);
  process.exit(1);
});
