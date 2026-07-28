import { appendFile, readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { basename, join } from 'node:path';

const registryRoot = process.env.REGISTRY_ROOT;
if (!registryRoot) throw new Error('REGISTRY_ROOT is required.');

const registry = JSON.parse(await readFile(join(registryRoot, 'registry.json'), 'utf8'));
const requestLogPath = join(registryRoot, 'requests.ndjson');

function sendJson(response, statusCode, value) {
	const body = Buffer.from(JSON.stringify(value));
	response.writeHead(statusCode, {
		'content-length': body.byteLength,
		'content-type': 'application/json',
	});
	response.end(body);
}

async function handle(request, response) {
	const url = new URL(request.url ?? '/', 'http://registry.npmjs.org');
	await appendFile(
		requestLogPath,
		`${JSON.stringify({ method: request.method, path: url.pathname })}\n`,
	);
	if (url.pathname === '/-/ping') {
		sendJson(response, 200, {});
		return;
	}
	if (url.pathname === '/api/package' && request.method === 'POST') {
		sendJson(response, 200, { status: 'OK' });
		return;
	}
	if (url.pathname === '/-/npm/v1/security/advisories/bulk' && request.method === 'POST') {
		sendJson(response, 200, {});
		return;
	}

	const pathParts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	const packageName = pathParts[0];
	const metadata = registry[packageName];
	if (!metadata) {
		sendJson(response, 404, { error: 'package not found' });
		return;
	}
	if (pathParts.length === 1) {
		sendJson(response, 200, metadata);
		return;
	}
	if (pathParts.length === 3 && pathParts[1] === '-') {
		const tarballName = basename(pathParts[2]);
		const expectedTarball = Object.values(metadata.versions).some(
			(version) => new URL(version.dist.tarball).pathname.endsWith(`/${tarballName}`),
		);
		if (!expectedTarball) {
			sendJson(response, 404, { error: 'tarball not found' });
			return;
		}
		const body = await readFile(join(registryRoot, 'tarballs', tarballName));
		response.writeHead(200, {
			'content-length': body.byteLength,
			'content-type': 'application/octet-stream',
		});
		response.end(body);
		return;
	}
	sendJson(response, 404, { error: 'not found' });
}

const keyPath = process.env.REGISTRY_TLS_KEY;
const certificatePath = process.env.REGISTRY_TLS_CERT;
const server =
	keyPath && certificatePath
		? createHttpsServer(
				{
					cert: await readFile(certificatePath),
					key: await readFile(keyPath),
				},
				(request, response) => void handle(request, response),
			)
		: createHttpServer((request, response) => void handle(request, response));

const registryPort = Number(process.env.REGISTRY_PORT ?? (keyPath ? 443 : 4873));
await new Promise((resolveListen, rejectListen) => {
	server.once('error', rejectListen);
	server.listen(registryPort, '0.0.0.0', resolveListen);
});
const address = server.address();
if (typeof address !== 'object' || address === null) {
	throw new Error('Registry did not bind a TCP port.');
}
process.stdout.write(`${JSON.stringify({ registryPort: address.port })}\n`);
for (const signal of ['SIGINT', 'SIGTERM']) server.once(signal, () => server.close());
