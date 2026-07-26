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

// NOTE: `warning` carries an `unsafe` refusal's message — the formatter found
// its own output wanting and kept the file as it was, which is a bug in esfmt
// and worth saying out loud. A syntax refusal stays silent: it is most
// keystrokes and every format-on-save of a file caught mid-edit, and the
// Diagnostics already say what is wrong.
export type FormattingResult = {
	edits: Array<FormattingEdit> | null
	warning: string | null
}

// NOTE: In the 0-based line/character the protocol counts in — which is not
// the compiler's 1-based Cursor, and not a byte offset either, since neither
// the protocol nor the compiler has one.
function positionAt(
	source: string,
	offset: number,
): { line: number; character: number } {
	let line = 0
	let lineStart = 0

	for (let index = 0; index < offset; index++) {
		if (source[index] === "\n") {
			line++
			lineStart = index + 1
		}
	}

	return { line, character: offset - lineStart }
}

// NOTE: One edit covering the changed middle of the document — the untouched
// lead and tail are pared off by common prefix and suffix, so a format-on-save
// that fixes one line does not replace the whole buffer under the cursor. Any
// finer diff would be invented after the fact rather than produced by the
// work, so a single contiguous span is as honest as it gets.
function narrowedEdit(source: string, formatted: string): FormattingEdit {
	let limit = Math.min(source.length, formatted.length)
	let prefix = 0

	while (prefix < limit && source[prefix] === formatted[prefix]) {
		prefix++
	}

	// NOTE: The suffix must not reach back into the prefix — when one text is
	// a substring of the other, the same characters would otherwise be counted
	// from both ends.
	let suffix = 0

	while (
		suffix < limit - prefix &&
		source[source.length - 1 - suffix] ===
			formatted[formatted.length - 1 - suffix]
	) {
		suffix++
	}

	return {
		range: {
			start: positionAt(source, prefix),
			end: positionAt(source, source.length - suffix),
		},
		newText: formatted.slice(prefix, formatted.length - suffix),
	}
}

// NOTE: `edits` is `null` both while the document does not parse and when it
// is already formatted, so that an editor's format-on-save neither reports a
// failed request nor marks a clean buffer dirty.
//
// `formatter` is a test seam: an `unsafe` refusal is by definition a formatter
// bug, so no real source can produce one on demand.
export function findFormattingEdits(
	source: string,
	documentPath?: string,
	formatter: typeof format = format,
): FormattingResult {
	let result = formatter(source, { documentPath })

	if (result.refusal !== null) {
		return {
			edits: null,
			warning:
				result.refusal.kind === "unsafe"
					? result.refusal.message
					: null,
		}
	}

	if (!result.changed) {
		return { edits: null, warning: null }
	}

	return { edits: [narrowedEdit(source, result.text)], warning: null }
}
