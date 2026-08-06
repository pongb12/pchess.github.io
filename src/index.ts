import { DurableObject } from 'cloudflare:workers';
import { Chess } from '../lib/chess.js';

interface Env {
  PCHESS_ROOM: DurableObjectNamespace;
}

const ROOM_CODE_RE = /^[A-Za-z0-9]{1,20}$/;
const MAX_MSG_LEN = 4096;
const MOVE_RATE_LIMIT_MS = 100;
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
    if (url.pathname !== '/room') {
      return json({ error: 'not_found' }, 404);
    }

    const code = (url.searchParams.get('code') || '').trim();
    if (!ROOM_CODE_RE.test(code)) {
      return json({ error: 'invalid_room_code' }, 400);
    }

    const id = env.PCHESS_ROOM.idFromName(code.toLowerCase());
    const stub = env.PCHESS_ROOM.get(id);
    return stub.fetch(request);
  },
};

interface Slot {
  ws: WebSocket;
  color: 'w' | 'b';
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
    const alive = this.ctx.getWebSockets();

    if (alive.length >= 2) {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], [claimedRole]);
      pair[1].send(JSON.stringify({ type: 'room-full' }));
      pair[1].close();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    let index: number;
    if (alive.length === 0) {
      index = claimedRole === 'host' ? 0 : 1;
    } else {
      index = this.slots[0] ? 1 : 0;
    }

    const color: 'w' | 'b' = index === 0 ? 'w' : 'b';
    const role = index === 0 ? 'host' : 'guest';

    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [role]);
    this.slots[index] = { ws: server, color };

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

    const other = this.opponent(ws);
    if (other) other.send(JSON.stringify(msg));
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

    const now = Date.now();
    const last = await this.ctx.storage.get<number>('lastMoveAt');
    if (last && now - last < MOVE_RATE_LIMIT_MS) {
      reject('rate_limit');
      return;
    }
    await this.ctx.storage.put('lastMoveAt', now);

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
