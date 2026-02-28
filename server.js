/**
 * Doodle War – Authoritative Multiplayer Server
 * Zero external dependencies — uses only Node built-ins (http, crypto, net)
 *
 * Usage:  node server.js [port]
 * Default port: 3000
 */

const http   = require('http');
const crypto = require('crypto');
const PORT   = parseInt(process.env.PORT || process.argv[2] || '3000');

// ─── Minimal WebSocket server (RFC 6455) ────────────────────────────────────
class WSServer {
  constructor(httpServer) {
    this.clients = new Map(); // id -> socket+meta
    this._nextId = 1;
    httpServer.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) return socket.destroy();
      const accept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      const id = this._nextId++;
      const client = { id, socket, buf: Buffer.alloc(0) };
      this.clients.set(id, client);
      socket.on('data', data => this._onData(client, data));
      socket.on('close', () => { this.clients.delete(id); this.onclose && this.onclose(id); });
      socket.on('error', () => socket.destroy());
      this.onconnect && this.onconnect(id);
    });
  }

  _onData(client, data) {
    client.buf = Buffer.concat([client.buf, data]);
    while (client.buf.length >= 2) {
      const b0 = client.buf[0], b1 = client.buf[1];
      const masked = !!(b1 & 0x80);
      let payLen = b1 & 0x7f;
      let offset = 2;
      if (payLen === 126) { if (client.buf.length < 4) break; payLen = client.buf.readUInt16BE(2); offset = 4; }
      else if (payLen === 127) { if (client.buf.length < 10) break; payLen = Number(client.buf.readBigUInt64BE(2)); offset = 10; }
      const maskLen = masked ? 4 : 0;
      if (client.buf.length < offset + maskLen + payLen) break;
      const mask = masked ? client.buf.slice(offset, offset + 4) : null;
      offset += maskLen;
      const payload = client.buf.slice(offset, offset + payLen);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      client.buf = client.buf.slice(offset + payLen);
      const opcode = b0 & 0x0f;
      if (opcode === 8) { client.socket.destroy(); break; }
      if (opcode === 9) { this.send(client.id, '', 10); break; } // pong
      if (opcode === 1 || opcode === 2) this.onmessage && this.onmessage(client.id, payload.toString('utf8'));
    }
  }

  send(id, msg, opcode = 1) {
    const client = this.clients.get(id);
    if (!client) return;
    const payload = Buffer.from(msg, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126)      header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0]=0x80|opcode; header[1]=126; header.writeUInt16BE(len,2); }
    else                  { header = Buffer.alloc(10); header[0]=0x80|opcode; header[1]=127; header.writeBigUInt64BE(BigInt(len),2); }
    try { client.socket.write(Buffer.concat([header, payload])); } catch(_) {}
  }

  broadcast(msg, exceptId) {
    for (const [id] of this.clients) if (id !== exceptId) this.send(id, msg);
  }
}

// ─── Game Constants (must match client) ─────────────────────────────────────
const GRAVITY      = 0.45;
const TERMINAL_VEL = 14;
const JUMP_FORCE   = -10;
const MOVE_SPEED   = 3.5;
const JETPACK_FORCE= 0.55;
const MAX_FUEL     = 100;
const FUEL_DRAIN   = 0.8;
const FUEL_REGEN   = 0.3;
const MAX_HP       = 100;
const RESPAWN_TIME = 120;
const WIN_KILLS    = 10;
const W = 900, H = 550;

const PLATFORMS = [
  {x:0,y:520,w:900,h:30},{x:0,y:0,w:20,h:520},{x:880,y:0,w:20,h:520},
  {x:20,y:480,w:80,h:12},{x:65,y:450,w:80,h:12},{x:110,y:420,w:80,h:12},
  {x:800,y:480,w:80,h:12},{x:755,y:450,w:80,h:12},{x:710,y:420,w:80,h:12},
  {x:55,y:460,w:55,h:12},{x:55,y:320,w:55,h:12},{x:55,y:190,w:55,h:12},
  {x:790,y:460,w:55,h:12},{x:790,y:320,w:55,h:12},{x:790,y:190,w:55,h:12},
  {x:100,y:400,w:160,h:16},{x:640,y:400,w:160,h:16},{x:350,y:340,w:200,h:16},
  {x:180,y:250,w:130,h:16},{x:590,y:250,w:130,h:16},{x:380,y:175,w:140,h:16},
  {x:90,y:130,w:100,h:16},{x:710,y:130,w:100,h:16},
];

const WEAPONS = {
  pistol:      {damage:15,fireRate:18,speed:12,spread:0.05,ammo:-1, reloadTime:30,life:120},
  shotgun:     {damage:18,fireRate:40,speed:10,spread:0.25,ammo:24, reloadTime:60,life:80, pellets:6},
  sniper:      {damage:70,fireRate:70,speed:25,spread:0.01,ammo:10, reloadTime:80,life:220},
  machinegun:  {damage:9, fireRate:5, speed:14,spread:0.08,ammo:60, reloadTime:50,life:130},
  rocketlauncher:{damage:75,fireRate:90,speed:8,spread:0, ammo:6,  reloadTime:90,life:180,explosive:true},
  flamethrower:{damage:5, fireRate:4, speed:6, spread:0.35,ammo:80,reloadTime:50,life:40, flame:true},
};

const WEAPON_PICKUPS = [
  {x:230,y:223,type:'shotgun'},{x:620,y:223,type:'sniper'},
  {x:425,y:148,type:'rocketlauncher'},{x:85,y:103,type:'flamethrower'},
  {x:765,y:103,type:'machinegun'},
];
const HEALTH_PACKS = [
  {x:430,y:312},{x:60,y:393},{x:820,y:393},
];

// ─── Room / Lobby ────────────────────────────────────────────────────────────
const rooms   = new Map(); // code -> Room
const players = new Map(); // wsId -> {room, playerNum}

function makeCode() {
  return Math.random().toString(36).slice(2,6).toUpperCase();
}

// ─── Game Room ───────────────────────────────────────────────────────────────
class Room {
  constructor(code) {
    this.code    = code;
    this.wsIds   = [null, null]; // index 0=P1, 1=P2
    this.game    = null;
    this.inputs  = [{}, {}];     // latest input per player
    this.started = false;
  }

  addPlayer(wsId) {
    const slot = this.wsIds[0] === null ? 0 : (this.wsIds[1] === null ? 1 : -1);
    if (slot === -1) return false;
    this.wsIds[slot] = wsId;
    players.set(wsId, { room: this, playerNum: slot + 1 });
    return slot + 1; // 1 or 2
  }

  removePlayer(wsId) {
    for (let i = 0; i < 2; i++) if (this.wsIds[i] === wsId) this.wsIds[i] = null;
    players.delete(wsId);
    if (this.game) this.game.running = false;
  }

  isFull() { return this.wsIds[0] !== null && this.wsIds[1] !== null; }

  broadcast(msg) {
    for (const id of this.wsIds) if (id !== null) wss.send(id, msg);
  }

  start() {
    this.started = true;
    this.game    = new Game(this);
    this.game.start();
  }
}

// ─── Authoritative Game ──────────────────────────────────────────────────────
class Game {
  constructor(room) {
    this.room    = room;
    this.running = false;
    this.frame   = 0;
    this.bullets = [];
    this.particles = [];
    this.picks   = WEAPON_PICKUPS.map(p => ({...p, taken:false, respawn:0}));
    this.hps     = HEALTH_PACKS.map(p  => ({...p, taken:false, respawn:0}));
    this.players = [
      this._makePlayer(1, 120, 450),
      this._makePlayer(2, 760, 450),
    ];
  }

  _makePlayer(id, x, y) {
    return {
      id, x, y, w:26, h:36, vx:0, vy:0,
      hp: MAX_HP, fuel: MAX_FUEL,
      onGround: false, dead: false, respawnTimer: 0,
      kills: 0, facing: id===1?1:-1,
      aimAngle: id===1?0:Math.PI,
      weapon:'pistol', ammo:-1,
      carriedWeapons:['pistol'], weaponAmmos:{pistol:-1},
      reloadTimer:0, fireTimer:0,
      legPhase:0, jetpackFlame:0, flashTimer:0,
      _weaponHeld:false,
    };
  }

  start() {
    this.running = true;
    this._loop();
  }

  _loop() {
    if (!this.running) return;
    this.frame++;

    const inp = this.room.inputs;
    const [p1, p2] = this.players;
    this._updatePlayer(p1, p2, inp[0]);
    this._updatePlayer(p2, p1, inp[1]);
    this._updateBullets();
    this._updatePickups();

    // Broadcast state every frame (clients interpolate)
    if (this.frame % 2 === 0) this._broadcast();

    setTimeout(() => this._loop(), 16); // ~60fps
  }

  _updatePlayer(p, other, inp) {
    if (p.dead) {
      if (--p.respawnTimer <= 0) this._respawn(p);
      return;
    }

    // Movement
    if (inp.left)  { p.vx -= MOVE_SPEED*0.35; if(p.vx<-MOVE_SPEED) p.vx=-MOVE_SPEED; p.facing=-1; }
    if (inp.right) { p.vx += MOVE_SPEED*0.35; if(p.vx> MOVE_SPEED) p.vx= MOVE_SPEED; p.facing= 1; }
    if (!inp.left && !inp.right) p.vx *= 0.75;
    if (inp.jump && p.onGround) p.vy = JUMP_FORCE;

    // Jetpack
    if (inp.jetpack && p.fuel > 0) {
      p.vy -= JETPACK_FORCE;
      if (inp.left)  p.vx -= 0.2;
      if (inp.right) p.vx += 0.2;
      p.fuel = Math.max(0, p.fuel - FUEL_DRAIN);
      p.jetpackFlame = 8;
    } else {
      p.fuel = Math.min(MAX_FUEL, p.fuel + FUEL_REGEN);
      if (p.jetpackFlame > 0) p.jetpackFlame--;
    }

    p.vy += GRAVITY;
    if (p.vy > TERMINAL_VEL) p.vy = TERMINAL_VEL;
    p.x += p.vx; p.y += p.vy;
    this._resolveCollision(p);

    // Aim at other player
    p.aimAngle = Math.atan2(other.y - p.y, other.x - p.x);

    // Timers
    if (p.reloadTimer > 0) p.reloadTimer--;
    else if (p.ammo === 0 && WEAPONS[p.weapon].ammo !== -1) p.ammo = WEAPONS[p.weapon].ammo;
    if (p.fireTimer > 0) p.fireTimer--;

    // Fire
    const wep = WEAPONS[p.weapon];
    if (inp.fire && p.fireTimer <= 0 && p.reloadTimer <= 0) {
      const ammoOk = wep.ammo === -1 || p.ammo > 0;
      if (ammoOk) {
        this._fire(p, wep);
        p.fireTimer = wep.fireRate;
        if (wep.ammo !== -1) { p.ammo--; if (p.ammo === 0) p.reloadTimer = wep.reloadTime; }
      }
    }

    // Manual reload
    if (inp.reload && wep.ammo !== -1 && p.reloadTimer <= 0 && p.ammo < wep.ammo) {
      p.reloadTimer = wep.reloadTime; p.ammo = 0;
    }

    // Weapon swap
    if (inp.weapon && !p._weaponHeld) {
      p._weaponHeld = true;
      const order = ['pistol','shotgun','sniper','machinegun','rocketlauncher','flamethrower'];
      const carried = order.filter(w => p.carriedWeapons.includes(w));
      if (carried.length > 1) {
        const idx = (carried.indexOf(p.weapon)+1) % carried.length;
        p.weaponAmmos[p.weapon] = p.ammo;
        p.weapon = carried[idx];
        p.ammo = p.weaponAmmos[p.weapon] ?? WEAPONS[p.weapon].ammo;
        p.reloadTimer=0; p.fireTimer=0;
      }
    }
    if (!inp.weapon) p._weaponHeld = false;

    if (inp.left || inp.right) p.legPhase += 0.25;
    if (p.flashTimer > 0) p.flashTimer--;
    p.x = Math.max(20, Math.min(W-p.w-20, p.x));
    if (p.y > H) { p.hp = 0; this._checkDeath(p); }
  }

  _fire(p, wep) {
    const pellets = wep.pellets || 1;
    for (let i = 0; i < pellets; i++) {
      const angle = p.aimAngle + (Math.random()-0.5)*wep.spread*2;
      this.bullets.push({
        owner: p.id,
        x: p.x+p.w/2 + Math.cos(p.aimAngle)*18,
        y: p.y+p.h/2 + Math.sin(p.aimAngle)*18,
        vx: Math.cos(angle)*wep.speed,
        vy: Math.sin(angle)*wep.speed,
        dmg: wep.damage, explosive: !!wep.explosive, flame: !!wep.flame,
        life: wep.life||120,
      });
    }
  }

  _updateBullets() {
    for (let i = this.bullets.length-1; i >= 0; i--) {
      const b = this.bullets[i];
      if (b.flame) { b.x += b.vx+(Math.random()-0.5)*1.5; b.y += b.vy+(Math.random()-0.5)*1.5; b.vy+=0.1; }
      else         { b.x += b.vx; b.y += b.vy; }
      b.life--;
      if (b.x<0||b.x>W||b.y<0||b.y>H||b.life<=0||this._bulletHitPlat(b)) {
        if (b.explosive && this._bulletHitPlat(b)) this._explode(b.x,b.y,b.owner);
        this.bullets.splice(i,1); continue;
      }
      let hit = false;
      for (const p of this.players) {
        if (p.dead || p.id===b.owner) continue;
        if (b.x>p.x&&b.x<p.x+p.w&&b.y>p.y&&b.y<p.y+p.h) {
          const isHead = b.y < p.y+p.h*0.25;
          p.hp -= isHead ? b.dmg*1.5 : b.dmg;
          p.flashTimer = 8;
          if (b.explosive) this._explode(b.x,b.y,b.owner);
          this._checkDeath(p);
          hit=true; break;
        }
      }
      if (hit) { this.bullets.splice(i,1); }
    }
  }

  _explode(x, y, ownerId) {
    for (const p of this.players) {
      if (p.dead||p.id===ownerId) continue;
      const dist = Math.hypot(p.x+p.w/2-x, p.y+p.h/2-y);
      if (dist < 80) {
        const f = 1-dist/80;
        p.hp -= 70*f; p.vy -= 5*f;
        p.vx += ((p.x+p.w/2-x)>0?1:-1)*4*f;
        p.flashTimer=10; this._checkDeath(p);
      }
    }
  }

  _updatePickups() {
    for (const pk of this.picks) {
      if (pk.taken) { if(--pk.respawn<=0) pk.taken=false; continue; }
      for (const p of this.players) {
        if (!p.dead && Math.abs(p.x+p.w/2-pk.x)<40 && Math.abs(p.y+p.h-pk.y)<40) {
          this._equip(p, pk.type);
          pk.taken=true; pk.respawn=600;
        }
      }
    }
    for (const hp of this.hps) {
      if (hp.taken) { if(--hp.respawn<=0) hp.taken=false; continue; }
      for (const p of this.players) {
        if (!p.dead && Math.abs(p.x+p.w/2-hp.x)<22 && Math.abs(p.y+p.h/2-hp.y)<22) {
          p.hp = Math.min(MAX_HP, p.hp+40);
          hp.taken=true; hp.respawn=480;
        }
      }
    }
  }

  _equip(p, type) {
    if (p.carriedWeapons) p.weaponAmmos[p.weapon]=p.ammo;
    if (!p.carriedWeapons.includes(type)) p.carriedWeapons.push(type);
    p.weapon=type; p.ammo=p.weaponAmmos[type]??WEAPONS[type].ammo;
    p.reloadTimer=0; p.fireTimer=0;
  }

  _checkDeath(p) {
    if (p.hp<=0 && !p.dead) {
      p.dead=true; p.respawnTimer=RESPAWN_TIME;
      const other = this.players.find(x=>x.id!==p.id);
      other.kills++;
      if (other.kills >= WIN_KILLS) {
        this.running=false;
        this.room.broadcast(JSON.stringify({type:'win',winner:other.id,kills:other.kills}));
      }
    }
  }

  _respawn(p) {
    p.dead=false; p.hp=MAX_HP; p.fuel=MAX_FUEL; p.vx=0; p.vy=0;
    p.weapon='pistol'; p.ammo=-1;
    p.carriedWeapons=['pistol']; p.weaponAmmos={pistol:-1};
    p.reloadTimer=0; p.fireTimer=0;
    p.x=p.id===1?120:760; p.y=450;
  }

  _resolveCollision(p) {
    p.onGround=false;
    for (const pl of PLATFORMS) {
      if (p.x<pl.x+pl.w&&p.x+p.w>pl.x&&p.y<pl.y+pl.h&&p.y+p.h>pl.y) {
        const ol=(p.x+p.w)-pl.x, or2=pl.x+pl.w-p.x;
        const ot=(p.y+p.h)-pl.y, ob=pl.y+pl.h-p.y;
        const mh=Math.min(ol,or2), mv=Math.min(ot,ob);
        if (mv<mh) {
          if(ot<ob){p.y=pl.y-p.h;p.vy=0;p.onGround=true;}
          else{p.y=pl.y+pl.h;p.vy=0;}
        } else {
          if(ol<or2){p.x=pl.x-p.w;p.vx=0;}
          else{p.x=pl.x+pl.w;p.vx=0;}
        }
      }
    }
  }

  _bulletHitPlat(b) {
    for (const pl of PLATFORMS)
      if (b.x>pl.x&&b.x<pl.x+pl.w&&b.y>pl.y&&b.y<pl.y+pl.h) return true;
    return false;
  }

  _broadcast() {
    const [p1,p2] = this.players;
    const state = {
      type:'state', frame:this.frame,
      p1: this._serializePlayer(p1),
      p2: this._serializePlayer(p2),
      bullets: this.bullets.map(b=>({x:Math.round(b.x),y:Math.round(b.y),vx:b.vx,vy:b.vy,dmg:b.dmg,owner:b.owner,explosive:b.explosive,flame:b.flame})),
      picks: this.picks.map(p=>p.taken?1:0),
      hps:   this.hps.map(h=>h.taken?1:0),
    };
    this.room.broadcast(JSON.stringify(state));
  }

  _serializePlayer(p) {
    return {
      id:p.id, x:Math.round(p.x*10)/10, y:Math.round(p.y*10)/10,
      vx:p.vx, vy:p.vy, hp:p.hp, fuel:p.fuel,
      dead:p.dead, kills:p.kills, facing:p.facing,
      aimAngle:Math.round(p.aimAngle*100)/100,
      weapon:p.weapon, ammo:p.ammo,
      reloadTimer:p.reloadTimer, fireTimer:p.fireTimer,
      onGround:p.onGround, legPhase:Math.round(p.legPhase*10)/10,
      jetpackFlame:p.jetpackFlame, flashTimer:p.flashTimer,
      respawnTimer:p.respawnTimer,
      carriedWeapons:p.carriedWeapons,
    };
  }
}

// ─── HTTP Server (serves the client HTML) ───────────────────────────────────
const fs   = require('fs');
const path = require('path');

const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(fs.readFileSync(path.join(__dirname,'index.html')));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WSServer(httpServer);

// ─── WebSocket Message Handling ──────────────────────────────────────────────
wss.onconnect = (wsId) => {
  console.log(`Client connected: ${wsId}`);
  wss.send(wsId, JSON.stringify({type:'connected', id:wsId}));
};

wss.onclose = (wsId) => {
  console.log(`Client disconnected: ${wsId}`);
  const meta = players.get(wsId);
  if (meta) {
    const room = meta.room;
    room.removePlayer(wsId);
    room.broadcast(JSON.stringify({type:'opponent_left'}));
    if (room.wsIds[0]===null && room.wsIds[1]===null) rooms.delete(room.code);
  }
};

wss.onmessage = (wsId, raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch(_) { return; }

  if (msg.type === 'create') {
    let code;
    do { code = makeCode(); } while (rooms.has(code));
    const room = new Room(code);
    rooms.set(code, room);
    const pNum = room.addPlayer(wsId);
    wss.send(wsId, JSON.stringify({type:'created', code, playerNum: pNum}));
    console.log(`Room ${code} created by ${wsId}`);
  }

  else if (msg.type === 'join') {
    const code = (msg.code||'').toUpperCase();
    const room = rooms.get(code);
    if (!room)         return wss.send(wsId, JSON.stringify({type:'error', msg:'Room not found'}));
    if (room.isFull()) return wss.send(wsId, JSON.stringify({type:'error', msg:'Room is full'}));
    const pNum = room.addPlayer(wsId);
    wss.send(wsId, JSON.stringify({type:'joined', code, playerNum: pNum}));
    // Notify P1 that P2 joined
    if (room.wsIds[0] !== null) wss.send(room.wsIds[0], JSON.stringify({type:'opponent_joined'}));
    // Start game
    room.broadcast(JSON.stringify({type:'start', playerNum1:1, playerNum2:2}));
    room.start();
    console.log(`Room ${code}: game started`);
  }

  else if (msg.type === 'input') {
    const meta = players.get(wsId);
    if (!meta) return;
    const idx = meta.playerNum - 1;
    meta.room.inputs[idx] = msg.input || {};
  }
};

httpServer.listen(PORT, () => {
  const nets = require('os').networkInterfaces();
  console.log(`\n🎮 Doodle War Server running on port ${PORT}`);
  console.log(`\n📡 Share one of these URLs with your friend:\n`);
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family==='IPv4' && !net.internal) {
        console.log(`   http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`   http://localhost:${PORT}  (same machine)\n`);
});
