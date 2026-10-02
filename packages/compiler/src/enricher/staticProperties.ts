import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	containsErrors,
	report,
} from "../diagnostics/index"
import { findTypedChild, type TypedNode } from "../visitor/index"
import { enrichExpression } from "./enrichers"
import { resolveType } from "./resolvers"

// The Scopes whose hoist made no progress in its last round. See "Static
// Properties while hoisting" in DEVELOPMENT.md.
const settling = new WeakSet<enricher.Scope>()

// The Properties a settling hoist typed by their annotations, keyed by the
// Property map of their Namespace's Type.
const settled = new WeakMap<Record<string, common.Type>, Set<string>>()

// Whether the hoist stops, after a round that made no progress. The first such
// round is followed by one that settles, the second ends the hoist.
export function hoistStalls(
	units: ReadonlyArray<{ scope: enricher.Scope }>,
	stuck: boolean,
): boolean {
	let settles = units.some((unit) => settling.has(unit.scope))

	for (let unit of units) {
		if (stuck && !settles) {
			settling.add(unit.scope)
		} else {
			settling.delete(unit.scope)
		}
	}

	return stuck && settles
}

// Types each bodied static Property of a Namespace by its value. While a
// hoist settles, a Property whose value does not resolve yet takes its
// annotation, since the value may read a Constant, which never hoists.
export function typeBodiedProperties(
	node: parser.NamespaceDefinitionStatementNode,
	properties: Record<string, common.Type>,
	selfScope: enricher.Scope,
	scope: enricher.Scope,
	hoisting: boolean,
): void {
	for (let [memberKey, memberValue] of Object.entries(node.properties)) {
		let value = memberValue.value

		if (value === null) {
			continue
		}

		// Enriching an Expression declares nothing, so this is safe while
		// hoisting.
		let { result, diagnostics } = collectDiagnostics(() =>
			enrichExpression(value, selfScope),
		)

		if (
			hoisting &&
			memberValue.type !== null &&
			settling.has(scope) &&
			containsErrors(diagnostics)
		) {
			properties[memberKey] = resolveType(memberValue.type, scope)
			settle(properties, memberKey)

			continue
		}

		diagnostics.forEach(report)
		properties[memberKey] = result.type

		// A Type read off a settled Property is the annotation's, so the
		// Property reading it is settled again with it.
		if (hoisting && readsSettled(result)) {
			settle(properties, memberKey)
		}
	}
}

function settle(
	properties: Record<string, common.Type>,
	memberKey: string,
): void {
	settled.set(
		properties,
		(settled.get(properties) ?? new Set()).add(memberKey),
	)
}

function readsSettled(value: common.typed.ExpressionNode): boolean {
	let reads = (node: TypedNode): true | undefined =>
		(node.nodeType === "Lookup" &&
			node.base.type.type === "Namespace" &&
			settled.get(node.base.type.properties)?.has(node.member.content)) ||
		findTypedChild(node, reads)

	return reads(value) === true
}

// Gives a settled Property its value's Type once the value is enriched in
// place. Code below the Namespace then reads it as it would have, had the
// Namespace never hoisted.
export function settleProperty(
	properties: Record<string, common.Type>,
	memberKey: string,
	valueType: common.Type,
): void {
	if (settled.get(properties)?.has(memberKey) === true) {
		properties[memberKey] = valueType
	}
}
