const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = 'D:\\pchess\\public';
const PORT = 34567;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  let filePath = path.join(ROOT, parsed.pathname === '/' ? 'index.html' : decodeURIComponent(parsed.pathname));
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  // prevent directory traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      console.log('404:', filePath);
      res.writeHead(404);
      res.end('Not found: ' + filePath);
      return;
    }
    console.log('200:', filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

process.on('SIGINT', () => server.close(() => process.exit(0)));