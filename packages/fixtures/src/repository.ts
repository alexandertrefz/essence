import { existsSync } from "node:fs"
import * as path from "node:path"

import { spawnAndWait } from "./spawn"

// Every file under `root` that git does not ignore, tracked or not, relative
// to `root` and sorted. A check that reads them holds a new file to its rules
// before the file is added. A tracked file deleted from the working tree is
// left out, since there is nothing to read.
export async function repositoryFiles(root: string): Promise<Array<string>> {
	let listed = await spawnAndWait(
		["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: root },
	)

	if (listed.code !== 0) {
		throw new Error(`git ls-files failed: ${listed.stderr}`)
	}

	return [...new Set(listed.stdout.split("\0"))]
		.filter((file) => file !== "" && existsSync(path.join(root, file)))
		.sort()
}
