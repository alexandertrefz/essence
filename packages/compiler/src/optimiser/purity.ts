import type { common } from "@essence-lang/interfaces"

// NOTE: Whether an Expression can be left UNEVALUATED without the Program
// noticing. It is asked wherever a lowering would move an Expression out of the
// order Essence evaluates it in — `a::and(b)` evaluates `b` before the call and
// JavaScript's `&&` does not — and it is the one question in the Optimiser
// whose wrong answer is silent: an effect that stops happening leaves no
// Diagnostic and no crash, only a Program that prints less than it printed.
//
// NOTE: So it is conservative to the point of dullness. `true` means the
// Compiler can NAME every reason this Expression could matter and there is
// none; everything it can not name is `false`. A missing rule costs an
// optimisation, and a wrong one costs a `__print`.
//
// NOTE: What "matters" means, exactly, in the language as it stands:
//   - it PRINTS. `__print` is the only observable effect a Program has.
//   - it ASSIGNS. A variable assignment is the only mutation there is, and it
//     is an Expression here as well as a Statement.
//   - it DIVERGES or THROWS. Neither is an effect the language offers on
//     purpose — the throws are `noCaseMatched` and the descriptor's own
//     Compiler-bug guard — but a Program that stops running is telling its
//     author something, and skipping the call that would have stopped it is
//     not an optimisation. A Function call may reach any of the three, and
//     recursion may reach none of them and still never come back.
//
// NOTE: Which is why a CALL is impure unless it is one of the shapes named
// below. Everything else — a literal, a name, a member read, a value built out
// of pure parts — reaches nothing at all.

export function isPureExpression(
	node: common.typedSimple.ExpressionNode,
): boolean {
	switch (node.nodeType) {
		// NOTE: The leaves. A literal holds its own value; an Identifier is a
		// binding read, and no Essence value has a getter for the read to run.
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
		case "Identifier":
			return true
		// NOTE: A Function literal is a value, not a call — building the
		// closure runs none of its body.
		case "FunctionValue":
			return true
		// NOTE: A member read off a Record, a Case payload or a Namespace.
		// Every member the Type says is there IS there, so the read can not
		// fail, and it can not run anything either.
		case "Lookup":
			return isPureExpression(node.base)
		case "RecordValue":
			return Object.values(node.members).every(isPureExpression)
		case "ListValue":
			return node.values.every(isPureExpression)
		case "CaseValue":
			return node.value === null || isPureExpression(node.value)
		case "Combination":
			return isPureExpression(node.lhs) && isPureExpression(node.rhs)
		// NOTE: A witness is a method map — references to Methods, never calls
		// of them — and a conditional one curries the witnesses below it onto
		// those references. Nothing in either runs.
		case "ConformanceValue":
			return node.conditions.every(isPureExpression)
		// NOTE: A call, and the whole of what this function refuses. A native
		// Function is `__print` itself for all it can tell here, a
		// Function-valued Expression is whatever was bound to it, and a Union
		// dispatch is a Method call with a search in front of it.
		case "NativeFunctionInvocation":
		case "FunctionInvocation":
		case "UnionMethodInvocation":
			return false
		case "MethodInvocation":
			return isPureMethodInvocation(node)
		// NOTE: An interpolated String CALLS `toString` on each hole, through a
		// witness that may name a Method a Namespace wrote — so it is a call
		// like any other, and refused like one. (`fold-constants` will want
		// this widened for the holes whose witness is a standard library
		// Method; that is a rule to add here, with its own argument.)
		case "InterpolatedStringValue":
			return false
		// NOTE: A Match runs a Handler's BODY, which is Statements — an
		// assignment among them is exactly the effect this is asked about, and
		// Statements are not what this function reads. Refused whole rather
		// than half-read.
		case "Match":
			return false
		case "Intrinsic":
			return isPureIntrinsic(node)
	}
}

function isPureIntrinsic(node: common.typedSimple.IntrinsicNode): boolean {
	switch (node.kind) {
		case "tag-test":
		case "essence-boolean":
		case "raw-boolean":
			return isPureExpression(node.value)
		// NOTE: The value it reads is hoisted into a const band and the site
		// holds a NAME. Whether the value itself is pure is `pool-constants`'
		// question, and its answer is stricter than this one.
		case "pooled-reference":
			return true
		case "type-test":
			return (
				isPureExpression(node.value) &&
				isPureExpression(node.descriptor)
			)
		// NOTE: A descriptor is data, and a `direct-method` is a reference to a
		// Function rather than a call of one.
		case "type-descriptor":
		case "direct-method":
			return true
		// NOTE: A Method call with the search in front of it taken out, which is
		// a Method call — refused exactly as the `UnionMethodInvocation` it was
		// compiled from is.
		case "dispatch-chain":
			return false
		case "raw-boolean-op":
			return (
				isPureExpression(node.operand) &&
				(node.other === null || isPureExpression(node.other))
			)
		case "raw-compare":
		case "raw-equals":
		case "raw-arithmetic":
			return isPureExpression(node.left) && isPureExpression(node.right)
		case "direct-record":
			return Object.values(node.members).every(isPureExpression)
		case "direct-case":
			return (
				Object.values(node.members).every(isPureExpression) &&
				(node.payload === null || isPureExpression(node.payload))
			)
		case "direct-list":
			return node.values.every(isPureExpression)
		case "spread-combination":
			return (
				isPureExpression(node.lhs) &&
				Object.values(node.members).every(isPureExpression) &&
				(node.rhs === null || isPureExpression(node.rhs))
			)
	}
}

// NOTE: THE ENUMERATION. A Method call is impure unless it is a call of one of
// these, on one of these Namespaces, and every Argument it is given is pure
// too.
//
// NOTE: It is short on purpose, and every entry is here for the same three
// reasons: the Method prints nothing and assigns nothing, it answers for EVERY
// value of its Parameter Types rather than throwing for some of them, and it
// terminates in a bounded number of steps. `Integer`'s entries are bigint
// operations and the Essence one-liners written on them; `Boolean`'s are the
// two interned instances and the logic over them.
//
// NOTE: What is deliberately absent, so that adding one is a decision rather
// than an oversight. `Number`'s covering comparison reaches π's interval
// arithmetic, which narrows until it can decide a sign and is not obviously
// bounded for every pair. `Integer.raise` is `a ** b`, which is bounded only by
// how much memory the answer needs. `List` and `Optional` take Function
// Arguments and run them, so their purity is the caller's Function's. `String`
// allocates freely but the Methods worth naming here are the comparisons, which
// `lower-scalar-operations` reaches without this.
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
	]),
	Boolean: new Set(["is", "isNot", "and", "or", "negate", "exclusiveOr"]),
}

function isPureMethodInvocation(
	node: common.typedSimple.MethodInvocationNode,
): boolean {
	// NOTE: The Namespace is read by NAME, which is safe here for a reason that
	// is not obvious: a Program may declare a Namespace of its own called
	// `Integer` — nested, where the name is not taken yet — and its Methods
	// would answer under these names. That Program's Namespace can do anything
	// at all, so what saves this is that `lower-scalar-operations` refuses to
	// lower ANY Invocation on a name a Program declares below its top level,
	// and it is the only caller. A second caller must ask the same question
	// before it asks this one.
	let members = pureMethods[node.base.name]

	if (members === undefined) {
		return false
	}

	if (!members.has(withoutOverloadSuffix(node.member.name))) {
		return false
	}

	return node.arguments.every((argument) => isPureExpression(argument.value))
}

// NOTE: `isLessThan__overload$1` and `isLessThan` are one Method written with
// and without its entries; which entry a call reached is decided by the Types
// it was given, and every entry of the Methods named above is as pure as its
// siblings.
export function withoutOverloadSuffix(name: string): string {
	let suffix = name.indexOf("__overload$")

	return suffix === -1 ? name : name.slice(0, suffix)
}
