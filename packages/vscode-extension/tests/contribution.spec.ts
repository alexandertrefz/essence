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

	// NOTE: Every one of these settings names an executable to spawn, so every
	// one is ignored in untrusted workspaces — a workspace could point any of
	// them at a program it ships itself.
	it("restricts every executable-path setting", () => {
		let restricted =
			manifest.capabilities.untrustedWorkspaces.restrictedConfigurations

		expect(restricted).toEqual([
			"essence.server.path",
			"essence.cli.path",
			"essence.bun.path",
			"essence.node.path",
		])
	})

	it("documents every path setting it reads", () => {
		let properties = manifest.contributes.configuration.properties

		for (let setting of [
			"essence.server.path",
			"essence.cli.path",
			"essence.bun.path",
			"essence.node.path",
		]) {
			expect(properties[setting as keyof typeof properties]).toBeDefined()
		}
	})
})

// NOTE: The live test session is a thing that RUNS a project's code as it is
// typed, so the setting that declines it is part of the contract rather than a
// convenience — a reader who cannot find it has no way to stop it.
describe("the test session contribution", () => {
	it("offers the setting that switches the live session off", () => {
		let properties = manifest.contributes.configuration.properties

		expect(properties["essence.tests.enabled"]).toMatchObject({
			type: "boolean",
			default: true,
		})
	})

	it("keeps the lens commands out of the palette", () => {
		// NOTE: `essence.test.run` and `essence.test.debug` are registered in
		// `extension.js` and invoked by a Code Lens, which carries the ids to
		// run. A command in `contributes.commands` is a command the palette
		// offers with no ids at all, which could only ever do nothing. The two
		// that ARE offered take no arguments: what failed, and where the
		// session writes.
		expect(
			manifest.contributes.commands.map((command) => command.command),
		).toEqual([
			"essence.restartServer",
			"essence.test.runFailed",
			"essence.test.showOutput",
		])
	})

	// NOTE: The palette groups by the prefix, and a `category` beside a title
	// that already carries one reads as "Test: Essence: …".
	it("names every palette command the same way", () => {
		for (let command of manifest.contributes.commands) {
			expect(command.title.startsWith("Essence: ")).toBe(true)
			expect(command).not.toHaveProperty("category")
		}
	})

	// NOTE: The live session runs a project's code on every edit, so what it
	// runs and how often are settings rather than constants — and each one is
	// only real because the Server reads it back out of the client.
	it("offers the settings that say what runs and how often", () => {
		let properties = manifest.contributes.configuration.properties

		expect(properties["essence.tests.skipTags"]).toMatchObject({
			type: "array",
			default: [],
		})
		expect(properties["essence.tests.debounce"]).toMatchObject({
			type: "number",
			default: 450,
		})
	})
})
