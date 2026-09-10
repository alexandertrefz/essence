import * as vscode from "vscode"

// NOTE: The one gesture a Code Action can not make with edits. An extraction
// has to call the thing it lifted out SOMETHING, and the name it derives —
// `total`, `extracted` — is a placeholder the reader is meant to replace; the
// way to say so is to put the cursor on it and open rename. No workspace edit
// moves a cursor, so the Server asks for this by hand instead: the action
// carries `essence.renameAt` with the URI and the Position the new name will
// stand at once the edits have landed.
//
// The Position is the protocol's — zero based on both axes — because the
// Server computed it, and every other Position it sends is one of those too.
export async function revealForRename(uriString, position) {
	if (
		typeof uriString !== "string" ||
		position === null ||
		typeof position !== "object" ||
		typeof position.line !== "number" ||
		typeof position.character !== "number"
	) {
		return
	}

	let cursor = new vscode.Position(position.line, position.character)

	// NOTE: The selection is handed to `showTextDocument` rather than written
	// onto an editor afterwards, because the document need not be open at all —
	// an action that edits a second file is a shape this Server already has —
	// and opening it AT the name is one scroll rather than two. It also focuses
	// the editor, which `editor.action.rename` needs: rename acts on whatever
	// is active, not on whatever was handed a selection.
	await vscode.window.showTextDocument(vscode.Uri.parse(uriString), {
		selection: new vscode.Range(cursor, cursor),
	})

	await vscode.commands.executeCommand("editor.action.rename")
}
