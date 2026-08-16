// NOTE: The four ways reaching an Essence Module can go wrong, told apart by
// WHOSE mistake they are: a JavaScript value does not fit the Essence Type it
// was handed to, a Function was called in a way its signature does not allow,
// the build itself was set up in a way that can not work, or the Essence source
// did not compile. A host catching one of these knows which of its own sides to
// look at, which a bare `Error` never says.
//
// NOTE: Three of the four are here and the fourth is in `compile-error.ts`,
// because this file is imported by `marshal-runtime.ts` — the half of the
// boundary that ships to a browser with no Compiler anywhere near it. Nothing
// here may import one. An `EssenceCompileError` renders Diagnostics through the
// Compiler's own renderer, which is exactly what that rule excludes, and it is
// also the one failure that can not happen at run time: by then the sources
// have long since compiled.

// NOTE: A value that does not fit the Type on the other side of the boundary,
// in either direction.
//
// NOTE: `path` says WHERE, as the message already does — `argument 2 →
// .items[0].width`. It is carried apart from the prose so that a host can group,
// match or point an editor at the failure without reading the sentence back
// again, which is the one thing a caught Error's message is bad at.
export class EssenceMarshalError extends Error {
	readonly path: string
	// NOTE: Whether the value was RECOGNISED before it was refused — a Case
	// whose `$case` named this arm and whose payload then did not fit, rather
	// than an arm that never took the value at all. A Union tries its arms in
	// order and answers with one refusal, and this is how it tells "you meant
	// this one and got a member wrong" from "this is not any of them".
	readonly inside: boolean

	constructor(message: string, path = "", inside = false) {
		super(message)

		this.name = "EssenceMarshalError"
		this.path = path
		this.inside = inside
	}
}

// NOTE: A call the Function's signature does not admit — the wrong number of
// Arguments, labels that are not its Parameters', an overloaded export with no
// single answer.
export class EssenceCallError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "EssenceCallError"
	}
}

// NOTE: An invariant of the plugins broken while serving — a file that compiled
// without emitting a Module of its own, the standard library's prelude asked for
// before anything was compiled. Not a compile failure: every source involved
// compiled, and what is wrong is a bug in the plugin rather than anything in a
// file, so there is no excerpt to show and nothing to underline.
export class EssenceBuildError extends Error {
	constructor(message: string) {
		super(message)

		this.name = "EssenceBuildError"
	}
}
