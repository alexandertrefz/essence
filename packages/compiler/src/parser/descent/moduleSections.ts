import type { common, parser } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../../diagnostics/index"

// One `import { … }` or `export { … }` block as read, with the side of the
// implementation it stood on. A Diagnostic about the side points at the
// Keyword alone.
export type ModuleSectionRead = {
	node: parser.ImportSectionNode | parser.ExportSectionNode
	keywordPosition: common.Position
	side: "above" | "below"
}

// `placed` is the block of its kind on the right side, where one stands. The
// Program holds one block of a kind, so the entries move into that one.
export function reportMisplacedSection(
	section: ModuleSectionRead,
	implementationPosition: common.Position,
	placed: common.Position | null,
): void {
	let isImport = section.node.nodeType === "ImportSection"
	let keyword: "import" | "export" = isImport ? "import" : "export"
	let expectedSide = isImport ? "above" : "below"

	reportError(
		`The '${keyword} { … }' block belongs ${expectedSide} the implementation`,
		section.keywordPosition,
		{
			code: "misplaced-module-section",
			// The whole block's span for the Quick Fix that moves it, since
			// the Diagnostic underlines the Keyword.
			data: {
				kind: "section-order",
				section: keyword,
				block: section.node.position,
				into: placed,
			},
			labels: [
				primary(
					section.keywordPosition,
					`this block is written ${section.side} the implementation`,
				),
				secondary(
					implementationPosition,
					"the implementation block is here",
				),
			],
			notes: [
				"A Program reads top to bottom: what it imports, what it does, what it exports.",
			],
			helps: [
				placed === null
					? `Move the '${keyword} { … }' block ${expectedSide} 'implementation { … }'.`
					: `Move the entries of this '${keyword} { … }' block into the one ${expectedSide} 'implementation { … }'.`,
			],
		},
	)
}
