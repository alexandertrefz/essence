import { describe, expect, it } from "bun:test"

import manifest from "../package.json"

// Nothing type-checks the manifest, and a mistake in it fails silently in VS
// Code, so its contract is pinned here.
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

	// A starter configuration missing a required attribute would need repair
	// before first use.
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

	// VS Code derives the activation events from the contributions, and the
	// manifest linter warns about any spelled out.
	it("relies on the generated activation events", () => {
		expect(manifest).not.toHaveProperty("activationEvents")
	})

	// Each setting names an executable to spawn, so untrusted workspaces
	// cannot set them to a program they ship.
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

// The live session runs a project's code as it is typed, so the setting that
// switches it off is part of the contract.
describe("the test session contribution", () => {
	it("offers the setting that switches the live session off", () => {
		let properties = manifest.contributes.configuration.properties

		expect(properties["essence.tests.enabled"]).toMatchObject({
			type: "boolean",
			default: true,
		})
	})

	it("keeps the lens commands out of the palette", () => {
		// A lens command such as `essence.test.run` needs the ids its lens
		// carries, which the palette cannot pass. Only commands without
		// arguments are offered.
		expect(
			manifest.contributes.commands.map((command) => command.command),
		).toEqual([
			"essence.restartServer",
			"essence.test.runFailed",
			"essence.test.showOutput",
		])
	})

	// The title carries the prefix, so a `category` would read as
	// "Test: Essence: …".
	it("names every palette command the same way", () => {
		for (let command of manifest.contributes.commands) {
			expect(command.title.startsWith("Essence: ")).toBe(true)
			expect(command).not.toHaveProperty("category")
		}
	})

	// Whether the live session runs and how often are settings, which the
	// Server reads from the client.
	it("offers the settings that say whether it runs and how often", () => {
		let properties: Record<string, unknown> =
			manifest.contributes.configuration.properties

		expect(properties["essence.tests.debounce"]).toMatchObject({
			type: "number",
			default: 450,
		})
		// Off by default: an instrumented bundle differs from a build's and
		// does more work on every keystroke.
		expect(properties["essence.tests.coverage"]).toMatchObject({
			type: "boolean",
			default: false,
		})
		// Which tags a run skips belongs to the project, so it lives in the
		// `essence.json` the terminal reads too.
		expect(properties).not.toHaveProperty("essence.tests.skipTags")
	})

	// The project file is JSON with comments, described by the generated
	// Schema for completion and hover. The client's document selector also
	// sends it to the Server, which reports mistakes on the file.
	describe("the project file contribution", () => {
		it("reads essence.json as JSON with comments", () => {
			expect(manifest.contributes.languages).toContainEqual({
				id: "jsonc",
				filenames: ["essence.json"],
			})
		})

		it("validates it against the generated Schema", () => {
			expect(manifest.contributes.jsonValidation).toEqual([
				{
					fileMatch: ["essence.json"],
					url: "./schemas/essence.schema.json",
				},
			])
		})
	})
})
