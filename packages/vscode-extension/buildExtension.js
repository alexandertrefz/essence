// Bundles the extension into `dist/extension.js`. `vscode` is left out, since
// VS Code hands it to the extension.
import { cpSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { ownLocation } from "./buildServer.js"

let entry = path.join(import.meta.dirname, "extension.js")
// The language client stops a Language Server that outlives `stop` with this
// script, which it looks for beside its own file. Bundled, that is beside
// `extension.js`.
let terminateScript = path.join(
	path.dirname(
		fileURLToPath(
			import.meta.resolve("vscode-languageclient/package.json"),
		),
	),
	"lib",
	"node",
	"terminateProcess.sh",
)

// Writes `extension.js` and the script it runs into `directory`.
export async function buildExtension(directory) {
	let build = await Bun.build({
		entrypoints: [entry],
		outdir: directory,
		naming: "extension.js",
		target: "node",
		format: "esm",
		external: ["vscode"],
		...ownLocation,
		throw: false,
	})

	if (!build.success) {
		throw new AggregateError(build.logs, "Bundling extension.js failed.")
	}

	cpSync(terminateScript, path.join(directory, "terminateProcess.sh"))
}

if (import.meta.main) {
	await buildExtension(path.join(import.meta.dirname, "dist"))
}
