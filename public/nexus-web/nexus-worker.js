// Nexus 6.1 Web Worker wrapper (web-analysis build, pump API)
// Stockfish-compatible interface (postMessage/onmessage) for PChess analysis mode.
//
// The engine uses Emscripten pthreads, so the page must be crossOriginIsolated
// (SharedArrayBuffer). Serve the worker page with:
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// Command flow: postMessage("position startpos ...") -> nexus_push_command()
// queues the line; nexus_run_uci() drains it. "go" starts search synchronously.

let nexusModule = null;
let nexusReady = false;
let pendingCommands = [];
let running = false;

console.log('[Nexus Worker] Starting initialization (web-analysis build)');

importScripts('nexus6.1.js');

// Helper: fetch file with progress callback
async function fetchWithProgress(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const total = parseInt(response.headers.get('Content-Length') || '0', 10);
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let lastReport = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress && total > 0 && (received - lastReport > 500000 || received === total)) {
            onProgress(received, total);
            lastReport = received;
        }
    }

    const combined = new Uint8Array(received);
    let pos = 0;
    for (const chunk of chunks) {
        combined.set(chunk, pos);
        pos += chunk.length;
    }
    return combined;
}

async function initNexus() {
    const t0 = Date.now();
    console.log('[Nexus Worker] Step 1: Loading WASM module');

    nexusModule = await createNexusModule({
        print: function (text) {
            postMessage(typeof text === 'string' ? text : String(text));
        },
        printErr: function (text) {
            console.error('[Nexus stderr]', text);
        },
        locateFile: function (path) {
            return path;
        },
        noInitialRun: true,
    });
    console.log('[Nexus Worker] WASM loaded in', Date.now() - t0, 'ms');

    // Fetch network file with progress
    const networkPath = 'nexus-9b84c340af7e.nn';
    let needFetch = true;
    try {
        const stat = nexusModule.FS.stat(networkPath);
        if (stat && stat.size > 0) needFetch = false;
    } catch (e) { /* not in FS yet */ }

    if (needFetch) {
        postMessage('NEXUS_PROGRESS:network:0');
        const t1 = Date.now();
        const networkData = await fetchWithProgress(networkPath, (received, total) => {
            const pct = Math.floor((received / total) * 100);
            postMessage('NEXUS_PROGRESS:network:' + pct);
        });
        console.log('[Nexus Worker] Network downloaded in', Date.now() - t1, 'ms');
        nexusModule.FS.writeFile(networkPath, networkData);
    }

    nexusReady = true;
    console.log('[Nexus Worker] Ready, total init:', Date.now() - t0, 'ms');
    postMessage('NEXUS_READY');
    flushCommands();
}

initNexus().catch(function (err) {
    console.error('[Nexus Worker] init failed:', err);
    postMessage('ERROR: ' + (err && err.message ? err.message : err));
});

onmessage = function (e) {
    const cmd = e.data;
    if (typeof cmd !== 'string') return;
    console.log('[Nexus Worker] CMD:', cmd.substring(0, 50));

    if (!nexusReady) {
        pendingCommands.push(cmd);
        return;
    }
    sendCommand(cmd);
};

function sendCommand(cmd) {
    if (!nexusModule) return;

    try {
        const len = nexusModule.lengthBytesUTF8(cmd);
        const ptr = nexusModule._malloc(len + 1);
        nexusModule.stringToUTF8(cmd, ptr, len + 1);
        nexusModule._nexus_push_command(ptr);
        nexusModule._free(ptr);
    } catch (e) {
        postMessage('ERROR: push failed — ' + (e && e.message ? e.message : e));
        return;
    }

    if (!running) {
        flushCommands();
    }
}

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
