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
export function eraseRefinements(type: common.Type): common.Type
export function eraseRefinements(
	program: common.typedSimple.Program,
): common.typedSimple.Program
export function eraseRefinements(value: object): object {
	return erase(value, new Map()) as object
}

// NOTE: A Choice's payload may name the Choice, so a Type can lead back to one
// already in hand — and the same Type object stands in thousands of places in a
// simplified Program, which is what the memo is really for. An entry is written
// BEFORE the recursion, as the value itself, so a cycle is answered with what it
// already is; a refinement standing inside such a cycle would then be erased
// everywhere but there. None can: a `where` clause is written on Integer, String
// or a List of them, and none of those names itself.
function erase(value: unknown, seen: Map<object, unknown>): unknown {
	if (value === null || typeof value !== "object") {
		return value
	}

	let known = seen.get(value)

	if (known !== undefined) {
		return known
	}

	seen.set(value, value)

	let erased = eraseChildren(value, seen)

	seen.set(value, erased)

	return erased
}

function eraseChildren(value: object, seen: Map<object, unknown>): unknown {
	if (Array.isArray(value)) {
		let changed = false
		let mapped = value.map((item) => {
			let result = erase(item, seen)

			changed ||= result !== item

			return result
		})

		return changed ? mapped : value
	}

	let record = value as Record<string, unknown>

	// NOTE: The refinement itself — its base, erased in turn, stands where it
	// stood. `name` and `conjuncts` are gone with it: a Diagnostic that had
	// something to say about either said it long before emission.
	if (record.type === "Refinement") {
		return erase((record as unknown as common.RefinementType).base, seen)
	}

	let entries = Object.entries(record)
	let changed = false
	let mapped: Record<string, unknown> = {}

	// NOTE: Rebuilt key by key in the order the keys were written, which is not
	// a detail: a Record's members are emitted in the order they were declared,
	// and the emitted literal's key order is what the runtime's Record equality
	// and its printer read.
	for (let [key, child] of entries) {
		let result = erase(child, seen)

		changed ||= result !== child
		mapped[key] = result
	}

	return changed ? mapped : value
}
