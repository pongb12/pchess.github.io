// Nexus 6.1 Web Worker wrapper
// Tương thích với interface Stockfish worker (postMessage/onmessage)
// Dùng cho PChess analysis mode
//
// 2 mode depth: Low (14) và High (35) — cùng WASM, khác depth setting
// Depth được main thread quyết định qua lệnh "go depth N"
//
// Kiến trúc: Tách network ra file riêng để tải có progress bar
// - WASM (138KB): tải nhanh, compile ngay
// - Network (25MB): tải với progress bar, ghi vào Emscripten FS
// - Sau khi có cả 2, init engine (LoadDefaultNN đọc từ FS)

let nexusModule = null;
let nexusReady = false;
let pendingCommands = [];
let running = false;

// Load WASM module wrapper
importScripts('nexus6.1.js');

// Helper: fetch file with progress callback
async function fetchWithProgress(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status + ' fetching ' + url);

    const total = parseInt(response.headers.get('Content-Length') || '0', 10);
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress && total > 0) {
            onProgress(received, total);
        }
    }

    // Combine chunks into single Uint8Array
    const combined = new Uint8Array(received);
    let pos = 0;
    for (const chunk of chunks) {
        combined.set(chunk, pos);
        pos += chunk.length;
    }
    return combined;
}

// Khởi tạo Nexus: load WASM → fetch network → write to FS → ready
async function initNexus() {
    // 1. Load WASM module (fast — 138KB)
    nexusModule = await createNexusModule({
        print: function (text) {
            postMessage(typeof text === 'string' ? text : String(text));
        },
        printErr: function (text) {
            console.error('[Nexus stderr]', text);
        },
        locateFile: function (path) {
            return path;  // relative to worker
        },
        noInitialRun: true,
    });

    // 2. Fetch network file with progress (25MB — slow part)
    // Emscripten FS expects file at the path matching EVALFILE
    const networkPath = 'nexus-9b84c340af7e.nn';

    // Check if file already exists in FS (idempotent init)
    let needFetch = true;
    try {
        const stat = nexusModule.FS.stat(networkPath);
        if (stat && stat.size > 0) needFetch = false;
    } catch (e) { /* file doesn't exist yet */ }

    if (needFetch) {
        postMessage('NEXUS_PROGRESS:network:0');
        const networkData = await fetchWithProgress(networkPath, (received, total) => {
            const pct = Math.floor((received / total) * 100);
            postMessage('NEXUS_PROGRESS:network:' + pct);
        });

        // Write to Emscripten virtual FS
        nexusModule.FS.writeFile(networkPath, networkData);
    }

    // 3. Worker ready — engine init runs lazily on first 'uci' command
    nexusReady = true;
    postMessage('NEXUS_READY');
    flushCommands();
}

initNexus().catch(function (err) {
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

    try {
        nexusModule.ccall('nexus_push_command', 'int', ['string'], [cmd]);
    } catch (e) {
        postMessage('ERROR: push failed — ' + (e && e.message ? e.message : e));
        return;
    }

    if (!running) {
        flushCommands();
    }
}

// Chạy UCI loop — lần đầu sẽ init engine (LoadDefaultNN đọc từ FS)
function flushCommands() {
    if (running || !nexusModule) return;
    running = true;

    try {
        nexusModule.ccall('nexus_run_uci', 'int', [], []);
    } catch (e) {
        postMessage('ERROR: run failed — ' + (e && e.message ? e.message : e));
    }

    running = false;
}
