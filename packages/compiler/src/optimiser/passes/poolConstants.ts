import type { common } from "@essence-lang/interfaces"

import {
	derivedEnumerableNamespaceName,
	derivedEquatableNamespaceName,
} from "../../enricher/resolvers"
import { withoutRecordNames } from "../../helpers/types"
import { runtimeNamespaceNames } from "../../rewriter/runtimeNamespaces"
import type { OptimiserPass } from "../index"
import type { DeclaredNamespaces } from "../namespaces"
import { rewriteExpressions } from "../walk"

// Builds each constant once, in a band of consts, rather than at every site on
// every evaluation. Immutable values without identity make that invisible. See
// "pool-constants" in DEVELOPMENT.md.

export const poolConstants: OptimiserPass = {
	name: "pool-constants",
	run: (program, namespaces) => {
		// `poolableNamespace` reads both sets.
		let declared = namespaces

		// A default runs per call, and every call is emitted after the band.
		return rewriteExpressions(program, (node) => pool(node, declared), {
			parameterDefaults: true,
		})
	},
}

function pool(
	node: common.typedSimple.ExpressionNode,
	declaredNamespaces: DeclaredNamespaces,
): common.typedSimple.ExpressionNode {
	let key = poolKeyOf(node, declaredNamespaces)

	if (key === null) {
		return node
	}

	// The reference keeps the Position, where a debugger should stop.
	return {
		nodeType: "Intrinsic",
		kind: "pooled-reference",
		key,
		value: node,
		type: node.type,
		position: node.position,
	}
}

// Equal exactly when the emitted JavaScript would be, Positions aside. Null
// for any kind not named here, which is never pooled.
function poolKeyOf(
	node: common.typedSimple.ExpressionNode,
	declaredNamespaces: DeclaredNamespaces,
): string | null {
	switch (node.nodeType) {
		case "IntegerValue":
			return `integer:${node.value}`
		case "StringValue":
			return `string:${node.value}`
		case "RationalValue":
			// The parts as written, since a Rational stores what it was given: `4/2` and
			// `2/1` are two constants.
			return `rational:${node.numerator}/${node.denominator}`
		// `createCase` already interns a unit Case, so this saves the call and lookup.
		case "CaseValue":
			return node.value === null ? `case:${node.tag}` : null
		case "ConformanceValue":
			return conformanceKeyOf(node, declaredNamespaces)
		case "Intrinsic":
			// Keyed by the Type the rewriter emits, without a Record's display name, so
			// one shape reached two ways is one constant.
			return node.kind === "type-descriptor"
				? `descriptor:${serializeKey(
						withoutRecordNames(node.descriptor),
					)}`
				: null
		default:
			return null
	}
}

// `JSON.stringify` that marks a back edge as `<cycle:N>`, N objects up. Only
// open objects are held, so a shared sub-object serializes fully each time.
function serializeKey(value: unknown, visiting: Array<object> = []): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null"
	}

	let backEdge = visiting.indexOf(value)

	if (backEdge !== -1) {
		return `<cycle:${visiting.length - backEdge}>`
	}

	visiting.push(value)

	try {
		if (Array.isArray(value)) {
			return `[${value
				.map((item) => serializeKey(item, visiting))
				.join(",")}]`
		}

		let entries = Object.entries(value)
			.filter(([, member]) => member !== undefined)
			.map(
				([key, member]) =>
					`${JSON.stringify(key)}:${serializeKey(member, visiting)}`,
			)

		return `{${entries.join(",")}}`
	} finally {
		visiting.pop()
	}
}

// A witness is a constant when every name it reads is one the band can read.
// The key and the refusals are one function, so a witness is never pooled
// under a key that misdescribes it.
function conformanceKeyOf(
	node: common.typedSimple.ConformanceValueNode,
	declaredNamespaces: DeclaredNamespaces,
): string | null {
	if (!poolableNamespace(node.namespaceName, declaredNamespaces)) {
		return null
	}

	let conditions = conditionKeysOf(node.conditions, declaredNamespaces)
	let groupConditions =
		node.groupConditions === undefined
			? undefined
			: conditionKeysOf(node.groupConditions, declaredNamespaces)

	if (conditions === null || groupConditions === null) {
		return null
	}

	let witnesses: Array<string> = []

	for (let witness of node.providedWitnesses ?? []) {
		let key = conformanceKeyOf(witness, declaredNamespaces)

		if (key === null) {
			return null
		}

		witnesses.push(key)
	}

	// Everything of the witness that reaches the emitted JavaScript.
	return `conformance:${serializeKey({
		namespace: node.namespaceName,
		methods: node.methodMap,
		provided: node.providedMethods ?? null,
		curried: node.curriedWith ?? null,
		witnesses,
		descriptor: node.derivedDescriptor ?? null,
		// Every derived listing and routed Record shares one Namespace and map, so
		// only these tell two Choices, or two Records, apart.
		cases: node.derivedCases ?? null,
		members: node.derivedMembers ?? null,
		conditions,
		groupConditions,
		shared: node.sharedConditions ?? null,
		indices: node.conditionIndices,
	})}`
}

// The key of every condition, or null where one can not be pooled.
function conditionKeysOf(
	conditions: Array<common.typedSimple.ExpressionNode>,
	declaredNamespaces: DeclaredNamespaces,
): Array<string> | null {
	let keys: Array<string> = []

	for (let condition of conditions) {
		let key = conditionKeyOf(condition, declaredNamespaces)

		if (key === null) {
			return null
		}

		keys.push(key)
	}

	return keys
}

// A poolable condition is already a `pooled-reference`, since the walk is
// bottom-up, and its key names the const it will be. An Identifier is a
// Parameter's witness, a different value per call.
function conditionKeyOf(
	condition: common.typedSimple.ExpressionNode,
	declaredNamespaces: DeclaredNamespaces,
): string | null {
	if (
		condition.nodeType === "Intrinsic" &&
		condition.kind === "pooled-reference"
	) {
		return condition.key
	}

	return condition.nodeType === "ConformanceValue"
		? conformanceKeyOf(condition, declaredNamespaces)
		: null
}

const runtimeNamespaces = new Set<string>(runtimeNamespaceNames)

// Whether the band can read the name a witness names. See "pool-constants" in
// DEVELOPMENT.md.
function poolableNamespace(
	name: string,
	declared: DeclaredNamespaces,
): boolean {
	if (declared.nested.has(name)) {
		return false
	}

	return (
		name === derivedEquatableNamespaceName ||
		name === derivedEnumerableNamespaceName ||
		runtimeNamespaces.has(name) ||
		declared.all.has(name)
	)
}
