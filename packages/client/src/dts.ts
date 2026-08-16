import type {
	CaseDescriptor,
	DeclaredType,
	Descriptor,
	ExportDescriptor,
	FunctionDescriptor,
	ModuleDescriptor,
	NamespaceDescriptor,
} from "./descriptor"
import { isTypeName, isValueName, mangled, memberName } from "./names"

// NOTE: A Module as TypeScript, printed off the same Descriptor the interpreter
// marshals by. That is the whole point of it being a Descriptor: every rule a
// value is decided by was written down once, on the Compiler's side of the seam,
// and a declaration file is that same writing read as the other language. An
// Integer marshals to a `bigint` and says `bigint`; an `Optional<T>` collapses to
// `T | undefined` in both, because there is only one node to collapse.
//
// NOTE: There are TWO views of a Module, because a bundler serves two doors into
// one. The wrapper the plugin emits hands over JavaScript — that is the
// `javascript` view, and the whole of the mapping table. Behind it, `?raw` serves
// the emitted Module itself: Essence's own values, under the names the Rewriter
// emitted them as — that is the `bundle` view, where every value is opaque. A
// generated declaration file has to describe the module it sits next to, so which
// of the two is asked for is not a matter of taste.

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
	// NOTE: The Types the Module exports under names of their own, which a
	// `ModuleDescriptor` deliberately does not carry — nothing at run time reads
	// a Type Alias. Without them a declaration is still true, it just spells
	// every shape out where the source had a name for it.
	types?: ReadonlyArray<DeclaredType>
}

const DEFAULT_CLIENT_SPECIFIER = "@essence-lang/client"

// NOTE: Past this, a declaration is broken onto one line per member or per arm.
// A Namespace of eight Methods and a Choice of three payloads are the shapes
// that need it — either on one line is the one thing a reader of a generated
// file can not skim.
const SINGLE_LINE_WIDTH = 80

export function generateDeclarations(
	descriptor: ModuleDescriptor,
	options: DeclarationOptions = {},
): string {
	let view = options.view ?? "javascript"
	let imports = new Set<string>()
	let types = options.types ?? []
	let walker = createWalker(types, imports)
	let blocks =
		view === "javascript"
			? javascriptBlocks(descriptor, types, walker)
			: bundleBlocks(descriptor, walker)
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
			? ["// The Module as JavaScript — marshalled at every boundary."]
			: [
					"// The Module's own exports: Essence values, under the names the",
					"// Rewriter emitted them as. Build one with `@essence-lang/runtime`,",
					"// which the build resolves to the same copy these were built by.",
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
	descriptor: ModuleDescriptor,
	types: ReadonlyArray<DeclaredType>,
	walker: Walker,
): Array<string> {
	let blocks: Array<string> = []

	for (let declared of types) {
		// NOTE: A Type Alias is reachable only under the name it was written
		// with, and TypeScript has no spelling for one it can not write as an
		// identifier.
		if (!isTypeName(declared.name)) {
			continue
		}

		if (declared.of === null) {
			blocks.push(
				[
					`// NOTE: '${declared.name}' is a Protocol. A Namespace conforms to one, and no value`,
					"// is ever of one — there is nothing on this side to hold.",
					`export type ${declared.name} = unknown`,
				].join("\n"),
			)

			continue
		}

		blocks.push(walker.aliasDeclaration(declared.name, declared.of))
	}

	blocks.push(
		grouped(
			Object.entries(descriptor.exports).map(([name, entry]) =>
				walker.valueDeclaration(name, entry),
			),
		),
	)

	return blocks.filter((block) => block !== "")
}

// #endregion

// #region The bundle view

// NOTE: What the emitted Module actually binds, and nothing it does not: a Type,
// a Choice and a Protocol are erased before a byte is emitted, so a declaration
// for one would name an export that is not there. An Overload set binds no name
// of its own either — each Overload is its own `name__overload$N`, and those are
// the names a call can reach.
function bundleBlocks(
	descriptor: ModuleDescriptor,
	walker: Walker,
): Array<string> {
	let declarations: Array<string> = []

	for (let [name, entry] of Object.entries(descriptor.exports)) {
		if (entry.kind === "overloaded") {
			for (let overload of entry.overloads) {
				declarations.push(
					walker.emittedFunction(
						overload.name,
						overload.emitted,
						overload.of,
					),
				)
			}

			continue
		}

		declarations.push(walker.emittedDeclaration(name, entry))
	}

	return [
		// NOTE: Declared here rather than imported. These declarations sit beside
		// a `.es` file in somebody else's project, and the one thing they need
		// from this package is a single word for "opaque" — importing it would
		// make a generated file depend on a package a build that only ever used
		// the plugin need not have installed.
		[
			"// NOTE: An Essence value as JavaScript holds it — deliberately opaque. It",
			"// carries its Type on a Symbol the runtime mints, and reading one apart",
			"// or building one is `@essence-lang/runtime`'s to do.",
			"type EssenceValue = object",
		].join("\n"),
		grouped(declarations),
	].filter((block) => block !== "")
}

// #endregion

// #region The walker

// NOTE: Which way a value at this position CROSSES — into the Module as an
// Argument, or out of it as a constant or an answer. The two are not the same
// Type, because the boundary is not symmetric: coming out a value says what it
// is, and going in it has to be BUILT against what the Module declared. What the
// interpreter has no way to build is therefore uninhabited on the way in and
// perfectly ordinary on the way out — a Type Parameter is the clearest case, and
// a Function the one a host is most likely to try.
type Direction = "in" | "out"

// NOTE: The Descriptors nothing may be passed to, as the one TypeScript Type
// nothing is assignable to. `never` is not a shrug: it makes the call the
// interpreter would throw on fail to typecheck instead, which is the whole reason
// an Overload set is already declared this way.
//
// NOTE: A `refused` node carries the sentence the interpreter throws, so the
// refusal a reader is shown and the refusal a caller would have been given are
// one string. The two rules below are the interpreter's own, stated where the
// Descriptor has a shape rather than a refusal to carry them.
function inputRefusal(node: Descriptor): string | null {
	let item = optionalItem(node)

	if (item !== null && admitsAbsence(item)) {
		return "never /* an Optional inside an Optional has no JavaScript spelling */"
	}

	switch (node.kind) {
		case "refused":
			return `never /* ${node.why} */`
		case "function":
			return "never /* callbacks are not supported yet */"
		default:
			return null
	}
}

// NOTE: Whether anything a value of this Descriptor CARRIES would be refused on
// the way in — a callback member three levels down means no value the declaration
// admits can actually be built. What it decides is whether an in-position use may
// go by name: a Type Alias is declared once, in its permissive out-form, so a
// Parameter naming a tainted one would typecheck the call that always throws.
// Spelling the shape out instead puts the `never` on the member that is the
// mistake.
function containsInputRefusal(node: Descriptor): boolean {
	if (inputRefusal(node) !== null) {
		return true
	}

	switch (node.kind) {
		case "list":
		case "optional":
			return containsInputRefusal(node.of)
		case "record":
			return Object.values(node.members).some(containsInputRefusal)
		case "case":
			return Object.values(node.payload).some(containsInputRefusal)
		case "union":
			return node.arms.some(containsInputRefusal)
		default:
			return false
	}
}

// NOTE: What an `Optional` holds, or `null` where this is not one. The pair
// collapses to a node of its own; a lone `#Value` is met where a `constant thing
// = #Value(3)` was inferred as the Case rather than as the Union an annotation
// would have named.
function optionalItem(node: Descriptor): Descriptor | null {
	switch (node.kind) {
		case "optional":
			return node.of
		case "case":
			return node.optional && node.name === "Value"
				? (node.payload.item ?? null)
				: null
		case "union": {
			for (let arm of node.arms) {
				let item = optionalItem(arm)

				if (item !== null) {
					return item
				}
			}

			return null
		}
		default:
			return null
	}
}

// NOTE: Whether `undefined` is a value of this Descriptor — which is exactly
// whether an `Optional`'s `#Empty` is reachable in it. What it decides is whether
// an `Optional` is about to be put inside another one, and both levels spelled as
// nothing.
function admitsAbsence(node: Descriptor): boolean {
	switch (node.kind) {
		case "optional":
			return true
		case "case":
			return node.optional && node.name === "Empty"
		case "union":
			return node.arms.some(admitsAbsence)
		default:
			return false
	}
}

// NOTE: An export the BUNDLE binds a name for. An Overload set is the one that
// does not — each of its Overloads binds one instead — so the bundle view takes
// them apart before it asks for a declaration.
type BoundExport = Exclude<ExportDescriptor, { kind: "overloaded" }>

type Walker = {
	aliasDeclaration: (name: string, node: Descriptor) => string
	valueDeclaration: (name: string, entry: ExportDescriptor) => string
	emittedDeclaration: (name: string, entry: BoundExport) => string
	// NOTE: One Overload of a set, which is a signature and no export at all —
	// the set is the export, and only its members are bound in the bundle.
	emittedFunction: (
		name: string,
		emitted: string,
		signature: FunctionDescriptor,
	) => string
}

function createWalker(
	types: ReadonlyArray<DeclaredType>,
	imports: Set<string>,
): Walker {
	// NOTE: The Types this Module exports under a name of their own, keyed by
	// the Type as the Compiler PRINTS it — which is the one identity that
	// survives a Descriptor being written down. Printing the name rather than
	// the shape is what makes a generated file read like the source it came
	// from, and two Types that print alike are the same Type to TypeScript
	// anyway, since it decides by shape.
	let named = new Map<string, string>()

	for (let declared of types) {
		if (declared.of !== null && isTypeName(declared.name)) {
			named.set(declared.of.shown, declared.name)
		}
	}

	function print(node: Descriptor, direction: Direction): string {
		// NOTE: Ahead of the naming table, so that a Type Alias for a callback —
		// `type Handler = (_ Integer) -> Integer` — is refused where it is passed
		// IN rather than named there and declared callable somewhere else.
		if (direction === "in") {
			let refusal = inputRefusal(node)

			if (refusal !== null) {
				return refusal
			}
		}

		// NOTE: By name only where the name tells the truth. A declaration is
		// printed once, in its out-form, and a Type whose in-form differs — a
		// callback among its members, a nested Optional — is spelled out at the
		// Parameter instead, so the refusal lands on the member that is the
		// mistake.
		let alias = named.get(node.shown)

		if (
			alias !== undefined &&
			(direction === "out" || !containsInputRefusal(node))
		) {
			return alias
		}

		return printBody(node, direction)
	}

	// NOTE: The shape itself, with the naming table skipped — what a Type Alias'
	// own declaration prints, since looking the name up there would declare it as
	// itself.
	function printBody(node: Descriptor, direction: Direction): string {
		switch (node.kind) {
			case "integer":
				return "bigint"
			case "string":
				return "string"
			case "boolean":
				return "boolean"
			case "rational":
				imports.add("EssenceRational")

				return "EssenceRational"
			case "list":
				return `Array<${print(node.of, direction)}>`
			case "record":
				return inlined(recordEntries(node.members, direction))
			case "case":
				return printCase(node, direction)
			case "optional":
			case "union":
				return unionParts(node, direction).join(" | ")
			// NOTE: Coming OUT only — `inputRefusal` has already answered for
			// the other direction. A Function that comes back is wrapped to
			// marshal around its calls, so the signature printed here is the one
			// a caller really calls — and its own Parameters are values that
			// pass IN.
			case "function":
				return `(${printParameters(node.parameters)}) => ${print(
					node.returns,
					"out",
				)}`
			// NOTE: The numeric tower above Rational, a Type Parameter nothing
			// has applied, and whatever else arrives before its mapping does —
			// each carrying the sentence the Compiler wrote while it still had
			// the Type to name.
			case "refused":
				return `unknown /* ${node.why} */`
		}
	}

	function recordEntries(
		members: Record<string, Descriptor>,
		direction: Direction,
	): Array<string> {
		return Object.entries(members).map(
			([name, member]) =>
				`${memberName(name)}: ${print(member, direction)}`,
		)
	}

	// NOTE: An `Optional` is spelled by its ABSENCE on this side, so its two
	// Cases are not Cases here at all: `#Value` is its item and `#Empty` is
	// `undefined`. Every other Case carries which one it is as a member, under
	// the `$case` the boundary writes — the Choice as it was DECLARED and the
	// Case, never the path of the machine that compiled it.
	function printCase(node: CaseDescriptor, direction: Direction): string {
		if (node.optional) {
			let item = node.payload.item

			return node.name === "Empty" || item === undefined
				? "undefined"
				: print(item, direction)
		}

		return inlined([
			`$case: ${JSON.stringify(`${node.choice}#${node.name}`)}`,
			...recordEntries(node.payload, direction),
		])
	}

	// NOTE: The arms as they cross, in declaration order and deduplicated —
	// `Optional<Integer> | Integer` is one `bigint` on this side, and printing it
	// twice would only ask a reader what the difference was. An `Optional` inside
	// a Union contributes its item and one `undefined`, however deep it sits, so
	// that `Optional<Optional<Integer>>` coming out reads `bigint | undefined`
	// rather than spelling its absence twice.
	function unionParts(
		node: Extract<Descriptor, { kind: "optional" | "union" }>,
		direction: Direction,
	): Array<string> {
		let parts: Array<string> = []
		let absent = false

		function add(arm: Descriptor): void {
			if (arm.kind === "optional") {
				add(arm.of)
				absent = true

				return
			}

			if (arm.kind === "case" && arm.optional) {
				let item = arm.payload.item

				if (arm.name === "Empty" || item === undefined) {
					absent = true
				} else {
					add(item)
				}

				return
			}

			parts.push(print(arm, direction))
		}

		if (node.kind === "optional") {
			add(node)
		} else {
			for (let arm of node.arms) {
				add(arm)
			}
		}

		if (absent) {
			parts.push("undefined")
		}

		let unique = [...new Set(parts)]

		return unique.length === 0 ? ["never"] : unique
	}

	// NOTE: A Parameter is the one position a value goes IN at, and everything
	// under it goes in with it — the item Type of a List Parameter, the member
	// Type of a Record one.
	function printParameters(
		parameters: FunctionDescriptor["parameters"],
	): string {
		return parameterNames(parameters)
			.map(
				(name, index) =>
					`${name}: ${print(parameters[index]!.of, "in")}`,
			)
			.join(", ")
	}

	// #region Declarations

	// NOTE: Declared as it comes OUT. A Type Alias has one spelling and is used
	// in both directions, so a body that crosses differently each way — a
	// callback — is named here in its permissive form and spelled out, with the
	// refusal on it, at the Parameter that would pass one — which is where the
	// mistake actually is. `containsInputRefusal` is what keeps the name off
	// such a Parameter.
	function aliasDeclaration(name: string, node: Descriptor): string {
		let head = `export type ${name} =`

		if (node.kind === "union" || node.kind === "optional") {
			return unioned(head, unionParts(node, "out"))
		}

		if (node.kind === "record") {
			return braced(head, recordEntries(node.members, "out"))
		}

		// NOTE: The body, never the name — this IS the declaration of that name,
		// and asking the naming table here would declare it as itself.
		return `${head} ${printBody(node, "out")}`
	}

	function valueDeclaration(name: string, entry: ExportDescriptor): string {
		if (entry.kind === "overloaded") {
			return `${OVERLOADED_NOTICE}${exported(name, "never")}`
		}

		if (entry.kind === "namespace") {
			let entries = namespaceEntries(entry)

			return isValueName(name)
				? braced(`export declare const ${name}:`, entries)
				: exported(name, inlined(entries))
		}

		if (entry.kind === "function" && isValueName(name)) {
			return `export declare function ${name}(${printParameters(
				entry.of.parameters,
			)}): ${print(entry.of.returns, "out")}`
		}

		if (entry.of.kind === "record" && isValueName(name)) {
			return braced(
				`export declare const ${name}:`,
				recordEntries(entry.of.members, "out"),
			)
		}

		return exported(name, print(entry.of, "out"))
	}

	// NOTE: A Namespace is an object of its statics on this side, so its Methods
	// are members rather than declarations — and its constants come OUT whichever
	// way the Namespace itself was reached, since there is no writing one.
	function namespaceEntries(entry: NamespaceDescriptor): Array<string> {
		let entries = Object.entries(entry.properties).map(
			([name, property]) =>
				`${memberName(name)}: ${print(property.of, "out")}`,
		)

		for (let [name, method] of Object.entries(entry.methods)) {
			if (method.kind === "overloaded") {
				entries.push(
					`${memberName(name)}: never /* overloaded — calling it throws */`,
				)

				continue
			}

			entries.push(
				`${memberName(name)}(${printParameters(
					method.of.parameters,
				)}): ${print(method.of.returns, "out")}`,
			)
		}

		return entries
	}

	// NOTE: The bundle's binding: the name the Rewriter emitted, and a Type that
	// says only that the value is Essence's. It IS only that — an Integer there is
	// a tagged object holding a number or a bigint, keyed by a Symbol this side
	// never sees, and every shape it might have is one the bridge builds rather
	// than one TypeScript can check.
	function emittedDeclaration(name: string, entry: BoundExport): string {
		if (entry.kind === "function") {
			return emittedFunction(name, entry.emitted, entry.of)
		}

		let notice = emittedNotice(name, entry.emitted)

		if (entry.kind === "namespace") {
			return `${notice}${braced(
				`export declare const ${entry.emitted}:`,
				emittedMembers(entry),
			)}`
		}

		return `${notice}export declare const ${entry.emitted}: EssenceValue`
	}

	function emittedFunction(
		name: string,
		emitted: string,
		signature: FunctionDescriptor,
	): string {
		return `${emittedNotice(
			name,
			emitted,
		)}export declare function ${emitted}(${opaqueParameters(
			signature.parameters,
		)}): EssenceValue`
	}

	function emittedNotice(name: string, emitted: string): string {
		return emitted === name
			? ""
			: `// '${name}' as the Rewriter emits it.\n`
	}

	// NOTE: The emitted member names, which are the CLASS's — a member named
	// `prototype` or `constructor` is bound under a mangled one, and a
	// declaration spelling the written name would promise a member the bundle
	// does not have.
	function emittedMembers(entry: NamespaceDescriptor): Array<string> {
		let entries = Object.values(entry.properties).map(
			(property) => `${memberName(property.emitted)}: EssenceValue`,
		)

		for (let method of Object.values(entry.methods)) {
			let overloads =
				method.kind === "overloaded"
					? method.overloads
					: [{ emitted: method.emitted, of: method.of }]

			for (let overload of overloads) {
				entries.push(
					`${memberName(overload.emitted)}(${opaqueParameters(
						overload.of.parameters,
					)}): EssenceValue`,
				)
			}
		}

		return entries
	}

	// #endregion

	return {
		aliasDeclaration,
		valueDeclaration,
		emittedDeclaration,
		emittedFunction,
	}
}

const OVERLOADED_NOTICE =
	"// NOTE: Overloaded. Which Overload a call means is decided by the Argument\n" +
	"// Types, which a JavaScript value does not carry — calling this throws.\n"

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

function opaqueParameters(
	parameters: FunctionDescriptor["parameters"],
): string {
	return parameterNames(parameters)
		.map((name) => `${name}: EssenceValue`)
		.join(", ")
}

// NOTE: The Parameter names a signature reads with — its labels, which is what
// the Declaration wrote and what a labelled call passes. A `_` Parameter has
// none, and a name TypeScript would read as something else (`first?` is an
// OPTIONAL Parameter there, silently) is no better than none, so both fall back
// to the position. The fallback is nudged until it is nobody else's name.
function parameterNames(
	parameters: FunctionDescriptor["parameters"],
): Array<string> {
	let taken = new Set(
		parameters
			.map((parameter) => parameter.label)
			.filter(
				(label): label is string =>
					label !== null && isValueName(label),
			),
	)

	return parameters.map((parameter, index) => {
		if (parameter.label !== null && isValueName(parameter.label)) {
			return parameter.label
		}

		let name = `p${index}`

		while (taken.has(name)) {
			name = `_${name}`
		}

		taken.add(name)

		return name
	})
}

// #endregion
