import { writeFileSync } from "node:fs"
import * as path from "node:path"

import { snippets } from "@essence-lang/language-server/snippets"

// NOTE: The VS Code `.code-snippets` file is generated from the Language
// Server's own table, so that the bodies an Editor completes and the bodies it
// expands from a prefix can not drift. The Server offers them scoped to the
// block the cursor stands in, which a static file has no way to be; the file is
// kept for the readers who switch the Server off, and it is what VS Code loads
// before the Server has started.
//
// The extension owns the copy it ships, and holds a spec that fails when it is
// out of date; this script is what brings it up to date.
//
// Regenerate with `bun run generate:snippets`.

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..")

export const SNIPPETS_COPY = path.join(
	REPOSITORY_ROOT,
	"packages/vscode-extension/snippets/essence.code-snippets",
)

// NOTE: The prefix is the key as well. A `.code-snippets` file names each entry
// twice — once as the object key an Editor shows in its own snippet list, once
// as the `prefix` that expands it — and one name for both is one name that can
// not disagree with itself. The `contexts` a body carries are deliberately left
// out: the file has nowhere to say them, and the Server is what honours them.
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
