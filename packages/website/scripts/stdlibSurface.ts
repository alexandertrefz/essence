/*
 * The standard library's documented surface, read off the parsed sources.
 *
 * Every declaration the reference publishes — the Namespaces and their
 * members, the Choices, the Type Aliases, the Protocols and the free Function
 * family `loop` — with the `§§` block written above each one already split into
 * a description, one line per `@param`, a `@returns` and the `@example` blocks.
 * The Compiler does that splitting for the Language Server, and this asks the
 * same question of the same AST rather than reading the sources with a regular
 * expression. What the editor shows on hover and what this site publishes are
 * then the same text by construction.
 *
 * Signatures are SLICED from the source rather than printed back from the AST.
 * A printer would have to re-decide every spacing question the sources have
 * already answered, and would drift from them the first time it disagreed; a
 * slice is what was written, including the generic bounds and the labels.
 *
 * Documentation is read per ENTRY. An `overload` block carries one `§§` block
 * for the set and one for each entry, and the `@param` lines sit on the entries
 * — reading only the set's block is what once published 161 overloads with no
 * Parameters at all.
 *
 * On top of what is written, this computes what a conformance hands a Namespace
 * without a line in the file: the Methods a Protocol provides, and the ones a
 * Choice derives. Completion lists those, so the reference has to.
 *
 * Nothing here writes anything. `libraryPages.ts` places this on pages,
 * `generateStdlibDocs.ts` writes them, and `tests/stdlibMembers.spec.ts` holds
 * the written pages to account against it.
 */

import { parseStdlibSource } from "@essence-lang/compiler/enricher/stdlib"
import type { common } from "@essence-lang/interfaces"
import { readStdlibFiles } from "@essence-lang/standard-library"

export interface Documentation {
	/** The description, paragraphs separated by a blank line. Markdown, as the editor gets it. */
	description: string
	returns: string | null
	/** Each `@example` block, its common indentation taken off. */
	examples: string[]
}

export interface Parameter {
	/** The label a call writes — `where`, `defaultingTo` — or `_` for a positional one. */
	label: string
	/** As written. */
	type: string
	/** The `= …` a caller may leave out, as written; null where there is none. */
	default: string | null
	/**
	 * The `@param` line written for this Parameter. Matched by POSITION, the
	 * way the Compiler matches them — the first line documents the first
	 * Parameter — so a line's name is never what decides where it goes.
	 */
	description: string | null
}

/** One signature: a member has one, an `overload` block one per entry. */
export interface Entry {
	/** Name, generics, Parameters and return Type as written: `firstItem(where check: …) -> Optional<ItemType>`. */
	signature: string
	/** Bound to the runtime rather than written in Essence. */
	native: boolean
	generics: Array<{ name: string; bound: string | null }>
	parameters: Parameter[]
	returnType: string
	documentation: Documentation | null
}

export interface Member {
	/** As written: `add`, `isLessThan`, `Pi`. */
	name: string
	kind: "method" | "static method" | "property"
	/**
	 * The block above an `overload`, which speaks for the set. Null for a
	 * member with one entry, whose block is that entry's own.
	 */
	documentation: Documentation | null
	entries: Entry[]
	/** The line the member starts on, for written order. */
	line: number
}

export interface Namespace {
	name: string
	/** `namespace List<infer ItemType> for List<ItemType>` — the conformances are read separately. */
	declaration: string
	/** The `for` Type as written; null for a Namespace with no target (`Terminal`). */
	targetType: string | null
	/** The name the target is built on: `List` for `List<Optional<ItemType>>`. */
	targetHead: string | null
	documentation: Documentation | null
	/** Protocol names, with the `where` clause's text when it is conditional. */
	conformsTo: Array<{ protocol: string; condition: string | null }>
	members: Member[]
	fileName: string
	line: number
}

export interface Choice {
	name: string
	/** The whole `choice … { … }` block, as written. */
	declaration: string
	cases: Array<{ name: string; payload: string | null }>
	documentation: Documentation | null
	fileName: string
	line: number
}

export interface Alias {
	name: string
	/** `NonEmptyList<ItemType>` — the name with its Type Parameters. */
	written: string
	/** The whole `type … = …` line, as written. */
	declaration: string
	/** The Type the alias names, as written. */
	type: string
	/** The name that Type is built on, for anything but a union. */
	base: string | null
	/** The members of a union of plain names. */
	cases: string[]
	/** The `where` clause of a checked refinement; null for an ordinary alias. */
	predicate: string | null
	documentation: Documentation | null
	fileName: string
	line: number
}

export interface ProtocolMethod {
	name: string
	static: boolean
	/** Carries a body, so a conformer answers it without writing it. */
	provided: boolean
	entries: Entry[]
}

export interface Protocol {
	name: string
	/** `protocol Orderable is Comparable` */
	declaration: string
	/** The Protocols this one extends. */
	extends: string[]
	documentation: Documentation | null
	methods: ProtocolMethod[]
	fileName: string
	line: number
}

/** A free Function — `loop` is the only one — and its entries. */
export interface FunctionFamily {
	name: string
	/** `overload function loop` */
	declaration: string
	documentation: Documentation | null
	entries: Entry[]
	fileName: string
	line: number
}

/**
 * A Method a Namespace answers without a line of its own: provided by the body
 * a Protocol wrote, or derived for a Choice from its Cases.
 */
export interface ProvidedMember {
	/** The Namespace that receives it. */
	namespace: string
	name: string
	protocol: string
	/** The conformance's `where` clause, when it is conditional. */
	condition: string | null
	derived: boolean
	static: boolean
	/** The Protocol's own entries, with `Self` written as the Namespace's target. */
	entries: Entry[]
}

/** A `§§`-less declaration is a hole in the reference, so it is named as one. */
export interface Undocumented {
	namespace: string
	member: string
}

export interface Surface {
	namespaces: Namespace[]
	choices: Choice[]
	aliases: Alias[]
	protocols: Protocol[]
	functions: FunctionFamily[]
	provided: ProvidedMember[]
	undocumented: Undocumented[]
}

type Node = Record<string, any>

function sliceSource(text: string, position: common.Position): string {
	let lines = text.split("\n")

	if (position.start.line === position.end.line) {
		return lines[position.start.line - 1]!.slice(
			position.start.column - 1,
			position.end.column - 1,
		)
	}

	let out = [lines[position.start.line - 1]!.slice(position.start.column - 1)]

	for (let line = position.start.line; line < position.end.line - 1; line++) {
		out.push(lines[line]!)
	}

	out.push(lines[position.end.line - 1]!.slice(0, position.end.column - 1))

	return out.join("\n")
}

/*
 * A signature spans several lines when its parameters do, and those lines carry
 * the indentation of being nested inside `declarations { namespace { … } }`.
 * The first line has none of it — the slice starts mid-line — so the block
 * arrives with its continuations pushed several tabs to the right of its own
 * opening. This takes that nesting back off, leaving the indentation the
 * parameters have relative to the declaration, which is the shape to print.
 */
function dedentContinuations(signature: string, indent: number): string {
	let [first, ...rest] = signature.split("\n")

	if (rest.length === 0) {
		return signature
	}

	return [
		first,
		...rest.map((line) => line.replace(new RegExp(`^\t{0,${indent}}`), "")),
	].join("\n")
}

function indentationOf(text: string, line: number): number {
	return /^\t*/.exec(text.split("\n")[line - 1] ?? "")![0]!.length
}

/** A declaration's own text, first character to last, without the nesting it sits in. */
function sliceDeclaration(text: string, position: common.Position): string {
	return dedentContinuations(
		sliceSource(text, position),
		indentationOf(text, position.start.line),
	)
}

/*
 * An `@example` block keeps the spaces written after `§§`, and a block is
 * indented under its tag, so every line arrives with the same few spaces in
 * front. Those come off; the indentation the code has within itself stays.
 */
function dedentExample(lines: string[]): string {
	let indents = lines
		.filter((line) => line.trim() !== "")
		.map((line) => /^[ \t]*/.exec(line)![0]!.length)
	let shared = indents.length === 0 ? 0 : Math.min(...indents)

	return lines
		.map((line) => line.slice(shared).trimEnd())
		.join("\n")
		.replace(/^\n+|\n+$/g, "")
}

function documentationOf(
	documentation: common.Documentation | null | undefined,
): Documentation | null {
	if (documentation == null) {
		return null
	}

	return {
		description: documentation.description,
		returns: documentation.returns,
		// A line arrives as written, `§§` and all.
		examples: documentation.examples.map((example) =>
			dedentExample(
				example.lines.map((line) => line.text.replace(/^\s*§§/, "")),
			),
		),
	}
}

/** `List` for `List<Optional<ItemType>>`; null for a union, a Record or a Function Type. */
function headOf(type: Node | null | undefined): string | null {
	if (type == null) {
		return null
	}

	if (type.nodeType === "IdentifierTypeDeclaration") {
		return type.type.content
	}

	if (type.nodeType === "GenericTypeDeclaration") {
		return headOf(type.baseType)
	}

	return null
}

/** A native entry is its own definition; a bodied one keeps it on the Function literal. */
function definitionOf(entry: Node): Node {
	return entry.nodeType === "NativeMethodSignature" ? entry : entry.value
}

/*
 * One entry of a Method — an overload is several. A body-less signature already
 * ends at its return Type, so its own span is the whole of what to show; a
 * bodied one runs on into its implementation, and is cut at the return Type so
 * that the page shows a signature rather than a copy of the standard library.
 *
 * Both spans begin at the parameter list, which leaves the generics out — and
 * the generics are the half a reader most needs, because that is where the
 * bound is written: `contains<infer ItemType is Equatable>` is the difference
 * between a Method every List has and one a List of Records does not. So the
 * start is pulled back to the `<` when there is one.
 */
function entrySignature(entry: Node, text: string): string {
	let definition = definitionOf(entry)
	let generics = definition.generics ?? []
	let start =
		generics.length === 0
			? entry.position.start
			: {
					line: generics[0].position.start.line,
					column: generics[0].position.start.column - 1,
				}
	let end =
		entry.nodeType === "NativeMethodSignature"
			? entry.position.end
			: definition.returnType.position.end

	return dedentContinuations(
		sliceSource(text, { start, end }),
		indentationOf(text, start.line),
	)
}

/*
 * A Parameter's Type as one line. A Function Type written over several lines
 * is the same Type, and a table cell has no room for the layout.
 */
function oneLineType(type: string): string {
	return type
		.replace(/\s*\n\s*/g, " ")
		.replace(/\(\s+/g, "(")
		.replace(/,?\s+\)/g, ")")
}

function readParameters(
	definition: Node,
	documentation: common.Documentation | null | undefined,
	text: string,
): Parameter[] {
	let lines = documentation?.parameters ?? []

	return (definition.parameters ?? []).map(
		(parameter: Node, index: number): Parameter => ({
			// NOTE: `_ text: String` carries no external name and `count: Integer`
			// reuses one Identifier for both, so a missing external name is the
			// positional one.
			label: parameter.externalName?.content ?? "_",
			type:
				parameter.type == null
					? ""
					: oneLineType(sliceSource(text, parameter.type.position)),
			default:
				parameter.defaultValue == null
					? null
					: sliceSource(text, parameter.defaultValue.position),
			description: lines[index]?.text ?? null,
		}),
	)
}

function readEntry(entry: Node, text: string, prefix: string): Entry {
	let definition = definitionOf(entry)
	let documentation = definition.documentation ?? null

	return {
		signature: `${prefix}${entrySignature(entry, text)}`,
		native: entry.nodeType === "NativeMethodSignature",
		generics: (definition.generics ?? []).map((generic: Node) => ({
			name: generic.name.content,
			bound: generic.constraint?.content ?? null,
		})),
		parameters: readParameters(definition, documentation, text),
		returnType:
			definition.returnType == null
				? ""
				: oneLineType(
						sliceSource(text, definition.returnType.position),
					),
		documentation: documentationOf(documentation),
	}
}

function entriesOf(member: Node): Node[] {
	if (member.methods !== undefined) {
		return member.methods
	}

	return [member.signature ?? member.method]
}

function isStatic(member: Node): boolean {
	return (
		member.nodeType.startsWith("Static") ||
		member.nodeType.startsWith("OverloadedStatic")
	)
}

function readMethod(name: string, member: Node, text: string): Member {
	let isStaticMember = isStatic(member)
	let prefix = `${isStaticMember ? "static " : ""}${name}`

	return {
		name,
		kind: isStaticMember ? "static method" : "method",
		// An `overload` block carries one block for the set; a single Method's
		// block is its entry's, and is read there.
		documentation:
			member.methods === undefined
				? null
				: documentationOf(member.documentation),
		entries: entriesOf(member).map((entry) =>
			readEntry(entry, text, prefix),
		),
		line: member.name.position.start.line,
	}
}

function readProperty(name: string, property: Node, text: string): Member {
	let type =
		property.type == null ? "" : sliceSource(text, property.type.position)

	return {
		name,
		kind: "property",
		documentation: null,
		entries: [
			{
				signature: `static ${name}${type === "" ? "" : `: ${type}`}`,
				native: property.value === null,
				generics: [],
				parameters: [],
				returnType: type,
				documentation: documentationOf(property.documentation),
			},
		],
		line: property.name.position.start.line,
	}
}

function conformancesOf(node: Node, text: string) {
	return (node.conformsTo ?? []).map((clause: Node) => ({
		protocol: clause.protocol.content as string,
		condition:
			clause.conditions.length === 0
				? null
				: (clause.conditions
						.map((condition: Node) =>
							sliceSource(text, condition.position),
						)
						.join(", ") as string),
	}))
}

function readNamespace(node: Node, text: string, fileName: string): Namespace {
	let members = [
		...Object.entries<Node>(node.properties).map(([name, property]) =>
			readProperty(name, property, text),
		),
		...Object.entries<Node>(node.methods).map(([name, member]) =>
			readMethod(name, member, text),
		),
		// Written order, whatever kind of member each is.
	].sort((a, b) => a.line - b.line)

	return {
		name: node.name.content,
		declaration: sliceSource(text, {
			start: node.position.start,
			end: (node.targetType ?? node.name).position.end,
		}),
		targetType:
			node.targetType == null
				? null
				: sliceSource(text, node.targetType.position),
		targetHead: headOf(node.targetType),
		documentation: documentationOf(node.documentation),
		conformsTo: conformancesOf(node, text),
		members,
		fileName,
		line: node.position.start.line,
	}
}

function readChoice(node: Node, text: string, fileName: string): Choice {
	return {
		name: node.name.content,
		declaration: sliceDeclaration(text, node.position),
		cases: node.cases.map((entry: Node) => ({
			name: entry.name.content,
			payload:
				entry.type == null
					? null
					: sliceSource(text, entry.type.position),
		})),
		documentation: documentationOf(node.documentation),
		fileName,
		line: node.position.start.line,
	}
}

function readAlias(node: Node, text: string, fileName: string): Alias {
	let generics: string[] = node.generics.map(
		(generic: Node) => generic.name.content,
	)

	return {
		name: node.name.content,
		written:
			generics.length === 0
				? node.name.content
				: `${node.name.content}<${generics.join(", ")}>`,
		declaration: sliceDeclaration(text, node.position),
		type: sliceSource(text, node.type.position),
		base: headOf(node.type),
		cases:
			node.type.nodeType === "UnionTypeDeclaration"
				? node.type.types
						.filter(
							(entry: Node) =>
								entry.nodeType === "IdentifierTypeDeclaration",
						)
						.map((entry: Node) => entry.type.content)
				: [],
		predicate:
			node.predicate == null
				? null
				: sliceSource(text, node.predicate.position),
		documentation: documentationOf(node.documentation),
		fileName,
		line: node.position.start.line,
	}
}

function readProtocol(node: Node, text: string, fileName: string): Protocol {
	let methods = Object.entries<Node>(node.methods).map(
		([name, method]): ProtocolMethod => {
			let isStaticMethod = isStatic({
				nodeType: method.nodeType.replace(/Protocol/, ""),
			})
			let signatures: Node[] = method.signatures ?? [method.signature]
			let prefix = `${isStaticMethod ? "static " : ""}${name}`

			return {
				name,
				static: isStaticMethod,
				provided: signatures.every(
					(signature) => signature.body != null,
				),
				entries: signatures.map((signature): Entry => {
					let start = signature.position.start

					return {
						// A Protocol's signature is cut at its return Type for the
						// reason a bodied Method's is: a provided one runs on into
						// its body.
						signature: `${prefix}${dedentContinuations(
							sliceSource(text, {
								start,
								end: signature.returnType.position.end,
							}),
							indentationOf(text, start.line),
						)}`,
						native: false,
						generics: [],
						parameters: readParameters(
							signature,
							signature.documentation,
							text,
						),
						returnType: sliceSource(
							text,
							signature.returnType.position,
						),
						documentation: documentationOf(signature.documentation),
					}
				}),
			}
		},
	)
	let clauses = node.conformsTo as Node[]

	return {
		name: node.name.content,
		declaration: sliceSource(text, {
			start: node.position.start,
			end: (clauses.at(-1) ?? node.name).position.end,
		}),
		extends: clauses.map((clause) => clause.protocol.content),
		documentation: documentationOf(node.documentation),
		methods,
		fileName,
		line: node.position.start.line,
	}
}

function readFunctionFamily(
	node: Node,
	text: string,
	fileName: string,
): FunctionFamily {
	return {
		name: node.name.content,
		declaration: sliceSource(text, {
			start: node.position.start,
			end: node.name.position.end,
		}),
		documentation: documentationOf(node.documentation),
		entries: node.methods.map((entry: Node) =>
			readEntry(entry, text, node.name.content),
		),
		fileName,
		line: node.position.start.line,
	}
}

/** `Self` written as the Type the receiving Namespace is for. */
function substituteSelf(entry: Entry, target: string): Entry {
	let replace = (text: string) => text.replace(/\bSelf\b/g, target)

	return {
		...entry,
		signature: replace(entry.signature),
		parameters: entry.parameters.map((parameter) => ({
			...parameter,
			type: replace(parameter.type),
		})),
		returnType: replace(entry.returnType),
	}
}

/*
 * What a Namespace answers without writing it.
 *
 * A conformance brings every provided Method of its Protocol and of every
 * Protocol that one extends — `Orderable` brings `Comparable`'s four
 * inequalities along with its own two — unless the Namespace writes the Method
 * itself, which is what `Integer` does with all six of `Comparable`'s. The
 * condition travels with the Method: a List answers `isLessThan` only where its
 * items are `Comparable`.
 *
 * A Choice needs no conformance for some of it. Every Choice answers `is`,
 * Case against Case; a Choice of payload-free Cases also answers the static
 * `cases()`, and prints its Case names once its Namespace declares `Printable`,
 * with nothing written in the body. Each of the three was checked against the
 * Compiler, not read off a comment.
 */
function computeProvided(
	namespaces: Namespace[],
	choices: Choice[],
	protocols: Protocol[],
): ProvidedMember[] {
	let protocolByName = new Map(
		protocols.map((protocol) => [protocol.name, protocol]),
	)
	let choiceByName = new Map(choices.map((choice) => [choice.name, choice]))
	let lineage = (name: string): string[] => {
		let protocol = protocolByName.get(name)

		if (protocol === undefined) {
			throw new Error(
				`A Namespace conforms to ${name}, which no standard library file declares as a Protocol.`,
			)
		}

		return [name, ...protocol.extends.flatMap(lineage)]
	}
	let requirement = (
		protocolName: string,
		method: string,
	): ProtocolMethod => {
		let found = protocolByName
			.get(protocolName)
			?.methods.find((candidate) => candidate.name === method)

		if (found === undefined) {
			throw new Error(
				`A Choice derives ${protocolName}.${method}, which the Protocol no longer declares.`,
			)
		}

		return found
	}

	let provided: ProvidedMember[] = []

	for (let namespace of namespaces) {
		let answered = new Set(namespace.members.map((member) => member.name))
		let target = namespace.targetType ?? namespace.name
		let add = (
			method: ProtocolMethod,
			protocol: string,
			condition: string | null,
			derived: boolean,
		) => {
			if (answered.has(method.name)) {
				return
			}

			answered.add(method.name)
			provided.push({
				namespace: namespace.name,
				name: method.name,
				protocol,
				condition,
				derived,
				static: method.static,
				entries: method.entries.map((entry) =>
					substituteSelf(entry, target),
				),
			})
		}

		// Only the Namespace over the Choice itself. `NestedOptional` is for an
		// Optional too, but its `is` is the one `Optional`'s Namespace writes.
		let choice =
			namespace.targetHead === namespace.name
				? choiceByName.get(namespace.name)
				: undefined

		if (choice !== undefined) {
			add(requirement("Equatable", "is"), "Equatable", null, true)

			if (choice.cases.every((entry) => entry.payload === null)) {
				if (
					namespace.conformsTo.some(
						(clause) => clause.protocol === "Printable",
					)
				) {
					add(
						requirement("Printable", "toString"),
						"Printable",
						null,
						true,
					)
				}

				add(
					requirement("Enumerable", "cases"),
					"Enumerable",
					null,
					true,
				)
			}
		}

		for (let clause of namespace.conformsTo) {
			for (let name of lineage(clause.protocol)) {
				for (let method of protocolByName.get(name)!.methods) {
					if (method.provided) {
						add(method, name, clause.condition, false)
					}
				}
			}
		}
	}

	return provided
}

export function readSurface(): Surface {
	let namespaces: Namespace[] = []
	let choices: Choice[] = []
	let aliases: Alias[] = []
	let protocols: Protocol[] = []
	let functions: FunctionFamily[] = []

	for (let file of readStdlibFiles()) {
		let fileName = file.filePath.split("/").pop() ?? file.filePath
		let text = file.sourceText
		let { program, diagnostics } = parseStdlibSource(file.filePath, text)

		// A standard library that does not parse is not something to paper over
		// with a partial reference — the pages would silently lose whatever the
		// parser gave up on.
		if (diagnostics.length > 0) {
			throw new Error(
				`${fileName} produced ${diagnostics.length} parse diagnostics; the reference cannot be generated from a source that does not parse.`,
			)
		}

		let section =
			(program as Node).implementation ?? (program as Node).declarations

		for (let node of section?.nodes ?? []) {
			switch (node.nodeType) {
				case "TypeAliasStatement":
					aliases.push(readAlias(node, text, fileName))
					break
				case "ChoiceDeclarationStatement":
					choices.push(readChoice(node, text, fileName))
					break
				case "ProtocolDeclarationStatement":
					protocols.push(readProtocol(node, text, fileName))
					break
				case "NamespaceDefinitionStatement":
					namespaces.push(readNamespace(node, text, fileName))
					break
				case "OverloadedFunctionStatement":
					functions.push(readFunctionFamily(node, text, fileName))
					break
				case "FunctionStatement":
					// Every free Function the library declares today is an entry of
					// `loop`. A single one would need its own reading — its span
					// starts at the keyword, not at the parameter list — and a
					// silent gap in the reference is the worse way to find out.
					throw new Error(
						`${fileName} declares the free Function ${node.name.content}, which stdlibSurface.ts does not read yet.`,
					)
				default:
					break
			}
		}
	}

	let undocumented = namespaces.flatMap((namespace) =>
		namespace.members
			.filter(
				(member) =>
					member.documentation === null &&
					member.entries.every(
						(entry) => entry.documentation === null,
					),
			)
			.map((member) => ({
				namespace: namespace.name,
				member: member.name,
			})),
	)

	return {
		namespaces,
		choices,
		aliases,
		protocols,
		functions,
		provided: computeProvided(namespaces, choices, protocols),
		undocumented,
	}
}
