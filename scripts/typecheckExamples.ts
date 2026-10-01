import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { createCompiler } from "@essence-lang/client/plugin-core"

import { scanScript } from "./commentProse"

// Each example is type-checked against its own `tsconfig.json`, which
// reads an imported `.es` file's Types from the `.d.es.ts` its plugin writes
// beside it. Those are not tracked, so they are written here first, the same
// way the plugin writes them.

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..")
const EXAMPLES_DIRECTORY = path.join(REPOSITORY_ROOT, "examples")
const TSC = path.join(REPOSITORY_ROOT, "node_modules", ".bin", "tsc")

const ESSENCE_MODULE = /^\.{1,2}\/.+\.es$/

function typeScriptFilesUnder(directory: string): Array<string> {
	let files: Array<string> = []

	for (let entry of readdirSync(directory, { withFileTypes: true })) {
		let filePath = path.join(directory, entry.name)

		if (entry.name === "node_modules" || entry.name === "dist") {
			continue
		}

		if (entry.isDirectory()) {
			files.push(...typeScriptFilesUnder(filePath))
		} else if (
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".d.es.ts")
		) {
			files.push(filePath)
		}
	}

	return files
}

// Read by the scanner, so a comment or a string that mentions an import is
// not one.
export function essenceImportsOf(text: string): Array<string> {
	return scanScript(text).modules.filter((module) =>
		ESSENCE_MODULE.test(module),
	)
}

async function declareImports(example: string): Promise<void> {
	let compiler = createCompiler({ declarations: true }, example)
	let entries = new Set<string>()

	for (let file of typeScriptFilesUnder(example)) {
		for (let specifier of essenceImportsOf(readFileSync(file, "utf8"))) {
			entries.add(path.resolve(path.dirname(file), specifier))
		}
	}

	for (let entry of entries) {
		await compiler.declare(await compiler.compile(entry), "javascript")
	}
}

if (import.meta.main) {
	let failed = false

	for (let name of readdirSync(EXAMPLES_DIRECTORY).sort()) {
		let example = path.join(EXAMPLES_DIRECTORY, name)

		if (!existsSync(path.join(example, "tsconfig.json"))) {
			continue
		}

		await declareImports(example)

		let tsc = Bun.spawnSync(
			[process.execPath, TSC, "--noEmit", "-p", example],
			{
				stdout: "inherit",
				stderr: "inherit",
			},
		)

		failed ||= tsc.exitCode !== 0
	}

	process.exit(failed ? 1 : 0)
}
