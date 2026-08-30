// NOTE: `define { as VALUE if CONDITION … as VALUE otherwise }` holds nothing
// but Expressions. An arm has no body to descend into — that is what keeps a
// `define` an Expression — so a walker with no case for it descends into
// nothing at all, and the whole of `as total if hasRun` is invisible to Hovers,
// Completion, Inlay Hints and the rename index. This is the one answer to "what
// is written inside a define", asked the way `matchHandlerChildren` asks it of a
// Match Handler, so that the walkers reading it can not come to disagree — and
// in particular so that none of them forgets the `otherwise` arm, which is a
// field of its own rather than another entry in `arms`.
//
// Returned in SOURCE order — the value stands left of the `if`, and the
// `otherwise` arm stands below every conditional one — so a walker searching for
// the first match in a document finds it where it lexically is.
//
// NOTE: One set of functions answers for the Parser AST and for the typed one
// alike: an arm is a value and a Condition either side of enrichment, and only
// the Expression Type differs. Shaped after `parameterDefaults`, which is
// written generically over the same two ASTs for the same reason.

type Arm<Expression> = {
	value: Expression
	condition: Expression
}

type Define<Expression> = {
	arms: ReadonlyArray<Arm<Expression>>
	otherwise: { value: Expression }
}

// NOTE: One arm, for the walkers that have something to say about the arm
// itself — a Position of its own to put on a selection chain.
export function defineArmExpressions<Expression>(
	arm: Arm<Expression>,
): Array<Expression> {
	return [arm.value, arm.condition]
}

export function defineExpressions<Expression>(
	node: Define<Expression>,
): Array<Expression> {
	return [
		...node.arms.flatMap((arm) => defineArmExpressions(arm)),
		node.otherwise.value,
	]
}

// NOTE: The same enumeration split by what the two halves are read AGAINST,
// for the walkers that thread an expected Type down: every value answers the
// `define` and so is read against the Type the position expects of it, while a
// Condition is a Boolean that expects nothing of its own. Split here rather
// than at each call site so that the `otherwise` arm's value is counted as a
// value everywhere, which is what it is.
export function defineValues<Expression>(
	node: Define<Expression>,
): Array<Expression> {
	return [...node.arms.map((arm) => arm.value), node.otherwise.value]
}

export function defineConditions<Expression>(
	node: Define<Expression>,
): Array<Expression> {
	return node.arms.map((arm) => arm.condition)
}
