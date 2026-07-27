import crypto from "node:crypto"
import path from "node:path"

// NOTE: The debugger's pure half — everything here is a plain function of its
// arguments, with no reach into VS Code, so the specs can exercise the launch
// configuration the extension hands to js-debug without an extension host.
// `extension.js` owns the other half: settings, processes and notifications.

// NOTE: Which executable compiles, answered as a description the same way
// `resolveServer` answers for the Language Server. The order is the one a
// user would want debugging a checkout: the explicit setting wins, a checkout
// open in the workspace is next — its `bin/essence` launcher runs on Bun —
// and otherwise `essence` is expected on PATH, however it got there.
export function resolveCli(configuredPath, workspaceRoot, exists) {
	if (typeof configuredPath === "string" && configuredPath.trim() !== "") {
		let cliPath = configuredPath.trim()

		if (!exists(cliPath)) {
			return { error: `'essence.cli.path' points at '${cliPath}', which does not exist.` }
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

// NOTE: One directory per debugged program, its name stable across launches —
// relaunching overwrites rather than accumulates — and collision-free across
// programs that share a basename, which the hash of the full path is for.
export function debugBuildSlug(programPath) {
	let hash = crypto
		.createHash("sha256")
		.update(programPath)
		.digest("hex")
		.slice(0, 8)

	return `${path.basename(programPath, ".es")}-${hash}`
}

// NOTE: The command line that compiles a program for debugging: a linked map
// beside the output — the debug session needs the artifacts on disk anyway —
// and the JSON report on stdout, which is what the failure summary is read
// from.
export function compileArguments(programPath, outputFile) {
	return [
		"build",
		programPath,
		"--out",
		outputFile,
		"--sourcemap",
		"--json",
		"--quiet",
	]
}

// NOTE: One line for a notification, out of a report that may carry many
// files' worth of Diagnostics — the Problems view already shows every one of
// them through the Language Server, so the notification only says how much
// went wrong and where to look.
export function summariseFailure(report) {
	if (report === null) {
		return "the Essence compiler did not produce a readable report."
	}

	let counted =
		report.errors === 1 ? "1 error" : `${report.errors} errors`

	return `compilation failed with ${counted} — see the Problems view or the Essence output.`
}

// NOTE: How the Variables view reads an Essence value. js-debug evaluates
// this INSIDE the debuggee against each object it describes — `this` is the
// object, the argument the description it would have shown — so bigints are
// live values here, and a returned string replaces innards like
// `{numerator: 3n, denominator: 4n}` with the `3/4` the language means.
//
// It is a compact retelling of the runtime's own `getStringRepresentation`
// (runtime/src/functions.ts), and it must stay SELF-CONTAINED: it travels as
// source text into another process, where nothing of this module exists. The
// tag symbol is found by its description — each bundle creates its own
// `Symbol("$type")`, so identity can never match. Anything unexpected answers
// the default description; the debugger showing stock output is the worst
// this function is allowed to do.
function describeEssenceValue(defaultValue) {
	function render(value, depth) {
		if (typeof value === "function") {
			return "Function"
		}

		if (value === null || typeof value !== "object") {
			return null
		}

		let tagSymbol = Object.getOwnPropertySymbols(value).find(
			(symbol) => symbol.description === "$type",
		)

		if (tagSymbol === undefined) {
			return null
		}

		let tag = value[tagSymbol]

		if (typeof tag !== "string") {
			return null
		}

		if (tag === "String") {
			return `"${value.value}"`
		}

		if (tag === "Boolean") {
			return value.value ? "true" : "false"
		}

		if (tag === "Integer") {
			return String(value.value)
		}

		if (tag === "Rational") {
			return `${value.numerator}/${value.denominator}`
		}

		if (tag === "Nothing") {
			return "Nothing"
		}

		if (tag === "Algebraic" || tag === "Transcendental") {
			return tag
		}

		if (tag === "List") {
			if (value.value.length === 0) {
				return "[]"
			}

			if (depth >= 2) {
				return "[ … ]"
			}

			let items = value.value.map(
				(item) => render(item, depth + 1) ?? "…",
			)
			let rendered = `[ ${items.join(", ")} ]`

			return rendered.length < 60 ? rendered : `[ ${items[0]}, … ]`
		}

		if (tag === "Record" || tag.includes("#")) {
			let prefix = tag === "Record" ? "" : `${tag} `
			let entries = Object.entries(value)

			if (entries.length === 0) {
				return tag === "Record" ? "{}" : tag
			}

			if (depth >= 2) {
				return `${prefix}{ … }`
			}

			let members = entries.map(
				([key, member]) =>
					`${key} = ${render(member, depth + 1) ?? "…"}`,
			)
			let rendered = `${prefix}{ ${members.join(", ")} }`

			return rendered.length < 60
				? rendered
				: `${prefix}{ ${members[0]}, … }`
		}

		return null
	}

	try {
		let rendered = render(this, 0)

		return rendered === null ? defaultValue : rendered
	} catch {
		return defaultValue
	}
}

// NOTE: Shipped as the function's own source — one implementation, testable
// here as a value and evaluated over there as text.
export const ESSENCE_DESCRIPTION_GENERATOR = describeEssenceValue.toString()

// NOTE: The handoff: an `essence` launch request becomes the `pwa-node`
// session js-debug runs, pointed at the compiled bundle with its linked map.
// `outFiles` and `resolveSourceMapLocations` are spelled absolutely because
// the build directory lives in the extension's storage, OUTSIDE the workspace
// — js-debug's `${workspaceFolder}/**` default would never load the map, and
// breakpoints in `.es` files would never bind.
export function createNodeDebugConfiguration(config, artifacts) {
	let configuration = {
		type: "pwa-node",
		request: "launch",
		name: config.name,
		program: artifacts.program,
		args: Array.isArray(config.args) ? config.args : [],
		cwd: config.cwd ?? artifacts.defaultCwd,
		console: config.console ?? "internalConsole",
		stopOnEntry: config.stopOnEntry === true,
		runtimeExecutable: config.runtimeExecutable ?? "node",
		sourceMaps: true,
		outFiles: [`${artifacts.directory}/**/*.js`],
		resolveSourceMapLocations: [`${artifacts.directory}/**`],
		// NOTE: Code the final map deliberately leaves unmapped — the standard
		// library prelude and the inlined runtime — is stepped through rather
		// than into. That is the map's contract with the debugger, and
		// `smartStep` is the half the debugger owes.
		smartStep: config.smartStep !== false,
		skipFiles: [
			"<node_internals>/**",
			...(Array.isArray(config.skipFiles) ? config.skipFiles : []),
		],
	}

	// NOTE: `noDebug` is how "Run Without Debugging" arrives, and it is only
	// honoured when the STARTED configuration carries it — forwarded exactly
	// when set, absent otherwise, so an ordinary F5 config stays an ordinary
	// one.
	if (config.noDebug === true) {
		configuration.noDebug = true
	}

	// NOTE: A generator the user wrote themselves always wins, and
	// `essenceValueRendering: false` opts out entirely — both are escape
	// hatches for debugging the rendering itself.
	if (typeof config.customDescriptionGenerator === "string") {
		configuration.customDescriptionGenerator =
			config.customDescriptionGenerator
	} else if (config.essenceValueRendering !== false) {
		configuration.customDescriptionGenerator = ESSENCE_DESCRIPTION_GENERATOR
	}

	return configuration
}
