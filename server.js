#!/usr/bin/env node
/**
 * Servidor estático local, sem dependências externas.
 * Uso: node server.js [--open] [--port 3000] [--host 127.0.0.1]
 *
 * Por padrão escuta apenas em 127.0.0.1 (somente este computador) e envia
 * cabeçalhos de segurança (CSP, Permissions-Policy etc.).
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const ROOT = __dirname;
const HOST = argValue('--host') || process.env.HOST || '127.0.0.1';
let port = Number(argValue('--port') || process.env.PORT || 3000);
const OPEN = args.includes('--open');

const ALLOWED_DIRS = ['', 'css', 'js', 'assets', 'models', 'vendor'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método não permitido', { Allow: 'GET, HEAD' });

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Requisição inválida');
  }
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(ROOT, pathname));
  const rel = path.relative(ROOT, filePath);
  const topDir = rel.includes(path.sep) ? rel.split(path.sep)[0] : '';
  if (rel.startsWith('..') || path.isAbsolute(rel) || pathname.includes('\0') || !ALLOWED_DIRS.includes(topDir)) {
    return send(res, 404, 'Não encontrado');
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!MIME[ext] || (topDir === '' && !['index.html', 'favicon.ico'].includes(rel))) return send(res, 404, 'Não encontrado');

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Não encontrado');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext],
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  });
});

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && port < 3020) {
    console.warn(`Porta ${port} em uso, tentando ${port + 1}...`);
    port += 1;
    server.listen(port, HOST);
  } else {
    console.error('Erro ao iniciar o servidor:', err.message);
    process.exit(1);
  }
});

server.on('listening', () => {
  const url = `http://${HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`;
  console.log('\n  FaceID Seguro em execução');
  console.log(`  Acesse: ${url}`);
  console.log('  Pressione Ctrl+C para encerrar.\n');
  if (OPEN) openBrowser(url);
});

server.listen(port, HOST);
