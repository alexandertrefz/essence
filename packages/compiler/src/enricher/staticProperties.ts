import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	containsErrors,
	report,
} from "../diagnostics/index"
import {
	NotHoistedYet,
	typeContainsError,
	typeContainsUnknown,
} from "../helpers/types"
import {
	recordFailedRead,
	recordUntypedProperty,
	type UntypedProperty,
	type UntypedReadCause,
	untypedPropertyOf,
} from "../helpers/untypedProperties"
import { findTypedChild, type TypedNode } from "../visitor/index"
import { enrichExpression } from "./enrichers"
import { resolveType } from "./resolvers"
import { modulePathOf } from "./scope"

// The Scopes whose hoist made no progress in its last round, each with the
// Modules hoisted with it. See "Static Properties while hoisting" in
// DEVELOPMENT.md.
const settling = new WeakMap<enricher.Scope, ReadonlySet<string | null>>()

// The Properties a settling hoist typed by their annotations or left untyped,
// keyed by the Property map of their Namespace's Type.
const settled = new WeakMap<Record<string, common.Type>, Set<string>>()

// How many Property values are being typed while hoisting. A read there that
// can not type an untyped Property throws, so the value waits.
let hoistingValues = 0

class UntypedPropertyPending extends NotHoistedYet {}

// Whether the hoist stops, after a round that made no progress. The first such
// round is followed by one that settles, the second ends the hoist.
export function hoistStalls(
	units: ReadonlyArray<{ scope: enricher.Scope }>,
	stuck: boolean,
): boolean {
	let settles = units.some((unit) => settling.has(unit.scope))
	let group = new Set(units.map((unit) => modulePathOf(unit.scope)))

	for (let unit of units) {
		if (stuck && !settles) {
			settling.set(unit.scope, group)
		} else {
			settling.delete(unit.scope)
		}
	}

	return stuck && settles
}

// Types each bodied static Property of a Namespace by its value. While a
// hoist settles, a Property whose value does not resolve yet takes its
// annotation, since the value may read a Constant, which never hoists. One
// without an annotation is left untyped until it is read.
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

		let { result, diagnostics } = enrichValue(value, selfScope, hoisting)
		let group = settling.get(scope)
		// A value that reads an Error unreported counts as unresolved too, or
		// code above the Namespace would read that Error.
		let unresolved =
			result === null ||
			containsErrors(diagnostics) ||
			(hoisting && typeContainsError(result.type))

		if (hoisting && group !== undefined && unresolved) {
			if (memberValue.type === null) {
				properties[memberKey] = { type: "Error" }
				recordUntypedProperty(properties, {
					namespaceName: node.name.content,
					memberName: memberKey,
					value,
					selfScope,
					name: memberValue.name.position,
					modulePath: modulePathOf(scope),
					group,
					typing: false,
					typedOnRead: null,
					settledType: null,
					failsWhereWritten: false,
					failures: new WeakMap(),
				})
			} else {
				properties[memberKey] = resolveType(memberValue.type, scope)
			}

			settle(properties, memberKey)

			continue
		}

		if (result === null || (unresolved && !containsErrors(diagnostics))) {
			throw new UntypedPropertyPending(
				`Property '${node.name.content}.${memberKey}' reads one not typed yet`,
			)
		}

		diagnostics.forEach(report)
		properties[memberKey] = result.type

		// A Type read off a settled Property may be the annotation's, so the
		// Property reading it is settled again with it.
		if (hoisting && readsSettled(result)) {
			settle(properties, memberKey)
		}
	}
}

// Enriching an Expression declares nothing, so this is safe while hoisting.
// The value is null where it read an untyped Property that can not be typed.
function enrichValue(
	value: parser.ExpressionNode,
	selfScope: enricher.Scope,
	hoisting: boolean,
): {
	result: common.typed.ExpressionNode | null
	diagnostics: Array<common.Diagnostic>
} {
	if (!hoisting) {
		return collectDiagnostics(() => enrichExpression(value, selfScope))
	}

	hoistingValues += 1

	try {
		return collectDiagnostics(() => enrichExpression(value, selfScope))
	} catch (error) {
		if (error instanceof UntypedPropertyPending) {
			return { result: null, diagnostics: [] }
		}

		throw error
	} finally {
		hoistingValues -= 1
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
	namespace: common.NamespaceType,
	memberKey: string,
	value: common.typed.ExpressionNode,
): void {
	if (settled.get(namespace.properties)?.has(memberKey) === true) {
		namespace.properties[memberKey] = value.type
	}

	let property = untypedPropertyOf(namespace, memberKey)

	if (property !== undefined) {
		property.settledType = value.type
		property.failsWhereWritten = holdsError(value)
	}
}

// Whether any part of a value is typed as an Error, which its own report or
// the validator's accounts for.
function holdsError(value: common.typed.ExpressionNode): boolean {
	let found = (node: TypedNode): true | undefined =>
		("type" in node &&
			typeof node.type === "object" &&
			node.type !== null &&
			"type" in node.type &&
			node.type.type === "Error") ||
		findTypedChild(node, found)

	return found(value) === true
}

// The Type of a member read off a Namespace, or null where it declares none.
// A read that can not type an untyped Property answers an Error, which the
// validator reports. See "Static Properties while hoisting" in DEVELOPMENT.md.
export function namespaceMemberType(
	namespace: common.NamespaceType,
	memberName: string,
	positions: { member: common.Position },
	scope: enricher.Scope | null,
): common.Type | null {
	if (!Object.hasOwn(namespace.properties, memberName)) {
		return Object.hasOwn(namespace.methods, memberName)
			? namespace.methods[memberName]
			: null
	}

	let property = untypedPropertyOf(namespace, memberName)

	if (property === undefined) {
		return namespace.properties[memberName]
	}

	let reader = scope === null ? property.modulePath : modulePathOf(scope)
	let answer: common.Type | UntypedReadCause =
		reader !== property.modulePath && property.group.has(reader)
			? "cycle"
			: (property.settledType ??
				property.typedOnRead ??
				typeOnRead(property))

	if (typeof answer !== "string") {
		return answer
	}

	if (hoistingValues > 0) {
		throw new UntypedPropertyPending(
			`Property '${property.namespaceName}.${memberName}' is not typed yet`,
		)
	}

	nestedCauses?.add(answer)

	// `provided-method-out-of-reach` refuses the Namespace's name there.
	if (!inProvidedMethod(scope)) {
		recordFailedRead(property, positions.member, answer)
	}

	return { type: "Error" }
}

// Whether the read stands in a provided Method a Program declares, which may
// name nothing the Program declares.
function inProvidedMethod(scope: enricher.Scope | null): boolean {
	let provided = false
	let program = false

	for (let current = scope; current !== null; current = current.parent) {
		provided ||= current.providedMethodOf !== undefined
		program ||= current.preludeNames !== undefined
	}

	return provided && program
}

// The causes of the reads that failed inside the value `typeOnRead` is typing,
// so a value failing through another Property keeps its root cause.
let nestedCauses: Set<UntypedReadCause> | null = null

// The value's Type as the Scope it was written in now stands, or why it can
// not be typed there. A value that reads itself back is not typed.
function typeOnRead(property: UntypedProperty): common.Type | UntypedReadCause {
	if (property.typing) {
		return "other"
	}

	property.typing = true

	let outer = nestedCauses
	let nested = new Set<UntypedReadCause>()

	nestedCauses = nested

	try {
		let { result, diagnostics } = collectDiagnostics(() =>
			enrichExpression(property.value, property.selfScope),
		)

		if (
			containsErrors(diagnostics) ||
			result.type.type === "Error" ||
			nested.size > 0
		) {
			return onlyUndeclared(diagnostics, nested) ? "undeclared" : "other"
		}

		if (typeContainsUnknown(result.type)) {
			return "undecided"
		}

		property.typedOnRead = result.type

		return result.type
	} finally {
		nestedCauses = outer
		property.typing = false
	}
}

// Whether a value failed only on names not declared where it was typed, its
// own or those of the Properties it read.
function onlyUndeclared(
	diagnostics: Array<common.Diagnostic>,
	nested: ReadonlySet<UntypedReadCause>,
): boolean {
	let errors = diagnostics.filter(
		(diagnostic) => diagnostic.severity === "error",
	)

	return (
		errors.every((diagnostic) => diagnostic.code === "unknown-name") &&
		[...nested].every((cause) => cause === "undeclared") &&
		errors.length + nested.size > 0
	)
}
