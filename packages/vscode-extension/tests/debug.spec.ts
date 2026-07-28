import { describe, expect, it } from "bun:test"
import path from "node:path"

import { resolveCli } from "../debug.js"

// NOTE: The extension's whole debugging job is finding the CLI whose `dap`
// command speaks the session — everything else lives in
// `@essence-lang/debug-adapter`, tested there.
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
		let launcher = path.join("/repo", "packages", "cli", "bin", "essence")

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
