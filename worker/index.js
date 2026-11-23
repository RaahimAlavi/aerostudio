import { DurableObject } from 'cloudflare:workers';
import QRCode from 'qrcode';

const PLAYER_PROFILES = [
  { slot: 0, label: 'P1', name: 'COBALT', color: '#2563EB', glow: 'rgba(37, 99, 235, 0.35)', soft: '#93C5FD' },
  { slot: 1, label: 'P2', name: 'CORAL', color: '#E11D48', glow: 'rgba(225, 29, 72, 0.35)', soft: '#FDA4AF' },
  { slot: 2, label: 'P3', name: 'EMERALD', color: '#059669', glow: 'rgba(5, 150, 105, 0.35)', soft: '#6EE7B7' },
  { slot: 3, label: 'P4', name: 'AMBER', color: '#D97706', glow: 'rgba(217, 119, 6, 0.35)', soft: '#FCD34D' },
];

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function cleanRoomCode(raw) {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

/**
 * Cloudflare Durable Object (SQLite Free-Tier + WebSocket Hibernation API)
 * Coordinates 1 Primary Host, N Synced Remote Viewer Screens, and up to 4 Phone Controllers per room.
 */
export class AeroRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.currentMode = 'hub';
    this.roomCode = '';
    this.ctx.blockConcurrencyWhile(async () => {
      const savedMode = await this.ctx.storage.get('mode');
      const savedCode = await this.ctx.storage.get('roomCode');
      if (savedMode) this.currentMode = savedMode;
      if (savedCode) this.roomCode = savedCode;
    });
  }

  _safeSend(ws, objOrStr) {
    try {
      const payload = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr);
      ws.send(payload);
    } catch (_) {}
  }

  _getHosts() {
    return this.ctx.getWebSockets('host');
  }

  _getControllers() {
    return this.ctx.getWebSockets('controller');
  }

  _getPrimaryHost(excludeWs = null) {
    for (const h of this._getHosts()) {
      if (h === excludeWs) continue;
      const meta = h.deserializeAttachment();
      if (meta?.isPrimary) return h;
    }
    return null;
  }

  _getPlayersSnapshot(excludeWs = null) {
    const players = [];
    for (const c of this._getControllers()) {
      if (c === excludeWs) continue;
      const m = c.deserializeAttachment();
      if (!m || typeof m.slot !== 'number') continue;
      players.push({
        slot: m.slot,
        id: m.id,
        profile: PLAYER_PROFILES[m.slot] || PLAYER_PROFILES[0],
        name: m.name || `Player ${m.slot + 1}`,
        sensorMode: m.sensorMode || 'pending',
      });
    }
    players.sort((a, b) => a.slot - b.slot);
    return players;
  }

  _broadcastToHosts(objOrStr, excludeWs = null) {
    const payload = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr);
    for (const h of this._getHosts()) {
      if (h === excludeWs) continue;
      this._safeSend(h, payload);
    }
  }

  _broadcastToControllers(objOrStr, excludeSlot = -1) {
    const payload = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr);
    for (const c of this._getControllers()) {
      const m = c.deserializeAttachment();
      if (m && m.slot === excludeSlot) continue;
      this._safeSend(c, payload);
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const url = new URL(request.url);
    const role = url.searchParams.get('role') || 'host';
    const code = cleanRoomCode(url.searchParams.get('room')) || this.roomCode || makeRoomCode();
    if (code !== this.roomCode) {
      this.roomCode = code;
      await this.ctx.storage.put('roomCode', code);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'host') {
      const existingPrimary = this._getPrimaryHost();
      const isPrimary = !existingPrimary;
      this.ctx.acceptWebSocket(server, ['host']);
      server.serializeAttachment({
        role: 'host',
        isPrimary,
      });

      const hostCount = this._getHosts().length;
      const viewerCount = Math.max(0, hostCount - 1);

      this._safeSend(server, {
        type: 'host_welcome',
        roomCode: this.roomCode,
        players: this._getPlayersSnapshot(),
        mode: this.currentMode,
        tunnelUrl: null,
        isPrimaryHost: isPrimary,
        viewerCount,
        isCloud: true,
      });

      if (!isPrimary && existingPrimary) {
        this._safeSend(existingPrimary, { type: 'viewers_changed', viewerCount });
        this._safeSend(existingPrimary, { type: 'sync_request' });
      }
    } else {
      const usedSlots = new Set();
      for (const c of this._getControllers()) {
        const m = c.deserializeAttachment();
        if (m && typeof m.slot === 'number') usedSlots.add(m.slot);
      }

      let slot = -1;
      for (let i = 0; i < 4; i++) {
        if (!usedSlots.has(i)) {
          slot = i;
          break;
        }
      }

      this.ctx.acceptWebSocket(server, ['controller']);

      if (slot === -1) {
        this._safeSend(server, { type: 'error', code: 'ROOM_FULL', message: 'All 4 controller slots are occupied.' });
        try {
          server.close(1008, 'Room full');
        } catch (_) {}
        return new Response(null, { status: 101, webSocket: client });
      }

      const profile = PLAYER_PROFILES[slot];
      const meta = {
        role: 'controller',
        slot,
        id: `p${slot + 1}-${Date.now().toString(36).slice(-4)}`,
        name: url.searchParams.get('name') || `Player ${slot + 1}`,
        sensorMode: url.searchParams.get('native') === '1' ? 'native_udp' : 'pending',
      };
      server.serializeAttachment(meta);

      this._safeSend(server, {
        type: 'controller_welcome',
        roomCode: this.roomCode,
        slot,
        profile,
        mode: this.currentMode,
        udpPort: 41234,
      });

      this._broadcastToHosts({
        type: 'player_joined',
        player: {
          slot,
          id: meta.id,
          profile,
          name: meta.name,
          sensorMode: meta.sensorMode,
        },
        players: this._getPlayersSnapshot(),
      });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const meta = ws.deserializeAttachment();
    if (!meta) return;

    // Fast path: 18-byte binary motion packet from phone controller -> broadcast directly to all host screens!
    if (message instanceof ArrayBuffer) {
      if (meta.role !== 'controller' || message.byteLength < 18) return;
      const bytes = new Uint8Array(message.slice(0, 18));
      if (bytes[0] !== 0x01) return;
      bytes[1] = meta.slot & 0xff;
      for (const h of this._getHosts()) {
        try {
          h.send(bytes);
        } catch (_) {}
      }
      return;
    }

    if (typeof message !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.type === 'ping') {
      this._safeSend(ws, { type: 'pong', t: msg.t });
      return;
    }

    if (meta.role === 'host') {
      if (msg.type === 'state_sync' || msg.type === 'event_sync') {
        if (meta.isPrimary) {
          this._broadcastToHosts(message, ws);
        }
        return;
      }

      if (msg.type === 'mode_change') {
        if (!meta.isPrimary) return;
        this.currentMode = msg.mode || 'hub';
        this.ctx.storage.put('mode', this.currentMode);
        this._broadcastToControllers({
          type: 'mode',
          mode: this.currentMode,
          hints: msg.hints || null,
        });
        this._broadcastToHosts({ type: 'mode_sync', mode: this.currentMode }, ws);
        return;
      }

      if (msg.type === 'feedback' || msg.type === 'to_controller' || msg.type === 'rtc_signal') {
        if (!meta.isPrimary) return;
        if (typeof msg.slot === 'number') {
          for (const c of this._getControllers()) {
            const cm = c.deserializeAttachment();
            if (cm && cm.slot === msg.slot) {
              this._safeSend(c, msg);
              break;
            }
          }
        } else {
          this._broadcastToControllers(msg, typeof msg.excludeSlot === 'number' ? msg.excludeSlot : -1);
        }
      }
    } else {
      // Controller JSON message
      if (msg.type === 'sensor_status') {
        meta.sensorMode = msg.sensorMode || 'gyro';
        ws.serializeAttachment(meta);
        this._broadcastToHosts({
          type: 'player_status',
          slot: meta.slot,
          sensorMode: meta.sensorMode,
        });
        return;
      }

      msg.slot = meta.slot;
      this._broadcastToHosts(msg);
    }
  }

  _handleDisconnect(ws) {
    const meta = ws.deserializeAttachment();
    if (!meta) return;

    if (meta.role === 'host') {
      const remainingHosts = this._getHosts().filter((h) => h !== ws);
      if (meta.isPrimary && remainingHosts.length > 0) {
        const nextPrimary = remainingHosts[0];
        nextPrimary.serializeAttachment({ role: 'host', isPrimary: true });
        this._safeSend(nextPrimary, {
          type: 'host_role',
          isPrimaryHost: true,
          viewerCount: Math.max(0, remainingHosts.length - 1),
        });
      } else {
        const primary = this._getPrimaryHost(ws);
        if (primary) {
          this._safeSend(primary, {
            type: 'viewers_changed',
            viewerCount: Math.max(0, remainingHosts.length - 1),
          });
        }
      }
      if (remainingHosts.length === 0) {
        this.currentMode = 'hub';
        this.ctx.storage.put('mode', 'hub');
      }
    } else if (meta.role === 'controller' && typeof meta.slot === 'number') {
      this._broadcastToHosts({
        type: 'player_left',
        slot: meta.slot,
        players: this._getPlayersSnapshot(ws),
      });
    }
  }

  async webSocketClose(ws) {
    this._handleDisconnect(ws);
  }

  async webSocketError(ws) {
    this._handleDisconnect(ws);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const origin = url.origin;

    if (pathname === '/healthz') {
      return Response.json({ ok: true, cloud: true, runtime: 'cloudflare-workers' });
    }

    if (pathname === '/ws') {
      let room = cleanRoomCode(url.searchParams.get('room'));
      if (!room) {
        room = makeRoomCode();
        url.searchParams.set('room', room);
      }
      const id = env.AERO_ROOM.idFromName(room);
      const stub = env.AERO_ROOM.get(id);
      return stub.fetch(new Request(url.toString(), request));
    }

    if (pathname === '/api/info') {
      const roomCode = cleanRoomCode(url.searchParams.get('room')) || makeRoomCode();
      return new Response(
        JSON.stringify({
          ips: [{ name: 'cloud', ip: '' }],
          primaryIp: '',
          httpPort: 443,
          httpsPort: 443,
          udpPort: 41234,
          roomCode,
          tunnelUrl: null,
          isRemoteTunnel: true,
          isCloud: true,
          apkAvailable: true,
          publicOrigin: origin,
        }),
        { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    }

    if (pathname === '/api/qr') {
      const room = cleanRoomCode(url.searchParams.get('room')) || makeRoomCode();
      const targetUrl = `${origin}/controller?room=${encodeURIComponent(room)}`;
      const watchUrl = `${origin}/?room=${encodeURIComponent(room)}`;
      const svg = await QRCode.toString(targetUrl, {
        type: 'svg',
        margin: 1,
        width: 240,
        color: { dark: '#111318', light: '#00000000' },
        errorCorrectionLevel: 'M',
      });
      return new Response(
        JSON.stringify({
          url: targetUrl,
          watchUrl,
          svg,
          sourceKind: 'trusted',
          hasTunnel: false,
          isCloud: true,
        }),
        { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    }

    // Friendly page routes
    let assetPath = pathname;
    if (assetPath === '/' || assetPath === '/host') assetPath = '/index.html';
    else if (assetPath === '/controller' || assetPath === '/remote' || assetPath === '/c') assetPath = '/controller.html';

    const assetUrl = new URL(assetPath, origin);
    const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));

    if (assetPath === '/downloads/aero-remote.apk' && assetRes.ok) {
      const headers = new Headers(assetRes.headers);
      headers.set('Content-Type', 'application/vnd.android.package-archive');
      headers.set('Content-Disposition', 'attachment; filename="aero-remote.apk"');
      return new Response(assetRes.body, { status: assetRes.status, headers });
    }

    return assetRes;
  },
};
