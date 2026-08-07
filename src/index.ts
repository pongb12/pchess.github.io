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

interface Slot {
  ws: WebSocket;
  color: 'w' | 'b';
  lastMoveAt: number;
  moveCount: number[];
}

interface GameState {
  fen: string;
  history: string[];
}

export class PChessRoom extends DurableObject<Env> {
  private slots: (Slot | null)[] = [null, null];

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return json({ ok: true, players: this.ctx.getWebSockets().length });
    }

    const url = new URL(request.url);
    const claimedRole = url.searchParams.get('role') === 'guest' ? 'guest' : 'host';
    const isReconnect = url.searchParams.get('reconnect') === '1';
    const alive = this.ctx.getWebSockets();

    // Dọn slot đã đóng. Client mất kết nối (mobile để nền / thoát tab) có thể
    // để lại socket cũ chưa được webSocketClose dọn -> nếu cứ đếm sẽ tưởng
    // "phòng đầy" và từ chối nhầm người đang nối lại.
    for (let i = 0; i < 2; i++) {
      const s = this.slots[i];
      if (s && (s.ws.readyState !== WebSocket.OPEN || !alive.includes(s.ws))) {
        this.slots[i] = null;
      }
    }

    let index = this.slots.findIndex((s) => !s);

    // Chỉ khi đây là KẾT NỐI LẠI (client gửi reconnect=1): nếu socket cũ cùng
    // vai trò vẫn "sống" ở server (mất mạng không gửi close frame) thì kick nó
    // để nhường chỗ. Không áp dụng cho người vào mới -> tránh bị chiếm chỗ.
    // Lưu ý: close() phía server KHÔNG tới client (giới hạn Cloudflare
    // WebSocketPair), nên phải gửi 'session-takeover' trước để client cũ biết
    // phiên đã bị thay thế.
    if (index < 0 && isReconnect) {
      const roleIdx = claimedRole === 'host' ? 0 : 1;
      const existing = this.slots[roleIdx];
      if (existing) {
        try {
          existing.ws.send(JSON.stringify({ type: 'session-takeover' }));
        } catch {
          /* ignore */
        }
        try {
          existing.ws.close(4000, 'reconnect');
        } catch {
          /* ignore */
        }
        this.slots[roleIdx] = null;
        index = roleIdx;
      }
    }

    if (index < 0) {
      // Phòng thật sự đầy: 2 người đang chơi.
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [claimedRole]);
      // send() ngay trong fetch bị drop vì handshake client chưa xong -> hoãn lại.
      // Lưu ý: close() phía server sẽ gỡ socket khỏi DO (tránh phòng bị kẹt) dù
      // close frame có thể không tới client (giới hạn của Cloudflare WebSocketPair);
      // client tự đóng socket khi nhận 'room-full' (handleRoomFull).
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

    const color: 'w' | 'b' = index === 0 ? 'w' : 'b';
    const role = index === 0 ? 'host' : 'guest';

    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [role]);
    this.slots[index] = { ws: server, color, lastMoveAt: 0, moveCount: [] };

    // Gửi trạng thái trò chơi đang dở để client nối lại ván (server-authoritative)
    const game = await this.ctx.storage.get<GameState>('game');
    server.send(JSON.stringify({ type: 'joined', role, color, game: game || null }));

    const target = this.slots[1 - index];
    if (target) {
      target.ws.send(JSON.stringify({ type: 'peer_joined' }));
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
    const other = this.opponent(ws);
    const idx = this.slots.findIndex((s) => s && s.ws === ws);
    if (idx >= 0) this.slots[idx] = null;

    if (other) other.send(JSON.stringify({ type: 'peer_left' }));
  }

  async webSocketError(ws: WebSocket) {
    ws.close(1011, 'error');
  }

  private colorOf(ws: WebSocket): 'w' | 'b' | null {
    const i = this.slots.findIndex((s) => s && s.ws === ws);
    return i >= 0 ? this.slots[i]!.color : null;
  }

  private opponent(ws: WebSocket): WebSocket | null {
    const i = this.slots.findIndex((s) => s && s.ws === ws);
    if (i < 0) return null;
    const other = this.slots[1 - i];
    return other && other.ws.readyState === WebSocket.OPEN ? other.ws : null;
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
    const idx = this.slots.findIndex((s) => s && s.ws === ws);
    if (idx >= 0) {
      const slot = this.slots[idx]!;
      const now = Date.now();
      if (now - slot.lastMoveAt < MOVE_RATE_LIMIT_MS) {
        reject('rate_limit');
        return;
      }
      slot.lastMoveAt = now;
      slot.moveCount = slot.moveCount.filter((t) => now - t < MOVE_BURST_WINDOW_MS);
      slot.moveCount.push(now);
      if (slot.moveCount.length > MOVE_BURST_MAX) {
        reject('rate_limit');
        return;
      }
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
