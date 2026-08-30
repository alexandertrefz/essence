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
// `dictionary` by its entries, `plain` as an ordinary JavaScript object, `leaf`
// not at all.

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
			// NOTE: LOWEST TERMS, computed here. A Rational is stored as the
			// two bigints it was built from — `createRational` puts the sign on
			// the numerator and settles zero as `0/1`, and reduces nothing —
			// and the runtime's structural printer (`formatAsRational` in
			// runtime/src/Rational.ts) reduces on the way out, so `6/2` prints
			// as `3/1`. A Dictionary keeps the FIRST key box that arrived, and
			// that box may be the unreduced spelling of a key its Program only
			// ever prints reduced; drawing it raw would show a reader a value
			// no output of theirs can ever hold.
			//
			// NOTE: Euclid's, inlined for the reason everything here is
			// inlined — this source is evaluated in the debuggee, where nothing
			// else of this module exists. A denominator of zero is no Rational
			// the language can build, so it is handed back untouched rather
			// than divided by.
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

		if (
			tag === "Algebraic" ||
			tag === "Transcendental" ||
			tag === "Randomness"
		) {
			return tag
		}

		if (tag === "List") {
			// NOTE: A List is two runs and a VIEW into each — the back run
			// forward in `value`, the front run REVERSED in `front`, each as
			// long as its count says and no longer (`ListType` in
			// runtime/src/List.ts is the authority). Both Arrays are SHARED
			// with the other boxes of the chain and can hold items this box
			// never had, so what is shown is the view and never the Array: a
			// box viewing four items may not be drawn as five.
			let back = record.value as Array<unknown>
			let backCount = (record.length as number | undefined) ?? back.length
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
			// NOTE: A Dictionary is a shared STORE and a box's GENERATION into
			// it (`DictionaryType` in runtime/src/Dictionary.ts is the
			// authority). The store holds one slot per key in insertion order,
			// and each slot the versions its value has had, every version
			// stamped with the write that made it — so what THIS box holds is,
			// slot by slot, the newest version stamped at or below its own
			// generation. A slot opened by a write this box came before has no
			// version it can see and is not its, which is the same rule as the
			// List above under another name: the structure is shared and only
			// the view is the value.
			//
			// NOTE: A version whose value is a SYMBOL is the tombstone a
			// removal pushes — the key stands in the store but this box does
			// not hold it. `typeof` decides that here because no value of the
			// language is a Symbol, and the runtime's own `TOMBSTONE` is a
			// binding of a realm this source cannot reach into.
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

			// NOTE: `[=]` rather than `[]`, which is the empty LIST — the one
			// place the two written forms had to be told apart, and the
			// runtime's printer tells them apart the same way.
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

		// NOTE: Its own kind rather than `record`, because a Dictionary's
		// members are its store and its generation — the machinery — and what
		// a reader means by opening one is its entries. `record` would have
		// offered the store.
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

// NOTE: A List's logical items, gathered INSIDE the debuggee so that expanding
// a List in the Variables view offers exactly the items the box views, in
// order — its inner Array is shared with the rest of its chain and may run past
// the view, and a box that was prepended to holds a second, reversed run in
// front of it.
//
// NOTE: It repeats the renderer's view arithmetic rather than sharing it, for
// the reason the renderer inlines everything: this source is evaluated in a
// realm where nothing else of this module exists.
//
// NOTE: A NEW Array, never the runtime's own `materialise`, which would swap
// the box's representation in place. That swap is invisible to a running
// program, but looking at a paused one may not write to it at all.
function essenceListItems(list: unknown): Array<unknown> {
	let record = list as Record<string, never>
	let back = (record.value as Array<unknown> | undefined) ?? []
	let backCount = (record.length as number | undefined) ?? back.length
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

// NOTE: A Dictionary's entries, gathered INSIDE the debuggee so that expanding
// one in the Variables view offers exactly the entries the box views, in
// insertion order — its store is shared with the rest of its chain and carries
// versions stamped past this box along with tombstoned slots for the keys it no
// longer holds, none of which are this box's.
//
// NOTE: It repeats the renderer's view arithmetic rather than sharing it, for
// the reason the renderer inlines everything: this source is evaluated in a
// realm where nothing else of this module exists.
//
// NOTE: An entry is the Record `{ key, value }` the language itself is written
// in — the shape `entries()` answers and every Dictionary callback receives —
// but it is MINTED here rather than asked of the debuggee's own `entries`,
// which is a binding a bundle may have renamed or shaken away and which would
// be program code run inside a paused program. The key and the value it holds
// are the live boxes, so expanding an entry opens what the Dictionary holds.
//
// NOTE: A NEW Array of new Records, and not one property of the box is written
// — the same rule the List reader keeps, and for the same reason: looking at a
// paused program may not write to it.
//
// NOTE: The tag is read OFF the Dictionary rather than minted here, because
// every bundle mints its own `Symbol("$type")` and a Record wearing a second
// one is a Record the renderer over there would not recognise.
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

// NOTE: Shipped as the functions' own source — one implementation each,
// testable here as a value and evaluated over there as text.
export const DESCRIBE_BATCH_SOURCE = describeEssenceValues.toString()
export const LIST_ITEMS_SOURCE = essenceListItems.toString()
export const DICTIONARY_ENTRIES_SOURCE = essenceDictionaryEntries.toString()
