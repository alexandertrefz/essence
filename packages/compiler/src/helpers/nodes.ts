import type { lexer, parser } from "@essence-lang/interfaces"

export function stripPositionFromArray(
	tokens: Array<lexer.Token | undefined>,
): Array<lexer.SimpleToken | undefined> {
	return tokens.map((value) => stripPosition(value))
}

// A Token without its Position and offsets, for a spec that compares what was
// lexed. The lexer spec asserts offsets only where they are the point.
export function stripPosition(
	token: lexer.Token | undefined,
): lexer.SimpleToken | undefined {
	let tokenCopy: lexer.SimpleToken | undefined = structuredClone(token)
	if (tokenCopy) {
		;(tokenCopy as any).position = undefined
		;(tokenCopy as any).start = undefined
		;(tokenCopy as any).end = undefined
		return tokenCopy
	}

	return undefined
}

// Calls `visit` on each object a node holds short of another node or a Type,
// such as a Conformance or a dispatch branch. It passes the field and the
// object holding it, and reads on into the object where `visit` answers true.
// See "What a node holds" in DEVELOPMENT.md.
export function forEachHeldRecord(
	node: object,
	visit: (
		record: Record<string, unknown>,
		field: string,
		holder: Record<string, unknown>,
	) => boolean,
): void {
	let readValue = (
		value: unknown,
		field: string,
		holder: Record<string, unknown>,
	): void => {
		if (typeof value !== "object" || value === null) {
			return
		}

		if (Array.isArray(value)) {
			for (let item of value) {
				readValue(item, field, holder)
			}

			return
		}

		let record = value as Record<string, unknown>

		if (
			typeof record.nodeType !== "string" &&
			typeof record.type !== "string" &&
			visit(record, field, holder)
		) {
			readFields(record)
		}
	}

	let readFields = (holder: Record<string, unknown>): void => {
		for (let field in holder) {
			if (field !== "position") {
				readValue(holder[field], field, holder)
			}
		}
	}

	readFields(node as Record<string, unknown>)
}

// The one Node a Record Literal's member holds: its value, or the braced descend
// written in its place. Every walk over a Literal's members asks here, so none
// skips a descend.
export function memberExpression(
	member: parser.RecordValueMemberNode,
): parser.ExpressionNode {
	return member.value ?? member.group!
}
