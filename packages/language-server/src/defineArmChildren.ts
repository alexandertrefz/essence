// What is written inside a `define`: Expressions only, since an arm has no
// body. In source order, the `otherwise` arm included, for the Parser and the
// typed AST alike, as `matchHandlerChildren` answers for a Match Handler.

type Arm<Expression> = {
	value: Expression
	condition: Expression
}

type Define<Expression> = {
	arms: ReadonlyArray<Arm<Expression>>
	otherwise: { value: Expression }
}

// One arm, for walkers that put the arm's own Position on a selection chain.
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

// The same, split into values, read against the expected Type, and
// Conditions, which are Booleans.
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
