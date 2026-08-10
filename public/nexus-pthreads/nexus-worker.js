// Nexus 6.1 PTHREADS Web Worker wrapper
// Requires server with COOP/COEP headers for SharedArrayBuffer
//
// Differences from single-threaded worker:
// - WASM internally creates pthread worker pool (PTHREAD_POOL_SIZE=4)
// - Search runs in background threads → faster (2-4x depending on CPU cores)
// - Worker.js needs to handle async search completion (bestmove comes from
//   background thread, not from synchronous runUCI call)

let nexusModule = null;
let nexusReady = false;
let pendingCommands = [];
let running = false;

console.log('[Nexus PThreads Worker] Starting initialization');

importScripts('nexus6.1.js');

async function fetchWithProgress(url, onProgress) {
    console.log('[Nexus PThreads Worker] Fetching:', url);
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
    console.log('[Nexus PThreads Worker] Step 1: Loading WASM module (172KB, pthreads)');

    nexusModule = await createNexusModule({
        print: function (text) {
            postMessage(typeof text === 'string' ? text : String(text));
        },
        printErr: function (text) {
            console.error('[Nexus stderr]', text);
        },
        locateFile: function (path) {
            console.log('[Nexus PThreads Worker] locateFile:', path);
            return path;
        },
        noInitialRun: true,
    });
    console.log('[Nexus PThreads Worker] WASM module loaded in', Date.now() - t0, 'ms');

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
        console.log('[Nexus PThreads Worker] Network downloaded in', Date.now() - t1, 'ms');
        nexusModule.FS.writeFile(networkPath, networkData);
        console.log('[Nexus PThreads Worker] Network written to FS');
    }

    nexusReady = true;
    console.log('[Nexus PThreads Worker] Ready, total init:', Date.now() - t0, 'ms');
    postMessage('NEXUS_READY');
    flushCommands();
}

initNexus().catch(function (err) {
    console.error('[Nexus PThreads Worker] init failed:', err);
    postMessage('ERROR: ' + (err && err.message ? err.message : err));
});

onmessage = function (e) {
    const cmd = e.data;
    if (typeof cmd !== 'string') return;
    console.log('[Nexus PThreads Worker] CMD:', cmd.substring(0, 50));

    if (!nexusReady) {
        pendingCommands.push(cmd);
        return;
    }
    sendCommand(cmd);
};

function sendCommand(cmd) {
    if (!nexusModule) return;

    try {
        nexusModule.ccall('nexus_push_command', 'int', ['string'], [cmd]);
    } catch (e) {
        postMessage('ERROR: push failed — ' + (e && e.message ? e.message : e));
        return;
    }

    // With pthreads, runUCI returns immediately after starting search
    // (search runs in background pthread). We still call runUCI to process
    // commands in the buffer, but it won't block on search.
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
