import type { common } from "@essence-lang/interfaces"

import { derivedEquatableNamespaceName } from "../../enricher/resolvers"
import { runtimeNamespaceNames } from "../../rewriter/runtimeNamespaces"
import type { OptimiserPass } from "../index"
import { rewriteExpressions } from "../walk"

// NOTE: A constant written in a Program is BUILT at every site it is written
// at, and built again on every turn of whatever loop reaches it. `1` is
// `Integer.createInteger(1n)` — an object, a bigint and a call, per turn;
// `"{value}"` builds `{ toString: Integer.toString }` before it renders
// anything; a Match's Record Matcher rebuilds `{ type: "Record", members: … }`
// to hand to the check, per test, per turn. None of them can differ from one
// evaluation to the next, so each is built ONCE, in a band of consts, and read
// by name ever after.
//
// NOTE: It rests on exactly what the interning in the runtime rests on: every
// Essence value is immutable, and the language has no operator asking whether
// two values are the SAME value — only whether they are EQUAL. So one shared
// value is indistinguishable from twenty equal ones, and a value built before
// the Program's first Statement is indistinguishable from one built where it
// was written. What is NOT indistinguishable is a value whose construction can
// FAIL or observe something, and nothing here can: a literal, a Case with no
// payload, a descriptor and a method map are all data.
//
// NOTE: Booleans are deliberately absent. There are exactly two Boolean objects
// in a running Program already — `interned-booleans`, in the runtime — so
// pooling one would name what it already has.

export const poolConstants: OptimiserPass = {
	name: "pool-constants",
	run: (program) => {
		// NOTE: A Namespace a Program DECLARES is a `class` in the emitted
		// Module, and a class is not hoisted — so a const band above it can not
		// read one. The witnesses below name a Namespace, so this is what they
		// are checked against, and a Namespace name a Program declares is
		// refused whether the name is the Program's own or one it took from the
		// standard library.
		let declared = declaredNamespaceNames(program)

		return rewriteExpressions(program, (node) => pool(node, declared))
	},
}

function pool(
	node: common.typedSimple.ExpressionNode,
	declaredNamespaces: ReadonlySet<string>,
): common.typedSimple.ExpressionNode {
	let key = poolKeyOf(node, declaredNamespaces)

	if (key === null) {
		return node
	}

	// NOTE: The Position rides on the REFERENCE rather than on the constant.
	// What a debugger should stop on is the place the value is read, which is
	// where the Program says it; the band is machinery no source was written
	// for.
	return {
		nodeType: "Intrinsic",
		kind: "pooled-reference",
		key,
		value: node,
		type: node.type,
		position: node.position,
	}
}

// NOTE: What makes two constants ONE — a spelling of the value that is equal
// exactly when the emitted JavaScript would be. Positions are left out on
// purpose: `1` written on two lines is one constant, and the reference each
// site holds keeps its own Position.
//
// NOTE: `null` for everything else, which is the whole gate. A Node kind that
// is not named here is not pooled, so a shape added to `typedSimple` later is
// left alone rather than silently hoisted out of the order it was written in.
function poolKeyOf(
	node: common.typedSimple.ExpressionNode,
	declaredNamespaces: ReadonlySet<string>,
): string | null {
	switch (node.nodeType) {
		case "IntegerValue":
			return `integer:${node.value}`
		case "StringValue":
			return `string:${node.value}`
		case "RationalValue":
			// NOTE: The parts AS WRITTEN. A Rational stores what it was given
			// and reduces only what it answers with, so `4/2` and `2/1` are two
			// constants — equal as values, and not the same stored parts.
			return `rational:${node.numerator}/${node.denominator}`
		// NOTE: A Case with no payload is one shared instance per tag already,
		// handed out by `createCase` from a Map — so what a pooled const saves
		// is the call and the lookup, not the object.
		case "CaseValue":
			return node.value === null ? `case:${node.tag}` : null
		case "ConformanceValue":
			return conformanceKeyOf(node, declaredNamespaces)
		case "Intrinsic":
			// NOTE: A Type descriptor is DATA the runtime reads, and the same
			// Matcher written in three Handlers of one Match is one descriptor
			// — which is where this earns most, because that object was
			// rebuilt at every test of every turn.
			return node.kind === "type-descriptor"
				? `descriptor:${JSON.stringify(node.descriptor)}`
				: null
		default:
			return null
	}
}

// NOTE: A conformance witness is a method map — `{ compare: Integer.compare }`
// — built fresh at every site that needs one, which for an interpolated String
// is once per hole per evaluation. It holds no Expression the Program computes:
// each member is a reference to a Method, and a conditional conformance's
// `boundConformance(<map>, [<witnesses>])` only curries those references onto
// each other. So the whole of it is a constant, PROVIDED every name it reads is
// one the band can read.
//
// NOTE: Which is what the two refusals below are about. A `parameter`-sourced
// condition is not a constant at all — it is the enclosing Function's own
// conformance Argument, a different value per call — and the Simplifier leaves
// it as an Identifier, so a witness carrying one stays where it was written.
// And a Namespace the Program declares is a `class` in the emitted Module,
// which is not hoisted: a const above it reading one is a `ReferenceError` at
// import. Every other Namespace a witness can name is either a runtime Module,
// bound by an `import * as` before any Statement runs, or the fabricated
// Namespace a Choice's derived equality names, which is emitted as a read off
// the runtime helpers.
function conformanceKeyOf(
	node: common.typedSimple.ConformanceValueNode,
	declaredNamespaces: ReadonlySet<string>,
): string | null {
	if (!isPoolableConformance(node, declaredNamespaces)) {
		return null
	}

	return `conformance:${JSON.stringify(conformanceShapeOf(node))}`
}

function isPoolableConformance(
	node: common.typedSimple.ConformanceValueNode,
	declaredNamespaces: ReadonlySet<string>,
): boolean {
	if (
		node.namespaceName !== derivedEquatableNamespaceName &&
		!runtimeNamespaces.has(node.namespaceName)
	) {
		return false
	}

	if (declaredNamespaces.has(node.namespaceName)) {
		return false
	}

	return node.conditions.every(
		(condition) =>
			condition.nodeType === "ConformanceValue" &&
			isPoolableConformance(condition, declaredNamespaces),
	)
}

// NOTE: Everything about a witness that reaches the emitted JavaScript, and
// nothing else — the Namespace, the map, the plan a generic Choice's equality
// follows, and the conditions curried onto it, each read the same way. The
// witness's `type` is left out: it is what the Compiler called the conformance,
// and two witnesses spelled alike emit alike whatever it says.
function conformanceShapeOf(
	node: common.typedSimple.ConformanceValueNode,
): unknown {
	return {
		namespace: node.namespaceName,
		methods: node.methodMap,
		descriptor: node.derivedDescriptor ?? null,
		conditions: node.conditions.map((condition) =>
			condition.nodeType === "ConformanceValue"
				? conformanceShapeOf(condition)
				: null,
		),
	}
}

const runtimeNamespaces = new Set<string>(runtimeNamespaceNames)

// NOTE: Every Namespace the Program declares, wherever it declares one — the
// top level, a Function body, a Method body. A nested one is emitted inside its
// block, so it is even further out of the band's reach than a top-level one.
function declaredNamespaceNames(
	program: common.typedSimple.Program,
): ReadonlySet<string> {
	let names = new Set<string>()

	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let entry of value) {
				visit(entry)
			}

			return
		}

		if (value === null || typeof value !== "object") {
			return
		}

		let node = value as Record<string, unknown>

		if (node["nodeType"] === "NamespaceDefinitionStatement") {
			let name = node["name"] as Record<string, unknown> | undefined

			if (typeof name?.["name"] === "string") {
				names.add(name["name"])
			}
		}

		for (let entry of Object.values(node)) {
			visit(entry)
		}
	}

	visit(program.implementation.nodes)

	return names
}
