import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { readdir, rm } from "node:fs/promises"
import * as path from "node:path"

// NOTE: Where a test run stages the bundles it imports: a directory named for
// the process that made it, under a prefix of the tool's own, so that a later
// run can tell the directory of one that has stopped from one still in use.
export function stagingDirectoryIn(root: string, prefix: string): string {
	return path.join(root, `${prefix}${process.pid}-${randomUUID()}`)
}

// NOTE: Never throws. It runs in a Worker's `exit` listener and in a signal
// handler, where a throw would take the process down with it.
export function removeStagingDirectory(directory: string): void {
	try {
		rmSync(directory, { recursive: true, force: true })
	} catch {}
}

// NOTE: The directories a process that was killed or crashed left behind. A
// directory without a process in its name, or whose process is running, stays.
export async function sweepStagingDirectories(
	root: string,
	prefix: string,
): Promise<void> {
	let owned = new RegExp(`^${prefix}(\\d+)-`)
	let names: Array<string>

	try {
		names = await readdir(root)
	} catch {
		return
	}

	for (let name of names) {
		let owner = owned.exec(name)?.[1]

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
