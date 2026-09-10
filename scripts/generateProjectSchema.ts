import { writeFileSync } from "node:fs"
import * as path from "node:path"

import { projectSchema } from "@essence-lang/compiler/configuration"

// NOTE: The JSON Schema for `essence.json` is generated from the reader's own
// catalogue of settings, so that what an editor completes and validates can
// not drift from what the toolchain reads. Two copies are checked in, each
// owned by the package that ships it: the VS Code extension bundles one and
// registers it for the filename, and the website serves the other at the URL
// the file's `$schema` names. Each package holds a spec that fails when its
// copy is out of date; this script is what brings them up to date.
//
// Regenerate with `bun run generate:schema`.

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..")

export const SCHEMA_COPIES: ReadonlyArray<string> = [
	path.join(
		REPOSITORY_ROOT,
		"packages/vscode-extension/schemas/essence.schema.json",
	),
	path.join(
		REPOSITORY_ROOT,
		"packages/website/public/schemas/essence.schema.json",
	),
]

export function renderProjectSchema(): string {
	return `${JSON.stringify(projectSchema(), null, "\t")}\n`
}

if (import.meta.main) {
	let rendered = renderProjectSchema()

	for (let copy of SCHEMA_COPIES) {
		writeFileSync(copy, rendered, "utf8")
		console.log(`Wrote ${path.relative(REPOSITORY_ROOT, copy)}`)
	}
}
