import { bareCaseCollision } from "./bare-cases"
import type {
	CaseDescriptor,
	DeclaredType,
	Descriptor,
	ExportDescriptor,
	FunctionDescriptor,
	Members,
	ModuleDescriptor,
	NamespaceDescriptor,
} from "./descriptor"
import { labelsOf, lastRequiredIndex } from "./marshal-runtime"
import { isTypeName, isValueName, mangled, memberName } from "./names"

// A Module as TypeScript, printed from the Descriptor the interpreter marshals
// by. See "Declaration files" in DEVELOPMENT.md.

export type DeclarationView = "javascript" | "bundle"

export type DeclarationOptions = {
	view?: DeclarationView
	// The file name the header says the declarations came from.
	moduleName?: string
	// Where the `javascript` view imports the names it borrows from: the
	// package by default, or a path where the package name does not resolve.
	clientSpecifier?: string
	// The Types the Module exports by name, which a `ModuleDescriptor` does not
	// carry. Without them every shape is spelled out.
	types?: ReadonlyArray<DeclaredType>
}

const DEFAULT_CLIENT_SPECIFIER = "@essence-lang/client"

// Past this width a declaration takes one line per member or per arm.
const SINGLE_LINE_WIDTH = 80

export function generateDeclarations(
	descriptor: ModuleDescriptor,
	options: DeclarationOptions = {},
): string {
	let view = options.view ?? "javascript"
	let types = options.types ?? []
	let borrowed = createBorrower(declaredNames(descriptor, types))
	let walker = createWalker(types, borrowed.borrow)
	let blocks =
		view === "javascript"
			? javascriptBlocks(descriptor, types, walker)
			: bundleBlocks(descriptor, walker)
	let preamble = [header(view, options.moduleName)]
	let imports = borrowed.imports()

	if (imports.length > 0) {
		preamble.push(
			`import type { ${imports.join(", ")} } from "${
				options.clientSpecifier ?? DEFAULT_CLIENT_SPECIFIER
			}"`,
		)
	}

	return `${[...preamble, ...blocks].join("\n\n")}\n`
}

// The names the file declares, which a name borrowed from this package must
// avoid. A Module may export its own `EssenceRational`, and TypeScript refuses an
// import and a declaration of one name. Both views' names count.
function declaredNames(
	descriptor: ModuleDescriptor,
	types: ReadonlyArray<DeclaredType>,
): Set<string> {
	let names = new Set<string>()

	for (let declared of types) {
		names.add(declared.name)
	}

	for (let [name, entry] of Object.entries(descriptor.exports)) {
		names.add(name)

		if (entry.kind === "overloaded") {
			for (let overload of entry.overloads) {
				names.add(overload.emitted)
			}
		} else if (entry.kind !== "choice") {
			names.add(entry.emitted)
		}
	}

	return names
}

// A borrowed name is spelled as itself, or prefixed with `$` until it is free.
function createBorrower(declared: ReadonlySet<string>): {
	borrow: (name: string) => string
	imports: () => Array<string>
} {
	let taken = new Set(declared)
	let spellings = new Map<string, string>()

	return {
		borrow(name) {
			let spelling = spellings.get(name)

			if (spelling !== undefined) {
				return spelling
			}

			spelling = name

			while (taken.has(spelling)) {
				spelling = `$${spelling}`
			}

			taken.add(spelling)
			spellings.set(name, spelling)

			return spelling
		},
		imports() {
			return [...spellings.entries()]
				.sort(([one], [other]) => (one < other ? -1 : 1))
				.map(([name, spelling]) =>
					spelling === name ? name : `${name} as ${spelling}`,
				)
		},
	}
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

// The Types first and the values after, as a reader expects. TypeScript
// hoists both, so the order is for the reader alone.
function javascriptBlocks(
	descriptor: ModuleDescriptor,
	types: ReadonlyArray<DeclaredType>,
	walker: Walker,
): Array<string> {
	let blocks: Array<string> = []

	for (let declared of types) {
		// TypeScript can not declare a Type under a name that is not an
		// identifier.
		if (!isTypeName(declared.name)) {
			continue
		}

		if (declared.of === null) {
			blocks.push(
				[
					`// '${declared.name}' is a Protocol. A Namespace conforms to one, and no value`,
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

// Only what the emitted Module binds. Types, Choices and Protocols are erased,
// and an Overload set binds each Overload under a name of its own.
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

		if (entry.kind === "choice") {
			continue
		}

		declarations.push(walker.emittedDeclaration(name, entry))
	}

	return [
		// Declared rather than imported, so the file needs nothing from this
		// package.
		[
			"// An Essence value as JavaScript holds it — deliberately opaque. It",
			"// carries its Type on a Symbol the runtime mints, and reading one apart",
			"// or building one is `@essence-lang/runtime`'s to do.",
			"type EssenceValue = object",
		].join("\n"),
		grouped(declarations),
	].filter((block) => block !== "")
}

// #endregion

// #region The walker

// Which way a value crosses a position: in as an Argument, or out as a constant
// or an answer. See "Directions" in DEVELOPMENT.md.
type Direction = "in" | "out"

// The Descriptors nothing may be passed to, as `never`, with the sentence the
// interpreter would throw. A call it would refuse then fails to typecheck.
function inputRefusal(node: Descriptor): string | null {
	let item = optionalItem(node)

	if (item !== null && admitsAbsence(item)) {
		return "never /* an Optional inside an Optional has no JavaScript spelling */"
	}

	return node.kind === "refused" ? `never /* ${node.why} */` : null
}

// A Union with no unambiguous spelling, refused in both directions and inline.
// See "Unions and Cases" in DEVELOPMENT.md.
function unionRefusal(node: Descriptor): string | null {
	let collision = bareCaseCollision(node)

	return collision === null
		? null
		: `never /* '${node.shown}' has no unambiguous JavaScript spelling — ${collision}. Crossing one throws. */`
}

// Whether the two directions print differently, in which case a Parameter
// spells the shape out rather than naming its alias. See "Naming" in
// DEVELOPMENT.md.
function crossesDifferently(node: Descriptor): boolean {
	if (inputRefusal(node) !== null) {
		return true
	}

	switch (node.kind) {
		case "list":
		case "optional":
		// Work prints differently by position, not by direction, so what it
		// holds decides.
		case "future":
		case "started":
			return crossesDifferently(node.of)
		case "dictionary":
			return (
				crossesDifferently(node.key) || crossesDifferently(node.value)
			)
		// A member the callee fills in may be left out going in only.
		case "record":
			return Object.values(node.members).some(
				(member) =>
					member.optional === true || crossesDifferently(member.of),
			)
		case "case":
			return Object.values(node.payload).some(
				(member) =>
					member.optional === true || crossesDifferently(member.of),
			)
		case "union":
			return node.arms.some(crossesDifferently)
		// A Function prints differently where anything it carries does.
		case "function":
			return (
				node.parameters.some((parameter) =>
					crossesDifferently(parameter.of),
				) || crossesDifferently(node.returns)
			)
		default:
			return false
	}
}

// Whether the in-form is wider than the declaration, which is so where an
// Integer is reachable without a Function in the way. A named Type that widens
// is printed as `Input<Name>` at a Parameter.
function widensOnInput(node: Descriptor): boolean {
	switch (node.kind) {
		case "integer":
			return true
		case "list":
		case "optional":
		case "future":
		case "started":
			return widensOnInput(node.of)
		case "dictionary":
			return widensOnInput(node.key) || widensOnInput(node.value)
		case "record":
			return Object.values(node.members).some((member) =>
				widensOnInput(member.of),
			)
		case "case":
			return Object.values(node.payload).some((member) =>
				widensOnInput(member.of),
			)
		case "union":
			return node.arms.some(widensOnInput)
		default:
			return false
	}
}

// What an `Optional` holds, or `null`. A lone `#Value` appears where a constant
// was inferred as the Case rather than the Union.
function optionalItem(node: Descriptor): Descriptor | null {
	switch (node.kind) {
		case "optional":
			return node.of
		case "case":
			return node.optional && node.name === "Value"
				? (node.payload.item?.of ?? null)
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

// Whether an `Optional`'s `#Empty`, and so `undefined`, is reachable here.
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

// An export the bundle binds a name for. An Overload set's Overloads bind names
// of their own, and a Choice binds nothing.
type BoundExport = Exclude<
	ExportDescriptor,
	{ kind: "overloaded" } | { kind: "choice" }
>

type Walker = {
	aliasDeclaration: (name: string, node: Descriptor) => string
	valueDeclaration: (name: string, entry: ExportDescriptor) => string
	emittedDeclaration: (name: string, entry: BoundExport) => string
	// One Overload of a set, which the bundle binds but does not export by itself.
	emittedFunction: (
		name: string,
		emitted: string,
		signature: FunctionDescriptor,
	) => string
}

function createWalker(
	types: ReadonlyArray<DeclaredType>,
	borrow: (name: string) => string,
): Walker {
	// The Types the Module exports by name, keyed by `shown`. See "Naming" in
	// DEVELOPMENT.md.
	let named = new Map<string, string>()

	for (let declared of types) {
		if (declared.of !== null && isTypeName(declared.name)) {
			named.set(declared.of.shown, declared.name)
		}
	}

	function print(node: Descriptor, direction: Direction): string {
		// Before the names, so an alias for a callback is refused where it is
		// passed in.
		if (direction === "in") {
			let refusal = inputRefusal(node)

			if (refusal !== null) {
				return refusal
			}
		}

		// By name only where the name is true in this direction.
		let alias = named.get(node.shown)

		if (
			alias !== undefined &&
			(direction === "out" || !crossesDifferently(node))
		) {
			return direction === "in" && widensOnInput(node)
				? `${borrow("Input")}<${alias}>`
				: alias
		}

		return printBody(node, direction)
	}

	// The shape without the naming table, as an alias's own declaration needs.
	function printBody(node: Descriptor, direction: Direction): string {
		switch (node.kind) {
			// A `bigint` out at every size, and a safe `number` too going in.
			case "integer":
				return direction === "in" ? "bigint | number" : "bigint"
			case "string":
				return "string"
			case "boolean":
				return "boolean"
			case "rational":
				return borrow("EssenceRational")
			case "list":
				return `Array<${print(node.of, direction)}>`
			// A `Map` at every key Type. Bare Case keys print as string literals,
			// as in `Map<"Up" | "Down", bigint>`.
			case "dictionary":
				return `Map<${print(node.key, direction)}, ${print(
					node.value,
					direction,
				)}>`
			case "record":
				return inlined(recordEntries(node.members, direction))
			case "case":
				return printCase(node, direction)
			case "optional":
			case "union":
				return unionParts(node, direction).join(" | ")
			// A Function's Parameters cross against its own direction. See
			// "Directions" in DEVELOPMENT.md.
			case "function":
				return `(${printParameters(
					node.parameters,
					direction === "out" ? "in" : "out",
				)}) => ${printAnswer(node.returns, direction)}`
			// Work anywhere but a call's answer. See "Work" in DEVELOPMENT.md.
			case "future":
			case "started":
				return `never /* a ${node.shown} is work rather than a value, and work crosses only as a call's answer */`
			// What has no mapping yet, such as an unapplied Type Parameter, with
			// the compiler's sentence.
			case "refused":
				return `unknown /* ${node.why} */`
		}
	}

	// `?` marks a member the callee's default fills in, going in only. A member
	// has no order, so it needs no trailing-run rule.
	function recordEntries(
		members: Members,
		direction: Direction,
	): Array<string> {
		return Object.entries(members).map(([name, member]) => {
			let omittable = direction === "in" && member.optional === true

			return `${memberName(name)}${omittable ? "?" : ""}: ${print(
				member.of,
				direction,
			)}`
		})
	}

	// An `Optional`'s Cases are its item and `undefined`, a unit Choice's Case
	// is its bare name, and every other Case carries `$case`. See "Unions and
	// Cases" in DEVELOPMENT.md.
	function printCase(node: CaseDescriptor, direction: Direction): string {
		if (node.optional) {
			let item = node.payload.item

			return node.name === "Empty" || item === undefined
				? "undefined"
				: print(item.of, direction)
		}

		if (node.unitChoice) {
			return JSON.stringify(node.name)
		}

		return inlined([
			`$case: ${JSON.stringify(`${node.choice}#${node.name}`)}`,
			...recordEntries(node.payload, direction),
		])
	}

	// The arms as they cross, in declaration order and without duplicates. Any
	// `Optional` adds its item and one `undefined`, however deep it sits.
	function unionParts(
		node: Extract<Descriptor, { kind: "optional" | "union" }>,
		direction: Direction,
	): Array<string> {
		// Asked here rather than in `print`, because `aliasDeclaration` lays out
		// a Union itself and must refuse it too.
		let refusal = unionRefusal(node)

		if (refusal !== null) {
			return [refusal]
		}

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
					add(item.of)
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

	// What a call answers with, the one position work crosses at, as
	// `compileAnswerOut` marshals it. See "Work" in DEVELOPMENT.md.
	function printAnswer(node: Descriptor, direction: Direction): string {
		if (
			node.kind === "future" ||
			(node.kind === "started" && direction === "out")
		) {
			return `Promise<${print(node.of, direction)}>`
		}

		return print(node, direction)
	}

	// Everything under a Parameter crosses the way the Parameter does, which
	// the caller decides.
	function printParameters(
		parameters: FunctionDescriptor["parameters"],
		direction: Direction,
	): string {
		// `?` only on a trailing run, as TypeScript requires. See "Parameters" in
		// DEVELOPMENT.md.
		let lastRequired = lastRequiredIndex(parameters)

		return parameterNames(parameters)
			.map((name, index) => {
				let parameter = parameters[index]!
				let printed = print(parameter.of, direction)

				if (parameter.optional !== true) {
					return `${name}: ${printed}`
				}

				return index > lastRequired
					? `${name}?: ${printed}`
					: `${name}: ${printed} | undefined`
			})
			.join(", ")
	}

	// A call with one object keyed by the labels, declared exactly where
	// `labelsOf` lets the interpreter answer one.
	function labelledParameters(signature: FunctionDescriptor): string | null {
		let labels = labelsOf(signature)

		if (labels === null) {
			return null
		}

		return `labelled: ${inlined(
			labels.map((label, index) => {
				let parameter = signature.parameters[index]!
				let optional = parameter.optional === true ? "?" : ""

				return `${memberName(label)}${optional}: ${print(
					parameter.of,
					"in",
				)}`
			}),
		)}`
	}

	// #region Declarations

	// Declared in its out-form. See "Naming" in DEVELOPMENT.md.
	function aliasDeclaration(name: string, node: Descriptor): string {
		let head = `export type ${name} =`

		if (node.kind === "union" || node.kind === "optional") {
			return unioned(head, unionParts(node, "out"))
		}

		if (node.kind === "record") {
			return braced(head, recordEntries(node.members, "out"))
		}

		// The body, since the naming table would declare the alias as itself.
		return `${head} ${printBody(node, "out")}`
	}

	function valueDeclaration(name: string, entry: ExportDescriptor): string {
		if (entry.kind === "overloaded") {
			return `${OVERLOADED_NOTICE}${exported(name, "never")}`
		}

		// The object a Choice's Cases are spelled through, under the name of its
		// Type, as in `Shape.Circle({ radius: 3n })`.
		if (entry.kind === "choice") {
			return braced(
				`export declare const ${name}:`,
				caseEntries(entry.cases),
			)
		}

		if (entry.kind === "namespace") {
			let entries = namespaceEntries(entry)

			return isValueName(name)
				? braced(`export declare const ${name}:`, entries)
				: exported(name, inlined(entries))
		}

		if (entry.kind === "function" && isValueName(name)) {
			let returns = printAnswer(entry.of.returns, "out")
			let positional = `export declare function ${name}(${printParameters(
				entry.of.parameters,
				"in",
			)}): ${returns}`
			let labelled = labelledParameters(entry.of)

			return labelled === null
				? positional
				: `${positional}\nexport declare function ${name}(${labelled}): ${returns}`
		}

		if (entry.of.kind === "record" && isValueName(name)) {
			return braced(
				`export declare const ${name}:`,
				recordEntries(entry.of.members, "out"),
			)
		}

		return exported(name, print(entry.of, "out"))
	}

	// A Case with a payload is a generic Function of it, and one without is the
	// value. See "Unions and Cases" in DEVELOPMENT.md.
	function caseEntries(cases: ReadonlyArray<CaseDescriptor>): Array<string> {
		return cases.map((node) => {
			if (Object.keys(node.payload).length === 0) {
				let member = `${memberName(node.name)}: ${printCase(node, "in")}`

				return node.unitChoice ? `readonly ${member}` : member
			}

			let tag = JSON.stringify(`${node.choice}#${node.name}`)

			return `${memberName(node.name)}<Payload_ extends ${inlined(
				recordEntries(node.payload, "in"),
			)}>(payload: Payload_): Payload_ & { $case: ${tag} }`
		})
	}

	// A Namespace is an object of its statics. Its constants only come out. A
	// Case it also declares a member for is left out, as `bindNamespace` lets the
	// member replace the constructor.
	function namespaceEntries(entry: NamespaceDescriptor): Array<string> {
		let declared = new Set([
			...Object.keys(entry.properties),
			...Object.keys(entry.methods),
		])
		let entries = [
			...caseEntries(
				(entry.cases ?? []).filter((node) => !declared.has(node.name)),
			),
			...Object.entries(entry.properties).map(
				([name, property]) =>
					`${memberName(name)}: ${print(property.of, "out")}`,
			),
		]

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
					"in",
				)}): ${printAnswer(method.of.returns, "out")}`,
			)

			let labelled = labelledParameters(method.of)

			if (labelled !== null) {
				entries.push(
					`${memberName(name)}(${labelled}): ${printAnswer(
						method.of.returns,
						"out",
					)}`,
				)
			}
		}

		return entries
	}

	// The bundle's binding under its emitted name, as an opaque `EssenceValue`.
	// Its shapes are the bridge's to build, and TypeScript can not check them.
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

	// The emitted member names, since a member called `prototype` or
	// `constructor` is bound under a mangled one.
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
	"// Overloaded. Which Overload a call means is decided by the Argument\n" +
	"// Types, which a JavaScript value does not carry — calling this throws.\n"

// #endregion

// #region Layout

function inlined(entries: Array<string>): string {
	return entries.length === 0 ? "{}" : `{ ${entries.join("; ")} }`
}

// An object Type after its head, on one line while it fits. Otherwise one
// member per line, with no `;`, since TypeScript reads a line break as one.
function braced(head: string, entries: Array<string>): string {
	if (entries.length === 0) {
		return `${head} {}`
	}

	let line = `${head} ${inlined(entries)}`

	return line.length <= SINGLE_LINE_WIDTH
		? line
		: `${head} {\n\t${entries.join("\n\t")}\n}`
}

// A Union after its head, on one line while it fits, otherwise one arm per
// line, each led by its `|`.
function unioned(head: string, entries: Array<string>): string {
	let line = `${head} ${entries.join(" | ")}`

	return line.length <= SINGLE_LINE_WIDTH
		? line
		: `${head}\n\t| ${entries.join("\n\t| ")}`
}

// One declaration per line, with a blank line around any that takes more, so
// a comment heading one is not read as its neighbour's.
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

// A name such as `ok?` is exported under a string literal from a mangled local.
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

// The Parameter names: labels where TypeScript can read them, and the position
// otherwise. See "Parameters" in DEVELOPMENT.md.
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
