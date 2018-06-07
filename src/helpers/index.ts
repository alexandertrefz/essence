import { lexer, common } from "../interfaces"

export function stripPositionFromArray(tokens: Array<lexer.Token | undefined>): Array<lexer.SimpleToken> {
	return tokens.map(value => stripPosition(value))
}

export function stripPosition(token: lexer.Token | undefined): lexer.SimpleToken {
	let tokenCopy = JSON.parse(JSON.stringify(token))
	delete tokenCopy.position
	return tokenCopy
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
		let result

		if (Array.isArray(curr)) {
			result = prev.concat(curr)
		} else {
			result = [...prev, curr]
		}

		return result
	}, [])
}

export function resolveOverloadedMethodName(name: string, index: number) {
	return `${name}__overload$${index + 1}`
}
