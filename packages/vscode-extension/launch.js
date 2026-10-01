import path from "node:path"

// Where everything the extension spawns comes from, as pure functions with the
// file system, environment and shell handed in. `PATH` cannot be trusted. See
// "Finding the runtimes" in DEVELOPMENT.md.

const macosLaunchdPath = "/usr/bin:/bin:/usr/sbin:/sbin"

function isBlank(value) {
	return typeof value !== "string" || value.trim() === ""
}

// Only a built `.js`, `.cjs` or `.mjs` bundle runs on Node. A TypeScript entry
// point or an extensionless launcher such as `bin/esls` needs Bun.
export function isBundle(filePath) {
	return /\.(js|cjs|mjs)$/.test(filePath)
}

/**
 * A path setting may use `${workspaceFolder}`, a relative path or `~`, so a
 * checkout can commit a `.vscode/settings.json` that works for everyone.
 *
 * @param raw
 * @param {{ workspaceRoot?: string, home?: string }} [where]
 */
export function expandPath(raw, { workspaceRoot, home } = {}) {
	let value = raw.trim()

	if (typeof workspaceRoot === "string") {
		value = value.replaceAll("${workspaceFolder}", workspaceRoot)
	}

	if (typeof home === "string" && (value === "~" || value.startsWith("~/"))) {
		value = path.join(home, value.slice(1))
	}

	if (!path.isAbsolute(value) && typeof workspaceRoot === "string") {
		value = path.resolve(workspaceRoot, value)
	}

	return value
}

// Where each installer writes, which the user's shell would have added to
// `PATH`: Bun's installer, Homebrew and the Node version managers. A global
// `essence` may land in any of them.
function usualDirectories(name, { env, home, platform, list }) {
	let directories = []
	let add = (...segments) => {
		if (segments.every((segment) => typeof segment === "string")) {
			directories.push(path.join(...segments))
		}
	}

	let bunDirectories = () => {
		add(env.BUN_INSTALL, "bin")
		add(home, ".bun", "bin")
	}

	let nodeDirectories = () => {
		add(home, ".volta", "bin")
		add(home, ".local", "share", "fnm", "aliases", "default", "bin")
		add(home, ".fnm", "aliases", "default", "bin")

		// nvm selects a version per shell, which cannot be asked from
		// outside one, so the newest comes first.
		if (typeof home === "string") {
			let versions = path.join(home, ".nvm", "versions", "node")

			for (let version of list(versions).sort(
				compareVersionsDescending,
			)) {
				add(versions, version, "bin")
			}
		}
	}

	if (platform === "win32") {
		if (name === "bun" || name === "essence") {
			add(env.BUN_INSTALL, "bin")
			add(env.USERPROFILE, ".bun", "bin")
			add(env.USERPROFILE, "scoop", "shims")
		}

		if (name === "node" || name === "essence") {
			add(env.ProgramFiles, "nodejs")
			add(env.LOCALAPPDATA, "Volta", "bin")
			add(env.APPDATA, "npm")
		}

		return directories
	}

	if (name === "bun" || name === "essence") {
		bunDirectories()
	}

	if (name === "node" || name === "essence") {
		nodeDirectories()
	}

	add("/opt/homebrew/bin")
	add("/usr/local/bin")
	add("/home/linuxbrew/.linuxbrew/bin")

	if (name === "essence") {
		add(home, ".npm-global", "bin")
	}

	return directories
}

function compareVersionsDescending(left, right) {
	let parse = (version) =>
		version
			.replace(/^v/, "")
			.split(".")
			.map((part) => Number.parseInt(part, 10) || 0)
	let [a, b] = [parse(left), parse(right)]

	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		let difference = (b[index] ?? 0) - (a[index] ?? 0)

		if (difference !== 0) {
			return difference
		}
	}

	return 0
}

function executableNames(name, platform) {
	return platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name]
}

// `PATH` first, then the usual locations, so a stray install never shadows a
// chosen version. The directories searched are answered for the output
// channel.
export function findExecutable(name, { env, home, platform, exists, list }) {
	let delimiter = platform === "win32" ? ";" : ":"
	let onPath = (env.PATH ?? "")
		.split(delimiter)
		.filter((directory) => directory !== "")
	let usual = usualDirectories(name, { env, home, platform, list })
	let searched = []

	for (let [directories, source] of [
		[onPath, "PATH"],
		[usual, "usual location"],
	]) {
		for (let directory of directories) {
			if (searched.includes(directory)) {
				continue
			}

			searched.push(directory)

			for (let fileName of executableNames(name, platform)) {
				let candidate = path.join(directory, fileName)

				if (exists(candidate)) {
					return { path: candidate, source, searched }
				}
			}
		}
	}

	return { searched }
}

// Asks an interactive login shell, as VS Code does at launch. `run` spawns it
// with a timeout. The output is read from the bottom up, past any greeting,
// and only an existing absolute path counts.
export async function probeLoginShell(name, { platform, shell, run, exists }) {
	if (platform === "win32" || isBlank(shell)) {
		return undefined
	}

	let output = await run(shell, ["-ilc", `command -v ${name}`])

	if (typeof output !== "string") {
		return undefined
	}

	let lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "")

	for (let line of lines.reverse()) {
		if (path.isAbsolute(line) && exists(line)) {
			return line
		}
	}

	return undefined
}

// Which `bun`, `node` or `essence` to run. A configured path that does not
// exist is an error rather than a reason to look elsewhere. See "Finding the
// runtimes" in DEVELOPMENT.md.
export async function resolveRuntime(
	name,
	configured,
	{ settingName, env, home, platform, shell, exists, list, run },
) {
	if (!isBlank(configured)) {
		let configuredPath = expandPath(configured, { home })

		if (!exists(configuredPath)) {
			return {
				error: `'${settingName}' points at '${configuredPath}', which does not exist.`,
				searched: [],
			}
		}

		return { path: configuredPath, source: "setting", searched: [] }
	}

	let found = findExecutable(name, { env, home, platform, exists, list })

	// A fresh literal rather than `found`, so the inferred type marks the
	// other branches' fields absent and a caller may ask for `.error`.
	if (found.path !== undefined) {
		return {
			path: found.path,
			source: found.source,
			searched: found.searched,
		}
	}

	let fromShell = await probeLoginShell(name, {
		platform,
		shell,
		run,
		exists,
	})

	if (fromShell !== undefined) {
		return {
			path: fromShell,
			source: "login shell",
			searched: found.searched,
		}
	}

	return {
		error: `no '${name}' executable was found on PATH, in its usual install locations, or through the login shell.`,
		searched: found.searched,
	}
}

// The environment explained, for a lookup that fails or needs the usual
// locations. The bare launchd `PATH` means VS Code's shell probe failed, which
// only a full relaunch fixes.
export function describeEnvironment({ env, platform }) {
	let currentPath = env.PATH ?? ""
	let lines = [`PATH as the extension host sees it: '${currentPath}'`]

	if (platform === "darwin" && currentPath === macosLaunchdPath) {
		lines.push(
			"That is the bare launchd PATH: VS Code could not read your shell environment when it launched (its log says 'Unable to resolve your shell environment'), so nothing your shell configuration adds is visible here. Quit VS Code fully and reopen it — Reload Window keeps the old environment.",
		)
	}

	return lines
}

// Which Language Server to run, and how. A bundle runs as a `module` on VS
// Code's own Node; a configured source entry point needs Bun. When the
// configured server cannot run, the bundled one is offered as `fallback`.
export async function resolveServer(
	configured,
	{ workspaceRoot, extensionPath, home, exists, resolveBun },
) {
	let bundledPath = path.join(extensionPath, "server", "server.js")
	let bundled = exists(bundledPath)
		? { kind: "module", path: bundledPath, configured: false }
		: undefined

	if (!isBlank(configured)) {
		let serverPath = expandPath(configured, { workspaceRoot, home })

		if (!exists(serverPath)) {
			return {
				error: `'essence.server.path' points at '${serverPath}', which does not exist.`,
				fallback: bundled,
			}
		}

		if (isBundle(serverPath)) {
			return { kind: "module", path: serverPath, configured: true }
		}

		let bun = await resolveBun()

		if (bun.error !== undefined) {
			return {
				error: `'essence.server.path' names '${serverPath}', which is source and needs Bun to run, but ${bun.error}`,
				searched: bun.searched,
				fallback: bundled,
			}
		}

		return {
			kind: "command",
			command: bun.path,
			runtimeSource: bun.source,
			path: serverPath,
			configured: true,
		}
	}

	if (bundled === undefined) {
		return {
			error: "the bundled Language Server is missing. Run 'bun run build' in packages/vscode-extension, or set 'essence.server.path'.",
		}
	}

	return bundled
}

export function describeServer(server) {
	let which = `${server.configured ? "configured" : "bundled"} Language Server '${server.path}'`

	return server.kind === "module"
		? `${which}, run on VS Code's own Node`
		: `${which}, run with '${server.command}'`
}

// Which CLI the Debug Adapter runs through: the setting, then a checkout open
// in the workspace, then an installed `essence`. `kind` says what is left to
// resolve: nothing for a `module`, Bun for `bun`, `essence` for `installed`.
export function resolveCli(configured, { workspaceRoot, home, exists }) {
	if (!isBlank(configured)) {
		let cliPath = expandPath(configured, { workspaceRoot, home })

		if (!exists(cliPath)) {
			return {
				error: `'essence.cli.path' points at '${cliPath}', which does not exist.`,
			}
		}

		return {
			kind: isBundle(cliPath) ? "module" : "bun",
			path: cliPath,
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
				kind: "bun",
				path: checkoutBinary,
				description: `workspace checkout CLI '${checkoutBinary}'`,
			}
		}
	}

	return { kind: "installed", description: "the installed 'essence'" }
}
