// Nexus 6.1 Web Worker wrapper
// Tương thích với interface Stockfish worker (postMessage/onmessage)
// Dùng cho PChess analysis mode
//
// 2 mode depth: Low (18-24) và High (35-40) — cùng WASM, khác depth setting
// Depth được main thread quyết định qua lệnh "go depth N"

let nexusModule = null;
let nexusReady = false;
let pendingCommands = [];
let running = false;

// Load WASM module wrapper
importScripts('nexus6.1.js');

// Khởi tạo Nexus với stdout override
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

    // Khởi tạo engine + chạy UCI loop với buffer rỗng (chỉ init, không search)
    // nexus_run_uci() lần đầu: init engine (SeedRandom, InitAttacks, ThreadsInit,
    // TTInit, LoadDefaultNN) rồi UCILoop() sẽ return ngay vì buffer rỗng
    try {
        nexusModule.ccall('nexus_run_uci', 'int', [], []);
    } catch (e) {
        postMessage('ERROR: init failed — ' + (e && e.message ? e.message : e));
        return;
    }

    nexusReady = true;
    postMessage('NEXUS_READY');

    // Flush pending commands (uci, isready, v.v. gửi trong lúc loading)
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
function flushCommands() {
    if (running || !nexusModule) return;
    running = true;

    try {
        // nexus_run_uci() đồng bộ — sẽ block cho đến khi search xong
        // (UCILoop return khi buffer rỗng)
        nexusModule.ccall('nexus_run_uci', 'int', [], []);
    } catch (e) {
        postMessage('ERROR: run failed — ' + (e && e.message ? e.message : e));
    }

    running = false;

    // Nếu có command mới đến trong lúc chạy, flush tiếp
    // (pendingCommands đã được xử lý qua onmessage → sendCommand → buffer)
}
