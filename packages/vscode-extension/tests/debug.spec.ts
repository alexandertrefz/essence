import { describe, expect, it } from "bun:test"
import path from "node:path"

import {
	compileArguments,
	createNodeDebugConfiguration,
	debugBuildSlug,
	ESSENCE_DESCRIPTION_GENERATOR,
	resolveCli,
	summariseFailure,
} from "../debug.js"

// NOTE: The generator travels to the debuggee as source text — evaluating it
// here, the way js-debug does over there, is what proves it is genuinely
// self-contained: a captured binding would throw the moment it runs outside
// this module.
const describeValue = (0, eval)(`(${ESSENCE_DESCRIPTION_GENERATOR})`) as (
	this: unknown,
	defaultValue: string,
) => string

function tagged(tag: string, fields: Record<string, unknown> = {}): object {
	return { ...fields, [Symbol("$type")]: tag }
}

function describe$(value: unknown): string {
	return describeValue.call(value, "«default»")
}

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

	it("renders Essence values unless told not to", () => {
		expect(
			createNodeDebugConfiguration({}, artifacts)
				.customDescriptionGenerator,
		).toBe(ESSENCE_DESCRIPTION_GENERATOR)
		expect(
			"customDescriptionGenerator" in
				createNodeDebugConfiguration(
					{ essenceValueRendering: false },
					artifacts,
				),
		).toBe(false)
	})

	it("never overwrites a generator the user wrote", () => {
		expect(
			createNodeDebugConfiguration(
				{ customDescriptionGenerator: "function (d) { return d }" },
				artifacts,
			).customDescriptionGenerator,
		).toBe("function (d) { return d }")
	})
})

describe("the description generator", () => {
	it("renders the scalar values as the language spells them", () => {
		expect(describe$(tagged("Integer", { value: 42n }))).toBe("42")
		expect(
			describe$(tagged("Rational", { numerator: 3n, denominator: 4n })),
		).toBe("3/4")
		expect(describe$(tagged("String", { value: "hello" }))).toBe('"hello"')
		expect(describe$(tagged("Boolean", { value: true }))).toBe("true")
		expect(describe$(tagged("Nothing"))).toBe("Nothing")
	})

	it("renders Records and Lists like __print does", () => {
		expect(
			describe$(
				tagged("Record", {
					width: tagged("Integer", { value: 3n }),
					height: tagged("Integer", { value: 4n }),
				}),
			),
		).toBe("{ width = 3, height = 4 }")
		expect(
			describe$(
				tagged("List", {
					value: [
						tagged("Integer", { value: 1n }),
						tagged("Integer", { value: 2n }),
					],
				}),
			),
		).toBe("[ 1, 2 ]")
		expect(describe$(tagged("Record"))).toBe("{}")
		expect(describe$(tagged("List", { value: [] }))).toBe("[]")
	})

	it("renders a Case by its tag, payload spelled like a Record", () => {
		expect(describe$(tagged("Ordering#Less"))).toBe("Ordering#Less")
		expect(
			describe$(
				tagged("Shape#Circle", {
					radius: tagged("Integer", { value: 2n }),
				}),
			),
		).toBe("Shape#Circle { radius = 2 }")
	})

	it("caps what one line can hold", () => {
		let long = describe$(
			tagged("Record", {
				first: tagged("String", { value: "a very long member value" }),
				second: tagged("String", { value: "another long member value" }),
			}),
		)

		expect(long.endsWith("… }")).toBe(true)
		expect(long.length).toBeLessThan(80)
	})

	it("answers the default for anything that is not an Essence value", () => {
		expect(describe$({ plain: true })).toBe("«default»")
		expect(describe$(null)).toBe("«default»")
	})

	// NOTE: The runtime prints a bare Function as the one word — its Type is
	// erased and its source is compiled output, neither worth showing.
	it("names a Function the way the runtime prints one", () => {
		expect(describe$(() => 1)).toBe("Function")
	})
})
