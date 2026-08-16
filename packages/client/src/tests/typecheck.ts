import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

export const REPOSITORY = path.join(import.meta.dirname, "..", "..", "..", "..")

// NOTE: The real class rather than a copy of its shape. A consumer of a
// generated file imports `EssenceRational` from this package, and a stub
// declaring what it is thought to be would typecheck a Module against a Rational
// that does not exist. A path, because a temporary directory has no
// `node_modules` above it to find the package name in.
export const RATIONAL_MODULE = path.join(import.meta.dirname, "..", "rational")

// NOTE: `tsc` over a directory of its own, extending the repository's own
// TypeScript settings — the point of the exercise is that a generated file
// compiles where its reader's code compiles, and a laxer configuration invented
// for the test would answer a question nobody asked. `typeRoots` is absolute
// because a temporary directory has no `node_modules` above it.
//
// NOTE: Shared by the two specs that ask the question — the declarations as
// `generateDeclarations` writes them, and the declarations as a PLUGIN writes
// them beside a source. Both are the same claim: a reader's code compiles
// against what was generated for it.
export function typecheck(files: Record<string, string>): {
	code: number
	output: string
} {
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
					// NOTE: What makes `./Math.es` resolve to `Math.d.es.ts`.
					allowArbitraryExtensions: true,
					types: ["bun"],
					typeRoots: [
						path.join(REPOSITORY, "node_modules", "@types"),
					],
				},
				include: ["*.ts"],
			}),
		)

		// NOTE: The repository's own `tsc`, by path. `bun x tsc` from a directory
		// with no `node_modules` above it goes to the network for one, which
		// makes the test both slow and a liar about which compiler it ran.
		let run = Bun.spawnSync(
			[
				path.join(REPOSITORY, "node_modules", ".bin", "tsc"),
				"--project",
				directory,
			],
			{ cwd: directory },
		)

		return {
			code: run.exitCode,
			output: `${new TextDecoder().decode(
				run.stdout,
			)}${new TextDecoder().decode(run.stderr)}`,
		}
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}
