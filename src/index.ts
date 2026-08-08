import { DurableObject } from 'cloudflare:workers';
import { Chess } from '../lib/chess.js';

interface Env {
  PCHESS_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  // Optional: event signing secret. Falls back to a per-room derived key when not
  // configured (still better than nothing — client cannot forge without knowing
  // the room code, which it already knows, but at least the signature proves the
  // event was generated server-side for THIS room).
  EVENT_SIGNING_SECRET?: string;
}

const ROOM_CODE_RE = /^[A-Za-z0-9]{1,20}$/;
const MAX_MSG_LEN = 4096;
// Chống spam theo TỪNG người chơi: cùng một socket không được gửi nước đi liên
// tiếp cách nhau dưới ngưỡng này. Trước đây giới hạn là chung phòng (khoảng cách
// giữa nước của 2 người) nên ván nhanh (1-3 phút) bị nhầm là spam khi đối thủ
// trả lời nhanh. Per-socket thì người thật không bao giờ đi 2 nước trong 100ms
// (lượt luân phiên) -> chỉ chặn được flood script.
const MOVE_RATE_LIMIT_MS = 100;
// Cảnh báo nếu một socket gửi quá nhiều nước đi hợp lệ trong 1 giây (bất khả
// thi với người thật vì lượt đi luân phiên) -> chỉ chặn flood script.
const MOVE_BURST_MAX = 5;
const MOVE_BURST_WINDOW_MS = 1000;
const PROMOTION_TYPES = ['q', 'r', 'b', 'n'];

// Anti-cheat: reconnection / room-creation rate limit theo IP.
// Một IP tạo quá nhiều phòng hoặc reconnect quá nhiều lần trong ngắn hạn là dấu
// hiệu của botnet /扫描. Chỉ chặn ở tầng tạo phòng (fetch /room) — không chặn
// trong game vì người thật cũng có thể mạng yếu và WS rớt liên tục.
const IP_ROOM_CREATE_MAX = 20;
const IP_ROOM_CREATE_WINDOW_MS = 60_000;
const IP_RECONNECT_MAX = 30;
const IP_RECONNECT_WINDOW_MS = 60_000;

// Audit log: tối đa bao nhiêu entry giữ lại trong storage (đủ để review sau).
const AUDIT_LOG_MAX = 500;

// Engine-like heuristic thresholds (server-side, dựa trên audit log).
// Không chạy Stockfish ở server (tốn CPU), chỉ flag các pattern bất thường:
// - Move times quá đều (std deviation < 50ms) -> auto-player
// - Move times quá nhanh (< 200ms) cho nhiều nước liên tiếp -> engine pre-computed
// - Move times quá chậm (> 60s) cho nhiều nước -> tab-switch / consulting engine
const SUSPECT_FAST_MOVE_MS = 200;
const SUSPECT_FAST_STREAK = 4;
const SUSPECT_UNIFORM_STDDEV_MS = 50;
const SUSPECT_UNIFORM_MIN_MOVES = 8;

type Role = 'host' | 'guest';
const ROLES: Role[] = ['host', 'guest'];

function colorOfRole(role: Role): 'w' | 'b' {
  return role === 'host' ? 'w' : 'b';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}

// IP rate limit state — lưu tạm trong module-level Map (chia sẻ giữa các
// request trong cùng isolate). Khi worker isolate bị recycle thì reset — chấp
// nhận được vì chỉ là tầng chống flood, không phải security critical.
interface IpBucket {
  count: number;
  firstAt: number;
}
const ipRoomCreateBuckets = new Map<string, IpBucket>();
const ipReconnectBuckets = new Map<string, IpBucket>();

function ipAllowed(map: Map<string, IpBucket>, ip: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = map.get(ip);
  if (!bucket || now - bucket.firstAt > windowMs) {
    map.set(ip, { count: 1, firstAt: now });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

function clientIp(request: Request): string {
  // Cloudflare đặt CF-Connecting-IP cho mọi request.
  const cf = (request as Request & { cf?: { ip?: string } }).cf;
  if (cf?.ip) return cf.ip;
  const h = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || 'unknown';
  return h;
}

// HMAC-SHA256 cho signed events. Cloudflare Workers có Web Crypto.
async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  // hex
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Lấy signing key cho room. Ưu tiên biến môi trường, fallback về room-code-derived
// (không an toàn bằng nhưng ít nhất signature gắn với room).
async function signingKey(env: Env, roomCode: string): Promise<string> {
  if (env.EVENT_SIGNING_SECRET) return env.EVENT_SIGNING_SECRET;
  // Fallback: hash room code để tạo per-room key. Vẫn phải biết room code để giả mạo
  // (người chơi đã biết room code nên đây chỉ là chống giả mạo cross-room).
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pchess:' + roomCode));
  return 'rk:' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signEvent(env: Env, roomCode: string, payload: unknown): Promise<string> {
  const msg = JSON.stringify(payload);
  const key = await signingKey(env, roomCode);
  return await hmacSign(key, msg);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true });
    }
    if (url.pathname === '/room') {
      const code = (url.searchParams.get('code') || '').trim();
      if (!ROOM_CODE_RE.test(code)) {
        return json({ error: 'invalid_room_code' }, 400);
      }

      // IP rate limit: chống flood tạo phòng / connect.
      const ip = clientIp(request);
      const isReconnect = url.searchParams.get('reconnect') === '1';
      const allowed = isReconnect
        ? ipAllowed(ipReconnectBuckets, ip, IP_RECONNECT_MAX, IP_RECONNECT_WINDOW_MS)
        : ipAllowed(ipRoomCreateBuckets, ip, IP_RECONNECT_MAX, IP_RECONNECT_WINDOW_MS);
      if (!allowed) {
        return json({ error: 'rate_limited' }, 429);
      }

      const id = env.PCHESS_ROOM.idFromName(code.toLowerCase());
      const stub = env.PCHESS_ROOM.get(id);
      // Truyền IP + signing secret vào DO qua header (DO fetch là internal).
      const headers = new Headers(request.headers);
      headers.set('X-PChess-IP', ip);
      if (env.EVENT_SIGNING_SECRET) headers.set('X-PChess-Signing-Secret', env.EVENT_SIGNING_SECRET);
      return stub.fetch(new Request(request, { headers }));
    }

    // ===== Server-side analysis endpoint =====
    // Client gửi PGN (hoặc list of moves SAN), server gọi Lichess API cho mỗi
    // position, trả về JSON có eval + multi-PV + opening name sẵn. Tránh tải
    // Stockfish WASM 108MB trên browser.
    if (url.pathname === '/api/analyze') {
      return handleAnalyze(request, env);
    }

    // Static assets fallback — defensive: nếu env.ASSETS undefined (do deploy issue),
    // trả về 500 với message rõ ràng thay vì crash.
    if (!env.ASSETS) {
      return json({ error: 'assets_binding_missing', message: 'Static assets binding not configured. Check wrangler.toml [assets] section.' }, 500);
    }
    const staticPath = /^\/(index\.html|css\/|js\/|stockfish\/|assets\/)/.test(url.pathname) ? url.pathname : '/';
    return env.ASSETS.fetch(new Request(new URL(staticPath, request.url), request));
  },
};

// ===== Server-side analysis: gọi Lichess Cloud Eval API =====
// Lichess API miễn phí, có multi-PV + opening name + depth ~30.
// Rate limit: ~60 req/min (unauth). Cho post-game analysis (~20-60 positions)
// thì cần batch + cache.
//
// Cache: dùng Cloudflare KV (nếu có binding ANALYSIS_CACHE) hoặc in-memory Map
// (per-isolate, không persistent). Hiện dùng in-memory để đơn giản.
const analysisCache = new Map<string, unknown>();

interface LichessEval {
  fen: string;
  knodes: number;
  depth: number;
  pvs: Array<{ moves: string; cp: number | null; mate: number | null }>;
  opening?: { eco: string; name: string };
}

async function lichessEval(fen: string, multiPv = 3): Promise<LichessEval | null> {
  const cacheKey = fen + '|' + multiPv;
  const cached = analysisCache.get(cacheKey);
  if (cached) return cached as LichessEval;

  // Endpoint đúng: /api/cloud-eval (không phải /api/eval — cái đó 404)
  const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`;
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'PChess/1.0 (https://github.com/pongb12/pchess.github.io)',
        'Accept': 'application/json',
      },
    });
    // Lichess cloud-eval có thể trả về 404 cho FEN không hợp lệ hoặc position hiếm
    if (!resp.ok) {
      console.log(`[lichessEval] fen=${fen.substring(0,30)} status=${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as LichessEval;
    analysisCache.set(cacheKey, data);
    return data;
  } catch (e) {
    console.log(`[lichessEval] exception: ${(e as Error).message}`);
    return null;
  }
}

async function handleAnalyze(request: Request, _env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  let body: { pgn?: string; moves?: string[] };
  try {
    body = await request.json() as { pgn?: string; moves?: string[] };
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  // Parse PGN hoặc nhận list of SAN moves
  const chess = new Chess();
  if (body.pgn) {
    try {
      chess.load_pgn(body.pgn);
    } catch (e) {
      return json({ error: 'invalid_pgn', message: (e as Error).message }, 400);
    }
  } else if (Array.isArray(body.moves) && body.moves.length) {
    try {
      for (const san of body.moves) {
        chess.move(san);
      }
    } catch (e) {
      return json({ error: 'invalid_moves', message: (e as Error).message }, 400);
    }
  } else {
    return json({ error: 'missing_pgn_or_moves' }, 400);
  }

  const history = chess.history();

  // Sinh list of FEN cho mỗi position (ply 0 = vị trí ban đầu, ply N = sau nước thứ N)
  const fens: Array<{ ply: number; fen: string }> = [];
  const tempChess = new Chess();
  fens.push({ ply: 0, fen: tempChess.fen() });
  for (const san of history) {
    try {
      tempChess.move(san);
    } catch (e) {
      break;
    }
    fens.push({ ply: fens.length, fen: tempChess.fen() });
  }

  // Batch gọi Lichess API (5 requests song song để tránh rate limit)
  const BATCH_SIZE = 5;
  const positions: Array<{
    ply: number;
    fen: string;
    eval?: { score: { type: string; value: number }; pv: string[]; depth: number };
    multipv?: Array<{ score: { type: string; value: number }; pv: string[]; depth: number }>;
    opening?: { eco: string; name: string };
    error?: string;
  }> = [];

  for (let i = 0; i < fens.length; i += BATCH_SIZE) {
    const batch = fens.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async ({ ply, fen }) => {
        const eval_ = await lichessEval(fen, 3);
        if (!eval_) {
          return { ply, fen, error: 'lichess_unavailable' };
        }

        // Convert UCI moves sang SAN bằng chess.js (replay từ FEN)
        const convertLine = (line: { moves: string; cp: number | null; mate: number | null }) => {
          const ch = new Chess();
          ch.load(fen);
          const sans: string[] = [];
          const ucis = line.moves.trim().split(/\s+/);
          for (const u of ucis) {
            if (u.length < 4) break;
            try {
              const mv = ch.move({
                from: u.slice(0, 2),
                to: u.slice(2, 4),
                promotion: u.length > 4 ? u[4] : undefined,
              });
              if (mv) sans.push(mv.san);
              else break;
            } catch {
              break;
            }
          }
          const score = line.mate != null
            ? { type: 'mate', value: line.mate }
            : { type: 'cp', value: line.cp ?? 0 };
          return { score, pv: sans, depth: eval_.depth };
        };

        const multipv = (eval_.pvs || []).map(convertLine);
        const top = multipv[0] || { score: { type: 'cp', value: 0 }, pv: [], depth: 0 };

        return {
          ply,
          fen,
          eval: top,
          multipv,
          opening: eval_.opening,
        };
      })
    );
    positions.push(...batchResults);
  }

  return json({
    ok: true,
    moves: history,
    positions,
    cached: positions.filter((p) => !p.error).length,
    errors: positions.filter((p) => p.error).length,
  });
}


interface GameState {
  fen: string;
  history: string[];
  // Audit trail: timestamp của mỗi nước đi (ms epoch), dùng cho anti-cheat heuristic.
  moveTimestamps: number[];
  startedAt: number;
}

interface RematchState {
  // State machine rõ ràng thay vì chỉ Set<Role>:
  //   'idle'                       -> chưa có yêu cầu
  //   'requested'                  -> một bên đã yêu cầu, chờ bên kia đồng ý
  //   'accepted_by_host'           -> host đã accept (guest request trước đó)
  //   'accepted_by_guest'          -> guest đã accept (host request trước đó)
  //   'declined'                   -> một bên đã từ chối
  // Chỉ reset game khi state đạt 'accepted_by_both'.
  status: 'idle' | 'requested' | 'accepted_by_host' | 'accepted_by_guest' | 'accepted_by_both' | 'declined';
  requestedBy: Role | null;
  acceptedBy: Role[];
  requestedAt: number | null;
}

interface AuditEntry {
  t: number; // timestamp
  type: string; // 'move' | 'join' | 'leave' | 'reconnect' | 'takeover' | 'rematch_*' | 'resign' | 'draw_*' | 'game_over' | 'cheat_flag'
  role?: Role;
  detail?: unknown;
}

interface CheatFlag {
  role: Role;
  reason: string;
  at: number;
  detail?: unknown;
}

export class PChessRoom extends DurableObject<Env> {
  // Trạng thái chống spam theo socket. QUAN TRỌNG: bộ nhớ trong bị xoá sạch khi
  // Durable Object "ngủ đông" (hibernation) — nên mọi trạng thái phòng PHẢI lấy
  // từ runtime (ctx.getWebSockets/getTags) hoặc ctx.storage, không được giữ ở
  // thuộc tính. Hai Map này chỉ chống flood tạm thời, reset khi ngủ đông cũng
  // chấp nhận được (ván cờ được lưu trong ctx.storage, không bị ảnh hưởng).
  private lastMoveAt = new Map<WebSocket, number>();
  private moveCounts = new Map<WebSocket, number[]>();

  // Tìm socket còn mở theo vai trò. getWebSockets(role) hoạt động ngay cả sau
  // khi DO ngủ đông: runtime giữ các socket, chỉ bộ nhớ trong bị reset. Không
  // dùng mảng slot trong bộ nhớ — trước đây nó biến mất sau khi ngủ đông nên
  // đối thủ "không còn ở đó" và không ai nhận được peer_joined (ván không bắt đầu).
  private socketOf(role: Role): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(role)) {
      if (ws.readyState === WebSocket.OPEN) return ws;
    }
    return null;
  }

  private roleOf(ws: WebSocket): Role | null {
    try {
      const tags = this.ctx.getTags(ws);
      for (const role of ROLES) {
        if (tags.includes(role)) return role;
      }
    } catch {
      /* socket không còn được theo dõi */
    }
    return null;
  }

  private opponent(ws: WebSocket): WebSocket | null {
    const role = this.roleOf(ws);
    if (!role) return null;
    return this.socketOf(role === 'host' ? 'guest' : 'host');
  }

  private colorOf(ws: WebSocket): 'w' | 'b' | null {
    const role = this.roleOf(ws);
    return role ? colorOfRole(role) : null;
  }

  private roomCode(): string {
    // Tên DO = room code lowercased (xem idFromName ở default.fetch).
    return this.ctx.name || 'unknown';
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return json({ ok: true, players: this.ctx.getWebSockets().length });
    }

    const url = new URL(request.url);
    const claimedRole: Role = url.searchParams.get('role') === 'guest' ? 'guest' : 'host';
    const isReconnect = url.searchParams.get('reconnect') === '1';

    // Lưu signing secret từ header (set bởi default.fetch). Không lưu trên this
    // vì hibernate — lưu qua tag của WS hoặc đọc lại mỗi lần từ storage.
    const signingSecret = request.headers.get('X-PChess-Signing-Secret') || null;
    const clientIp = request.headers.get('X-PChess-IP') || 'unknown';

    // Socket cũ cùng vai trò vẫn còn (tìm qua tag — hoạt động cả sau ngủ đông).
    const existing = this.socketOf(claimedRole);

    // KẾT NỐI LẠI (client gửi reconnect=1): đá socket cũ cùng vai trò để nhường
    // chỗ. Người VÀO MỚI không được đá — tránh bị chiếm chỗ.
    // Lưu ý: close() phía server KHÔNG gửi close frame tới client (giới hạn của
    // Cloudflare WebSocketPair), nên phải gửi 'session-takeover' trước để client
    // cũ biết phiên đã bị thay thế.
    if (existing && isReconnect) {
      try {
        existing.send(JSON.stringify({ type: 'session-takeover' }));
      } catch {
        /* ignore */
      }
      try {
        existing.close(4000, 'reconnect');
      } catch {
        /* ignore */
      }
      await this.appendAudit({ t: Date.now(), type: 'takeover', role: claimedRole, detail: { ip: clientIp } });
    }

    if (existing && !isReconnect) {
      // Vai trò này đã có người -> phòng đầy. Dùng tag riêng 'roomfull' để
      // không làm nhiễu việc tìm socket chơi thật (host/guest).
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ['roomfull']);
      // send() ngay trong fetch bị drop vì handshake client chưa xong -> hoãn lại.
      setTimeout(() => {
        try {
          pair[1].send(JSON.stringify({ type: 'room-full' }));
          pair[1].close();
        } catch {
          /* ignore */
        }
      }, 100);
      await this.appendAudit({ t: Date.now(), type: 'room_full_attempt', role: claimedRole, detail: { ip: clientIp } });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const color = colorOfRole(claimedRole);
    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [claimedRole]);

    // Gắn signing secret + IP vào WS info (dùng serializeAttachment nếu có).
    // Cloudflare: WebSocket không có thuộc tính tùy chỉnh, nhưng ta có thể đọc
    // lại từ env khi cần trong webSocketMessage. Lưu secret vào storage nếu cần.
    if (signingSecret) {
      await this.ctx.storage.put('signing_secret', signingSecret);
    }
    if (clientIp && clientIp !== 'unknown') {
      // Ghi lại IP cuối của role — cho audit / review sau.
      const ips = (await this.ctx.storage.get<Record<Role, string>>('ips')) || { host: '', guest: '' };
      ips[claimedRole] = clientIp;
      await this.ctx.storage.put('ips', ips);
    }

    // Gửi trạng thái trò chơi đang dở để client nối lại ván (server-authoritative)
    const game = await this.ctx.storage.get<GameState>('game');
    const rematch = await this.ctx.storage.get<RematchState>('rematch');

    // Sign các event critical (joined + sync) để client verify.
    const joinedPayload = {
      type: 'joined',
      role: claimedRole,
      color,
      game: game || null,
      rematch: rematch || null,
      reconnect: isReconnect,
      ts: Date.now(),
    };
    const joinedSig = await this.signPayload(joinedPayload);
    server.send(JSON.stringify({ ...joinedPayload, sig: joinedSig }));

    // Nếu reconnect + có game, gửi luôn sync banner thông báo "đang khôi phục".
    if (isReconnect && game) {
      try {
        server.send(JSON.stringify({ type: 'sync_banner', state: 'restoring', ts: Date.now() }));
      } catch {
        /* ignore */
      }
      // Auto-sync ngay khi WS mở lại — server chủ động gửi full state, không đợi client.
      const { chess, history } = await this.loadGame();
      const captured = this.deriveCaptured(history);
      const syncPayload = {
        type: 'sync',
        fen: chess.fen(),
        history,
        captured,
        turn: chess.turn(),
        ts: Date.now(),
        source: 'reconnect',
      };
      const syncSig = await this.signPayload(syncPayload);
      server.send(JSON.stringify({ ...syncPayload, sig: syncSig }));
    }

    const peer = this.socketOf(claimedRole === 'host' ? 'guest' : 'host');
    if (peer) {
      try {
        peer.send(JSON.stringify({ type: 'peer_joined' }));
      } catch {
        /* ignore */
      }
      // Báo cho cả người vừa vào: nhờ đó host vào SAU guest vẫn nhận peer_joined
      // để gửi 'init' và bắt đầu ván (thứ tự vào phòng không quan trọng).
      try {
        server.send(JSON.stringify({ type: 'peer_joined' }));
      } catch {
        /* ignore */
      }
    }

    await this.appendAudit({ t: Date.now(), type: isReconnect ? 'reconnect' : 'join', role: claimedRole, detail: { ip: clientIp } });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let msg: { type?: string; [k: string]: unknown };
    try {
      if (typeof message !== 'string' || message.length > MAX_MSG_LEN) return;
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    const type = msg.type;

    if (type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp || Date.now() }));
      return;
    }
    if (type === 'move') {
      await this.handleMove(ws, msg);
      return;
    }
    if (type === 'sync_request') {
      await this.sendAuthoritativeSync(ws);
      return;
    }
    if (type === 'rematch_request') {
      await this.handleRematchRequest(ws);
      return;
    }
    if (type === 'rematch_accept') {
      await this.handleRematchAccept(ws);
      return;
    }
    if (type === 'rematch_decline') {
      await this.handleRematchDecline(ws);
      return;
    }

    // Audit các event quan trọng (resign / draw_* / game_over) — không log chat
    // để tránh bloat storage.
    if (type === 'resign' || type === 'draw_offer' || type === 'draw_accept' || type === 'draw_decline' || type === 'game_over') {
      const role = this.roleOf(ws);
      await this.appendAudit({ t: Date.now(), type, role: role || undefined, detail: msg });
    }

    // Relay tin nhắn giữa 2 người (resign, draw_*, rematch_*, game_over, chat,
    // sync, init...). Nếu slot đối thủ bị lệch, thử tất cả socket còn sống.
    // Sign các event critical (game_over, draw_accept) để client verify.
    if (type === 'game_over' || type === 'draw_accept') {
      const sig = await this.signPayload(msg);
      msg = { ...msg, sig };
    }
    this.relayToPeer(ws, msg);
  }

  async webSocketClose(ws: WebSocket) {
    this.lastMoveAt.delete(ws);
    this.moveCounts.delete(ws);
    const role = this.roleOf(ws);
    const other = this.opponent(ws);
    if (other) {
      try {
        // Tách biệt rõ: đây là "peer_left" (đối thủ rời phòng) chứ không phải
        // mất mạng tạm thời. Client sẽ tự dùng heartbeat/reconnect để phân biệt.
        other.send(JSON.stringify({ type: 'peer_left', reason: 'disconnect', ts: Date.now() }));
      } catch {
        /* ignore */
      }
    }
    if (role) {
      await this.appendAudit({ t: Date.now(), type: 'leave', role });
    }
  }

  async webSocketError(ws: WebSocket) {
    ws.close(1011, 'error');
  }

  private relayToPeer(ws: WebSocket, msg: unknown) {
    const data = JSON.stringify(msg);
    const other = this.opponent(ws);
    if (other) {
      try {
        other.send(data);
        return;
      } catch {
        /* rơi xuống broadcast */
      }
    }
    for (const s of this.ctx.getWebSockets()) {
      if (s !== ws && s.readyState === WebSocket.OPEN) {
        try {
          s.send(data);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private broadcast(obj: unknown) {
    const data = JSON.stringify(obj);
    for (const s of this.ctx.getWebSockets()) {
      try {
        s.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  private async signingSecret(): Promise<string> {
    // Ưu tiên secret từ storage (đã được set ở fetch), fallback per-room key.
    const stored = await this.ctx.storage.get<string>('signing_secret');
    if (stored) return stored;
    return 'rk:' + this.roomCode();
  }

  private async signPayload(payload: unknown): Promise<string> {
    const key = await this.signingSecret();
    const msg = JSON.stringify(payload);
    return await hmacSign(key, msg);
  }

  private async loadGame(): Promise<{ chess: Chess; history: string[]; moveTimestamps: number[]; startedAt: number }> {
    const saved = await this.ctx.storage.get<GameState>('game');
    const chess = new Chess();
    const history: string[] = saved?.history || [];
    const moveTimestamps: number[] = saved?.moveTimestamps || [];
    const startedAt: number = saved?.startedAt || Date.now();
    if (saved?.fen) {
      try {
        chess.load(saved.fen);
      } catch {
        /* fen không hợp lệ */
      }
    }
    return { chess, history, moveTimestamps, startedAt };
  }

  private async handleMove(ws: WebSocket, msg: { move?: { from?: string; to?: string; promotion?: string } }) {
    const move = msg.move;
    const reject = (reason: string) => {
      try {
        ws.send(JSON.stringify({ type: 'move_rejected', move: move || null, reason, ts: Date.now() }));
      } catch {
        /* ignore */
      }
    };

    if (!move || typeof move.from !== 'string' || typeof move.to !== 'string') {
      reject('malformed');
      return;
    }

    const { chess, history, moveTimestamps, startedAt } = await this.loadGame();

    const color = this.colorOf(ws);
    if (!color || color !== chess.turn()) {
      reject('not_your_turn');
      return;
    }

    // Chống spam theo từng socket: người chơi hợp lệ chỉ có thể đi khi tới lượt,
    // nên cùng socket gửi nước đi nhanh liên tục là flood script.
    const now = Date.now();
    if (now - (this.lastMoveAt.get(ws) ?? 0) < MOVE_RATE_LIMIT_MS) {
      reject('rate_limit');
      return;
    }
    this.lastMoveAt.set(ws, now);
    const counts = (this.moveCounts.get(ws) ?? []).filter((t) => now - t < MOVE_BURST_WINDOW_MS);
    counts.push(now);
    this.moveCounts.set(ws, counts);
    if (counts.length > MOVE_BURST_MAX) {
      reject('rate_limit');
      return;
    }

    const promotion = PROMOTION_TYPES.includes(move.promotion || '') ? move.promotion! : undefined;
    let result: { san: string } | null = null;
    try {
      result = chess.move({ from: move.from, to: move.to, promotion });
    } catch {
      result = null;
    }
    if (!result) {
      reject('illegal');
      return;
    }

    history.push(result.san);
    moveTimestamps.push(now);

    // Anti-cheat heuristic (audit-only, không chặn realtime): flag các pattern
    // bất thường dựa trên move timestamps. Server không chạy Stockfish nhưng có
    // thể flag "behavior" để review sau.
    const role = this.roleOf(ws);
    if (role) {
      await this.runAntiCheatHeuristic(role, moveTimestamps, history.length);
    }

    // Reset rematch state khi có nước đi mới (nếu ván đã kết thúc mà vẫn có
    // nước đi -> hiếm nhưng đề phòng).
    await this.ctx.storage.delete('rematch');
    await this.ctx.storage.put('game', {
      fen: chess.fen(),
      history,
      moveTimestamps,
      startedAt,
    } satisfies GameState);

    await this.appendAudit({
      t: now,
      type: 'move',
      role: role || undefined,
      detail: { san: result.san, from: move.from, to: move.to },
    });

    const broadcastPayload = {
      type: 'move',
      move: { from: move.from, to: move.to, promotion },
      san: result.san,
      fen: chess.fen(),
      ts: now,
    };
    const sig = await this.signPayload(broadcastPayload);
    this.broadcast({ ...broadcastPayload, sig });
  }

  private async runAntiCheatHeuristic(role: Role, moveTimestamps: number[], moveCount: number): Promise<void> {
    if (moveTimestamps.length < 2) return;

    // Tính delta thời gian giữa các nước của CÙNG role (cách 2 nước vì luân phiên).
    const ownDeltas: number[] = [];
    // moveTimestamps[i] = thời điểm nước thứ i. Mỗi role đi nửa số nước.
    // Role 'host' (trắng) đi ở index chẵn (0, 2, 4...), 'guest' ở index lẻ.
    const expectedParity = role === 'host' ? 0 : 1;
    for (let i = expectedParity + 2; i < moveTimestamps.length; i += 2) {
      ownDeltas.push(moveTimestamps[i] - moveTimestamps[i - 2]);
    }

    if (ownDeltas.length < 3) return;

    // Pattern 1: quá nhanh liên tục (engine pre-computed).
    let fastStreak = 0;
    let maxFastStreak = 0;
    for (const d of ownDeltas) {
      if (d < SUSPECT_FAST_MOVE_MS) {
        fastStreak++;
        if (fastStreak > maxFastStreak) maxFastStreak = fastStreak;
      } else {
        fastStreak = 0;
      }
    }
    if (maxFastStreak >= SUSPECT_FAST_STREAK) {
      await this.flagCheat(role, 'fast_move_streak', {
        maxStreak: maxFastStreak,
        threshold: SUSPECT_FAST_MOVE_MS,
        moveCount,
      });
    }

    // Pattern 2: quá đều (auto-player script). Cần ít nhất 8 nước để có ý nghĩa.
    if (ownDeltas.length >= SUSPECT_UNIFORM_MIN_MOVES) {
      const mean = ownDeltas.reduce((a, b) => a + b, 0) / ownDeltas.length;
      const variance = ownDeltas.reduce((a, b) => a + (b - mean) ** 2, 0) / ownDeltas.length;
      const stddev = Math.sqrt(variance);
      if (stddev < SUSPECT_UNIFORM_STDDEV_MS && mean < 5000) {
        await this.flagCheat(role, 'uniform_move_timing', {
          stddev,
          mean,
          moveCount,
        });
      }
    }
  }

  private async flagCheat(role: Role, reason: string, detail: unknown): Promise<void> {
    const flag: CheatFlag = { role, reason, at: Date.now(), detail };
    const flags = (await this.ctx.storage.get<CheatFlag[]>('cheat_flags')) || [];
    // Tránh spam cùng một flag: chỉ add nếu flag cuối cùng khác reason hoặc quá 30s.
    const last = flags[flags.length - 1];
    if (last && last.reason === reason && last.role === role && Date.now() - last.at < 30_000) {
      return;
    }
    flags.push(flag);
    // Giới hạn 100 flag cuối.
    if (flags.length > 100) flags.splice(0, flags.length - 100);
    await this.ctx.storage.put('cheat_flags', flags);
    await this.appendAudit({ t: flag.at, type: 'cheat_flag', role, detail: flag });

    // Broadcast "cheat_flagged" tới cả 2 (audit-only, không chặn). Client có thể
    // hiển thị badge "Đang xem xét" nếu muốn.
    this.broadcast({ type: 'cheat_flagged', role, reason, ts: flag.at });
  }

  private async sendAuthoritativeSync(ws: WebSocket) {
    const { chess, history, moveTimestamps, startedAt } = await this.loadGame();
    const captured = this.deriveCaptured(history);
    const syncPayload = {
      type: 'sync',
      fen: chess.fen(),
      history,
      captured,
      moveTimestamps,
      startedAt,
      turn: chess.turn(),
      ts: Date.now(),
      source: 'request',
    };
    const sig = await this.signPayload(syncPayload);
    ws.send(JSON.stringify({ ...syncPayload, sig }));
  }

  // Derive captured pieces từ history (server-side, không tin client).
  private deriveCaptured(history: string[]): { w: string[]; b: string[] } {
    const temp = new Chess();
    const captured: { w: string[]; b: string[] } = { w: [], b: [] };
    for (const san of history) {
      try {
        const move = temp.move(san);
        if (move && move.captured) {
          // move.color = màu của NGƯỜI ĐI (đã ăn). Captured piece là màu đối thủ.
          // chess.js: move.captured = loại quân bị ăn ('p','n','b','r','q').
          // captured.w = quân trắng bị ăn (= đen ăn trắng).
          const capturedColor = move.color === 'w' ? 'b' : 'w';
          captured[capturedColor].push(move.captured);
        }
      } catch {
        /* skip */
      }
    }
    return captured;
  }

  // ===== Rematch state machine (fix bug) =====
  // Trước đây: rematch_accept xóa game ngay khi NHẬN một lần accept (gọi
  // noteRematchAccepted add role + check every role has accepted). Rủi ro:
  // nếu một bên bấm accept sớm hoặc message đến lệch, state bị xóa trước khi
  // cả hai thật sự đồng ý.
  //
  // State machine mới:
  //   idle -> (request từ A) -> requested
  //   requested -> (accept từ A) -> accepted_by_<A>
  //   accepted_by_<A> -> (accept từ B) -> accepted_by_both -> RESET GAME
  //   requested -> (decline) -> declined
  //   accepted_by_<A> -> (decline từ B) -> declined
  //   declined -> (request mới) -> requested
  // Quan trọng: chỉ reset game khi đạt accepted_by_both. Trạng thái được lưu
  // rõ ràng trong storage để cả 2 client có thể sync.

  private async handleRematchRequest(ws: WebSocket): Promise<void> {
    const role = this.roleOf(ws);
    if (!role) return;

    let rematch = await this.ctx.storage.get<RematchState>('rematch');
    if (!rematch || rematch.status === 'declined' || rematch.status === 'accepted_by_both') {
      rematch = {
        status: 'requested',
        requestedBy: role,
        acceptedBy: [role], // người request được xem như đã "accept" ngầm
        requestedAt: Date.now(),
      };
    } else {
      // Đang ở trạng thái requested / accepted_by_X. Người request lại -> reset.
      rematch = {
        status: 'requested',
        requestedBy: role,
        acceptedBy: [role],
        requestedAt: Date.now(),
      };
    }
    await this.ctx.storage.put('rematch', rematch);
    await this.appendAudit({ t: Date.now(), type: 'rematch_request', role });

    // Relay tới đối thủ.
    this.relayToPeer(ws, { type: 'rematch_request', by: role, ts: Date.now() });
  }

  private async handleRematchAccept(ws: WebSocket): Promise<void> {
    const role = this.roleOf(ws);
    if (!role) return;

    const rematch = await this.ctx.storage.get<RematchState>('rematch');
    if (!rematch) {
      // Không có request nào mà accept -> ignore.
      return;
    }
    if (rematch.status === 'accepted_by_both' || rematch.status === 'declined') {
      // Đã kết thúc — ignore.
      return;
    }

    // Thêm role vào acceptedBy nếu chưa có.
    if (!rematch.acceptedBy.includes(role)) {
      rematch.acceptedBy.push(role);
    }

    // Cập nhật state machine.
    const bothAccepted = ROLES.every((r) => rematch.acceptedBy.includes(r));
    if (bothAccepted) {
      rematch.status = 'accepted_by_both';
    } else if (role === 'host') {
      rematch.status = 'accepted_by_host';
    } else {
      rematch.status = 'accepted_by_guest';
    }
    await this.ctx.storage.put('rematch', rematch);
    await this.appendAudit({ t: Date.now(), type: 'rematch_accept', role });

    if (rematch.status === 'accepted_by_both') {
      // Cả hai đã đồng ý — reset game. Broadcast rematch_accept tới cả 2 (đã
      // được relay ở trên), sau đó xóa game state.
      this.broadcast({ type: 'rematch_accept', by: role, ts: Date.now() });
      await this.ctx.storage.delete('game');
      await this.ctx.storage.delete('rematch');
      // Giữ cheat_flags + audit log để review sau (không xóa).
    } else {
      // Chỉ một bên accept -> relay cho bên kia biết.
      this.relayToPeer(ws, { type: 'rematch_accept_partial', by: role, status: rematch.status, ts: Date.now() });
    }
  }

  private async handleRematchDecline(ws: WebSocket): Promise<void> {
    const role = this.roleOf(ws);
    if (!role) return;

    const rematch = await this.ctx.storage.get<RematchState>('rematch');
    if (!rematch || rematch.status === 'accepted_by_both' || rematch.status === 'declined') {
      return;
    }
    rematch.status = 'declined';
    await this.ctx.storage.put('rematch', rematch);
    await this.appendAudit({ t: Date.now(), type: 'rematch_decline', role });

    this.broadcast({ type: 'rematch_decline', by: role, ts: Date.now() });
  }

  // ===== Audit log =====
  private async appendAudit(entry: AuditEntry): Promise<void> {
    const log = (await this.ctx.storage.get<AuditEntry[]>('audit_log')) || [];
    log.push(entry);
    // Giới hạn kích thước — giữ AUDIT_LOG_MAX entry cuối.
    if (log.length > AUDIT_LOG_MAX) {
      log.splice(0, log.length - AUDIT_LOG_MAX);
    }
    await this.ctx.storage.put('audit_log', log);
  }
}
