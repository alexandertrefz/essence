import { beforeEach, describe, expect, it, mock } from "bun:test"

import { createStub, type StubRange } from "./vscodeStub.js"

// NOTE: The command an extraction ends on. Everything it DECIDES is one line —
// where the cursor goes — and everything else about it is the API: which
// document was opened, which selection it was opened at, and that rename was
// asked for afterwards. None of that is visible in an Extension Development
// Host without watching it happen, and all of it is wrong in ways nobody
// notices until an extraction stops offering to rename anything.

const stub = createStub()

mock.module("vscode", () => stub.module)

// NOTE: After the mock, because a static import would evaluate `renameAt.js` —
// and its `import * as vscode` — before the registration ran.
const { revealForRename } = await import("../renameAt.js")

const URI = "file:///repo/Season.es"

describe("revealForRename", () => {
	beforeEach(() => {
		stub.reset()
	})

	it("opens the document at the name and runs the Editor's rename", async () => {
		await revealForRename(URI, { line: 4, character: 9 })

		expect(stub.shownDocuments).toHaveLength(1)
		expect(stub.shownDocuments[0]!.uri.fsPath).toBe(URI)

		let selection = stub.shownDocuments[0]!.options?.selection as StubRange

		// NOTE: An empty selection — a cursor is a selection of no width, and
		// rename reads the word it stands in rather than the text it covers.
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

	// NOTE: The command is not in `contributes.commands`, so nothing offers it
	// from the palette — but a command is callable by anything that knows its
	// name, and one called with the wrong shape must do nothing rather than
	// open rename wherever the cursor happens to be.
	it("does nothing when it was not handed a URI and a Position", async () => {
		await revealForRename(undefined, { line: 1, character: 1 })
		await revealForRename(URI, undefined)
		await revealForRename(URI, null)
		await revealForRename(URI, { line: 1 })

		expect(stub.shownDocuments).toEqual([])
		expect(stub.executedCommands).toEqual([])
	})
})
