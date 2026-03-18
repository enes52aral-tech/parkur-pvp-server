const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('SOKAK SAVAŞÇISI PvP Sunucusu Aktif 🎮');
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();
const lobbyPlayers = new Map();
const registeredPlayers = new Map();
const giftQueue = new Map(); // name → [gift, ...]
let playerIdCounter = 0;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function getRoomByPlayer(ws) {
  for (const [code, room] of rooms.entries()) {
    if (room.players.includes(ws)) return { code, room };
  }
  return null;
}

function broadcastLobby() {
  const players = [];
  for (const [id, p] of lobbyPlayers.entries()) players.push({ id, name: p.name });
  for (const [, p] of lobbyPlayers.entries()) {
    const filtered = players.filter(pl => pl.id !== p.ws.playerId);
    send(p.ws, { type: 'lobby_players', players: filtered });
  }
}

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.playerId = String(++playerIdCounter);

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'lobby_join': {
        ws.playerName = (msg.name || 'OYUNCU').toUpperCase().slice(0, 12);
        lobbyPlayers.set(ws.playerId, { ws, name: ws.playerName });
        registeredPlayers.set(ws.playerName, { lastSeen: Date.now(), id: ws.playerId });
        broadcastLobby();
        // Bekleyen hediyeleri gönder
        const pending = giftQueue.get(ws.playerName) || [];
        if (pending.length) {
          setTimeout(() => {
            pending.forEach(g => send(ws, { type: 'gift_received', gift: g }));
            giftQueue.delete(ws.playerName);
          }, 1000);
        }
        break;
      }

      case 'search_player': {
        const q = (msg.query || '').toUpperCase().trim();
        if (q.length < 2) { send(ws, { type: 'search_results', results: [] }); break; }
        const myName = (ws.playerName || '').toUpperCase();
        const results = [];
        for (const [id, p] of lobbyPlayers.entries()) {
          if (p.name.toUpperCase().includes(q) && p.name.toUpperCase() !== myName) {
            results.push({ name: p.name, id, online: true });
          }
        }
        for (const [name, data] of registeredPlayers.entries()) {
          if (name.includes(q) && name !== myName && !results.find(r => r.name === name)) {
            results.push({ name, id: null, online: false });
          }
        }
        send(ws, { type: 'search_results', results: results.slice(0, 10) });
        break;
      }

      case 'gift': {
        const toName = (msg.to || '').toUpperCase();
        const giftData = { from: ws.playerName || 'OYUNCU', ...msg.gift, ts: Date.now() };
        const onlineTarget = [...lobbyPlayers.values()].find(p => p.name.toUpperCase() === toName);
        if (onlineTarget) {
          send(onlineTarget.ws, { type: 'gift_received', gift: giftData });
        } else {
          if (!giftQueue.has(toName)) giftQueue.set(toName, []);
          giftQueue.get(toName).push(giftData);
        }
        send(ws, { type: 'gift_sent' });
        break;
      }

      case 'invite': {
        const target = lobbyPlayers.get(msg.to);
        if (target) send(target.ws, { type: 'invite', from: ws.playerId, fromName: ws.playerName || 'OYUNCU' });
        break;
      }

      case 'invite_accept': {
        const inviter = lobbyPlayers.get(msg.to);
        if (inviter) send(inviter.ws, { type: 'invite_accepted', from: ws.playerId, fromName: ws.playerName || 'OYUNCU' });
        break;
      }

      case 'invite_decline': {
        const inviter = lobbyPlayers.get(msg.to);
        if (inviter) send(inviter.ws, { type: 'invite_declined' });
        break;
      }

      case 'create_room': {
        lobbyPlayers.delete(ws.playerId);
        broadcastLobby();
        let code; do { code = generateRoomCode(); } while (rooms.has(code));
        const room = {
          players: [ws],
          playerData: [{ weapon: msg.weapon || 'pistol', skin: msg.skin || 'default', name: msg.name || 'OYUNCU 1' }],
          scores: [0, 0], round: 1, maxRounds: 5, started: false
        };
        rooms.set(code, room);
        ws.roomCode = code; ws.playerIndex = 0;
        send(ws, { type: 'room_created', code, playerIndex: 0 });
        if (msg.inviteTo) {
          const invitee = lobbyPlayers.get(msg.inviteTo);
          if (invitee) send(invitee.ws, { type: 'auto_join', code, fromName: msg.name || 'OYUNCU' });
        }
        break;
      }

      case 'join_room': {
        const code = (msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) { send(ws, { type: 'error', msg: 'Oda bulunamadı!' }); return; }
        if (room.players.length >= 2) { send(ws, { type: 'error', msg: 'Oda dolu!' }); return; }
        if (room.started) { send(ws, { type: 'error', msg: 'Oyun başladı!' }); return; }
        lobbyPlayers.delete(ws.playerId);
        broadcastLobby();
        room.players.push(ws);
        room.playerData.push({ weapon: msg.weapon || 'pistol', skin: msg.skin || 'default', name: msg.name || 'OYUNCU 2' });
        ws.roomCode = code; ws.playerIndex = 1;
        send(ws, { type: 'room_joined', code, playerIndex: 1, opponent: room.playerData[0] });
        send(room.players[0], { type: 'opponent_joined', opponent: room.playerData[1] });
        room.started = true;
        const startData = { type: 'game_start', playerData: room.playerData, round: 1, maxRounds: room.maxRounds };
        room.players.forEach(p => send(p, startData));
        break;
      }

      case 'player_state': {
        const r = getRoomByPlayer(ws); if (!r) return;
        const opp = r.room.players.find(p => p !== ws);
        if (opp) send(opp, { type: 'opponent_state', x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy, facingR: msg.facingR, hp: msg.hp, weapon: msg.weapon });
        break;
      }

      case 'shoot': {
        const r = getRoomByPlayer(ws); if (!r) return;
        const opp = r.room.players.find(p => p !== ws);
        if (opp) send(opp, { type: 'opponent_shoot', x: msg.x, y: msg.y, dir: msg.dir, weapon: msg.weapon, bul: msg.bul });
        break;
      }

      case 'hit': {
        const r = getRoomByPlayer(ws); if (!r) return;
        const opp = r.room.players.find(p => p !== ws);
        if (opp) send(opp, { type: 'take_damage', dmg: msg.dmg });
        break;
      }

      case 'ability_used': {
        const r = getRoomByPlayer(ws); if (!r) return;
        const opp = r.room.players.find(p => p !== ws);
        if (opp) send(opp, { type: 'opponent_ability', costumeId: msg.costumeId });
        break;
      }

      case 'ability_effect': {
        const r = getRoomByPlayer(ws); if (!r) return;
        const opp = r.room.players.find(p => p !== ws);
        if (opp) send(opp, { type: 'opponent_ability_effect', effect: msg.effect });
        break;
      }

      case 'player_died': {
        const r = getRoomByPlayer(ws); if (!r) return;
        const { code, room } = r;
        const killerIdx = room.players.findIndex(p => p !== ws);
        if (killerIdx >= 0) room.scores[killerIdx]++;
        room.players.forEach(p => send(p, { type: 'round_over', scores: room.scores, round: room.round, killerIndex: killerIdx }));
        room.round++;
        if (room.round > room.maxRounds || Math.max(...room.scores) > room.maxRounds / 2) {
          const winner = room.scores[0] > room.scores[1] ? 0 : 1;
          room.players.forEach(p => send(p, { type: 'game_over', scores: room.scores, winner }));
          setTimeout(() => rooms.delete(code), 30000);
        } else {
          setTimeout(() => room.players.forEach(p => send(p, { type: 'next_round', round: room.round, scores: room.scores })), 3000);
        }
        break;
      }

      case 'rematch': {
        const r = getRoomByPlayer(ws); if (!r) return;
        const { room } = r;
        ws.wantsRematch = true;
        if (room.players.every(p => p.wantsRematch)) {
          room.scores = [0, 0]; room.round = 1;
          room.players.forEach(p => { p.wantsRematch = false; send(p, { type: 'game_start', playerData: room.playerData, round: 1, maxRounds: room.maxRounds }); });
        } else {
          const opp = room.players.find(p => p !== ws);
          if (opp) send(opp, { type: 'opponent_wants_rematch' });
        }
        break;
      }

      case 'emote': {
        const r = getRoomByPlayer(ws); if (!r) return;
        const opp = r.room.players.find(p => p !== ws);
        if (opp) send(opp, { type: 'opponent_emote', emote: msg.emote });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.playerName) {
      registeredPlayers.set(ws.playerName, { lastSeen: Date.now(), id: null });
    }
    lobbyPlayers.delete(ws.playerId);
    broadcastLobby();
    const r = getRoomByPlayer(ws); if (!r) return;
    const { code, room } = r;
    const opp = room.players.find(p => p !== ws);
    if (opp) send(opp, { type: 'opponent_disconnected' });
    rooms.delete(code);
  });

  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) { ws.terminate(); return; }
    ws.alive = false; ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log(`🎮 SOKAK SAVAŞÇISI PvP Sunucusu port ${PORT}'de çalışıyor`));
