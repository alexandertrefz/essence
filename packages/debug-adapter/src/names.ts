// The compiler's naming read backwards: what a JavaScript frame or binding is
// called in Essence. Each rule mirrors an injective one in
// `packages/compiler/src/rewriter/rewrite.ts`, so reading it back is exact.
//
// - `$user_` mangling keeps `[A-Za-z0-9$]` and writes any other character as
//   `_<hex>_`. No Essence identifier holds a `_`, which lexes as a Symbol.
// - A reserved word is prefixed with `_`, and an overload ends `__overload$N`.
// - A standard library Method is `$es_<Namespace>_<member>`.
// - A Protocol's provided Method is `$es_<Protocol>__<member>` or
//   `$es_<Protocol>_<n>__<member>`.

const mangledNamePrefix = "$user_"
const stdlibMethodPrefix = "$es_"
const overloadSuffix = /__overload\$\d+$/
const providedMethod = /^([^_]+)(?:_\d+)?__(.+)$/

// The words the Rewriter escapes. A `_new` in a frame is the user's `new`,
// while `_self` is the compiler's receiver.
const reservedJavaScriptWords = new Set([
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

function demangleUserName(mangled: string): string {
	return mangled
		.slice(mangledNamePrefix.length)
		.replace(/_([0-9a-f]+)_/g, (_, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		)
}

import { isSynthesizedName } from "@essence-lang/compiler/helpers"

// One emitted name as the author spelled it. The overload suffix is appended
// to an escaped name, so it comes off first.
export function demangleName(name: string): string {
	let base = name.replace(overloadSuffix, "")

	if (base.startsWith(stdlibMethodPrefix)) {
		let rest = base.slice(stdlibMethodPrefix.length)
		let provided = providedMethod.exec(rest)

		if (provided !== null) {
			return `${provided[1]}.${provided[2]}`
		}

		let separator = rest.indexOf("_")

		if (separator > 0) {
			return `${rest.slice(0, separator)}.${rest.slice(separator + 1)}`
		}

		return rest
	}

	if (base.startsWith(mangledNamePrefix)) {
		return demangleUserName(base)
	}

	if (base.startsWith("_") && reservedJavaScriptWords.has(base.slice(1))) {
		return base.slice(1)
	}

	return base
}

// The forward direction, for `evaluate`: a single identifier the user types is
// retried under its escaped name. Unlike `escapeName`, it leaves names in
// `compilerOwnedNames` unmangled.
export function escapeNameForEvaluation(name: string): string {
	if (reservedJavaScriptWords.has(name)) {
		return `_${name}`
	}

	if (/^[A-Za-z0-9$]+$/.test(name)) {
		return name
	}

	let mangled = mangledNamePrefix

	for (let character of name) {
		mangled += /^[A-Za-z0-9$]$/.test(character)
			? character
			: `_${character.codePointAt(0)!.toString(16)}_`
	}

	return mangled
}

// Whether a binding is the compiler's own rather than the author's, which the
// Variables view leaves out of a scope.
export function isCompilerBinding(name: string): boolean {
	return (
		name === "$type" ||
		name === "$helpers" ||
		name === "$_" ||
		// The binding a Pattern reads its members off, such as
		// `$pattern_6_12`. The names the Pattern binds are the author's and
		// stay.
		isSynthesizedName(name) ||
		name.startsWith(stdlibMethodPrefix) ||
		name.endsWith("__conformance")
	)
}
