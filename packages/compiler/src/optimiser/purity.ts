import type { common } from "@essence-lang/interfaces"

// Whether an Expression can be left unevaluated without the Program noticing.
// `true` means the compiler can name every reason it could matter, and none
// applies. `shadowed` is the Program's nested Namespaces, and is required. See
// "Purity" in DEVELOPMENT.md.

export function isPureExpression(
	node: common.typedSimple.ExpressionNode,
	shadowed: ReadonlySet<string>,
): boolean {
	let isPure = (child: common.typedSimple.ExpressionNode): boolean =>
		isPureExpression(child, shadowed)

	switch (node.nodeType) {
		// The leaves. No Essence value has a getter for a read to run.
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
		case "Identifier":
			return true
		// Building a closure runs none of its body.
		case "FunctionValue":
			return true
		// Every member the Type names is there, so a read can not fail.
		case "Lookup":
			return isPure(node.base)
		case "RecordValue":
			return Object.values(node.members).every(isPure)
		case "ListValue":
			return node.values.every(isPure)
		// Building a Dictionary compares keys through a witness, which runs nothing.
		case "DictionaryValue":
			return node.entries.every(
				(entry) => isPure(entry.key) && isPure(entry.value),
			)
		case "CaseValue":
			return node.value === null || isPure(node.value)
		case "Combination":
			return isPure(node.lhs) && isPure(node.rhs)
		// A witness is a method map of references, never calls.
		case "ConformanceValue":
			return (
				node.conditions.every(isPure) &&
				(node.groupConditions ?? []).every(isPure)
			)
		// A call. A Function value may be a native such as `loop` that runs its
		// callbacks, and a Union dispatch is a Method call.
		case "FunctionInvocation":
		case "UnionMethodInvocation":
			return false
		case "MethodInvocation":
			return isPureMethodInvocation(node, shadowed)
		// Each hole calls `toString`, weighed against the enumeration.
		case "InterpolatedStringValue":
			return node.segments.every((segment) =>
				isPureSegment(segment, shadowed),
			)
		// A Match runs Statement bodies, which this function does not read.
		case "Match":
			return false
		// A `define` holds only Expressions. Every Condition is weighed, including
		// those that never run.
		case "Define":
			return (
				node.arms.every(
					(arm) => isPure(arm.condition) && isPure(arm.value),
				) && isPure(node.otherwise)
			)
		// A trace writes into the test's trace buffer, which is its whole point.
		case "TestTrace":
			return false
		// A counter writes into the Module's coverage table.
		case "CoverageCounter":
			return false
		// A `start` runs the work it puts in flight.
		case "Start":
			return false
		// A `complete` observes every effect of the work it waits for.
		case "Complete":
			return false
		case "Intrinsic":
			return isPureIntrinsic(node, shadowed)
	}
}

// A hole is weighed as `a::toString()` written out would be. See "Holes and
// shadowed names" in DEVELOPMENT.md.
function isPureSegment(
	segment: common.typedSimple.InterpolationSegmentNode,
	shadowed: ReadonlySet<string>,
): boolean {
	if (segment.kind === "text") {
		return true
	}

	let namespaceName = printingNamespaceOf(segment.witness)

	if (namespaceName === null || shadowed.has(namespaceName)) {
		return false
	}

	if (segment.expression.type.type !== namespaceName) {
		return false
	}

	if (!(pureMethods[namespaceName]?.has("toString") ?? false)) {
		return false
	}

	return isPureExpression(segment.expression, shadowed)
}

// The Namespace whose `toString` a hole's witness names outright. That is the
// Namespace's own name, so `namespace Loud for Integer is Printable` answers
// `"Loud"`. A conditional conformance names nothing.
export function printingNamespaceOf(
	witness: common.typedSimple.ExpressionNode,
): string | null {
	if (witness.nodeType === "Intrinsic" && witness.kind === "direct-method") {
		if (witness.derivedDescriptor !== undefined) {
			return null
		}

		return withoutOverloadSuffix(witness.memberName) === "toString"
			? witness.namespaceName
			: null
	}

	if (witness.nodeType !== "ConformanceValue") {
		return null
	}

	if (witness.conditions.length !== 0 || witness.derivedDescriptor) {
		return null
	}

	// A Protocol-provided `toString` has no own entry, and a plain index would
	// answer `Object.prototype.toString`.
	let memberName = Object.hasOwn(witness.methodMap, "toString")
		? witness.methodMap["toString"]
		: undefined

	if (memberName === undefined) {
		return null
	}

	return withoutOverloadSuffix(memberName) === "toString"
		? witness.namespaceName
		: null
}

function isPureIntrinsic(
	node: common.typedSimple.IntrinsicNode,
	shadowed: ReadonlySet<string>,
): boolean {
	let isPure = (child: common.typedSimple.ExpressionNode): boolean =>
		isPureExpression(child, shadowed)

	switch (node.kind) {
		case "tag-test":
		case "essence-boolean":
		case "raw-boolean":
			return isPure(node.value)
		// The site holds a name. `pool-constants` asks a stricter question of the
		// value.
		case "pooled-reference":
			return true
		case "type-test":
			return isPure(node.value) && isPure(node.descriptor)
		// Data, a Function reference, and the literal `undefined`.
		case "type-descriptor":
		case "direct-method":
		case "omitted-argument":
			return true
		// A compiled dispatch is a Method call.
		case "dispatch-chain":
			return false
		// A loop runs Statement bodies, and may never end.
		case "inline-loop":
			return false
		case "raw-boolean-op":
			return (
				isPure(node.operand) &&
				(node.other === null || isPure(node.other))
			)
		case "raw-compare":
		case "raw-equals":
		case "raw-arithmetic":
			return isPure(node.left) && isPure(node.right)
		// The fallback counts though it may not run, since the question is whether
		// moving this observes anything.
		case "member-or-default":
			return isPure(node.base) && isPure(node.fallback)
		case "direct-record":
			return Object.values(node.members).every(isPure)
		case "direct-case":
			return (
				Object.values(node.members).every(isPure) &&
				(node.payload === null || isPure(node.payload))
			)
		case "direct-list":
			return node.values.every(isPure)
		// Only an inlined loop holds a build, and loops are refused, but the items
		// are weighed anyway.
		case "list-build":
			return node.additions.every((addition) => isPure(addition.value))
		case "spread-combination":
			return (
				isPure(node.lhs) &&
				Object.values(node.members).every(isPure) &&
				(node.rhs === null || isPure(node.rhs))
			)
	}
}

// The allowlist of pure Methods by Namespace. A call is pure only with every
// Argument of that Namespace's own Type. See "The enumeration" in
// DEVELOPMENT.md.
const pureMethods: Record<string, ReadonlySet<string>> = {
	Integer: new Set([
		"is",
		"isNot",
		"isLessThan",
		"isGreaterThan",
		"isLessThanOrEqualTo",
		"isGreaterThanOrEqualTo",
		"compare",
		"add",
		"subtract",
		"multiply",
		"negate",
		"absolute",
		"toString",
	]),
	Boolean: new Set([
		"is",
		"isNot",
		"and",
		"or",
		"negate",
		"exclusiveOr",
		"toString",
	]),
	String: new Set(["is", "isNot", "compare", "toString"]),
	Rational: new Set(["toString"]),
	// The refinements of `Integer`, where a written operand's arithmetic goes.
	// Each entry is `Integer`'s own operation under another name.
	NonZeroInteger: new Set(["multiply", "negate", "absolute"]),
	NonNegativeInteger: new Set(["add", "multiply"]),
	PositiveInteger: new Set(["add", "multiply"]),
}

// The Type a refined Namespace's Arguments carry, since refinements erase
// before the first pass.
const pureNamespaceTypes: Record<string, string> = {
	NonZeroInteger: "Integer",
	NonNegativeInteger: "Integer",
	PositiveInteger: "Integer",
}

function isPureMethodInvocation(
	node: common.typedSimple.MethodInvocationNode,
	shadowed: ReadonlySet<string>,
): boolean {
	// A name the Program declares below its top level is not the standard
	// library's. It is refused across the whole Program, since passes walk
	// Expressions, not Scopes.
	if (shadowed.has(node.base.name)) {
		return false
	}

	let members = pureMethods[node.base.name]

	if (members === undefined) {
		return false
	}

	if (!members.has(withoutOverloadSuffix(node.member.name))) {
		return false
	}

	let valueType = pureNamespaceTypes[node.base.name] ?? node.base.name

	return node.arguments.every(
		(argument) =>
			argument.value.type.type === valueType &&
			isPureExpression(argument.value, shadowed),
	)
}

// Every Overload of a listed Method is as pure as the others.
export function withoutOverloadSuffix(name: string): string {
	let suffix = name.indexOf("__overload$")

	return suffix === -1 ? name : name.slice(0, suffix)
}
