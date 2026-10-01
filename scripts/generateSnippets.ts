import { writeFileSync } from "node:fs"
import * as path from "node:path"

import { snippets } from "@essence-lang/language-server/snippets"

// Generates the VS Code `.code-snippets` file from the Language Server's table,
// so completed and prefix-expanded bodies agree. The file serves readers with
// the Server off, and VS Code before the Server starts. The extension's spec
// fails when its copy is stale.
//
// Regenerate with `bun run generate:snippets`.

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..")

export const SNIPPETS_COPY = path.join(
	REPOSITORY_ROOT,
	"packages/vscode-extension/snippets/essence.code-snippets",
)

// The prefix doubles as the entry's key, so the two names never disagree. The
// `contexts` are left out: the file cannot express them, and the Server honours
// them.
export function renderSnippets(): string {
	let rendered: Record<
		string,
		{ prefix: string; body: Array<string>; description: string }
	> = {}

	for (let snippet of snippets) {
		rendered[snippet.prefix] = {
			prefix: snippet.prefix,
			body: snippet.body,
			description: snippet.description,
		}
	}

	return `${JSON.stringify(rendered, null, "\t")}\n`
}

if (import.meta.main) {
	writeFileSync(SNIPPETS_COPY, renderSnippets(), "utf8")
	console.log(`Wrote ${path.relative(REPOSITORY_ROOT, SNIPPETS_COPY)}`)
}
