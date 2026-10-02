import {
	findParserChild,
	type ParserNode,
} from "@essence-lang/compiler/visitor"
import type { common, parser } from "@essence-lang/interfaces"

import { isSamePosition } from "../positions"
import { programBodies } from "../sections"
import { isWordBounded, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"

type TypeMember = Extract<parser.PatternMemberNode, { kind: "Type" }>

// A misspelled member a Pattern binds under its own name, as `{ kye }` binds
// `kye`. The fix names the member and keeps the binding the body reads, as
// `{ key as kye }`. Null where the misspelling is no such member, and nothing
// where no rewrite is safe, since renaming alone unbinds the body's reads.
export function patternMemberSpellingActions(
	diagnostic: common.Diagnostic & { position: common.Position },
	program: parser.Program,
	lines: Array<string>,
): Array<CodeActionEntry> | null {
	if (diagnostic.data?.kind !== "suggestion") {
		return null
	}

	let found = memberNamedAt(program, diagnostic.position)

	if (found === null) {
		return null
	}

	let { pattern, member } = found
	let { suggestion } = diagnostic.data
	let name = member.name.content

	// A member the Pattern names already would be taken apart twice.
	if (
		Object.hasOwn(pattern.members, suggestion) ||
		sliceOf(lines, member.name.position) !== name ||
		!isWordBounded(lines, member.name.position)
	) {
		return []
	}

	// An annotated member takes its binder after the Type.
	let edits =
		member.type === null
			? [
					{
						range: member.name.position,
						newText: `${suggestion} as ${name}`,
					},
				]
			: [
					{ range: member.name.position, newText: suggestion },
					{
						range: {
							start: member.type.position.end,
							end: member.type.position.end,
						},
						newText: ` as ${name}`,
					},
				]

	return [
		{
			title: `Change to '${suggestion} as ${name}'`,
			kind: "quickfix",
			diagnosticCode: diagnostic.code,
			diagnosticPosition: diagnostic.position,
			isPreferred: true,
			edits,
		},
	]
}

// The Pattern member that binds under its own name and is named at the
// span, at any depth of any body.
function memberNamedAt(
	program: parser.Program,
	position: common.Position,
): { pattern: parser.PatternNode; member: TypeMember } | null {
	let visit = (
		node: ParserNode,
	): { pattern: parser.PatternNode; member: TypeMember } | undefined => {
		if (node.nodeType === "Pattern") {
			for (let member of Object.values(node.members)) {
				if (
					member.kind === "Type" &&
					member.binder === null &&
					isSamePosition(member.name.position, position)
				) {
					return { pattern: node, member }
				}
			}
		}

		return findParserChild(node, visit)
	}

	for (let body of programBodies(program)) {
		for (let node of body) {
			let found = visit(node)

			if (found !== undefined) {
				return found
			}
		}
	}

	return null
}
