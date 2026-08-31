import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	readPlaylistSelection,
	type PlaylistSelection,
	type YtDlpExecutionPlan,
} from './arguments';
import { createAuthenticationTransport } from './authentication';
import { ytDlpInvocationHardening, type YtDlpInvocationOptions } from './download';
import { YtDlpProcessTerminationError, superviseYtDlpExecutionPlan } from './process';
import { createResourceEnvelope, readHostResourceConfiguration } from './resource-envelope';
import { MAX_SOURCE_URL_BYTES, createDownloadRequest } from './source-url';
import { removeWorkspace } from './workspace';

/** The file the listing prints one entry address to per line. */
export const PLAYLIST_ENTRIES_FILE = 'entries';
/**
 * The file the listing prints once per playlist. Its presence is the answer to the only question
 * the listing exists to settle: whether the Source URL the author gave is a playlist source at
 * all. yt-dlp writes a `playlist:` scoped template exactly once for a playlist and never for a
 * single video, so a single video is recognised by the absence of this file rather than by the
 * node guessing from the address.
 */
export const PLAYLIST_MARKER_FILE = 'playlist';

/**
 * The listing plan. It reaches the same extractors over the same network a Download Request does,
 * so it carries the same invocation hardening from the same definition. It downloads nothing:
 * `--simulate` keeps it to metadata and `--flat-playlist` keeps it to the list itself.
 */
function createListingPlan(
	selection: PlaylistSelection,
	entriesPath: string,
	markerPath: string,
	options: YtDlpInvocationOptions,
): YtDlpExecutionPlan {
	return {
		argv: [
			...selection.selectionArgv,
			...ytDlpInvocationHardening(options),
			'--simulate',
			'--flat-playlist',
			'--print-to-file',
			'%(url)s',
			entriesPath,
			'--print-to-file',
			'playlist:%(playlist_count)s',
			markerPath,
			'--',
			selection.sourceUrl,
		],
	};
}

/**
 * Reads the entry addresses the listing wrote, one per line. The read is bounded by the Source
 * URL budget rather than by an entry count: a line longer than a Source URL may be cannot be one,
 * so it is dropped the way any other entry that fails validation is, and no single line is ever
 * held beyond that budget. The number of entries is the capability this expansion exists to
 * offer, so it carries no bound of the node's own.
 */
async function readListedAddresses(handle: FileHandle): Promise<string[]> {
	const addresses: string[] = [];
	let pending = Buffer.alloc(0);
	let discardingOverlongLine = false;

	const takeCompletedLines = (): void => {
		while (true) {
			const newlineIndex = pending.indexOf(0x0a);
			if (newlineIndex === -1) return;
			const line = pending.subarray(0, newlineIndex);
			pending = pending.subarray(newlineIndex + 1);
			if (discardingOverlongLine) discardingOverlongLine = false;
			else addresses.push(line.toString('utf8'));
		}
	};

	for await (const chunk of handle.createReadStream({ autoClose: false })) {
		pending = Buffer.concat([pending, Buffer.from(chunk)]);
		takeCompletedLines();
		if (pending.length > MAX_SOURCE_URL_BYTES) {
			discardingOverlongLine = true;
			pending = Buffer.alloc(0);
		}
	}
	if (!discardingOverlongLine && pending.length > 0) addresses.push(pending.toString('utf8'));
	return addresses;
}

/**
 * Turns the addresses a listing produced into Download Requests. Every address goes through the
 * same Source URL validation a user-supplied address does, and an address that does not pass
 * produces no request at all rather than a failure — a listing is remote input, so an entry the
 * node will not accept is one entry the node does not download, not a reason to lose the rest.
 */
export function createEntryPlans(
	selection: PlaylistSelection,
	addresses: readonly string[],
): YtDlpExecutionPlan[] {
	const plans: YtDlpExecutionPlan[] = [];
	for (const address of addresses) {
		let request;
		try {
			request = createDownloadRequest(address, '');
		} catch {
			continue;
		}
		// An entry is one video. The selection that chose it is spent, and `--no-playlist` keeps an
		// entry address that is itself a playlist source from expanding a second time.
		plans.push({
			argv: [...selection.entryArgv, '--no-playlist', '--', request.sourceUrl],
		});
	}
	return plans;
}

/**
 * Opens one of the files the listing writes into the workspace, or reports its absence. A file
 * the listing did not write is an answer — the marker is absent for a source that is not a
 * playlist — while a file that is there but is not a regular file is an invariant failure of the
 * private workspace and belongs to nobody's Download Request.
 */
async function openListingFile(path: string): Promise<FileHandle | undefined> {
	let handle: FileHandle | undefined;
	let failure: unknown;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		if ((await handle.stat()).isFile()) return handle;
		failure = new Error('The playlist listing is not a regular file.');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		failure = error;
	}
	await handle?.close();
	throw new Error('The playlist listing could not be read.', { cause: failure });
}

/**
 * Opens a Source URL into the Download Requests it stands for. A playlist source becomes one
 * independent request per entry; anything else stays the single request the author wrote. The
 * entry list is read exactly once, here, so no later stage pays a metadata request per entry.
 */
export async function expandPlaylistRequest(
	plan: YtDlpExecutionPlan,
	options: YtDlpInvocationOptions,
): Promise<YtDlpExecutionPlan[]> {
	const selection = readPlaylistSelection(plan);
	if (selection.pinnedToSingleVideo) return [plan];

	const workspaceParent = options.workspaceParent ?? tmpdir();
	const resourceEnvelope =
		options.resourceEnvelope ??
		createResourceEnvelope(await readHostResourceConfiguration(workspaceParent));
	const workspace = await mkdtemp(join(workspaceParent, 'n8n-nodes-yt-dlp-listing-'));
	const controlDirectory = join(workspace, 'control');
	const entriesPath = join(workspace, PLAYLIST_ENTRIES_FILE);
	const markerPath = join(workspace, PLAYLIST_MARKER_FILE);
	let cleanupAllowed = true;

	try {
		await mkdir(controlDirectory, { mode: 0o700 });
		const listingPlan = createListingPlan(selection, entriesPath, markerPath, options);
		const authenticationTransport = await createAuthenticationTransport(
			controlDirectory,
			options.authentication ?? {},
		);
		try {
			await superviseYtDlpExecutionPlan(options.executablePath, listingPlan, {
				cwd: workspace,
				redactValues: authenticationTransport.redactValues,
				signal: options.signal,
				stdinData: authenticationTransport.secretConfig,
				noProgressLimitMs: resourceEnvelope.noProgressLimitMs,
				workspaceLimitBytes: resourceEnvelope.maximumWorkspaceSizeBytes,
			}).catch((error: unknown) => {
				if (error instanceof YtDlpProcessTerminationError && !error.processClosed) {
					cleanupAllowed = false;
				}
				return Promise.reject(error);
			});
		} finally {
			if (cleanupAllowed) await authenticationTransport.removeCookieFile();
		}

		const marker = await openListingFile(markerPath);
		if (marker === undefined) return [plan];
		await marker.close();

		const entries = await openListingFile(entriesPath);
		if (entries === undefined) return [];
		try {
			return createEntryPlans(selection, await readListedAddresses(entries));
		} finally {
			await entries.close();
		}
	} finally {
		if (cleanupAllowed) await removeWorkspace(workspace);
	}
}
