import { describe, expect, it } from "bun:test"

import manifest from "../package.json"

// NOTE: The manifest is data VS Code reads, not code anything type-checks —
// a missing `breakpoints` entry or a snippet without its required attribute
// fails silently in the product, so the contract is pinned here instead.
describe("the debugger contribution", () => {
	const debuggers = manifest.contributes.debuggers

	it("declares Essence breakpoints", () => {
		expect(manifest.contributes.breakpoints).toEqual([
			{ language: "essence" },
		])
	})

	it("contributes one debugger, for the language", () => {
		expect(debuggers).toHaveLength(1)
		expect(debuggers[0]!.type).toBe("essence")
		expect(debuggers[0]!.languages).toEqual(["essence"])
	})

	it("requires exactly the program attribute", () => {
		expect(debuggers[0]!.configurationAttributes.launch.required).toEqual([
			"program",
		])
	})

	// NOTE: A starter configuration that omits a required attribute is a
	// launch.json the user has to repair before first use.
	it("writes complete starter configurations", () => {
		for (let configuration of debuggers[0]!.initialConfigurations) {
			expect(configuration.type).toBe("essence")
			expect(configuration.request).toBe("launch")
			expect(typeof configuration.program).toBe("string")
		}

		for (let snippet of debuggers[0]!.configurationSnippets) {
			expect(snippet.body.type).toBe("essence")
			expect(snippet.body.request).toBe("launch")
			expect(typeof snippet.body.program).toBe("string")
		}
	})

	// NOTE: VS Code derives the debug activation events from the `debuggers`
	// contribution itself, so none may be spelled out — a spelled-out one is
	// the warning the manifest linter raises.
	it("relies on the generated debug activation events", () => {
		expect(manifest.activationEvents).toEqual(["onLanguage:essence"])
	})

	// NOTE: Both settings name an executable to spawn, so both are ignored in
	// untrusted workspaces — a workspace could point either at a program it
	// ships itself.
	it("restricts every executable-path setting", () => {
		let restricted =
			manifest.capabilities.untrustedWorkspaces.restrictedConfigurations

		expect(restricted).toContain("essence.server.path")
		expect(restricted).toContain("essence.cli.path")
	})

	it("documents the CLI setting it reads", () => {
		expect(
			manifest.contributes.configuration.properties["essence.cli.path"],
		).toBeDefined()
	})
})
