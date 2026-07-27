import path from "node:path"

// NOTE: The debugger's pure half — a plain function of its arguments, with no
// reach into VS Code, so the specs can exercise it without an extension host.
// Everything else about debugging lives in `@essence/debug-adapter`, which the
// resolved CLI's `dap` command speaks over stdio; the extension's only job is
// finding that CLI.

// NOTE: Which executable the Debug Adapter runs through, answered as a
// description the same way `resolveServer` answers for the Language Server.
// The order is the one a user would want debugging a checkout: the explicit
// setting wins, a checkout open in the workspace is next — its `bin/essence`
// launcher runs on Bun — and otherwise `essence` is expected on PATH, however
// it got there.
export function resolveCli(configuredPath, workspaceRoot, exists) {
	if (typeof configuredPath === "string" && configuredPath.trim() !== "") {
		let cliPath = configuredPath.trim()

		if (!exists(cliPath)) {
			return {
				error: `'essence.cli.path' points at '${cliPath}', which does not exist.`,
			}
		}

		// NOTE: Only a built bundle is JavaScript, and only that can run on
		// Node. Everything else — the repository's extensionless `bin/essence`
		// launcher, or a TypeScript entry — is source that needs Bun.
		return {
			command: /\.(js|cjs|mjs)$/.test(cliPath) ? "node" : "bun",
			args: [cliPath],
			description: `configured CLI '${cliPath}'`,
		}
	}

	if (typeof workspaceRoot === "string") {
		let checkoutBinary = path.join(
			workspaceRoot,
			"packages",
			"cli",
			"bin",
			"essence",
		)

		if (exists(checkoutBinary)) {
			return {
				command: "bun",
				args: [checkoutBinary],
				description: `workspace checkout CLI '${checkoutBinary}'`,
			}
		}
	}

	return {
		command: "essence",
		args: [],
		description: "'essence' on PATH",
	}
}
