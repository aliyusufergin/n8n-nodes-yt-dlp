import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseFlatted } from 'flatted';

import { captureCapacityEvidence, markPartialRun } from './capacity-evidence.mjs';
import {
	failureCodeCounts,
	queueLatencies,
	requestTimeLimitMs,
	settleRequestWait,
	summarizeRequestTimeLimit,
	timedOutRequestRecord,
} from './capacity-load.mjs';
import {
	createMetricsSampleTolerance,
	parseWorkerMetrics,
	settleMetricsRead,
} from './metrics-observer.mjs';
import {
	evaluateThreadRestriction,
	parseWorkerProcessSample,
	summarizeWorkerProcesses,
} from './process-observer.mjs';
import { collectUntilComplete } from './sample-loop.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(process.argv[2] ?? '.');
const suiteRoot = join(repositoryRoot, 'e2e/n8n-2.27.4');
const n8nTag = process.env.E2E_N8N_TAG;
const n8nImageReference = process.env.E2E_N8N_IMAGE;
const n8nIndexDigest = process.env.E2E_N8N_INDEX_DIGEST;
const n8nRole = process.env.E2E_N8N_ROLE;
const capacity = process.env.E2E_CAPACITY === 'true';
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
if (capacity && !scaleRecovery) {
	throw new Error('The capacity lane requires the frozen-head scale/recovery topology.');
}
const generatedRoot = join(suiteRoot, '.generated', n8nTag);
const composePath = join(suiteRoot, 'compose.yaml');
const n8nPort = Number(process.env.E2E_N8N_PORT ?? 15678);
const fixturePort = Number(process.env.E2E_FIXTURE_PORT ?? 18080);
const n8nBaseUrl = `http://127.0.0.1:${n8nPort}`;
// The lane installs the version this repository releases, so a release bump does not need every
// lane script edited in lockstep.
const packageVersion = JSON.parse(
	await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
).version;
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
	E2E_METRICS_ENABLED: String(capacity),
	E2E_N8N_IMAGE: n8nImageReference,
	E2E_N8N_PORT: String(n8nPort),
	E2E_REINSTALL_MISSING_PACKAGES: String(scaleRecovery),
	E2E_SUITE_ROOT: suiteRoot,
	E2E_WORKER_CONCURRENCY: capacity ? '10' : '1',
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

function report(phase, detail = {}) {
	process.stdout.write(`${JSON.stringify({ phase, ...detail })}\n`);
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

	async waitForExecution(executionId, timeoutMs = 180_000) {
		return await poll(
			`execution ${executionId}`,
			async () => {
				const execution = await this.execution(executionId);
				return ['new', 'running', 'waiting'].includes(execution.status)
					? undefined
					: execution;
			},
			{ timeoutMs },
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
	onError = continueOnFail ? 'continueRegularOutput' : undefined,
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
			onError,
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
	if (onError === 'continueErrorOutput') {
		// n8n appends the error output at workflow level, so the Failure Item branch is main[1].
		nodes.push(node('Error Handler', 'n8n-nodes-base.noOp', 1, {}, [520, 200]));
		connections['YT-DLP'] = {
			main: [
				connections['YT-DLP']?.main?.[0] ?? [],
				[{ index: 0, node: 'Error Handler', type: 'main' }],
			],
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

function parseByteValue(value) {
	const match = /^([\d.]+)\s*([kmgt]?i?b)$/iu.exec(value.trim());
	if (!match) throw new Error(`Cannot parse byte value: ${value}`);
	const factors = {
		b: 1,
		gb: 1_000_000_000,
		gib: 1024 ** 3,
		kb: 1_000,
		kib: 1024,
		mb: 1_000_000,
		mib: 1024 ** 2,
		tb: 1_000_000_000_000,
		tib: 1024 ** 4,
	};
	return Number(match[1]) * factors[match[2].toLowerCase()];
}

function percentile(values, percentileValue) {
	assert(values.length > 0, 'Cannot calculate a percentile without measurements.');
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.ceil((percentileValue / 100) * sorted.length) - 1];
}

async function containerId(service) {
	const { stdout } = await compose(['ps', '--all', '-q', service]);
	const id = stdout.trim();
	assert(id !== '', `No container found for ${service}.`);
	return id;
}

async function containerResourceSnapshot(serviceIds) {
	const { stdout } = await run('docker', [
		'stats',
		'--no-stream',
		'--format',
		'{{json .}}',
		...Object.values(serviceIds),
	]);
	const byId = new Map(
		stdout
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const stat = JSON.parse(line);
				return [stat.ID, stat];
			}),
	);
	return Object.fromEntries(
		Object.entries(serviceIds).map(([service, id]) => {
			const stat = [...byId.entries()].find(([shortId]) => id.startsWith(shortId))?.[1];
			assert(stat, `Docker stats returned no sample for ${service}.`);
			return [
				service,
				{
					blockInputBytes: parseByteValue(stat.BlockIO.split('/')[0]),
					blockOutputBytes: parseByteValue(stat.BlockIO.split('/')[1]),
					cpuPercent: Number.parseFloat(stat.CPUPerc),
					memoryBytes: parseByteValue(stat.MemUsage.split('/')[0]),
					pids: Number(stat.PIDs),
				},
			];
		}),
	);
}

async function workerMetricSnapshot() {
	const script = `
fetch('http://127.0.0.1:5678/metrics')
  .then(async (response) => {
    const body = await response.text();
    if (!response.ok) {
      throw new Error('metrics status ' + response.status + ': ' + body.slice(0, 500));
    }
    process.stdout.write(body);
  })
  .catch((error) => {
    process.stderr.write(error.message);
    process.exitCode = 1;
  });
`;
	const { stdout } = await compose(['exec', '-T', 'worker', 'node', '-e', script]);
	return parseWorkerMetrics(stdout);
}

async function workerProcessSnapshot(workerId) {
	const { stdout } = await run('docker', [
		'top',
		workerId,
		'-eo',
		'pid,ppid,rss,comm,args',
	]);
	return summarizeWorkerProcesses(parseWorkerProcessSample(stdout));
}

async function workerTemporaryDiskSnapshot() {
	const { stdout } = await compose([
		'exec',
		'-T',
		'worker',
		'sh',
		'-c',
		"if [ -d /tmp/n8n-nodes-yt-dlp ]; then du -sk /tmp/n8n-nodes-yt-dlp | cut -f1; else echo 0; fi; df -Pk /tmp | awk 'NR == 2 { print $4 }'",
	]);
	const [usedKiB, freeKiB] = stdout
		.trim()
		.split('\n')
		.map((value) => Number(value.trim()));
	assert(Number.isFinite(usedKiB) && Number.isFinite(freeKiB), 'Invalid worker temp-disk sample.');
	return { freeBytes: freeKiB * 1024, usedBytes: usedKiB * 1024 };
}

async function binaryStorageSnapshot() {
	const binary = JSON.parse(
		(
			await postgresQuery(
				"SELECT json_build_object('rows', count(*), 'bytes', coalesce(sum(\"fileSize\"), 0)) FROM binary_data",
			)
		).trim(),
	);
	return { bytes: Number(binary.bytes), rows: Number(binary.rows) };
}

async function storageSnapshot() {
	const binary = await binaryStorageSnapshot();
	const databaseBytes = Number(
		(await postgresQuery("SELECT pg_database_size('n8n')")).trim(),
	);
	const { stdout: redisInfo } = await compose([
		'exec',
		'-T',
		'redis',
		'redis-cli',
		'--raw',
		'INFO',
		'memory',
	]);
	const redisUsedMemoryBytes = Number(
		/^used_memory:(\d+)$/mu.exec(redisInfo)?.[1],
	);
	assert(Number.isFinite(redisUsedMemoryBytes), 'Redis exposed no used_memory measurement.');
	return {
		binaryBytes: binary.bytes,
		binaryRows: binary.rows,
		databaseBytes,
		redisUsedMemoryBytes,
	};
}

async function hostSnapshot() {
	const [meminfo, loadAverage, cpuStat] = await Promise.all([
		readFile('/proc/meminfo', 'utf8'),
		readFile('/proc/loadavg', 'utf8'),
		readFile('/proc/stat', 'utf8'),
	]);
	const memory = Object.fromEntries(
		meminfo
			.trim()
			.split('\n')
			.map((line) => {
				const [name, value] = line.split(/:\s+/u);
				return [name, Number(value.split(/\s+/u)[0]) * 1024];
			}),
	);
	const cpu = cpuStat
		.split('\n')[0]
		.trim()
		.split(/\s+/u)
		.slice(1)
		.map(Number);
	return {
		availableMemoryBytes: memory.MemAvailable,
		cpuIdleTicks: cpu[3] + (cpu[4] ?? 0),
		cpuTotalTicks: cpu.reduce((total, value) => total + value, 0),
		harnessRssBytes: process.memoryUsage().rss,
		loadAverage1Minute: Number(loadAverage.split(/\s+/u)[0]),
		totalMemoryBytes: memory.MemTotal,
	};
}

/**
 * Takes one capacity sample.
 *
 * A failed metrics reading costs the sample its `metrics` only: every other
 * measurement in the sample was taken from a different source and is still
 * exact, and the endpoint is likeliest to fail exactly when the run is under
 * the pressure whose container, host, and disk extrema decide the lane. The
 * failed reading is recorded against the run's metrics tolerance, which fails
 * the lane once the failure stops being transient.
 */
async function capacitySample(serviceIds, metricsTolerance) {
	const at = new Date().toISOString();
	const [containers, host, metricsRead, processes, storage, temporaryDisk] = await Promise.all([
		containerResourceSnapshot(serviceIds),
		hostSnapshot(),
		settleMetricsRead(workerMetricSnapshot),
		workerProcessSnapshot(serviceIds.worker),
		storageSnapshot(),
		workerTemporaryDiskSnapshot(),
	]);
	if (metricsRead.reason === undefined) {
		metricsTolerance.recordSuccess();
	} else {
		report('capacity:metrics-reading-skipped', { at, reason: metricsRead.reason });
		metricsTolerance.recordFailure({ at, reason: metricsRead.reason });
	}
	return {
		at,
		containers,
		host,
		metrics: metricsRead.metrics,
		processes,
		storage,
		temporaryDisk,
	};
}

/**
 * Describes the worker process observer for one window.
 *
 * Every window the lane judges the thread restriction over samples at the same
 * interval, so the load window and the FFmpeg probe window state it once here:
 * the two windows' observation counts are read side by side in the evidence,
 * and an interval that drifted between them would make that comparison a lie.
 */
function workerProcessObserver(workerId, collection) {
	return {
		collection,
		intervalMs: 100,
		snapshot: async () => await workerProcessSnapshot(workerId),
	};
}

async function collectCapacitySamples(serviceIds, operation) {
	const samples = [];
	const processObservations = [];
	const metricsTolerance = createMetricsSampleTolerance();
	const result = await collectUntilComplete(operation, [
		{
			collection: samples,
			intervalMs: 1_000,
			snapshot: async () => await capacitySample(serviceIds, metricsTolerance),
		},
		workerProcessObserver(serviceIds.worker, processObservations),
	]);
	return {
		metricsSampling: metricsTolerance.summary(),
		processObservations,
		result,
		samples,
	};
}

/**
 * Samples the packaged FFmpeg itself while it runs under the forced one-thread
 * restriction.
 *
 * The capacity load merges two one-second fixtures, so its FFmpeg lives for a
 * few milliseconds and no run of the lane has sampled it. This request instead
 * re-encodes a twenty-second fixture into another container, which is the one
 * postprocessing path that cannot be a stream copy: six hundred frames through
 * one x264 thread keep FFmpeg alive across many process observations. The
 * request runs after the load's own measurements are taken, so it costs the
 * recorded capacity envelope nothing.
 *
 * A probe that samples no FFmpeg leaves `ffmpegThreadsRestricted` false rather
 * than throwing. The lane's evidence is worth more than a fast failure: a
 * thrown probe would discard a completed load run, and an unproven restriction
 * is exactly what the acceptance flag exists to report.
 *
 * A probe whose own execution fails is reported the same way, for the same
 * reason. The probe runs immediately after a load window that may have just
 * measured a request the worker never finished, which is precisely when the
 * probe is likeliest to fail — throwing there would discard the sample series
 * and process observations the load lane exists to produce. What the probe
 * reached is recorded on its measurements instead, and an unproven restriction
 * still drops the capacity decision.
 */
async function runFfmpegThreadRestrictionProbe(client, serviceIds) {
	const observations = [];
	let probe;
	let failureReason;
	try {
		probe = await collectUntilComplete(
			async () =>
				await createAndRunManual(client, {
					argumentsValue: '--recode-video mkv',
					name: 'E2E FFmpeg thread restriction probe',
					roundTrip: false,
					sourceUrl: 'http://fixture:8080/recode.mp4',
				}),
			[workerProcessObserver(serviceIds.worker, observations)],
		);
	} catch (error) {
		failureReason = error instanceof Error ? error.message : String(error);
	}
	const artifactFileName = probe?.items.length === 1 ? probe.items[0].json.fileName : undefined;
	const recodedArtifactObserved =
		probe?.execution.status === 'success' &&
		typeof artifactFileName === 'string' &&
		artifactFileName.endsWith('.mkv');
	if (!recodedArtifactObserved) {
		report('capacity:ffmpeg-probe-unproven', {
			artifactFileName,
			executionId: probe?.executionId,
			executionStatus: probe?.execution.status,
			failureReason,
			itemCount: probe?.items.length,
		});
	}
	return {
		artifactFileName,
		executionId: probe?.executionId,
		executionStatus: probe?.execution.status,
		failureReason,
		observations,
		recodedArtifactObserved,
	};
}

async function workspaceNames(service = 'worker') {
	const { stdout } = await compose([
		'exec',
		'-T',
		service,
		'sh',
		'-c',
		"find /tmp/n8n-nodes-yt-dlp -mindepth 1 -maxdepth 1 -type d -name 'n8n-nodes-yt-dlp-execution-*' 2>/dev/null | sort",
	]);
	return stdout.trim().split('\n').filter(Boolean);
}

async function workerContainerState() {
	const id = await containerId('worker');
	const { stdout } = await run('docker', [
		'inspect',
		'--format',
		'{{json .State}}',
		id,
	]);
	return { id, state: JSON.parse(stdout) };
}

async function runUncatchableRecovery(client, label, recreate) {
	const fixtureBefore = await readFixtureEvidence();
	const workflow = await client.createWorkflow(
		workflowDefinition({
			name: `E2E ${label} uncatchable recovery`,
			roundTrip: false,
			sourceUrl: 'http://fixture:8080/slow.mp4',
		}),
	);
	const executionId = await client.runManual(workflow, 'YT-DLP');
	await poll(`${label} slow request`, async () =>
		(await readFixtureEvidence()).slowRequests > fixtureBefore.slowRequests ? true : undefined,
	);
	const staleWorkspaces = await poll(`${label} workspace creation`, async () => {
		const names = await workspaceNames();
		return names.length > 0 ? names : undefined;
	});
	const beforeKill = await workerContainerState();
	const unaffectedIds = Object.fromEntries(
		await Promise.all(
			['main', 'postgres', 'redis'].map(async (service) => [service, await containerId(service)]),
		),
	);
	await run('docker', ['kill', '--signal', 'KILL', beforeKill.id]);
	const killed = await workerContainerState();
	assert(killed.state.ExitCode === 137, `${label} worker did not exit from SIGKILL.`);

	if (recreate) {
		await compose(['rm', '--force', 'worker']);
		await compose(['up', '-d', '--wait', 'worker'], { timeout: 300_000 });
	} else {
		await compose(['start', 'worker']);
		await workerReadiness('worker');
	}
	const interrupted = await client.execution(executionId);
	if (['new', 'running', 'waiting'].includes(interrupted.status)) {
		await client.request(`/executions/${executionId}/stop`, { method: 'POST' });
		await client.waitForExecution(executionId);
	}
	if (!recreate) {
		for (const workspace of staleWorkspaces) {
			await compose([
				'exec',
				'-T',
				'worker',
				'node',
				'-e',
				"const { utimesSync } = require('node:fs'); const old = new Date(Date.now() - 4 * 60 * 60 * 1000); utimesSync(process.argv[1], old, old);",
				`${workspace}/.owner.json`,
			]);
		}
	}

	const afterRecovery = await workerContainerState();
	assert(
		recreate ? afterRecovery.id !== beforeKill.id : afterRecovery.id === beforeKill.id,
		`${label} recovery used the wrong container boundary.`,
	);
	for (const [service, id] of Object.entries(unaffectedIds)) {
		assert((await containerId(service)) === id, `${label} recovery recreated unaffected ${service}.`);
	}
	assertExactPackageState(await packageState('worker'));
	const probe = await createAndRunManual(client, {
		name: `E2E ${label} recovery probe`,
		roundTrip: false,
		sourceUrl: 'http://fixture:8080/direct.mp4',
	});
	assert(probe.execution.status === 'success', `${label} recovery probe failed.`);
	assert((await workspaceNames()).length === 0, `${label} recovery retained a workspace.`);
	return {
		executionId,
		killedExitCode: killed.state.ExitCode,
		oomKilled: killed.state.OOMKilled,
		recoveryExecutionId: probe.executionId,
		staleWorkspaceCount: staleWorkspaces.length,
		targetedContainerRecreation: recreate,
		workerContainerChanged: afterRecovery.id !== beforeKill.id,
	};
}

function summarizeCapacity(
	samples,
	metricsSampling,
	processObservations,
	ffmpegProbe,
	executions,
	binaryBefore,
	binaryAfter,
) {
	assert(samples.length > 0, 'The capacity lane retained no resource sample.');
	const eventLoopValues = samples.flatMap(({ metrics }) =>
		Object.entries(metrics ?? {})
			.filter(([name]) => /eventloop.*(?:max|p99|lag_seconds$)/iu.test(name))
			.map(([, value]) => value),
	);
	assert(
		eventLoopValues.length > 0,
		'The capacity lane retained no event-loop lag measurement to judge.',
	);
	const workerMemoryPeakBytes = Math.max(
		...samples.map(({ containers }) => containers.worker.memoryBytes),
	);
	const workerProcessRssPeakBytes = Math.max(
		...processObservations.map(({ workerRssBytes }) => workerRssBytes),
	);
	const minimumHostAvailableMemoryBytes = Math.min(
		...samples.map(({ host }) => host.availableMemoryBytes),
	);
	const minimumWorkerTempFreeBytes = Math.min(
		...samples.map(({ temporaryDisk }) => temporaryDisk.freeBytes),
	);
	// The restriction is judged over every process the lane observed, in both the load window and
	// the probe window: an unrestricted process fails the verdict wherever it was sampled, and the
	// FFmpeg the verdict rests on is the one the probe holds still long enough to read. Only
	// `ffmpegThreadRestrictionProven` is that combined verdict; every other process measurement
	// stays scoped to the window it describes, so the load window's numbers keep comparing to the
	// records written before the probe existed.
	const loadThreadRestriction = evaluateThreadRestriction(processObservations);
	const probeThreadRestriction = evaluateThreadRestriction(ffmpegProbe.observations);
	const threadRestriction = evaluateThreadRestriction([
		...processObservations,
		...ffmpegProbe.observations,
	]);
	const requestTimeLimit = summarizeRequestTimeLimit(executions, requestTimeLimitMs);
	const queueLatencyMs = queueLatencies(executions);
	assert(
		queueLatencyMs.length > 0,
		'The capacity lane retained no queue-latency measurement to judge.',
	);
	const eventLoopLagPeakSeconds = Math.max(...eventLoopValues);
	const firstHost = samples[0].host;
	const lastHost = samples.at(-1).host;
	const cpuTotalDelta = lastHost.cpuTotalTicks - firstHost.cpuTotalTicks;
	const hostCpuPercent =
		cpuTotalDelta === 0
			? 0
			: ((cpuTotalDelta - (lastHost.cpuIdleTicks - firstHost.cpuIdleTicks)) /
					cpuTotalDelta) *
				100;
	const thresholds = {
		eventLoopLagSeconds: 1,
		hostAvailableMemoryBytes: 2 * 1024 ** 3,
		queueLatencyP95Ms: 30_000,
		workerContainerMemoryBytes: Math.ceil((workerMemoryPeakBytes * 1.25) / 1024 ** 2) * 1024 ** 2,
		workerTempFreeBytes: 6 * 1024 ** 3,
	};
	const acceptance = {
		allRequestsSucceeded: executions.every(({ status }) => status === 'success'),
		binaryGrowthObserved: binaryAfter.bytes - binaryBefore.bytes >= 256 * 1024 ** 2,
		eventLoopHealthy: eventLoopLagPeakSeconds <= thresholds.eventLoopLagSeconds,
		// The probe's own request used to be asserted, so a probe that never re-encoded its Artifact
		// failed the run and discarded the load's evidence with it. It is now judged like every other
		// measurement: an unproven probe drops the capacity decision and keeps the run's evidence.
		ffmpegProbeCompleted: ffmpegProbe.recodedArtifactObserved,
		ffmpegThreadsRestricted: threadRestriction.proven,
		hostMemoryHeadroom:
			minimumHostAvailableMemoryBytes >= thresholds.hostAvailableMemoryBytes,
		queueLatencyBounded: percentile(queueLatencyMs, 95) <= thresholds.queueLatencyP95Ms,
		tempDiskHeadroom: minimumWorkerTempFreeBytes >= thresholds.workerTempFreeBytes,
	};
	const safe = Object.values(acceptance).every(Boolean);
	return {
		acceptance,
		alertThresholds: thresholds,
		capacityDecision: {
			concurrentRequests: safe ? 10 : 1,
			nodeHardCapsChanged: false,
			safeAtConcurrency10: safe,
			supportedScope: safe
				? 'one frozen-head worker at concurrency 10 on the measured topology'
				: 'worker concurrency 1 until a lower-concurrency disposable load lane passes',
		},
		measurements: {
			binaryGrowthBytes: binaryAfter.bytes - binaryBefore.bytes,
			binaryRowGrowth: binaryAfter.rows - binaryBefore.rows,
			containerPeaks: Object.fromEntries(
				Object.keys(samples[0].containers).map((service) => [
					service,
					{
						cpuPercent: Math.max(
							...samples.map(({ containers }) => containers[service].cpuPercent),
						),
						memoryBytes: Math.max(
							...samples.map(({ containers }) => containers[service].memoryBytes),
						),
					},
				]),
			),
			databasePeakBytes: Math.max(...samples.map(({ storage }) => storage.databaseBytes)),
			eventLoopLagPeakSeconds,
			failureCodes: failureCodeCounts(executions),
			ffmpegArgvUnwrittenTotal: loadThreadRestriction.ffmpegArgvUnwrittenTotal,
			ffmpegProcessPeak: loadThreadRestriction.ffmpegProcessPeak,
			ffmpegThreadRestrictionObserved:
				loadThreadRestriction.ffmpegThreadRestrictionObserved,
			ffmpegThreadRestrictionProbe: {
				artifactFileName: ffmpegProbe.artifactFileName,
				executionId: ffmpegProbe.executionId,
				executionStatus: ffmpegProbe.executionStatus,
				failureReason: ffmpegProbe.failureReason,
				ffmpegArgvUnwrittenTotal: probeThreadRestriction.ffmpegArgvUnwrittenTotal,
				ffmpegProcessPeak: probeThreadRestriction.ffmpegProcessPeak,
				ffmpegThreadRestrictionObserved:
					probeThreadRestriction.ffmpegThreadRestrictionObserved,
				ffmpegUnrestrictedCommandLines:
					probeThreadRestriction.ffmpegUnrestrictedCommandLines,
				ffmpegWithoutMediaInputTotal: probeThreadRestriction.ffmpegWithoutMediaInputTotal,
				ffmpegWithoutThreadRestrictionObserved:
					probeThreadRestriction.ffmpegWithoutThreadRestrictionObserved,
				processObservationCount: probeThreadRestriction.observationCount,
				recodedArtifactObserved: ffmpegProbe.recodedArtifactObserved,
				unattributedArgvUnwrittenTotal:
					probeThreadRestriction.unattributedArgvUnwrittenTotal,
				// The probe window is only the worker's own if every request the load window measured
				// has ended. A request the lane could not stop is still running through it, so the
				// count is reported here rather than leaving the window's numbers looking clean.
				unstoppedRequestCount: executions.filter(
					({ stoppedStatus, timedOut }) => timedOut === true && stoppedStatus === 'unstopped',
				).length,
			},
			ffmpegThreadRestrictionProven: acceptance.ffmpegThreadsRestricted,
			ffmpegUnrestrictedCommandLines: loadThreadRestriction.ffmpegUnrestrictedCommandLines,
			ffmpegWithoutMediaInputTotal: loadThreadRestriction.ffmpegWithoutMediaInputTotal,
			ffmpegWithoutThreadRestrictionObserved:
				loadThreadRestriction.ffmpegWithoutThreadRestrictionObserved,
			hostCpuPercent,
			hostHarnessRssPeakBytes: Math.max(...samples.map(({ host }) => host.harnessRssBytes)),
			hostTotalMemoryBytes: firstHost.totalMemoryBytes,
			metricsSampling,
			minimumHostAvailableMemoryBytes,
			minimumWorkerTempFreeBytes,
			processObservationCount: processObservations.length,
			queueLatencyMaximumMs: Math.max(...queueLatencyMs),
			queueLatencyP95Ms: percentile(queueLatencyMs, 95),
			redisUsedMemoryPeakBytes: Math.max(
				...samples.map(({ storage }) => storage.redisUsedMemoryBytes),
			),
			requestTimeLimit,
			sampleCount: samples.length,
			unattributedArgvUnwrittenTotal: loadThreadRestriction.unattributedArgvUnwrittenTotal,
			workerProcessRssPeakBytes,
			workerTemporaryDiskPeakBytes: Math.max(
				...samples.map(({ temporaryDisk }) => temporaryDisk.usedBytes),
			),
			ytDlpArgvUnwrittenTotal: loadThreadRestriction.ytDlpArgvUnwrittenTotal,
			ytDlpProcessPeak: loadThreadRestriction.ytDlpProcessPeak,
			ytDlpWithoutFfmpegThreadRestrictionObserved:
				loadThreadRestriction.ytDlpWithoutFfmpegThreadRestrictionObserved,
		},
	};
}

/**
 * Closes the load window on the requests that exceeded the time limit.
 *
 * A request the lane stopped waiting for is still running on the worker, and
 * everything the lane measures after the load window — the FFmpeg probe's
 * process observations, the binary pruning proof, both recovery lanes — reads a
 * worker that is supposed to be idle. Each exceeded request is therefore
 * stopped through the same REST stop endpoint the editor's stop button calls,
 * and the terminal status that stop reached is recorded against the request.
 *
 * A stop that fails is reported and recorded as `unstopped` rather than thrown:
 * the run's remaining measurements are worth more than a fast failure, and a
 * request that neither finished nor stopped is exactly the kind of result the
 * evidence should carry.
 */
async function stopTimedOutRequests(client, requests) {
	return await Promise.all(
		requests.map(async (request) => {
			if (request.timedOut !== true) return request;
			try {
				await client.request(`/executions/${request.executionId}/stop`, { method: 'POST' });
				const stopped = await client.waitForExecution(request.executionId, 120_000);
				return { ...request, stoppedStatus: stopped.status };
			} catch (error) {
				report('capacity:request-stop-failed', {
					executionId: request.executionId,
					reason: error instanceof Error ? error.message : String(error),
				});
				return request;
			}
		}),
	);
}

/**
 * Runs the capacity lane, recording each measurement as it is taken.
 *
 * Every measurement is written into `progress` the moment the lane holds it,
 * and `progress.step` names the step the lane is inside. The lane's own result
 * is built from that same record, so what a completed run reports and what a
 * failed run leaves behind are the same measurements rather than two shapes
 * that can drift apart. The caller owns `progress`: when the lane throws — most
 * likely in one of the two SIGKILL recovery steps that end it — the caller
 * writes the partial evidence from it and rethrows.
 *
 * `durationMs` is measured from the lane's first step rather than from the load
 * window, so a partial record and a passing one report the same span. Records
 * written before this change measured only from the load window onward and are
 * shorter by the lane's setup — the worker scale-down, the container lookups,
 * the binary baseline, and the ten workflow creations.
 */
async function runCapacityLane(client, progress) {
	Object.assign(progress, {
		startedAt: Date.now(),
		step: 'worker scale down',
		topology: {
			binaryStorage: 'database',
			ffmpegThreads: 1,
			hostCpuCount: cpus().length,
			requests: 10,
			workerConcurrency: 10,
			workersUnderLoad: 1,
		},
		workload: {
			artifactCountPerRequest: 2,
			individualArtifactHardLimitBytes: 256 * 1024 ** 2,
			totalArtifactHardLimitBytes: 512 * 1024 ** 2,
		},
	});
	await compose(['stop', 'worker-secondary', 'worker-late']);
	progress.step = 'container identification';
	const serviceIds = Object.fromEntries(
		await Promise.all(
			['main', 'worker', 'postgres', 'redis'].map(async (service) => [
				service,
				await containerId(service),
			]),
		),
	);
	progress.step = 'binary storage baseline';
	const binaryBefore = await binaryStorageSnapshot();
	progress.step = 'workflow creation';
	const workflows = await Promise.all(
		Array.from({ length: 10 }, async (_, index) =>
			await client.createWorkflow(
				workflowDefinition({
					argumentsValue:
						'--yes-playlist --playlist-items 1-2 -f bestvideo+bestaudio/best --merge-output-format mp4',
					name: `E2E capacity ${index}`,
					roundTrip: false,
					sourceUrl: 'http://fixture:8080/capacity-playlist',
					ytParameters: {
						maximumArtifactCount: 50,
						maximumArtifactSizeMiB: 256,
						maximumTotalArtifactSizeMiB: 512,
						requestTimeoutMinutes: 60,
					},
				}),
			),
		),
	);
	progress.step = 'load window';
	const {
		metricsSampling,
		processObservations,
		result: loadRequests,
		samples,
	} = await collectCapacitySamples(
		serviceIds,
		async () => {
			const submitted = await Promise.all(
				workflows.map(async (workflow) => {
					const submittedAt = Date.now();
					return {
						executionId: await client.runManual(workflow, 'YT-DLP'),
						submittedAt,
					};
				}),
			);
			return await Promise.all(
				submitted.map(async ({ executionId, submittedAt }) => {
					const settled = await settleRequestWait(
						executionId,
						requestTimeLimitMs,
						async () => await client.waitForExecution(executionId, requestTimeLimitMs),
						async () => await client.execution(executionId),
					);
					if (settled.execution === undefined) {
						report('capacity:request-time-limit-exceeded', {
							executionId,
							waitedMs: settled.waitedMs,
						});
						return timedOutRequestRecord(executionId, settled.waitedMs);
					}
					const execution = settled.execution;
					const executionStartedAt = Date.parse(execution.startedAt);
					assert(
						Number.isFinite(executionStartedAt),
						`Execution ${executionId} exposed no start timestamp.`,
					);
					assert(
						executionStartedAt >= submittedAt,
						`Execution ${executionId} started before its submission timestamp.`,
					);
						const items =
							execution.status === 'success' ? nodeItems(execution, 'YT-DLP') : [];
						const data = executionData(execution);
						const executionError = data?.resultData?.error;
						return {
							artifactCount: items.filter((item) => item.binary?.data !== undefined).length,
							errorCode:
								executionError?.context?.errorCode ??
								executionError?.cause?.context?.errorCode ??
								executionError?.name,
						errorName: executionError?.name,
						executionId,
						queueLatencyMs: executionStartedAt - submittedAt,
						status: execution.status,
					};
				}),
			);
		},
	);
	progress.completedRequests = loadRequests;
	progress.rawProcessObservations = processObservations;
	progress.rawSamples = samples;
	progress.step = 'request stop';
	const executions = await stopTimedOutRequests(client, loadRequests);
	progress.completedRequests = executions;
	progress.step = 'binary storage growth';
	const binaryAfter = await binaryStorageSnapshot();
	progress.step = 'ffmpeg thread restriction probe';
	const ffmpegProbe = await runFfmpegThreadRestrictionProbe(client, serviceIds);
	progress.rawFfmpegProbeObservations = ffmpegProbe.observations;
	progress.step = 'capacity summary';
	const summary = summarizeCapacity(
		samples,
		metricsSampling,
		processObservations,
		ffmpegProbe,
		executions,
		binaryBefore,
		binaryAfter,
	);
	Object.assign(progress, summary);
	// The pruning proof is taken over the requests that finished on their own. A request the lane
	// stopped waiting for was still writing binary rows when its wait ended, so polling its rows to
	// zero would prove nothing about pruning and could hang the proof itself; its rows are deleted
	// after the proof, best effort, and the proof reports how many requests it covered.
	progress.step = 'binary pruning proof';
	const prunedRequests = executions.filter(({ timedOut }) => timedOut !== true);
	await client.request('/executions/delete', {
		body: { ids: prunedRequests.map(({ executionId }) => executionId) },
		method: 'POST',
	});
	await poll('capacity binary pruning', async () => {
		const remaining = await Promise.all(
			prunedRequests.map(async ({ executionId }) => await binaryRowCount(executionId)),
		);
		return remaining.every((count) => count === 0) ? true : undefined;
	});
	const timedOutIds = executions
		.filter(({ timedOut }) => timedOut === true)
		.map(({ executionId }) => executionId);
	if (timedOutIds.length > 0) {
		try {
			await client.request('/executions/delete', { body: { ids: timedOutIds }, method: 'POST' });
		} catch (error) {
			report('capacity:request-delete-failed', {
				executionIds: timedOutIds,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	// What that best-effort delete actually left behind is counted rather than assumed: the proof's
	// `unreferencedRowsAfterPruning: 0` describes the requests it covered, so the rows of a request
	// the lane never proved are reported separately instead of being folded into that zero.
	const timedOutRowsRemaining = (
		await Promise.all(timedOutIds.map(async (executionId) => await binaryRowCount(executionId)))
	).reduce((total, count) => total + count, 0);
	// The probe's own execution is deleted separately, after the load's pruning evidence is taken:
	// its Artifact is not part of the load whose binary growth and pruning the lane measures, and
	// folding it into that delete call would put a row the measurement never counted into the
	// pruning proof. A probe that never reached an execution has nothing to delete.
	if (ffmpegProbe.executionId !== undefined) {
		await client.request('/executions/delete', {
			body: { ids: [ffmpegProbe.executionId] },
			method: 'POST',
		});
	}
	progress.binaryPruning = {
		hardDeleteApi: 'public REST /executions/delete',
		internalDeletionApiUsed: false,
		provenRequestCount: prunedRequests.length,
		timedOutRequestRowsRemaining: timedOutRowsRemaining,
		unreferencedRowsAfterPruning: 0,
	};
	progress.step = 'stale sweep recovery';
	const staleSweep = await runUncatchableRecovery(client, 'stale sweep', false);
	progress.failureRecovery = { staleSweep };
	progress.step = 'targeted recreation recovery';
	const targetedRecreation = await runUncatchableRecovery(
		client,
		'targeted recreation',
		true,
	);
	progress.failureRecovery = { staleSweep, targetedRecreation };
	const { startedAt, step, ...collected } = progress;
	return {
		...collected,
		durationMs: Date.now() - startedAt,
		outcome: 'pass',
		schemaVersion: 1,
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
		outcome: undefined,
		packages: prepared.packages,
		partial: undefined,
		registryRequests: undefined,
		scenarios: {},
		schemaVersion: 1,
	};
	const evidencePath = join(generatedRoot, `evidence/n8n-${n8nTag}.json`);
	const writeEvidence = async () =>
		await writeFile(evidencePath, JSON.stringify(evidence, null, 2));

	await run('npm', [
		'test',
		'--',
		'test/process.test.ts',
		'-t',
		'terminates output floods above the combined eight MiB limit|terminates a Process Group when workspace apparent size overshoots|times out after a TERM-cooperative leader creates an ignored-SIGTERM descendant',
	]);
	evidence.scenarios.processBoundary = {
		evidenceSource: 'controlled process seam',
		outcome: 'pass',
		processDescendants: 'terminated',
		processOutputFlood: 'terminated',
		requestTimeout: 'terminated',
		workspaceDiskOvershoot: 'terminated',
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

		const errorOutputWorkflow = await client.createWorkflow(
			workflowDefinition({
				name: 'E2E continue using error output',
				onError: 'continueErrorOutput',
				roundTrip: false,
				sourceUrl: 'ftp://fixture/direct.mp4',
			}),
		);
		const errorOutputExecutionId = await client.runManual(errorOutputWorkflow, 'Error Handler');
		const errorOutputExecution = await client.waitForExecution(errorOutputExecutionId);
		const errorOutputRunData = executionData(errorOutputExecution)?.resultData?.runData ?? {};
		const errorOutputBranches = errorOutputRunData['YT-DLP']?.at(-1)?.data?.main ?? [];
		const errorOutputState = JSON.stringify({
			branchLengths: errorOutputBranches.map((branch) => branch?.length ?? null),
			ranNodes: Object.keys(errorOutputRunData),
			savedOnError: errorOutputWorkflow.nodes.find(({ name }) => name === 'YT-DLP')?.onError,
			status: errorOutputExecution.status,
		});
		const regularOutputItems = errorOutputBranches[0] ?? [];
		assert(
			regularOutputItems.length === 1 &&
				regularOutputItems[0].json.status === 'error' &&
				regularOutputItems[0].json.errorCode === 'INVALID_SOURCE_URL' &&
				regularOutputItems[0].binary === undefined,
			`continueErrorOutput did not keep the stable binary-free Failure Item on the regular output: ${errorOutputState}.`,
		);
		// n8n's engine owns the error output: handleNodeErrorOutput overwrites it with the items
		// it recognises as errors on the earlier outputs, and a Failure Item is not one of those
		// shapes. The branch therefore stays empty and the node warns instead.
		assert(
			(errorOutputBranches[1]?.length ?? 0) === 0 &&
				errorOutputRunData['Error Handler'] === undefined,
			`The engine-owned error output was not empty: ${errorOutputState}.`,
		);
		const errorOutputHints = errorOutputRunData['YT-DLP']?.at(-1)?.hints ?? [];
		assert(
			errorOutputHints.some(({ message }) => message?.includes('error output stays empty')),
			`continueErrorOutput produced no dead-branch warning hint: ${JSON.stringify(errorOutputHints)}.`,
		);
		evidence.scenarios.continueErrorOutput = {
			errorOutputItems: errorOutputBranches[1]?.length ?? 0,
			executionId: errorOutputExecutionId,
			hint: 'warned',
			outcome: 'pass',
			result: regularOutputItems[0].json,
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
			`Resource limit did not return a binary-free RESOURCE_LIMIT Failure Item: ${JSON.stringify(
				{
					items: successfulJson(resourceLimit.items),
					status: resourceLimit.execution.status,
				},
			)}.`,
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

			if (capacity) {
				report('capacity:start');
				// The lane's measurements are written to disk whether or not the lane passes. A
				// 25-minute disposable run is not repeatable — each run measures a different spread —
				// so a throw in one of its last steps must not take the sample series, the process
				// observations, the probe, and the pruning proof down with it. The record is written
				// marked partial and the failure is rethrown, so the run's exit code and the release
				// gate's behaviour are exactly what they were before it was written.
				await captureCapacityEvidence({
					evidence,
					lane: async (progress) => await runCapacityLane(client, progress),
					onPartial: async ({ partial }) => {
						await writeEvidence();
						report('capacity:partial-evidence', {
							evidencePath,
							failedStep: partial.failedStep,
							reason: partial.reason,
						});
					},
				});
				report('capacity:complete');
			}

			// The steps that close the run — the fixture service's own evidence, the registry's
			// recorded requests — read services that have been running for the whole lane, and a
			// failure in either used to discard the capacity measurements just as surely as a
			// failure inside the lane did. They are a result of the run rather than of the lane, so
			// the lane's record keeps the outcome it earned and the run is marked partial at the top
			// of the file before the failure is rethrown.
			let closingStep = 'fixture service evidence';
			try {
				if (capacity) evidence.fixtureService = await readFixtureEvidence();
				closingStep = 'registry request evidence';
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
			} catch (error) {
				if (evidence.scenarios.capacity !== undefined) {
					markPartialRun(evidence, closingStep, error);
					await writeEvidence();
					report('run:partial-evidence', {
						evidencePath,
						failedStep: evidence.partial.failedStep,
						reason: evidence.partial.reason,
					});
				}
				throw error;
			}
		evidence.completedAt = new Date().toISOString();
		evidence.outcome = 'pass';
		await writeEvidence();
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
