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
//
// NOTE: `shadowed` is the set of Namespace names the Program declares below its
// own top level, which is `declaredNamespaces(program).nested`. It is a REQUIRED
// Argument rather than a courtesy the callers extend, because the enumeration
// below reads a Namespace by NAME and a Program may declare a Namespace of its
// own called `Integer` — nested, where the name is not taken yet — whose Methods
// would answer under those names and can do anything at all. Asking every caller
// to have refused those names first is a precondition that was written down and
// then not met; asking for the set is a precondition the Compiler can not
// forget. Where the answer does not matter to a caller, the honest Argument is
// still the Program's set and not an empty one.

export function isPureExpression(
	node: common.typedSimple.ExpressionNode,
	shadowed: ReadonlySet<string>,
): boolean {
	let isPure = (child: common.typedSimple.ExpressionNode): boolean =>
		isPureExpression(child, shadowed)

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
			return isPure(node.base)
		case "RecordValue":
			return Object.values(node.members).every(isPure)
		case "ListValue":
			return node.values.every(isPure)
		case "CaseValue":
			return node.value === null || isPure(node.value)
		case "Combination":
			return isPure(node.lhs) && isPure(node.rhs)
		// NOTE: A witness is a method map — references to Methods, never calls
		// of them — and a conditional one curries the witnesses below it onto
		// those references. Nothing in either runs.
		case "ConformanceValue":
			return node.conditions.every(isPure)
		// NOTE: A call, and the whole of what this function refuses. A native
		// Function is `__print` itself for all it can tell here, a
		// Function-valued Expression is whatever was bound to it, and a Union
		// dispatch is a Method call with a search in front of it.
		case "NativeFunctionInvocation":
		case "FunctionInvocation":
		case "UnionMethodInvocation":
			return false
		case "MethodInvocation":
			return isPureMethodInvocation(node, shadowed)
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
			return isPureIntrinsic(node, shadowed)
	}
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
		// NOTE: The value it reads is hoisted into a const band and the site
		// holds a NAME. Whether the value itself is pure is `pool-constants`'
		// question, and its answer is stricter than this one.
		case "pooled-reference":
			return true
		case "type-test":
			return isPure(node.value) && isPure(node.descriptor)
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
				isPure(node.operand) &&
				(node.other === null || isPure(node.other))
			)
		case "raw-compare":
		case "raw-equals":
		case "raw-arithmetic":
			return isPure(node.left) && isPure(node.right)
		case "direct-record":
			return Object.values(node.members).every(isPure)
		case "direct-case":
			return (
				Object.values(node.members).every(isPure) &&
				(node.payload === null || isPure(node.payload))
			)
		case "direct-list":
			return node.values.every(isPure)
		case "spread-combination":
			return (
				isPure(node.lhs) &&
				Object.values(node.members).every(isPure) &&
				(node.rhs === null || isPure(node.rhs))
			)
	}
}

// NOTE: THE ENUMERATION. A Method call is impure unless it is a call of one of
// these, on one of these Namespaces, with every Argument — the receiver
// included — of exactly that Namespace's own Type, and every Argument pure too.
//
// NOTE: The Namespace name is the Type name on purpose: `Integer`'s entry is the
// Method called on an Integer and GIVEN an Integer, which is the shape whose
// body is a bigint operation. `add` and the comparisons are Overloads that also
// take a Rational, an Algebraic and a Transcendental, and those entries are
// written on the covering `Number` Namespace rather than on the native — a
// different Method, weighed separately or not at all. Requiring the Types
// closes the enumeration over the bodies it was read against instead of over
// every Overload that happens to share a name.
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
	shadowed: ReadonlySet<string>,
): boolean {
	// NOTE: The Namespace is read by NAME, and a name is only the standard
	// library's where the Program has not taken it. A Program can not take one
	// at its top level — `Integer` is already declared in that Scope — but a
	// Namespace declared inside a block REPLACES the builtin for the rest of it,
	// in Method resolution as in conformance solving, and what it answers is
	// whatever somebody wrote it to answer. So a name the Program declares
	// anywhere below its top level is not read out of the enumeration at all,
	// wherever in an Expression the call turns up. Refused for the whole Program
	// rather than per Scope: the Optimiser walks Expressions and not Scopes, and
	// the Program that pays for the difference is the one that shadowed a
	// builtin.
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

	return node.arguments.every(
		(argument) =>
			argument.value.type.type === node.base.name &&
			isPureExpression(argument.value, shadowed),
	)
}

// NOTE: `isLessThan__overload$1` and `isLessThan` are one Method written with
// and without its entries; which entry a call reached is decided by the Types
// it was given, and every entry of the Methods named above is as pure as its
// siblings.
export function withoutOverloadSuffix(name: string): string {
	let suffix = name.indexOf("__overload$")

	return suffix === -1 ? name : name.slice(0, suffix)
}
