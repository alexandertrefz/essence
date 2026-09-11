/*
 * The standard library's documented surface, read off the parsed sources.
 *
 * Every Namespace, every Method and every Property, with the `§§` block that
 * was written above it already split into a summary, one entry per `@param`
 * and a `@returns` — the Compiler does that splitting for the Language Server,
 * and this asks the same question of the same AST rather than reading the
 * sources with a regular expression. What the editor shows on hover and what
 * this site publishes are then the same text by construction.
 *
 * Signatures are SLICED from the source rather than printed back from the AST.
 * A printer would have to re-decide every spacing question the sources have
 * already answered, and would drift from them the first time it disagreed; a
 * slice is what was written, including the generic bounds and the labels.
 *
 * Nothing here writes anything. `generateStdlibDocs.ts` turns this into pages
 * and `tests/stdlibMembers.spec.ts` holds those pages to account against it.
 */

import { parseStdlibSource } from "@essence-lang/compiler/enricher/stdlib"
import type { common } from "@essence-lang/interfaces"
import { readStdlibFiles } from "@essence-lang/standard-library"

export interface Member {
	/** As written: `add`, `isLessThan`, `PI`. */
	name: string
	kind: "method" | "static method" | "property"
	/** The whole declaration, ready to print — an `overload` block when it is one. */
	signature: string
	/** The `§§` summary. Markdown, as the editor gets it. */
	summary: string
	/**
	 * The documented Parameters, each carrying the Type it was declared with —
	 * the `§§` block names and describes them, the signature is what says what
	 * they take, and a reference needs both in the same row.
	 */
	parameters: Array<{ name: string; type: string; description: string }>
	returns: string | null
	/** Where it sits among its Namespace's members, in written order. */
	order: number
	/** How many overloads it has; 1 for everything else. */
	overloads: number
	/**
	 * How many Parameters the declaration takes — the most any one overload
	 * takes, not the number the `§§` block happens to describe. The gap between
	 * this and `parameters.length` is what says a Method takes something nothing
	 * has been written about.
	 */
	declaredParameters: number
}

export interface Namespace {
	/** As written: `Integer`, `List`. */
	name: string
	/** The `§§` block above the Namespace, where one was written. */
	summary: string | null
	/** Protocol names, with the `where` clause's text when it is conditional. */
	conformsTo: Array<{ protocol: string; condition: string | null }>
	members: Member[]
	fileName: string
}

/** A `§§`-less declaration is a hole in the reference, so it is named as one. */
export interface Undocumented {
	namespace: string
	member: string
}

/**
 * A `type X = A | B` declared in the standard library.
 *
 * `Number` is one, and its cases are the four exact types — which is the fact
 * the reference nests them by. Read from the alias rather than listed by hand,
 * so a tower that grows a case grows the navigation with it.
 */
export interface Alias {
	name: string
	cases: string[]
}

export interface Surface {
	namespaces: Namespace[]
	aliases: Alias[]
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
	let definition =
		entry.nodeType === "NativeMethodSignature" ? entry : entry.value
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

function entriesOf(member: Node): Node[] {
	if (member.methods !== undefined) {
		return member.methods
	}

	return [member.signature ?? member.method]
}

function documentationOf(
	member: Node,
	entries: Node[],
): common.Documentation | null {
	// An `overload` block carries one block for the set; a single Method carries
	// its own, and for a bodied one that sits on the Function rather than on the
	// Method that names it.
	if (member.documentation != null) {
		return member.documentation
	}

	let first = entries[0]

	return first?.documentation ?? first?.value?.documentation ?? null
}

function isStatic(member: Node): boolean {
	return (
		member.nodeType.startsWith("Static") ||
		member.nodeType.startsWith("OverloadedStatic")
	)
}

function renderSignature(
	name: string,
	entries: Node[],
	text: string,
	member: Node,
): string {
	let keyword = isStatic(member) ? "static " : ""

	if (entries.length === 1) {
		return `${keyword}${name}${entrySignature(entries[0]!, text)}`
	}

	// The same shape the sources use, so a reader who opens `Integer.es` after
	// reading the page finds the block they were just looking at. Every line of
	// an entry is indented, not only its first: an entry whose parameters run
	// over several lines is one thing sitting inside the block, and indenting
	// just the line the name is on would leave its parameters hanging outside it.
	let block = entries
		.map((entry) =>
			entrySignature(entry, text)
				.split("\n")
				.map((line) => `\t${line}`)
				.join("\n"),
		)
		.join("\n")

	return `${keyword}overload ${name} {\n${block}\n}`
}

/*
 * The Type a documented Parameter was declared with, as written.
 *
 * A `@param` names a Parameter; the Types live on the entries, and an overload
 * may take the same name at several Types — `firstItem(matches:)` and
 * `firstItem(where:)` differ in exactly that. Every Type the name is declared
 * at is collected and joined, so a row says what the Method actually accepts
 * rather than what its first overload happens to.
 *
 * A Parameter is matched on its external name where it has one, because that is
 * the name a `@param` is written against and the name at the call site.
 */
function parameterType(entries: Node[], text: string, name: string): string {
	let types: string[] = []

	for (let entry of entries) {
		let definition =
			entry.nodeType === "NativeMethodSignature" ? entry : entry.value

		for (let parameter of definition.parameters ?? []) {
			let written =
				parameter.externalName?.content ??
				parameter.internalName?.content

			if (written !== name || parameter.type == null) {
				continue
			}

			let type = sliceSource(text, parameter.type.position)

			if (!types.includes(type)) {
				types.push(type)
			}
		}
	}

	return types.join(" | ")
}

function conformancesOf(node: Node, text: string) {
	return (node.conformsTo ?? []).map((clause: Node) => ({
		protocol: clause.protocol.content,
		condition:
			clause.conditions.length === 0
				? null
				: clause.conditions
						.map((condition: Node) =>
							sliceSource(text, condition.position),
						)
						.join(", "),
	}))
}

export function readSurface(): Surface {
	let namespaces: Namespace[] = []
	let aliases: Alias[] = []
	let undocumented: Undocumented[] = []

	for (let file of readStdlibFiles()) {
		let fileName = file.filePath.split("/").pop() ?? file.filePath
		let { program, diagnostics } = parseStdlibSource(
			file.filePath,
			file.sourceText,
		)

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
			if (node.nodeType === "TypeAliasStatement") {
				// Only a union of plain names; `Optional<ItemType>` and the like have
				// nothing to nest, since a generic parameter is not a type anybody
				// can open a page on.
				let types =
					node.type?.nodeType === "UnionTypeDeclaration"
						? node.type.types
						: []

				aliases.push({
					name: node.name.content,
					cases: types
						.filter(
							(entry: Node) =>
								entry.nodeType === "IdentifierTypeDeclaration",
						)
						.map((entry: Node) => entry.type.content),
				})

				continue
			}

			if (node.nodeType !== "NamespaceDefinitionStatement") {
				continue
			}

			let members: Member[] = []
			let order = 0

			for (let [name, property] of Object.entries<Node>(
				node.properties,
			)) {
				let documentation = property.documentation

				if (documentation == null) {
					undocumented.push({
						namespace: node.name.content,
						member: name,
					})
				}

				members.push({
					declaredParameters: 0,
					name,
					kind: "property",
					signature: `static ${name}${
						property.type == null
							? ""
							: `: ${sliceSource(file.sourceText, property.type.position)}`
					}`,
					summary: documentation?.description ?? "",
					parameters: [],
					returns: null,
					order: order++,
					overloads: 1,
				})
			}

			for (let [name, member] of Object.entries<Node>(node.methods)) {
				let entries = entriesOf(member)
				let documentation = documentationOf(member, entries)

				if (documentation == null) {
					undocumented.push({
						namespace: node.name.content,
						member: name,
					})
				}

				members.push({
					name,
					kind: isStatic(member) ? "static method" : "method",
					signature: renderSignature(
						name,
						entries,
						file.sourceText,
						member,
					),
					summary: documentation?.description ?? "",
					parameters: Object.entries(
						documentation?.parameters ?? {},
					).map(([parameter, description]) => ({
						name: parameter,
						type: parameterType(
							entries,
							file.sourceText,
							parameter,
						),
						description,
					})),
					returns: documentation?.returns ?? null,
					order: order++,
					overloads: entries.length,
					declaredParameters: Math.max(
						...entries.map((entry) => {
							let definition =
								entry.nodeType === "NativeMethodSignature"
									? entry
									: entry.value

							return (definition.parameters ?? []).length
						}),
					),
				})
			}

			namespaces.push({
				name: node.name.content,
				summary: node.documentation?.description ?? null,
				conformsTo: conformancesOf(node, file.sourceText),
				members,
				fileName,
			})
		}
	}

	return { namespaces, aliases, undocumented }
}
