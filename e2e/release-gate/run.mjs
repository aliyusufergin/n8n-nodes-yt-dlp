import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lanePath = resolve(repositoryRoot, 'e2e/n8n-2.27.4/run.mjs');
const releaseGate = {
	anchors: [
		{
			capacity: false,
			image:
				'docker.n8n.io/n8nio/n8n@sha256:bd39d2d238b51af2626b2ac7b6b9938efff069390cce83ba769e52f10eedf795',
			indexDigest: 'sha256:5b143d5ed0df23d295037408a8290872c549033709e375f920b33a94c754ea00',
			role: '2.x floor',
			scaleRecovery: false,
			tag: '2.0.0',
		},
		{
			capacity: false,
			image:
				'docker.n8n.io/n8nio/n8n@sha256:6dd442962208ff080af3e0a8ab5254eb4c6138f2d188d4a7e3cf84eed3b7eae1',
			indexDigest: 'sha256:cf11c96b0d0089bb24459bf97b445fd7008f41543b673cce4d955f7c0ed8752d',
			role: 'acceptance',
			scaleRecovery: false,
			tag: '2.27.4',
		},
		{
			capacity: true,
			image:
				'docker.n8n.io/n8nio/n8n@sha256:4da852b9488cf32bedc65ba1239216b50b0989f8187597e164b2901631954060',
			indexDigest: 'sha256:23a26975c21aa6f7113286668b35e2831ec898d3a7fbfa1ac8ff16f1bdf88c37',
			role: 'frozen stable head',
			scaleRecovery: true,
			tag: '2.30.7',
		},
	],
	frozenAt: '2026-07-17',
};
const releaseLanes = {
	capacity: {
		anchors: ['2.30.7'],
		capacity: true,
		scaleRecovery: true,
	},
	core: {
		anchors: releaseGate.anchors.map(({ tag }) => tag),
		capacity: false,
		scaleRecovery: false,
	},
	multiworker: {
		anchors: ['2.30.7'],
		capacity: false,
		scaleRecovery: true,
	},
};

function runAnchor(anchor, lane) {
	return new Promise((resolveRun) => {
		const child = spawn(process.execPath, [lanePath, repositoryRoot], {
			cwd: repositoryRoot,
			env: {
				...process.env,
				E2E_CAPACITY: String(lane.capacity),
				E2E_N8N_IMAGE: anchor.image,
				E2E_N8N_INDEX_DIGEST: anchor.indexDigest,
				E2E_N8N_ROLE: anchor.role,
				E2E_SCALE_RECOVERY: String(lane.scaleRecovery),
				E2E_N8N_TAG: anchor.tag,
			},
			stdio: 'inherit',
		});
		child.once('error', (error) => {
			process.stderr.write(`n8n ${anchor.tag} could not start: ${error.message}\n`);
			resolveRun(false);
		});
		child.once('exit', (code, signal) => {
			if (code === 0) {
				resolveRun(true);
				return;
			}
			process.stderr.write(
				`n8n ${anchor.tag} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.\n`,
			);
			resolveRun(false);
		});
	});
}

const arguments_ = process.argv.slice(2);
if (arguments_.length === 1 && arguments_[0] === '--list') {
	process.stdout.write(`${JSON.stringify(releaseGate)}\n`);
} else if (arguments_.length === 1 && arguments_[0] === '--list-lanes') {
	process.stdout.write(`${JSON.stringify(releaseLanes)}\n`);
} else if (arguments_.length === 2 && arguments_[0] === '--describe-lane') {
	const lane = releaseLanes[arguments_[1]];
	if (lane === undefined) throw new Error(`Unknown release-gate lane: ${arguments_[1]}`);
	process.stdout.write(
		`${JSON.stringify({
			...lane,
			anchors: releaseGate.anchors.filter(({ tag }) => lane.anchors.includes(tag)),
			lane: arguments_[1],
		})}\n`,
	);
} else {
	let laneName = 'core';
	let anchorTag;
	for (let index = 0; index < arguments_.length; index += 2) {
		const option = arguments_[index];
		const value = arguments_[index + 1];
		if (value === undefined || !['--anchor', '--lane'].includes(option)) {
			throw new Error(
				'Usage: run.mjs [--list | --list-lanes | --describe-lane <lane> | --lane <lane> [--anchor <version>]]',
			);
		}
		if (option === '--anchor') anchorTag = value;
		else laneName = value;
	}
	const lane = releaseLanes[laneName];
	if (lane === undefined) throw new Error(`Unknown release-gate lane: ${laneName}`);
	let anchors = releaseGate.anchors.filter(({ tag }) => lane.anchors.includes(tag));
	if (anchorTag !== undefined) {
		if (!lane.anchors.includes(anchorTag)) {
			throw new Error(`Anchor ${anchorTag} is not part of the ${laneName} lane.`);
		}
		anchors = anchors.filter(({ tag }) => tag === anchorTag);
	}

	const failedAnchors = [];
	for (const anchor of anchors) {
		process.stdout.write(
			`${JSON.stringify({ anchor: anchor.tag, lane: laneName, phase: 'start' })}\n`,
		);
		if (!(await runAnchor(anchor, lane))) failedAnchors.push(anchor.tag);
	}
	if (failedAnchors.length > 0) {
		throw new Error(`Release Gate Matrix failed: ${failedAnchors.join(', ')}`);
	}
}
