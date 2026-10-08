// 의존성 없는 작은 정적 파일 서버.  사용법: node scripts/serve.mjs [포트]
// 카메라는 https 또는 localhost 에서만 켜지므로, 같은 컴퓨터의 브라우저에서 http://localhost:포트 로 여세요.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.argv[2] || process.env.PORT || 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let path = normalize(join(root, decodeURIComponent(url.pathname)));
    if (path !== root && !path.startsWith(root + sep)) throw Object.assign(new Error('forbidden'), { status: 403 });
    if (relative(root, path).split(sep).includes('.git')) throw Object.assign(new Error('forbidden'), { status: 403 });
    if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(e.status || 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(e.status === 403 ? 'forbidden' : 'not found');
  }
  // 카메라는 https 가 아니면 localhost 에서만 켜지므로, 같은 컴퓨터에서만 접속되게 한다
}).listen(port, '127.0.0.1', () => {
  console.log(`손으로 놀자!  →  http://localhost:${port}`);
});
