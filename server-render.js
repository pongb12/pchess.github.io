// PChess Static Server with COOP/COEP headers for SharedArrayBuffer (pthreads WASM)
// Used for Render.com Web Service deployment
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.nn': 'application/octet-stream',
    '.ico': 'image/x-icon',
    '.map': 'application/json',
    '.worker.js': 'text/javascript; charset=utf-8',
};

// COOP/COEP headers — required for SharedArrayBuffer (pthreads WASM)
const SECURITY_HEADERS = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
};

const server = http.createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    // Prevent path traversal
    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { ...SECURITY_HEADERS });
            res.end('Not Found');
            return;
        }

        const ext = path.extname(filePath);
        const contentType = MIME[ext] || 'application/octet-stream';

        const headers = {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=3600',
            ...SECURITY_HEADERS,
        };

        // For WASM, add extra caching
        if (ext === '.wasm' || ext === '.nn') {
            headers['Cache-Control'] = 'public, max-age=86400';
        }

        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`PChess server running on port ${PORT}`);
    console.log(`Serving static files from: ${ROOT}`);
    console.log(`COOP/COEP headers enabled for SharedArrayBuffer (pthreads)`);
});
