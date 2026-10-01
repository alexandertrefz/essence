import { writeFileSync } from "node:fs"
import * as path from "node:path"

import { projectSchema } from "@essence-lang/compiler/configuration"

// Generates the JSON Schema for `essence.json` from the reader's catalogue, so
// editors validate what the toolchain reads. The VS Code extension bundles one
// copy and the website serves another at the `$schema` URL. Each package's spec
// fails when its copy is stale.
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
