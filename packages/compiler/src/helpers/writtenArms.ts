import type { common } from "@essence-lang/interfaces"

// The Records a written Union names, inside the Unions it names too. See
// "Undeclared members" in DEVELOPMENT.md.
export function writtenRecords(
	written: Array<common.Type | common.GenericUse>,
): Array<common.RecordType> {
	return written.flatMap((arm) =>
		arm.type === "UnionType"
			? writtenRecords(arm.types)
			: arm.type === "Record"
				? [arm]
				: [],
	)
}

// `keeper` with the arms of `taken`, where either came from a written Union.
// An inferred Union collapses by width alone.
export function carryingArms<Kept extends common.Type | common.GenericUse>(
	keeper: Kept,
	taken: common.Type | common.GenericUse,
): Kept {
	return (keeper.type === "Record" && keeper.writtenArms !== undefined) ||
		(taken.type === "Record" && taken.writtenArms !== undefined)
		? withArmsOf(keeper, taken)
		: keeper
}

// `keeper` with the arms `taken` declares besides its own.
export function withArmsOf<Kept extends common.Type | common.GenericUse>(
	keeper: Kept,
	taken: common.Type | common.GenericUse,
): Kept {
	if (keeper.type !== "Record" || taken.type !== "Record") {
		return keeper
	}

	let arms = new Set([
		...(keeper.writtenArms ?? [keeper]),
		...(taken.writtenArms ?? [taken]),
	])

	return arms.size === 1 ? keeper : { ...keeper, writtenArms: [...arms] }
}
