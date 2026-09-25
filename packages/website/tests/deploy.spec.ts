import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..")

type NetlifyConfiguration = {
	build?: { environment?: { BUN_VERSION?: unknown } }
}

// NOTE: Netlify installs the Bun `BUN_VERSION` names, so the site is built by
// the Bun that development and CI run only while it matches `.bun-version`.
describe("the Netlify deploy", () => {
	it("builds with the Bun `.bun-version` pins", () => {
		let configuration = Bun.TOML.parse(
			readFileSync(path.join(REPOSITORY_ROOT, "netlify.toml"), "utf8"),
		) as NetlifyConfiguration
		let pinned = readFileSync(
			path.join(REPOSITORY_ROOT, ".bun-version"),
			"utf8",
		).trim()

		expect(configuration.build?.environment?.BUN_VERSION).toBe(pinned)
	})
})
