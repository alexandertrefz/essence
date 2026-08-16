// NOTE: What JavaScript will let a name be — the rules a GENERATED file has to
// obey, wherever one is generated. A declaration file names an export and a
// wrapper Module binds one, and both meet the same Essence: `ok?` is an export
// nothing can be spelled after, `default` is a word nothing can be named.
//
// NOTE: The Rewriter's `escapeName` answers a related question and not this one.
// It decides what the BUNDLE binds a name as, and a generated file has to spell
// the name a host actually imports — so a wrapper reads `$module["ok?"]` and
// exports it under the string, rather than renaming the Module's exports to
// whatever JavaScript found easier.

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// NOTE: The words a declaration can not be named after. Deliberately the whole
// reserved set rather than the subset that happens to be illegal in each
// position — a generated file is read at least as often as it is compiled, and
// `let let` is not worth the two names it saves.
const RESERVED_WORDS = new Set([
	"arguments",
	"await",
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
	"eval",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"package",
	"private",
	"protected",
	"public",
	"return",
	"static",
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
])

// NOTE: TypeScript's own Type names on top of those. `type string = …` declares
// a name nothing can refer to afterwards, so a Module exporting one is left
// undeclared rather than declared unreachably.
const TYPE_KEYWORDS = new Set([
	"any",
	"bigint",
	"boolean",
	"never",
	"number",
	"object",
	"string",
	"symbol",
	"undefined",
	"unknown",
])

export function isValueName(name: string): boolean {
	return IDENTIFIER.test(name) && !RESERVED_WORDS.has(name)
}

export function isTypeName(name: string): boolean {
	return isValueName(name) && !TYPE_KEYWORDS.has(name)
}

// NOTE: A member of an object — written plainly where it can be, quoted where
// it can not. `toString` is an ordinary member name and `ok?` is a string.
export function memberName(name: string): string {
	return isValueName(name) ? name : JSON.stringify(name)
}

// NOTE: A local binding for a name JavaScript can not spell — `ok?` becomes
// `ok_3f_`, which is a name, and the export it hangs off carries the real one as
// a string. Every character JavaScript refuses is spelled as its code point, so
// two names can not mangle to one.
export function mangled(name: string): string {
	return [...name]
		.map((character) =>
			/[A-Za-z0-9_$]/.test(character)
				? character
				: `_${character.codePointAt(0)!.toString(16)}_`,
		)
		.join("")
}
