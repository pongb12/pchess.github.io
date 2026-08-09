// Nexus 6.1 WASM Worker for PChess
// Wraps Nexus WASM module in UCI-compatible Worker interface
// Compatible with PChess Analysis module (same interface as Stockfish Worker)

let nexusModule = null;
let outputBuffer = [];

// Load Nexus WASM module
importScripts('./nexus6.1.js');

let initPromise = createNexusModule({
    print: (text) => {
        if (text) {
            postMessage(text);
        }
    },
    printErr: (text) => {
        if (text) console.error('[Nexus ERR]', text);
    },
    instantiateWasm: async (imports, callback) => {
        try {
            const response = await fetch('./nexus6.1.wasm');
            const wasmBinary = await response.arrayBuffer();
            const { instance } = await WebAssembly.instantiate(wasmBinary, imports);
            callback(instance);
            return {};
        } catch (e) {
            postMessage('ERROR: ' + e.message);
            throw e;
        }
    },
    noInitialRun: true,
}).then((module) => {
    nexusModule = module;
    postMessage('NEXUS_READY');
}).catch((e) => {
    postMessage('ERROR: ' + e.message);
});

// Handle messages from main thread
onmessage = async function(e) {
    await initPromise;
    if (!nexusModule) {
        postMessage('ERROR: Nexus module not loaded');
        return;
    }

    const cmd = e.data;
    if (typeof cmd !== 'string') return;

    // Push command to Nexus stdin buffer
    nexusModule.ccall('nexus_push_command', 'int', ['string'], [cmd]);
    
    // If it's a 'go' command or 'quit', run the UCI loop
    // For 'uci', 'isready', 'setoption' — also run to get response
    if (cmd.startsWith('go') || cmd.startsWith('uci') || cmd.startsWith('isready') || 
        cmd.startsWith('setoption') || cmd.startsWith('position') || cmd.startsWith('ucinewgame') ||
        cmd.startsWith('quit') || cmd.startsWith('stop')) {
        // Add quit to end the loop
        nexusModule.ccall('nexus_push_command', 'int', ['string'], ['quit']);
        nexusModule.ccall('nexus_run_uci', 'int', [], []);
    }
};
