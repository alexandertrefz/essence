import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { isPureExpression } from "../purity"
import { type MatcherResidual, matcherResidualOverMembers } from "../residual"
import { rewriteExpressions } from "../walk"

// NOTE: A Method called on a Union-typed receiver is answered by one of several
// Methods, and which one is decided by the receiver — so the Compiler resolved
// every candidate statically and then handed the choice to the runtime:
//
//   $type.dispatchMethod(value, [args…], [
//     [{ type: "Case", choice: "Shape", name: "Circle", members: {…} },
//      Shapes.area, [], [[0, (item) { … }]]],
//     [{ type: "Case", choice: "Shape", name: "Blank" }, Shapes.area, []],
//   ])
//
// Everything in that call but the receiver and the shared Arguments is built to
// be read once and thrown away: an array per call, a tuple per case, a
// descriptor tree per case, a copy of the Argument array wherever a case
// overrides one — and then a search that asks `isValueOfType` of descriptors the
// Compiler wrote itself. The chain is what it decides, written out:
//
//   value[$type.typeKeySymbol] === "Shape#Circle"
//     ? Shapes.area(value, (item) { … })
//     : Shapes.area(value)
//
// NOTE: What is preserved, point for point. The cases keep their ORDER, which
// the Enricher chose — most specific first, because a check is open and a later
// case may accept what an earlier one is written for — and the first whose test
// answers is the one that runs, as the search took the first that accepted. The
// receiver and the shared Arguments are evaluated ONCE and BEFORE any test, as
// building the arrays evaluated them.
//
// NOTE: What CHANGES is when a branch's own Arguments are built. The dispatch
// built every branch's before choosing one — N conformance witnesses and N
// Function literals per call, of which one was used — and the chain builds only
// the ones the taken branch needs. That is observable only through an effect,
// and neither kind can have one: a witness is a map of Method references (or
// `boundConformance` currying them onto each other), and a contextual Argument
// is a Function LITERAL, whose body does not run because the closure was built.
// The pass proves it per case with `isPureExpression` all the same, and leaves
// the Invocation as it was where the proof fails — the rule is not "these are
// always pure", it is "this Compiler only lowers what it can show is".
//
// NOTE: THE LAST CASE IS THE `else`, on the same argument
// `elide-final-match-test` makes for a Match's last Handler, and with the same
// thing given up. The Enricher emits a dispatch only where every member of the
// receiver's Union has a case, so a value reaching the last case has nowhere
// else to go and its test has one possible answer. What is given up is the
// throw that names a Compiler bug: with the test elided, a receiver that
// satisfies NO case — which can only happen where a runtime check and the
// static Type part company — silently takes the last branch instead of saying
// so. So the elision is taken only where that last check is decided by TAGS,
// which is exactly where the two can not part company; a case that still needs
// a descriptor keeps its test and the chain ends in
// `$type.noDispatchCaseMatched`, the same throw `dispatchMethod` ends with.
// `--without-optimisation compile-union-dispatch` puts both the search and its
// throw back, and is what a Compiler developer chasing a dispatch that answers
// the wrong thing builds with.

export const compileUnionDispatch: OptimiserPass = {
	name: "compile-union-dispatch",
	run: (program, namespaces) => {
		// NOTE: The Namespaces the Program declares below its top level, which
		// is what `isPureExpression` needs to know before it reads a Namespace
		// name out of its enumeration. This pass never lowers a Method call
		// itself, so the set changes nothing it does today — it is asked for
		// because the question the purity of an operand answers is the same one
		// whoever asks it, and a caller that could not have been wrong is
		// cheaper than a caller that has to be checked.
		let shadowed = namespaces.nested

		return rewriteExpressions(program, (node) => compile(node, shadowed))
	},
}

// NOTE: Unspellable in Essence, like every other name the Compiler binds for
// itself: the Lexer reads `_` as a Symbol, so no user identifier holds one, and
// the `$` keeps it clear of `_self`. A chain nested inside another's branch
// numbers from zero again and shadows it, which is harmless — a chain reads its
// own temporaries and nothing else's, and the only thing that can stand inside
// one is a Function literal a branch passes on, whose body was written before
// any of these names existed.
const temporaryPrefix = "$dispatch_"

function compile(
	node: common.typedSimple.ExpressionNode,
	shadowed: ReadonlySet<string>,
): common.typedSimple.ExpressionNode {
	if (node.nodeType !== "UnionMethodInvocation") {
		return node
	}

	// NOTE: The Enricher does not emit a dispatch without cases, and a chain of
	// none would answer nothing at all — so this is a shape that can not arrive
	// rather than one that is left alone for a reason.
	if (node.cases.length === 0) {
		return node
	}

	if (
		!node.cases.every((dispatchCase) =>
			caseArgumentsArePure(dispatchCase, shadowed),
		)
	) {
		return node
	}

	let branches = collapsedIfUniform(planBranches(node.cases))
	// NOTE: The receiver and the shared Arguments, in the order the dispatch
	// evaluated them — which is the order they have to stay in.
	let operands = [
		node.base,
		...node.arguments.map((argument) => argument.value),
	]
	let isHeld = holdPlan(branches, operands, shadowed)
	let temporaries: Array<common.typedSimple.DispatchTemporaryNode> = []

	let reads = operands.map((operand, index) => {
		if (!isHeld[index]) {
			return () => ({ ...operand })
		}

		let name = `${temporaryPrefix}${temporaries.length}`

		temporaries.push({ name, value: operand })

		// NOTE: No Position. The name is machinery, and the Expression it holds
		// keeps the Position it was written with — which is where a debugger
		// should stop for the work this does.
		return (): common.typedSimple.ExpressionNode => ({
			nodeType: "Identifier",
			name,
			type: operand.type,
		})
	})

	let readReceiver = reads[0]!
	let readArguments = reads.slice(1)

	return {
		nodeType: "Intrinsic",
		kind: "dispatch-chain",
		temporaries,
		receiver: readReceiver(),
		arguments: readArguments.map((read) => read()),
		cases: branches.map((branch) => ({
			test:
				branch.residual === null
					? null
					: testOf(
							branch.residual,
							readReceiver(),
							branch.dispatchCase.memberType,
						),
			namespaceName: branch.dispatchCase.namespaceName,
			methodName: branch.dispatchCase.methodName,
			conformanceArguments: branch.dispatchCase.conformanceArguments.map(
				(argument) => argument.value,
			),
			contextualArguments: branch.dispatchCase.contextualArguments.map(
				(contextual) => ({
					index: contextual.index,
					value: contextual.argument.value,
				}),
			),
			derivedDescriptor: branch.dispatchCase.derivedDescriptor,
		})),
		type: node.type,
		position: node.position,
	}
}

type PlannedBranch = {
	dispatchCase: common.typedSimple.UnionMethodDispatchCase
	// NOTE: What this branch's check reduces to — and null where it needs no
	// check at all, which is where the chain ends.
	residual: MatcherResidual | null
}

// NOTE: The branches the chain is made of, in the order the cases were given.
// The residual is asked of the case's member Type against the MEMBERS — which
// are the cases, one per member of the receiver's Union — so a member Type two
// cases could both claim (`List<Alpha>` beside `List<Beta>`, both `"List"`)
// keeps the full check that tells them apart, exactly as a Match Handler does.
function planBranches(
	cases: ReadonlyArray<common.typedSimple.UnionMethodDispatchCase>,
): Array<PlannedBranch> {
	let memberTypes = cases.map((dispatchCase) => dispatchCase.memberType)
	let branches: Array<PlannedBranch> = []

	for (let [index, dispatchCase] of cases.entries()) {
		let residual = matcherResidualOverMembers(
			dispatchCase.memberType,
			memberTypes,
		)
		// NOTE: Two ways a branch ends up untested, and they are different
		// claims. `always` says the check accepts every value that can arrive,
		// so the cases AFTER it are unreachable and are dropped — the search
		// would have stopped here too. The last branch is untested because the
		// Union has no member left to send anywhere else, which is the trade
		// documented at the top of this file and is taken only for a check that
		// is decided by tags.
		let isDecided =
			residual.kind === "always" ||
			(index === cases.length - 1 && residual.kind === "tag")

		branches.push({ dispatchCase, residual: isDecided ? null : residual })

		if (isDecided) {
			break
		}
	}

	return branches
}

// NOTE: A chain every branch of which is the SAME CALL, written as that call.
// `List<Integer> | List<String>` asked for its `length` resolves to `List.length`
// for both members, so the chain the plan above describes is two branches that
// do the same thing behind two checks that decide which of them does it.
//
// NOTE: The residual is what says the checks are all a test can be. Each
// branch's is `matcherResidualOverMembers` of that branch's member Type against
// the members — a check that accepts this member's values and declines the
// others — and the only thing the chain does with the answer is pick a branch. A
// dispatch never narrows or converts what it dispatches on: the receiver is
// passed to the Method exactly as it arrived, in every branch, and the tests
// decide WHICH Method sees it and nothing else. Where that is one Method, they
// decide nothing, and a check that decides nothing removes nothing by going —
// which is why this needs no argument about tags, unlike
// `elide-final-match-test`. That pass drops the LAST test because the ones before
// it failed; this one drops ALL of them because their answers are
// interchangeable.
//
// NOTE: What is given up is the same throw, and it is given up on a stronger
// footing. The Enricher emits a dispatch only where every member of the
// receiver's Union has a case, so every value that can arrive has a branch, and
// `$type.noDispatchCaseMatched` is there for a receiver that satisfies none —
// which can only happen where a runtime check and the static Type part company
// over an erased payload. Two `List` cases are exactly that shape: both tag
// `"List"`, so both keep a full descriptor check today, and the check walks the
// items to tell them apart. With one call on every branch there is nothing for
// the two to disagree ABOUT — whichever member arrived, the Method it reaches is
// the same one.
//
// NOTE: A branch's own Arguments are what makes two branches different calls, so
// a chain where any branch carries one is left alone. That is stricter than
// comparing them: two branches of the same Method with different conformance
// witnesses are two different calls and must keep their tests, and two carrying
// the SAME witness is a shape nothing writes today and would cost a structural
// comparison of Expressions to recognise. A derived descriptor is refused on the
// same footing — it is the branch's own, spelt per member Type.
function collapsedIfUniform(
	branches: Array<PlannedBranch>,
): Array<PlannedBranch> {
	let first = branches[0]

	if (first === undefined || branches.length === 1) {
		return branches
	}

	let isUniform = branches.every(
		(branch) =>
			branch.dispatchCase.namespaceName ===
				first.dispatchCase.namespaceName &&
			branch.dispatchCase.methodName === first.dispatchCase.methodName &&
			branch.dispatchCase.derivedDescriptor === undefined &&
			branch.dispatchCase.conformanceArguments.length === 0 &&
			branch.dispatchCase.contextualArguments.length === 0,
	)

	if (!isUniform) {
		return branches
	}

	// NOTE: The first branch, untested — which is the shape `holdPlan` already
	// knows as "one branch, no test" and writes the operands out for, so the
	// chain emits as the call it is.
	return [{ dispatchCase: first.dispatchCase, residual: null }]
}

// NOTE: Which operands the chain HOLDS — evaluated once, in order, before any
// test, which is exactly where and when the dispatch built its Argument array —
// and which are written out where the branches use them instead.
//
// NOTE: Nothing at all is held where the chain is one untested branch. There is
// one place each operand is used and one order to use them in, so a name for it
// would say what the call already says.
//
// NOTE: A name or a literal is WRITTEN rather than held. A literal can not
// differ from one evaluation to the next and building it observes nothing; a
// name's read observes nothing either, and reading it later reads the same
// binding — PROVIDED nothing that runs in between can assign it. What runs in
// between is exactly the operands that ARE held, which are evaluated ahead of
// it, so a name with a held operand after it is held as well. That is not a
// hypothetical: in `either::tagged(with flip())`, where `flip` assigns
// `either`, the dispatch reads the receiver BEFORE the Argument is evaluated
// and answers for the value it had then — and a chain reading it where the
// branch uses it would answer for the value after the assignment, which is a
// different Program.
//
// NOTE: An Argument every branch overrides is read by no branch, and is the one
// evaluation the chain can drop: the dispatch built the shared Argument array
// whole, overridden entries and all. What stands in an overridden one can only
// be a contextually typed Function LITERAL — the Enricher overrides an Argument
// exactly where the Program wrote a Function literal there, and re-typed it per
// branch — so it has nothing to say. That is an argument about a shape rather
// than a promise about every shape, so the plan asks it: an unread operand that
// can not be shown to have nothing to say is HELD, which evaluates it where the
// Argument array did and leaves the name unread. That branch is unreachable
// today and is what makes the sentence above safe to stop checking.
function holdPlan(
	branches: ReadonlyArray<PlannedBranch>,
	operands: ReadonlyArray<common.typedSimple.ExpressionNode>,
	shadowed: ReadonlySet<string>,
): Array<boolean> {
	// NOTE: The receiver is read by every branch; a shared Argument is read by
	// none where every branch passes its own in its place.
	let isRead = operands.map(
		(_, index) =>
			index === 0 || !isOverriddenEverywhere(branches, index - 1),
	)
	// NOTE: Nothing is written out where the chain is one untested branch: there
	// is one place each operand is used and one order to use them in, so a name
	// for it would say what the call already says. An operand no branch reads
	// has no such place, so that stops being true of it.
	let writesOperandsOut =
		branches.length === 1 && branches[0]!.residual === null
	let isHeld = operands.map((operand, index) => {
		if (!isRead[index]) {
			return !isPureExpression(operand, shadowed)
		}

		return !writesOperandsOut && !isReReadable(operand)
	})

	// NOTE: Back to front, because what makes a name unsafe to leave where it
	// stands is what comes AFTER it.
	let heldAfter = false

	for (let index = operands.length - 1; index >= 0; index--) {
		if (isHeld[index]) {
			heldAfter = true
		} else if (
			heldAfter &&
			isRead[index] &&
			operands[index]!.nodeType === "Identifier"
		) {
			isHeld[index] = true
		}
	}

	return isHeld
}

// NOTE: Whether an Expression is one whose evaluation can be left where the
// branches need it — a name, whose read observes nothing, or a literal, which
// is the same value however often it is built and which `pool-constants` then
// declares once for every branch that names it. Everything else — a call, an
// interpolated String, an arithmetic Expression — is held, so that no branch
// carries a copy of it.
function isReReadable(node: common.typedSimple.ExpressionNode): boolean {
	switch (node.nodeType) {
		case "Identifier":
		case "IntegerValue":
		case "StringValue":
		case "RationalValue":
		case "BooleanValue":
			return true
		default:
			return false
	}
}

// NOTE: Whether every branch of the chain passes something of its own in this
// Argument's place — which makes the shared Expression there one nothing reads.
function isOverriddenEverywhere(
	branches: ReadonlyArray<PlannedBranch>,
	index: number,
): boolean {
	return branches.every((branch) =>
		branch.dispatchCase.contextualArguments.some(
			(contextual) => contextual.index === index,
		),
	)
}

// NOTE: The check as this branch still has to ask it — the same two Nodes
// `compile-type-tests` writes a Match Handler's check into, so a dispatch and a
// Match ask the same question in the same way. The descriptor stands in an
// Expression position for the same reason it does there: it is where
// `pool-constants` can reach it, and a descriptor rebuilt per test, per turn of
// whatever loop the call sits in, was the second thing it was paying for.
function testOf(
	residual: MatcherResidual,
	value: common.typedSimple.ExpressionNode,
	memberType: common.Type,
): common.typedSimple.ExpressionNode {
	if (residual.kind === "tag") {
		return {
			nodeType: "Intrinsic",
			kind: "tag-test",
			value,
			tag: residual.tag,
			negated: false,
			type: { type: "Boolean" },
		}
	}

	return {
		nodeType: "Intrinsic",
		kind: "type-test",
		value,
		descriptor: {
			nodeType: "Intrinsic",
			kind: "type-descriptor",
			descriptor: memberType,
			type: { type: "Unknown" },
		},
		type: { type: "Boolean" },
	}
}

// NOTE: Whether this case's own Arguments may be built in its branch rather
// than at the call — which is the one thing the chain does that the search did
// not, and the one thing that could be observed if it were untrue. A witness is
// a method map and a contextual Argument is a Function literal, so this holds
// for every dispatch a Program can write today; it is asked because what makes
// it hold is a property of those values, not a promise the shapes will not
// change.
function caseArgumentsArePure(
	dispatchCase: common.typedSimple.UnionMethodDispatchCase,
	shadowed: ReadonlySet<string>,
): boolean {
	return (
		dispatchCase.conformanceArguments.every((argument) =>
			isPureExpression(argument.value, shadowed),
		) &&
		dispatchCase.contextualArguments.every((contextual) =>
			isPureExpression(contextual.argument.value, shadowed),
		)
	)
}
