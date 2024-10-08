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

export function matchesType(lhs: common.Type, rhs: common.Type): boolean {
	if (lhs.type === "Unknown") {
		return true
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
			for (let lhsType of lhs.types) {
				let foundMatch = false

				for (let rhsType of rhs.types) {
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

	if (lhs.type === "Function" && rhs.type === "Function") {
		if (lhs.parameterTypes.length !== rhs.parameterTypes.length) {
			return false
		}

		for (let i = 0; i < lhs.parameterTypes.length; i++) {
			if (
				lhs.parameterTypes[i].name !== rhs.parameterTypes[i].name ||
				// TODO: Check wether this is safe
				// I have changed the order around, in order to enable a parameter of
				// type (_ a: A | B) -> X receiving an argument of type (_ a: A) -> X since this is safe.
				// Need to confirm this doesn't have strange side effects.
				!matchesType(
					rhs.parameterTypes[i].type,
					lhs.parameterTypes[i].type,
				)
			) {
				return false
			}
		}

		if (!matchesType(lhs.returnType, rhs.returnType)) {
			return false
		}

		return true
	}

	if (lhs.type === "SimpleMethod" && rhs.type === "SimpleMethod") {
		if (lhs.parameterTypes.length !== rhs.parameterTypes.length) {
			return false
		}

		if (!matchesType(lhs.returnType, rhs.returnType)) {
			return false
		}

		for (let i = 0; i < lhs.parameterTypes.length; i++) {
			if (
				lhs.parameterTypes[i].name !== rhs.parameterTypes[i].name ||
				!matchesType(
					lhs.parameterTypes[i].type,
					rhs.parameterTypes[i].type,
				)
			) {
				return false
			}
		}

		return true
	}

	if (lhs.type === "StaticMethod" && rhs.type === "StaticMethod") {
		if (lhs.parameterTypes.length !== rhs.parameterTypes.length) {
			return false
		}

		if (!matchesType(lhs.returnType, rhs.returnType)) {
			return false
		}

		for (let i = 0; i < lhs.parameterTypes.length; i++) {
			if (
				lhs.parameterTypes[i].name !== rhs.parameterTypes[i].name ||
				!matchesType(
					lhs.parameterTypes[i].type,
					rhs.parameterTypes[i].type,
				)
			) {
				return false
			}
		}

		return true
	}

	if (lhs.type === "OverloadedMethod" && rhs.type === "OverloadedMethod") {
		if (lhs.overloads.length !== rhs.overloads.length) {
			return false
		}

		for (let i = 0; i < lhs.overloads.length; i++) {
			let lhsOverload = lhs.overloads[i]
			let rhsOverload = rhs.overloads[i]

			if (
				lhsOverload.parameterTypes.length !==
				rhsOverload.parameterTypes.length
			) {
				return false
			}

			for (let j = 0; j < lhsOverload.parameterTypes.length; j++) {
				if (
					lhsOverload.parameterTypes[j].name !==
						rhsOverload.parameterTypes[j].name ||
					!matchesType(
						lhsOverload.parameterTypes[j].type,
						rhsOverload.parameterTypes[j].type,
					)
				) {
					return false
				}
			}

			if (!matchesType(lhsOverload.returnType, rhsOverload.returnType)) {
				return false
			}
		}

		return true
	}

	if (
		lhs.type === "OverloadedStaticMethod" &&
		rhs.type === "OverloadedStaticMethod"
	) {
		if (lhs.overloads.length !== rhs.overloads.length) {
			return false
		}

		for (let i = 0; i < lhs.overloads.length; i++) {
			let lhsOverload = lhs.overloads[i]
			let rhsOverload = rhs.overloads[i]

			if (
				lhsOverload.parameterTypes.length !==
				rhsOverload.parameterTypes.length
			) {
				return false
			}

			for (let j = 0; j < lhsOverload.parameterTypes.length; j++) {
				if (
					lhsOverload.parameterTypes[j].name !==
						rhsOverload.parameterTypes[j].name ||
					!matchesType(
						lhsOverload.parameterTypes[j].type,
						rhsOverload.parameterTypes[j].type,
					)
				) {
					return false
				}
			}

			if (!matchesType(lhsOverload.returnType, rhsOverload.returnType)) {
				return false
			}
		}

		return true
	}

	return false
}
