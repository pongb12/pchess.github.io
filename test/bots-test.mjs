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

  connect(opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(BASE);
      u.pathname = '/room';
      u.searchParams.set('code', this.room);
      u.searchParams.set('role', this.role);
      if (opts.reconnect) u.searchParams.set('reconnect', '1');
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
    for (;;) {
      if (this.pending && this.pending.length) {
        const m = this.pending.shift();
        if (m.type === type) return m;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${this.name}: timeout waiting ${type}`);
      const m = await this.next(remaining);
      if (m.type === type) return m;
      if (m.type === '__closed__') throw new Error(`${this.name}: closed before ${type}`);
      (this.pending = this.pending || []).push(m);
    }
  }

  async nextAnyOf(types, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.pending && this.pending.length) {
        const m = this.pending.shift();
        if (types.includes(m.type)) return m;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${this.name}: timeout waiting ${types.join('/')}`);
      const m = await this.next(remaining);
      if (types.includes(m.type)) return m;
      if (m.type === '__closed__') throw new Error(`${this.name}: closed before ${types.join('/')}`);
      (this.pending = this.pending || []).push(m);
    }
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
  msg = await third.nextType('room-full', 8000);
  check('THIRD: phòng đầy được thông báo', msg.type === 'room-full', `got=${msg.type}`);

  // Giống handleRoomFull: client tự đóng socket của mình
  third.close();
  await wait(300);

  // Verify phòng KHÔNG bị socket thứ 3 làm hỏng: guest2 rời -> guest3 vào vẫn được
  console.log('-- Verify phòng không bị socket thứ 3 làm hỏng --');
  guest2.close();
  await host.nextType('peer_left');
  const guest3 = new Bot('GUEST3', room, 'guest');
  await guest3.connect();
  msg = await guest3.nextType('joined', 8000);
  check('GUEST3: vào phòng bình thường (không bị room-full)', msg.type === 'joined' && msg.role === 'guest', `got=${msg.type}`);

  // 16) Rematch: cả 2 đồng ý -> server xóa ván
  console.log('\n-- Test rematch --');
  host.send({ type: 'rematch_accept' });
  guest3.send({ type: 'rematch_accept' });
  await wait(150);
  host.send({ type: 'sync_request' });
  msg = await host.nextType('sync');
  check('HOST: sync sau rematch = vị trí khởi đầu', msg.fen === new Chess().fen(), msg.fen);
  check('HOST: history rỗng sau rematch', Array.isArray(msg.history) && msg.history.length === 0, `len=${msg.history.length}`);

  // 17) Relay chat verbatim
  host.send({ type: 'chat', text: 'xin chào' });
  msg = await guest3.nextType('chat');
  check('GUEST3: nhận chat relay', msg.text === 'xin chào');

  host.close();
  guest3.close();

  // 18) Mobile reconnect: đóng rồi nối lại NGAY với reconnect=1 (mô phỏng
  //     mobile để nền/đổi mạng). Socket cũ có thể chưa được server dọn nên phòng
  //     tưởng "đầy" -> server phải kick socket cũ thay vì từ chối.
  console.log('\n-- Test mobile reconnect (reconnect=1, nối lại ngay) --');
  const mRoom = 'mobile' + Date.now().toString(36);
  const mHost = new Bot('MHOST', mRoom, 'host');
  await mHost.connect();
  await mHost.nextType('joined');
  const mGuest = new Bot('MGUEST', mRoom, 'guest');
  await mGuest.connect();
  await mGuest.nextType('joined');
  await mHost.nextType('peer_joined');

  mHost.send({ type: 'move', move: { from: 'e2', to: 'e4' } });
  const mh = await mHost.nextType('move');
  await mGuest.nextType('move');
  check('Mobile: host đi e4', mh.san === 'e4');

  // Đóng socket rồi nối lại ngay (không chờ server dọn close)
  mGuest.close();
  const mGuest2 = new Bot('MGUEST2', mRoom, 'guest');
  await mGuest2.connect({ reconnect: true });
  msg = await mGuest2.nextType('joined', 8000);
  check('Mobile: nối lại nhận joined (không bị room-full)', msg.type === 'joined', `got=${msg.type}`);
  check('Mobile: ván dở khôi phục', msg.game && msg.game.fen === mh.fen, `fen=${msg.game && msg.game.fen}`);
  msg = await mHost.nextType('peer_joined');
  check('Mobile: host nhận peer_joined', msg.type === 'peer_joined');

  // 19) Resign + draw relay sau reconnect
  console.log('\n-- Test relay resign / draw --');
  mHost.send({ type: 'draw_offer' });
  msg = await mGuest2.nextType('draw_offer');
  check('Mobile: guest nhận draw_offer', msg.type === 'draw_offer');

  mGuest2.send({ type: 'draw_accept' });
  msg = await mHost.nextType('draw_accept');
  check('Mobile: host nhận draw_accept', msg.type === 'draw_accept');

  mHost.send({ type: 'resign' });
  msg = await mGuest2.nextType('resign');
  check('Mobile: guest nhận resign', msg.type === 'resign');

  // 20) Same-role reconnect kick: host nối lại reconnect=1 kick socket host cũ
  console.log('\n-- Test same-role reconnect (kick socket cũ) --');
  const kRoom = 'kick' + Date.now().toString(36);
  const kHost = new Bot('KHOST', kRoom, 'host');
  await kHost.connect();
  await kHost.nextType('joined');
  const kGuest = new Bot('KGUEST', kRoom, 'guest');
  await kGuest.connect();
  await kGuest.nextType('joined');
  await kHost.nextType('peer_joined');

  const kHost2 = new Bot('KHOST2', kRoom, 'host');
  await kHost2.connect({ reconnect: true });
  msg = await kHost2.nextType('joined', 8000);
  check('Kick: host nối lại nhận joined', msg.type === 'joined', `got=${msg.type}`);
  msg = await kHost.nextAnyOf(['session-takeover', '__closed__', 'room-full'], 8000);
  check('Kick: socket host cũ bị thông báo session-takeover', msg.type === 'session-takeover', `got=${msg.type}`);
  kHost2.send({ type: 'move', move: { from: 'e2', to: 'e4' } });
  msg = await kGuest.nextType('move');
  check('Kick: host mới đi được (e4 broadcast)', msg.san === 'e4', `got=${msg.san}`);
  let oldInert = false;
  try {
    kHost.send({ type: 'move', move: { from: 'e7', to: 'e5' } });
    msg = await kHost.nextType('move_rejected');
    oldInert = msg.reason === 'not_your_turn';
  } catch (e) {
    // Socket cũ có thể đã bị đóng sạch (close frame tới) hoặc không -> miễn là
    // không còn đi được nước là đạt yêu cầu.
    oldInert = /ws not open|closed|timeout/i.test(String((e && e.message) || e));
  }
  check('Kick: socket cũ bị vô hiệu (đóng hoặc not_your_turn)', oldInert);

  mHost.close();
  mGuest2.close();
  kHost2.close();
  kGuest.close();

  // 21) Vai trò theo khai báo (không phải first-free-slot): guest vào TRƯỚC vẫn
  //     là guest, host vào sau vẫn là host; cả 2 đều nhận peer_joined để ván
  //     bắt đầu được dù thứ tự vào phòng ngược.
  console.log('\n-- Test vai trò theo khai báo (guest vào trước host) --');
  const rRoom = 'role' + Date.now().toString(36);
  const rGuest = new Bot('RGUEST', rRoom, 'guest');
  await rGuest.connect();
  msg = await rGuest.nextType('joined');
  check('Vai trò: guest vào trước nhận role=guest', msg.role === 'guest', `got=${msg.role}`);
  check('Vai trò: guest nhận color=b', msg.color === 'b', `got=${msg.color}`);

  const rHost = new Bot('RHOST', rRoom, 'host');
  await rHost.connect();
  msg = await rHost.nextType('joined');
  check('Vai trò: host vào sau nhận role=host', msg.role === 'host', `got=${msg.role}`);
  check('Vai trò: host nhận color=w', msg.color === 'w', `got=${msg.color}`);
  msg = await rHost.nextType('peer_joined');
  check('Vai trò: host nhận peer_joined dù vào sau', msg.type === 'peer_joined');
  msg = await rGuest.nextType('peer_joined');
  check('Vai trò: guest nhận peer_joined khi host vào', msg.type === 'peer_joined');

  // Host gửi init -> guest: mô phỏng host bắt đầu ván (bình thường do handlePeerJoined)
  rHost.send({ type: 'init', color: 'b', settings: {}, fen: new Chess().fen() });
  msg = await rGuest.nextType('init');
  check('Vai trò: guest nhận init từ host', msg.type === 'init');

  // Host thứ 3 khai 'host' (không reconnect) khi slot host đầy -> room-full
  const rHost3 = new Bot('RHOST3', rRoom, 'host');
  await rHost3.connect();
  msg = await rHost3.nextAnyOf(['room-full', 'joined'], 8000);
  check('Vai trò: host thứ 3 bị room-full (không chiếm chỗ)', msg.type === 'room-full', `got=${msg.type}`);
  rHost3.close();

  // Host thoát: slot host trống NHƯNG guest vẫn đang chiếm slot guest -> guest
  // mới cũng phải room-full, không bị đẩy lên thành host.
  rHost.close();
  await wait(300);
  const rGuest2 = new Bot('RGUEST2', rRoom, 'guest');
  await rGuest2.connect();
  msg = await rGuest2.nextAnyOf(['room-full', 'joined'], 8000);
  check('Vai trò: guest thứ 2 bị room-full dù slot host trống', msg.type === 'room-full', `got=${msg.type}`);
  rGuest2.close();
  rGuest.close();

  // 22) DO "ngủ đông" (hibernation): sau ~30s không có I/O, Cloudflare xoá bộ
  //     nhớ trong của Durable Object nhưng GIỮ các socket WebSocket. Trước đây
  //     trạng thái phòng (this.slots) bị reset nên khi guest vào SAU host đã chờ
  //     lâu, server không gửi peer_joined -> ván không bao giờ bắt đầu (đúng bug
  //     khi chơi 2 thiết bị khác nhau: host chờ, thiết bị thứ 2 mở link). Giờ
  //     tìm socket qua tag (ctx.getWebSockets(role)) nên phải hoạt động sau ngủ đông.
  console.log('\n-- Test DO hibernation (host chờ lâu, guest vào sau) --');
  const hRoom = 'hib' + Date.now().toString(36);
  const hHost = new Bot('HHOST', hRoom, 'host');
  await hHost.connect();
  msg = await hHost.nextType('joined');
  check('Hibernation: host nhận joined', msg.role === 'host', `got=${msg.role}`);
  console.log('  ... chờ 40s để DO ngủ đông ...');
  await wait(40000);
  const hGuest = new Bot('HGUEST', hRoom, 'guest');
  await hGuest.connect();
  msg = await hGuest.nextType('joined');
  check('Hibernation: guest vào sau nhận joined', msg.role === 'guest', `got=${msg.role}`);
  msg = await hHost.nextType('peer_joined');
  check('Hibernation: host nhận peer_joined sau ngủ đông', msg.type === 'peer_joined');
  msg = await hGuest.nextType('peer_joined');
  check('Hibernation: guest nhận peer_joined sau ngủ đông', msg.type === 'peer_joined');
  // Host gửi init -> guest: bình thường do handlePeerJoined trên host.
  hHost.send({ type: 'init', color: 'b', settings: {}, fen: new Chess().fen() });
  msg = await hGuest.nextType('init');
  check('Hibernation: init relay qua socket của host được giữ qua ngủ đông', msg.type === 'init');
  hHost.send({ type: 'move', move: { from: 'e2', to: 'e4' } });
  msg = await hGuest.nextType('move');
  check('Hibernation: move từ host broadcast', msg.san === 'e4', `got=${msg.san}`);
  await hHost.nextType('move'); // host cũng nhận bản broadcast e4 của chính mình
  hGuest.send({ type: 'move', move: { from: 'e7', to: 'e5' } });
  msg = await hHost.nextType('move');
  check('Hibernation: move từ guest relay tới host', msg.san === 'e5', `got=${msg.san}`);
  hHost.close();
  hGuest.close();

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
