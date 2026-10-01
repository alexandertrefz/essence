import type { common } from "@essence-lang/interfaces"

// Every refinement in a Type or a simplified Program replaced by its base. A
// checked refinement is decided while compiling, so the emitted Program carries
// only what it refines. See "Erasing refinements" in DEVELOPMENT.md.
export function eraseRefinements(type: common.Type): common.Type
export function eraseRefinements(
	program: common.typedSimple.Program,
): common.typedSimple.Program
export function eraseRefinements(value: object): object {
	let bearing = refinementBearing(value)

	if (bearing.size === 0) {
		return value
	}

	return rebuild(value, bearing, new Map()) as object
}

// Every object from which a refinement can be reached: the set the rebuild
// replaces. One sweep records who holds what, then bearing spreads back from
// the refinements along the recorded holders.
function refinementBearing(root: object): Set<object> {
	let holders = new Map<object, Array<object>>()
	let refinements: Array<object> = []
	let visited = new Set<object>()
	let pending: Array<object> = [root]

	while (pending.length > 0) {
		let value = pending.pop() as object

		if (visited.has(value)) {
			continue
		}

		visited.add(value)

		if ((value as Record<string, unknown>).type === "Refinement") {
			refinements.push(value)

			// The rebuild replaces the whole node, so its holders are enough.
			// Its base is still walked, so a refinement inside it is found.
			pending.push((value as unknown as common.RefinementType).base)

			continue
		}

		let children = Array.isArray(value)
			? value
			: Object.values(value as Record<string, unknown>)

		for (let child of children) {
			if (child === null || typeof child !== "object") {
				continue
			}

			let known = holders.get(child as object)

			if (known === undefined) {
				holders.set(child as object, [value])
			} else {
				known.push(value)
			}

			pending.push(child as object)
		}
	}

	let bearing = new Set<object>(refinements)
	let spread = [...refinements]

	while (spread.length > 0) {
		let value = spread.pop() as object

		for (let holder of holders.get(value) ?? []) {
			if (!bearing.has(holder)) {
				bearing.add(holder)
				spread.push(holder)
			}
		}
	}

	return bearing
}

// Only a bearing value is rebuilt. Each replacement is registered in `seen`
// before its children are filled, so a cycle's back-edge lands on the copy.
function rebuild(
	value: unknown,
	bearing: Set<object>,
	seen: Map<object, unknown>,
): unknown {
	if (value === null || typeof value !== "object" || !bearing.has(value)) {
		return value
	}

	let known = seen.get(value)

	if (known !== undefined) {
		return known
	}

	if (Array.isArray(value)) {
		let mapped: Array<unknown> = []

		seen.set(value, mapped)

		for (let item of value) {
			mapped.push(rebuild(item, bearing, seen))
		}

		return mapped
	}

	let record = value as Record<string, unknown>

	// A refinement becomes its erased base, and `seen` records that base, so
	// every holder of the refinement reads the same one.
	if (record.type === "Refinement") {
		let base = (record as unknown as common.RefinementType).base
		let erased = rebuild(base, bearing, seen)

		seen.set(value, erased)

		return erased
	}

	let mapped: Record<string, unknown> = {}

	seen.set(value, mapped)

	// A rebuilt Record drops its `name` and `alias`, since a member erased and
	// it is no longer the Alias it was written as. A Union keeps both. See
	// "Erasing refinements" in DEVELOPMENT.md.
	let spelled = record.type === "Record"

	// Keys keep their written order, since a Record's members are emitted in
	// the order they were declared.
	for (let [key, child] of Object.entries(record)) {
		if (spelled && (key === "name" || key === "alias")) {
			continue
		}

		mapped[key] = rebuild(child, bearing, seen)
	}

	return mapped
}
