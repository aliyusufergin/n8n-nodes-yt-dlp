import {
	spawn,
	type ChildProcessWithoutNullStreams,
	type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { isAbsolute } from 'node:path';

import type { YtDlpExecutionPlan } from './arguments';

export interface YtDlpSpawnContext {
	cwd: string;
	env: NodeJS.ProcessEnv;
}

type YtDlpSpawnOptions = SpawnOptionsWithoutStdio & {
	stdio: ['pipe', 'pipe', 'pipe'];
};

export type SpawnProcess = (
	command: string,
	args: readonly string[],
	options: YtDlpSpawnOptions,
) => ChildProcessWithoutNullStreams;

const spawnProcess: SpawnProcess = (command, args, options) => spawn(command, [...args], options);

export function spawnYtDlpExecutionPlan(
	executablePath: string,
	plan: YtDlpExecutionPlan,
	context: YtDlpSpawnContext,
	startProcess: SpawnProcess = spawnProcess,
): ChildProcessWithoutNullStreams {
	if (!isAbsolute(executablePath)) {
		throw new Error('The yt-dlp executable path must be absolute.');
	}

	return startProcess(executablePath, plan.argv, {
		cwd: context.cwd,
		env: context.env,
		shell: false,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
}
