import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseFlatted } from 'flatted';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(process.argv[2] ?? '.');
const suiteRoot = join(repositoryRoot, 'e2e/n8n-2.27.4');
const n8nTag = process.env.E2E_N8N_TAG;
const n8nImageReference = process.env.E2E_N8N_IMAGE;
const n8nIndexDigest = process.env.E2E_N8N_INDEX_DIGEST;
const n8nRole = process.env.E2E_N8N_ROLE;
const scaleRecovery = process.env.E2E_SCALE_RECOVERY === 'true';
if (!n8nTag || !/^\d+\.\d+\.\d+$/u.test(n8nTag)) {
	throw new Error('E2E_N8N_TAG must be an exact version.');
}
if (
	!n8nImageReference ||
	!/^docker\.n8n\.io\/n8nio\/n8n@sha256:[a-f0-9]{64}$/u.test(n8nImageReference)
) {
	throw new Error('E2E_N8N_IMAGE must pin an exact official n8n image digest.');
}
if (!n8nIndexDigest || !/^sha256:[a-f0-9]{64}$/u.test(n8nIndexDigest)) {
	throw new Error('E2E_N8N_INDEX_DIGEST must be an exact image-index digest.');
}
if (!n8nRole) throw new Error('E2E_N8N_ROLE is required.');
const generatedRoot = join(suiteRoot, '.generated', n8nTag);
const composePath = join(suiteRoot, 'compose.yaml');
const n8nPort = Number(process.env.E2E_N8N_PORT ?? 15678);
const fixturePort = Number(process.env.E2E_FIXTURE_PORT ?? 18080);
const n8nBaseUrl = `http://127.0.0.1:${n8nPort}`;
const packageVersion = '0.2.0';
const n8nImage = {
	digest: n8nImageReference.split('@')[1],
	indexDigest: n8nIndexDigest,
	platform: 'linux/amd64',
	reference: n8nImageReference,
	role: n8nRole,
	tag: n8nTag,
};
const secretSentinels = ['cookie-secret', 'proxy-password'];
const composeProject = `n8n-yt-dlp-${n8nTag.replaceAll('.', '')}`;
const dockerEnvironment = {
	...process.env,
	DOCKER_CONFIG: join(generatedRoot, '.docker'),
	DOCKER_HOST: process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock',
	E2E_FIXTURE_PORT: String(fixturePort),
	E2E_GENERATED_ROOT: generatedRoot,
	E2E_N8N_IMAGE: n8nImageReference,
	E2E_N8N_PORT: String(n8nPort),
	E2E_REINSTALL_MISSING_PACKAGES: String(scaleRecovery),
	E2E_SUITE_ROOT: suiteRoot,
};
const composeArguments = [
	'compose',
	'-f',
	composePath,
	'-p',
	composeProject,
];
const downArguments = scaleRecovery
	? [
			'--profile',
			'scale-recovery-online',
			'--profile',
			'scale-recovery-late',
			'down',
			'--volumes',
			'--remove-orphans',
		]
	: ['down', '--volumes', '--remove-orphans'];

async function run(command, arguments_, options = {}) {
	return await execFileAsync(command, arguments_, {
		cwd: repositoryRoot,
		env: dockerEnvironment,
		maxBuffer: 40 * 1024 * 1024,
		...options,
	});
}

async function compose(arguments_, options = {}) {
	return await run('docker', [...composeArguments, ...arguments_], options);
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function report(phase) {
	process.stdout.write(`${JSON.stringify({ phase })}\n`);
}

async function poll(description, operation, options = {}) {
	const timeoutMs = options.timeoutMs ?? 180_000;
	const intervalMs = options.intervalMs ?? 1_000;
	const deadline = Date.now() + timeoutMs;
	let lastError;
	while (Date.now() < deadline) {
		try {
			const value = await operation();
			if (value !== undefined && value !== false) return value;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
	}
	throw new Error(
		`${description} timed out.${lastError instanceof Error ? ` ${lastError.message}` : ''}`,
	);
}

class N8nClient {
	cookie;

	async request(path, options = {}) {
		const headers = { accept: 'application/json', ...options.headers };
		if (options.body !== undefined) headers['content-type'] = 'application/json';
		if (options.auth !== false && this.cookie) headers.cookie = this.cookie;
		const response = await fetch(`${n8nBaseUrl}/rest${path}`, {
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			headers,
			method: options.method ?? 'GET',
		});
		const text = await response.text();
		let decoded;
		try {
			decoded = text === '' ? undefined : JSON.parse(text);
		} catch {
			decoded = text;
		}
		if (!response.ok) {
			throw new Error(
				`${options.method ?? 'GET'} ${path} returned ${response.status}: ${text.slice(0, 2_000)}`,
			);
		}
		const setCookie = response.headers.get('set-cookie');
		if (setCookie) this.cookie = setCookie.split(';', 1)[0];
		return decoded?.data ?? decoded;
	}

	async setupOwner() {
		const owner = await this.request('/owner/setup', {
			auth: false,
			body: {
				email: 'e2e-owner@example.test',
				firstName: 'E2E',
				lastName: 'Owner',
				password: 'N8n-Yt-Dlp-E2e-Password1',
			},
			method: 'POST',
		});
		assert(this.cookie, 'Owner setup did not issue an authentication cookie.');
		return owner;
	}

	async createWorkflow(workflow) {
		return await this.request('/workflows', { body: workflow, method: 'POST' });
	}

	async runManual(workflow, destinationNode) {
		const started = await this.request(`/workflows/${workflow.id}/run`, {
			body: {
				destinationNode: { mode: 'inclusive', nodeName: destinationNode },
				workflowData: workflow,
			},
			method: 'POST',
		});
		assert(typeof started.executionId === 'string', 'Manual execution returned no execution ID.');
		return started.executionId;
	}

	async execution(executionId) {
		return await this.request(`/executions/${executionId}`);
	}

	async waitForExecution(executionId) {
		return await poll(
			`execution ${executionId}`,
			async () => {
				const execution = await this.execution(executionId);
				return ['new', 'running', 'waiting'].includes(execution.status)
					? undefined
					: execution;
			},
			{ timeoutMs: 180_000 },
		);
	}
}

function node(name, type, typeVersion, parameters, position, extra = {}) {
	return {
		id: randomUUID(),
		name,
		parameters,
		position,
		type,
		typeVersion,
		...extra,
	};
}

function workflowDefinition({
	activeWebhookPath,
	argumentsValue = '',
	continueOnFail = false,
	credential,
	name,
	roundTrip = true,
	sourceUrl,
	ytParameters = {},
}) {
	const triggerName = activeWebhookPath ? 'Webhook' : 'Manual Trigger';
	const trigger = activeWebhookPath
		? node(
				triggerName,
				'n8n-nodes-base.webhook',
				2,
				{
					httpMethod: 'POST',
					options: {},
					path: activeWebhookPath,
					responseMode: 'lastNode',
				},
				[0, 0],
				{ webhookId: randomUUID() },
			)
		: node(triggerName, 'n8n-nodes-base.manualTrigger', 1, {}, [0, 0]);
	const ytDlp = node(
		'YT-DLP',
		'n8n-nodes-yt-dlp.ytDlp',
		1,
		{
			arguments: argumentsValue,
			maximumArtifactCount: 20,
			maximumArtifactSizeMiB: 128,
			maximumTotalArtifactSizeMiB: 256,
			requestTimeoutMinutes: 30,
			sourceUrl,
			...ytParameters,
		},
		[260, 0],
		{
			continueOnFail,
			credentials: credential
				? { ytDlpAuthentication: { id: credential.id, name: credential.name } }
				: undefined,
			onError: continueOnFail ? 'continueRegularOutput' : undefined,
		},
	);
	const nodes = [trigger, ytDlp];
	const connections = {
		[triggerName]: { main: [[{ index: 0, node: 'YT-DLP', type: 'main' }]] },
	};
	if (roundTrip) {
		nodes.push(
			node(
				'Round-trip',
				'n8n-nodes-base.httpRequest',
				4.2,
				{
					contentType: 'binaryData',
					inputDataFieldName: 'data',
					method: 'POST',
					options: {},
					sendBody: true,
					url: 'http://fixture:8080/hash',
				},
				[520, 0],
			),
		);
		connections['YT-DLP'] = {
			main: [[{ index: 0, node: 'Round-trip', type: 'main' }]],
		};
	}
	return {
		active: false,
		connections,
		name,
		nodes,
		settings: { executionOrder: 'v1' },
	};
}

function executionData(execution) {
	return typeof execution.data === 'string' ? parseFlatted(execution.data) : execution.data;
}

function nodeItems(execution, nodeName) {
	const data = executionData(execution);
	const tasks = data?.resultData?.runData?.[nodeName];
	assert(
		Array.isArray(tasks) && tasks.length > 0,
		`Execution has no ${nodeName} run data: ${JSON.stringify({
			dataKeys: Object.keys(data ?? {}),
			errorCode: data?.resultData?.error?.context?.errorCode,
			errorMessage: data?.resultData?.error?.message,
			lastNodeExecuted: data?.resultData?.lastNodeExecuted,
			resultDataKeys: Object.keys(data?.resultData ?? {}),
			runNodes: Object.keys(data?.resultData?.runData ?? {}),
			status: execution.status,
		})}`,
	);
	const items = tasks.at(-1)?.data?.main?.[0];
	assert(Array.isArray(items), `Execution has no ${nodeName} output items.`);
	return items;
}

async function createAndRunManual(client, options) {
	const workflow = await client.createWorkflow(workflowDefinition(options));
	const destination = options.roundTrip === false ? 'YT-DLP' : 'Round-trip';
	const executionId = await client.runManual(workflow, destination);
	const execution = await client.waitForExecution(executionId);
	return {
		execution,
		executionId,
		items: nodeItems(execution, destination),
		workflow,
	};
}

function assertExactPackageState(state) {
	assert(
		[state.main.version, state.selector.version, state.platform.version].every(
			(version) => version === packageVersion,
		),
		'Main, selector, and platform packages are not in version lockstep.',
	);
	assert(
		state.platform.name === 'n8n-nodes-yt-dlp-linux-x64',
		'Unexpected platform package was selected.',
	);
}

async function packageState(service) {
	const script = `
const { createRequire } = require('node:module');
const mainPath = '/home/node/.n8n/nodes/node_modules/n8n-nodes-yt-dlp/package.json';
const main = require(mainPath);
const fromMain = createRequire(mainPath);
const selectorPath = fromMain.resolve('n8n-nodes-yt-dlp-platform/package.json');
const selector = require(selectorPath);
const fromSelector = createRequire(selectorPath);
const platformPath = fromSelector.resolve('n8n-nodes-yt-dlp-linux-x64/package.json');
const platform = require(platformPath);
process.stdout.write(JSON.stringify({
  main: { name: main.name, version: main.version, path: mainPath },
  selector: { name: selector.name, version: selector.version, path: selectorPath },
  platform: { name: platform.name, version: platform.version, path: platformPath },
}));
`;
	const { stdout } = await compose(['exec', '-T', service, 'node', '-e', script]);
	return JSON.parse(stdout.trim());
}

async function workerReadiness(service) {
	const script = `
fetch('http://127.0.0.1:5678/healthz/readiness')
  .then(async (response) => {
    process.stdout.write(JSON.stringify({
      body: await response.text(),
      status: response.status,
    }));
    if (!response.ok) process.exitCode = 1;
  })
  .catch(() => {
    process.exitCode = 1;
  });
`;
	const readiness = await poll(
		`${service} database/Redis readiness`,
		async () => {
			const { stdout } = await compose(['exec', '-T', service, 'node', '-e', script]);
			return JSON.parse(stdout.trim());
		},
		{ timeoutMs: 180_000, intervalMs: 2_000 },
	);
	return {
		...readiness,
		scope: 'database-and-redis-only',
	};
}

async function startWorkers(services) {
	await compose(['start', ...services]);
	return await Promise.all(services.map(async (service) => await workerReadiness(service)));
}

async function executeOnOnlyWorker(client, target, workers, name) {
	const otherWorkers = workers.filter((service) => service !== target);
	if (otherWorkers.length > 0) await compose(['stop', ...otherWorkers]);
	await startWorkers([target]);
	const { stdout } = await compose(['ps', '--status', 'running', '--services']);
	const runningWorkers = stdout
		.trim()
		.split('\n')
		.filter((service) => workers.includes(service));
	assert(
		JSON.stringify(runningWorkers) === JSON.stringify([target]),
		`Expected only ${target} to accept queue work, found ${runningWorkers.join(', ')}.`,
	);
	const run = await createAndRunManual(client, {
		name,
		roundTrip: false,
		sourceUrl: 'http://fixture:8080/direct.mp4',
	});
	assert(run.execution.status === 'success', `${target} queue execution failed.`);
	assert(run.items.length === 1, `${target} queue execution returned the wrong item count.`);
	return {
		executionId: run.executionId,
		outcome: 'pass',
		routingProof: 'only-running-queue-worker',
		service: target,
	};
}

async function recoverEmptyWorker(service, volume, profile) {
	await compose(['rm', '--stop', '--force', service]);
	await run('docker', ['volume', 'rm', `${composeProject}_${volume}`]);
	const arguments_ =
		profile === undefined
			? ['up', '-d', '--wait', service]
			: ['--profile', profile, 'up', '-d', '--wait', service];
	await compose(arguments_, { timeout: 300_000 });
	const readiness = await workerReadiness(service);
	const packages = await poll(
		`${service} exact-version missing-package recovery`,
		async () => await packageState(service),
		{ timeoutMs: 300_000, intervalMs: 2_000 },
	);
	assertExactPackageState(packages);
	return { packages, readiness };
}

async function workerPackageMount(service) {
	const { stdout: containerIdOutput } = await compose(['ps', '--all', '-q', service]);
	const containerId = containerIdOutput.trim();
	assert(containerId !== '', `No container found for ${service}.`);
	const { stdout } = await run('docker', ['inspect', containerId]);
	const inspected = JSON.parse(stdout);
	const mount = inspected[0]?.Mounts?.find(
		(candidate) => candidate.Destination === '/home/node/.n8n',
	);
	assert(mount?.Type === 'volume', `${service} does not use an isolated package volume.`);
	return { destination: mount.Destination, source: mount.Name, type: mount.Type };
}

async function mutateWorkerToolchain(service, mutation) {
	const script = `
const { appendFileSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const mainPath = '/home/node/.n8n/nodes/node_modules/n8n-nodes-yt-dlp/package.json';
const selectorPath = createRequire(mainPath).resolve('n8n-nodes-yt-dlp-platform/package.json');
const platformPath = createRequire(selectorPath).resolve('n8n-nodes-yt-dlp-linux-x64/package.json');
const platformRoot = dirname(platformPath);
const mutation = ${JSON.stringify(mutation)};
if (mutation === 'corrupt') {
  appendFileSync(join(platformRoot, 'bin/yt-dlp'), '\\ncorrupt-toolchain\\n');
} else if (mutation === 'missing') {
  renameSync(platformRoot, platformRoot + '.missing');
} else if (mutation === 'wrong') {
  const metadata = JSON.parse(readFileSync(platformPath, 'utf8'));
  metadata.version = '9.9.9';
  writeFileSync(platformPath, JSON.stringify(metadata));
} else {
  throw new Error('Unknown toolchain mutation.');
}
process.stdout.write(JSON.stringify({ mutation, platformRoot }));
`;
	const { stdout } = await compose(['exec', '-T', service, 'node', '-e', script]);
	return JSON.parse(stdout.trim());
}

async function proveToolchainFailClosed(client, service, mutation) {
	const mutated = await mutateWorkerToolchain(service, mutation);
	const fixtureEvidenceBefore = await readFixtureEvidence();
	const workflow = await client.createWorkflow(
		workflowDefinition({
			continueOnFail: true,
			name: `E2E ${mutation} toolchain fail-closed`,
			roundTrip: false,
			sourceUrl: 'http://fixture:8080/direct.mp4',
		}),
	);
	const executionId = await client.runManual(workflow, 'YT-DLP');
	const execution = await client.waitForExecution(executionId);
	assert(
		execution.status === 'error',
		`${mutation} toolchain failure was not global: ${execution.status}.`,
	);
	const fixtureEvidenceAfter = await readFixtureEvidence();
	assert(
		fixtureEvidenceAfter.mediaRequests === fixtureEvidenceBefore.mediaRequests,
		`${mutation} toolchain failure reached the media fixture.`,
	);
	const { stdout: workerLogs } = await compose(['logs', '--no-color', service]);
	assert(
		workerLogs.includes('TOOLCHAIN_ATTESTATION_FAILED'),
		`${mutation} toolchain failure did not emit its global error code.`,
	);
	await compose(['exec', '-T', service, 'test', '!', '-e', '/tmp/n8n-yt-dlp-system-fallback-used']);
	return {
		executionId,
		mutation: mutated.mutation,
		outcome: 'pass',
		systemFallbackObserved: false,
	};
}

async function binaryRowCount(executionId) {
	assert(/^\d+$/u.test(executionId), 'Execution ID is not numeric.');
	const query = `SELECT count(*) FROM binary_data WHERE "sourceType" = 'execution' AND "sourceId" = '${executionId}'`;
	const stdout = await postgresQuery(query);
	return Number(stdout.trim());
}

async function postgresQuery(query) {
	const { stdout } = await compose([
		'exec',
		'-T',
		'postgres',
		'psql',
		'-U',
		'n8n',
		'-d',
		'n8n',
		'-Atc',
		query,
	]);
	return stdout;
}

function successfulJson(items) {
	return items.map((item) => item.json);
}

async function readFixtureEvidence() {
	const response = await fetch(`http://127.0.0.1:${fixturePort}/evidence`);
	assert(response.ok, 'Fixture evidence endpoint failed.');
	return await response.json();
}

async function runScaleRecoveryLane(client) {
	const onlineWorkers = ['worker', 'worker-secondary'];
	const allWorkers = [...onlineWorkers, 'worker-late'];
	const onlinePackageStates = [];
	for (const service of onlineWorkers) {
		const packages = await poll(
			`${service} online install-event propagation`,
			async () => await packageState(service),
			{ timeoutMs: 300_000, intervalMs: 2_000 },
		);
		assertExactPackageState(packages);
		onlinePackageStates.push({ packages, service });
	}

	const onlineExecutions = [];
	for (const service of onlineWorkers) {
		onlineExecutions.push(
			await executeOnOnlyWorker(
				client,
				service,
				onlineWorkers,
				`E2E online propagation ${service}`,
			),
		);
	}
	await startWorkers(onlineWorkers);

	const recreated = await recoverEmptyWorker('worker', 'worker_data');
	const recreatedExecution = await executeOnOnlyWorker(
		client,
		'worker',
		onlineWorkers,
		'E2E recreated worker recovery',
	);
	await startWorkers(onlineWorkers);

	await compose(['--profile', 'scale-recovery-late', 'up', '-d', '--wait', 'worker-late'], {
		timeout: 300_000,
	});
	const lateReadiness = await workerReadiness('worker-late');
	const latePackages = await poll(
		'late worker exact-version missing-package recovery',
		async () => await packageState('worker-late'),
		{ timeoutMs: 300_000, intervalMs: 2_000 },
	);
	assertExactPackageState(latePackages);
	const lateExecution = await executeOnOnlyWorker(
		client,
		'worker-late',
		allWorkers,
		'E2E late worker recovery',
	);

	const packageMounts = Object.fromEntries(
		await Promise.all(
			allWorkers.map(async (service) => [service, await workerPackageMount(service)]),
		),
	);
	assert(
		new Set(Object.values(packageMounts).map(({ source }) => source)).size === allWorkers.length,
		'Workers unexpectedly share a Community Packages volume.',
	);

	const failClosed = [];
	failClosed.push(await proveToolchainFailClosed(client, 'worker-late', 'corrupt'));
	for (const mutation of ['wrong', 'missing']) {
		await recoverEmptyWorker('worker-late', 'worker_late_data', 'scale-recovery-late');
		failClosed.push(await proveToolchainFailClosed(client, 'worker-late', mutation));
	}

	await compose(['stop', 'worker-secondary', 'worker-late']);
	await recoverEmptyWorker('worker', 'worker_data');

	return {
		failClosed,
		lateWorker: {
			execution: lateExecution,
			nodeReadiness: {
				exactPackageVersion: packageVersion,
				executionOutcome: lateExecution.outcome,
			},
			packages: latePackages,
			queueReadiness: lateReadiness,
		},
		mediaWorkspace: {
			binaryStorage: 'database',
			packageMounts,
			sharedWorkerPackageVolume: false,
			workerPackageOrContainerMediaSharing: false,
		},
		onlineWorkers: onlinePackageStates.map((state) => ({
			...state,
			execution: onlineExecutions.find(({ service }) => service === state.service),
		})),
		outcome: 'pass',
		recreatedWorker: {
			emptyPackageState: true,
			execution: recreatedExecution,
			missingPackageRecovery: 'N8N_REINSTALL_MISSING_PACKAGES=true',
			packages: recreated.packages,
			queueReadiness: recreated.readiness,
		},
	};
}

async function main() {
	report('prepare:start');
	await run('node', [
		join(suiteRoot, 'prepare.mjs'),
		repositoryRoot,
		generatedRoot,
	]);
	report('prepare:complete');
	report('toolchain-smoke:start');
	await run('node', [
		join(suiteRoot, 'toolchain-smoke.mjs'),
		repositoryRoot,
		generatedRoot,
		n8nImageReference,
	]);
	report('toolchain-smoke:complete');
	await mkdir(dockerEnvironment.DOCKER_CONFIG, { recursive: true });
	await writeFile(join(dockerEnvironment.DOCKER_CONFIG, 'config.json'), '{}');
	const prepared = JSON.parse(
		await readFile(join(generatedRoot, 'evidence/prepared.json'), 'utf8'),
	);
	const fixtureByName = Object.fromEntries(
		prepared.fixtures.map((fixture) => [fixture.fileName, fixture]),
	);
	const evidence = {
		completedAt: undefined,
		fixtureService: undefined,
		image: n8nImage,
		packages: prepared.packages,
		registryRequests: undefined,
		scenarios: {},
		schemaVersion: 1,
	};

	await run('npm', [
		'test',
		'--',
		'test/process.test.ts',
		'-t',
		'terminates output floods above the combined eight MiB limit',
	]);
	evidence.scenarios.outputLimit = {
		evidenceSource: 'controlled process seam',
		outcome: 'pass',
	};

	let stackStarted = false;
	try {
		report('stack:reset');
		await compose(downArguments, { timeout: 180_000 });
		report('stack:reset-complete');
		report('stack:start');
		stackStarted = true;
		const stackArguments = scaleRecovery
			? ['--profile', 'scale-recovery-online', 'up', '-d', '--wait', '--quiet-pull']
			: ['up', '-d', '--wait', '--quiet-pull'];
		await compose(stackArguments, { timeout: 600_000 });
		report('stack:ready');
		const { stdout: reportedVersionOutput } = await compose([
			'exec',
			'-T',
			'main',
			'n8n',
			'--version',
		]);
		const reportedVersion = reportedVersionOutput.trim();
		assert(
			reportedVersion === n8nTag,
			`Pinned image reported n8n ${reportedVersion}, expected ${n8nTag}.`,
		);
		evidence.image.reportedVersion = reportedVersion;
		const client = new N8nClient();
		await poll('n8n API', async () => {
			const response = await fetch(`${n8nBaseUrl}/healthz`);
			return response.ok;
		});
		report('owner:start');
		await client.setupOwner();
		report('owner:complete');

		report('community-package-install:start');
		const installed = await client.request('/community-packages', {
			body: {
				name: 'n8n-nodes-yt-dlp',
				verify: false,
				version: packageVersion,
			},
			method: 'POST',
		});
		report('community-package-install:complete');
		assert(
			installed.installedVersion === packageVersion,
			'Community Packages installed an unexpected version.',
		);
		const mainPackages = await poll(
			'main package loading',
			async () => await packageState('main'),
			{ timeoutMs: 300_000, intervalMs: 2_000 },
		);
		const workerPackages = await poll(
			'worker package propagation',
			async () => await packageState('worker'),
			{ timeoutMs: 300_000, intervalMs: 2_000 },
		);
		for (const state of [mainPackages, workerPackages]) {
			assertExactPackageState(state);
		}
		report('worker-node-readiness:start');
		await poll(
			'worker node loading',
			async () =>
				await createAndRunManual(client, {
					name: 'E2E worker node readiness',
					roundTrip: false,
					sourceUrl: 'http://fixture:8080/direct.mp4',
				}),
			{ timeoutMs: 300_000, intervalMs: 2_000 },
		);
		report('worker-node-readiness:complete');
		evidence.scenarios.install = {
			main: mainPackages,
			outcome: 'pass',
			requestedVersion: packageVersion,
			worker: workerPackages,
		};
		if (scaleRecovery) {
			report('scale-recovery:start');
			evidence.scenarios.scaleRecovery = await runScaleRecoveryLane(client);
			report('scale-recovery:complete');
		}

		report('scenarios:start');
		const manualDirect = await createAndRunManual(client, {
			name: 'E2E manual direct',
			sourceUrl: 'http://fixture:8080/direct.mp4',
		});
		assert(manualDirect.execution.status === 'success', 'Manual direct execution failed.');
		const manualDirectJson = successfulJson(manualDirect.items);
		assert(manualDirectJson.length === 1, 'Manual direct execution returned the wrong item count.');
		assert(
			manualDirectJson[0].sha256 === fixtureByName['direct.mp4'].sha256 &&
				manualDirectJson[0].base64 ===
					(
						await readFile(join(generatedRoot, 'fixtures/direct.mp4'))
					).toString('base64'),
			'Manual downstream node did not read the exact direct fixture bytes.',
		);
		const ytDlpItems = nodeItems(manualDirect.execution, 'YT-DLP');
		const binaryId = ytDlpItems[0]?.binary?.data?.id;
		assert(
			typeof binaryId === 'string' && /^database(?:-v\d+)?:/u.test(binaryId),
			'Artifact did not use database binary storage.',
		);

		const productionWorkflow = await client.createWorkflow(
			workflowDefinition({
				activeWebhookPath: 'yt-dlp-e2e-direct',
				name: 'E2E production direct',
				sourceUrl: 'http://fixture:8080/direct.mp4',
			}),
		);
		await client.request(`/workflows/${productionWorkflow.id}/activate`, {
			body: { versionId: productionWorkflow.versionId },
			method: 'POST',
		});
		const productionResponse = await fetch(
			`${n8nBaseUrl}/webhook/yt-dlp-e2e-direct`,
			{ method: 'POST' },
		);
		const productionJson = await productionResponse.json();
		assert(productionResponse.ok, 'Production webhook execution failed.');
		const normalizedProduction = Array.isArray(productionJson)
			? productionJson
			: [productionJson];
		assert(
			JSON.stringify(normalizedProduction) === JSON.stringify(manualDirectJson),
			'Production and offloaded-manual Result contracts differ.',
		);
		evidence.scenarios.direct = {
			binaryIdScheme: binaryId.split(':', 1)[0],
			exactBytesSha256: manualDirectJson[0].sha256,
			manualExecutionId: manualDirect.executionId,
			outcome: 'pass',
			productionWorkflowId: productionWorkflow.id,
		};

		const ffmpeg = await createAndRunManual(client, {
			argumentsValue: '-f bestvideo+bestaudio --merge-output-format mp4',
			name: 'E2E FFmpeg merge',
			sourceUrl: 'http://fixture:8080/manifest.mpd',
		});
		assert(ffmpeg.execution.status === 'success', 'FFmpeg execution failed.');
		assert(ffmpeg.items.length === 1, 'FFmpeg execution returned the wrong item count.');
		evidence.scenarios.ffmpeg = {
			executionId: ffmpeg.executionId,
			outcome: 'pass',
			result: ffmpeg.items[0].json,
		};

		const playlist = await createAndRunManual(client, {
			argumentsValue: '--yes-playlist --playlist-items 1-2',
			name: 'E2E playlist',
			sourceUrl: 'http://fixture:8080/playlist',
		});
		assert(playlist.execution.status === 'success', 'Playlist execution failed.');
		assert(playlist.items.length === 2, 'Playlist did not return two Artifacts.');
		const playlistHashes = successfulJson(playlist.items).map((item) => item.sha256);
		assert(
			playlistHashes.every((hash) => hash === fixtureByName['direct.mp4'].sha256),
			'Playlist downstream byte hashes differ from the fixtures.',
		);
		evidence.scenarios.playlist = {
			executionId: playlist.executionId,
			hashes: playlistHashes,
			outcome: 'pass',
		};

		const credential = await client.request('/credentials', {
			body: {
					data: {
						cookies:
							'# Netscape HTTP Cookie File\nfixture.example.test\tFALSE\t/\tFALSE\t0\tsession\tcookie-secret\n',
						proxyUrl:
							'http://proxy-user:proxy-password@fixture:8081',
					},
				name: 'E2E YT-DLP Authentication',
				type: 'ytDlpAuthentication',
			},
			method: 'POST',
		});
		const authenticated = await createAndRunManual(client, {
			credential,
			name: 'E2E authenticated proxy',
			sourceUrl: 'http://fixture.example.test:8080/auth.mp4',
		});
		assert(authenticated.execution.status === 'success', 'Authenticated proxy execution failed.');
		assert(
			authenticated.items[0].json.sha256 === fixtureByName['direct.mp4'].sha256,
			'Authenticated proxy returned unexpected bytes.',
		);
		evidence.scenarios.authentication = {
			executionId: authenticated.executionId,
			outcome: 'pass',
		};

		const continueOnFail = await createAndRunManual(client, {
			continueOnFail: true,
			name: 'E2E Continue On Fail',
			roundTrip: false,
			sourceUrl: 'ftp://fixture/direct.mp4',
		});
		assert(
			continueOnFail.items.length === 1 &&
				continueOnFail.items[0].json.status === 'error' &&
				continueOnFail.items[0].json.errorCode === 'INVALID_SOURCE_URL' &&
				continueOnFail.items[0].binary === undefined,
			'Continue On Fail did not return the stable binary-free Failure Item.',
		);
		evidence.scenarios.continueOnFail = {
			executionId: continueOnFail.executionId,
			outcome: 'pass',
			result: continueOnFail.items[0].json,
		};

		const resourceLimit = await createAndRunManual(client, {
			continueOnFail: true,
			name: 'E2E resource limit',
			roundTrip: false,
			sourceUrl: 'http://fixture:8080/oversized.mp4',
			ytParameters: {
				maximumArtifactSizeMiB: 1,
				maximumTotalArtifactSizeMiB: 2,
			},
		});
		assert(
			resourceLimit.items[0].json.errorCode === 'RESOURCE_LIMIT' &&
				resourceLimit.items[0].binary === undefined,
			'Resource limit did not return a binary-free RESOURCE_LIMIT Failure Item.',
		);
		evidence.scenarios.resourceLimit = {
			executionId: resourceLimit.executionId,
			outcome: 'pass',
		};

		await postgresQuery(
			'ALTER TABLE binary_data ADD CONSTRAINT e2e_binary_data_file_size CHECK ("fileSize" <= 1048576)',
		);
		try {
			const transferFailure = await createAndRunManual(client, {
				argumentsValue: '--yes-playlist --playlist-items 1-2',
				continueOnFail: true,
				name: 'E2E Nth binary transfer failure',
				roundTrip: false,
				sourceUrl: 'http://fixture:8080/transfer-failure-playlist',
			});
			assert(
				transferFailure.items.length === 1 &&
					transferFailure.items[0].json.errorCode === 'BINARY_TRANSFER_FAILED' &&
					transferFailure.items[0].binary === undefined,
				`Nth binary transfer failure published a partial Artifact Item: ${JSON.stringify(
					transferFailure.items.map((item) => ({
						hasBinary: item.binary !== undefined,
						json: item.json,
					})),
				)}`,
			);
			const unreferencedBeforePruning = await binaryRowCount(transferFailure.executionId);
			assert(
				unreferencedBeforePruning === 1,
				'Expected exactly one unreferenced backend write before pruning.',
			);
			await client.request('/executions/delete', {
				body: { ids: [transferFailure.executionId] },
				method: 'POST',
			});
			await poll('binary pruning', async () =>
				(await binaryRowCount(transferFailure.executionId)) === 0 ? true : undefined,
			);
			evidence.scenarios.binaryTransferFailure = {
				evidenceSource: 'disposable database CHECK constraint',
				executionId: transferFailure.executionId,
				outcome: 'pass',
				unreferencedRowsAfterPruning: 0,
				unreferencedRowsBeforePruning: unreferencedBeforePruning,
			};
		} finally {
			await postgresQuery(
				'ALTER TABLE binary_data DROP CONSTRAINT IF EXISTS e2e_binary_data_file_size',
			);
		}

		const cancellationWorkflow = await client.createWorkflow(
			workflowDefinition({
				name: 'E2E cancellation',
				roundTrip: false,
				sourceUrl: 'http://fixture:8080/slow.mp4',
			}),
		);
		const cancellationId = await client.runManual(cancellationWorkflow, 'YT-DLP');
		await poll('running cancellation execution', async () => {
			const execution = await client.execution(cancellationId);
			if (execution.status === 'new') return undefined;
			assert(
				execution.status === 'running',
				`Cancellation execution became ${execution.status} before it started.`,
			);
			return true;
		});
		await poll('slow fixture request', async () =>
			(await readFixtureEvidence()).slowRequests > 0 ? true : undefined,
		);
		await client.request(`/executions/${cancellationId}/stop`, { method: 'POST' });
		const cancelled = await client.waitForExecution(cancellationId);
		assert(
			['canceled', 'cancelled', 'error'].includes(cancelled.status),
			`Unexpected cancellation status: ${cancelled.status}`,
		);
		evidence.scenarios.cancellation = {
			executionId: cancellationId,
			outcome: 'pass',
			status: cancelled.status,
		};

		const fixtureEvidence = await readFixtureEvidence();
		assert(
			fixtureEvidence.authenticatedOriginRequests > 0 &&
				fixtureEvidence.authenticatedProxyRequests > 0 &&
				fixtureEvidence.hashRequests >= 5 &&
				fixtureEvidence.slowRequests > 0,
			'Fixture service did not observe the expected auth/proxy/hash boundaries.',
		);
		evidence.fixtureService = fixtureEvidence;

		const { stdout: workerLogs } = await compose(['logs', '--no-color', 'worker']);
		for (const sentinel of secretSentinels) {
			assert(!workerLogs.includes(sentinel), `Worker logs leaked secret sentinel ${sentinel}.`);
		}
		const nodeTerminalLogs = workerLogs
			.split('\n')
			.filter(
				(line) =>
					line.includes('yt-dlp execution summary') ||
					line.includes('yt-dlp request terminal'),
			)
			.join('\n');
		for (const forbidden of ['http://fixture', 'direct.mp4', 'oversized.mp4']) {
			assert(
				!nodeTerminalLogs.includes(forbidden),
				`Node terminal logs leaked forbidden input ${forbidden}.`,
			);
		}
		assert(
			nodeTerminalLogs.includes('yt-dlp execution summary') &&
				nodeTerminalLogs.includes('yt-dlp request terminal'),
			'Worker logs contain no bounded node terminal evidence.',
		);
		evidence.scenarios.logs = { outcome: 'pass' };

		const { stdout: workspaceCount } = await compose([
			'exec',
			'-T',
			'worker',
			'sh',
			'-c',
			"find /tmp/n8n-nodes-yt-dlp -mindepth 1 -maxdepth 1 -type d -name 'n8n-nodes-yt-dlp-execution-*' 2>/dev/null | wc -l",
		]);
		assert(Number(workspaceCount.trim()) === 0, 'Worker retained an Execution Workspace.');
		evidence.scenarios.cleanup = { outcome: 'pass', remainingExecutionWorkspaces: 0 };

		const registryRequests = (
			await readFile(join(generatedRoot, 'registry/requests.ndjson'), 'utf8')
		)
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((request_) => request_.path.startsWith('/n8n-nodes-yt-dlp'));
		for (const packageName of [
			'n8n-nodes-yt-dlp',
			'n8n-nodes-yt-dlp-platform',
			'n8n-nodes-yt-dlp-linux-x64',
		]) {
			assert(
				registryRequests.some((request_) => request_.path === `/${packageName}`),
				`Registry saw no metadata request for ${packageName}.`,
			);
		}
		evidence.registryRequests = registryRequests;
		evidence.completedAt = new Date().toISOString();
		const evidencePath = join(generatedRoot, `evidence/n8n-${n8nTag}.json`);
		await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
		report('scenarios:complete');
		process.stdout.write(`${evidencePath}\n`);
	} finally {
		if (stackStarted) {
			report('stack:stop');
			await compose(downArguments, { timeout: 180_000 });
			report('stack:stopped');
		}
	}
}

await main();
