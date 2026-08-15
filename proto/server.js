// server.js — Node 静态服务器（零依赖，仅 node:http/fs/path）
// 端口 4173，服务 proto/ 根目录；/data/ 路径映射到 proto 之外的 data/ 目录。
// 正确处理 .html/.css/.js(ESM)/.json 的 MIME。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.join(ROOT, '..', 'data');
const PORT = 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** 把 URL 路径安全地拼到 base 下（防目录穿越） */
function safeJoin(base, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const p = path.normalize(path.join(base, decoded));
  if (p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = url.pathname;
    if (pathname === '/') pathname = '/web/index.html';

    // /data/* → proto 之外的 data 目录
    let base = ROOT;
    if (pathname.startsWith('/data/')) {
      base = DATA_ROOT;
      pathname = pathname.slice('/data'.length) || '/';
    }

    const filePath = safeJoin(base, pathname);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }

    let data;
    try {
      data = await readFile(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${pathname}`);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`后室：无尽回廊 已启动 → http://localhost:${PORT}`);
  console.log(`静态根：${ROOT}`);
  console.log(`/data/ → ${DATA_ROOT}`);
});
