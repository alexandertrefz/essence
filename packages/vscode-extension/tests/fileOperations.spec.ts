import { describe, expect, it } from "bun:test"

import { serverCapabilities } from "@essence-lang/language-server/server"
import { minimatch } from "minimatch"

// NOTE: What the Server ADVERTISES for `workspace/willRenameFiles` is only half
// of whether it is ever asked: the client decides, and it decides by matching
// each filter's glob against the file's absolute path with minimatch — the same
// library and the same defaults this reads them with. So a glob that looks
// right and reaches nothing is a rename that silently leaves every dependent's
// specifier pointing at a file that is no longer there, with no Diagnostic and
// no edit to undo.
//
// `dot: false` is the default, and under it neither `*` nor `**` crosses a
// segment that opens with a `.`. A project living under `~/.local/…`, or a
// source in a `.generated/` folder, is therefore a shape the plain globs can
// not see at all.

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
