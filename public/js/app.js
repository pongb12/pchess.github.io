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
        this.rematchState = { requested: false, by: null };
        this.gameResult = null;

        // Bind methods
        this.handleSquareClick = this.handleSquareClick.bind(this);
        this.handleResize = this.handleResize.bind(this);

        this.init();
    }

    // ===== Initialization =====
    init() {
        this.applyTheme(this.settings.theme);
        this.bindEvents();
        this.checkUrlForRoom();
        window.addEventListener('resize', this.handleResize);
        window.addEventListener('beforeunload', () => this.cleanup());
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
                    this.wsOpen = true;
                    this.reconnectAttempts = 0;
                    this.reconnecting = false;
                    this.startHeartbeat();
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

        const statusDot = document.querySelector('.status-dot');
        if (statusDot) {
            statusDot.classList.remove('connected');
            statusDot.classList.add('disconnected');
        }
        const connText = document.getElementById('connection-text');
        if (connText) connText.textContent = 'Mất kết nối';

        if (this.gameActive && this.reconnectAttempts < 5) {
            showToast('Mất kết nối, đang thử kết nối lại...', 'warning');
            this.reconnectAttempts++;
            this.scheduleReconnect();
        } else if (this.gameActive) {
            showToast('Không thể kết nối lại. Vui lòng tạo phòng mới.', 'error');
            this.leaveRoom();
        } else {
            // Chưa vào ván mà mất kết nối: thường do CONFIG.WS_URL chưa đổi / chưa deploy worker
            showToast('Không kết nối được server. Kiểm tra CONFIG.WS_URL và deploy worker (xem README).', 'error');
            this.cleanup();
            this.showPage('lobby-page', false);
            this.showPage('landing-page', true);
        }
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
                this.handlePeerLeft();
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
            case 'sync':
                this.handleSync(msg);
                break;
            case 'sync_request':
                this.requestSync();
                break;
            case 'rematch_request':
                this.handleRematchRequest();
                break;
            case 'rematch_accept':
                this.handleRematchAccept();
                break;
            case 'rematch_decline':
                this.handleRematchDecline();
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

        const statusDot = document.querySelector('.status-dot');
        if (statusDot) {
            statusDot.classList.add('connected');
            statusDot.classList.remove('disconnected');
        }
        const connText = document.getElementById('connection-text');
        if (connText) {
            connText.textContent = (this.isHost && !msg.game) ? 'Đang chờ đối thủ...' : 'Đã kết nối!';
        }

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
            showToast('Đã nối lại ván cờ đang dở', 'info');
        } else if (this.isHost && this.gameActive) {
            this.requestSync();
        }
    }

    handlePeerJoined() {
        debugLog('info', 'Đối thủ đã vào phòng');
        const statusDot = document.querySelector('.status-dot');
        if (statusDot) {
            statusDot.classList.add('connected');
            statusDot.classList.remove('disconnected');
        }
        const connText = document.getElementById('connection-text');
        if (connText) connText.textContent = 'Đã kết nối!';

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
    }

    handlePeerLeft() {
        debugLog('warn', 'Đối thủ đã rời phòng');
        const statusDot = document.querySelector('.status-dot');
        if (statusDot) {
            statusDot.classList.remove('connected');
            statusDot.classList.add('disconnected');
        }
        const connText = document.getElementById('connection-text');
        if (connText) connText.textContent = 'Mất kết nối';

        if (this.gameActive) {
            showToast('Đối thủ đã ngắt kết nối', 'error');
            this.stopTimer();
        }
    }

    handleMoveRejected(msg) {
        debugLog('error', 'Nước đi bị server từ chối:', msg && msg.reason);
        showToast('Nước đi bị từ chối: ' + (msg.reason === 'not_your_turn' ? 'chưa đến lượt bạn' : (msg.reason === 'rate_limit' ? 'đi quá nhanh' : 'không hợp lệ')), 'error');
        this.requestSync();
    }

    handleRoomFull() {
        // Nếu đang nối lại (hoặc đã có phiên phòng trong sessionStorage), đừng
        // xoá session: socket cũ chưa được server dọn nên phòng "tạm đầy".
        // Thử lại vài lần, server sẽ dọn slot cũ rồi cho vào.
        const hasSession = !!(this.roomId && this.role) || !!sessionStorage.getItem('pchess_room');
        if (hasSession && this.reconnectAttempts < 8) {
            this.reconnectAttempts++;
            showToast('Phòng đang đầy, thử kết nối lại (' + this.reconnectAttempts + '/8)...', 'warning');
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

        showToast('Phòng đã đầy! (tối đa 2 người)', 'error');
        this.cleanup();
        this.showPage('lobby-page', false);
        this.showPage('landing-page', true);
        sessionStorage.removeItem('pchess_room');
    }

    handleSessionTakeover() {
        // Phiên này đã bị thay thế bởi một kết nối cùng vai trò khác (thường là
        // người dùng mở lại trang sau khi mất mạng). Dừng ván và thoát gọn,
        // không tự reconnect vì socket mới đã nắm vai trò này.
        debugLog('warn', 'Phiên bị thay thế (session-takeover)');
        showToast('Phiên này đã được mở ở nơi khác', 'warning');
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
        }

        if (this.chess.game_over()) {
            this.handleGameOver();
        }
    }

    handleSync(msg) {
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

            if (msg.timers) {
                this.timers = msg.timers;
                this.updateTimerDisplay();
                this.startTimer();
            }

            showToast('Đã đồng bộ trạng thái game', 'info');
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

        // Determine orientation based on color
        const displayFiles = this.myColor === 'w' ? files : [...files].reverse();
        const displayRanks = this.myColor === 'w' ? ranks : [...ranks].reverse();

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
                        });
                        pieceEl.addEventListener('dragend', () => {
                            this.dragFrom = null;
                            this.clearSelection();
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

                // Valid moves highlight
                if (this.validMoves.includes(squareName)) {
                    const targetPiece = this.chess.get(squareName);
                    if (targetPiece && targetPiece.color !== this.myColor) {
                        square.classList.add('valid-capture');
                    } else {
                        square.classList.add('valid-move');
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
                    if (this.dragFrom) e.preventDefault();
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
        const indicator = statusEl.querySelector('.status-indicator');
        const text = statusEl.querySelector('.status-text');

        if (this.gameResult || this.chess.game_over()) {
            text.textContent = 'Kết thúc';
            indicator.className = 'status-indicator';
            return;
        }

        if (!this.gameActive) {
            text.textContent = 'Chưa bắt đầu';
            indicator.className = 'status-indicator';
            return;
        }

        const myTurn = this.chess.turn() === this.myColor;
        const inCheck = this.chess.in_check();

        if (inCheck) {
            text.textContent = myTurn ? '⚠️ Bạn đang bị chiếu!' : 'Đối thủ đang bị chiếu';
            indicator.className = 'status-indicator check';
        } else if (myTurn) {
            text.textContent = '🎯 Đến lượt bạn';
            indicator.className = 'status-indicator your-turn';
        } else {
            text.textContent = '⏳ Đang chờ đối thủ...';
            indicator.className = 'status-indicator opponent-turn';
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

    // ===== Rematch =====
    requestRematch() {
        document.getElementById('gameover-modal').classList.add('hidden');
        this.rematchState = { requested: true, by: this.role };
        this.sendMessage({ type: 'rematch_request' });
        showToast('Đã gửi yêu cầu chơi lại', 'info');
    }

    handleRematchRequest() {
        this.rematchState = { requested: true, by: 'opponent' };
        document.getElementById('rematch-modal').classList.remove('hidden');
        this.soundManager.play('notify');
    }

    acceptRematch() {
        document.getElementById('rematch-modal').classList.add('hidden');
        this.sendMessage({ type: 'rematch_accept' });
        this.resetGame();
    }

    declineRematch() {
        document.getElementById('rematch-modal').classList.add('hidden');
        this.sendMessage({ type: 'rematch_decline' });
        this.rematchState = { requested: false, by: null };
        showToast('Đã từ chối chơi lại', 'info');
    }

    handleRematchAccept() {
        this.resetGame();
        showToast('Đối thủ đồng ý chơi lại!', 'success');
    }

    handleRematchDecline() {
        this.rematchState = { requested: false, by: null };
        showToast('Đối thủ từ chối chơi lại', 'warning');
    }

    resetGame() {
        // Reset chess engine
        this.chess.reset();

        // Reset state
        this.gameActive = true;
        this.moveHistory = [];
        this.capturedPieces = { w: [], b: [] };
        this.lastMove = null;
        this.selectedSquare = null;
        this.validMoves = [];
        this.currentTurn = 'w';
        this.gameResult = null;
        this.rematchState = { requested: false, by: null };
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
        // Responsive adjustments if needed
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
    evals: {},
    classifications: {},
    pendingPly: null,
    requestPly: null,
    posChess: new Chess(),
    batchQueue: null,
    pendingStartAfterReady: false,
    _gen: 0,
    engineUrlValue: null,
    BOOK_PLY: 10,

    init() {
        document.getElementById('btn-analysis-back').addEventListener('click', () => this.exit());
        document.getElementById('btn-analysis-pgn').addEventListener('click', () => {
            document.getElementById('pgn-modal').classList.remove('hidden');
        });
        document.getElementById('btn-pgn-analyze').addEventListener('click', () => this.importFromPgnInput());
        document.getElementById('btn-analysis-export').addEventListener('click', () => this.exportPgn());
        document.getElementById('btn-analysis-start').addEventListener('click', () => this.startFullAnalysis());
        document.getElementById('btn-an-first').addEventListener('click', () => this.goTo(0));
        document.getElementById('btn-an-prev').addEventListener('click', () => this.goTo(this.index - 1));
        document.getElementById('btn-an-next').addEventListener('click', () => this.goTo(this.index + 1));
        document.getElementById('btn-an-last').addEventListener('click', () => this.goTo(this.pgnMoves.length));
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
            this.setEngineStatus('Stockfish 18 sẵn sàng');
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
            const score = this.parseScore(data);
            const pv = this.parsePv(data, ply);
            if (score != null) {
                this.evals[ply] = { score, pv, depth: this.parseDepth(data) };
            }
            if (ply === this.index) this.renderEval(ply);
            return;
        }
        if (data.indexOf('bestmove') === 0) {
            const ply = this.pendingPly;
            if (ply != null && ply === this.index) {
                this.renderEval(ply);
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
        this.renderBoard();
        this.renderMoveList();
        this.renderPgnText();
        this.analyzeCurrent();
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
                const file = files[f];
                const rank = ranks[r];
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
    }
};

