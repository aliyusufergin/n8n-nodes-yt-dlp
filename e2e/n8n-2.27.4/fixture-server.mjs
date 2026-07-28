import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, request as createRequest } from 'node:http';
import { basename, join } from 'node:path';

const fixtureRoot = process.env.FIXTURE_ROOT;
if (!fixtureRoot) throw new Error('FIXTURE_ROOT is required.');

const expectedProxyAuthorization = `Basic ${Buffer.from('proxy-user:proxy-password').toString('base64')}`;
const expectedCookie = 'session=cookie-secret';
const maximumHashBodyBytes = 4 * 1024 * 1024;
const evidence = {
	authenticatedOriginRequests: 0,
	authenticatedProxyRequests: 0,
	hashRequests: 0,
	mediaRequests: 0,
	slowRequests: 0,
};

function equalHeader(actual, expected) {
	if (typeof actual !== 'string') return false;
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return (
		actualBytes.byteLength === expectedBytes.byteLength &&
		timingSafeEqual(actualBytes, expectedBytes)
	);
}

function contentType(pathname) {
	if (pathname.endsWith('.jpg')) return 'image/jpeg';
	if (pathname.endsWith('.m4a')) return 'audio/mp4';
	if (pathname.endsWith('.m4s')) return 'video/iso.segment';
	if (pathname.endsWith('.mp4')) return 'video/mp4';
	if (pathname.endsWith('.mpd')) return 'application/dash+xml';
	if (pathname.endsWith('.vtt')) return 'text/vtt';
	return 'application/octet-stream';
}

async function serveFile(request, response, fileName) {
	evidence.mediaRequests += 1;
	const path = join(fixtureRoot, basename(fileName));
	const fileStat = await stat(path);
	const range = request.headers.range;
	if (typeof range === 'string') {
		const match = /^bytes=(\d+)-(\d*)$/u.exec(range);
		if (!match) {
			response.writeHead(416);
			response.end();
			return;
		}
		const start = Number(match[1]);
		const end = match[2] === '' ? fileStat.size - 1 : Number(match[2]);
		if (start > end || end >= fileStat.size) {
			response.writeHead(416, { 'content-range': `bytes */${fileStat.size}` });
			response.end();
			return;
		}
		response.writeHead(206, {
			'accept-ranges': 'bytes',
			'content-length': end - start + 1,
			'content-range': `bytes ${start}-${end}/${fileStat.size}`,
			'content-type': contentType(fileName),
		});
		if (request.method === 'HEAD') response.end();
		else createReadStream(path, { end, start }).pipe(response);
		return;
	}
	response.writeHead(200, {
		'accept-ranges': 'bytes',
		'content-length': fileStat.size,
		'content-type': contentType(fileName),
	});
	if (request.method === 'HEAD') response.end();
	else createReadStream(path).pipe(response);
}

async function readBoundedBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > maximumHashBodyBytes) throw new Error('hash body limit exceeded');
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size);
}

function servePlaylist(response, title, sources) {
	response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	response.end(
		`<html><head><title>${title}</title></head><body>` +
			sources.map((source) => `<video src="${source}" controls></video>`).join('') +
			'</body></html>',
	);
}

const origin = createServer((request, response) => {
	void (async () => {
		const url = new URL(request.url ?? '/', 'http://fixture');
		if (url.pathname === '/health') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{"status":"ok"}');
			return;
		}
		if (url.pathname === '/evidence') {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify(evidence));
			return;
		}
		if (url.pathname === '/hash' && request.method === 'POST') {
			const body = await readBoundedBody(request);
			evidence.hashRequests += 1;
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(
				JSON.stringify({
					base64: body.toString('base64'),
					sha256: createHash('sha256').update(body).digest('hex'),
					sizeBytes: body.byteLength,
				}),
			);
			return;
		}
		if (url.pathname === '/auth.mp4') {
			if (!equalHeader(request.headers.cookie, expectedCookie)) {
				response.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' });
				response.end('authentication required');
				return;
			}
			evidence.authenticatedOriginRequests += 1;
			await serveFile(request, response, 'direct.mp4');
			return;
		}
		if (url.pathname === '/playlist') {
			servePlaylist(response, 'Synthetic playlist', ['/alpha.mp4', '/bravo.mp4']);
			return;
		}
		if (url.pathname === '/capacity-playlist') {
			servePlaylist(response, 'Capacity playlist', ['/capacity.mp4', '/manifest.mpd']);
			return;
		}
		if (url.pathname === '/transfer-failure-playlist') {
			servePlaylist(response, 'Atomic transfer fixture', [
				'/alpha.mp4',
				'/oversized.mp4',
			]);
			return;
		}
		if (url.pathname === '/slow.mp4') {
			evidence.slowRequests += 1;
			response.writeHead(200, {
				'content-type': 'video/mp4',
				'transfer-encoding': 'chunked',
			});
			const timer = setInterval(() => response.write(Buffer.alloc(1024, 0x5a)), 250);
			response.once('close', () => clearInterval(timer));
			return;
		}

		const fileName = url.pathname.slice(1);
		if (!/^[a-z0-9][a-z0-9.-]*$/u.test(fileName)) {
			response.writeHead(404);
			response.end();
			return;
		}
		await serveFile(request, response, fileName);
	})().catch(() => {
		if (!response.headersSent) response.writeHead(404);
		response.end();
	});
});

const proxy = createServer((request, response) => {
	void (async () => {
		if (!equalHeader(request.headers['proxy-authorization'], expectedProxyAuthorization)) {
			response.writeHead(407, { 'proxy-authenticate': 'Basic realm="fixture-proxy"' });
			response.end('proxy authentication required');
			return;
		}
		if (!request.url) throw new Error('Proxy URL is missing.');
		const target = new URL(request.url);
		const originAddress = origin.address();
		if (
			target.protocol !== 'http:' ||
			!['fixture', 'fixture.example.test', '127.0.0.1'].includes(target.hostname) ||
			typeof originAddress !== 'object' ||
			originAddress === null ||
			Number(target.port) !== originAddress.port
		) {
			response.writeHead(403);
			response.end('target forbidden');
			return;
		}
		evidence.authenticatedProxyRequests += 1;
		const forwardedHeaders = {};
		for (const header of ['authorization', 'cookie', 'range', 'user-agent']) {
			const value = request.headers[header];
			if (typeof value === 'string') forwardedHeaders[header] = value;
		}
		const upstream = createRequest(
			{
				headers: forwardedHeaders,
				host: '127.0.0.1',
				method: request.method,
				path: `${target.pathname}${target.search}`,
				port: originAddress.port,
			},
			(upstreamResponse) => {
				response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
				upstreamResponse.pipe(response);
			},
		);
		upstream.once('error', () => response.destroy());
		request.pipe(upstream);
	})().catch(() => {
		if (!response.headersSent) response.writeHead(502);
		response.end();
	});
});

const originPort = Number(process.env.ORIGIN_PORT ?? 8080);
const proxyPort = Number(process.env.PROXY_PORT ?? 8081);
await Promise.all([
	new Promise((resolveListen, rejectListen) => {
		origin.once('error', rejectListen);
		origin.listen(originPort, '0.0.0.0', resolveListen);
	}),
	new Promise((resolveListen, rejectListen) => {
		proxy.once('error', rejectListen);
		proxy.listen(proxyPort, '0.0.0.0', resolveListen);
	}),
]);

const originAddress = origin.address();
const proxyAddress = proxy.address();
if (
	typeof originAddress !== 'object' ||
	originAddress === null ||
	typeof proxyAddress !== 'object' ||
	proxyAddress === null
) {
	throw new Error('Fixture services did not bind TCP ports.');
}
process.stdout.write(
	`${JSON.stringify({ originPort: originAddress.port, proxyPort: proxyAddress.port })}\n`,
);

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		origin.close();
		proxy.close();
	});
}
