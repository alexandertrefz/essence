import { type common, lexer } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../../diagnostics/index"
import { describeToken } from "./tokenStream"

const TokenType = lexer.TokenType

const PROGRAM_NOTE =
	"A Program is one 'implementation { … }' block, framed by an optional 'import { … }' block above it and an optional 'tests { … }' and 'export { … }' block below it."

// The blocks a Program was read as, for the report about what follows them.
type Blocks = {
	// The last `import` or `export` block read below the implementation.
	lastSection: common.Position | null
	tests: common.Position | null
	// The implementation's `}`, null for a file of tests alone.
	implementation: common.Position | null
}

// Reports the Tokens left once every section has been read. See "Text after
// the Program" in DEVELOPMENT.md.
export function reportTrailingTokens(
	rest: Array<lexer.Token>,
	blocks: Blocks,
): void {
	let [token] = rest

	if (token === undefined) {
		return
	}

	let last = lastBlock(blocks)
	let message = `Unexpected ${describeToken(token)} after the end of the Program`
	let labels: [common.DiagnosticLabel, ...Array<common.DiagnosticLabel>] = [
		primary(token.position, "nothing may follow here"),
		secondary(last.position, `${last.name} ends here`),
	]

	// A stray `}` or `;`, or a lone Token, is what goes. An empty
	// `essence-spelling` asks the Quick Fix to delete the span.
	if (rest.length === 1 || isStray(token)) {
		reportError(message, token.position, {
			code: "unexpected-token",
			labels,
			notes: [PROGRAM_NOTE],
			helps: [`Remove the ${describeToken(token)}.`],
			data: {
				kind: "essence-spelling",
				position: token.position,
				spelling: "",
			},
		})

		return
	}

	// The report stands on the `}` that ended the block early, since that is
	// the mistake and the edit.
	let surplus = last.brace === null ? null : surplusBrace(rest)

	if (last.brace !== null && surplus !== null) {
		reportError(`This '}' ends ${last.name} early`, last.brace, {
			code: "unexpected-token",
			labels: [
				primary(last.brace, `${last.name} ends here`),
				secondary(
					token.position,
					"so this stands after the end of the Program",
				),
				secondary(
					surplus.position,
					"and this '}' was written to close the block",
				),
			],
			notes: [
				"What follows the block closes one more '}' than it opens, so it was written inside the block.",
			],
			helps: ["Remove the '}'."],
			data: {
				kind: "essence-spelling",
				position: last.brace,
				spelling: "",
			},
		})

		return
	}

	// A file of tests alone has no implementation block, and its tests block
	// holds Statements too.
	let home = blocks.implementation === null ? "tests" : "implementation"

	reportError(message, token.position, {
		code: "unexpected-token",
		labels,
		notes: [PROGRAM_NOTE],
		helps: [
			`Move what follows into the '${home} { … }' block, or remove it.`,
		],
	})
}

// The block the Tokens follow, and its `}` where they follow it directly. A
// tests block written above the implementation is not the last one.
function lastBlock(blocks: Blocks): {
	position: common.Position
	name: string
	brace: common.Position | null
} {
	if (blocks.lastSection !== null) {
		return {
			position: blocks.lastSection,
			name: "the Program",
			brace: null,
		}
	}

	let tests = blocks.tests

	if (
		tests !== null &&
		(blocks.implementation === null ||
			isAfter(tests.end, blocks.implementation.end))
	) {
		return {
			position: tests,
			name: "the tests block",
			brace: {
				start: { line: tests.end.line, column: tests.end.column - 1 },
				end: tests.end,
			},
		}
	}

	let implementation = blocks.implementation as common.Position

	return {
		position: implementation,
		name: "the implementation block",
		brace: implementation,
	}
}

function isAfter(a: common.Cursor, b: common.Cursor): boolean {
	return a.line > b.line || (a.line === b.line && a.column > b.column)
}

function isStray(token: lexer.Token): boolean {
	return token.type === TokenType.SymbolRightBrace || token.value === ";"
}

// The one `}` the Tokens close without opening, which was written for the
// block before them. What follows it, such as an `export` block, has to
// balance, or the reading is wrong and the answer is null.
function surplusBrace(rest: Array<lexer.Token>): lexer.Token | null {
	let depth = 0
	let surplus: lexer.Token | null = null

	for (let token of rest) {
		if (token.type === TokenType.SymbolLeftBrace) {
			depth++
		} else if (token.type === TokenType.SymbolRightBrace) {
			depth--
		}

		if (depth < 0) {
			if (surplus !== null) {
				return null
			}

			surplus = token
			depth = 0
		}
	}

	return depth === 0 ? surplus : null
}
