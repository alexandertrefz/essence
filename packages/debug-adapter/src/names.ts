// NOTE: The Rewriter's naming, read backwards — what a JavaScript frame or
// binding is called in Essence. Every rule here mirrors one in
// `packages/compiler/src/rewriter/index.ts`, and each is injective there, so
// reading them back cannot guess wrong: `$user_` mangling keeps `[A-Za-z0-9$]`
// and writes every other character as `_<hex>_` (no Essence identifier
// contains `_` — the Lexer reads it as a Symbol); a reserved word is
// `_`-prefixed; an overload is `__overload$N`; a standard library Method is
// `$es_<Namespace>_<member>`.

const mangledNamePrefix = "$user_"
const stdlibMethodPrefix = "$es_"
const overloadSuffix = /__overload\$\d+$/

// NOTE: The same list the Rewriter escapes — a `_new` in a frame is the
// user's `new`, while `_self` (not reserved) is the compiler's receiver.
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

// NOTE: One emitted name, answered as the author spelled it. The overload
// suffix goes first — it is appended to an already-escaped name — and what
// remains is exactly one of the Rewriter's cases, or already the name itself.
export function demangleName(name: string): string {
	let base = name.replace(overloadSuffix, "")

	if (base.startsWith(stdlibMethodPrefix)) {
		let rest = base.slice(stdlibMethodPrefix.length)
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

// NOTE: The forward direction, for `evaluate` — a single identifier the user
// types is retried under the name the emitted JavaScript actually binds.
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

// NOTE: Whether a binding is the compiler's own rather than the author's —
// what the Variables view leaves out of a scope.
export function isCompilerBinding(name: string): boolean {
	return (
		name === "$type" ||
		name === "$helpers" ||
		name === "$_" ||
		name.startsWith(stdlibMethodPrefix) ||
		name.endsWith("__conformance")
	)
}
