import { format } from "@essence-lang/formatter"

// The shape LSP wants, kept structural so this module needs nothing from
// `vscode-languageserver`.
type FormattingEdit = {
	range: {
		start: { line: number; character: number }
		end: { line: number; character: number }
	}
	newText: string
}

// The message of an `unsafe` refusal, a formatter bug worth reporting. A
// syntax refusal stays silent: the Diagnostics already say what is wrong.
type FormattingResult = {
	edits: Array<FormattingEdit> | null
	warning: string | null
}

// In the protocol's 0-based line and character.
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

// One edit over the changed middle of the document, trimming the common
// prefix and suffix, so a one-line fix does not replace the whole buffer.
function narrowedEdit(source: string, formatted: string): FormattingEdit {
	let limit = Math.min(source.length, formatted.length)
	let prefix = 0

	while (prefix < limit && source[prefix] === formatted[prefix]) {
		prefix++
	}

	// The suffix must not overlap the prefix when one text contains the other.
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

// `edits` is null while the document does not parse and when it is formatted
// already, so format-on-save neither fails nor dirties a clean buffer.
// `formatter` lets a spec produce an `unsafe` refusal.
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
