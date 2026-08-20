import path from "node:path"

// NOTE: Where everything the extension spawns is decided — pure functions of
// their arguments, with the file system, the environment and the shell handed
// in, so the specs can exercise every branch without an extension host.
//
// The premise throughout is that PATH cannot be trusted. VS Code reads the
// shell environment once, at launch, by running the user's login shell; when
// that probe times out — a slow `.zshrc`, an agent waiting on a passphrase —
// every extension host for the rest of the session runs on the bare launchd
// PATH, where neither Bun nor a user-installed Node exists. So a bundle runs on
// the Node VS Code itself ships, which needs no lookup at all, and anything
// that does need a runtime is looked for in PATH, then where its installer
// puts it, then by asking the login shell directly — the probe VS Code failed.

const macosLaunchdPath = "/usr/bin:/bin:/usr/sbin:/sbin"

function isBlank(value) {
	return typeof value !== "string" || value.trim() === ""
}

// NOTE: A `.js` (or `.cjs`/`.mjs`) entry is a built bundle, and only that can
// run on Node. Everything else — a TypeScript entry point, or the compiler's
// extensionless `bin/esls` and `bin/essence` launchers — is source that needs
// Bun.
export function isBundle(filePath) {
	return /\.(js|cjs|mjs)$/.test(filePath)
}

// NOTE: What a path setting may say. `${workspaceFolder}` and a relative path
// are what let a checkout commit a working `.vscode/settings.json` instead of
// one author's absolute path, and `~` is how a path is written in a shell.
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

// NOTE: Which directories to look in beyond PATH, by executable. These are
// where each installer writes, which is what the user's shell configuration
// would have added to PATH had VS Code managed to read it: Bun's own
// installer, Homebrew on either architecture, the version managers. `essence`
// is installed globally through Bun or npm, so it lands in any of them.
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

		// NOTE: nvm keeps every installed version side by side and selects
		// one per shell, which nothing outside a shell can ask about; the
		// newest is the one a fresh install would pick.
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

// NOTE: PATH first, because that is what the user configured and what every
// other tool would run; the usual locations only when PATH has nothing, so a
// deliberately chosen version is never shadowed by a stray install. Every
// directory looked in is answered back, for the output channel to name when
// nothing is found.
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

// NOTE: The last resort is the question VS Code asks at launch, asked again:
// an interactive login shell, which sources the same files that put the
// runtime on the user's PATH. `run` is handed in — it spawns the shell with a
// timeout and answers its stdout, or nothing — and the answer is read from the
// bottom up, because an interactive shell may print a greeting or a prompt
// before `command -v` says anything, and only an absolute path that exists
// is believed.
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

// NOTE: The one answer for "which `bun` (or `node`, or `essence`)". The
// explicit setting wins and is not second-guessed — a path that does not exist
// is an error, not a reason to go looking elsewhere, because the user asked
// for that one. After that, PATH, the usual locations, and the login shell, in
// that order; `source` says which, so the output channel can tell a user whose
// PATH is broken how the runtime was found anyway.
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

	// NOTE: Spelled out rather than `return found`, so every return here is a
	// fresh literal and the inferred type gives each branch the others' fields
	// as absent — which is what lets a caller ask `.error` of the answer.
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

// NOTE: The environment explained, for when a lookup fails or succeeds only
// by the usual locations. The bare launchd PATH is the signature of VS Code
// having given up on the shell probe, and that has one fix — a full relaunch,
// which Reload Window is not, since the window inherits the environment from
// the process that failed.
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

// NOTE: Which Language Server to run, and how. A bundle — the one shipped in
// `server/`, or a configured `.js` — is run as a `module`, which is
// vscode-languageclient forking it on the Node VS Code itself ships: no
// lookup, so the default install cannot be broken by PATH. A configured source
// entry point needs Bun, resolved through `resolveBun`. When the configured
// server cannot run, the bundled one is offered as the `fallback`, so the
// user keeps diagnostics while the setting is repaired; the caller decides
// whether to take it, and says so if it does.
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

// NOTE: Which CLI the Debug Adapter runs through — the same shape of answer
// as the Language Server's. The order is the one a user would want debugging
// a checkout: the explicit setting wins, a checkout open in the workspace is
// next — its `bin/essence` launcher runs on Bun — and otherwise `essence` is
// expected to be installed, wherever that put it. `kind` says what the caller
// still has to resolve: a `module` runs on VS Code's Node, `bun` wants Bun
// found, and `installed` wants `essence` itself found.
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
