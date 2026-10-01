import type { common } from "@essence-lang/interfaces"

import { forEachSimpleChild, type SimpleNode } from "../visitor/typedSimple"

// The Namespaces a Program declares, and those it declares below its top
// level. Asked once per optimisation, since it walks the whole Program. See
// "Namespaces named after builtins" in DEVELOPMENT.md.

export type DeclaredNamespaces = {
	// Every Namespace the Program declares, wherever it declares one.
	all: ReadonlySet<string>
	// The ones a block declares, the only ones that can shadow a builtin.
	nested: ReadonlySet<string>
}

type Found = { all: Set<string>; nested: Set<string> }

export function declaredNamespaces(
	program: common.typedSimple.Program,
): DeclaredNamespaces {
	let found: Found = { all: new Set(), nested: new Set() }

	for (let node of program.implementation.nodes) {
		if (node.nodeType === "NamespaceDefinitionStatement") {
			found.all.add(node.name.name)

			// The Namespace stands at the top level, but what its members
			// declare is nested.
			forEachSimpleChild(node, collectNested, found)

			continue
		}

		collectNested(node, found)
	}

	// Everything a tests section declares is nested.
	if (program.tests !== null) {
		collectNested(program.tests, found)
	}

	return found
}

function collectNested(node: SimpleNode, found: Found): void {
	if (node.nodeType === "NamespaceDefinitionStatement") {
		found.all.add(node.name.name)
		found.nested.add(node.name.name)
	}

	forEachSimpleChild(node, collectNested, found)
}
