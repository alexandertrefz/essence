import { beforeEach, describe, expect, it, mock } from "bun:test"

import { createStub, type StubRange } from "./vscodeStub.js"

// The command an extraction ends on. Apart from where the cursor goes, it is
// all API calls, which these specs record through the stub.

const stub = createStub()

mock.module("vscode", () => stub.module)

// Imported after the mock, which a static import would evaluate before.
const { revealForRename } = await import("../renameAt.js")

const URI = "file:///repo/Season.es"

describe("revealForRename", () => {
	beforeEach(() => {
		stub.reset()
	})

	it("opens the document at the name and runs the Editor's rename", async () => {
		await revealForRename(URI, { line: 4, character: 9 })

		expect(stub.shownDocuments).toHaveLength(1)
		expect(stub.shownDocuments[0]!.uri.fsPath).toBe("/repo/Season.es")
		expect(stub.shownDocuments[0]!.uri.toString()).toBe(URI)

		let selection = stub.shownDocuments[0]!.options?.selection as StubRange

		// An empty selection: rename reads the word the cursor stands in.
		expect(selection).toEqual({
			startLine: 4,
			startCharacter: 9,
			endLine: 4,
			endCharacter: 9,
		})

		expect(stub.executedCommands).toEqual([
			{ command: "editor.action.rename", arguments: [] },
		])
	})

	it("leaves the selection on the editor it opened", async () => {
		await revealForRename(URI, { line: 0, character: 0 })

		expect(stub.editors).toHaveLength(1)
		expect(stub.editors[0]!.selection).toEqual({
			startLine: 0,
			startCharacter: 0,
			endLine: 0,
			endCharacter: 0,
		})
	})

	// Anything that knows the command's name can call it, so a call of the
	// wrong shape must not open rename wherever the cursor is.
	it("does nothing when it was not handed a URI and a Position", async () => {
		await revealForRename(undefined, { line: 1, character: 1 })
		await revealForRename(URI, undefined)
		await revealForRename(URI, null)
		await revealForRename(URI, { line: 1 })

		expect(stub.shownDocuments).toEqual([])
		expect(stub.executedCommands).toEqual([])
	})
})
