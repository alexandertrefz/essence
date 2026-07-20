import type { common, parser } from "../interfaces"

// NOTE: Renaming is resolved on the Parser AST with a lexical Scope model
// that mirrors the Enricher's binding rules — `values` corresponds to the
// Enricher's `members`, `types` to its `types`.
//
// Names that resolve through Types instead of Scopes are covered by two
// additional mechanisms:
//
// - Argument labels: for invocations whose callee is a plain Identifier,
//   the callee's Function Definitions are known lexically, so labels are
//   linked to the Parameters declaring them and rename together with them.
// - Method, property and Record member names: the enriched AST knows which
//   Namespace resolved each Method Invocation and the Record Type of every
//   Lookup base, so those references are bound in a second pass over the
//   typed Program. Record Types are structural — member occurrences are
//   grouped across all Record shapes in the file that share the member and
//   are subset-related (one shape could flow into the other).

export type SymbolSpace = "values" | "types"

export type DeclarationKind =
	| "constant"
	| "variable"
	| "function"
	| "parameter"
	| "namespace"
	| "type"
	| "generic"
	| "method"
	| "staticMethod"
	| "property"
	| "member"
	| "label"

export type Declaration = {
	builtin: boolean
	kind: DeclarationKind
	definition: common.Position | null
	// NOTE: Where the name starts being resolvable. `null` means "anywhere in
	// its Scope" — builtins, and the declaration kinds the Enricher hoists
	// (Functions, Namespaces, Type Aliases), which may be used before their
	// declaration site. Constants and Variables are deliberately not hoisted,
	// so they only become visible after their declaring Statement.
	visibleFrom: common.Cursor | null
	occurrences: Array<common.Position>
}

export type Scope = {
	parent: Scope | null
	values: Map<string, Declaration>
	types: Map<string, Declaration>
}

export type ScopeRange = {
	// NOTE: `null` covers the whole document — only the top level Scope.
	range: common.Position | null
	scope: Scope
}

// NOTE: `write` marks the occurrences that bind a value to the name — its
// declaration and any assignment to it. Everything else reads it. Only
// Document Highlight distinguishes the two; renaming touches both alike.
export type OccurrenceAccess = "read" | "write"

export type Occurrence = {
	name: string
	position: common.Position
	access: OccurrenceAccess
	declaration: Declaration
}

export type RenameIndex = Array<Occurrence>

type RecordMemberSite = {
	names: Array<string>
	members: Array<{ name: string; position: common.Position }>
}

type RecordMemberLookup = {
	names: Array<string>
	name: string
	position: common.Position
}

type WalkContext = {
	index: RenameIndex
	// NOTE: The Function Definitions each value Declaration is known to
	// hold — fed by Function Statements and by Function Values bound through
	// declarations and assignments.
	functionDefinitions: Map<Declaration, Array<parser.FunctionDefinitionNode>>
	// NOTE: Call site label → Declaration, per Function Definition. For a
	// Parameter without an explicit external name the label Declaration is
	// the Parameter's own — renaming one renames both.
	labels: Map<parser.FunctionDefinitionNode, Map<string, Declaration>>
	// NOTE: Labelled arguments are collected during the walk and resolved
	// afterwards, so that invocations of hoisted (or later-assigned)
	// Functions see their labels regardless of statement order.
	pendingLabelReferences: Array<{
		identifier: parser.IdentifierNode
		callee: Declaration
	}>
	// NOTE: Property and Method Declarations per Namespace name — the typed
	// AST identifies resolved Namespaces by name.
	namespaceMembers: Map<string, Map<string, Declaration>>
	// NOTE: Record member declaration sites (literals and Record Type
	// declarations) and member Lookups, grouped structurally after the walk.
	recordSites: Array<RecordMemberSite>
	recordLookups: Array<RecordMemberLookup>
	// NOTE: Every Scope with the Position it spans — lets completion find
	// the names visible at a cursor.
	scopes: Array<ScopeRange>
}

// NOTE: These mirror the top level Scope the Enricher starts from. Builtins
// participate in resolution — so that shadowing works — but are rejected as
// rename targets.
const builtinValues = [
	"__print",
	"String",
	"Boolean",
	"Integer",
	"Fraction",
	"Number",
	"Record",
	"List",
]

const builtinTypes = [
	"Nothing",
	"Boolean",
	"String",
	"Integer",
	"Fraction",
	"Record",
	"Number",
	"List",
]

const reservedWords = new Set([
	"if",
	"else",
	"type",
	"constant",
	"variable",
	"function",
	"static",
	"implementation",
	"overload",
	"match",
	"case",
	"with",
	"namespace",
	"for",
	"infer",
	"true",
	"false",
	"nothing",
])

// NOTE: Anything the Lexer would not produce as a single Identifier Token —
// whitespace, Symbols, String- and Comment-Literals, a leading digit — is
// rejected, as are reserved words.
const forbiddenIdentifierCharacters = /[\s"§(){}[\]<>|/@,.:=\-~_]/

export function isValidIdentifierName(name: string): boolean {
	return (
		name.length > 0 &&
		!forbiddenIdentifierCharacters.test(name) &&
		!/^[0-9]/.test(name) &&
		!reservedWords.has(name)
	)
}

export function findRenameableOccurrence(
	program: parser.Program,
	cursor: common.Cursor,
	enrichedProgram: common.typed.Program | null = null,
): Occurrence | null {
	let occurrence = findOccurrence(program, cursor, enrichedProgram)

	if (occurrence === null || occurrence.declaration.builtin) {
		return null
	}

	return occurrence
}

// NOTE: Unlike renaming, finding references and highlighting are read-only —
// they work on builtins too, so this does not reject them.
export function findOccurrence(
	program: parser.Program,
	cursor: common.Cursor,
	enrichedProgram: common.typed.Program | null = null,
): Occurrence | null {
	return occurrenceAt(buildRenameIndex(program, enrichedProgram), cursor)
}

export function findDefinition(
	program: parser.Program,
	cursor: common.Cursor,
	enrichedProgram: common.typed.Program | null = null,
): common.Position | null {
	let occurrence = occurrenceAt(
		buildRenameIndex(program, enrichedProgram),
		cursor,
	)

	return occurrence?.declaration.definition ?? null
}

export function buildRenameIndex(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null = null,
): RenameIndex {
	return indexProgram(program, enrichedProgram).index
}

export type ProgramIndex = {
	index: RenameIndex
	scopes: Array<ScopeRange>
}

export function indexProgram(
	program: parser.Program,
	enrichedProgram: common.typed.Program | null = null,
): ProgramIndex {
	let context: WalkContext = {
		index: [],
		functionDefinitions: new Map(),
		labels: new Map(),
		pendingLabelReferences: [],
		namespaceMembers: new Map(),
		recordSites: [],
		recordLookups: [],
		scopes: [],
	}

	let topLevelScope = createScope(null)

	context.scopes.push({ range: null, scope: topLevelScope })

	for (let name of builtinValues) {
		topLevelScope.values.set(name, {
			builtin: true,
			kind: name === "__print" ? "function" : "namespace",
			definition: null,
			visibleFrom: null,
			occurrences: [],
		})
	}

	for (let name of builtinTypes) {
		topLevelScope.types.set(name, {
			builtin: true,
			kind: "type",
			definition: null,
			visibleFrom: null,
			occurrences: [],
		})
	}

	walkBody(program.implementation.nodes, topLevelScope, context, {
		hoist: true,
	})

	for (let { identifier, callee } of context.pendingLabelReferences) {
		for (let definition of context.functionDefinitions.get(callee) ?? []) {
			let labelDeclaration = context.labels
				.get(definition)
				?.get(identifier.content)

			if (labelDeclaration !== undefined) {
				record(
					labelDeclaration,
					identifier.content,
					identifier.position,
					context.index,
				)
				break
			}
		}
	}

	if (enrichedProgram !== null) {
		walkTypedBody(enrichedProgram.implementation.nodes, context)
	}

	resolveRecordMembers(context)

	return { index: context.index, scopes: context.scopes }
}

export function occurrenceAt(
	index: RenameIndex,
	cursor: common.Cursor,
): Occurrence | null {
	// NOTE: Identifiers never span lines, and `end.column` is exclusive —
	// it is still included here so that renaming works with the cursor
	// directly behind the Identifier.
	for (let occurrence of index) {
		if (
			occurrence.position.start.line === cursor.line &&
			occurrence.position.start.column <= cursor.column &&
			cursor.column <= occurrence.position.end.column
		) {
			return occurrence
		}
	}

	return null
}

/***********/
/* Scoping */
/***********/

function createScope(parent: Scope | null): Scope {
	return { parent, values: new Map(), types: new Map() }
}

function lookup(
	scope: Scope,
	space: SymbolSpace,
	name: string,
): Declaration | null {
	let searchScope: Scope | null = scope

	while (searchScope !== null) {
		let declaration = searchScope[space].get(name)

		if (declaration !== undefined) {
			return declaration
		}

		searchScope = searchScope.parent
	}

	return null
}

function record(
	declaration: Declaration,
	name: string,
	position: common.Position,
	index: RenameIndex,
	access: OccurrenceAccess = "read",
) {
	declaration.occurrences.push(position)

	index.push({
		name,
		position,
		access,
		declaration,
	})
}

function declareInScope(
	scope: Scope,
	space: SymbolSpace,
	identifier: parser.IdentifierNode,
	kind: DeclarationKind,
	context: WalkContext,
	// NOTE: `null` for the kinds that hoist — see `Declaration.visibleFrom`.
	// Only set when the Declaration is created: a re-declaration is an error
	// the Enricher reports, and the first one is what use sites bound to.
	visibleFrom: common.Cursor | null = null,
): Declaration {
	// NOTE: Re-declarations share the first Declaration — the Enricher
	// reports the duplicate; grouping the occurrences is harmless here.
	let declaration = scope[space].get(identifier.content)

	if (declaration === undefined) {
		declaration = {
			builtin: false,
			kind,
			definition: null,
			visibleFrom,
			occurrences: [],
		}
		scope[space].set(identifier.content, declaration)
	}

	declaration.definition ??= identifier.position

	record(
		declaration,
		identifier.content,
		identifier.position,
		context.index,
		"write",
	)

	return declaration
}

function reference(
	scope: Scope,
	space: SymbolSpace,
	identifier: parser.IdentifierNode,
	context: WalkContext,
	access: OccurrenceAccess = "read",
): Declaration | null {
	let declaration = lookup(scope, space, identifier.content)

	// NOTE: Undeclared names are not recorded — the Enricher reports them.
	if (declaration !== null) {
		record(
			declaration,
			identifier.content,
			identifier.position,
			context.index,
			access,
		)
	}

	return declaration
}

function linkFunctionDefinition(
	declaration: Declaration,
	definition: parser.FunctionDefinitionNode,
	context: WalkContext,
) {
	let definitions = context.functionDefinitions.get(declaration)

	if (definitions === undefined) {
		definitions = []
		context.functionDefinitions.set(declaration, definitions)
	}

	definitions.push(definition)
}

// NOTE: Mirrors the Enricher's `hoistDeclarations`, minus the speculative
// resolution — for renaming, binding a use site to an un-hoistable
// declaration is what the user means anyway.
function hoistDeclarations(
	nodes: Array<parser.ImplementationNode>,
	scope: Scope,
) {
	for (let node of nodes) {
		if (node.nodeType === "TypeAliasStatement") {
			if (!scope.types.has(node.name.content)) {
				scope.types.set(node.name.content, {
					builtin: false,
					kind: "type",
					definition: null,
					visibleFrom: null,
					occurrences: [],
				})
			}
		} else if (
			node.nodeType === "FunctionStatement" ||
			node.nodeType === "NamespaceDefinitionStatement"
		) {
			if (!scope.values.has(node.name.content)) {
				scope.values.set(node.name.content, {
					builtin: false,
					kind:
						node.nodeType === "FunctionStatement"
							? "function"
							: "namespace",
					definition: null,
					visibleFrom: null,
					occurrences: [],
				})
			}
		}
	}
}

// NOTE: Approximates the Position a Body of Statements spans, for scoping
// completion — Bodies carry no Position of their own, only their contained
// nodes do.
function rangeOfBody(
	nodes: Array<parser.ImplementationNode>,
	fallback: common.Position,
): common.Position {
	if (nodes.length === 0) {
		return fallback
	}

	return {
		start: nodes[0].position.start,
		end: nodes[nodes.length - 1].position.end,
	}
}

/***********/
/* Walkers */
/***********/

function walkBody(
	nodes: Array<parser.ImplementationNode>,
	scope: Scope,
	context: WalkContext,
	{ hoist }: { hoist: boolean },
) {
	// NOTE: Only the top level hoists — nested bodies bind in order, exactly
	// like the Enricher.
	if (hoist) {
		hoistDeclarations(nodes, scope)
	}

	for (let node of nodes) {
		walkNode(node, scope, context)
	}
}

function walkNode(
	node: parser.ImplementationNode,
	scope: Scope,
	context: WalkContext,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement": {
			if (node.type !== null) {
				walkTypeDeclaration(node.type, scope, context)
			}

			walkNode(node.value, scope, context)

			let declaration = declareInScope(
				scope,
				"values",
				node.name,
				node.nodeType === "ConstantDeclarationStatement"
					? "constant"
					: "variable",
				context,
				// NOTE: Visible only after the whole Statement — the value is
				// resolved in the Scope as it was before the declaration, so
				// the name cannot refer to itself.
				node.position.end,
			)

			if (node.value.nodeType === "FunctionValue") {
				linkFunctionDefinition(declaration, node.value.value, context)
			}

			return
		}
		case "VariableAssignmentStatement": {
			let declaration = reference(
				scope,
				"values",
				node.name,
				context,
				"write",
			)

			walkNode(node.value, scope, context)

			if (
				declaration !== null &&
				node.value.nodeType === "FunctionValue"
			) {
				linkFunctionDefinition(declaration, node.value.value, context)
			}

			return
		}
		case "FunctionStatement": {
			let declaration = declareInScope(
				scope,
				"values",
				node.name,
				"function",
				context,
			)

			linkFunctionDefinition(declaration, node.value, context)
			walkFunctionDefinition(node.value, scope, context, node.position)
			return
		}
		case "NamespaceDefinitionStatement":
			walkNamespaceDefinition(node, scope, context)
			return
		case "TypeAliasStatement": {
			declareInScope(scope, "types", node.name, "type", context)

			let aliasScope = scopeWithGenerics(node.generics, scope, context)

			walkTypeDeclaration(node.type, aliasScope, context)
			return
		}
		case "IfStatement": {
			walkNode(node.condition, scope, context)

			let bodyScope = childScope(
				scope,
				rangeOfBody(node.body, node.position),
				context,
			)

			walkBody(node.body, bodyScope, context, { hoist: false })
			return
		}
		case "IfElseStatement": {
			walkNode(node.condition, scope, context)

			let trueScope = childScope(
				scope,
				rangeOfBody(node.trueBody, node.position),
				context,
			)
			let falseScope = childScope(
				scope,
				rangeOfBody(node.falseBody, node.position),
				context,
			)

			walkBody(node.trueBody, trueScope, context, { hoist: false })
			walkBody(node.falseBody, falseScope, context, { hoist: false })
			return
		}
		case "ReturnStatement":
			walkNode(node.expression, scope, context)
			return
		case "Identifier":
			reference(scope, "values", node, context)
			return
		case "NativeFunctionInvocation":
			reference(scope, "values", node.name, context)
			walkArguments(node.arguments, scope, context)
			return
		case "MethodInvocation":
			walkNode(node.base, scope, context)

			if (node.namespaceSpecifier !== null) {
				reference(scope, "values", node.namespaceSpecifier, context)
			}

			walkArguments(node.arguments, scope, context)
			return
		case "FunctionInvocation": {
			let callee: Declaration | null = null

			if (node.name.nodeType === "Identifier") {
				callee = reference(scope, "values", node.name, context)
			} else {
				walkNode(node.name, scope, context)
			}

			for (let argument of node.arguments) {
				if (argument.name !== null && callee !== null) {
					context.pendingLabelReferences.push({
						identifier: argument.name,
						callee,
					})
				}

				walkNode(argument.value, scope, context)
			}

			return
		}
		case "Lookup":
			// NOTE: The member resolves through the base's Type — skipped.
			walkNode(node.base, scope, context)
			return
		case "Combination":
			walkNode(node.lhs, scope, context)
			walkNode(node.rhs, scope, context)
			return
		case "Match":
			walkNode(node.value, scope, context)
			walkTypeDeclaration(node.returnType, scope, context)

			for (let handler of node.handlers) {
				walkTypeDeclaration(handler.matcher, scope, context)

				let handlerScope = childScope(
					scope,
					rangeOfBody(handler.body, node.position),
					context,
				)

				walkBody(handler.body, handlerScope, context, {
					hoist: false,
				})
			}

			return
		case "RecordValue":
			if (node.type !== null) {
				walkTypeDeclaration(node.type, scope, context)
			}

			registerRecordSite(Object.values(node.members), context)

			for (let member of Object.values(node.members)) {
				walkNode(member.value, scope, context)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				walkNode(value, scope, context)
			}

			return
		case "FunctionValue":
			walkFunctionDefinition(node.value, scope, context, node.position)
			return
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "FractionValue":
		case "BooleanValue":
		case "NothingValue":
			return
	}
}

function walkArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	scope: Scope,
	context: WalkContext,
) {
	// NOTE: Labels of Method and native invocations resolve through Types —
	// only their values are walked.
	for (let argument of nodeArguments) {
		walkNode(argument.value, scope, context)
	}
}

function childScope(
	parent: Scope,
	range: common.Position,
	context: WalkContext,
): Scope {
	let scope = createScope(parent)

	context.scopes.push({ range, scope })

	return scope
}

function scopeWithGenerics(
	generics: Array<parser.GenericDeclarationNode>,
	scope: Scope,
	context: WalkContext,
): Scope {
	let genericScope = createScope(scope)

	for (let generic of generics) {
		// NOTE: Default Types resolve in the outer Scope, exactly like the
		// Enricher's `resolveGenericDeclarations`.
		if (generic.defaultType !== null) {
			walkTypeDeclaration(generic.defaultType, scope, context)
		}

		declareInScope(
			genericScope,
			"types",
			generic.name,
			"generic",
			context,
			generic.name.position.end,
		)
	}

	return genericScope
}

function walkFunctionDefinition(
	definition: parser.FunctionDefinitionNode,
	scope: Scope,
	context: WalkContext,
	// NOTE: The wrapping FunctionStatement or FunctionValue's Position — it
	// spans the whole Definition including the body's braces, unlike the
	// body's own Statements, which can be empty or dropped by error recovery
	// while the cursor sits inside an incomplete Statement.
	range: common.Position,
) {
	let functionScope = scopeWithGenerics(definition.generics, scope, context)

	context.scopes.push({
		range,
		scope: functionScope,
	})

	let labels = new Map<string, Declaration>()

	context.labels.set(definition, labels)

	for (let parameter of definition.parameters) {
		walkTypeDeclaration(parameter.type, functionScope, context)

		if (parameter.externalName === null) {
			// NOTE: `_` — explicitly label-less.
			declareInScope(
				functionScope,
				"values",
				parameter.internalName,
				"parameter",
				context,
				parameter.internalName.position.end,
			)
		} else if (parameter.externalName === parameter.internalName) {
			// NOTE: The Parser reuses the same Identifier node when the
			// internal name doubles as the call site label — one symbol, so
			// call site labels rename together with the Parameter.
			let declaration = declareInScope(
				functionScope,
				"values",
				parameter.internalName,
				"parameter",
				context,
				parameter.internalName.position.end,
			)

			labels.set(parameter.internalName.content, declaration)
		} else {
			// NOTE: An explicit external name is its own symbol — renaming
			// it never touches the internal Parameter name, and vice versa.
			let labelDeclaration: Declaration = {
				builtin: false,
				kind: "label",
				definition: parameter.externalName.position,
				visibleFrom: null,
				occurrences: [],
			}

			record(
				labelDeclaration,
				parameter.externalName.content,
				parameter.externalName.position,
				context.index,
				"write",
			)
			labels.set(parameter.externalName.content, labelDeclaration)

			declareInScope(
				functionScope,
				"values",
				parameter.internalName,
				"parameter",
				context,
				parameter.internalName.position.end,
			)
		}
	}

	walkTypeDeclaration(definition.returnType, functionScope, context)
	walkBody(definition.body, functionScope, context, { hoist: false })
}

function walkNamespaceDefinition(
	node: parser.NamespaceDefinitionStatementNode,
	scope: Scope,
	context: WalkContext,
) {
	declareInScope(scope, "values", node.name, "namespace", context)

	// NOTE: Property and Method names are declared as Namespace member
	// symbols — the typed pass binds their use sites, which resolve through
	// the Namespace's Type. Same-named Namespaces share one member map.
	let memberDeclarations = context.namespaceMembers.get(node.name.content)

	if (memberDeclarations === undefined) {
		memberDeclarations = new Map()
		context.namespaceMembers.set(node.name.content, memberDeclarations)
	}

	for (let member of Object.values(node.properties)) {
		let declaration = memberDeclarations.get(member.name.content)

		if (declaration === undefined) {
			declaration = {
				builtin: false,
				kind: "property",
				definition: member.name.position,
				visibleFrom: null,
				occurrences: [],
			}
			memberDeclarations.set(member.name.content, declaration)
		}

		record(
			declaration,
			member.name.content,
			member.name.position,
			context.index,
			"write",
		)
	}

	for (let member of Object.values(node.methods)) {
		let declaration = memberDeclarations.get(member.name.content)

		if (declaration === undefined) {
			declaration = {
				builtin: false,
				kind:
					member.nodeType === "StaticMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? "staticMethod"
						: "method",
				definition: member.name.position,
				visibleFrom: null,
				occurrences: [],
			}
			memberDeclarations.set(member.name.content, declaration)
		}

		record(
			declaration,
			member.name.content,
			member.name.position,
			context.index,
			"write",
		)
	}

	let genericScope = scopeWithGenerics(node.generics, scope, context)

	if (node.targetType !== null) {
		walkTypeDeclaration(node.targetType, genericScope, context)
	}

	// NOTE: Properties resolve in the outer Scope — Namespace Generics are
	// only visible to the target Type and the Methods, like in the Enricher.
	for (let property of Object.values(node.properties)) {
		if (property.type !== null) {
			walkTypeDeclaration(property.type, scope, context)
		}

		walkNode(property.value, scope, context)
	}

	for (let member of Object.values(node.methods)) {
		let methods =
			member.nodeType === "OverloadedMethod" ||
			member.nodeType === "OverloadedStaticMethod"
				? member.methods
				: [member.method]

		for (let method of methods) {
			walkFunctionDefinition(
				method.value,
				genericScope,
				context,
				method.position,
			)
		}
	}
}

function walkTypeDeclaration(
	node: parser.TypeDeclarationNode,
	scope: Scope,
	context: WalkContext,
) {
	switch (node.nodeType) {
		case "IdentifierTypeDeclaration":
			reference(scope, "types", node.type, context)
			return
		case "RecordTypeDeclaration":
			registerRecordSite(Object.values(node.members), context)

			for (let member of Object.values(node.members)) {
				walkTypeDeclaration(member.type, scope, context)
			}

			return
		case "UnionTypeDeclaration":
			for (let type of node.types) {
				walkTypeDeclaration(type, scope, context)
			}

			return
		case "FunctionTypeDeclaration":
			for (let parameter of node.parameterTypes) {
				walkTypeDeclaration(parameter.type, scope, context)
			}

			walkTypeDeclaration(node.returnType, scope, context)
			return
		case "GenericTypeDeclaration":
			walkTypeDeclaration(node.baseType, scope, context)

			for (let generic of node.generics) {
				walkTypeDeclaration(generic, scope, context)
			}

			return
	}
}

/******************/
/* Record members */
/******************/

function registerRecordSite(
	members: Array<parser.RecordValueMemberNode | parser.RecordTypeMemberNode>,
	context: WalkContext,
) {
	if (members.length === 0) {
		return
	}

	context.recordSites.push({
		names: members.map((member) => member.name.content),
		members: members.map((member) => ({
			name: member.name.content,
			position: member.name.position,
		})),
	})
}

// NOTE: Record Types are structural — there is no single declaration a
// member belongs to. Member occurrences are grouped across all Record
// shapes that are subset-related (one could flow into the other), so a
// rename touches every site that could observe the member. Two unrelated
// but identically shaped Records rename together — with structural typing
// they are the same Type.
function resolveRecordMembers(context: WalkContext) {
	let shapes = [
		...context.recordSites.map((site) => new Set(site.names)),
		...context.recordLookups.map((lookupSite) => new Set(lookupSite.names)),
	]

	let parents = shapes.map((_, shapeIndex) => shapeIndex)

	function findRoot(shapeIndex: number): number {
		while (parents[shapeIndex] !== shapeIndex) {
			parents[shapeIndex] = parents[parents[shapeIndex]]
			shapeIndex = parents[shapeIndex]
		}

		return shapeIndex
	}

	function isSubset(a: Set<string>, b: Set<string>): boolean {
		for (let name of a) {
			if (!b.has(name)) {
				return false
			}
		}

		return true
	}

	for (let i = 0; i < shapes.length; i++) {
		for (let j = i + 1; j < shapes.length; j++) {
			if (shapes[i].size === 0 || shapes[j].size === 0) {
				continue
			}

			if (
				isSubset(shapes[i], shapes[j]) ||
				isSubset(shapes[j], shapes[i])
			) {
				parents[findRoot(i)] = findRoot(j)
			}
		}
	}

	let declarations = new Map<string, Declaration>()

	function declarationFor(shapeIndex: number, name: string): Declaration {
		let key = `${findRoot(shapeIndex)} ${name}`
		let declaration = declarations.get(key)

		if (declaration === undefined) {
			declaration = {
				builtin: false,
				kind: "member",
				definition: null,
				visibleFrom: null,
				occurrences: [],
			}
			declarations.set(key, declaration)
		}

		return declaration
	}

	// NOTE: Declaration sites first, so `definition` points at one of them
	// instead of at a Lookup.
	context.recordSites.forEach((site, siteIndex) => {
		for (let member of site.members) {
			let declaration = declarationFor(siteIndex, member.name)

			declaration.definition ??= member.position

			record(
				declaration,
				member.name,
				member.position,
				context.index,
				"write",
			)
		}
	})

	context.recordLookups.forEach((lookupSite, lookupIndex) => {
		let declaration = declarationFor(
			context.recordSites.length + lookupIndex,
			lookupSite.name,
		)

		record(declaration, lookupSite.name, lookupSite.position, context.index)
	})
}

/**************/
/* Typed pass */
/**************/

function bindNamespaceMember(
	namespaceName: string,
	memberName: string,
	position: common.Position,
	context: WalkContext,
) {
	// NOTE: Builtin Namespaces have no source declaration — their members
	// stay unbound and are therefore not renameable.
	let declaration = context.namespaceMembers
		.get(namespaceName)
		?.get(memberName)

	if (declaration !== undefined) {
		record(declaration, memberName, position, context.index)
	}
}

function walkTypedBody(
	nodes: Array<common.typed.ImplementationNode>,
	context: WalkContext,
) {
	for (let node of nodes) {
		walkTypedNode(node, context)
	}
}

function walkTypedArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	context: WalkContext,
) {
	for (let argument of nodeArguments) {
		walkTypedNode(argument.value, context)
	}
}

function walkTypedNode(
	node: common.typed.ImplementationNode,
	context: WalkContext,
) {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			walkTypedNode(node.value, context)
			return
		case "FunctionStatement":
			walkTypedBody(node.value.body, context)
			return
		case "NamespaceDefinitionStatement":
			for (let property of Object.values(node.properties)) {
				walkTypedNode(property.value, context)
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					walkTypedBody(method.value.body, context)
				}
			}

			return
		case "IfStatement":
			walkTypedNode(node.condition, context)
			walkTypedBody(node.body, context)
			return
		case "IfElseStatement":
			walkTypedNode(node.condition, context)
			walkTypedBody(node.trueBody, context)
			walkTypedBody(node.falseBody, context)
			return
		case "ReturnStatement":
			walkTypedNode(node.expression, context)
			return
		case "NativeFunctionInvocation":
			walkTypedArguments(node.arguments, context)
			return
		case "MethodInvocation":
			bindNamespaceMember(
				node.namespace.name,
				node.member.name,
				node.member.position,
				context,
			)
			walkTypedNode(node.base, context)
			walkTypedArguments(node.arguments, context)
			return
		case "FunctionInvocation":
			walkTypedNode(node.name, context)
			walkTypedArguments(node.arguments, context)
			return
		case "Lookup": {
			walkTypedNode(node.base, context)

			let baseType = node.base.type

			if (baseType.type === "Namespace") {
				bindNamespaceMember(
					baseType.name,
					node.member.content,
					node.member.position,
					context,
				)
			} else if (baseType.type === "Record") {
				context.recordLookups.push({
					names: Object.keys(baseType.members),
					name: node.member.content,
					position: node.member.position,
				})
			}

			return
		}
		case "Combination":
			walkTypedNode(node.lhs, context)
			walkTypedNode(node.rhs, context)
			return
		case "Match":
			walkTypedNode(node.value, context)

			for (let handler of node.handlers) {
				walkTypedBody(handler.body, context)
			}

			return
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				walkTypedNode(member, context)
			}

			return
		case "ListValue":
			for (let value of node.values) {
				walkTypedNode(value, context)
			}

			return
		case "FunctionValue":
			walkTypedBody(node.value.body, context)
			return
		case "TypeAliasStatement":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "FractionValue":
		case "BooleanValue":
		case "NothingValue":
			return
	}
}
