// The failures of reaching an Essence Module, told apart by whose mistake each
// is. `EssenceCompileError` is in `compile-error.ts`, since this file is imported
// by `marshal-runtime.ts`, which runs where no compiler exists.

// A value that does not fit the Type on the other side of the boundary, in
// either direction. `path` says where, as in `argument 2 → .items[0].width`, so
// a host need not parse the message.
export class EssenceMarshalError extends Error {
	readonly path: string
	// Set when the value was recognised before it was refused, as a Case whose
	// `$case` matched and whose payload did not fit. A refused shape with no
	// JavaScript spelling sets it too. A Union reports such a refusal rather than
	// its own.
	readonly inside: boolean

	constructor(message: string, path = "", inside = false) {
		super(message)

		this.name = "EssenceMarshalError"
		this.path = path
		this.inside = inside
	}
}

// A call the Function's signature does not admit: the wrong number of
// Arguments, labels it does not declare, or no single Overload that fits.
export class EssenceCallError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "EssenceCallError"
	}
}

// A plugin invariant broken while serving, such as the standard library's
// prelude asked for before anything compiled. Every source compiled, so the bug
// is the plugin's and there is no excerpt to show.
export class EssenceBuildError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "EssenceBuildError"
	}
}
