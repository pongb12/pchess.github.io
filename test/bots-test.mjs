import { Chess } from '../lib/chess.js';

const BASE = process.env.WS_BASE || 'ws://127.0.0.1:8787';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return null;
}

class Bot {
  constructor(name, room, role) {
    this.name = name;
    this.room = room;
    this.role = role;
    this.queue = [];
    this.waiters = [];
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(BASE);
      u.pathname = '/room';
      u.searchParams.set('code', this.room);
      u.searchParams.set('role', this.role);
      this.ws = new WebSocket(u.toString());
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`${this.name}: ws error`));
      this.ws.onmessage = (ev) => {
        const text = decode(ev.data);
        let m;
        try { m = JSON.parse(text); } catch { m = { type: '__badjson__', raw: text }; }
        this._push(m);
      };
      this.ws.onclose = (ev) => {
        this.closed = true;
        this._push({ type: '__closed__', code: ev.code });
      };
    });
  }

  _push(m) {
    if (this.waiters.length) this.waiters.shift()(m);
    else this.queue.push(m);
  }

  next(timeoutMs = 20000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: timeout`)), timeoutMs);
      this.waiters.push((m) => { clearTimeout(t); resolve(m); });
    });
  }

  async nextType(type, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const m = await this.next(Math.max(100, deadline - Date.now()));
      if (m.type === type) return m;
      if (m.type === '__closed__') throw new Error(`${this.name}: closed before ${type}`);
      this.queue.unshift(m);
    }
    throw new Error(`${this.name}: timeout waiting ${type}`);
  }

  async nextAnyOf(types, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const m = await this.next(Math.max(100, deadline - Date.now()));
      if (types.includes(m.type)) return m;
      if (m.type === '__closed__') throw new Error(`${this.name}: closed before ${types.join('/')}`);
      this.queue.unshift(m);
    }
    throw new Error(`${this.name}: timeout waiting ${types.join('/')}`);
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error(`${this.name}: ws not open`);
    this.ws.send(JSON.stringify(obj));
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

function pickMove(chess, seed) {
  const moves = chess.moves({ verbose: true });
  return moves[seed % moves.length];
}

async function main() {
  const room = 'test' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
  console.log(`=== Bot test: 2 bots nối phòng "${room}" (${BASE}) ===\n`);

  // 1) Host connect
  const host = new Bot('HOST', room, 'host');
  await host.connect();
  let msg = await host.nextType('joined');
  check('HOST: joined role=host', msg.role === 'host', `role=${msg.role}`);
  check('HOST: color=w', msg.color === 'w', `color=${msg.color}`);
  check('HOST: game=null (chưa có ván dở)', msg.game === null, `game=${JSON.stringify(msg.game)}`);

  // ping/pong
  host.send({ type: 'ping', timestamp: 12345 });
  msg = await host.nextType('pong');
  check('HOST: pong echo timestamp', msg.timestamp === 12345, `ts=${msg.timestamp}`);

  // 2) Guest connect
  const guest = new Bot('GUEST', room, 'guest');
  await guest.connect();
  msg = await guest.nextType('joined');
  check('GUEST: joined role=guest', msg.role === 'guest', `role=${msg.role}`);
  check('GUEST: color=b', msg.color === 'b', `color=${msg.color}`);

  msg = await host.nextType('peer_joined');
  check('HOST: nhận peer_joined khi guest vào', msg.type === 'peer_joined');

  // 3) relay init: host -> guest
  host.send({ type: 'init', color: 'b', settings: { theme: 'classic' }, fen: 'start' });
  msg = await guest.nextType('init');
  check('GUEST: nhận init relay verbatim', msg.color === 'b' && msg.settings.theme === 'classic', JSON.stringify(msg));

  // 4) ping from server side check (guest)
  guest.send({ type: 'ping', timestamp: 999 });
  msg = await guest.nextType('pong');
  check('GUEST: pong', msg.timestamp === 999);

  // 5) Host move e2-e4 -> broadcast
  host.send({ type: 'move', move: { from: 'e2', to: 'e4' } });
  const h1 = await host.nextType('move');
  const g1 = await guest.nextType('move');
  check('HOST: move e4 san', h1.san === 'e4', `san=${h1.san}`);
  check('HOST: move fen hợp lệ (đen đi)', typeof h1.fen === 'string' && h1.fen.includes(' b '), h1.fen);
  check('GUEST: nhận cùng broadcast move', g1.san === 'e4' && g1.fen === h1.fen);

  await wait(150);

  // 6) Host move lại (lượt đen) -> not_your_turn
  host.send({ type: 'move', move: { from: 'e7', to: 'e5' } });
  msg = await host.nextType('move_rejected');
  check('HOST: đi sai lượt -> not_your_turn', msg.reason === 'not_your_turn', `reason=${msg.reason}`);

  // 7) Guest move e7-e5
  await wait(150);
  guest.send({ type: 'move', move: { from: 'e7', to: 'e5' } });
  const [hs, gs] = await Promise.all([host.nextType('move'), guest.nextType('move')]);
  check('GUEST: move e5 được nhận', gs.san === 'e5', `san=${gs.san}`);
  check('HOST: nhận broadcast e5', hs.san === 'e5' && hs.fen === gs.fen, `san=${hs.san}`);

  await wait(150);

  // 8) Host move bất hợp lệ (tốt a2 không nhảy 3 ô) -> illegal
  host.send({ type: 'move', move: { from: 'a2', to: 'a5' } });
  msg = await host.nextType('move_rejected');
  check('HOST: nước bất hợp lệ -> illegal', msg.reason === 'illegal', `reason=${msg.reason}`);

  // 9) Rate limit: gửi ngay nước thứ 2 trong vòng 100ms -> rate_limit
  host.send({ type: 'move', move: { from: 'a2', to: 'a5' } });
  msg = await host.nextType('move_rejected');
  check('HOST: spam -> rate_limit', msg.reason === 'rate_limit', `reason=${msg.reason}`);

  await wait(150);

  // 10) sync_request -> sync
  host.send({ type: 'sync_request' });
  msg = await host.nextType('sync');
  check('HOST: sync trả fen + history', Array.isArray(msg.history) && msg.history.join(',') === 'e4,e5' && msg.fen === hs.fen, `history=${msg.history}`);

  // 11) Chơi tiếp nhiều nước (server-authoritative, dùng chess.js local để verify)
  console.log('\n-- Game loop: 12 nước đi xoay lượt --');
  const serverChess = new Chess(hs.fen);
  let loopOk = true;
  for (let i = 0; i < 12; i++) {
    await wait(120);
    const mover = serverChess.turn() === 'w' ? host : guest;
    const mv = pickMove(serverChess, i);
    mover.send({ type: 'move', move: { from: mv.from, to: mv.to, promotion: mv.promotion } });
    const a = await host.nextType('move');
    const b = await guest.nextType('move');
    const expected = new Chess(serverChess.fen());
    const res = expected.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
    const sameSan = a.san === res.san;
    const sameFen = a.fen === expected.fen();
    const sameMove = a.move.from === mv.from && a.move.to === mv.to;
    const sameBroadcast = b.san === a.san && b.fen === a.fen;
    if (!sameSan || !sameFen || !sameMove || !sameBroadcast) {
      loopOk = false;
      console.log(`  FAIL nước ${i}: sent=${JSON.stringify(mv)} got(san=${a.san} fen=${a.fen})`);
    }
    serverChess.move(res);
  }
  check('Game loop: 12 nước đều hợp lệ + broadcast khớp', loopOk);

  // 12) Sync lại sau game
  host.send({ type: 'sync_request' });
  msg = await host.nextType('sync');
  check('HOST: sync sau game khớp fen local', msg.fen === serverChess.fen(), `got=${msg.fen} want=${serverChess.fen()}`);
  check('HOST: sync history đủ nước', msg.history.length === 14, `len=${msg.history.length}`);

  // 13) Persistence: guest thoát rồi nối lại -> nhận ván dở
  console.log('\n-- Test reconnect/khôi phục ván --');
  const oldGuest = guest;
  oldGuest.close();
  msg = await host.nextType('peer_left');
  check('HOST: nhận peer_left khi guest thoát', msg.type === 'peer_left');

  const guest2 = new Bot('GUEST2', room, 'guest');
  await guest2.connect();
  msg = await guest2.nextType('joined');
  check('GUEST2: joined game != null', msg.game !== null, JSON.stringify(msg.game));
  check('GUEST2: fen khôi phục từ server', msg.game.fen === serverChess.fen(), `got=${msg.game.fen}`);
  check('GUEST2: history khôi phục', Array.isArray(msg.game.history) && msg.game.history.length === 14, `len=${msg.game.history.length}`);

  msg = await host.nextType('peer_joined');
  check('HOST: peer_joined khi guest nối lại', msg.type === 'peer_joined');

  // 14) Promotion: 1 ván scripted để tốt lên Hậu, verify server nhận promotion
  console.log('\n-- Test phong cấp (promotion) --');
  const pRoom = 'promo' + Date.now().toString(36);
  const pHost = new Bot('PHOST', pRoom, 'host');
  await pHost.connect();
  await pHost.nextType('joined');
  const pGuest = new Bot('PGUEST', pRoom, 'guest');
  await pGuest.connect();
  await pGuest.nextType('joined');
  await pHost.nextType('peer_joined');

  const seq = [
    ['w', 'h2', 'h4'], ['b', 'a7', 'a6'], ['w', 'h4', 'h5'], ['b', 'b7', 'b6'],
    ['w', 'h5', 'h6'], ['b', 'c7', 'c6'], ['w', 'h6', 'g7'], ['b', 'd7', 'd6'],
    ['w', 'g7', 'h8', 'q'],
  ];
  let promoFen = null;
  let promoOk = true;
  for (let i = 0; i < seq.length; i++) {
    await wait(120);
    const [col, from, to, promotion] = seq[i];
    const mover = col === 'w' ? pHost : pGuest;
    mover.send({ type: 'move', move: { from, to, promotion } });
    const a = await pHost.nextType('move');
    const b = await pGuest.nextType('move');
    if (a.san !== b.san || a.fen !== b.fen) promoOk = false;
    if (i === seq.length - 1) {
      check('Promotion: san = gxh8=Q', a.san === 'gxh8=Q', `san=${a.san}`);
      check('Promotion: broadcast khớp cả 2', a.san === b.san && a.fen === b.fen);
      promoFen = a.fen;
    }
  }
  check('Promotion: có Hậu trắng tại h8 trong fen', !!promoFen && promoFen.split(' ')[0].split('/')[0].endsWith('Q'), promoFen);
  pHost.close();
  pGuest.close();

  // 15) room-full: connection thứ 3
  console.log('\n-- Test room-full --');
  const third = new Bot('THIRD', room, 'guest');
  await third.connect();
  msg = await third.nextAnyOf(['room-full', '__closed__'], 8000);
  check('THIRD: phòng đầy được thông báo', msg.type === 'room-full', `got=${msg.type}`);
  if (msg.type === 'room-full') {
    msg = await third.nextType('__closed__', 5000);
    check('THIRD: server đóng socket sau room-full', msg.type === '__closed__', `got=${msg.type}`);
  }

  // 15) Rematch: cả 2 đồng ý -> server xóa ván
  console.log('\n-- Test rematch --');
  host.send({ type: 'rematch_accept' });
  guest2.send({ type: 'rematch_accept' });
  await wait(150);
  host.send({ type: 'sync_request' });
  msg = await host.nextType('sync');
  check('HOST: sync sau rematch = vị trí khởi đầu', msg.fen === new Chess().fen(), msg.fen);
  check('HOST: history rỗng sau rematch', Array.isArray(msg.history) && msg.history.length === 0, `len=${msg.history.length}`);

  // 16) Relay chat verbatim
  host.send({ type: 'chat', text: 'xin chào' });
  msg = await guest2.nextType('chat');
  check('GUEST2: nhận chat relay', msg.text === 'xin chào');

  host.close();
  guest2.close();

  console.log(`\n=== KẾT QUẢ: ${passed} PASS, ${failed} FAIL ===`);
  if (failed > 0) {
    console.log('FAIL:', failures.join(', '));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\nLỖI NGHIÊM TRỌNG:', err.message);
  process.exit(1);
});
