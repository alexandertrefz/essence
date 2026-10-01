import { describe, expect, it } from "bun:test"

import { serverCapabilities } from "@essence-lang/language-server/server"
import { minimatch } from "minimatch"

// The client asks `workspace/willRenameFiles` only when a filter's glob
// matches the absolute path under minimatch's defaults, as read here. A glob
// that misses leaves every importer pointing at the old file, silently.
//
// Under the default `dot: false`, neither `*` nor `**` crosses a segment
// starting with `.`, such as `~/.local` or a `.generated/` folder.

let filters = serverCapabilities.workspace?.fileOperations?.willRename?.filters

function reaches(path: string, matches: "file" | "folder"): boolean {
	return (filters ?? []).some(
		(filter) =>
			filter.pattern.matches === matches &&
			minimatch(path, filter.pattern.glob),
	)
}

describe("the rename filters the Server advertises", () => {
	it("reach a source and the folder above it", () => {
		expect(reaches("/Users/reader/repo/Season.es", "file")).toBe(true)
		expect(reaches("/Users/reader/repo/lib", "folder")).toBe(true)
	})

	it("reach a source under a dot-directory", () => {
		expect(reaches("/Users/reader/repo/.generated/Season.es", "file")).toBe(
			true,
		)
		expect(reaches("/Users/reader/.local/share/Season.es", "file")).toBe(
			true,
		)
		expect(reaches("/Users/reader/repo/.generated/lib", "folder")).toBe(
			true,
		)
	})

	it("reach nothing that is not an Essence source", () => {
		expect(reaches("/Users/reader/repo/Season.txt", "file")).toBe(false)
		expect(reaches("/Users/reader/repo/.generated/notes.md", "file")).toBe(
			false,
		)
	})
})
