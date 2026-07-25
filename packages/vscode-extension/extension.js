import fs from "node:fs"
import path from "node:path"

import * as vscode from "vscode"
// NOTE: The explicit `.js` is required — under native ESM resolution an
// extensionless specifier is not resolved, and vscode-languageclient ships no
// `exports` map that would map one.
import { LanguageClient } from "vscode-languageclient/node.js"

let client

// NOTE: The Language Server is bundled into `server/server.js` by `bun run
// build`, which compiles it out of the compiler repository. That bundle runs
// on the Node that ships with VS Code, so neither Bun nor a compiler checkout
// is needed to use the extension.
//
// `essence.server.path` overrides it, which is how the compiler is developed
// against: point it at `bin/esls` and every edit takes effect on the next
// restart, with no bundling step.
function resolveServerOptions(context) {
	let configuredPath = vscode.workspace
		.getConfiguration("essence")
		.get("server.path")

	if (typeof configuredPath === "string" && configuredPath.trim() !== "") {
		let serverPath = configuredPath.trim()

		if (!fs.existsSync(serverPath)) {
			vscode.window.showErrorMessage(
				`Essence: 'essence.server.path' points at '${serverPath}', which does not exist.`,
			)

			return null
		}

		// NOTE: Only a built bundle is JavaScript, and only that can run on
		// Node. Everything else — a TypeScript entry point, or the compiler's
		// extensionless `bin/esls` launcher — is source that needs Bun.
		return /\.(js|cjs|mjs)$/.test(serverPath)
			? { command: "node", args: [serverPath, "--stdio"] }
			: { command: "bun", args: [serverPath, "--stdio"] }
	}

	let bundledPath = path.join(context.extensionPath, "server", "server.js")

	if (!fs.existsSync(bundledPath)) {
		vscode.window.showErrorMessage(
			"Essence: the bundled Language Server is missing. Run 'bun run build' in the extension folder, or set 'essence.server.path'.",
		)

		return null
	}

	return { command: "node", args: [bundledPath, "--stdio"] }
}

async function startClient(context) {
	let serverOptions = resolveServerOptions(context)

	if (serverOptions === null) {
		return
	}

	client = new LanguageClient(
		"essence",
		"Essence Language Server",
		serverOptions,
		{
			documentSelector: [{ scheme: "file", language: "essence" }],
		},
	)

	await client.start()
}

async function stopClient() {
	if (client === undefined) {
		return
	}

	let stopping = client

	client = undefined

	await stopping.stop()
}

export async function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand("essence.restartServer", async () => {
			await stopClient()
			await startClient(context)
		}),
	)

	await startClient(context)
}

export async function deactivate() {
	await stopClient()
}
