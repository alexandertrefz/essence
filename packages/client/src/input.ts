import type { EssenceRational } from "./rational"

// What a caller may pass where the Module declared `T`: an Integer may also be a
// safe `number`. See "Input types" in DEVELOPMENT.md.
export type Input<T> = T extends bigint
	? bigint | number
	: T extends EssenceRational
		? T
		: T extends (...args: never) => unknown
			? T
			: T extends Promise<unknown>
				? T
				: T extends ReadonlyArray<infer Item>
					? Array<Input<Item>>
					: T extends ReadonlyMap<infer Key, infer Value>
						? Map<Input<Key>, Input<Value>>
						: T extends object
							? { [Key in keyof T]: Input<T[Key]> }
							: T
