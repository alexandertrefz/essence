// How emitted code spells an Essence name. It imports nothing from the
// pipeline, so a host such as the debug adapter loads it without the Rewriter.

import { runtimeNamespaceNames } from "./runtimeNamespaces"

// The words a strict-mode JavaScript module can not bind. Essence allows
// many of them as names, even its own keywords as a Parameter's internal name.
export const reservedJavaScriptWords = new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"new",
	"null",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"let",
	"static",
	"implements",
	"interface",
	"package",
	"private",
	"protected",
	"public",
	"await",
	"arguments",
	"eval",
])

// The names emitted code binds or reads for its own use: runtime imports,
// module aliases and globals such as `Object`. A Program may bind them too, so
// `escapeName` mangles the user's. See "Escaped names" in DEVELOPMENT.md.
export const compilerOwnedNames = new Set([
	...runtimeNamespaceNames,
	"$_",
	"$type",
	"$helpers",
	// The test runtime and the names a `tests` section binds.
	"$testing",
	"$context",
	"$tests",
	// The coverage counter of an instrumented Module.
	"$cover",
	// The `Future` module alias, and the context a completing body runs
	// under, which every `start` and `complete` inside it reads.
	"$future",
	"$ctx",
	"Object",
	// A counted walk past the safe range converts its start with `BigInt`.
	"BigInt",
])

// A JavaScript IdentifierName as the specification spells it, so a name
// JavaScript accepts, accents included, is emitted as it is.
const javaScriptIdentifierName =
	/^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u

export function isJavaScriptIdentifierName(name: string): boolean {
	return javaScriptIdentifierName.test(name)
}

// The injective spelling of a name JavaScript can not spell or the compiler
// owns. See "Escaped names" in DEVELOPMENT.md.
export const mangledNamePrefix = "$user_"
const keptMangledCharacter = /^[A-Za-z0-9$]$/

export function mangleName(name: string): string {
	let mangled = mangledNamePrefix

	for (let character of name) {
		mangled += keptMangledCharacter.test(character)
			? character
			: `_${character.codePointAt(0)!.toString(16)}_`
	}

	return mangled
}

// One Essence name as emitted code binds and reads it. Not for member
// positions, which `memberKey` spells. Exported so a host's bindings agree. See
// "Escaped names" in DEVELOPMENT.md.
export function escapeName(name: string): string {
	if (compilerOwnedNames.has(name) || !isJavaScriptIdentifierName(name)) {
		return mangleName(name)
	}

	return reservedJavaScriptWords.has(name) ? `_${name}` : name
}
