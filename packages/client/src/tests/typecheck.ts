import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"

export const REPOSITORY = path.join(import.meta.dirname, "..", "..", "..", "..")

// The real borrowed names rather than a stub, so a generated file is checked
// against the class it imports. A path, since a temporary directory has no
// `node_modules` above it.
export const BORROWED_MODULE = path.join(import.meta.dirname, "..", "borrowed")

// `tsc` over a directory of its own, with the repository's settings, so a
// generated file is checked where its reader's code compiles. The specs of
// `generateDeclarations` and of the plugins share it.
export async function typecheck(files: Record<string, string>): Promise<{
	code: number | null
	output: string
}> {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-dts-"))

	try {
		for (let [name, contents] of Object.entries(files)) {
			writeFileSync(path.join(directory, name), contents)
		}

		writeFileSync(
			path.join(directory, "tsconfig.json"),
			JSON.stringify({
				extends: path.join(REPOSITORY, "tsconfig.base.json"),
				compilerOptions: {
					// What makes `./Math.es` resolve to `Math.d.es.ts`.
					allowArbitraryExtensions: true,
					types: ["bun"],
					typeRoots: [
						path.join(REPOSITORY, "node_modules", "@types"),
					],
				},
				include: ["*.ts"],
			}),
		)

		// The repository's own `tsc`, by path. `bun x tsc` here would fetch
		// one from the network.
		let run = await spawnAndWait(
			[
				path.join(REPOSITORY, "node_modules", ".bin", "tsc"),
				"--project",
				directory,
			],
			{ cwd: directory },
		)

		return { code: run.code, output: `${run.stdout}${run.stderr}` }
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}
