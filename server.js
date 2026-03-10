const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('PARKUR PvP Sunucusu Aktif 🎮');
});

const wss = new WebSocket.Server({ server });

// Odalar: { odaKodu: { players: [ws1, ws2], state: {...} } }
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getRoomByPlayer(ws) {
  for (const [code, room] of rooms.entries()) {
    if (room.players.includes(ws)) return { code, room };
  }
  return null;
}

wss.on('connection', (ws) => {
  console.log('Yeni bağlantı');
  ws.alive = true;

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── ODA OLUŞTUR ──
      case 'create_room': {
        let code;
        do { code = generateRoomCode(); } while (rooms.has(code));

        const room = {
          players: [ws],
          playerData: [{ weapon: msg.weapon || 'pistol', skin: msg.skin || 'default', name: msg.name || 'OYUNCU 1' }],
          scores: [0, 0],
          round: 1,
          maxRounds: 5,
          started: false
        };
        rooms.set(code, room);
        ws.roomCode = code;
        ws.playerIndex = 0;

        send(ws, { type: 'room_created', code, playerIndex: 0 });
        console.log(`Oda oluşturuldu: ${code}`);
        break;
      }

      // ── ODAYA KATIL ──
      case 'join_room': {
        const code = (msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);

        if (!room) {
          send(ws, { type: 'error', msg: 'Oda bulunamadı!' });
          return;
        }
        if (room.players.length >= 2) {
          send(ws, { type: 'error', msg: 'Oda dolu!' });
          return;
        }
        if (room.started) {
          send(ws, { type: 'error', msg: 'Oyun zaten başladı!' });
          return;
        }

        room.players.push(ws);
        room.playerData.push({ weapon: msg.weapon || 'pistol', skin: msg.skin || 'default', name: msg.name || 'OYUNCU 2' });
        ws.roomCode = code;
        ws.playerIndex = 1;

        // İkinci oyuncuya bilgi ver
        send(ws, {
          type: 'room_joined',
          code,
          playerIndex: 1,
          opponent: room.playerData[0]
        });

        // Birinci oyuncuya rakip geldi bildir
        send(room.players[0], {
          type: 'opponent_joined',
          opponent: room.playerData[1]
        });

        // Oyunu başlat
        room.started = true;
        const startData = {
          type: 'game_start',
          playerData: room.playerData,
          round: 1,
          maxRounds: room.maxRounds
        };
        room.players.forEach(p => send(p, startData));
        console.log(`Oda ${code} başladı`);
        break;
      }

      // ── OYUNCU DURUMU GÖNDER (hareket, konum, can) ──
      case 'player_state': {
        const r = getRoomByPlayer(ws);
        if (!r) return;
        const { room } = r;
        const opponent = room.players.find(p => p !== ws);
        if (opponent) {
          send(opponent, {
            type: 'opponent_state',
            x: msg.x, y: msg.y,
            vx: msg.vx, vy: msg.vy,
            facingR: msg.facingR,
            hp: msg.hp,
            weapon: msg.weapon,
            anim: msg.anim
          });
        }
        break;
      }

      // ── ATEŞLEDİ ──
      case 'shoot': {
        const r = getRoomByPlayer(ws);
        if (!r) return;
        const opponent = r.room.players.find(p => p !== ws);
        if (opponent) {
          send(opponent, {
            type: 'opponent_shoot',
            x: msg.x, y: msg.y,
            dir: msg.dir,
            weapon: msg.weapon,
            bul: msg.bul
          });
        }
        break;
      }

      // ── HIT (isabet) ──
      case 'hit': {
        const r = getRoomByPlayer(ws);
        if (!r) return;
        const { room } = r;
        const opponent = room.players.find(p => p !== ws);
        if (opponent) {
          send(opponent, {
            type: 'take_damage',
            dmg: msg.dmg,
            from: ws.playerIndex
          });
        }
        break;
      }

      // ── OYUNCU ÖLDÜ ──
      case 'player_died': {
        const r = getRoomByPlayer(ws);
        if (!r) return;
        const { code, room } = r;
        const killerIndex = room.players.findIndex(p => p !== ws);
        if (killerIndex >= 0) room.scores[killerIndex]++;

        const roundOver = {
          type: 'round_over',
          scores: room.scores,
          round: room.round,
          killerIndex
        };
        room.players.forEach(p => send(p, roundOver));

        room.round++;
        if (room.round > room.maxRounds || Math.max(...room.scores) > room.maxRounds / 2) {
          // Oyun bitti
          const winner = room.scores[0] > room.scores[1] ? 0 : 1;
          const gameOver = { type: 'game_over', scores: room.scores, winner };
          room.players.forEach(p => send(p, gameOver));
          setTimeout(() => rooms.delete(code), 30000);
        } else {
          // Sonraki round
          setTimeout(() => {
            const nextRound = { type: 'next_round', round: room.round, scores: room.scores };
            room.players.forEach(p => send(p, nextRound));
          }, 3000);
        }
        break;
      }

      // ── TEKRAR OYNA ──
      case 'rematch': {
        const r = getRoomByPlayer(ws);
        if (!r) return;
        const { room } = r;
        ws.wantsRematch = true;
        const both = room.players.every(p => p.wantsRematch);
        if (both) {
          room.scores = [0, 0];
          room.round = 1;
          room.players.forEach(p => { p.wantsRematch = false; });
          const restart = { type: 'game_start', playerData: room.playerData, round: 1, maxRounds: room.maxRounds };
          room.players.forEach(p => send(p, restart));
        } else {
          const opponent = room.players.find(p => p !== ws);
          if (opponent) send(opponent, { type: 'opponent_wants_rematch' });
        }
        break;
      }

      // ── SOHBET/EMOJI ──
      case 'emote': {
        const r = getRoomByPlayer(ws);
        if (!r) return;
        const opponent = r.room.players.find(p => p !== ws);
        if (opponent) send(opponent, { type: 'opponent_emote', emote: msg.emote });
        break;
      }
    }
  });

  ws.on('close', () => {
    const r = getRoomByPlayer(ws);
    if (!r) return;
    const { code, room } = r;
    const opponent = room.players.find(p => p !== ws);
    if (opponent) send(opponent, { type: 'opponent_disconnected' });
    rooms.delete(code);
    console.log(`Oda ${code} silindi (bağlantı koptu)`);
  });

  ws.on('error', () => {});
});

// Ping-pong (ölü bağlantıları temizle)
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) { ws.terminate(); return; }
    ws.alive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`🎮 PARKUR PvP Sunucusu port ${PORT}'de çalışıyor`);
});
