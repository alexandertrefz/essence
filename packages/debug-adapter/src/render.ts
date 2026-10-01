// How a batch of Essence values is rendered inside the debuggee. The source of
// `describeEssenceValues` runs there, so it must stay self-contained. See
// "Rendering values" in DEVELOPMENT.md.
//
// Each value answers `{ display, kind }`. `display` is the line the Variables
// view shows, or null for the default description. `kind` says how the value
// expands: `record` by its members, `list` by its items and `dictionary` by its
// entries. A `plain` value expands as a JavaScript object, a `leaf` not at all.

export type DescribedValue = {
	display: string | null
	kind: "leaf" | "record" | "list" | "dictionary" | "plain"
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

	// A copy of `quotedText` in `packages/runtime/src/String.ts`, which must
	// change with it. A line break or control character is escaped, so a value
	// stays on one row and nothing in it is invisible.
	function quoted(text: string): string {
		let out = '"'

		for (let index = 0; index < text.length; index++) {
			let code = text.charCodeAt(index)
			let spelled =
				code === 0x5c
					? "\\\\"
					: code === 0x22
						? '\\"'
						: code === 0x0a
							? "\\n"
							: code === 0x0d
								? "\\r"
								: code === 0x09
									? "\\t"
									: code === 0x7b
										? "\\{"
										: code === 0x7d
											? "\\}"
											: null

			if (spelled !== null) {
				out += spelled

				continue
			}

			let paired =
				code >= 0xd800 &&
				code <= 0xdbff &&
				text.charCodeAt(index + 1) >= 0xdc00 &&
				text.charCodeAt(index + 1) <= 0xdfff

			let trailing =
				code >= 0xdc00 &&
				code <= 0xdfff &&
				index > 0 &&
				text.charCodeAt(index - 1) >= 0xd800 &&
				text.charCodeAt(index - 1) <= 0xdbff

			let lone = code >= 0xd800 && code <= 0xdfff && !paired && !trailing

			if (
				code < 0x20 ||
				(code >= 0x7f && code <= 0x9f) ||
				code === 0x061c ||
				code === 0xfeff ||
				(code >= 0x200e && code <= 0x200f) ||
				(code >= 0x2028 && code <= 0x202e) ||
				(code >= 0x2066 && code <= 0x2069) ||
				lone
			) {
				out += `\\u{${(lone ? 0xfffd : code)
					.toString(16)
					.toUpperCase()}}`

				continue
			}

			out += text[index]
		}

		return `${out}"`
	}

	// The text a Case is shown as, `Door#Open`, without the Module the tag
	// carries. A copy of `caseText` in `packages/runtime/src/registry.ts`.
	function shownTag(tag: string): string {
		let separator = tag.lastIndexOf("#")

		return separator === -1
			? tag
			: tag.slice(tag.lastIndexOf("#", separator - 1) + 1)
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
			return quoted(record.value as unknown as string)
		}

		if (tag === "Boolean") {
			return record.value ? "true" : "false"
		}

		if (tag === "Integer") {
			return String(record.value)
		}

		if (tag === "Rational") {
			// Reduced to lowest terms, as `formatAsRational` prints it, since
			// a Rational is stored unreduced. A zero denominator is no Rational
			// the language builds, so it is left as it is.
			let numerator = record.numerator as unknown as bigint
			let denominator = record.denominator as unknown as bigint

			if (denominator !== 0n) {
				let first = numerator < 0n ? -numerator : numerator
				let second = denominator < 0n ? -denominator : denominator

				while (second > 0n) {
					let remainder = first % second

					first = second
					second = remainder
				}

				if (first > 0n) {
					numerator = numerator / first
					denominator = denominator / first
				}
			}

			return `${numerator}/${denominator}`
		}

		// The runtime prints these as bare names. A `Future` holds a closure
		// and a `Started` a promise and a controller, none of which the
		// Program wrote.
		if (
			tag === "Algebraic" ||
			tag === "Transcendental" ||
			tag === "Randomness" ||
			tag === "Future" ||
			tag === "Started"
		) {
			return tag
		}

		if (tag === "List") {
			// Only the box's view of its shared runs is shown, with the
			// writes past its version undone into a copy. See "Rendering
			// values" in DEVELOPMENT.md.
			let back = record.value as Array<unknown>
			let backCount = (record.length as number | undefined) ?? back.length
			let writes = record.writes as
				| {
						log: {
							version: number
							positions: Array<number>
							items: Array<unknown>
						}
						seen: number
				  }
				| undefined

			if (writes !== undefined && writes.seen !== writes.log.version) {
				let undone = back.slice(0, backCount)

				for (
					let version = writes.log.version - 1;
					version >= writes.seen;
					version--
				) {
					let position = writes.log.positions[version]

					if (position < backCount) {
						undone[position] = writes.log.items[version]
					}
				}

				back = undone
			}
			let front = (record.front as Array<unknown> | undefined) ?? []
			let frontCount =
				(record.frontLen as number | undefined) ?? front.length

			if (frontCount + backCount === 0) {
				return "[]"
			}

			if (depth >= 2) {
				return "[ … ]"
			}

			let rendered: Array<string> = []

			for (let index = frontCount - 1; index >= 0; index--) {
				rendered.push(render(front[index], depth + 1) ?? "…")
			}

			for (let index = 0; index < backCount; index++) {
				rendered.push(render(back[index], depth + 1) ?? "…")
			}

			let line = `[ ${rendered.join(", ")} ]`

			return line.length < 60 ? line : `[ ${rendered[0]}, … ]`
		}

		if (tag === "Dictionary") {
			// Per slot, the newest version at or below this box's generation.
			// A Symbol value is a removal's tombstone. See "Rendering values"
			// in DEVELOPMENT.md.
			let store = record.store as
				| {
						slots: Array<{
							key: unknown
							versions: Array<{
								value: unknown
								generation: number
							}>
						}>
				  }
				| undefined
			let slots = store === undefined ? [] : store.slots
			let generation = (record.generation as number | undefined) ?? 0
			let pairs: Array<[unknown, unknown]> = []

			for (let index = 0; index < slots.length; index++) {
				let slot = slots[index]
				let versions = slot.versions

				for (let back = versions.length - 1; back >= 0; back--) {
					let version = versions[back]

					if (version.generation <= generation) {
						if (typeof version.value !== "symbol") {
							pairs.push([slot.key, version.value])
						}

						break
					}
				}
			}

			// `[]` is the empty List, so the runtime prints an empty
			// Dictionary as `[=]`.
			if (pairs.length === 0) {
				return "[=]"
			}

			if (depth >= 2) {
				return "[ … ]"
			}

			let rendered = pairs.map(
				([key, held]) =>
					`${render(key, depth + 1) ?? "…"} = ${
						render(held, depth + 1) ?? "…"
					}`,
			)
			let line = `[ ${rendered.join(", ")} ]`

			return line.length < 60 ? line : `[ ${rendered[0]}, … ]`
		}

		let entries = Object.entries(record)
		let shown = shownTag(tag)
		let prefix = tag === "Record" ? "" : `${shown} `

		if (entries.length === 0) {
			return tag === "Record" ? "{}" : shown
		}

		// A one-member Case renders its payload bare, `Optional#Value(3)`, as
		// the language writes it and `getStringRepresentation` prints it.
		if (
			tag !== "Record" &&
			tag.indexOf("#") !== -1 &&
			entries.length === 1
		) {
			return `${shown}(${render(entries[0]![1], depth + 1) ?? "…"})`
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

		// A Dictionary's own members are its store and generation, so it
		// expands by its entries instead.
		if (tag === "Dictionary") {
			return { display: render(value, 0), kind: "dictionary" }
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

// A List's items as the box views them, in order, gathered inside the
// debuggee. It repeats the view arithmetic of `describeEssenceValues` and
// builds a new Array rather than calling `materialise`, which writes the box.
function essenceListItems(list: unknown): Array<unknown> {
	let record = list as Record<string, never>
	let back = (record.value as Array<unknown> | undefined) ?? []
	let backCount = (record.length as number | undefined) ?? back.length
	let writes = record.writes as
		| {
				log: {
					version: number
					positions: Array<number>
					items: Array<unknown>
				}
				seen: number
		  }
		| undefined

	if (writes !== undefined && writes.seen !== writes.log.version) {
		let undone = back.slice(0, backCount)

		for (
			let version = writes.log.version - 1;
			version >= writes.seen;
			version--
		) {
			let position = writes.log.positions[version]

			if (position < backCount) {
				undone[position] = writes.log.items[version]
			}
		}

		back = undone
	}
	let front = (record.front as Array<unknown> | undefined) ?? []
	let frontCount = (record.frontLen as number | undefined) ?? front.length
	let items: Array<unknown> = []

	for (let index = frontCount - 1; index >= 0; index--) {
		items.push(front[index])
	}

	for (let index = 0; index < backCount; index++) {
		items.push(back[index])
	}

	return items
}

// A Dictionary's entries as the box views them, in insertion order, gathered
// inside the debuggee as new `{ key, value }` Records around the live boxes.
// See "Rendering values" in DEVELOPMENT.md.
function essenceDictionaryEntries(dictionary: unknown): Array<unknown> {
	let record = dictionary as Record<string, never>
	let tag = Object.getOwnPropertySymbols(record).find(
		(candidate) => candidate.description === "$type",
	)
	let store = record.store as
		| {
				slots: Array<{
					key: unknown
					versions: Array<{ value: unknown; generation: number }>
				}>
		  }
		| undefined
	let slots = store === undefined ? [] : store.slots
	let generation = (record.generation as number | undefined) ?? 0
	let entries: Array<unknown> = []

	for (let index = 0; index < slots.length; index++) {
		let slot = slots[index]
		let versions = slot.versions

		for (let back = versions.length - 1; back >= 0; back--) {
			let version = versions[back]

			if (version.generation <= generation) {
				if (typeof version.value !== "symbol") {
					entries.push(
						tag === undefined
							? { key: slot.key, value: version.value }
							: {
									[tag]: "Record",
									key: slot.key,
									value: version.value,
								},
					)
				}

				break
			}
		}
	}

	return entries
}

// Each function is tested here as a value and sent to the debuggee as its
// source text.
export const DESCRIBE_BATCH_SOURCE = describeEssenceValues.toString()
export const LIST_ITEMS_SOURCE = essenceListItems.toString()
export const DICTIONARY_ENTRIES_SOURCE = essenceDictionaryEntries.toString()
