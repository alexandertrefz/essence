import type { common, parser } from "@essence-lang/interfaces"

// A `focused` test silences the rest of the run. The command line refuses a
// plain run that holds one, so the Editor warns on the Modifier and offers to
// remove it. Per file, since only a test's own source can focus it.

// A `focused` that is also `skipped` narrows nothing, as on the command line.
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
		// Single quotes, as every Help spells a keyword: a Diagnostic is read in a
		// terminal too.
		helps: [
			"Remove 'focused' before this lands, or narrow the run with " +
				"'--filter' or '--tag' while you are iterating.",
		],
	}
}

// Every `focused` written in one file's tests section, in source order.
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
