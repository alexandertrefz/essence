import type { EssenceRational } from "./rational"

// NOTE: What a JavaScript caller may HAND the boundary where the Module declared
// `T` — as opposed to what it gets back, which is `T` itself. The two differ in
// exactly one place: an Integer comes out as a `bigint`, always, so a call's Type
// does not depend on how big its answer was; but going in the interpreter takes
// a safe `number` as readily, and hands both to the runtime's own canonicaliser.
// A declaration that said `bigint` at a Parameter would send every caller
// through `BigInt(i)` to satisfy a checker the runtime never needed satisfied.
//
// NOTE: A mapped Type rather than a second declaration of every alias, so that a
// Parameter still reads `Input<Rectangle>` and hovers to the shape, rather than
// spelling a Record out at every place it is passed. It walks what a value
// walks: down a List, into a Record's members, across the arms of a Union (a
// naked `T` distributes) — and it stops where marshalling does. A Rational is a
// class and crosses as itself. A Function is not widened, because a callback
// going in is CALLED by the Module: its Parameters are the Module's own values
// coming out, and its declared shape is already the one whoever writes it
// really answers.
export type Input<T> = T extends bigint
	? bigint | number
	: T extends EssenceRational
		? T
		: T extends (...args: never) => unknown
			? T
			: T extends ReadonlyArray<infer Item>
				? Array<Input<Item>>
				: T extends object
					? { [Key in keyof T]: Input<T[Key]> }
					: T
