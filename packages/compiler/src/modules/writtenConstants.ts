import type { common, enricher, parser } from "@essence-lang/interfaces"

import { collectDiagnostics, containsErrors } from "../diagnostics/index"
import {
	findTypeInScope,
	referencedTypeNames,
	resolveType,
} from "../enricher/resolvers"
import { typeContainsError } from "../helpers/types"

// The top-level Constant whose name is written at `position`, or null where a
// Pattern or another kind of declaration holds that name.
export function constantStatementAt(
	program: parser.Program,
	position: common.Position,
): parser.ConstantDeclarationStatementNode | null {
	for (let node of program.implementation.nodes) {
		if (
			node.nodeType === "ConstantDeclarationStatement" &&
			node.name.position === position
		) {
			return node
		}
	}

	return null
}

// Reads into `into` the written Type of each Constant it lacks, once the
// annotation resolves in the Module's top-level `scope`. Once the hoist is
// over (`final`) one that does not resolve is read as an Error, which its
// Module reports. Answers whether any was read.
// See "Constants across a cycle" in DEVELOPMENT.md.
export function readWrittenConstantTypes(
	statements: Iterable<parser.ConstantDeclarationStatementNode>,
	scope: enricher.Scope,
	into: Map<string, common.Type>,
	final: boolean,
): boolean {
	let read = false

	for (let node of statements) {
		let annotation = node.type

		if (
			annotation === null ||
			node.name.nodeType !== "Identifier" ||
			into.has(node.name.content)
		) {
			continue
		}

		let type = writtenType(annotation, scope)

		if (type === "throws" || (type === null && !final)) {
			continue
		}

		into.set(node.name.content, type ?? { type: "Error" })
		read = true
	}

	return read
}

// The annotation's Type, or null where it resolves with an Error. A name not
// in Scope yet answers null without resolving, since spelling its
// `unknown-type` remedy is costly. A throw leaves the Constant to wait for its
// Statement.
function writtenType(
	annotation: parser.TypeDeclarationNode,
	scope: enricher.Scope,
): common.Type | null | "throws" {
	if (
		referencedTypeNames(annotation).some(
			(name) => findTypeInScope(name.content, scope) === null,
		)
	) {
		return null
	}

	try {
		let { result, diagnostics } = collectDiagnostics(() =>
			resolveType(annotation, scope),
		)

		return containsErrors(diagnostics) || typeContainsError(result)
			? null
			: result
	} catch {
		return "throws"
	}
}
