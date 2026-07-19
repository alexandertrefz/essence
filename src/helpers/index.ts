import type { common, lexer } from "../interfaces"

export function stripPositionFromArray(
	tokens: Array<lexer.Token | undefined>,
): Array<lexer.SimpleToken | undefined> {
	return tokens.map((value) => stripPosition(value))
}

export function stripPosition(
	token: lexer.Token | undefined,
): lexer.SimpleToken | undefined {
	let tokenCopy: lexer.SimpleToken | undefined = structuredClone(token)
	if (tokenCopy) {
		;(tokenCopy as any).position = undefined
		return tokenCopy
	}

	return undefined
}

export function symbol(array: Array<{ position: common.Position }>) {
	return { position: array[0].position }
}

export function first<T = any>(array: Array<T>) {
	return array[0]
}

export function second<T = any>(array: Array<T>) {
	return array[1]
}

export function third<T = any>(array: Array<T>) {
	return array[2]
}

export function flatten<T = any>(array: Array<T | Array<T>>): Array<T> {
	return array.reduce<Array<T>>((prev, curr) => {
		let result: Array<T>

		if (Array.isArray(curr)) {
			result = prev.concat(curr)
		} else {
			prev.push(curr)
			result = prev
		}

		return result
	}, [])
}

export function resolveOverloadedMethodName(name: string, index: number) {
	return `${name}__overload$${index + 1}`
}

// NOTE: A signature is substitutable when the actual signature accepts at
// least what the expected signature promises to feed it (contravariant
// parameter types) and returns no more than the expected signature promises
// to yield (covariant return type).
// This accepts an actual `(_ a: A | B) -> X` where `(_ a: A) -> X` is
// expected, and rejects the unsafe reverse direction.
// External parameter names are part of the call syntax and must match exactly.
function signatureMatches(
	expected: common.BaseFunction,
	actual: common.BaseFunction,
): boolean {
	if (expected.parameterTypes.length !== actual.parameterTypes.length) {
		return false
	}

	for (let i = 0; i < expected.parameterTypes.length; i++) {
		if (expected.parameterTypes[i].name !== actual.parameterTypes[i].name) {
			return false
		}

		if (
			!matchesType(
				actual.parameterTypes[i].type,
				expected.parameterTypes[i].type,
			)
		) {
			return false
		}
	}

	return matchesType(expected.returnType, actual.returnType)
}

// NOTE: `AppliedType`s over List are normalized into plain List Types here,
// so that the rest of `matchesType` only has to deal with one representation.
function normalizeType(type: common.Type): common.Type {
	if (type.type === "AppliedType" && type.baseType.type === "GenericList") {
		return {
			type: "List",
			itemType: type.appliedGenerics[0]?.type ?? { type: "Unknown" },
		}
	}

	return type
}

export function matchesType(lhs: common.Type, rhs: common.Type): boolean {
	lhs = normalizeType(lhs)
	rhs = normalizeType(rhs)

	// NOTE: Error Types are poison values — they only occur after a
	// Diagnostic has already been reported, and match anything in both
	// directions so that a single mistake does not cascade into
	// follow-up Diagnostics.
	if (lhs.type === "Error" || rhs.type === "Error") {
		return true
	}

	// NOTE: Stabilisation semantics — unresolved Generics match anything, in
	// both directions. Generic Inference will replace this with proper
	// binding & substitution.
	if (lhs.type === "Unknown" || lhs.type === "GenericUse") {
		return true
	}

	if (rhs.type === "GenericUse") {
		return true
	}

	if (
		(lhs.type === "GenericList" || lhs.type === "List") &&
		rhs.type === "GenericList"
	) {
		return true
	}

	if (lhs.type === "GenericList" && rhs.type === "List") {
		return true
	}

	if (lhs.type === "List" && rhs.type === "List") {
		// NOTE: Empty List Literals have an Unknown itemType and
		// are assignable to any List.
		if (rhs.itemType.type === "Unknown") {
			return true
		}

		return matchesType(lhs.itemType, rhs.itemType)
	}

	if (lhs.type === "Nothing" && rhs.type === "Nothing") {
		return true
	}

	if (lhs.type === "String" && rhs.type === "String") {
		return true
	}

	if (lhs.type === "Boolean" && rhs.type === "Boolean") {
		return true
	}

	if (lhs.type === "Integer" && rhs.type === "Integer") {
		return true
	}

	if (lhs.type === "Fraction" && rhs.type === "Fraction") {
		return true
	}

	if (lhs.type === "UnionType") {
		if (rhs.type === "UnionType") {
			// NOTE: An actual Union is assignable when every one of its
			// members is accepted by some member of the expected Union — the
			// actual Type must not be able to hold any value the expected
			// Type can not hold.
			for (let rhsType of rhs.types) {
				let foundMatch = false

				for (let lhsType of lhs.types) {
					if (matchesType(lhsType, rhsType)) {
						foundMatch = true
						break
					}
				}

				if (!foundMatch) {
					return false
				}
			}

			return true
		} else {
			for (let type of lhs.types) {
				if (matchesType(type, rhs)) {
					return true
				}
			}
		}

		return false
	}

	if (lhs.type === "Record" && rhs.type === "Record") {
		for (let memberName in lhs.members) {
			if (rhs.members[memberName] === undefined) {
				return false
			}

			if (
				!matchesType(lhs.members[memberName], rhs.members[memberName])
			) {
				return false
			}
		}

		return true
	}

	if (
		(lhs.type === "Function" && rhs.type === "Function") ||
		(lhs.type === "SimpleMethod" && rhs.type === "SimpleMethod") ||
		(lhs.type === "StaticMethod" && rhs.type === "StaticMethod")
	) {
		return signatureMatches(lhs, rhs)
	}

	if (
		(lhs.type === "OverloadedMethod" && rhs.type === "OverloadedMethod") ||
		(lhs.type === "OverloadedStaticMethod" &&
			rhs.type === "OverloadedStaticMethod")
	) {
		if (lhs.overloads.length !== rhs.overloads.length) {
			return false
		}

		for (let i = 0; i < lhs.overloads.length; i++) {
			if (!signatureMatches(lhs.overloads[i], rhs.overloads[i])) {
				return false
			}
		}

		return true
	}

	return false
}
