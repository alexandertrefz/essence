import type { common } from "@essence-lang/interfaces"

// NOTE: Checked refinements do not survive into the emitted Program. A
// `NonZeroInteger` IS an Integer at run time — the same object, built by the
// same constructor — and its predicate was decided while compiling, so there is
// nothing left for the JavaScript to carry. This is where they go: every
// refinement in a Type, or in a whole simplified Program, replaced by what it
// refines.
//
// NOTE: It is a REFLECTIVE walk, unlike the Optimiser's `walk.ts` next door,
// which handles every Node kind by name so that a kind added without handling is
// a compile error. Erasure asks the opposite question. A pass that misses a
// position is an optimisation that silently does not happen; erasure that misses
// one is a refinement reaching the Rewriter, so what it needs is not a list to
// keep up to date but the guarantee that no field can be forgotten — including
// the fields of a Node kind, an intrinsic or a Type shape a later work package
// adds. `typeWalkFinds` in `helpers/index.ts` reads a Type the same way and for
// the same reason. The Rewriter's ICE guards are the second half of it: if this
// walk were ever wrong, the compile fails there rather than emitting a Program
// that carries evidence nobody can read.
//
// NOTE: Nothing is mutated and identity is preserved — a value carrying no
// refinement comes back AS ITSELF, so a Program that refines nothing pays a
// traversal and not one allocation. That matters twice over: the standard
// library's simplified Program is a process-wide value handed out again and
// again, and the caches around it are keyed by what they were given.
//
// NOTE: It runs in two passes because a Type can lead back to itself — a
// Choice's payload may name the Choice — and a rebuild that discovers what
// changed WHILE recursing answers a cycle's back-edge before it knows. The
// original one-pass form did exactly that: the back-edge was answered with the
// original object, the parent concluded nothing under it had changed, and a
// refinement standing anywhere on the cycle survived into emission, where the
// ICE guard turned a legal Program into a compile failure. So the question
// "does anything under here need erasing?" is answered FIRST, over the whole
// graph, where a cycle is just an edge already followed; only then does the
// rebuild run, and only over the values the first pass named. A rebuilt value
// is registered BEFORE its children are filled in, so a cycle's back-edge wires
// to the replacement rather than to the original it was built to replace.
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

// NOTE: Every object from which a refinement can be REACHED — the exact set the
// rebuild must replace, and the exact set the old walk's `changed` flags tried
// to discover mid-flight. Reachability is asked backwards: one sweep records
// who holds what and where the refinements stand, then bearing spreads from the
// refinements along the recorded holders. A cycle needs no care at all here —
// it is only an edge to something already visited.
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

			// NOTE: A refinement's OWN subtree is not walked for holders — the
			// rebuild replaces the whole node with its erased base, so nothing
			// under it can make an ancestor bear that the node itself does not.
			// Its base still has to be SEEN though: a refinement nested inside
			// another's base erases with it, and the inner one must be in
			// `refinements` for the day such a shape exists.
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

// NOTE: Only a bearing value is rebuilt; everything else comes back as itself,
// which is the identity guarantee above stated as one line. The replacement is
// registered in `seen` before its children are filled, so a cyclic Type's
// back-edge lands on the new object — the erased graph has the same shape as
// the one it replaces, cycles included.
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

	// NOTE: The refinement itself — its base, erased in turn, stands where it
	// stood. `name` and `conjuncts` are gone with it: a Diagnostic that had
	// something to say about either said it long before emission. The base is
	// what the memo records, so every holder of this refinement reads the one
	// erased base rather than each rebuilding its own.
	if (record.type === "Refinement") {
		let base = (record as unknown as common.RefinementType).base
		let erased = rebuild(base, bearing, seen)

		seen.set(value, erased)

		return erased
	}

	let mapped: Record<string, unknown> = {}

	seen.set(value, mapped)

	// NOTE: Rebuilt key by key in the order the keys were written, which is not
	// a detail: a Record's members are emitted in the order they were declared,
	// and the emitted literal's key order is what the runtime's Record equality
	// and its printer read.
	for (let [key, child] of Object.entries(record)) {
		mapped[key] = rebuild(child, bearing, seen)
	}

	return mapped
}
