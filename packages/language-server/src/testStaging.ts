import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { readdir, rm } from "node:fs/promises"
import * as path from "node:path"

// NOTE: Where the test Workers stage the bundles they import: one directory per
// Worker, named for the Server's process so that a later Server can tell the
// directory of one that has stopped from one still in use.

const STAGING_PREFIX = "essence-lsp-tests-"
const STAGING_NAME = new RegExp(`^${STAGING_PREFIX}(\\d+)-`)

export function stagingDirectoryIn(root: string): string {
	return path.join(root, `${STAGING_PREFIX}${process.pid}-${randomUUID()}`)
}

// NOTE: Never throws. It runs in a Worker's `exit` listener, where a throw
// would take the Server down with it.
export function removeStagingDirectory(directory: string): void {
	try {
		rmSync(directory, { recursive: true, force: true })
	} catch {}
}

// NOTE: The directories a Server that was killed or crashed left behind. A
// directory without a process in its name, or whose process is running, stays.
export async function sweepStagingDirectories(root: string): Promise<void> {
	let names: Array<string>

	try {
		names = await readdir(root)
	} catch {
		return
	}

	for (let name of names) {
		let owner = STAGING_NAME.exec(name)?.[1]

		if (owner === undefined || isRunning(Number(owner))) {
			continue
		}

		try {
			await rm(path.join(root, name), { recursive: true, force: true })
		} catch {}
	}
}

// NOTE: Signal 0 checks that the process exists without touching it. A process
// this user may not signal is somebody's, so it counts as running.
function isRunning(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		return true
	}

	try {
		process.kill(pid, 0)

		return true
	} catch (error) {
		return (error as { code?: string }).code === "EPERM"
	}
}
