import { describe, expect, it } from "bun:test"
import path from "node:path"

import {
	compileArguments,
	createNodeDebugConfiguration,
	debugBuildSlug,
	resolveCli,
	summariseFailure,
} from "../debug.js"

describe("resolveCli", () => {
	it("runs a configured bundle with node and anything else with bun", () => {
		expect(resolveCli("/tools/essence.js", undefined, () => true)).toEqual({
			command: "node",
			args: ["/tools/essence.js"],
			description: "configured CLI '/tools/essence.js'",
		})

		expect(
			resolveCli("/repo/packages/cli/bin/essence", undefined, () => true)
				.command,
		).toBe("bun")
	})

	it("refuses a configured path that does not exist", () => {
		let result = resolveCli("/nowhere/essence", undefined, () => false)

		expect(result.error).toContain("/nowhere/essence")
		expect(result.command).toBeUndefined()
	})

	it("finds a checkout's own launcher in the workspace", () => {
		let launcher = path.join(
			"/repo",
			"packages",
			"cli",
			"bin",
			"essence",
		)

		expect(
			resolveCli("", "/repo", (candidate) => candidate === launcher),
		).toEqual({
			command: "bun",
			args: [launcher],
			description: `workspace checkout CLI '${launcher}'`,
		})
	})

	it("falls back to essence on PATH", () => {
		expect(resolveCli(undefined, "/elsewhere", () => false)).toEqual({
			command: "essence",
			args: [],
			description: "'essence' on PATH",
		})
	})
})

describe("debugBuildSlug", () => {
	it("stays stable for the same program", () => {
		expect(debugBuildSlug("/work/App.es")).toBe(
			debugBuildSlug("/work/App.es"),
		)
	})

	it("keeps programs sharing a basename apart", () => {
		let first = debugBuildSlug("/work/App.es")
		let second = debugBuildSlug("/other/App.es")

		expect(first).not.toBe(second)
		expect(first.startsWith("App-")).toBe(true)
		expect(second.startsWith("App-")).toBe(true)
	})
})

describe("compileArguments", () => {
	it("asks for a linked map and the JSON report", () => {
		expect(compileArguments("/work/App.es", "/builds/App.js")).toEqual([
			"build",
			"/work/App.es",
			"--out",
			"/builds/App.js",
			"--sourcemap",
			"--json",
			"--quiet",
		])
	})
})

describe("summariseFailure", () => {
	it("counts the errors", () => {
		expect(summariseFailure({ errors: 3 })).toContain("3 errors")
		expect(summariseFailure({ errors: 1 })).toContain("1 error —")
	})

	it("survives a report that never arrived", () => {
		expect(summariseFailure(null)).toContain("readable report")
	})
})

describe("createNodeDebugConfiguration", () => {
	const artifacts = {
		program: "/storage/debug-builds/App-abc12345/App.js",
		directory: "/storage/debug-builds/App-abc12345",
		defaultCwd: "/work",
	}

	it("hands the session to js-debug pointed at the compiled bundle", () => {
		let configuration = createNodeDebugConfiguration(
			{ type: "essence", request: "launch", name: "Debug App.es" },
			artifacts,
		)

		expect(configuration.type).toBe("pwa-node")
		expect(configuration.request).toBe("launch")
		expect(configuration.name).toBe("Debug App.es")
		expect(configuration.program).toBe(artifacts.program)
		expect(configuration.runtimeExecutable).toBe("node")
		expect(configuration.sourceMaps).toBe(true)
	})

	// NOTE: The build directory lives OUTSIDE the workspace, so both globs
	// must be absolute — js-debug's `${workspaceFolder}/**` default would
	// never load the map and no breakpoint would ever bind.
	it("points the map globs at the build directory absolutely", () => {
		let configuration = createNodeDebugConfiguration({}, artifacts)

		expect(configuration.outFiles).toEqual([
			"/storage/debug-builds/App-abc12345/**/*.js",
		])
		expect(configuration.resolveSourceMapLocations).toEqual([
			"/storage/debug-builds/App-abc12345/**",
		])
	})

	it("steps over unmapped code unless told otherwise", () => {
		expect(createNodeDebugConfiguration({}, artifacts).smartStep).toBe(true)
		expect(
			createNodeDebugConfiguration({ smartStep: false }, artifacts)
				.smartStep,
		).toBe(false)
	})

	it("keeps node internals skipped and merges the user's patterns", () => {
		expect(
			createNodeDebugConfiguration(
				{ skipFiles: ["**/vendor/**"] },
				artifacts,
			).skipFiles,
		).toEqual(["<node_internals>/**", "**/vendor/**"])
	})

	it("passes the launch surface through", () => {
		let configuration = createNodeDebugConfiguration(
			{
				args: ["--flag"],
				cwd: "/elsewhere",
				console: "integratedTerminal",
				stopOnEntry: true,
				runtimeExecutable: "/opt/node",
			},
			artifacts,
		)

		expect(configuration.args).toEqual(["--flag"])
		expect(configuration.cwd).toBe("/elsewhere")
		expect(configuration.console).toBe("integratedTerminal")
		expect(configuration.stopOnEntry).toBe(true)
		expect(configuration.runtimeExecutable).toBe("/opt/node")
	})

	it("defaults the working directory to the one it was handed", () => {
		expect(createNodeDebugConfiguration({}, artifacts).cwd).toBe("/work")
	})

	// NOTE: `noDebug` is how "Run Without Debugging" arrives — forwarded
	// exactly when set, absent otherwise, so an ordinary launch stays one.
	it("forwards noDebug exactly when set", () => {
		expect(
			createNodeDebugConfiguration({ noDebug: true }, artifacts).noDebug,
		).toBe(true)
		expect(
			"noDebug" in createNodeDebugConfiguration({}, artifacts),
		).toBe(false)
	})
})
