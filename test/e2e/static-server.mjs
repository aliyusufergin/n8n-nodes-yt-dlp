import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? '');
const mimeTypes = {
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.mpd': 'application/dash+xml',
};

createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const filePath = resolve(root, `.${requestPath}`);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-length': fileStat.size,
      'content-type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}).listen(18_080, '127.0.0.1');
