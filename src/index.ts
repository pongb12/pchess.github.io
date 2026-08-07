import { DurableObject } from 'cloudflare:workers';
import { Chess } from '../lib/chess.js';

interface Env {
  PCHESS_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
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

      const id = env.PCHESS_ROOM.idFromName(code.toLowerCase());
      const stub = env.PCHESS_ROOM.get(id);
      return stub.fetch(request);
    }

    const staticPath = /^\/(index\.html|css\/|js\/|stockfish\/)/.test(url.pathname) ? url.pathname : '/';
    return env.ASSETS.fetch(new Request(new URL(staticPath, request.url), request));
  },
};

interface GameState {
  fen: string;
  history: string[];
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

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return json({ ok: true, players: this.ctx.getWebSockets().length });
    }

    const url = new URL(request.url);
    const claimedRole: Role = url.searchParams.get('role') === 'guest' ? 'guest' : 'host';
    const isReconnect = url.searchParams.get('reconnect') === '1';

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
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const color = colorOfRole(claimedRole);
    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [claimedRole]);

    // Gửi trạng thái trò chơi đang dở để client nối lại ván (server-authoritative)
    const game = await this.ctx.storage.get<GameState>('game');
    server.send(JSON.stringify({ type: 'joined', role: claimedRole, color, game: game || null }));

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
    if (type === 'rematch_accept') {
      await this.ctx.storage.delete('game');
    }

    // Relay tin nhắn giữa 2 người (resign, draw_*, rematch_*, game_over, chat,
    // sync, init...). Nếu slot đối thủ bị lệch, thử tất cả socket còn sống.
    this.relayToPeer(ws, msg);
  }

  async webSocketClose(ws: WebSocket) {
    this.lastMoveAt.delete(ws);
    this.moveCounts.delete(ws);
    const other = this.opponent(ws);
    if (other) {
      try {
        other.send(JSON.stringify({ type: 'peer_left' }));
      } catch {
        /* ignore */
      }
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

  private async loadGame(): Promise<{ chess: Chess; history: string[] }> {
    const saved = await this.ctx.storage.get<GameState>('game');
    const chess = new Chess();
    const history: string[] = saved?.history || [];
    if (saved?.fen) {
      try {
        chess.load(saved.fen);
      } catch {
        /* fen không hợp lệ */
      }
    }
    return { chess, history };
  }

  private async handleMove(ws: WebSocket, msg: { move?: { from?: string; to?: string; promotion?: string } }) {
    const move = msg.move;
    const reject = (reason: string) => {
      try {
        ws.send(JSON.stringify({ type: 'move_rejected', move: move || null, reason }));
      } catch {
        /* ignore */
      }
    };

    if (!move || typeof move.from !== 'string' || typeof move.to !== 'string') {
      reject('malformed');
      return;
    }

    const { chess, history } = await this.loadGame();

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
    await this.ctx.storage.put('game', { fen: chess.fen(), history } satisfies GameState);

    this.broadcast({ type: 'move', move: { from: move.from, to: move.to, promotion }, san: result.san, fen: chess.fen() });
  }

  private async sendAuthoritativeSync(ws: WebSocket) {
    const { chess, history } = await this.loadGame();
    ws.send(JSON.stringify({ type: 'sync', fen: chess.fen(), history }));
  }
}
