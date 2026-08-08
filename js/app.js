/**
 * PChess - Cờ vua trực tuyến qua WebSocket relay (Cloudflare Durable Objects)
 * Server-authoritative: nước đi được validate bằng chess.js trên server.
 */

// ===== Configuration =====
const CONFIG = {
    WS_URL: 'wss://pchess-github-io.st163943.workers.dev',
    MOVE_RATE_LIMIT: 100, // ms between moves
    RECONNECT_DELAY: 3000,
    SYNC_INTERVAL: 5000,
    DEFAULT_TIMER: 0, // 0 = no limit
    PIECE_BASE_URL: 'https://images.chesscomfiles.com/chess-themes/pieces/neo/300',
    PIECES: {
        w: { k: 'wk.png', q: 'wq.png', r: 'wr.png', b: 'wb.png', n: 'wn.png', p: 'wp.png' },
        b: { k: 'bk.png', q: 'bq.png', r: 'br.png', b: 'bb.png', n: 'bn.png', p: 'bp.png' }
    }
};

function getPieceUrl(color, type) {
    return CONFIG.PIECE_BASE_URL + '/' + CONFIG.PIECES[color][type];
}

// ===== EngineStore (IndexedDB): lưu bản Stockfish Full do người dùng tự cài =====
// localStorage chỉ đủ ~5MB nên file engine (~100MB) phải dùng IndexedDB.
const EngineStore = {
    DB_NAME: 'pchess',
    STORE: 'engines',
    _db: null,

    open() {
        if (this._db) return Promise.resolve(this._db);
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(this.STORE)) {
                    req.result.createObjectStore(this.STORE);
                }
            };
            req.onsuccess = () => {
                this._db = req.result;
                resolve(req.result);
            };
            req.onerror = () => reject(req.error || new Error('Không mở được IndexedDB'));
        });
    },

    async save(key, blob) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE, 'readwrite');
            tx.objectStore(this.STORE).put(blob, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Lưu IndexedDB thất bại'));
        });
    },

    async load(key) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const req = db.transaction(this.STORE, 'readonly').objectStore(this.STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error || new Error('Đọc IndexedDB thất bại'));
        });
    },

    async delete(key) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE, 'readwrite');
            tx.objectStore(this.STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Xóa IndexedDB thất bại'));
        });
    },

    async size() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const req = db.transaction(this.STORE, 'readonly').objectStore(this.STORE).getAll();
            req.onsuccess = () => resolve((req.result || []).reduce((s, b) => s + (b && b.size ? b.size : 0), 0));
            req.onerror = () => reject(req.error || new Error('Đọc IndexedDB thất bại'));
        });
    }
};

// ===== Sound Manager (Web Audio API) =====
class SoundManager {
    constructor() {
        this.enabled = true;
        this.ctx = null;
        this.initAudio();
    }

    initAudio() {
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('Web Audio API not supported');
        }
    }

    ensureContext() {
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    play(type) {
        if (!this.enabled || !this.ctx) return;
        this.ensureContext();

        switch (type) {
            case 'move': this.playTone(520, 0.07, 'triangle', 0.18); break;
            case 'capture': this.playNoise(0.09, 0.28); this.playTone(150, 0.12, 'triangle', 0.22); break;
            case 'check': this.playTone(660, 0.16, 'square', 0.16); this.playTone(880, 0.16, 'square', 0.12); break;
            case 'checkmate': this.playMelody([523, 659, 784], [0.2, 0.2, 0.4]); break;
            case 'castle': this.playTone(330, 0.1, 'sine', 0.16); this.playTone(440, 0.1, 'sine', 0.14); break;
            case 'promote': this.playMelody([392, 523, 659, 784], [0.12, 0.12, 0.12, 0.28]); break;
            case 'draw': this.playMelody([440, 494, 523], [0.2, 0.2, 0.35]); break;
            case 'notify': this.playTone(560, 0.12, 'sine', 0.12); break;
            case 'error': this.playTone(200, 0.2, 'sawtooth', 0.1); break;
            case 'lowtime': this.playTone(880, 0.06, 'square', 0.12); break;
            case 'flag': this.playMelody([660, 330, 165], [0.15, 0.15, 0.4]); break;
        }
    }

    playTone(freq, duration, type = 'sine', volume = 0.1) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(volume, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
    }

    playNoise(duration, volume = 0.1) {
        const bufferSize = this.ctx.sampleRate * duration;
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        const noise = this.ctx.createBufferSource();
        noise.buffer = buffer;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(volume, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        noise.connect(gain);
        gain.connect(this.ctx.destination);
        noise.start();
    }

    playMelody(freqs, durations) {
        let time = this.ctx.currentTime;
        freqs.forEach((freq, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, time);
            gain.gain.setValueAtTime(0.15, time);
            gain.gain.exponentialRampToValueAtTime(0.01, time + durations[i]);
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(time);
            osc.stop(time + durations[i]);
            time += durations[i];
        });
    }

    setEnabled(val) {
        this.enabled = val;
    }
}

// ===== Toast Notifications =====
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}

// ===== Debug Panel =====
function debugLog(level, ...args) {
    if (window.DebugPanel) window.DebugPanel.log(level, args);
}

const DebugPanel = {
    MAX_LOGS: 400,

    init() {
        this.panel = document.getElementById('debug-panel');
        this.logEl = document.getElementById('debug-log');
        this.statusEl = document.getElementById('debug-status');
        this.logs = [];

        document.getElementById('btn-debug-toggle').addEventListener('click', () => this.toggle());
        document.getElementById('btn-debug-close').addEventListener('click', () => this.close());
        document.getElementById('btn-debug-clear').addEventListener('click', () => this.clear());
        document.getElementById('btn-debug-copy').addEventListener('click', () => this.copyLogs());
        document.getElementById('btn-debug-reconnect').addEventListener('click', () => this.reconnect());

        this.hookConsole();
        this.hookErrors();
        this.log('info', ['Debug panel khởi động. Bấm 📋 để copy log báo lỗi.']);

        setInterval(() => {
            if (this.panel.classList.contains('open')) this.refreshStatus();
        }, 1500);
    },

    toggle() {
        this.panel.classList.toggle('open');
        if (this.panel.classList.contains('open')) this.refreshStatus();
    },

    close() {
        this.panel.classList.remove('open');
    },

    clear() {
        this.logs = [];
        this.logEl.innerHTML = '';
    },

    log(level, args) {
        const text = args.map(a => {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return a.stack || a.message;
            try {
                return JSON.stringify(a);
            } catch (e) {
                return String(a);
            }
        }).join(' ');

        const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
        this.logs.push({ level, time, text });
        if (this.logs.length > this.MAX_LOGS) this.logs.shift();

        const line = document.createElement('div');
        line.className = `dbg-line dbg-${level}`;
        line.innerHTML = `<span class="dbg-time">${time}</span> ${this.escapeHtml(text)}`;
        this.logEl.appendChild(line);
        while (this.logEl.children.length > this.MAX_LOGS) this.logEl.firstChild.remove();
        this.logEl.scrollTop = this.logEl.scrollHeight;
    },

    escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    hookConsole() {
        const self = this;
        const orig = {};
        ['log', 'info', 'warn', 'error'].forEach(level => {
            orig[level] = console[level].bind(console);
            console[level] = (...args) => {
                orig[level](...args);
                self.log(level, args);
            };
        });
        this._origConsole = orig;
    },

    hookErrors() {
        window.addEventListener('error', (e) => {
            this.log('error', [e.message, (e.filename || '') + ':' + (e.lineno || '')]);
        });
        window.addEventListener('unhandledrejection', (e) => {
            this.log('error', ['Unhandled promise rejection:', e.reason && e.reason.message || e.reason]);
        });
    },

    refreshStatus() {
        const g = window.game;
        if (!g) {
            this.statusEl.textContent = 'Game chưa khởi tạo';
            return;
        }

        const lines = [];
        try {
            lines.push(`Role: ${g.role || (g.isHost ? 'Host' : (g.myColor ? 'Guest' : 'Idle'))} | Color: ${g.myColor || '-'}`);
            lines.push(`Room: ${g.roomId || '-'}`);
            if (g.ws) {
                const states = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' };
                lines.push(`WS: ${states[g.ws.readyState] || g.ws.readyState}`);
            } else {
                lines.push('WS: none');
            }
            lines.push(`Ping: ${g.lastPing != null ? g.lastPing + 'ms' : '-'}`);
        } catch (err) {
            lines.push('Lỗi đọc trạng thái: ' + err.message);
        }
        this.statusEl.innerHTML = lines.map(l => `<div>${this.escapeHtml(l)}</div>`).join('');
    },

    copyLogs() {
        const text = this.logs.map(l => `[${l.time}] [${l.level}] ${l.text}`).join('\n');
        const doCopy = () => {
            navigator.clipboard.writeText(text).then(() => {
                this.log('info', ['Đã copy logs vào clipboard']);
            });
        };
        if (navigator.clipboard && window.isSecureContext) {
            doCopy();
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand('copy');
                this.log('info', ['Đã copy logs vào clipboard']);
            } catch (e) {
                this.log('error', ['Không copy được, tự bôi đen log trong panel']);
            }
            ta.remove();
        }
    },

    reconnect() {
        const g = window.game;
        if (!g || !g.roomId) {
            this.log('error', ['Chưa có phòng (chưa tạo/join)']);
            return;
        }
        if (g.ws && g.ws.readyState === WebSocket.OPEN) {
            this.log('info', ['WS vẫn open, không cần reconnect']);
            return;
        }
        g.connectRoom(g.roomId, g.role || (g.isHost ? 'host' : 'guest'), true);
        this.log('info', ['Đang reconnect WS...']);
    }
};

// ===== Main Game Class =====
class PChessGame {
    constructor() {
        this.chess = new Chess();
        this.ws = null;
        this.wsOpen = false;
        this.heartbeatInterval = null;
        this.role = null; // 'host' hoặc 'guest'
        this.roomId = null;
        this.isHost = false;
        this.myColor = null; // 'w' or 'b'
        this.lastPing = null;
        this.selectedSquare = null;
        this.validMoves = [];
        this.dragFrom = null;
        this.lastMove = null;
        this.lastMoveInfo = null; // { san, captured, color, isCastle, isPromotion, isCheck } — cho indicators
        this.gameActive = false;
        this.moveHistory = [];
        this.capturedPieces = { w: [], b: [] };
        this.soundManager = new SoundManager();
        this.settings = this.loadSettings();
        this.timers = { w: 0, b: 0 };
        this.timerInterval = null;
        this.currentTurn = 'w';
        this.lastMoveTime = 0;
        this.reconnectAttempts = 0;
        this.pendingPromotion = null;
        this.rematchState = { requested: false, by: null, status: 'idle', acceptedBy: [] };
        this.gameResult = null;
        this.recoveringSync = false;
        // Flip board (cho phép xem từ góc nhìn đối thủ — chủ yếu cho analysis
        // mode sau ván, nhưng cũng dùng được trong game nếu người chơi muốn).
        this.boardFlipped = false;
        // Move preview khi rê quân: ghost piece ở ô đích
        this.previewSquare = null;
        // Sync banner timer (tự ẩn sau vài giây)
        this.syncBannerTimer = null;
        // Conn banner timer
        this.connBannerTimer = null;
        // Reconnect reason rõ ràng: 'temp_disconnect' | 'room_full' | 'takeover' | 'peer_left' | null
        this.disconnectReason = null;
        // Active mobile panel tab
        this.activePanelTab = 'move-history';

        // Bind methods
        this.handleSquareClick = this.handleSquareClick.bind(this);
        this.handleResize = this.handleResize.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);

        this.init();
    }

    // ===== Initialization =====
    init() {
        this.applyTheme(this.settings.theme);
        this.bindEvents();
        this.checkUrlForRoom();
        window.addEventListener('resize', this.handleResize);
        window.addEventListener('beforeunload', () => this.cleanup());
        // Keyboard shortcuts toàn cục (chỉ hoạt động khi đang ở game/analysis)
        window.addEventListener('keydown', this.handleKeyDown);
    }

    bindEvents() {
        // Landing page
        document.getElementById('btn-create-room').addEventListener('click', () => this.createRoom());
        document.getElementById('btn-goto-analysis').addEventListener('click', () => this.gotoAnalysis());
        document.getElementById('btn-join-room').addEventListener('click', () => this.joinFromInput());
        document.getElementById('input-room-link').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.joinFromInput();
        });
        document.getElementById('btn-settings-landing').addEventListener('click', () => this.openSettings());

        // Lobby
        document.getElementById('btn-copy-link').addEventListener('click', () => this.copyRoomLink());
        document.getElementById('btn-cancel-lobby').addEventListener('click', () => this.leaveRoom());

        // Game header
        document.getElementById('btn-game-settings').addEventListener('click', () => this.openSettings());
        document.getElementById('btn-game-menu').addEventListener('click', () => this.openMenu());

        // Settings modal
        document.querySelectorAll('.btn-close-modal').forEach(btn => {
            btn.addEventListener('click', (e) => this.closeModal(e.target.closest('.modal')));
        });
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => this.closeModal(e.target.parentElement));
        });

        // Theme buttons
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.changeTheme(e.target.dataset.theme));
        });

        // Settings controls
        document.getElementById('setting-promotion').addEventListener('change', (e) => {
            this.settings.promotion = e.target.value;
            this.saveSettings();
        });
        document.getElementById('setting-sound').addEventListener('change', (e) => {
            this.settings.sound = e.target.checked;
            this.soundManager.setEnabled(e.target.checked);
            this.saveSettings();
        });
        document.getElementById('setting-animation').addEventListener('change', (e) => {
            this.settings.animation = e.target.checked;
            this.saveSettings();
        });
        document.getElementById('setting-coords').addEventListener('change', (e) => {
            this.settings.coords = e.target.checked;
            this.saveSettings();
            this.renderBoard();
        });
        document.getElementById('setting-timer').addEventListener('change', (e) => {
            this.settings.timer = parseInt(e.target.value);
            this.saveSettings();
        });
        document.getElementById('setting-engine').addEventListener('change', (e) => {
            this.settings.engine = e.target.value;
            this.saveSettings();
        });
        document.getElementById('btn-import-engine').addEventListener('click', () => {
            document.getElementById('engine-file-input').click();
        });
        document.getElementById('engine-file-input').addEventListener('change', async (e) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            if (!files.length) return;
            const js = files.find(f => /\.js$/i.test(f.name));
            const wasm = files.find(f => /\.wasm$/i.test(f.name));
            if (!js && !wasm) {
                showToast('Hãy chọn file .js và .wasm của bản Full', 'warning');
                return;
            }
            showToast('Đang lưu bản Full...', 'info');
            try {
                if (js) await EngineStore.save('engine-full', js);
                if (wasm) await EngineStore.save('engine-full-wasm', wasm);
                await this.syncEngineStatus();
                const missing = [];
                if (!js) missing.push('.js');
                if (!wasm) missing.push('.wasm');
                showToast('Đã lưu bản Full' + (missing.length ? ' (thiếu ' + missing.join(', ') + ')' : ''), missing.length ? 'warning' : 'success');
            } catch (err) {
                showToast('Lưu thất bại: ' + (err && err.message ? err.message : err), 'error');
            }
        });
        document.getElementById('btn-clear-engine').addEventListener('click', async () => {
            try {
                await EngineStore.delete('engine-full');
                await EngineStore.delete('engine-full-wasm');
                await this.syncEngineStatus();
                showToast('Đã xóa bản Full', 'success');
            } catch (err) {
                showToast('Xóa thất bại: ' + (err && err.message ? err.message : err), 'error');
            }
        });
        document.getElementById('btn-download-engine').addEventListener('click', () => this.downloadFullEngine());

        // Promotion modal
        document.querySelectorAll('.promotion-piece').forEach(btn => {
            btn.addEventListener('click', (e) => this.completePromotion(e.target.dataset.piece));
        });

        // Game over modal
        document.getElementById('btn-rematch').addEventListener('click', () => this.requestRematch());
        document.getElementById('btn-new-game').addEventListener('click', () => this.leaveRoom());

        // Rematch modal
        document.getElementById('btn-accept-rematch').addEventListener('click', () => this.acceptRematch());
        document.getElementById('btn-decline-rematch').addEventListener('click', () => this.declineRematch());

        // Draw modal
        document.getElementById('btn-accept-draw').addEventListener('click', () => this.acceptDrawOffer());
        document.getElementById('btn-decline-draw').addEventListener('click', () => this.declineDrawOffer());

        // Menu modal
        document.getElementById('btn-menu-settings').addEventListener('click', () => {
            this.closeModal(document.getElementById('menu-modal'));
            this.openSettings();
        });
        document.getElementById('btn-menu-resign').addEventListener('click', () => this.resign());
        document.getElementById('btn-menu-draw').addEventListener('click', () => this.offerDraw());

        // Analysis & PGN
        document.getElementById('btn-analyze-game').addEventListener('click', () => this.startAnalysis());
        document.getElementById('btn-game-analyze').addEventListener('click', () => this.startAnalysis());
        document.getElementById('btn-menu-analyze').addEventListener('click', () => {
            this.closeModal(document.getElementById('menu-modal'));
            this.startAnalysis();
        });
        document.getElementById('btn-export-pgn').addEventListener('click', () => this.exportPgn());
        document.getElementById('btn-menu-export-pgn').addEventListener('click', () => {
            this.closeModal(document.getElementById('menu-modal'));
            this.exportPgn();
        });

        // Flip board
        const flipBtn = document.getElementById('btn-flip-board');
        if (flipBtn) flipBtn.addEventListener('click', () => this.flipBoard());

        // Mobile panel tabs
        document.querySelectorAll('.panel-tab[data-tab]').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchPanelTab(e.target.dataset.tab));
        });
        const collapseBtn = document.getElementById('panel-tab-collapse');
        if (collapseBtn) collapseBtn.addEventListener('click', () => this.togglePanelCollapse());

        // Sync settings UI
        this.syncSettingsUI();
    }

    syncSettingsUI() {
        document.getElementById('setting-promotion').value = this.settings.promotion;
        document.getElementById('setting-sound').checked = this.settings.sound;
        document.getElementById('setting-animation').checked = this.settings.animation;
        document.getElementById('setting-coords').checked = this.settings.coords;
        document.getElementById('setting-timer').value = this.settings.timer;
        document.getElementById('setting-engine').value = this.settings.engine || 'lite';
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === this.settings.theme);
        });
        this.soundManager.setEnabled(this.settings.sound);
        this.syncEngineStatus();
    }

    async syncEngineStatus() {
        const el = document.getElementById('engine-full-status');
        if (!el) return;
        try {
            const js = await EngineStore.load('engine-full');
            const wasm = await EngineStore.load('engine-full-wasm');
            if (js && wasm) {
                el.textContent = 'Đã cài (' + ((js.size + wasm.size) / 1048576).toFixed(0) + 'MB)';
            } else if (js || wasm) {
                el.textContent = 'Thiếu file ' + (js ? '.wasm' : '.js') + ' — ' +
                    ((js && js.size || 0) / 1048576).toFixed(0) + 'MB đã lưu';
            } else {
                el.textContent = 'Chưa cài';
            }
        } catch (e) {
            el.textContent = 'Lỗi đọc';
        }
    }

    // Tự tải bản Full (stockfish-18-single.js + .wasm) từ CDN rồi lưu IndexedDB
    async downloadFullEngine() {
        const btn = document.getElementById('btn-download-engine');
        const wrap = document.getElementById('engine-download-progress-wrap');
        const bar = document.getElementById('engine-download-bar');
        const text = document.getElementById('engine-download-text');
        if (!btn || !wrap || !bar || !text) return;
        btn.disabled = true;
        wrap.style.display = 'flex';
        bar.style.width = '0%';
        text.textContent = 'Bắt đầu tải...';
        const base = 'https://unpkg.com/stockfish@18.0.8/bin/';
        const files = [
            { name: 'engine-full', url: base + 'stockfish-18-single.js', size: 0 },
            { name: 'engine-full-wasm', url: base + 'stockfish-18-single.wasm', size: 0 }
        ];
        try {
            for (const f of files) {
                text.textContent = 'Đang tải ' + (f.name === 'engine-full' ? 'stockfish-18-single.js' : 'stockfish-18-single.wasm (~108MB)') + '...';
                const res = await fetch(f.url);
                if (!res.ok || !res.body) throw new Error('Tải về thất bại (HTTP ' + res.status + '). Kiểm tra kết nối mạng.');
                const total = parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
                const reader = res.body.getReader();
                const chunks = [];
                let received = 0;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    received += value.length;
                    if (total) {
                        const pct = Math.min(100, Math.round(received / total * 100));
                        bar.style.width = pct + '%';
                        text.textContent = (received / 1048576).toFixed(0) + ' / ' + (total / 1048576).toFixed(0) + ' MB (' + pct + '%)';
                    } else {
                        bar.style.width = '30%';
                        bar.classList.add('indeterminate');
                        text.textContent = 'Đã tải ' + (received / 1048576).toFixed(0) + ' MB...';
                    }
                }
                bar.classList.remove('indeterminate');
                const blob = new Blob(chunks, { type: f.name === 'engine-full' ? 'text/javascript' : 'application/wasm' });
                await EngineStore.save(f.name, blob);
                f.size = blob.size;
            }
            wrap.style.display = 'none';
            await this.syncEngineStatus();
            showToast('Đã cài bản Full (' + ((files[0].size + files[1].size) / 1048576).toFixed(0) + 'MB)', 'success');
        } catch (err) {
            wrap.style.display = 'none';
            showToast('Tải bản Full thất bại: ' + (err && err.message ? err.message : err), 'error');
        } finally {
            btn.disabled = false;
        }
    }

    // ===== WebSocket Setup =====
    connectRoom(roomCode, role, reconnect = false) {
        return new Promise((resolve, reject) => {
            try {
                debugLog('info', 'Kết nối WS tới phòng', roomCode, 'role =', role, reconnect ? '(reconnect)' : '');
                this.roomId = roomCode;
                this.role = role;
                this.reconnecting = reconnect;
                const wsUrl = CONFIG.WS_URL + '/room?code=' + encodeURIComponent(roomCode) +
                    '&role=' + role + (reconnect ? '&reconnect=1' : '');
                this.ws = new WebSocket(wsUrl);

                let settled = false;
                // Không để "Đang kết nối..." treo vô thời hạn
                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    debugLog('error', 'Timeout kết nối WS (10s)');
                    if (this.ws) {
                        try { this.ws.close(); } catch (e) { /* ignore */ }
                    }
                    reject(new Error('timeout'));
                }, 10000);

                this.ws.onopen = () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    debugLog('info', 'WS open');
                    const wasReconnect = this.reconnecting;
                    this.wsOpen = true;
                    this.reconnectAttempts = 0;
                    this.reconnecting = false;
                    this.startHeartbeat();
                    if (wasReconnect) {
                        this.recoveringSync = true;
                        // Hiển thị sync banner thay vì chỉ toast text nhỏ
                        this.showSyncBanner('Đang khôi phục ván cờ...');
                        // Auto-sync ngay khi WS mở lại. Server sẽ tự gửi sync message
                        // (xem handleJoined + handleSync) nên ta chỉ cần đợi. Vẫn gửi
                        // sync_request để phòng trường hợp server không có game.
                        this.sendMessage({ type: 'sync_request' });
                        // Backup: nếu sau 4s chưa nhận sync thì vẫn clear banner
                        if (this.syncBannerTimer) clearTimeout(this.syncBannerTimer);
                        this.syncBannerTimer = setTimeout(() => this.hideSyncBanner(), 4000);
                    }
                    this.updateConnDetail();
                    resolve(roomCode);
                };

                this.ws.onmessage = (event) => this.onWsMessage(event);

                this.ws.onclose = (event) => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        reject(new Error('ws_closed'));
                    }
                    this.handleWsClose(event);
                };

                this.ws.onerror = (err) => {
                    debugLog('error', 'WS error:', err && err.message ? err.message : '');
                };
            } catch (err) {
                debugLog('error', 'connectRoom exception:', err);
                reject(err);
            }
        });
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            this.sendMessage({ type: 'ping', timestamp: Date.now() });
        }, 25000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    handleWsClose(event) {
        this.wsOpen = false;
        this.stopHeartbeat();
        debugLog('warn', 'WS đóng, code =', event && event.code);

        if (!this.ws) return; // đóng chủ động (leaveRoom / cleanup)

        // Phân biệt rõ 4 lý do mất kết nối để hiển thị đúng UX:
        //   1. temp_disconnect — mạng rớt tạm thời, đang thử reconnect
        //   2. room_full — phòng đầy, thử lại vài lần rồi fallback
        //   3. takeover — phiên bị thay thế (xem handleSessionTakeover)
        //   4. peer_left — đối thủ rời phòng (server báo, không phải WS close)
        // handleSessionTakeover sẽ tự set disconnectReason='takeover' và không vào đây.
        this.disconnectReason = 'temp_disconnect';

        this.setConnState('disconnected', 'Mất kết nối', 'Đang thử kết nối lại...');

        if (this.gameActive && this.reconnectAttempts < 5) {
            this.showConnBanner('temp_disconnect', 'Mất kết nối mạng', 'Đang thử kết nối lại (lần ' + (this.reconnectAttempts + 1) + '/5)...');
            this.reconnectAttempts++;
            this.scheduleReconnect();
        } else if (this.gameActive) {
            this.showConnBanner('temp_disconnect', 'Không thể kết nối lại', 'Vui lòng tạo phòng mới.');
            this.leaveRoom();
        } else {
            // Chưa vào ván mà mất kết nối: thường do CONFIG.WS_URL chưa đổi / chưa deploy worker
            this.showConnBanner('temp_disconnect', 'Không kết nối được server', 'Kiểm tra CONFIG.WS_URL và deploy worker.');
            this.cleanup();
            this.showPage('lobby-page', false);
            this.showPage('landing-page', true);
        }
        this.updateConnDetail();
    }

    scheduleReconnect() {
        setTimeout(() => {
            if (!this.roomId || !this.role) return;
            debugLog('warn', 'Reconnect lần', this.reconnectAttempts, 'tới', this.roomId);
            this.connectRoom(this.roomId, this.role, true);
        }, CONFIG.RECONNECT_DELAY);
    }

    // ===== Room Management =====
    generateRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        return code;
    }

    gotoAnalysis() {
        this.showPage('landing-page', false);
        this.showPage('analysis-page', true);
        // Start analysis from initial position (empty moves)
        Analysis.startFromGame([], { winner: null, reason: 'analysis', message: '*' });
    }

    async createRoom() {
        try {
            debugLog('info', 'Tạo phòng mới...');
            this.showPage('landing-page', false);
            this.showPage('lobby-page', true);
            document.getElementById('connection-text').textContent = 'Đang tạo phòng...';

            const code = this.generateRoomCode();
            this.isHost = true;
            this.myColor = 'w';
            this.role = 'host';
            await this.connectRoom(code, 'host');

            const link = this.generateRoomLink();
            document.getElementById('room-link-display').value = link;
            document.getElementById('connection-text').textContent = 'Đang chờ đối thủ...';

            // Save to session storage for reconnect
            sessionStorage.setItem('pchess_room', JSON.stringify({
                roomId: code,
                role: 'host',
                color: 'w',
                isHost: true
            }));

            showToast('Phòng đã tạo! Gửi link cho đối thủ.', 'success');
        } catch (err) {
            showToast('Không thể tạo phòng: ' + err.message, 'error');
            this.showPage('landing-page', true);
            this.showPage('lobby-page', false);
        }
    }

    async joinRoom(roomId) {
        try {
            debugLog('info', 'Join phòng:', roomId);
            this.showPage('landing-page', false);
            this.showPage('lobby-page', true);
            document.getElementById('connection-text').textContent = 'Đang kết nối...';

            this.isHost = false;
            this.myColor = 'b';
            this.role = 'guest';
            await this.connectRoom(roomId, 'guest');

            // Save to session storage
            sessionStorage.setItem('pchess_room', JSON.stringify({
                roomId: roomId,
                role: 'guest',
                color: 'b',
                isHost: false
            }));
        } catch (err) {
            showToast('Không thể vào phòng: ' + err.message, 'error');
            this.showPage('landing-page', true);
            this.showPage('lobby-page', false);
        }
    }

    joinFromInput() {
        const input = document.getElementById('input-room-link').value.trim();
        if (!input) {
            showToast('Vui lòng nhập link phòng', 'warning');
            return;
        }

        // Extract room ID from link or direct input
        let roomId = input;
        try {
            const url = new URL(input);
            const hash = url.hash.replace('#', '');
            if (hash) roomId = hash;
        } catch (e) {
            // Not a URL, treat as room ID
        }

        this.joinRoom(roomId);
    }

    checkUrlForRoom() {
        const hash = window.location.hash.replace('#', '');
        if (hash && hash.length >= 4) {
            document.getElementById('input-room-link').value = window.location.href;
            // Auto-join after a short delay
            setTimeout(() => this.joinRoom(hash), 500);
            return;
        }

        // Check session storage for reconnect
        const saved = sessionStorage.getItem('pchess_room');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                if (data.roomId && data.role) {
                    debugLog('info', 'Tự động kết nối lại phòng', data.roomId, 'role =', data.role);
                    this.showPage('landing-page', false);
                    this.showPage('lobby-page', true);
                    document.getElementById('connection-text').textContent = 'Đang kết nối lại...';
                    this.isHost = data.role === 'host';
                    this.myColor = data.color || (this.isHost ? 'w' : 'b');
                    this.connectRoom(data.roomId, data.role);
                }
            } catch (e) {
                sessionStorage.removeItem('pchess_room');
            }
        }
    }

    generateRoomLink() {
        const base = window.location.origin + window.location.pathname;
        return `${base}#${this.roomId}`;
    }

    copyRoomLink() {
        const link = document.getElementById('room-link-display');
        link.select();
        navigator.clipboard.writeText(link.value).then(() => {
            showToast('Đã sao chép link!', 'success');
        });
    }

    // ===== Connection Handling =====
    onWsMessage(event) {
        let msg;
        try {
            msg = JSON.parse(event.data);
        } catch (e) {
            debugLog('error', 'JSON lỗi từ WS:', event.data);
            return;
        }
        this.handleMessage(msg);
    }

    sendMessage(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                debugLog('log', 'Gửi →', data.type);
                this.ws.send(JSON.stringify(data));
                return true;
            } catch (err) {
                debugLog('error', 'Send error:', err);
                return false;
            }
        } else {
            debugLog('warn', 'Không gửi được', data.type, '- WS chưa mở hoặc không tồn tại');
            return false;
        }
    }

    // ===== Message Handling =====
    handleMessage(msg) {
        console.log('Received:', msg.type, msg);

        switch (msg.type) {
            case 'init':
                this.handleInit(msg);
                break;
            case 'joined':
                this.handleJoined(msg);
                break;
            case 'peer_joined':
                this.handlePeerJoined();
                break;
            case 'peer_left':
                this.handlePeerLeft(msg);
                break;
            case 'move':
                this.handleRemoteMove(msg);
                break;
            case 'move_rejected':
                this.handleMoveRejected(msg);
                break;
            case 'room-full':
                this.handleRoomFull();
                break;
            case 'session-takeover':
                this.handleSessionTakeover();
                break;
            case 'sync_banner':
                this.handleSyncBanner(msg);
                break;
            case 'sync':
                this.handleSync(msg);
                break;
            case 'sync_request':
                this.requestSync();
                break;
            case 'rematch_request':
                this.handleRematchRequest(msg);
                break;
            case 'rematch_accept':
                this.handleRematchAccept(msg);
                break;
            case 'rematch_accept_partial':
                this.handleRematchAcceptPartial(msg);
                break;
            case 'rematch_decline':
                this.handleRematchDecline(msg);
                break;
            case 'cheat_flagged':
                this.handleCheatFlagged(msg);
                break;
            case 'resign':
                this.handleResign();
                break;
            case 'game_over':
                this.handleRemoteGameOver(msg);
                break;
            case 'draw_offer':
                this.handleDrawOffer();
                break;
            case 'draw_accept':
                this.handleDrawAccept();
                break;
            case 'draw_decline':
                this.handleDrawDecline();
                break;
            case 'chat':
                // Optional: handle chat
                break;
            case 'ping':
                this.sendMessage({ type: 'pong', timestamp: msg.timestamp });
                break;
            case 'pong':
                if (msg.timestamp) {
                    this.lastPing = Date.now() - msg.timestamp;
                    this.updateConnDetail();
                }
                break;
        }
    }

    handleJoined(msg) {
        debugLog('info', 'Joined phòng: role =', msg.role, ', color =', msg.color, ', ván dở =', !!msg.game);
        this.myColor = msg.color;
        if (msg.role) {
            this.role = msg.role;
            this.isHost = msg.role === 'host';
        }

        // Server gửi kèm trạng thái rematch hiện tại (nếu có) — đồng bộ ngay
        if (msg.rematch) {
            this.rematchState = {
                requested: msg.rematch.status !== 'idle' && msg.rematch.status !== 'declined' && msg.rematch.status !== 'accepted_by_both',
                by: msg.rematch.requestedBy,
                status: msg.rematch.status,
                acceptedBy: msg.rematch.acceptedBy || []
            };
        }

        this.setConnState('connected', (this.isHost && !msg.game) ? 'Đang chờ đối thủ' : 'Đã kết nối');

        // Auto-sync: nếu server gửi game state sẵn (reconnect), không cần toast
        // thêm "đã nối lại ván cờ đang dở" nữa vì đã có sync banner xử lý.
        if (msg.game && msg.game.fen) {
            // Nối lại ván cờ đang dở (trạng thái server là nguồn sự thật)
            this.chess.load(msg.game.fen);
            this.moveHistory = msg.game.history || [];
            this.capturedPieces = this.deriveCaptured(this.moveHistory);
            this.gameActive = true;
            this.currentTurn = this.chess.turn();
            this.showPage('lobby-page', false);
            this.showPage('game-page', true);
            document.getElementById('self-color').textContent = this.myColor === 'w' ? 'Trắng' : 'Đen';
            document.getElementById('opponent-color').textContent = this.myColor === 'w' ? 'Đen' : 'Trắng';
            this.renderBoard();
            this.updateGameStatus();
            this.updateMoveList();
            this.updateCapturedPieces();
            this.updateTimerDisplay();
            this.startTimer();
            // Tính lastMoveInfo từ history cuối
            this.recomputeLastMoveInfo();
            this.updateMoveIndicators();
            // Nếu reconnect, server đã gửi sync_banner + sync message riêng
            if (msg.reconnect) {
                this.showSyncBanner('Đang khôi phục ván cờ...');
                // Backup: clear sau 3s nếu không nhận được sync
                if (this.syncBannerTimer) clearTimeout(this.syncBannerTimer);
                this.syncBannerTimer = setTimeout(() => this.hideSyncBanner(), 3000);
            } else {
                showToast('Đã nối lại ván cờ đang dở', 'info');
            }
        } else if (this.isHost && this.gameActive) {
            this.requestSync();
        }
        this.updateConnDetail();
    }

    handlePeerJoined() {
        debugLog('info', 'Đối thủ đã vào phòng');
        this.setConnState('connected', 'Đã kết nối');

        if (!this.isHost) {
            showToast('Đối thủ đã kết nối lại!', 'success');
        }

        if (this.isHost) {
            this.showPage('lobby-page', false);
            if (this.gameActive) {
                this.requestSync();
            } else {
                debugLog('info', 'Host gửi init cho guest');
                this.sendMessage({
                    type: 'init',
                    color: 'b',
                    settings: this.settings,
                    fen: this.chess.fen()
                });
                this.startGame();
            }
        }
        this.updateConnDetail();
    }

    handlePeerLeft(msg) {
        debugLog('warn', 'Đối thủ đã rời phòng', msg && msg.reason);
        // Server phân biệt rõ: 'disconnect' (đối thủ rời phòng, có thể do mất mạng).
        // Đây là trạng thái peer_left — khác với temp_disconnect (chính mình rớt mạng).
        this.disconnectReason = 'peer_left';
        this.setConnState('peer_left', 'Đối thủ đã rời phòng');

        if (this.gameActive) {
            this.showConnBanner('peer_left', 'Đối thủ đã ngắt kết nối',
                'Ván cờ được giữ nguyên. Bạn có thể chờ đối thủ vào lại.');
            this.stopTimer();
        }
        this.updateConnDetail();
    }

    handleMoveRejected(msg) {
        debugLog('error', 'Nước đi bị server từ chối:', msg && msg.reason);
        showToast('Nước đi bị từ chối: ' + (msg.reason === 'not_your_turn' ? 'chưa đến lượt bạn' : (msg.reason === 'rate_limit' ? 'đi quá nhanh' : 'không hợp lệ')), 'error');
        this.requestSync();
    }

    handleRoomFull() {
        // Phòng đầy: thử lại vài lần (server có thể đang dọn socket cũ).
        this.disconnectReason = 'room_full';
        this.setConnState('room_full', 'Phòng đang đầy');
        const hasSession = !!(this.roomId && this.role) || !!sessionStorage.getItem('pchess_room');
        if (hasSession && this.reconnectAttempts < 8) {
            this.reconnectAttempts++;
            this.showConnBanner('room_full', 'Phòng đang đầy',
                'Thử kết nối lại (' + this.reconnectAttempts + '/8)...');
            if (this.ws) {
                this.ws.onclose = null;
                try {
                    this.ws.close(1000, 'room-full');
                } catch (e) { /* ignore */ }
            }
            this.ws = null;
            setTimeout(() => this.scheduleReconnect(), CONFIG.RECONNECT_DELAY);
            return;
        }

        this.showConnBanner('room_full', 'Phòng đã đầy', 'Tối đa 2 người. Vui lòng tạo phòng mới.');
        this.cleanup();
        this.showPage('lobby-page', false);
        this.showPage('landing-page', true);
        sessionStorage.removeItem('pchess_room');
        this.updateConnDetail();
    }

    handleSessionTakeover() {
        // Phiên này đã bị thay thế bởi một kết nối cùng vai trò khác (thường là
        // người dùng mở lại trang sau khi mất mạng). Dừng ván và thoát gọn,
        // không tự reconnect vì socket mới đã nắm vai trò này.
        debugLog('warn', 'Phiên bị thay thế (session-takeover)');
        this.disconnectReason = 'takeover';
        this.setConnState('takeover', 'Phiên bị thay thế');
        this.showConnBanner('takeover', 'Phiên đã được mở ở nơi khác',
            'Tab này sẽ tự tắt để tránh xung đột.');
        if (this.ws) {
            this.ws.onclose = null;
            try {
                this.ws.close(1000, 'takeover');
            } catch (e) { /* ignore */ }
            this.ws = null;
        }
        this.wsOpen = false;
        this.stopTimer();
        this.cleanup();
        this.showPage('game-page', false);
        this.showPage('lobby-page', false);
        this.showPage('landing-page', true);
        sessionStorage.removeItem('pchess_room');
        this.updateConnDetail();
    }

    handleInit(msg) {
        // Guest receives init from host
        this.myColor = msg.color;
        this.settings = { ...this.settings, ...msg.settings };
        this.syncSettingsUI();
        this.applyTheme(this.settings.theme);

        if (msg.fen) {
            this.chess.load(msg.fen);
        }

        this.startGame();
        showToast('Đã vào phòng! Bạn chơi quân Đen.', 'success');
    }

    handleRemoteMove(msg) {
        // Anti-cheat: validate received move
        if (!msg.move || !msg.move.from || !msg.move.to) {
            showToast('Nước đi không hợp lệ từ đối thủ', 'error');
            return;
        }

        // Rate limit check
        const now = Date.now();
        if (now - this.lastMoveTime < CONFIG.MOVE_RATE_LIMIT) {
            console.warn('Move too fast, possible spam');
        }

        // Validate using chess.js
        const moveObj = {
            from: msg.move.from,
            to: msg.move.to,
            promotion: msg.move.promotion
        };

        const capturedPiece = this.chess.get(msg.move.to);
        const result = this.chess.move(moveObj);
        if (!result) {
            showToast('Nước đi bất hợp lệ, đồng bộ lại...', 'warning');
            this.requestSync();
            return;
        }

        // Move is valid, update UI
        this.lastMove = { from: msg.move.from, to: msg.move.to };
        // Track move info chi tiết cho indicators (last move / check / capture / promotion)
        this.lastMoveInfo = {
            san: result.san,
            from: msg.move.from,
            to: msg.move.to,
            color: result.color,
            captured: result.captured || null,
            isCastle: result.flags.includes('k') || result.flags.includes('q'),
            isPromotion: !!result.promotion,
            isCheck: false // set bên dưới sau khi kiểm tra
        };
        this.moveHistory.push(result.san);

        const opponentColor = this.myColor === 'w' ? 'b' : 'w';
        if (result.captured) {
            this.capturedPieces[opponentColor].push(result.captured);
            this.soundManager.play('capture');
        } else if (result.flags.includes('k') || result.flags.includes('q')) {
            this.soundManager.play('castle');
        } else if (result.promotion) {
            this.soundManager.play('promote');
        } else {
            this.soundManager.play('move');
        }

        this.updateGameStatus();
        this.renderBoard();
        this.animatePieceMove(msg.move.from, msg.move.to, capturedPiece);
        this.updateMoveList();
        this.updateCapturedPieces();

        // Switch timer
        this.currentTurn = this.chess.turn();
        this.startTimer();

        // Check for check/checkmate
        if (this.chess.in_check()) {
            this.soundManager.play('check');
            if (this.lastMoveInfo) this.lastMoveInfo.isCheck = true;
        }

        // Cập nhật indicators (last move / check / capture / promotion pending)
        this.updateMoveIndicators();

        if (this.chess.game_over()) {
            this.handleGameOver();
        }
    }

    handleSync(msg) {
        // Auto-sync khi WS mở lại: server gửi sync có source='reconnect' hoặc 'request'.
        // Clear sync banner khi nhận được.
        if (this.recoveringSync || msg.source === 'reconnect') {
            this.recoveringSync = false;
            this.hideSyncBanner();
            this.setConnState('connected', 'Đã đồng bộ');
        }
        if (msg.fen && msg.fen !== this.chess.fen()) {
            this.chess.load(msg.fen);
            this.moveHistory = msg.history || [];
            if (msg.captured) {
                this.capturedPieces = msg.captured;
            } else {
                this.capturedPieces = this.deriveCaptured(this.moveHistory);
            }
            this.currentTurn = this.chess.turn();
            this.renderBoard();
            this.updateMoveList();
            this.updateCapturedPieces();
            this.updateGameStatus();
            this.recomputeLastMoveInfo();
            this.updateMoveIndicators();

            if (msg.timers) {
                this.timers = msg.timers;
                this.updateTimerDisplay();
                this.startTimer();
            }

            if (msg.source !== 'reconnect') {
                showToast('Đã đồng bộ trạng thái game', 'info');
            }
        } else {
            // FEN giống nhau — vẫn clear banner nếu đang recovering
            if (this.recoveringSync) {
                this.hideSyncBanner();
                this.recoveringSync = false;
            }
        }
        this.updateConnDetail();
    }

    handleSyncBanner(msg) {
        // Server chủ động báo "đang khôi phục" — hiển thị banner.
        if (msg.state === 'restoring') {
            this.showSyncBanner('Đang khôi phục ván cờ từ server...');
        }
    }

    handleCheatFlagged(msg) {
        // Anti-cheat heuristic đã flag một player. Đây là audit-only, không
        // chặn realtime — chỉ hiển thị badge nhỏ để người chơi biết ván đang
        // được theo dõi.
        debugLog('warn', 'Cheat flag từ server:', msg);
        const isMe = msg.role === this.role;
        const reasonText = {
            fast_move_streak: 'chuỗi nước đi quá nhanh',
            uniform_move_timing: 'nhịp nước đi quá đều'
        }[msg.reason] || msg.reason;
        if (isMe) {
            showToast('Hệ thống phát hiện nhịp đi bất thường (' + reasonText + '). Ván đang được xem xét.', 'warning', 5000);
        } else {
            showToast('Đối thủ có dấu hiệu bất thường (' + reasonText + '). Ván đang được xem xét.', 'warning', 5000);
        }
    }

    deriveCaptured(history) {
        const captured = { w: [], b: [] };
        try {
            const ch = new Chess();
            for (const san of history) {
                const m = ch.move(san);
                if (m && m.captured) captured[m.color].push(m.captured);
            }
        } catch (e) {
            debugLog('warn', 'Không dựng lại captured được từ lịch sử:', e);
        }
        return captured;
    }

    requestSync() {
        if (this.isHost) {
            this.sendMessage({
                type: 'sync',
                fen: this.chess.fen(),
                history: this.moveHistory,
                captured: this.capturedPieces,
                timers: this.timers,
                turn: this.currentTurn
            });
        } else {
            this.sendMessage({ type: 'sync_request' });
        }
    }

    // ===== Game Flow =====
    startGame() {
        this.gameActive = true;
        this.showPage('lobby-page', false);
        this.showPage('game-page', true);

        // Update player info
        document.getElementById('self-color').textContent = this.myColor === 'w' ? 'Trắng' : 'Đen';
        document.getElementById('opponent-color').textContent = this.myColor === 'w' ? 'Đen' : 'Trắng';

        // Setup timer if enabled
        const timerMinutes = this.settings.timer || 0;
        if (timerMinutes > 0) {
            this.timers = { w: timerMinutes * 60, b: timerMinutes * 60 };
        }

        this.currentTurn = 'w';
        this.renderBoard();
        this.updateGameStatus();
        this.updateMoveList();

        if (this.isHost) {
            showToast('Ván cờ bắt đầu! Bạn đi trước (Trắng).', 'success');
        } else {
            showToast('Ván cờ bắt đầu! Chờ Trắng đi.', 'info');
        }

        this.startTimer();

        this.soundManager.play('notify');
    }

    // ===== Board Rendering =====
    renderBoard() {
        const board = document.getElementById('chess-board');
        board.innerHTML = '';

        const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        const ranks = ['8', '7', '6', '5', '4', '3', '2', '1'];

        // Determine orientation based on color + flip flag.
        // Mặc định xem từ góc nhìn myColor. Khi boardFlipped = true, lật 180 độ
        // để xem từ góc nhìn đối thủ (hữu ích khi phân tích sau ván).
        const baseFiles = this.myColor === 'w' ? files : [...files].reverse();
        const baseRanks = this.myColor === 'w' ? ranks : [...ranks].reverse();
        const displayFiles = this.boardFlipped ? [...baseFiles].reverse() : baseFiles;
        const displayRanks = this.boardFlipped ? [...baseRanks].reverse() : baseRanks;

        for (let r = 0; r < 8; r++) {
            for (let f = 0; f < 8; f++) {
                const square = document.createElement('div');
                const file = displayFiles[f];
                const rank = displayRanks[r];
                const squareName = file + rank;
                const isLight = (r + f) % 2 === 0;

                square.className = `square ${isLight ? 'light' : 'dark'}`;
                square.dataset.square = squareName;

                // Piece
                const piece = this.chess.get(squareName);
                if (piece) {
                    const pieceEl = document.createElement('img');
                    pieceEl.className = `piece ${piece.color} piece-img`;
                    pieceEl.src = getPieceUrl(piece.color, piece.type);
                    pieceEl.alt = piece.color + piece.type;
                    pieceEl.draggable = false;

                    const canDrag = this.gameActive && !this.pendingPromotion &&
                        this.chess.turn() === this.myColor && piece.color === this.myColor;
                    if (canDrag) {
                        pieceEl.draggable = true;
                        pieceEl.addEventListener('dragstart', (e) => {
                            this.dragFrom = squareName;
                            this.selectedSquare = squareName;
                            this.validMoves = this.getValidMoves(squareName);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', squareName);
                            // Drag image ghost = piece itself (mặc định đã OK)
                            this.renderBoard(); // hiển thị ô hợp lệ ngay khi bắt đầu drag
                        });
                        pieceEl.addEventListener('dragend', () => {
                            this.dragFrom = null;
                            this.previewSquare = null;
                            this.clearSelection();
                        });
                        // Move preview khi rê chuột trên bàn cờ (hover ghost)
                        pieceEl.addEventListener('mouseenter', () => {
                            if (!this.gameActive) return;
                            // Không can thiệp khi đang drag (trình duyệt tự vẽ)
                        });
                    }

                    square.appendChild(pieceEl);
                }

                // Coordinates
                if (this.settings.coords) {
                    if (f === 0) {
                        const rankCoord = document.createElement('span');
                        rankCoord.className = 'coord rank';
                        rankCoord.textContent = rank;
                        square.appendChild(rankCoord);
                    }
                    if (r === 7) {
                        const fileCoord = document.createElement('span');
                        fileCoord.className = 'coord file';
                        fileCoord.textContent = file;
                        square.appendChild(fileCoord);
                    }
                }

                // Highlights
                if (this.selectedSquare === squareName) {
                    square.classList.add('selected');
                }
                if (this.lastMove) {
                    if (squareName === this.lastMove.from || squareName === this.lastMove.to) {
                        square.classList.add('last-move');
                    }
                }

                // Valid moves highlight — rõ hơn trên mobile (chấm tròn lớn + viền đỏ khi ăn)
                if (this.validMoves.includes(squareName)) {
                    const targetPiece = this.chess.get(squareName);
                    if (targetPiece && targetPiece.color !== this.myColor) {
                        square.classList.add('valid-capture');
                    } else {
                        square.classList.add('valid-move');
                    }
                }

                // Move preview (ghost) khi rê chuột và đang có ô đích hợp lệ
                if (this.dragFrom && this.previewSquare === squareName && this.validMoves.includes(squareName)) {
                    square.classList.add('preview-target');
                    // Ghost piece nhỏ ở ô đích
                    const piece = this.chess.get(this.dragFrom);
                    if (piece) {
                        const ghost = document.createElement('img');
                        ghost.className = 'piece piece-ghost';
                        ghost.src = getPieceUrl(piece.color, piece.type);
                        ghost.alt = '';
                        ghost.style.opacity = '0.5';
                        square.appendChild(ghost);
                    }
                }

                // Check highlight
                if (this.chess.in_check()) {
                    const kingSquare = this.findKing(this.chess.turn());
                    if (kingSquare === squareName) {
                        square.classList.add('check');
                    }
                }

                square.addEventListener('click', () => this.handleSquareClick(squareName));
                square.addEventListener('dragover', (e) => {
                    if (this.dragFrom) {
                        e.preventDefault();
                        // Cập nhật preview khi hover
                        if (this.previewSquare !== squareName) {
                            this.previewSquare = squareName;
                            // Chỉ re-render partial (update ghost) — nhưng vì board
                            // nhỏ, re-render cả board vẫn OK về perf.
                            this.renderBoard();
                        }
                    }
                });
                square.addEventListener('dragleave', () => {
                    if (this.previewSquare === squareName) {
                        this.previewSquare = null;
                    }
                });
                square.addEventListener('drop', (e) => {
                    e.preventDefault();
                    if (!this.dragFrom) return;
                    if (this.validMoves.includes(squareName)) {
                        this.attemptMove(this.dragFrom, squareName);
                    } else {
                        this.clearSelection();
                    }
                    this.dragFrom = null;
                    this.previewSquare = null;
                });
                board.appendChild(square);
            }
        }
    }

    findKing(color) {
        const board = this.chess.board();
        for (let r = 0; r < 8; r++) {
            for (let f = 0; f < 8; f++) {
                const piece = board[r][f];
                if (piece && piece.type === 'k' && piece.color === color) {
                    const files = 'abcdefgh';
                    const ranks = '87654321';
                    return files[f] + ranks[r];
                }
            }
        }
        return null;
    }

    animatePieceMove(from, to, captured) {
        if (this.settings.animation === false) return;
        const fromEl = document.querySelector(`.square[data-square="${from}"]`);
        const toEl = document.querySelector(`.square[data-square="${to}"]`);
        if (!fromEl || !toEl) return;

        // Nhấp nháy ô đích
        toEl.classList.add(captured ? 'capture-flash' : 'move-flash');
        setTimeout(() => {
            toEl.classList.remove('capture-flash', 'move-flash');
        }, 350);

        // Trượt quân từ ô `from` về ô `to` (toạ độ màn hình, không phụ thuộc xoay bàn)
        const piece = toEl.querySelector('.piece-img');
        if (!piece || typeof piece.animate !== 'function') return;
        const r1 = fromEl.getBoundingClientRect();
        const r2 = toEl.getBoundingClientRect();
        const dx = r1.left - r2.left;
        const dy = r1.top - r2.top;
        piece.animate(
            [
                { transform: `translate(${dx}px, ${dy}px)` },
                { transform: 'translate(0px, 0px)' }
            ],
            { duration: 180, easing: 'cubic-bezier(0.2, 0.6, 0.35, 1)' }
        );
    }

    // ===== Move Handling =====
    handleSquareClick(square) {
        if (!this.gameActive) return;
        if (this.chess.turn() !== this.myColor) return; // Not your turn
        if (this.pendingPromotion) return;

        const piece = this.chess.get(square);

        // If a square is already selected
        if (this.selectedSquare) {
            // Clicking same square deselects
            if (this.selectedSquare === square) {
                this.clearSelection();
                return;
            }

            // Try to move
            if (this.validMoves.includes(square)) {
                this.attemptMove(this.selectedSquare, square);
                return;
            }

            // Clicking another of own pieces selects it
            if (piece && piece.color === this.myColor) {
                this.selectSquare(square);
                return;
            }

            this.clearSelection();
            return;
        }

        // Select own piece
        if (piece && piece.color === this.myColor) {
            this.selectSquare(square);
        }
    }

    selectSquare(square) {
        this.selectedSquare = square;
        this.validMoves = this.getValidMoves(square);
        this.renderBoard();
    }

    clearSelection() {
        this.selectedSquare = null;
        this.validMoves = [];
        this.renderBoard();
    }

    getValidMoves(square) {
        const moves = this.chess.moves({ square: square, verbose: true });
        return moves.map(m => m.to);
    }

    attemptMove(from, to) {
        // Check if promotion
        const piece = this.chess.get(from);
        if (piece && piece.type === 'p') {
            const targetRank = to.charAt(1);
            if ((piece.color === 'w' && targetRank === '8') || 
                (piece.color === 'b' && targetRank === '1')) {
                if (this.settings.promotion === 'ask') {
                    this.pendingPromotion = { from, to };
                    this.showPromotionModal(piece.color);
                    return;
                }
            }
        }

        this.executeMove(from, to, 'q');
    }

    showPromotionModal(color) {
        const modal = document.getElementById('promotion-modal');
        const pieces = modal.querySelectorAll('.promotion-piece');
        pieces.forEach(p => {
            const type = p.dataset.piece;
            p.innerHTML = `<img src="${getPieceUrl(color, type)}" alt="${color}${type}">`;
        });
        modal.classList.remove('hidden');
    }

    completePromotion(pieceType) {
        if (!this.pendingPromotion) return;

        document.getElementById('promotion-modal').classList.add('hidden');
        this.executeMove(this.pendingPromotion.from, this.pendingPromotion.to, pieceType);
        this.pendingPromotion = null;
    }

    executeMove(from, to, promotion = 'q') {
        if (!this.gameActive) return;

        // Rate limiting (chỉ cảnh báo, server mới quyết định)
        const now = Date.now();
        if (now - this.lastMoveTime < CONFIG.MOVE_RATE_LIMIT) {
            console.warn('Move rate limit warning');
        }
        this.lastMoveTime = now;

        // Server-authoritative: gửi lên server, server validate + broadcast
        // nước đi hợp lệ. Không tự áp dụng nước đi ở client.
        this.sendMessage({
            type: 'move',
            move: { from, to, promotion }
        });

        this.clearSelection();
    }

    // ===== Game Status & Timer =====
    updateGameStatus() {
        const statusEl = document.getElementById('game-status');
        if (!statusEl) return;
        const indicator = statusEl.querySelector('.status-indicator');
        const text = statusEl.querySelector('.status-text');

        if (this.gameResult || this.chess.game_over()) {
            text.textContent = 'Kết thúc';
            indicator.className = 'status-indicator ended';
            statusEl.dataset.state = 'ended';
            return;
        }

        if (!this.gameActive) {
            text.textContent = 'Chưa bắt đầu';
            indicator.className = 'status-indicator idle';
            statusEl.dataset.state = 'idle';
            return;
        }

        // Nếu WS chưa mở / đang reconnect -> ưu tiên hiển thị trạng thái kết nối
        if (!this.wsOpen) {
            text.textContent = '⚠ Mất kết nối — đang chờ đồng bộ';
            indicator.className = 'status-indicator disconnected';
            statusEl.dataset.state = 'disconnected';
            return;
        }

        const myTurn = this.chess.turn() === this.myColor;
        const inCheck = this.chess.in_check();

        if (inCheck) {
            text.textContent = myTurn ? '⚠️ Bạn đang bị chiếu!' : 'Đối thủ đang bị chiếu';
            indicator.className = 'status-indicator check';
            statusEl.dataset.state = myTurn ? 'my-check' : 'opp-check';
        } else if (myTurn) {
            text.textContent = '🎯 Đến lượt bạn';
            indicator.className = 'status-indicator your-turn';
            statusEl.dataset.state = 'your-turn';
        } else {
            text.textContent = '⏳ Đang chờ đối thủ...';
            indicator.className = 'status-indicator opponent-turn';
            statusEl.dataset.state = 'opponent-turn';
        }
    }

    startTimer() {
        this.stopTimer();
        if (this.settings.timer <= 0) return;

        this.timerInterval = setInterval(() => {
            if (!this.gameActive) return;

            this.timers[this.currentTurn]--;
            this.updateTimerDisplay();

            if (this.timers[this.currentTurn] <= 0) {
                this.stopTimer();
                this.handleTimeout();
            }
        }, 1000);
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    updateTimerDisplay() {
        const formatTime = (seconds) => {
            if (seconds <= 0) return '00:00';
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        };

        const selfTimer = document.getElementById('self-timer');
        const oppTimer = document.getElementById('opponent-timer');

        if (this.settings.timer <= 0) {
            selfTimer.textContent = '--:--';
            oppTimer.textContent = '--:--';
            return;
        }

        const selfTime = this.timers[this.myColor] || 0;
        const oppTime = this.timers[this.myColor === 'w' ? 'b' : 'w'] || 0;

        selfTimer.textContent = formatTime(selfTime);
        oppTimer.textContent = formatTime(oppTime);

        // Warning when low on time
        if (selfTime <= 30) {
            selfTimer.classList.add('warning');
        } else {
            selfTimer.classList.remove('warning');
        }

        // Âm thanh nhắc hết giờ (1 lần)
        if (selfTime === 10 && this._lowWarned !== this.currentTurn) {
            this._lowWarned = this.currentTurn;
            this.soundManager.play('lowtime');
        } else if (selfTime > 10) {
            this._lowWarned = null;
        }
    }

    handleTimeout() {
        const loser = this.currentTurn;
        const winner = loser === 'w' ? 'b' : 'w';
        this.soundManager.play('flag');
        this.sendMessage({
            type: 'game_over',
            reason: 'timeout',
            winner: winner
        });
        this.gameResult = {
            winner: winner,
            reason: 'timeout',
            message: loser === this.myColor ? 'Bạn hết giờ!' : 'Đối thủ hết giờ!'
        };
        this.endGame();
    }

    handleRemoteGameOver(msg) {
        if (!this.gameActive) return;

        if (msg.reason === 'timeout') {
            this.gameResult = {
                winner: msg.winner,
                reason: 'timeout',
                message: msg.winner === this.myColor ? 'Đối thủ hết giờ!' : 'Bạn hết giờ!'
            };
            this.soundManager.play('error');
            this.endGame();
        }
    }

    // ===== Game Over =====
    handleGameOver() {
        let result = {};

        if (this.chess.in_checkmate()) {
            const winner = this.chess.turn() === 'w' ? 'b' : 'w';
            result = {
                winner: winner,
                reason: 'checkmate',
                message: winner === this.myColor ? 'Bạn thắng bằng chiếu hết!' : 'Bạn thua bằng chiếu hết!'
            };
            this.soundManager.play('checkmate');
        } else if (this.chess.in_stalemate()) {
            result = { winner: null, reason: 'stalemate', message: 'Hòa do hết nước đi (Stalemate)' };
            this.soundManager.play('draw');
        } else if (this.chess.in_threefold_repetition()) {
            result = { winner: null, reason: 'repetition', message: 'Hòa do lặp lại 3 lần' };
            this.soundManager.play('draw');
        } else if (this.chess.insufficient_material()) {
            result = { winner: null, reason: 'insufficient', message: 'Hòa do không đủ quân để chiếu hết' };
            this.soundManager.play('draw');
        } else if (this.chess.in_draw()) {
            result = { winner: null, reason: 'draw', message: 'Hòa' };
            this.soundManager.play('draw');
        }

        this.gameResult = result;
        this.endGame();
    }

    endGame() {
        this.gameActive = false;
        this.stopTimer();
        document.getElementById('draw-modal').classList.add('hidden');
        this.updateGameStatus();

        const modal = document.getElementById('gameover-modal');
        const icon = document.getElementById('gameover-icon');
        const title = document.getElementById('gameover-title');
        const message = document.getElementById('gameover-message');

        if (this.gameResult.winner === this.myColor) {
            icon.textContent = '🏆';
            title.textContent = 'Chiến thắng!';
            title.style.color = 'var(--success)';
        } else if (this.gameResult.winner === null) {
            icon.textContent = '🤝';
            title.textContent = 'Hòa!';
            title.style.color = 'var(--accent)';
        } else {
            icon.textContent = '💔';
            title.textContent = 'Thua cuộc';
            title.style.color = 'var(--danger)';
        }

        message.textContent = this.gameResult.message;
        modal.classList.remove('hidden');
    }

    // ===== Analysis & PGN =====
    startAnalysis() {
        document.getElementById('gameover-modal').classList.add('hidden');
        const moves = this.moveHistory || [];
        const result = this.gameResult || { winner: null, reason: 'game', message: '*' };
        Analysis.startFromGame(moves, result);
        this.showPage('game-page', false);
        this.showPage('analysis-page', true);
    }

    buildPgn(moves, result) {
        const resultTag = result && result.winner === 'w' ? '1-0' :
            (result && result.winner === 'b' ? '0-1' : (result && result.winner === null ? '1/2-1/2' : '*'));
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '.');
        let movesStr = '';
        for (let i = 0; i < moves.length; i++) {
            if (i % 2 === 0) movesStr += (i / 2 + 1) + '. ';
            movesStr += moves[i] + ' ';
        }
        movesStr += resultTag;
        return [
            '[Event "PChess"]',
            '[Site "PChess"]',
            '[Date "' + dateStr + '"]',
            '[Round "-"]',
            '[White "Player 1"]',
            '[Black "Player 2"]',
            '[Result "' + resultTag + '"]',
            '',
            movesStr
        ].join('\n');
    }

    exportPgn() {
        const pgn = this.buildPgn(this.moveHistory || [], this.gameResult || null);
        this.copyTextToClipboard(pgn);
        showToast('Đã copy PGN vào clipboard', 'success');
    }

    copyTextToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {});
            return;
        }
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }

    // ===== Rematch (state machine client-side matching server) =====
    requestRematch() {
        document.getElementById('gameover-modal').classList.add('hidden');
        this.rematchState = { requested: true, by: this.role, status: 'requested', acceptedBy: [this.role] };
        this.sendMessage({ type: 'rematch_request' });
        showToast('Đã gửi yêu cầu chơi lại. Chờ đối thủ đồng ý.', 'info');
    }

    handleRematchRequest(msg) {
        // Đối thủ yêu cầu chơi lại. Server gửi kèm `by` để biết ai yêu cầu.
        this.rematchState = {
            requested: true,
            by: msg.by || 'opponent',
            status: 'requested',
            acceptedBy: [msg.by]
        };
        document.getElementById('rematch-modal').classList.remove('hidden');
        this.soundManager.play('notify');
    }

    acceptRematch() {
        document.getElementById('rematch-modal').classList.add('hidden');
        this.sendMessage({ type: 'rematch_accept' });
        // KHÔNG resetGame() ngay — đợi server confirm 'rematch_accept' (broadcast
        // khi cả hai đã accept). Trước đây client tự reset ngay khi nhận 1
        // accept, dẫn đến state lệch nếu message đến không đúng thứ tự.
        showToast('Đã đồng ý chơi lại. Chờ đối thủ xác nhận...', 'info');
    }

    handleRematchAcceptPartial(msg) {
        // Server báo: đối thủ đã accept nhưng bản thân chưa (hoặc ngược lại).
        // Hiển thị tiến trình để người chơi biết đang chờ ai.
        const acceptedBy = msg.acceptedBy || (msg.by ? [msg.by] : []);
        this.rematchState.status = msg.status || 'requested';
        this.rematchState.acceptedBy = acceptedBy;
        const me = this.role;
        const them = this.role === 'host' ? 'guest' : 'host';
        const meAccepted = acceptedBy.includes(me);
        const themAccepted = acceptedBy.includes(them);
        if (meAccepted && !themAccepted) {
            showToast('Bạn đã đồng ý. Đang chờ đối thủ...', 'info');
        } else if (themAccepted && !meAccepted) {
            // Đối thủ đã đồng ý trước — popup hỏi lại để mình bấm accept.
            document.getElementById('rematch-modal').classList.remove('hidden');
            showToast('Đối thủ muốn chơi lại. Hãy xác nhận.', 'info');
        }
    }

    handleRematchAccept(msg) {
        // Server broadcast 'rematch_accept' khi CẢ HAI đã đồng ý -> reset game.
        this.resetGame();
        showToast('Đối thủ đồng ý chơi lại!', 'success');
    }

    handleRematchDecline(msg) {
        this.rematchState = { requested: false, by: null, status: 'idle', acceptedBy: [] };
        document.getElementById('rematch-modal').classList.add('hidden');
        showToast('Đối thủ từ chối chơi lại', 'warning');
    }

    declineRematch() {
        document.getElementById('rematch-modal').classList.add('hidden');
        this.sendMessage({ type: 'rematch_decline' });
        this.rematchState = { requested: false, by: null, status: 'idle', acceptedBy: [] };
        showToast('Đã từ chối chơi lại', 'info');
    }

    resetGame() {
        // Reset chess engine
        this.chess.reset();

        // Reset state
        this.gameActive = true;
        this.moveHistory = [];
        this.capturedPieces = { w: [], b: [] };
        this.lastMove = null;
        this.lastMoveInfo = null;
        this.selectedSquare = null;
        this.validMoves = [];
        this.currentTurn = 'w';
        this.gameResult = null;
        this.rematchState = { requested: false, by: null, status: 'idle', acceptedBy: [] };
        this.pendingPromotion = null;

        // Reset timer
        const timerMinutes = this.settings.timer || 0;
        if (timerMinutes > 0) {
            this.timers = { w: timerMinutes * 60, b: timerMinutes * 60 };
        }

        // Hide modals
        document.getElementById('gameover-modal').classList.add('hidden');
        document.getElementById('rematch-modal').classList.add('hidden');
        document.getElementById('draw-modal').classList.add('hidden');

        // Update UI
        this.renderBoard();
        this.updateGameStatus();
        this.updateMoveList();
        this.updateCapturedPieces();
        this.updateTimerDisplay();
        this.updateMoveIndicators();

        // Start timer for the side to move (both players run clocks locally)
        this.startTimer();

        this.soundManager.play('notify');
        showToast('Ván cờ mới bắt đầu!', 'success');
    }

    // ===== Resign & Draw =====
    resign() {
        if (!this.gameActive) return;

        if (!confirm('Bạn có chắc muốn đầu hàng?')) return;

        const sent = this.sendMessage({ type: 'resign' });
        if (!sent) {
            showToast('Mất kết nối, không gửi được yêu cầu đầu hàng', 'error');
            return;
        }
        this.gameResult = {
            winner: this.myColor === 'w' ? 'b' : 'w',
            reason: 'resign',
            message: 'Bạn đã đầu hàng'
        };
        this.endGame();
        this.closeModal(document.getElementById('menu-modal'));
    }

    handleResign() {
        if (!this.gameActive) return;
        this.gameResult = {
            winner: this.myColor,
            reason: 'resign',
            message: 'Đối thủ đã đầu hàng'
        };
        this.endGame();
        showToast('Đối thủ đã đầu hàng!', 'success');
    }

    offerDraw() {
        if (!this.gameActive) return;
        const sent = this.sendMessage({ type: 'draw_offer' });
        if (sent) {
            showToast('Đã gửi đề nghị hòa', 'info');
        } else {
            showToast('Mất kết nối, không gửi được đề nghị hòa', 'error');
        }
        this.closeModal(document.getElementById('menu-modal'));
    }

    handleDrawOffer() {
        if (!this.gameActive) return;
        document.getElementById('draw-modal').classList.remove('hidden');
        this.soundManager.play('notify');
    }

    acceptDrawOffer() {
        document.getElementById('draw-modal').classList.add('hidden');
        if (!this.gameActive) return;
        this.sendMessage({ type: 'draw_accept' });
        this.gameResult = { winner: null, reason: 'agreement', message: 'Hòa theo thỏa thuận' };
        this.endGame();
    }

    declineDrawOffer() {
        document.getElementById('draw-modal').classList.add('hidden');
        this.sendMessage({ type: 'draw_decline' });
        showToast('Đã từ chối hòa', 'info');
    }

    handleDrawAccept() {
        document.getElementById('draw-modal').classList.add('hidden');
        this.gameResult = { winner: null, reason: 'agreement', message: 'Hòa theo thỏa thuận' };
        this.endGame();
        showToast('Đối thủ đồng ý hòa', 'info');
    }

    handleDrawDecline() {
        document.getElementById('draw-modal').classList.add('hidden');
        showToast('Đối thủ từ chối hòa', 'warning');
    }

    // ===== UI Updates =====
    updateMoveList() {
        const list = document.getElementById('move-list');
        list.innerHTML = '';

        for (let i = 0; i < this.moveHistory.length; i += 2) {
            const num = Math.floor(i / 2) + 1;
            const white = this.moveHistory[i] || '';
            const black = this.moveHistory[i + 1] || '';

            const numEl = document.createElement('span');
            numEl.className = 'move-number';
            numEl.textContent = num + '.';
            list.appendChild(numEl);

            const whiteEl = document.createElement('span');
            whiteEl.className = 'move-white';
            whiteEl.textContent = white;
            if (i === this.moveHistory.length - 1 && white) whiteEl.classList.add('move-current');
            list.appendChild(whiteEl);

            if (black) {
                const blackEl = document.createElement('span');
                blackEl.className = 'move-black';
                blackEl.textContent = black;
                if (i + 1 === this.moveHistory.length - 1) blackEl.classList.add('move-current');
                list.appendChild(blackEl);
            } else {
                list.appendChild(document.createElement('span'));
            }
        }

        // Auto scroll to bottom
        const container = list.parentElement;
        container.scrollTop = container.scrollHeight;
    }

    updateCapturedPieces() {
        const selfContainer = document.getElementById('captured-by-self');
        const oppContainer = document.getElementById('captured-by-opponent');

        const selfColor = this.myColor;
        const oppColor = selfColor === 'w' ? 'b' : 'w';

        selfContainer.innerHTML = this.capturedPieces[selfColor]
            .map(p => `<img class="captured-piece" src="${getPieceUrl(oppColor, p)}" alt="${oppColor}${p}">`)
            .join('');

        oppContainer.innerHTML = this.capturedPieces[oppColor]
            .map(p => `<img class="captured-piece" src="${getPieceUrl(selfColor, p)}" alt="${selfColor}${p}">`)
            .join('');
    }

    // ===== Settings & Theme =====
    loadSettings() {
        const defaults = {
            theme: 'classic',
            promotion: 'auto',
            sound: true,
            animation: true,
            coords: false,
            timer: 0,
            engine: 'auto'
        };

        try {
            const saved = localStorage.getItem('pchess_settings');
            if (saved) return { ...defaults, ...JSON.parse(saved) };
        } catch (e) {
            console.warn('Failed to load settings');
        }
        return defaults;
    }

    saveSettings() {
        try {
            localStorage.setItem('pchess_settings', JSON.stringify(this.settings));
        } catch (e) {
            console.warn('Failed to save settings');
        }
    }

    applyTheme(theme) {
        document.documentElement.dataset.theme = theme;
        this.settings.theme = theme;
        this.saveSettings();
    }

    changeTheme(theme) {
        this.applyTheme(theme);
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === theme);
        });
    }

    openSettings() {
        document.getElementById('settings-modal').classList.remove('hidden');
    }

    openMenu() {
        document.getElementById('menu-modal').classList.remove('hidden');
    }

    closeModal(modal) {
        if (modal) modal.classList.add('hidden');
    }

    // ===== Navigation =====
    showPage(pageId, show) {
        const page = document.getElementById(pageId);
        if (page) {
            page.classList.toggle('active', show);
        }
    }

    leaveRoom() {
        this.cleanup();
        sessionStorage.removeItem('pchess_room');
        window.location.hash = '';
        location.reload();
    }

    cleanup() {
        this.stopTimer();
        this.stopHeartbeat();
        if (this.ws) {
            try {
                this.ws.close();
            } catch (e) {
                // ignore
            }
            this.ws = null;
        }
        this.wsOpen = false;
    }

    handleResize() {
        // Responsive adjustments:
        // - Trên mobile (< 768px), panel sẽ tự chuyển sang dạng slide-up.
        // - Ẩn các tab không cần thiết để tiết kiệm không gian.
        // - Không cần làm gì thêm vì CSS đã xử lý phần lớn qua media queries.
        // Chỉ log để debug.
        if (window.innerWidth < 768) {
            debugLog('info', 'Mobile layout active, innerWidth =', window.innerWidth);
        }
    }

    // ===== Sync / Connection Banner =====
    showSyncBanner(text) {
        const banner = document.getElementById('sync-banner');
        if (!banner) return;
        const textEl = banner.querySelector('.sync-text');
        if (textEl) textEl.textContent = text || 'Đang khôi phục ván cờ...';
        banner.classList.remove('hidden');
        // Force reflow để animation chạy
        void banner.offsetWidth;
        banner.classList.add('visible');
    }

    hideSyncBanner() {
        const banner = document.getElementById('sync-banner');
        if (!banner) return;
        banner.classList.remove('visible');
        // Đợi animation kết thúc rồi mới ẩn hẳn
        setTimeout(() => {
            if (!banner.classList.contains('visible')) {
                banner.classList.add('hidden');
            }
        }, 300);
        if (this.syncBannerTimer) {
            clearTimeout(this.syncBannerTimer);
            this.syncBannerTimer = null;
        }
    }

    // Connection banner: hiển thị lý do mất kết nối rõ ràng (temp/room_full/takeover/peer_left)
    showConnBanner(reason, title, detail) {
        const banner = document.getElementById('conn-banner');
        if (!banner) return;
        banner.className = 'conn-banner visible ' + reason;
        const textEl = banner.querySelector('.conn-text');
        const detailEl = banner.querySelector('.conn-detail');
        if (textEl) textEl.textContent = title || '';
        if (detailEl) detailEl.textContent = detail || '';
        banner.classList.remove('hidden');
        // Tự ẩn sau 6s nếu không phải trạng thái cuối (takeover thì giữ lâu hơn)
        if (this.connBannerTimer) clearTimeout(this.connBannerTimer);
        const timeout = reason === 'takeover' ? 10000 : 6000;
        this.connBannerTimer = setTimeout(() => {
            // Chỉ ẩn nếu trạng thái hiện tại đã resolved
            if (this.wsOpen || reason === 'takeover') {
                banner.classList.remove('visible');
                setTimeout(() => banner.classList.add('hidden'), 300);
            }
        }, timeout);
    }

    hideConnBanner() {
        const banner = document.getElementById('conn-banner');
        if (!banner) return;
        banner.classList.remove('visible');
        setTimeout(() => banner.classList.add('hidden'), 300);
        if (this.connBannerTimer) {
            clearTimeout(this.connBannerTimer);
            this.connBannerTimer = null;
        }
    }

    // Connection state setter — cập nhật cả status dot + text + detail list
    setConnState(state, text) {
        const dot = document.querySelector('.status-dot');
        if (dot) {
            dot.classList.remove('connected', 'disconnected', 'peer_left', 'room_full', 'takeover');
            if (state === 'connected') dot.classList.add('connected');
            else if (state === 'disconnected') dot.classList.add('disconnected');
            else if (state === 'peer_left') dot.classList.add('peer_left');
            else if (state === 'room_full') dot.classList.add('room_full');
            else if (state === 'takeover') dot.classList.add('takeover');
        }
        const badge = document.querySelector('#connection-badge .badge-text');
        if (badge) {
            badge.textContent = ({
                connected: 'Đã kết nối',
                disconnected: 'Mất kết nối',
                peer_left: 'Đối thủ rời phòng',
                room_full: 'Phòng đầy',
                takeover: 'Phiên bị thay thế'
            })[state] || 'Server';
        }
        const connText = document.getElementById('connection-text');
        if (connText && text) connText.textContent = text;

        // Ẩn conn banner khi đã kết nối lại
        if (state === 'connected') this.hideConnBanner();

        // Cập nhật detail list
        const detailState = document.getElementById('conn-detail-state');
        if (detailState && text) detailState.textContent = text;

        // Cập nhật game status (nếu mất kết nối, hiển thị rõ trên header)
        this.updateGameStatus();
    }

    updateConnDetail() {
        const pingEl = document.getElementById('conn-detail-ping');
        if (pingEl) pingEl.textContent = this.lastPing != null ? (this.lastPing + ' ms') : '—';
        const roomEl = document.getElementById('conn-detail-room');
        if (roomEl) roomEl.textContent = this.roomId || '—';
        const roleEl = document.getElementById('conn-detail-role');
        if (roleEl) roleEl.textContent = this.role ? (this.role === 'host' ? 'Host (Trắng)' : 'Guest (Đen)') : '—';
    }

    // ===== Move Indicators (last move / check / capture / promotion pending) =====
    recomputeLastMoveInfo() {
        // Khi sync từ server, không có event "move" riêng — phải tính lại
        // lastMoveInfo từ history cuối cùng.
        if (!this.moveHistory.length) {
            this.lastMoveInfo = null;
            return;
        }
        try {
            const ch = new Chess();
            for (const san of this.moveHistory) ch.move(san);
            const verbose = ch.history({ verbose: true });
            const last = verbose[verbose.length - 1];
            if (!last) { this.lastMoveInfo = null; return; }
            this.lastMoveInfo = {
                san: last.san,
                from: last.from,
                to: last.to,
                color: last.color,
                captured: last.captured || null,
                isCastle: last.flags.includes('k') || last.flags.includes('q'),
                isPromotion: !!last.promotion,
                isCheck: ch.in_check()
            };
        } catch (e) {
            this.lastMoveInfo = null;
        }
    }

    updateMoveIndicators() {
        const lastEl = document.getElementById('mi-last');
        const checkEl = document.getElementById('mi-check');
        const captureEl = document.getElementById('mi-capture');
        const promoEl = document.getElementById('mi-promotion');
        if (!lastEl) return;

        // Last move
        const lastVal = lastEl.querySelector('.mi-value');
        if (this.lastMoveInfo && this.lastMoveInfo.san) {
            if (lastVal) lastVal.textContent = this.lastMoveInfo.san;
            lastEl.classList.remove('hidden');
        } else {
            if (lastVal) lastVal.textContent = '—';
        }

        // Check indicator
        const inCheck = this.chess.in_check && this.chess.in_check();
        if (checkEl) checkEl.classList.toggle('hidden', !inCheck);

        // Capture indicator (chỉ hiển thị khi nước vừa đi có ăn quân)
        if (captureEl) captureEl.classList.toggle('hidden', !(this.lastMoveInfo && this.lastMoveInfo.captured));

        // Promotion pending indicator
        if (promoEl) promoEl.classList.toggle('hidden', !this.pendingPromotion);
    }

    // ===== Flip board =====
    flipBoard() {
        this.boardFlipped = !this.boardFlipped;
        this.renderBoard();
        showToast(this.boardFlipped ? 'Đã lật bàn cờ' : 'Đã trở lại góc nhìn mặc định', 'info', 1500);
    }

    // ===== Mobile panel tabs =====
    switchPanelTab(tab) {
        this.activePanelTab = tab;
        document.querySelectorAll('.panel-tab[data-tab]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        document.querySelectorAll('.game-panel .panel-section').forEach(section => {
            section.classList.toggle('active', section.dataset.section === tab);
        });
        // Mở rộng panel nếu đang collapse
        const panel = document.getElementById('game-panel');
        if (panel) panel.classList.remove('collapsed');
    }

    togglePanelCollapse() {
        const panel = document.getElementById('game-panel');
        if (!panel) return;
        panel.classList.toggle('collapsed');
        const btn = document.getElementById('panel-tab-collapse');
        if (btn) btn.textContent = panel.classList.contains('collapsed') ? '▲' : '▼';
    }

    // ===== Keyboard shortcuts =====
    handleKeyDown(e) {
        // Bỏ qua nếu đang gõ trong input/textarea/select
        const target = e.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
            return;
        }
        // Bỏ qua nếu đang mở modal
        const anyModalOpen = document.querySelector('.modal:not(.hidden)');
        if (anyModalOpen) {
            // Enter = xác nhận nút chính trong modal (promotion/rematch/draw)
            if (e.key === 'Enter') {
                // Tìm nút primary trong modal đang mở và click
                const primary = anyModalOpen.querySelector('.btn-primary');
                if (primary) {
                    e.preventDefault();
                    primary.click();
                }
            }
            return;
        }

        // Phím tắt cho Analysis page
        const analysisActive = document.getElementById('analysis-page').classList.contains('active');
        if (analysisActive && window.Analysis) {
            switch (e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    Analysis.goTo(Analysis.index - 1);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    Analysis.goTo(Analysis.index + 1);
                    break;
                case 'Home':
                    e.preventDefault();
                    Analysis.goTo(0);
                    break;
                case 'End':
                    e.preventDefault();
                    Analysis.goTo(Analysis.pgnMoves.length);
                    break;
                case ' ':
                case 'Spacebar':
                    e.preventDefault();
                    Analysis.togglePlay();
                    break;
                case 'f':
                case 'F':
                    e.preventDefault();
                    Analysis.flipBoard();
                    break;
            }
            return;
        }

        // Phím tắt cho Game page (chỉ khi đang chơi, không khi modal mở)
        const gameActive = document.getElementById('game-page').classList.contains('active');
        if (gameActive) {
            switch (e.key) {
                case 'f':
                case 'F':
                    e.preventDefault();
                    this.flipBoard();
                    break;
                case 'Escape':
                    this.clearSelection();
                    break;
            }
        }
    }
}

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
    window.game = new PChessGame();
    DebugPanel.init();
    Analysis.init();
});

// ===== Phân tích ván cờ với Stockfish 18 (WASM) =====
const Analysis = {
    engine: null,
    ready: false,
    failed: false,
    pgnMoves: [],
    result: null,
    index: -1,
    evals: {}, // { [ply]: { score, pv, depth, multipv: [{score, pv, depth}, ...] } }
    classifications: {},
    pendingPly: null,
    requestPly: null,
    posChess: new Chess(),
    batchQueue: null,
    pendingStartAfterReady: false,
    _gen: 0,
    engineUrlValue: null,
    BOOK_PLY: 10,
    boardFlipped: false,
    playInterval: null,
    _chartGeo: null,
    _svgCache: null,
    _engineMode: 'lite',
    MULTI_PV_COUNT: 3,

    init() {
        document.getElementById('btn-analysis-back').addEventListener('click', () => this.exit());
        document.getElementById('btn-analysis-pgn').addEventListener('click', () => {
            document.getElementById('pgn-modal').classList.remove('hidden');
        });
        document.getElementById('btn-pgn-analyze').addEventListener('click', () => this.importFromPgnInput());
        document.getElementById('btn-analysis-export').addEventListener('click', () => this.exportPgn());
        document.getElementById('btn-analysis-start').addEventListener('click', () => this.startFullAnalysis());
        const reviewBtn = document.getElementById('btn-analysis-review');
        if (reviewBtn) reviewBtn.addEventListener('click', () => this.showReview());
        document.getElementById('btn-an-first').addEventListener('click', () => this.goTo(0));
        document.getElementById('btn-an-prev').addEventListener('click', () => this.goTo(this.index - 1));
        const playBtn = document.getElementById('btn-an-play');
        if (playBtn) playBtn.addEventListener('click', () => this.togglePlay());
        document.getElementById('btn-an-next').addEventListener('click', () => this.goTo(this.index + 1));
        document.getElementById('btn-an-last').addEventListener('click', () => this.goTo(this.pgnMoves.length));
        const flipBtn = document.getElementById('btn-an-flip');
        if (flipBtn) flipBtn.addEventListener('click', () => this.flipBoard());
        const undoBtn = document.getElementById('btn-an-undo');
        if (undoBtn) undoBtn.addEventListener('click', () => this.undoLocal());
        const whyBtn = document.getElementById('btn-an-why');
        if (whyBtn) whyBtn.addEventListener('click', () => this.showWhyPopup(this.index));
        const whyCloseBtn = document.getElementById('btn-why-close');
        if (whyCloseBtn) whyCloseBtn.addEventListener('click', () => this.hideWhyPopup());
        const scrubEl = document.getElementById('analysis-scrub');
        if (scrubEl) scrubEl.addEventListener('input', (e) => {
            const v = parseInt(e.target.value, 10);
            this.goTo(v);
        });
        document.getElementById('analysis-chart').addEventListener('click', (e) => {
            const geo = this._chartGeo;
            if (!geo || !geo.N) return;
            const rect = document.getElementById('analysis-chart').getBoundingClientRect();
            const ratio = rect.width ? (e.clientX - rect.left) / rect.width : 0;
            const frac = Math.max(0, Math.min(1, ratio));
            const i = Math.round(frac * geo.N);
            this.goTo(Math.max(0, Math.min(geo.N, i)));
        });
    },

    startFromGame(moves, result) {
        this.pgnMoves = moves.slice();
        this.result = result;
        this.evals = {};
        this.classifications = {};
        this.batchQueue = null;
        this.index = -1;
        this.failed = false;
        this.pendingStartAfterReady = false;
        this.setEngineStatus('Đang tải Stockfish...');
        this.ensureEngine();
        this.goTo(0);
    },

    importFromPgnInput() {
        const text = document.getElementById('pgn-input').value.trim();
        if (!text) {
            showToast('Hãy dán PGN vào trước', 'warning');
            return;
        }
        try {
            const ch = new Chess();
            ch.load_pgn(text);
            const moves = ch.history();
            if (!moves.length) throw new Error('Không có nước đi nào');
            this.pgnMoves = moves;
            this.result = null;
            this.evals = {};
            this.classifications = {};
            this.batchQueue = null;
            this.index = -1;
            this.failed = false;
            this.pendingStartAfterReady = false;
            document.getElementById('pgn-modal').classList.add('hidden');
            document.getElementById('pgn-input').value = '';
            this.setEngineStatus('Đang tải Stockfish...');
            this.ensureEngine();
            this.goTo(0);
            this.show();
            showToast('Đã nạp PGN: ' + moves.length + ' nước', 'success');
        } catch (err) {
            showToast('PGN không hợp lệ: ' + err.message, 'error');
        }
    },

    show() {
        document.getElementById('game-page').classList.remove('active');
        document.getElementById('analysis-page').classList.add('active');
    },

    exit() {
        document.getElementById('analysis-page').classList.remove('active');
        const g = window.game;
        if (g && g.wsOpen && g.role) {
            document.getElementById('game-page').classList.add('active');
        } else {
            document.getElementById('landing-page').classList.add('active');
        }
        this.stopEngine();
    },

    ensureEngine() {
        if (this.engine || this.failed) return;
        this.setEngineStatus('Đang tải Stockfish...');
        const gen = ++this._gen;
        this.engineUrl().then((res) => {
            // Đã exit/stop giữa lúc đọc IndexedDB thì bỏ qua
            if (gen !== this._gen || this.engine || this.failed) return;
            try {
                this.engine = new Worker(res.url);
                this.engineUrlValue = res.revokeUrl;
            } catch (err) {
                this.engineFailed('Không tạo được worker: ' + err.message);
                return;
            }
            this.engine.onerror = (e) => {
                this.engineFailed('Stockfish lỗi: ' + (e.message || 'worker error'));
            };
            this.engine.onmessage = (e) => this.onEngineMessage(e.data);
            this.engine.postMessage('uci');
            // Multi-PV: yêu cầu engine trả về N đường tốt nhất cho mỗi vị trí.
            // Stockfish 18 hỗ trợ 'setoption name MultiPV value N'.
            this.engine.postMessage('setoption name MultiPV value ' + this.MULTI_PV_COUNT);
            this.engine.postMessage('isready');
            // Bản Full cần thêm thời gian để compile WASM lớn trên máy chậm.
            const timeout = (this._engineMode === 'full') ? 180000 : 30000;
            setTimeout(() => {
                if (!this.ready && !this.failed) {
                    this.engineFailed('Stockfish không phản hồi (tải WASM quá lâu). Thử lại sau.');
                }
            }, timeout);
        }).catch((err) => {
            if (gen !== this._gen) return;
            this.engineFailed(err && err.message ? err.message : 'Không tải được engine.');
        });
    },

    // Kiểm tra xem bản Full đã cài trong IndexedDB chưa
    async _hasFullEngine() {
        try {
            const js = await EngineStore.load('engine-full');
            const wasm = await EngineStore.load('engine-full-wasm');
            return js && wasm && wasm.size >= 50 * 1048576;
        } catch (e) {
            return false;
        }
    },

    // Trả về { url, revokeUrl }. Với bản Full, giữ WASM ở Blob URL riêng và
    // truyền qua hash đúng theo loader của stockfish-18-single.js, tránh nhét
    // ~108MB WASM thành base64 vào worker script.
    async engineUrl() {
        // Tự động chọn 'full' nếu đã cài, ngược lại dùng 'lite'
        const settingsMode = (window.game && window.game.settings && window.game.settings.engine) || 'auto';
        let mode = settingsMode;
        if (mode === 'lite' || mode === 'auto') {
            const hasFull = await this._hasFullEngine();
            if (hasFull) mode = 'full';
        }
        this._engineMode = mode;

        if (mode !== 'full') {
            this.setEngineStatus('Đang tải Stockfish (lite)...');
            return { url: 'stockfish/stockfish-18-lite-single.js', revokeUrl: null };
        }
        this.setEngineStatus('Đang tải Stockfish (full)...');
        const js = await EngineStore.load('engine-full');
        const wasm = await EngineStore.load('engine-full-wasm');
        if (!js) throw new Error('Chưa cài bản Full. Vào Cài đặt > Stockfish và ấn "Tự tải bản Full" (hoặc chọn thủ công 2 file).');
        if (!wasm) throw new Error('Thiếu file stockfish-18-single.wasm của bản Full. Vào Cài đặt > Stockfish để cài lại.');
        if (wasm.size < 50 * 1048576) {
            throw new Error('File .wasm có vẻ không đúng (quá nhỏ). Hãy cài lại bản Full.');
        }
        const src = await js.text();
        if (src.length < 5000 || src.indexOf('stockfish') === -1) {
            throw new Error('File stockfish-18-single.js không đúng phiên bản. Cài lại bản Full.');
        }
        const jsUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const wasmUrl = URL.createObjectURL(wasm);
        return {
            url: jsUrl + '#' + encodeURIComponent(wasmUrl) + ',worker',
            revokeUrl: [jsUrl, wasmUrl]
        };
    },

    engineFailed(msg) {
        this.failed = true;
        this.setEngineStatus('⚠️ ' + msg, true);
        if (this.engine) {
            try { this.engine.terminate(); } catch (e) { /* ignore */ }
            this.engine = null;
        }
        this.revokeEngineUrls();
    },

    revokeEngineUrls() {
        if (!this.engineUrlValue) return;
        const urls = Array.isArray(this.engineUrlValue) ? this.engineUrlValue : [this.engineUrlValue];
        for (const url of urls) {
            if (url && url.indexOf('blob:') === 0) {
                try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
            }
        }
        this.engineUrlValue = null;
    },

    stopEngine() {
        if (this.engine) {
            try {
                this.engine.postMessage('quit');
                this.engine.terminate();
            } catch (e) { /* ignore */ }
            this.engine = null;
        }
        this.revokeEngineUrls();
        this.ready = false;
        this.failed = false;
        this.pendingPly = null;
        this.requestPly = null;
        this.batchQueue = null;
        this._gen++;
    },

    onEngineMessage(data) {
        if (typeof data !== 'string') return;
        if (data === 'uciok') {
            this.engine.postMessage('isready');
            return;
        }
        if (data === 'readyok') {
            this.ready = true;
            this.failed = false;
            this.setEngineStatus('Stockfish 18 sẵn sàng (Multi-PV ' + this.MULTI_PV_COUNT + ')');
            this.analyzeCurrent();
            if (this.pendingStartAfterReady) {
                this.pendingStartAfterReady = false;
                this.analyzeAll();
            }
            return;
        }
        if (data.indexOf('info depth') === 0) {
            const ply = this.pendingPly;
            if (ply == null) return;
            // Parse MultiPV: Stockfish gửi nhiều dòng "info ... multipv N ..."
            // mỗi dòng là 1 PV. Khi MultiPV=1, không có trường multipv -> mặc định 1.
            const mpvMatch = data.match(/multipv (\d+)/);
            const mpvIdx = mpvMatch ? parseInt(mpvMatch[1], 10) : 1;
            const score = this.parseScore(data);
            const pv = this.parsePv(data, ply);
            const depth = this.parseDepth(data);
            if (score != null) {
                // Lưu trữ theo cấu trúc: evals[ply].score = best (PV 1), evals[ply].multipv[idx-1] = {...}
                if (!this.evals[ply]) this.evals[ply] = {};
                if (mpvIdx === 1) {
                    // Top PV — dùng cho classification + chart
                    this.evals[ply].score = score;
                    this.evals[ply].pv = pv;
                    this.evals[ply].depth = depth;
                }
                if (!this.evals[ply].multipv) this.evals[ply].multipv = [];
                this.evals[ply].multipv[mpvIdx - 1] = { score, pv, depth };
            }
            if (ply === this.index) this.renderEval(ply);
            return;
        }
        if (data.indexOf('bestmove') === 0) {
            const ply = this.pendingPly;
            if (ply != null && ply === this.index) {
                this.renderEval(ply);
                this.renderMultiPV(ply);
            }
            this.pendingPly = null;
            // Đang chạy "phân tích toàn bộ": cập nhật nhãn rồi sang vị trí kế tiếp
            if (this.batchQueue) {
                this.classify();
                this.renderMoveList();
                this.processBatch();
                return;
            }
            // Có vị trí mới được yêu cầu khi đang search: làm ngay bây giờ
            if (this.requestPly != null) this.analyzeCurrent();
        }
    },

    parseScore(line) {
        const m = line.match(/score (cp|mate) (-?\d+)/);
        if (!m) return null;
        if (m[1] === 'mate') {
            const moves = parseInt(m[2], 10);
            return { type: 'mate', value: moves };
        }
        return { type: 'cp', value: parseInt(m[2], 10) };
    },

    parseDepth(line) {
        const m = line.match(/depth (\d+)/);
        return m ? parseInt(m[1], 10) : null;
    },

    parsePv(line, ply) {
        const m = line.match(/ pv (.+)$/);
        if (!m) return [];
        const ucis = m[1].trim().split(/\s+/);
        // chess.js không có clone(): dựng lại vị trí ở ply từ đầu rồi chơi PV
        const ch = new Chess();
        try {
            for (let i = 0; i < ply; i++) ch.move(this.pgnMoves[i]);
        } catch (e) { /* ignore */ }
        const sans = [];
        for (const u of ucis) {
            if (u.length < 4) break;
            try {
                const mv = ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4] : undefined });
                if (mv) sans.push(mv.san);
                else break;
            } catch (e) {
                break;
            }
        }
        return sans;
    },

    goTo(idx) {
        const maxIdx = this.pgnMoves.length;
        idx = Math.max(0, Math.min(idx, maxIdx));
        if (idx === this.index && this.pgnMoves.length) {
            this.analyzeCurrent();
            return;
        }
        this.index = idx;

        // Dựng lại vị trí bằng cách chơi lại các nước
        this.posChess = new Chess();
        for (let i = 0; i < idx; i++) {
            try {
                this.posChess.move(this.pgnMoves[i]);
            } catch (e) {
                break;
            }
        }

        document.getElementById('analysis-position-label').textContent = idx + '/' + maxIdx;
        // Cập nhật scrub bar
        const scrub = document.getElementById('analysis-scrub');
        if (scrub) {
            scrub.max = String(maxIdx);
            scrub.value = String(idx);
        }
        const scrubLabel = document.getElementById('analysis-scrub-label');
        if (scrubLabel) scrubLabel.textContent = idx + ' / ' + maxIdx;
        this.renderBoard();
        this.renderMoveList();
        this.renderPgnText();
        this.renderOpeningName(idx);
        this.renderPhase(idx);
        this.analyzeCurrent();
        // Nếu đã có eval từ lần phân tích trước, render ngay không đợi engine
        if (this.evals[idx]) {
            this.renderEval(idx);
            this.renderMultiPV(idx);
        }
        this.renderPhaseStats();
    },

    // ===== Opening name detection =====
    // Database khai cuộc rút gọn (top 30 phổ biến). Dựa trên N nước đầu tiên.
    // Không đầy đủ như Lichess/Chess.com nhưng đủ để gọi tên các khai cuộc phổ biến.
    OPENINGS: [
        { moves: ['e4','e5','Nf3','Nc6','Bb5'], name: 'Ruy Lopez (Tây Ban Nha)', family: 'Open Game' },
        { moves: ['e4','e5','Nf3','Nc6','Bc4'], name: 'Italian Game (Ý)', family: 'Open Game' },
        { moves: ['e4','e5','Nf3','Nc6','d4'], name: 'Scotch Game', family: 'Open Game' },
        { moves: ['e4','e5','Nf3','Nc6','Nf6'], name: 'Four Knights Game', family: 'Open Game' },
        { moves: ['e4','e5','Nf3','d5'], name: 'Elephant Gambit', family: 'Open Game' },
        { moves: ['e4','e5','f4'], name: "King's Gambit (Gambit Vua)", family: 'Open Game' },
        { moves: ['e4','e5','Bc4','Nf6'], name: 'Italian Game, Two Knights Defense', family: 'Open Game' },
        { moves: ['e4','c5'], name: 'Sicilian Defense (Sicilia)', family: 'Open Game' },
        { moves: ['e4','c5','Nf3','d6','d4','cxd4','Nxd4','Nf6','Nc3'], name: 'Sicilian Defense, Najdorf Variation', family: 'Sicilian' },
        { moves: ['e4','c5','Nf3','d6','d4','cxd4','Nxd4','Nf6','Nc3','g6'], name: 'Sicilian Defense, Dragon Variation', family: 'Sicilian' },
        { moves: ['e4','c5','Nf3','Nc6','d4','cxd4','Nxd4','Nf6','Nc3','e5'], name: 'Sicilian Defense, Pelikan/Sveshnikov', family: 'Sicilian' },
        { moves: ['e4','c5','Nf3','e6'], name: 'Sicilian Defense, Taimanov Variation', family: 'Sicilian' },
        { moves: ['e4','e6'], name: 'French Defense (Pháp)', family: 'Semi-Open Game' },
        { moves: ['e4','c6'], name: 'Caro-Kann Defense', family: 'Semi-Open Game' },
        { moves: ['e4','d5'], name: 'Scandinavian Defense', family: 'Semi-Open Game' },
        { moves: ['e4','d6'], name: "Pirc Defense", family: 'Semi-Open Game' },
        { moves: ['e4','g6'], name: 'Modern Defense', family: 'Semi-Open Game' },
        { moves: ['e4','Nf6'], name: 'Alekhine Defense', family: 'Semi-Open Game' },
        { moves: ['d4','d5'], name: "Queen's Gambit (Gambit Hậu)", family: 'Closed Game' },
        { moves: ['d4','d5','c4','e6'], name: "Queen's Gambit Declined", family: 'Closed Game' },
        { moves: ['d4','d5','c4','c6'], name: 'Slav Defense', family: 'Closed Game' },
        { moves: ['d4','d5','c4','dxc4'], name: "Queen's Gambit Accepted", family: 'Closed Game' },
        { moves: ['d4','Nf6','c4','g6','Nc3','Bg7'], name: "King's Indian Defense (KID)", family: 'Indian Defense' },
        { moves: ['d4','Nf6','c4','e6','Nc3','Bb4'], name: 'Nimzo-Indian Defense', family: 'Indian Defense' },
        { moves: ['d4','Nf6','c4','e6','Nf3','b6'], name: "Queen's Indian Defense", family: 'Indian Defense' },
        { moves: ['d4','Nf6','c4','c5'], name: 'Benoni Defense', family: 'Indian Defense' },
        { moves: ['d4','Nf6','c4','g6'], name: "King's Indian Defense", family: 'Indian Defense' },
        { moves: ['d4','f5'], name: 'Dutch Defense', family: 'Closed Game' },
        { moves: ['c4'], name: 'English Opening', family: 'Flank Opening' },
        { moves: ['Nf3'], name: "Réti Opening", family: 'Flank Opening' },
        { moves: ['g3'], name: 'Hungarian Opening / Benko Opening', family: 'Flank Opening' },
        { moves: ['b3'], name: 'Larsen Opening', family: 'Flank Opening' },
        { moves: ['b4'], name: 'Sokolsky Opening / Polish Opening', family: 'Flank Opening' },
        { moves: ['f4'], name: "Bird's Opening", family: 'Flank Opening' },
    ],

    renderOpeningName(idx) {
        const el = document.getElementById('analysis-opening-name');
        if (!el) return;
        const matched = this.detectOpening(this.pgnMoves.slice(0, idx));
        if (matched) {
            el.textContent = 'Khai cuộc: ' + matched.name;
            el.title = matched.family + ' — ' + matched.name;
        } else if (idx === 0) {
            el.textContent = 'Khai cuộc: Vị trí ban đầu';
            el.title = '';
        } else {
            el.textContent = 'Khai cuộc: Không xác định / biến phụ';
            el.title = '';
        }
    },

    detectOpening(movesPlayed) {
        // Tìm opening có prefix dài nhất khớp với movesPlayed.
        let best = null;
        let bestLen = 0;
        for (const op of this.OPENINGS) {
            if (movesPlayed.length < op.moves.length) continue;
            let ok = true;
            for (let i = 0; i < op.moves.length; i++) {
                if (movesPlayed[i] !== op.moves[i]) { ok = false; break; }
            }
            if (ok && op.moves.length > bestLen) {
                best = op;
                bestLen = op.moves.length;
            }
        }
        return best;
    },

    // ===== Phase detection (opening / middlegame / endgame) =====
    // Quy tắc xấp xỉ Lichess:
    //   opening  : <= 10 ply và chưa ra khỏi sách khai cuộc
    //   endgame  : trên board còn <= 6 quân không tính tốt (hoặc <= 10 quân tổng cộng)
    //   middlegame: phần giữa
    getPhase(idx) {
        if (idx <= 0) return 'opening';
        const ch = new Chess();
        for (let i = 0; i < idx; i++) {
            try { ch.move(this.pgnMoves[i]); } catch (e) { break; }
        }
        const board = ch.board();
        let nonPawn = 0;
        let totalPieces = 0;
        for (const row of board) {
            for (const p of row) {
                if (!p) continue;
                totalPieces++;
                if (p.type !== 'p' && p.type !== 'k') nonPawn++;
            }
        }
        if (idx <= 10) return 'opening';
        if (nonPawn <= 6 || totalPieces <= 10) return 'endgame';
        return 'middlegame';
    },

    renderPhase(idx) {
        const el = document.getElementById('analysis-phase');
        if (!el) return;
        const phase = this.getPhase(idx);
        const label = { opening: 'Khai cuộc', middlegame: 'Trung cuộc', endgame: 'Tàn cuộc' }[phase] || phase;
        el.textContent = 'Giai đoạn: ' + label;
        el.dataset.phase = phase;
    },

    renderPhaseStats() {
        const el = document.getElementById('analysis-phase-stats');
        if (!el) return;
        // Tính trung bình eval theo từng phase (abs cp, quy về góc nhìn Trắng)
        const phaseRanges = { opening: [], middlegame: [], endgame: [] };
        let lastPhase = null;
        for (let i = 0; i <= this.pgnMoves.length; i++) {
            const phase = this.getPhase(i);
            if (phase !== lastPhase || lastPhase === null) {
                // Bắt đầu phase mới
                if (!phaseRanges[phase]) phaseRanges[phase] = [];
            }
            lastPhase = phase;
            const ev = this.evals[i];
            if (ev && ev.score) {
                const cp = this.cpOf(ev.score);
                // Đổi dấu về góc nhìn Trắng (eval sau ply lẻ là của Đen)
                const whiteCp = (i % 2 === 0) ? cp : -cp;
                phaseRanges[phase].push(whiteCp);
            }
        }
        const phaseLabels = {
            opening: 'Khai cuộc (≤10 nước)',
            middlegame: 'Trung cuộc',
            endgame: 'Tàn cuộc (≤6 quân không phải tốt)'
        };
        let html = '';
        for (const phase of ['opening', 'middlegame', 'endgame']) {
            const arr = phaseRanges[phase];
            if (!arr || !arr.length) {
                html += '<div class="phase-stat-row"><span class="phase-stat-label">' + phaseLabels[phase] + '</span><span class="phase-stat-val">—</span></div>';
                continue;
            }
            const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
            const sign = avg > 0 ? '+' : '';
            const txt = Math.abs(avg) >= 100000
                ? (avg > 0 ? 'M thắng Trắng' : 'M thắng Đen')
                : (sign + (avg / 100).toFixed(2));
            html += '<div class="phase-stat-row"><span class="phase-stat-label">' + phaseLabels[phase] + '</span><span class="phase-stat-val">' + txt + '</span></div>';
        }
        el.innerHTML = html;
    },

    // ===== Multi-PV render =====
    renderMultiPV(ply) {
        const container = document.getElementById('analysis-multipv');
        if (!container) return;
        const ev = this.evals[ply];
        if (!ev || !ev.multipv || !ev.multipv.length) {
            container.textContent = '—';
            return;
        }
        let html = '';
        for (let i = 0; i < ev.multipv.length; i++) {
            const line = ev.multipv[i];
            if (!line) continue;
            const num = i + 1;
            const scoreText = this.formatScore(line.score);
            const pvText = (line.pv || []).slice(0, 8).join(' ');
            const isBest = i === 0;
            html += '<div class="mpv-row' + (isBest ? ' mpv-best' : '') + '">'
                + '<span class="mpv-num">' + num + '.</span>'
                + '<span class="mpv-eval">' + scoreText + '</span>'
                + '<span class="mpv-line">' + (pvText || '—') + '</span>'
                + '</div>';
        }
        container.innerHTML = html;
    },

    // ===== Flip board =====
    flipBoard() {
        this.boardFlipped = !this.boardFlipped;
        this.renderBoard();
        showToast(this.boardFlipped ? 'Đã lật bàn cờ phân tích' : 'Góc nhìn mặc định', 'info', 1500);
    },

    // ===== Undo local (chỉ trong analysis mode, không ảnh hưởng game thật) =====
    undoLocal() {
        // Lùi 1 nước trong PGN locally (chỉ khi không đang chạy batch).
        if (this.batchQueue) {
            showToast('Đang phân tích toàn bộ, không thể lùi', 'warning');
            return;
        }
        if (!this.pgnMoves.length) {
            showToast('Chưa có nước đi nào', 'warning');
            return;
        }
        // Xóa eval của nước cuối
        const removed = this.pgnMoves.pop();
        delete this.evals[this.pgnMoves.length + 1];
        delete this.classifications[this.pgnMoves.length + 1];
        showToast('Đã lùi: ' + removed, 'info', 1500);
        this.goTo(Math.min(this.index, this.pgnMoves.length));
        this.renderPgnText();
    },

    // ===== Play / pause replay =====
    togglePlay() {
        const btn = document.getElementById('btn-an-play');
        if (this.playInterval) {
            clearInterval(this.playInterval);
            this.playInterval = null;
            if (btn) btn.textContent = '▶';
            return;
        }
        if (this.index >= this.pgnMoves.length) {
            this.goTo(0);
        }
        if (btn) btn.textContent = '⏸';
        this.playInterval = setInterval(() => {
            if (this.index >= this.pgnMoves.length) {
                clearInterval(this.playInterval);
                this.playInterval = null;
                if (btn) btn.textContent = '▶';
                return;
            }
            this.goTo(this.index + 1);
        }, 1200);
    },

    analyzeCurrent() {
        if (!this.ready || this.index < 0 || this.index > this.pgnMoves.length) return;
        // Bản engine -single bị crash (RuntimeError: unreachable) nếu gửi
        // position/go trong khi tìm kiếm trước chưa xong -> phải chờ bestmove.
        // Ghi nhớ vị trí cần phân tích và xử lý khi bestmove đến.
        if (this.pendingPly != null) {
            this.requestPly = this.index;
            return;
        }
        this.pendingPly = this.index;
        this.requestPly = null;
        // Stockfish cần UCI (e2e4), chuyển từ SAN
        const ucis = [];
        const ch = new Chess();
        for (let i = 0; i < this.index; i++) {
            try {
                const mv = ch.move(this.pgnMoves[i]);
                if (mv) ucis.push(mv.from + mv.to + (mv.promotion || ''));
            } catch (e) {
                break;
            }
        }
        const cmd = 'position startpos' + (ucis.length ? ' moves ' + ucis.join(' ') : '');
        this.engine.postMessage(cmd);
        this.engine.postMessage('go depth 16');
        document.getElementById('analysis-bestmove').textContent =
            (this.evals[this.index] ? 'Đã có đánh giá' : 'Đang phân tích...');
    },

    // ===== Phân tích toàn bộ ván (chạy tuần tự từng vị trí) =====
    startFullAnalysis() {
        if (!this.pgnMoves.length) {
            showToast('Chưa có ván cờ nào để phân tích', 'warning');
            return;
        }
        if (this.batchQueue) {
            showToast('Đang phân tích...', 'info');
            return;
        }
        if (this.failed) {
            showToast('Stockfish không hoạt động, thử lại sau', 'warning');
            return;
        }
        if (!this.ready) {
            // Chưa tải xong engine: chờ readyok rồi tự chạy phân tích toàn bộ
            if (!this.engine) {
                this.setEngineStatus('Đang tải Stockfish...');
                this.ensureEngine();
            }
            this.pendingStartAfterReady = true;
            return;
        }
        this.analyzeAll();
    },

    analyzeAll() {
        if (!this.ready) {
            showToast('Stockfish chưa sẵn sàng, thử lại sau', 'warning');
            return;
        }
        if (!this.pgnMoves.length) {
            showToast('Chưa có nước đi nào để phân tích', 'warning');
            return;
        }
        if (this.batchQueue) {
            showToast('Đang phân tích...', 'info');
            return;
        }
        this.batchQueue = [];
        for (let i = 0; i <= this.pgnMoves.length; i++) this.batchQueue.push(i);
        this.setEngineStatus('Đang phân tích toàn bộ ván...');
        this.processBatch();
    },

    processBatch() {
        if (!this.batchQueue || !this.batchQueue.length) {
            this.batchQueue = null;
            this.classify();
            this.renderMoveList();
            this.setEngineStatus('Đã phân tích xong toàn bộ ván');
            showToast('Đã phân tích xong toàn bộ ván', 'success');
            return;
        }
        // goTo() dựng vị trí + gọi analyzeCurrent (tự serialize chờ bestmove)
        this.goTo(this.batchQueue.shift());
    },

    // ===== Phân loại nước đi (kiểu Chess.com — Expected Points model) =====
    cpOf(score) {
        if (!score) return null;
        if (score.type === 'mate') return score.value > 0 ? 100000 - score.value : -(100000 + score.value);
        return score.value;
    },

    winPct(cp) {
        if (cp == null) return null;
        if (cp >= 100000) return 100;
        if (cp <= -100000) return 0;
        // Sigmoid: centipawn -> % thắng (cùng dạng Lichess/Chess.com)
        return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    },

    materialBalance(ch, color) {
        const val = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
        let b = 0;
        const board = ch.board();
        for (let r = 0; r < 8; r++) {
            for (let f = 0; f < 8; f++) {
                const p = board[r][f];
                if (!p) continue;
                b += (p.color === color ? val[p.type] || 0 : -(val[p.type] || 0));
            }
        }
        return b;
    },

    buildAt(i) {
        const ch = new Chess();
        try {
            for (let k = 0; k < i; k++) {
                if (!ch.move(this.pgnMoves[k])) break;
            }
        } catch (e) { /* ignore */ }
        return ch;
    },

    classifyMove(i) {
        const before = this.evals[i - 1];
        const after = this.evals[i];
        if (!before || !after || !before.score || !after.score) return null;
        const bestCp = this.cpOf(before.score);
        const afterCp = this.cpOf(after.score);
        if (bestCp == null || afterCp == null) return null;
        const winBefore = this.winPct(bestCp);
        const winAfter = this.winPct(-afterCp); // eval sau nước là của đối phương -> đổi dấu
        if (winBefore == null || winAfter == null) return null;
        const delta = winBefore - winAfter; // % thắng bị mất (0..100)

        const moverColor = (i - 1) % 2 === 0 ? 'w' : 'b';
        const bestSan = before.pv && before.pv[0];
        const playedSan = this.pgnMoves[i - 1];
        const isBest = !!bestSan && bestSan === playedSan;

        // Book: nước mở đầu hợp lý (gần đúng khai cuộc — không có sách khai cuộc thật)
        if (i <= this.BOOK_PLY && delta <= 5) return { label: 'Book', delta, winBefore, winAfter };

        // Missed: có nước thắng rõ ràng (>= 85% thắng nếu đi đúng) nhưng không chọn
        if (delta >= 10 && winBefore >= 85) return { label: 'Missed', delta, winBefore, winAfter };

        // Brilliant: nước hay nhất kèm hy sinh quân (mất >= 1 tốt) mà vẫn không thua
        if (isBest && delta <= 2 && winAfter >= 50 && winBefore <= 95) {
            const bal0 = this.materialBalance(this.buildAt(i - 1), moverColor);
            const bal1 = this.materialBalance(this.buildAt(i), moverColor);
            if (bal1 < bal0 - 0.9) return { label: 'Brilliant', delta, winBefore, winAfter };
        }

        // Great: nước "cứu ván" — biến thế thua thành cầm cự/thắng
        if (delta <= 5 && ((winBefore <= 30 && winAfter >= 50) || (winBefore <= 50 && winAfter >= 75))) {
            return { label: 'Great', delta, winBefore, winAfter };
        }

        if (isBest || delta <= 2) return { label: 'Best', delta, winBefore, winAfter };
        if (delta <= 5) return { label: 'Excellent', delta, winBefore, winAfter };
        if (delta <= 8) return { label: 'Good', delta, winBefore, winAfter };
        if (delta <= 12) return { label: 'Inaccuracy', delta, winBefore, winAfter };
        if (delta <= 20) return { label: 'Mistake', delta, winBefore, winAfter };
        return { label: 'Blunder', delta, winBefore, winAfter };
    },

    classify() {
        const next = {};
        for (let i = 1; i <= this.pgnMoves.length; i++) {
            const c = this.classifyMove(i);
            if (c) next[i] = c;
        }
        this.classifications = next;
    },

    renderEval(ply) {
        const ev = this.evals[ply];
        if (!ev || ply !== this.index) return;
        const text = this.formatScore(ev.score);
        document.getElementById('analysis-eval-text').textContent = text;

        const fill = document.getElementById('analysis-eval-fill');
        let pct = 50;
        if (ev.score.type === 'mate') {
            pct = ev.score.value > 0 ? 96 : 4;
        } else {
            const cp = ev.score.value;
            pct = 50 + Math.max(-46, Math.min(46, cp / 120 * 46));
        }
        fill.style.height = pct + '%';
        fill.style.background = pct >= 50
            ? 'linear-gradient(to top, #fafafa, #e0e0e0)'
            : 'linear-gradient(to top, #3a3a3a, #555555)';

        const best = document.getElementById('analysis-bestmove');
        if (ev.pv && ev.pv.length) {
            const side = this.posChess.turn() === 'w' ? 'Trắng' : 'Đen';
            best.textContent = 'Tốt nhất: ' + ev.pv[0] +
                ' (' + side + ')  ·  ' + text + (ev.depth ? '  ·  depth ' + ev.depth : '');
        } else {
            best.textContent = text + (ev.depth ? '  ·  depth ' + ev.depth : '');
        }

        const cells = document.querySelectorAll('.ml-eval');
        cells[ply] && (cells[ply].textContent = text);
    },

    formatScore(score) {
        if (!score) return '';
        if (score.type === 'mate') return (score.value > 0 ? 'M' : '-M') + Math.abs(score.value);
        const pawns = score.value / 100;
        const s = pawns.toFixed(1);
        return (pawns > 0 ? '+' : '') + s;
    },

    renderBoard() {
        const board = document.getElementById('analysis-board');
        board.innerHTML = '';
        const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        const ranks = ['8', '7', '6', '5', '4', '3', '2', '1'];
        // Hỗ trợ flip board (xem từ góc nhìn Đen)
        const displayFiles = this.boardFlipped ? [...files].reverse() : files;
        const displayRanks = this.boardFlipped ? [...ranks].reverse() : ranks;
        let lastFrom = null, lastTo = null;
        if (this.index > 0 && this.index <= this.pgnMoves.length) {
            const ch = new Chess();
            try {
                for (let i = 0; i < this.index; i++) ch.move(this.pgnMoves[i]);
                const last = ch.history({ verbose: true })[ch.history().length - 1];
                lastFrom = last.from;
                lastTo = last.to;
            } catch (e) { /* ignore */ }
        }
        const inCheck = this.posChess.in_check();
        const kingSquare = inCheck ? this.findKingSquare(this.posChess, this.posChess.turn()) : null;

        for (let r = 0; r < 8; r++) {
            for (let f = 0; f < 8; f++) {
                const square = document.createElement('div');
                const file = displayFiles[f];
                const rank = displayRanks[r];
                const squareName = file + rank;
                const isLight = (r + f) % 2 === 0;
                square.className = `square ${isLight ? 'light' : 'dark'}`;
                square.dataset.square = squareName;

                const piece = this.posChess.get(squareName);
                if (piece) {
                    const pieceEl = document.createElement('img');
                    pieceEl.className = `piece ${piece.color} piece-img`;
                    pieceEl.src = getPieceUrl(piece.color, piece.type);
                    pieceEl.alt = piece.color + piece.type;
                    pieceEl.draggable = false;
                    square.appendChild(pieceEl);
                }

                if (squareName === lastFrom || squareName === lastTo) {
                    square.classList.add('last-move');
                }
                if (squareName === kingSquare) {
                    square.classList.add('check');
                }
                board.appendChild(square);
            }
        }
    },

    findKingSquare(chess, color) {
        const b = chess.board();
        const files = 'abcdefgh', ranks = '87654321';
        for (let r = 0; r < 8; r++) {
            for (let f = 0; f < 8; f++) {
                const p = b[r][f];
                if (p && p.type === 'k' && p.color === color) return files[f] + ranks[r];
            }
        }
        return null;
    },

    renderMoveList() {
        const list = document.getElementById('analysis-movelist');
        list.innerHTML = '';
        for (let i = 0; i < this.pgnMoves.length; i += 2) {
            const num = document.createElement('span');
            num.className = 'ml-num';
            num.textContent = (i / 2 + 1) + '.';

            const w = document.createElement('span');
            w.className = 'ml-move' + (this.index === i + 1 ? ' active' : '');
            w.textContent = this.pgnMoves[i];
            this.appendLabel(w, i + 1);
            w.addEventListener('click', () => this.goTo(i + 1));

            const b = document.createElement('span');
            b.className = 'ml-move' + (this.index === i + 2 ? ' active' : '');
            b.textContent = this.pgnMoves[i + 1] || '';
            this.appendLabel(b, i + 2);
            b.addEventListener('click', () => this.goTo(i + 2));

            const ev = document.createElement('span');
            ev.className = 'ml-eval';
            ev.textContent = this.formatScore(this.evals[i + 1] && this.evals[i + 1].score);

            list.appendChild(num);
            list.appendChild(w);
            list.appendChild(b);
            list.appendChild(ev);
        }
        this.renderChart();
        this.renderClassificationStats();
    },

    // ===== Thống kê phân loại nước đi =====
    async getInlineSvg(fileName) {
        if (!this._svgCache) this._svgCache = {};
        if (this._svgCache[fileName]) return this._svgCache[fileName];

        try {
            const res = await fetch('assets/svg/' + fileName);
            if (!res.ok) throw new Error();
            let text = await res.text();
            // Loại bỏ các thẻ XML và DOCTYPE thừa
            text = text.replace(/<\?xml[^>]*\?>/i, '')
                       .replace(/<!DOCTYPE[^>]*>/i, '')
                       .trim();
            this._svgCache[fileName] = text;
            return text;
        } catch (e) {
            // Fallback hình tròn đơn giản nếu tải lỗi
            return `<svg viewBox="0 0 18 19"><circle cx="9" cy="9.5" r="9" fill="currentColor"/></svg>`;
        }
    },

    renderClassificationStats() {
        const container = document.getElementById('analysis-classification-stats');
        if (!container) return;

        // Tính toán độ chính xác % cho Trắng và Đen
        let whiteDeltas = [], blackDeltas = [];
        for (let i = 1; i <= this.pgnMoves.length; i++) {
            const c = this.classifications[i];
            if (c && c.delta !== undefined) {
                // i là số lẻ -> nước đi của Trắng, i số chẵn -> Đen (1-based index)
                if (i % 2 === 1) {
                    whiteDeltas.push(c.delta);
                } else {
                    blackDeltas.push(c.delta);
                }
            }
        }

        const calcAcc = (deltas) => {
            if (!deltas.length) return 100;
            // Công thức xấp xỉ Chess.com từ trung bình mức giảm % thắng (delta)
            const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
            return Math.max(0, Math.min(100, Math.round(100 - (avg * 2.5))));
        };

        const whiteAcc = calcAcc(whiteDeltas);
        const blackAcc = calcAcc(blackDeltas);

        let html = `
            <div class="cs-accuracy-header">
                <div class="cs-accuracy-col">
                    <span class="cs-acc-label">Trắng</span>
                    <span class="cs-acc-val">${whiteAcc}%</span>
                </div>
                <div class="cs-accuracy-divider">Chính xác</div>
                <div class="cs-accuracy-col">
                    <span class="cs-acc-label">Đen</span>
                    <span class="cs-acc-val">${blackAcc}%</span>
                </div>
            </div>
        `;

        // Định nghĩa thứ tự và cấu hình phân loại theo đúng yêu cầu từ trên xuống
        const classConfig = [
            { key: 'Brilliant', label: 'Thiên tài', iconFile: 'brilliant.svg', className: 'brilliant' },
            { key: 'Great', label: 'Great Move', iconFile: 'great_find.svg', className: 'great' },
            { key: 'Best', label: 'Nước đi tốt nhất', iconFile: 'best.svg', className: 'best' },
            { key: 'Excellent', label: 'Tuyệt vời', iconFile: 'excellent.svg', className: 'excellent' },
            { key: 'Good', label: 'Tốt', iconFile: 'good.svg', className: 'good' },
        ];

        // Đếm các phân loại nước đi từ classifications
        const counts = {};
        for (let i = 1; i <= this.pgnMoves.length; i++) {
            const c = this.classifications[i];
            if (c) {
                counts[c.label] = (counts[c.label] || 0) + 1;
            }
        }

        // Đếm Book riêng
        let bookCount = 0;
        for (let i = 1; i <= this.pgnMoves.length; i++) {
            const c = this.classifications[i];
            if (c && c.label === 'Book') {
                bookCount++;
            }
        }

        for (const cfg of classConfig) {
            const count = counts[cfg.key] || 0;
            html += `
                <div class="cs-row ${cfg.className}">
                    <span class="cs-count">${count}</span>
                    <div class="cs-main">
                        <span class="cs-icon" data-icon-file="${cfg.iconFile}"></span>
                        <span class="cs-name">${cfg.label}</span>
                    </div>
                    <span class="cs-count">${count}</span>
                </div>
            `;
        }

        // Thêm các hàng còn lại: Book, Inaccuracy, Mistake, Blunder, Missed
        const remainingConfig = [
            { key: 'Book', label: 'Chủ đề sách', iconFile: 'book.svg', className: 'book', customCount: bookCount },
            { key: 'Inaccuracy', label: 'Không chính xác', iconFile: 'inaccuracy.svg', className: 'inaccuracy' },
            { key: 'Mistake', label: 'Sai lầm', iconFile: 'mistake.svg', className: 'mistake' },
            { key: 'Blunder', label: 'Nước sai lầm ngớ ngẩn', iconFile: 'blunder.svg', className: 'blunder' },
            { key: 'Missed', label: 'Bỏ lỡ', iconFile: 'missed_win.svg', className: 'missed' },
        ];

        for (const cfg of remainingConfig) {
            const count = cfg.customCount !== undefined ? cfg.customCount : (counts[cfg.key] || 0);
            html += `
                <div class="cs-row ${cfg.className}">
                    <span class="cs-count">${count}</span>
                    <div class="cs-main">
                        <span class="cs-icon" data-icon-file="${cfg.iconFile}"></span>
                        <span class="cs-name">${cfg.label}</span>
                    </div>
                    <span class="cs-count">${count}</span>
                </div>
            `;
        }

        container.innerHTML = html;

        // Tải và chèn SVG inline cho tất cả các icon
        const placeholders = container.querySelectorAll('.cs-icon');
        placeholders.forEach(async (el) => {
            const iconFile = el.getAttribute('data-icon-file');
            if (iconFile) {
                const svgText = await this.getInlineSvg(iconFile);
                el.innerHTML = svgText;
            }
        });
    },

    appendLabel(el, i) {
        const c = this.classifications[i];
        if (!c || i > this.pgnMoves.length) return;
        const badge = document.createElement('span');
        badge.className = 'ml-label label-' + c.label.toLowerCase();
        badge.textContent = this.labelText(c.label);
        badge.title = c.label + ' — mất ' + c.delta.toFixed(1) + '% thắng cờ';
        el.appendChild(badge);
    },

    labelText(label) {
        const map = {
            Brilliant: '!!',
            Great: '!',
            Best: '★',
            Excellent: '✓',
            Good: '≈',
            Book: 'B',
            Inaccuracy: '?!',
            Mistake: '?',
            Missed: '−',
            Blunder: '??'
        };
        return map[label] || label;
    },

    renderPgnText() {
        let s = '';
        for (let i = 0; i < this.pgnMoves.length; i++) {
            if (i % 2 === 0) s += (i / 2 + 1) + '. ';
            s += this.pgnMoves[i] + ' ';
        }
        document.getElementById('analysis-pgn-text').value = s.trim();
    },

    // ===== Biểu đồ áp đảo (advantage chart) =====
    // Eval sau ply lẻ là của Đen -> đổi dấu để quy về % thắng của Trắng
    whiteWinPct(ply) {
        const ev = this.evals[ply];
        if (!ev || !ev.score) return null;
        const cp = this.cpOf(ev.score);
        if (cp == null) return null;
        const w = this.winPct(cp);
        if (w == null) return null;
        return ply % 2 === 1 ? 100 - w : w;
    },

    renderChart() {
        const svg = document.getElementById('analysis-chart');
        const empty = document.getElementById('analysis-chart-empty');
        if (!svg || !empty) return;
        const N = this.pgnMoves.length;
        const W = 600, H = 220, padL = 26, padR = 16, padT = 10, padB = 20;
        const xMin = padL, xMax = W - padR, yMin = padT, yMax = H - padB;
        const xs = (i) => (N <= 0 ? (xMin + xMax) / 2 : xMin + (xMax - xMin) * (i / N));
        const ys = (wp) => yMax - (yMax - yMin) * (wp / 100);

        let points = [];
        let hasData = false;
        let last = null;
        for (let i = 0; i <= N; i++) {
            let wp = this.whiteWinPct(i);
            if (wp != null) {
                hasData = true;
                last = wp;
            } else if (last != null) {
                wp = last; // nước chưa đánh giá: kéo dài giá trị gần nhất
            }
            if (wp == null) continue;
            points.push({ x: xs(i), y: ys(wp), i });
        }

        if (!hasData) {
            svg.innerHTML = '';
            empty.style.display = 'block';
            return;
        }
        empty.style.display = 'none';
        this._chartGeo = { xMin, xMax, N, yMin, yMax, xs };

        let d = '';
        let white = 'M' + points[0].x.toFixed(1) + ' ' + points[0].y.toFixed(1);
        let black = 'M' + points[0].x.toFixed(1) + ' ' + points[0].y.toFixed(1);
        for (let k = 1; k < points.length; k++) {
            d += 'L' + points[k].x.toFixed(1) + ' ' + points[k].y.toFixed(1) + ' ';
            white += 'L' + points[k].x.toFixed(1) + ' ' + points[k].y.toFixed(1);
            black += 'L' + points[k].x.toFixed(1) + ' ' + points[k].y.toFixed(1);
        }
        const p0 = points[0], pn = points[points.length - 1];
        white += ' L' + pn.x.toFixed(1) + ' ' + yMin + ' L' + p0.x.toFixed(1) + ' ' + yMin + ' Z';
        black += ' L' + pn.x.toFixed(1) + ' ' + yMax + ' L' + p0.x.toFixed(1) + ' ' + yMax + ' Z';

        let html = '';
        // vùng trắng / đen
        html += '<path d="' + white + '" fill="rgba(240,240,240,0.16)"></path>';
        html += '<path d="' + black + '" fill="rgba(0,0,0,0.30)"></path>';
        // đường giữa 50%
        html += '<line x1="' + xMin + '" y1="' + ys(50).toFixed(1) + '" x2="' + xMax + '" y2="' + ys(50).toFixed(1) + '" stroke="rgba(128,128,128,0.45)" stroke-width="1" stroke-dasharray="4 3"></line>';
        // nhãn trục y
        html += '<text x="6" y="' + (ys(100) + 4) + '" class="chart-tick">100%</text>';
        html += '<text x="6" y="' + (ys(50) + 4) + '" class="chart-tick">50%</text>';
        html += '<text x="6" y="' + (ys(0) + 4) + '" class="chart-tick">0%</text>';
        // đường eval
        html += '<path d="M' + points[0].x.toFixed(1) + ' ' + points[0].y.toFixed(1) + ' ' + d + '" fill="none" stroke="#aab" stroke-width="1.8" stroke-linejoin="round"></path>';
        // số nước ở trục x (mỗi 5 ply)
        const step = N <= 0 ? 1 : Math.max(1, Math.ceil(N / 6));
        for (let i = 0; i <= N; i += step) {
            html += '<text x="' + xs(i).toFixed(1) + '" y="' + (H - 4) + '" class="chart-tick" text-anchor="middle">' + i + '</text>';
        }
        // vùng bắt click
        html += '<rect x="' + xMin + '" y="' + yMin + '" width="' + (xMax - xMin) + '" height="' + (yMax - yMin) + '" fill="transparent" class="chart-hit"></rect>';
        svg.innerHTML = html;
    },

    exportPgn() {
        const text = document.getElementById('analysis-pgn-text').value;
        if (!text) {
            showToast('Chưa có ván cờ nào để xuất', 'warning');
            return;
        }
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {});
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
        showToast('Đã copy PGN vào clipboard', 'success');
    },

    setEngineStatus(text, error) {
        const el = document.getElementById('analysis-engine-status');
        el.textContent = text;
        el.classList.toggle('ready', !error);
    },

    // ===== Review Mode: top 3 turning points =====
    // Tìm 3 khoảnh khắc có độ rớt % thắng lớn nhất trong ván.
    showReview() {
        if (!this.pgnMoves.length) {
            showToast('Chưa có ván cờ nào để review. Bấm "Bắt đầu phân tích" trước.', 'warning');
            return;
        }
        const modal = document.getElementById('review-modal');
        const list = document.getElementById('review-list');
        if (!modal || !list) return;

        // Tính delta cho mỗi nước
        const points = [];
        for (let i = 1; i <= this.pgnMoves.length; i++) {
            const c = this.classifications[i];
            if (c && typeof c.delta === 'number') {
                points.push({ ply: i, delta: c.delta, label: c.label, winBefore: c.winBefore, winAfter: c.winAfter });
            }
        }
        if (!points.length) {
            list.innerHTML = 'Chưa có dữ liệu phân tích. Hãy bấm "Bắt đầu phân tích" trước.';
            modal.classList.remove('hidden');
            return;
        }
        // Sắp xếp theo delta giảm dần, lấy top 3
        const top3 = points.slice().sort((a, b) => b.delta - a.delta).slice(0, 3);
        let html = '';
        for (let rank = 0; rank < top3.length; rank++) {
            const p = top3[rank];
            const moveNum = Math.ceil(p.ply / 2);
            const isWhite = p.ply % 2 === 1;
            const side = isWhite ? 'Trắng' : 'Đen';
            const san = this.pgnMoves[p.ply - 1] || '?';
            const explanation = this.labelExplanation(p.label, p.delta, p.winBefore, p.winAfter);
            html += '<div class="review-item review-' + p.label.toLowerCase() + '">'
                + '<div class="review-rank">#' + (rank + 1) + '</div>'
                + '<div class="review-main">'
                + '<div class="review-move">' + moveNum + (isWhite ? '.' : '...') + ' ' + san + ' <span class="review-side">(' + side + ')</span></div>'
                + '<div class="review-label">' + p.label + ' — rớt ' + p.delta.toFixed(1) + '% thắng</div>'
                + '<div class="review-explain">' + explanation + '</div>'
                + '<div class="review-eval">Trước: ' + (p.winBefore != null ? p.winBefore.toFixed(0) + '%' : '?') + ' → Sau: ' + (p.winAfter != null ? p.winAfter.toFixed(0) + '%' : '?') + '</div>'
                + '</div>'
                + '<button class="btn btn-secondary review-goto" data-ply="' + p.ply + '">Xem nước này</button>'
                + '</div>';
        }
        list.innerHTML = html;
        // Bind click cho nút "Xem nước này"
        list.querySelectorAll('.review-goto').forEach(btn => {
            btn.addEventListener('click', () => {
                const ply = parseInt(btn.dataset.ply, 10);
                modal.classList.add('hidden');
                this.goTo(ply);
            });
        });
        modal.classList.remove('hidden');
    },

    // ===== "Why this is bad" popup =====
    showWhyPopup(ply) {
        const popup = document.getElementById('why-popup');
        const body = document.getElementById('why-body');
        if (!popup || !body) return;
        if (ply < 1 || ply > this.pgnMoves.length) {
            showToast('Chọn một nước đi để xem giải thích', 'info');
            return;
        }
        const c = this.classifications[ply];
        const san = this.pgnMoves[ply - 1] || '?';
        const moveNum = Math.ceil(ply / 2);
        const isWhite = ply % 2 === 1;
        const side = isWhite ? 'Trắng' : 'Đen';
        const before = this.evals[ply - 1];
        const after = this.evals[ply];
        const bestSan = before && before.pv ? before.pv[0] : null;

        let html = '<div class="why-move">' + moveNum + (isWhite ? '.' : '...') + ' ' + san + ' <span class="why-side">(' + side + ')</span></div>';
        if (c) {
            html += '<div class="why-label why-label-' + c.label.toLowerCase() + '">' + c.label + '</div>';
            html += '<div class="why-explain">' + this.labelExplanation(c.label, c.delta, c.winBefore, c.winAfter) + '</div>';
        } else {
            html += '<div class="why-explain">Chưa phân tích nước này. Bấm "Bắt đầu phân tích" để có nhãn đánh giá.</div>';
        }
        if (bestSan && bestSan !== san) {
            html += '<div class="why-best">Nước tốt nhất lúc đó: <b>' + bestSan + '</b></div>';
        } else if (bestSan === san) {
            html += '<div class="why-best">Đây chính là nước tốt nhất mà engine đề xuất!</div>';
        }
        if (after && after.score) {
            html += '<div class="why-eval">Đánh giá sau nước này: ' + this.formatScore(after.score) + '</div>';
        }
        body.innerHTML = html;
        popup.classList.remove('hidden');
    },

    hideWhyPopup() {
        const popup = document.getElementById('why-popup');
        if (popup) popup.classList.add('hidden');
    },

    // ===== Giải thích nhãn phân loại (ngôn ngữ người thường) =====
    labelExplanation(label, delta, winBefore, winAfter) {
        const deltaTxt = delta != null ? delta.toFixed(1) : '?';
        const beforeTxt = winBefore != null ? winBefore.toFixed(0) : '?';
        const afterTxt = winAfter != null ? winAfter.toFixed(0) : '?';
        const explanations = {
            Brilliant: 'Nước thiên tài! Bạn hy sinh material nhưng vẫn giữ được lợi thế hoặc giành lợi thế lớn. Engine thấy đường đi sâu mà người thường khó thấy.',
            Great: 'Nước rất tốt — bạn cứu được ván từ thế khó, biến tình thế bất lợi thành cầm cờ hoặc thắng.',
            Best: 'Đúng nước engine đề xuất. Bạn đã tìm ra nước đi tốt nhất trong tình huống này.',
            Excellent: 'Nước gần tối ưu. Đánh giá rớt rất ít so với nước tốt nhất — bạn đang chơi rất chính xác.',
            Good: 'Nước hợp lý. Có thể không phải nước tốt nhất nhưng vẫn giữ được lợi thế.',
            Book: 'Nước theo lý thuyết khai cuộc. Đây là nước đã được nghiên cứu rộng rãi.',
            Inaccuracy: 'Không chính xác. Bạn rớt khoảng ' + deltaTxt + '% thắng. Không nghiêm trọng nhưng có nước chính xác hơn.',
            Mistake: 'Sai lầm. Bạn rớt ' + deltaTxt + '% thắng (từ ' + beforeTxt + '% xuống ' + afterTxt + '%). Có nước rõ ràng tốt hơn.',
            Missed: 'Bỏ lỡ cơ hội thắng lớn. Bạn đang có ' + beforeTxt + '% thắng nhưng chọn nước không tối ưu, bỏ lỡ cơ hội quyết định.',
            Blunder: 'Lỗi nghiêm trọng! Bạn rớt ' + deltaTxt + '% thắng (từ ' + beforeTxt + '% xuống ' + afterTxt + '%). Có thể mất material hoặc bị chiếu hết.'
        };
        return explanations[label] || ('Nước đi với mức rớt ' + deltaTxt + '% thắng.');
    }
};

