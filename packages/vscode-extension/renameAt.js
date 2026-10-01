import * as vscode from "vscode"

// An extraction names what it lifted out with a placeholder, then opens rename
// on it. No workspace edit moves a cursor, so the action carries
// `essence.renameAt` with the URI and the name's Position after the edits.
// The Position is the protocol's, zero-based on both axes.
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

	// `showTextDocument` opens the document if needed, at the name, and
	// focuses it, which `editor.action.rename` needs since it acts on the
	// active editor.
	await vscode.window.showTextDocument(vscode.Uri.parse(uriString), {
		selection: new vscode.Range(cursor, cursor),
	})

	await vscode.commands.executeCommand("editor.action.rename")
}
