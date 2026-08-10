// Nexus 6.1 Web Worker wrapper
// Tương thích với interface Stockfish worker (postMessage/onmessage)
// Dùng cho PChess analysis mode
//
// 2 mode depth: Low (12) và High (35) — cùng WASM, khác depth setting
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

console.log('[Nexus Worker] Starting initialization');

// Load WASM module wrapper
importScripts('nexus6.1.js');
console.log('[Nexus Worker] nexus6.1.js loaded, createNexusModule type:', typeof createNexusModule);

// Helper: fetch file with progress callback
async function fetchWithProgress(url, onProgress) {
    console.log('[Nexus Worker] Fetching:', url);
    const response = await fetch(url);
    if (!response.ok) {
        console.error('[Nexus Worker] Fetch failed:', response.status, response.statusText);
        throw new Error('HTTP ' + response.status + ' fetching ' + url);
    }

    const total = parseInt(response.headers.get('Content-Length') || '0', 10);
    console.log('[Nexus Worker] Fetch OK, Content-Length:', total, 'bytes');
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let lastProgressReport = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress && total > 0) {
            // Report progress every ~500KB to avoid flooding
            if (received - lastProgressReport > 500000 || received === total) {
                onProgress(received, total);
                lastProgressReport = received;
            }
        }
    }
    console.log('[Nexus Worker] Download complete:', received, 'bytes received');

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
    const t0 = Date.now();
    console.log('[Nexus Worker] Step 1: Loading WASM module (138KB)');

    // 1. Load WASM module (fast — 138KB)
    try {
        nexusModule = await createNexusModule({
            print: function (text) {
                postMessage(typeof text === 'string' ? text : String(text));
            },
            printErr: function (text) {
                console.error('[Nexus stderr]', text);
            },
            locateFile: function (path) {
                console.log('[Nexus Worker] locateFile:', path);
                return path;  // relative to worker
            },
            noInitialRun: true,
        });
        console.log('[Nexus Worker] WASM module loaded in', Date.now() - t0, 'ms');
        console.log('[Nexus Worker] nexusModule.FS type:', typeof nexusModule.FS);
        if (nexusModule.FS) {
            console.log('[Nexus Worker] FS.writeFile:', typeof nexusModule.FS.writeFile);
            console.log('[Nexus Worker] FS.stat:', typeof nexusModule.FS.stat);
        }
    } catch (e) {
        console.error('[Nexus Worker] WASM module load failed:', e.message);
        postMessage('ERROR: WASM load failed — ' + e.message);
        return;
    }

    // 2. Fetch network file with progress (25MB — slow part)
    const networkPath = 'nexus-9b84c340af7e.nn';
    console.log('[Nexus Worker] Step 2: Fetching network file (25MB)');

    // Check if file already exists in FS (idempotent init)
    let needFetch = true;
    try {
        const stat = nexusModule.FS.stat(networkPath);
        if (stat && stat.size > 0) {
            needFetch = false;
            console.log('[Nexus Worker] Network already in FS, size:', stat.size);
        }
    } catch (e) { /* file doesn't exist yet */ }

    if (needFetch) {
        postMessage('NEXUS_PROGRESS:network:0');
        const t1 = Date.now();
        try {
            const networkData = await fetchWithProgress(networkPath, (received, total) => {
                const pct = Math.floor((received / total) * 100);
                postMessage('NEXUS_PROGRESS:network:' + pct);
            });
            console.log('[Nexus Worker] Network downloaded in', Date.now() - t1, 'ms');

            // Write to Emscripten virtual FS
            console.log('[Nexus Worker] Writing network to FS...');
            nexusModule.FS.writeFile(networkPath, networkData);
            console.log('[Nexus Worker] Network written to FS, size:', networkData.length);
        } catch (e) {
            console.error('[Nexus Worker] Network fetch/write failed:', e.message);
            postMessage('ERROR: Network load failed — ' + e.message);
            return;
        }
    }

    // 3. Worker ready — engine init runs lazily on first 'uci' command
    console.log('[Nexus Worker] Step 3: Ready, total init time:', Date.now() - t0, 'ms');
    nexusReady = true;
    postMessage('NEXUS_READY');
    flushCommands();
}

initNexus().catch(function (err) {
    console.error('[Nexus Worker] initNexus failed:', err);
    postMessage('ERROR: ' + (err && err.message ? err.message : err));
});

// Nhận command từ main thread
onmessage = function (e) {
    const cmd = e.data;
    if (typeof cmd !== 'string') return;
    console.log('[Nexus Worker] Received command:', cmd.substring(0, 50));

    if (!nexusReady) {
        console.log('[Nexus Worker] Not ready yet, queuing command');
        pendingCommands.push(cmd);
        return;
    }

    sendCommand(cmd);
};

// Push command vào stdin buffer của Nexus rồi chạy UCI loop
function sendCommand(cmd) {
    if (!nexusModule) {
        console.error('[Nexus Worker] sendCommand but module is null');
        return;
    }

    try {
        nexusModule.ccall('nexus_push_command', 'int', ['string'], [cmd]);
    } catch (e) {
        console.error('[Nexus Worker] push_command failed:', e.message);
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
    console.log('[Nexus Worker] flushCommands start');

    try {
        // nexus_run_uci() đồng bộ — sẽ block cho đến khi search xong
        // Lần đầu: init engine (~1s) rồi UCILoop (returns ngay nếu buffer rỗng)
        // Lần sau: chỉ UCILoop
        nexusModule.ccall('nexus_run_uci', 'int', [], []);
        console.log('[Nexus Worker] flushCommands done');
    } catch (e) {
        console.error('[Nexus Worker] flushCommands error:', e.message);
        postMessage('ERROR: run failed — ' + (e && e.message ? e.message : e));
    }

    running = false;
}
