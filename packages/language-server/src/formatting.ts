import { format } from "@essence/formatter"

// NOTE: The shape the LSP wants back, kept structural so this module needs
// nothing from `vscode-languageserver` and can be tested on its own.
export type FormattingEdit = {
	range: {
		start: { line: number; character: number }
		end: { line: number; character: number }
	}
	newText: string
}

// NOTE: The very end of the text, in the 0-based line/character the protocol
// counts in — which is not the compiler's 1-based Cursor, and not a byte offset
// either, since neither the protocol nor the compiler has one.
function endOf(source: string): { line: number; character: number } {
	let lines = source.split("\n")

	return {
		line: lines.length - 1,
		character: (lines[lines.length - 1] as string).length,
	}
}

// NOTE: One edit spanning the whole document, or none at all. Document sync is
// Full, so the source here is the entire current buffer anyway, and a formatter
// that re-lays a file out has no smaller unit to offer — a finer diff would be
// invented after the fact rather than produced by the work.
//
// `null` when the document does not parse, which is most keystrokes and every
// format-on-save of a file caught mid-edit. The Diagnostics already say what is
// wrong, and saying it again as a failed formatting request would only be
// noise. `null` too when the file is already formatted, so that an editor's
// format-on-save does not mark a clean buffer dirty.
export function findFormattingEdits(
	source: string,
	documentPath?: string,
): Array<FormattingEdit> | null {
	let result = format(source, { documentPath })

	if (result.refusal !== null || !result.changed) {
		return null
	}

	return [
		{
			range: {
				start: { line: 0, character: 0 },
				end: endOf(source),
			},
			newText: result.text,
		},
	]
}
