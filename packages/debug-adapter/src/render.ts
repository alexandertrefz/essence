// NOTE: How a batch of Essence values is rendered INSIDE the debuggee.
// `Runtime.callFunctionOn` evaluates this function's source over there — the
// values arrive as live arguments, bigints and all, and one JSON string comes
// back — so it must stay SELF-CONTAINED: nothing of this module exists in the
// debuggee's realm. The display rules retell the runtime's own
// `getStringRepresentation` (runtime/src/Terminal.ts); the tag symbol is
// found by its description, because every bundle mints its own
// `Symbol("$type")`.
//
// Each value answers `{ display, kind }`: `display` is the line the Variables
// view shows (null hands the default description back), and `kind` says how
// the value expands — `record` by its own members, `list` by its items,
// `plain` as an ordinary JavaScript object, `leaf` not at all.

export type DescribedValue = {
	display: string | null
	kind: "leaf" | "record" | "list" | "plain"
}

function describeEssenceValues(...values: Array<unknown>): string {
	function findTag(value: unknown): string | null {
		if (value === null || typeof value !== "object") {
			return null
		}

		let symbol = Object.getOwnPropertySymbols(value).find(
			(candidate) => candidate.description === "$type",
		)

		if (symbol === undefined) {
			return null
		}

		let tag = (value as Record<symbol, unknown>)[symbol]

		return typeof tag === "string" ? tag : null
	}

	function render(value: unknown, depth: number): string | null {
		if (typeof value === "function") {
			return "Function"
		}

		let tag = findTag(value)

		if (tag === null) {
			return null
		}

		let record = value as Record<string, never>

		if (tag === "String") {
			return `"${record.value}"`
		}

		if (tag === "Boolean") {
			return record.value ? "true" : "false"
		}

		if (tag === "Integer") {
			return String(record.value)
		}

		if (tag === "Rational") {
			return `${record.numerator}/${record.denominator}`
		}

		if (tag === "Algebraic" || tag === "Transcendental") {
			return tag
		}

		if (tag === "List") {
			let items = record.value as Array<unknown>

			if (items.length === 0) {
				return "[]"
			}

			if (depth >= 2) {
				return "[ … ]"
			}

			let rendered = items.map((item) => render(item, depth + 1) ?? "…")
			let line = `[ ${rendered.join(", ")} ]`

			return line.length < 60 ? line : `[ ${rendered[0]}, … ]`
		}

		let entries = Object.entries(record)
		let prefix = tag === "Record" ? "" : `${tag} `

		if (entries.length === 0) {
			return tag === "Record" ? "{}" : tag
		}

		// NOTE: A ONE-member Case renders its payload bare, in parentheses —
		// `Optional#Value(3)`, not `Optional#Value { item = 3 }` — because that
		// is how the language writes one. Mirrors `getStringRepresentation` in
		// the runtime, which `src/tests/render.spec.ts` pins the two together
		// against.
		if (
			tag !== "Record" &&
			tag.indexOf("#") !== -1 &&
			entries.length === 1
		) {
			return `${tag}(${render(entries[0]![1], depth + 1) ?? "…"})`
		}

		if (depth >= 2) {
			return `${prefix}{ … }`
		}

		let members = entries.map(
			([key, member]) => `${key} = ${render(member, depth + 1) ?? "…"}`,
		)
		let line = `${prefix}{ ${members.join(", ")} }`

		return line.length < 60 ? line : `${prefix}{ ${members[0]}, … }`
	}

	function describe(value: unknown): {
		display: string | null
		kind: string
	} {
		if (typeof value === "function") {
			return { display: "Function", kind: "leaf" }
		}

		let tag = findTag(value)

		if (tag === null) {
			return {
				display: null,
				kind:
					value !== null && typeof value === "object"
						? "plain"
						: "leaf",
			}
		}

		if (tag === "List") {
			return { display: render(value, 0), kind: "list" }
		}

		if (
			tag === "Record" ||
			tag === "Algebraic" ||
			tag === "Transcendental" ||
			(tag.indexOf("#") !== -1 && Object.keys(value as object).length > 0)
		) {
			return { display: render(value, 0), kind: "record" }
		}

		return { display: render(value, 0), kind: "leaf" }
	}

	try {
		return JSON.stringify(values.map(describe))
	} catch {
		return JSON.stringify(
			values.map(() => ({ display: null, kind: "leaf" })),
		)
	}
}

// NOTE: Shipped as the function's own source — one implementation, testable
// here as a value and evaluated over there as text.
export const DESCRIBE_BATCH_SOURCE = describeEssenceValues.toString()
