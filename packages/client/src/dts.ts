import {
	displayChoiceName,
	displayGenericName,
	resolveOverloadedMethodName,
} from "@essence-lang/compiler/helpers"
import type { ExportSurface } from "@essence-lang/compiler/modules"
import { escapeName } from "@essence-lang/compiler/rewriter"
import type { common } from "@essence-lang/interfaces"

import { BRIDGE_EXPORTS } from "./bridge"

// NOTE: An Export Surface as TypeScript — `printType`'s sibling, walking the
// same `common.Type` vocabulary and printing the other language. Every rule the
// Marshaller decides a value by is written here as a Type, which is what makes
// the two one boundary rather than two: an Integer marshals to a `bigint` and
// says `bigint`, an `Optional<T>` collapses to `T | undefined` in both.
//
// NOTE: There are TWO views of a Module, because there are two doors into one.
// `loadModule(…).exports` hands over JavaScript — that is the `javascript` view,
// and the whole of the mapping table. The BUNDLE the plugin hands a build
// exports Essence's own values, under the names the Rewriter emitted them as —
// that is the `bundle` view, where every value is opaque and the bridge that
// builds them is declared beside it. A generated declaration file has to
// describe the module it sits next to, so which of the two is asked for is not a
// matter of taste.

export type DeclarationView = "javascript" | "bundle"

export type DeclarationOptions = {
	view?: DeclarationView
	// NOTE: What the header says the declarations came from — a file name, for a
	// reader who found the file without the Module.
	moduleName?: string
	// NOTE: Where `EssenceRational` is imported from — the one name a generated
	// file borrows, and only in the `javascript` view. The package itself by
	// default; a path, where a generated file has to resolve from somewhere the
	// package name does not reach.
	clientSpecifier?: string
}

const DEFAULT_CLIENT_SPECIFIER = "@essence-lang/client"

// NOTE: Past this, a declaration is broken onto one line per member or per arm.
// A Namespace of eight Methods and a Choice of three payloads are the shapes
// that need it — either on one line is the one thing a reader of a generated
// file can not skim.
const SINGLE_LINE_WIDTH = 80

export function generateDeclarations(
	surface: ExportSurface,
	options: DeclarationOptions = {},
): string {
	let view = options.view ?? "javascript"
	let imports = new Set<string>()
	let walker = createWalker(surface, imports)
	let blocks =
		view === "javascript"
			? javascriptBlocks(surface, walker)
			: bundleBlocks(surface, walker)
	let preamble = [header(view, options.moduleName)]

	if (imports.size > 0) {
		preamble.push(
			`import type { ${[...imports].sort().join(", ")} } from "${
				options.clientSpecifier ?? DEFAULT_CLIENT_SPECIFIER
			}"`,
		)
	}

	return `${[...preamble, ...blocks].join("\n\n")}\n`
}

function header(view: DeclarationView, moduleName: string | undefined): string {
	let from = moduleName === undefined ? "Essence" : moduleName
	let what =
		view === "javascript"
			? [
					"// The Module as JavaScript — what `loadModule(…).exports` answers with.",
				]
			: [
					"// The bundle's own exports: Essence values, under the names the Rewriter",
					"// emitted them as, beside the bridge that builds values they accept.",
				]

	return [
		`// Generated from ${from} by @essence-lang/client. Do not edit.`,
		"//",
		...what,
	].join("\n")
}

// #region The JavaScript view

// NOTE: The Types first and the values after — the order a reader wants, and the
// order a hand written declaration file is written in. TypeScript hoists both,
// so nothing here depends on it.
function javascriptBlocks(
	surface: ExportSurface,
	walker: Walker,
): Array<string> {
	let blocks: Array<string> = []

	for (let name of Object.keys(surface.kinds)) {
		if (!walker.declarable(name)) {
			continue
		}

		if (surface.protocols[name] !== undefined) {
			blocks.push(
				[
					`// NOTE: '${name}' is a Protocol. A Namespace conforms to one, and no value`,
					"// is ever of one — there is nothing on this side to hold.",
					`export type ${name} = unknown`,
				].join("\n"),
			)

			continue
		}

		let type = surface.types[name]

		if (type !== undefined) {
			blocks.push(walker.aliasDeclaration(name, type))
		}
	}

	blocks.push(
		grouped(
			Object.entries(surface.values).map(([name, type]) =>
				walker.valueDeclaration(name, type),
			),
		),
	)

	return blocks.filter((block) => block !== "")
}

// #endregion

// #region The bundle view

// NOTE: What the emitted bundle actually binds, and nothing it does not: a Type,
// a Choice and a Protocol are erased before a byte is emitted, so a declaration
// for one would name an export that is not there. An Overload set binds no name
// of its own either — each Overload is its own `name__overload$N`, and those are
// the names a call can reach.
function bundleBlocks(surface: ExportSurface, walker: Walker): Array<string> {
	let declarations: Array<string> = []

	for (let [name, type] of Object.entries(surface.values)) {
		if (isOverloaded(type)) {
			for (let [index, overload] of type.overloads.entries()) {
				declarations.push(
					walker.emittedFunction(
						resolveOverloadedMethodName(name, index),
						overload,
					),
				)
			}

			continue
		}

		declarations.push(walker.emittedDeclaration(name, type))
	}

	return [
		// NOTE: Declared here rather than imported. These declarations sit beside
		// a `.es` file in somebody else's project, and the one thing they need
		// from this package is a single word for "opaque" — importing it would
		// make a generated file depend on a package a build that only ever used
		// the plugin need not have installed.
		[
			"// NOTE: An Essence value as JavaScript holds it — deliberately opaque. It",
			"// carries its Type on a Symbol minted while this bundle was evaluated, so",
			"// nothing outside the bundle can read one apart or build one.",
			"type EssenceValue = object",
		].join("\n"),
		grouped(declarations),
		[
			"// NOTE: The bundle's own runtime. Every Essence value carries its Type on a",
			"// Symbol minted while this bundle was evaluated, so these are the only",
			"// constructors whose values its Functions recognise.",
			...bridgeDeclarations(),
		].join("\n"),
	].filter((block) => block !== "")
}

function bridgeDeclarations(): Array<string> {
	let signatures: Array<[string, string]> = [
		[BRIDGE_EXPORTS.typeKey, "symbol"],
		[
			BRIDGE_EXPORTS.case,
			"(tag: string, payload?: Record<string, EssenceValue>) => EssenceValue",
		],
		[BRIDGE_EXPORTS.integer, "(value: bigint) => EssenceValue"],
		[
			BRIDGE_EXPORTS.rational,
			"(numerator: bigint, denominator: bigint) => EssenceValue",
		],
		[BRIDGE_EXPORTS.string, "(value: string) => EssenceValue"],
		[BRIDGE_EXPORTS.boolean, "(value: boolean) => EssenceValue"],
		[BRIDGE_EXPORTS.list, "(items: Array<EssenceValue>) => EssenceValue"],
		[
			BRIDGE_EXPORTS.record,
			"(fields: Record<string, EssenceValue>) => EssenceValue",
		],
	]

	return signatures.map(
		([name, signature]) => `export declare const ${name}: ${signature}`,
	)
}

// #endregion

// #region The walker

// NOTE: The Type Parameter names that are bound where a Type is being printed. A
// `GenericUse` naming one that is not is printed as `unknown`: TypeScript would
// refuse a name nothing declares, and a generated file that does not compile is
// worth less than one that admits what it does not know.
type Scope = ReadonlySet<string>

const EMPTY_SCOPE: Scope = new Set<string>()

type Walker = {
	// NOTE: Whether a name can be DECLARED as a Type. A Type Alias is reachable
	// only under the name it was written with, and TypeScript has no spelling for
	// one it can not write as an identifier.
	declarable: (name: string) => boolean
	aliasDeclaration: (name: string, type: common.Type) => string
	valueDeclaration: (name: string, type: common.Type) => string
	emittedDeclaration: (name: string, type: common.Type) => string
	// NOTE: One Overload of a set, which is a signature and no Type at all — the
	// set is the Type, and only its members are bound in the bundle.
	emittedFunction: (name: string, signature: common.BaseFunction) => string
}

function createWalker(surface: ExportSurface, imports: Set<string>): Walker {
	// NOTE: The Types this Module exports under a name of their own, by object
	// identity — the Enricher resolves an Alias to ONE Type and every mention of
	// it points at that same object, so a Parameter annotated `Rectangle` IS
	// `surface.types.Rectangle`. Printing the name rather than the shape is what
	// makes a generated file read like the source it came from.
	let named = new Map<common.Type, string>()

	for (let [name, type] of Object.entries(surface.types)) {
		if (isTypeName(name)) {
			named.set(type, name)
		}
	}

	// NOTE: The Types currently being printed, so that one reaching itself is
	// answered rather than followed. Nothing can spell such a Type today —
	// `recursive-type-declaration` refuses a declaration that names itself — so
	// this is what keeps the day they land from being the day this overflows its
	// stack instead of saying what it does not know.
	let printing = new Set<common.Type>()

	function print(type: common.Type, scope: Scope): string {
		let alias = named.get(type)

		if (alias !== undefined) {
			return alias
		}

		if (printing.has(type)) {
			return "unknown /* this Type is defined in terms of itself */"
		}

		printing.add(type)

		try {
			return printBody(type, scope)
		} finally {
			printing.delete(type)
		}
	}

	// NOTE: The shape itself, with the naming table skipped — what a Type Alias'
	// own declaration prints, since looking the name up there would declare it as
	// itself.
	function printBody(type: common.Type, scope: Scope): string {
		switch (type.type) {
			case "Integer":
				return "bigint"
			case "String":
				return "string"
			case "Boolean":
				return "boolean"
			case "Rational":
				imports.add("EssenceRational")

				return "EssenceRational"
			// NOTE: The numeric tower above Rational has no JavaScript to be — a
			// double is neither `√2` nor `π` — and the Marshaller refuses one
			// rather than rounding it. The comment is the whole of what a reader
			// can do about that, so it is carried into the declaration.
			case "Algebraic":
			case "Transcendental":
				return `unknown /* ${type.type} values can not be marshalled yet */`
			case "List":
				return `Array<${print(type.itemType, scope)}>`
			case "GenericList":
				return "Array<unknown>"
			case "Record":
			case "Namespace":
				return inlined(objectEntries(type, scope))
			case "Case":
				return printCase(type, scope)
			case "UnionType":
				return unionMembers(type, scope).join(" | ")
			// TODO: A checked refinement prints as its base, because that is what
			// the Marshaller builds — the predicate is not run at the boundary
			// yet. When it is, this is where the proven Type gets a spelling of
			// its own; TypeScript has no predicates, so a branded Alias is the
			// most one could ever be.
			case "Refinement":
				return print(type.base, scope)
			case "GenericAlias":
				return print(
					type.aliasedType,
					withGenerics(scope, type.generics),
				)
			case "GenericUse": {
				let name = displayGenericName(type.name)

				return scope.has(name)
					? name
					: `unknown /* the Type Parameter ${name} is not in scope here */`
			}
			case "Function":
			case "SimpleMethod":
			case "StaticMethod": {
				let inner = withGenerics(scope, type.generics)

				return `${printGenerics(type.generics)}(${printParameters(
					type.parameterTypes,
					inner,
				)}) => ${print(type.returnType, inner)}`
			}
			// NOTE: Never callable, and deliberately not spelled as TypeScript
			// Overloads — which Overload a call means is decided by the Argument
			// Types, which a JavaScript value does not carry, so `exports` binds
			// the name to a refusal. Declaring the signatures would typecheck a
			// call that throws.
			case "OverloadedMethod":
			case "OverloadedStaticMethod":
				return "never"
			default:
				return "unknown"
		}
	}

	// NOTE: One member per entry rather than one printed object, because whether
	// the object fits on a line is a question only its DECLARATION can answer —
	// the head it hangs off is part of the width. Nested objects stay inline: a
	// Record two levels down that breaks would take its parent's braces with it.
	function objectEntries(
		type: common.RecordType | common.NamespaceType,
		scope: Scope,
	): Array<string> {
		if (type.type === "Record") {
			return Object.entries(type.members).map(
				([name, memberType]) =>
					`${memberName(name)}: ${print(memberType, scope)}`,
			)
		}

		let entries = Object.entries(type.properties).map(
			([name, propertyType]) =>
				`${memberName(name)}: ${print(propertyType, scope)}`,
		)

		for (let [name, methodType] of Object.entries(type.methods)) {
			if (isOverloaded(methodType)) {
				entries.push(
					`${memberName(name)}: never /* overloaded — calling it throws */`,
				)

				continue
			}

			// NOTE: A Namespace's own Type Parameters are hoisted onto every
			// Method that could mention one, since an object Type has nowhere
			// else to declare them.
			let generics = [
				...type.generics.filter(
					(generic) =>
						!methodType.generics.some(
							(own) => own.name === generic.name,
						),
				),
				...methodType.generics,
			]
			let inner = withGenerics(scope, generics)

			entries.push(
				`${memberName(name)}${printGenerics(generics)}(${printParameters(
					methodType.parameterTypes,
					inner,
				)}): ${print(methodType.returnType, inner)}`,
			)
		}

		return entries
	}

	// NOTE: An `Optional` is spelled by its ABSENCE on this side, so its two
	// Cases are not Cases here at all: `#Value` is its item and `#Empty` is
	// `undefined`. Every other Case carries which one it is as a member, under the
	// `$case` the Marshaller writes — the Choice as it was DECLARED and the Case,
	// never the path of the machine that compiled it.
	function printCase(type: common.CaseType, scope: Scope): string {
		if (type.choice === "Optional") {
			let item = type.members.item

			return type.name === "Empty" || item === undefined
				? "undefined"
				: print(item, scope)
		}

		let tag = `${displayChoiceName(type.choice)}#${type.name}`

		return inlined([
			`$case: ${JSON.stringify(tag)}`,
			...Object.entries(type.members).map(
				([name, memberType]) =>
					`${memberName(name)}: ${print(memberType, scope)}`,
			),
		])
	}

	// NOTE: The arms as they cross, in declaration order and deduplicated —
	// `Optional<Integer> | Integer` is one `bigint` on this side, and printing it
	// twice would only ask a reader what the difference was.
	function unionMembers(type: common.UnionType, scope: Scope): Array<string> {
		let parts: Array<string> = []
		let optional = false

		for (let arm of type.types) {
			if (
				arm.type === "Case" &&
				arm.choice === "Optional" &&
				arm.name === "Empty"
			) {
				optional = true

				continue
			}

			parts.push(print(arm, scope))
		}

		if (optional) {
			parts.push("undefined")
		}

		let unique = [...new Set(parts)]

		return unique.length === 0 ? ["never"] : unique
	}

	function printParameters(
		parameters: Array<common.Parameter>,
		scope: Scope,
	): string {
		return parameterNames(parameters)
			.map(
				(name, index) =>
					`${name}: ${print(parameters[index]!.type, scope)}`,
			)
			.join(", ")
	}

	// #region Declarations

	function aliasDeclaration(name: string, type: common.Type): string {
		let generic = type.type === "GenericAlias" ? type : null
		let generics = generic === null ? [] : generic.generics
		let scope = withGenerics(EMPTY_SCOPE, generics)
		let head = `export type ${name}${printGenerics(generics)} =`
		let body = generic === null ? type : generic.aliasedType

		if (body.type === "UnionType") {
			return unioned(head, unionMembers(body, scope))
		}

		if (body.type === "Record" || body.type === "Namespace") {
			return braced(head, objectEntries(body, scope))
		}

		// NOTE: The body, never the name — this IS the declaration of that name,
		// and asking the naming table here would declare it as itself.
		return `${head} ${printBody(body, scope)}`
	}

	function valueDeclaration(name: string, type: common.Type): string {
		let notice = isOverloaded(type)
			? "// NOTE: Overloaded. Which Overload a call means is decided by the Argument\n" +
				"// Types, which a JavaScript value does not carry — calling this throws.\n"
			: ""

		if (isCallable(type) && isValueName(name)) {
			let scope = withGenerics(EMPTY_SCOPE, type.generics)

			return `${notice}export declare function ${name}${printGenerics(
				type.generics,
			)}(${printParameters(
				type.parameterTypes,
				scope,
			)}): ${print(type.returnType, scope)}`
		}

		if (type.type === "Record" || type.type === "Namespace") {
			let entries = objectEntries(type, EMPTY_SCOPE)

			if (isValueName(name)) {
				return `${notice}${braced(
					`export declare const ${name}:`,
					entries,
				)}`
			}
		}

		return `${notice}${exported(name, print(type, EMPTY_SCOPE))}`
	}

	// NOTE: The bundle's binding: the name the Rewriter emitted, and a Type that
	// says only that the value is Essence's. It IS only that — an Integer there is
	// a tagged object holding a `bigint`, keyed by a Symbol this side never sees,
	// and every shape it might have is one the bridge builds rather than one
	// TypeScript can check.
	function emittedDeclaration(name: string, type: common.Type): string {
		if (isCallable(type)) {
			return emittedFunction(name, type)
		}

		let emitted = escapeName(name)
		let notice = emittedNotice(name, emitted)

		if (type.type === "Namespace") {
			return `${notice}${braced(
				`export declare const ${emitted}:`,
				emittedMembers(type),
			)}`
		}

		return `${notice}export declare const ${emitted}: EssenceValue`
	}

	function emittedFunction(
		name: string,
		signature: common.BaseFunction,
	): string {
		let emitted = escapeName(name)

		return `${emittedNotice(name, emitted)}export declare function ${emitted}(${opaqueParameters(
			signature.parameterTypes,
		)}): EssenceValue`
	}

	function emittedNotice(name: string, emitted: string): string {
		return emitted === name
			? ""
			: `// '${name}' as the Rewriter emits it.\n`
	}

	function emittedMembers(type: common.NamespaceType): Array<string> {
		let entries = Object.keys(type.properties).map(
			(name) => `${memberName(name)}: EssenceValue`,
		)

		for (let [name, methodType] of Object.entries(type.methods)) {
			let overloads: Array<[string, common.BaseFunction]> = isOverloaded(
				methodType,
			)
				? methodType.overloads.map((overload, index) => [
						resolveOverloadedMethodName(name, index),
						overload,
					])
				: [[name, methodType]]

			for (let [spelling, signature] of overloads) {
				entries.push(
					`${memberName(spelling)}(${opaqueParameters(
						signature.parameterTypes,
					)}): EssenceValue`,
				)
			}
		}

		return entries
	}

	// #endregion

	return {
		declarable: isTypeName,
		aliasDeclaration,
		valueDeclaration,
		emittedDeclaration,
		emittedFunction,
	}
}

// #endregion

// #region Layout

function inlined(entries: Array<string>): string {
	return entries.length === 0 ? "{}" : `{ ${entries.join("; ")} }`
}

// NOTE: An object Type after its declaration's head, on one line while it fits
// there. A member per line otherwise, with no separator — TypeScript reads a
// newline as one, and a trailing `;` on every line of a generated file is noise
// a reader has to look past.
function braced(head: string, entries: Array<string>): string {
	if (entries.length === 0) {
		return `${head} {}`
	}

	let line = `${head} ${inlined(entries)}`

	return line.length <= SINGLE_LINE_WIDTH
		? line
		: `${head} {\n\t${entries.join("\n\t")}\n}`
}

// NOTE: A Union after its declaration's head, on one line while it fits there.
// One arm per line otherwise, each led by its `|` — which is what makes a Choice
// of three payloads readable and a Union of two words not worth breaking.
function unioned(head: string, entries: Array<string>): string {
	let line = `${head} ${entries.join(" | ")}`

	return line.length <= SINGLE_LINE_WIDTH
		? line
		: `${head}\n\t| ${entries.join("\n\t| ")}`
}

// NOTE: One declaration per line, with a blank line around any that needed more
// than one — a `// NOTE:` above a declaration reads as belonging to the one below
// it, and packed against its neighbour it reads as belonging to that one too.
function grouped(declarations: Array<string>): string {
	let text = ""

	for (let [index, declaration] of declarations.entries()) {
		let separated =
			declaration.includes("\n") ||
			(declarations[index - 1]?.includes("\n") ?? false)

		text +=
			index === 0
				? declaration
				: `${separated ? "\n\n" : "\n"}${declaration}`
	}

	return text
}

// #endregion

// #region Spelling

// NOTE: A name JavaScript can not spell is still an export — `ok?` is one — and
// a module may name its exports with a string literal, which is exactly what
// this is for. The local binding is what the declaration hangs off; the string is
// the name a host imports by.
function exported(name: string, type: string): string {
	if (isValueName(name)) {
		return `export declare const ${name}: ${type}`
	}

	let local = `$export_${mangled(name)}`

	return `declare const ${local}: ${type}\nexport { ${local} as ${JSON.stringify(
		name,
	)} }`
}

function isOverloaded(
	type: common.Type,
): type is common.OverloadedMethodType | common.OverloadedStaticMethodType {
	return (
		type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod"
	)
}

function isCallable(
	type: common.Type,
): type is common.Type & common.BaseFunction {
	return (
		type.type === "Function" ||
		type.type === "SimpleMethod" ||
		type.type === "StaticMethod"
	)
}

function opaqueParameters(parameters: Array<common.Parameter>): string {
	return parameterNames(parameters)
		.map((name) => `${name}: EssenceValue`)
		.join(", ")
}

// NOTE: The Parameter names a signature reads with — its labels, which is what
// the Declaration wrote and what a labelled call passes. A `_` Parameter has
// none, and a name TypeScript would read as something else (`first?` is an
// OPTIONAL Parameter there, silently) is no better than none, so both fall back
// to the position. The fallback is nudged until it is nobody else's name.
function parameterNames(parameters: Array<common.Parameter>): Array<string> {
	let taken = new Set(
		parameters
			.map((parameter) => parameter.name)
			.filter(
				(name): name is string => name !== null && isValueName(name),
			),
	)

	return parameters.map((parameter, index) => {
		if (parameter.name !== null && isValueName(parameter.name)) {
			return parameter.name
		}

		let name = `p${index}`

		while (taken.has(name)) {
			name = `_${name}`
		}

		taken.add(name)

		return name
	})
}

function withGenerics(
	scope: Scope,
	generics: ReadonlyArray<common.GenericDeclaration>,
): Scope {
	let names = genericNames(generics)

	return names.length === 0 ? scope : new Set([...scope, ...names])
}

// NOTE: The bound is dropped. `<ItemType is Comparable>` says the Namespace
// answering for the Type has a `compare`, which is a claim about a Namespace
// rather than about the values — there is nothing for a TypeScript constraint to
// be.
function printGenerics(
	generics: ReadonlyArray<common.GenericDeclaration>,
): string {
	let names = genericNames(generics)

	return names.length === 0 ? "" : `<${names.join(", ")}>`
}

function genericNames(
	generics: ReadonlyArray<common.GenericDeclaration>,
): Array<string> {
	return generics
		.map((generic) => displayGenericName(generic.name))
		.filter(isValueName)
}

function memberName(name: string): string {
	return isValueName(name) ? name : JSON.stringify(name)
}

function mangled(name: string): string {
	return [...name]
		.map((character) =>
			/[A-Za-z0-9_$]/.test(character)
				? character
				: `_${character.codePointAt(0)!.toString(16)}_`,
		)
		.join("")
}

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

function isValueName(name: string): boolean {
	return IDENTIFIER.test(name) && !RESERVED_WORDS.has(name)
}

function isTypeName(name: string): boolean {
	return isValueName(name) && !TYPE_KEYWORDS.has(name)
}

// #endregion
