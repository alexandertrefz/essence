import type { common, parser } from "@essence-lang/interfaces"

// NOTE: A `focused` test silences every other test of the run, which is exactly
// what it is for while somebody is iterating and exactly what must not be left
// behind. The command line refuses a plain run that still holds one; an Editor
// can not refuse anything, so it says so where the word is written — a warning
// on the Modifier itself, with the one edit that answers it.
//
// NOTE: Per file and per parse, unlike the tag Diagnostics next door: whether a
// test is focused is something its own source says, and no other file can
// change the answer.

// NOTE: A `focused` that is also `skipped` narrows nothing — the test does not
// run either way — and is not what has to go. The command line reads it the
// same way.
function isSkipped(modifiers: Array<parser.TestModifierNode>): boolean {
	return modifiers.some((modifier) => modifier.name.content === "skipped")
}

function focusOf(
	modifiers: Array<parser.TestModifierNode>,
): parser.TestModifierNode | null {
	if (isSkipped(modifiers)) {
		return null
	}

	return (
		modifiers.find((modifier) => modifier.name.content === "focused") ??
		null
	)
}

function focusDiagnostic(
	modifier: parser.TestModifierNode,
	item: "test" | "suite",
): common.Diagnostic {
	return {
		severity: "warning",
		message: `This ${item} is still focused`,
		position: modifier.name.position,
		code: "focused-tests-remain",
		labels: [
			{
				position: modifier.name.position,
				message: "only focused tests run",
				kind: "primary",
			},
		],
		notes: [
			"A focused test silences every other test of the run, so a run " +
				"nobody narrowed has not answered the question it was asked.",
		],
		helps: [
			"Remove `focused` before this lands, or narrow the run with " +
				"--filter or --tag while you are iterating.",
		],
	}
}

// NOTE: Every `focused` written in one file's tests section, in source order.
export function focusDiagnostics(
	program: parser.Program,
): Array<common.Diagnostic> {
	let diagnostics: Array<common.Diagnostic> = []

	let walk = (nodes: Array<parser.TestsNode>): void => {
		for (let node of nodes) {
			if (node.nodeType !== "Test" && node.nodeType !== "Suite") {
				continue
			}

			let focused = focusOf(node.modifiers)

			if (focused !== null) {
				diagnostics.push(
					focusDiagnostic(
						focused,
						node.nodeType === "Test" ? "test" : "suite",
					),
				)
			}

			if (node.nodeType === "Suite") {
				walk(node.nodes)
			}
		}
	}

	walk(program.tests?.nodes ?? [])

	return diagnostics
}
