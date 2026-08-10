// Nexus 6.1 Web Worker wrapper
// Tương thích với interface Stockfish worker (postMessage/onmessage)
// Dùng cho PChess analysis mode
//
// 2 mode depth: Low (18-24) và High (35-40) — cùng WASM, khác depth setting
// Depth được main thread quyết định qua lệnh "go depth N"
//
// QUAN TRỌNG: KHÔNG gọi nexus_run_uci() ngay khi module load.
// Engine init (SeedRandom, InitAttacks, InitZobristKeys, LoadDefaultNN,
// ThreadsInit, TTInit) mất 800ms trong Node, 5-30s trong browser do JIT
// cold start. Nếu gọi eager, worker bị block → main thread timeout.
// Lazy init: chỉ gọi nexus_run_uci() khi nhận 'uci' command đầu tiên.

let nexusModule = null;
let nexusReady = false;
let pendingCommands = [];
let running = false;

// Load WASM module wrapper
importScripts('nexus6.1.js');

// Khởi tạo Nexus với stdout override
// Chỉ load WASM module, KHÔNG init engine
createNexusModule({
    print: function (text) {
        // Capture UCI output (bestmove, info depth ..., uciok, readyok, ...)
        postMessage(typeof text === 'string' ? text : String(text));
    },
    printErr: function (text) {
        // stderr — log để debug nhưng không gửi ra UCI stream
        console.error('[Nexus stderr]', text);
    },
    // Đảm bảo tìm wasm cùng thư mục với worker
    locateFile: function (path) {
        // path thường là 'nexus6.1.wasm' — trả về relative để browser resolve theo worker URL
        return path;
    }
}).then(function (module) {
    nexusModule = module;
    // KHÔNG gọi nexus_run_uci() ở đây — lazy init khi nhận 'uci' command
    nexusReady = true;
    postMessage('NEXUS_READY');
    // Flush pending commands (nếu có)
    flushCommands();
}).catch(function (err) {
    postMessage('ERROR: ' + (err && err.message ? err.message : err));
});

// Nhận command từ main thread
onmessage = function (e) {
    const cmd = e.data;
    if (typeof cmd !== 'string') return;

    if (!nexusReady) {
        pendingCommands.push(cmd);
        return;
    }

    sendCommand(cmd);
};

// Push command vào stdin buffer của Nexus rồi chạy UCI loop
function sendCommand(cmd) {
    if (!nexusModule) return;

    // Push command + '\n' vào stdin buffer
    try {
        nexusModule.ccall('nexus_push_command', 'int', ['string'], [cmd]);
    } catch (e) {
        postMessage('ERROR: push failed — ' + (e && e.message ? e.message : e));
        return;
    }

    // Nếu đang chạy (đang search), đợi xong rồi flush; nếu không, chạy ngay
    if (!running) {
        flushCommands();
    }
}

// Chạy UCI loop — xử lý tất cả command trong buffer, return khi buffer rỗng
// Lần đầu gọi sẽ init engine (SeedRandom, InitAttacks, LoadDefaultNN, etc.)
// — có thể mất 800ms-30s trong browser do JIT cold start
function flushCommands() {
    if (running || !nexusModule) return;
    running = true;

    try {
        // nexus_run_uci() đồng bộ — sẽ block cho đến khi search xong
        // Lần đầu: init engine (~1s) rồi UCILoop (returns ngay nếu buffer rỗng)
        // Lần sau: chỉ UCILoop
        nexusModule.ccall('nexus_run_uci', 'int', [], []);
    } catch (e) {
        postMessage('ERROR: run failed — ' + (e && e.message ? e.message : e));
    }

    running = false;

    // Nếu có command mới đến trong lúc chạy, flush tiếp
    // (pendingCommands đã được xử lý qua onmessage → sendCommand → buffer)
}
