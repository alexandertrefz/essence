import { countCopied } from "./listWork"
import type { AnyType } from "./type"

// The undo log that lets a positional write change a shared run Array in
// place. See "The List write log" in DEVELOPMENT.md.
export type WriteLog<ItemType extends AnyType> = {
	// INVARIANT: `version` equals the number of entries. Entry k holds what
	// stood at `positions[k]` before the write that produced version k+1.
	version: number
	positions: Array<number>
	items: Array<ItemType>
	// Set for good once a walk hands the run to code that may call back into
	// Essence. A sealed log makes every later write copy.
	sealed: boolean
}

// The log and the version of it one box views. Never written once built, so
// boxes that view the same version can share one.
export type LoggedRun<ItemType extends AnyType> = {
	log: WriteLog<ItemType>
	seen: number
}

// The fields of a List box this module touches, named apart from `ListType` so
// that `type.ts` can catch a box up without importing `List.ts`.
export type WrittenList<ItemType extends AnyType> = {
	value: Array<ItemType>
	length?: number
	writes?: LoggedRun<ItemType>
}

// INVARIANT: a log is minted only with an Array nobody else holds.
export function freshLog<ItemType extends AnyType>(): WriteLog<ItemType> {
	return { version: 0, positions: [], items: [], sealed: false }
}

// Copies the box's own view and undoes every write since its version. The copy
// is the box's alone, so it gets a fresh log rather than none. Most boxes have
// no log or are current, so those two questions come first.
export function caughtUp<ItemType extends AnyType>(
	originalList: WrittenList<ItemType>,
): void {
	let writes = originalList.writes

	if (writes === undefined) {
		return
	}

	let log = writes.log

	if (writes.seen === log.version) {
		return
	}

	let count = originalList.length ?? originalList.value.length
	let own = originalList.value.slice(0, count)

	countCopied(count)
	let positions = log.positions
	let items = log.items

	for (let version = log.version - 1; version >= writes.seen; version--) {
		let position = positions[version]

		if (position < count) {
			own[position] = items[version]
		}
	}

	originalList.value = own
	originalList.length = count
	originalList.writes = { log: freshLog(), seen: 0 }
}
