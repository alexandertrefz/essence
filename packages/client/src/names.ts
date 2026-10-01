// The names JavaScript allows in a generated file. A declaration file names an
// export and a wrapper Module binds one, and an Essence name such as `ok?` or
// `default` can be neither.
//
// The Rewriter's `escapeName` picks the name the bundle binds. A generated file
// spells the name a host imports, so a wrapper exports `$module["ok?"]` under
// the string.

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// The words no generated name may be. The whole reserved set applies in every
// position, rather than the subset each position forbids, so the rule stays one.
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

// TypeScript's own Type names. `type string = …` declares a name nothing can
// refer to, so an exported Type of that name is left undeclared.
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

// A member of an object, quoted unless it is a value name.
export function memberName(name: string): string {
	return isValueName(name) ? name : JSON.stringify(name)
}

// A local binding for a name JavaScript can not spell: `ok?` becomes `ok_3f_`.
// Each refused character is spelled as its code point between underscores. An
// Essence name holds no underscore, so no two names mangle to one.
export function mangled(name: string): string {
	return [...name]
		.map((character) =>
			/[A-Za-z0-9_$]/.test(character)
				? character
				: `_${character.codePointAt(0)!.toString(16)}_`,
		)
		.join("")
}
