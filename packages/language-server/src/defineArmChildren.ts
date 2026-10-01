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

export function defineExpressions<Expression>(
	node: Define<Expression>,
): Array<Expression> {
	return [
		...node.arms.flatMap((arm) => [arm.value, arm.condition]),
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
