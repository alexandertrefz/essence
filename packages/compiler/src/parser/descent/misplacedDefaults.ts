import type { common } from "@essence-lang/interfaces"

import { primary, reportError } from "../../diagnostics/index"

// Where a Parameter default can not be relied on. A provided Method has a
// body, but a conforming Namespace may replace it, and its replacement answers
// bound calls without the default.
export type MisplacedDefault =
	| "Function literal"
	| "Protocol requirement"
	| "provided Method"

export function reportMisplacedDefault(
	position: common.Position,
	place: MisplacedDefault,
): void {
	let label = primary(position, "this default")

	if (place === "Function literal") {
		reportError("A Function literal can not carry a default", position, {
			code: "default-on-function-literal",
			labels: [label],
			notes: [
				"A Function literal is called through the Function Type it was written for, which fixes how many Arguments every call passes, so a default here could never be reached.",
				// A Note, since the Declaration the literal is passed to is
				// often not the reader's.
				"A default belongs to a named Function or Method, whose Parameter list is part of the Declaration a call is resolved against.",
			],
			// The edit the Quick Fix makes.
			helps: ["Remove the default."],
		})
	} else if (place === "provided Method") {
		reportError("A provided Method can not carry a default", position, {
			code: "default-on-protocol-method",
			labels: [label],
			notes: [
				"A conforming Namespace may replace a provided Method, and a call through a bound then runs the replacement, which a default here would not reach.",
			],
			helps: ["Remove the default, and pass the Argument at each call."],
		})
	} else {
		reportError(
			"A Protocol requirement can not carry a default",
			position,
			{
				code: "default-on-protocol-method",
				labels: [label],
				notes: [
					"A requirement says which calls a conforming Type must answer; a default is part of how one of them answers, which is each Namespace's own.",
				],
				helps: [
					"Declare the requirement without the default, and write the default on the fulfilling Method.",
				],
			},
		)
	}
}
