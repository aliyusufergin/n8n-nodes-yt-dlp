import { connect, createServer } from 'node:net';

// Docker 28+ does not wire published ports for a container attached only to
// `internal` networks. The stack keeps `e2e` and `control` internal so n8n has
// no egress, and this forwarder is the single service on the non-internal
// `edge` network: it owns the published host ports and relays them inward.
const routes = [
	{ listen: 5678, target: { host: 'main', port: 5678 } },
	{ listen: 8080, target: { host: 'fixture', port: 8080 } },
];

for (const route of routes) {
	createServer((client) => {
		const upstream = connect(route.target.port, route.target.host);
		client.on('error', () => upstream.destroy());
		upstream.on('error', () => client.destroy());
		client.pipe(upstream);
		upstream.pipe(client);
	}).listen(route.listen, '0.0.0.0');
}
