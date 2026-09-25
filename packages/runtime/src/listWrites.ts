import type { AnyType } from "./type"

// NOTE: THE UNDO LOG a positional write leaves behind, and the one thing that
// lets `replace` write a run Array IN PLACE. A push only ever extends an Array,
// so the boxes sharing it keep every position they have already answered for;
// a write at a position CHANGES one they view, and copying the run was the only
// honest answer to that. The log is the other one: the writer records what stood
// at the position, writes over it, and counts one version up. Every box sharing
// that Array says which version it views, so a box left behind can still say
// exactly what it holds — it copies the Array and undoes the writes made since,
// which is the copy `replace` used to make, deferred to whoever actually reads.
//
// NOTE: The log lives in a Module of its own because `type.ts` is the Module
// EVERY Program carries and it walks a List's runs raw rather than reaching
// into `List.ts`, which would tie the two in a cycle. A box left behind has to
// catch up before anything reads its items, type tests included, so the
// catching up has to be reachable from both sides. Nothing here writes a List
// literal — that stays `List.ts`'s alone.
export type WriteLog<ItemType extends AnyType> = {
	// NOTE: `version` counts the writes applied to the Array, and is always the
	// number of entries: entry k says what stood at `positions[k]` before the
	// write that produced version k+1. So undoing from the current version down
	// to the one a box views restores exactly the items that box was answering.
	version: number
	positions: Array<number>
	items: Array<ItemType>
	// NOTE: A run handed to code that may call back into Essence can no longer
	// be written in place — the walk is holding the very Array a callback could
	// write. Sealing is for good rather than for the walk's length: a walk is
	// linear work anyway, so the one copy the next write then makes is paid for,
	// and there is no pinning to unwind on a path that leaves early.
	sealed: boolean
}

// NOTE: What a box says about the run it shares: the log, and the version of it
// this box views. The pair is never written to once built — a box that catches
// up is given a DIFFERENT one — so two boxes viewing the same version share one
// object rather than each carrying a copy of it.
export type LoggedRun<ItemType extends AnyType> = {
	log: WriteLog<ItemType>
	seen: number
}

// NOTE: The fields of a List box this Module touches, named apart from
// `ListType` so that `type.ts` can catch a box up without importing `List.ts`.
export type WrittenList<ItemType extends AnyType> = {
	value: Array<ItemType>
	length?: number
	writes?: LoggedRun<ItemType>
}

// NOTE: A log is minted ONLY where a fresh Array is minted — `replace`'s copy
// path, and the catching up below — and from there it travels with that Array
// to every box the Array is shared with. That is the whole of the invariant: an
// Array nobody else holds may be written in place, and an Array with a log says
// who else is behind on it. An Array whose provenance is unknown carries no log
// and is copied on the first write, which is what every write cost before.
export function freshLog<ItemType extends AnyType>(): WriteLog<ItemType> {
	return { version: 0, positions: [], items: [], sealed: false }
}

// NOTE: THE CATCH-UP. A box whose `seen` is behind the log's version is holding
// an Array that has been written since it looked, so it takes a copy of its own
// view and undoes every write back down to its version. Positions it does not
// view are skipped: a write past the end of a shorter box changes nothing it
// answers for, and one version number can not say which writes a box cares
// about.
//
// NOTE: The copy is SOLE, so the box is given a fresh log at version zero rather
// than none at all. Left logless it would copy a second time on its next write —
// the ping-pong between two versions of one List would pay two copies a turn
// where it pays one today.
//
// NOTE: Written as an early return on the two cheap questions, because every
// reader of every List asks them: the field is absent for every box that never
// met a positional write, and equal versions is what a box that is current says.
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
