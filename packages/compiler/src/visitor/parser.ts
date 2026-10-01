import type { parser } from "@essence-lang/interfaces"

import {
	type ChildVisit,
	childWalks,
	compileEntry,
	type Entry,
	isAtOrBefore,
	type Key,
	type Place,
	type Table,
	type Visit,
	visitChild,
	visitInterleaved,
	visitSectionsBelow,
} from "./table"

// Every kind of the Parser AST. See "Adding a node kind" in DEVELOPMENT.md.
export type ParserNode =
	| parser.Program
	| parser.ImplementationSectionNode
	| parser.TestsSectionNode
	| parser.TestNode
	| parser.TestTableNode
	| parser.TestPropertiesNode
	| parser.SuiteNode
	| parser.TestModifierNode
	| parser.ImportSectionNode
	| parser.ImportGroupNode
	| parser.ImportNode
	| parser.ExportSectionNode
	| parser.ExportGroupNode
	| parser.ExportNode
	| parser.ModuleSpecifierNode
	| parser.ExpressionNode
	| parser.StatementNode
	| parser.CaseMatcherNode
	| parser.PatternNode
	| parser.WildcardMatcherNode
	| parser.LiteralMatcherNode
	| parser.SnapshotNode
	| parser.SimpleMethod
	| parser.StaticMethod
	| parser.OverloadedMethod
	| parser.OverloadedStaticMethod
	| parser.NativeMethodSignatureNode
	| parser.SimpleMethodSignature
	| parser.StaticMethodSignature
	| parser.OverloadedMethodSignatures
	| parser.OverloadedStaticMethodSignatures
	| parser.ConformanceClauseNode
	| parser.WhereConditionNode
	| parser.ProtocolMethodSignatureNode
	| parser.SimpleProtocolMethod
	| parser.StaticProtocolMethod
	| parser.OverloadedProtocolMethod
	| parser.OverloadedStaticProtocolMethod
	| parser.TypeDeclarationNode
	| parser.GenericDeclarationNode
	| parser.FunctionTypeParameterNode
	| parser.FunctionDefinitionNode
	| parser.ParameterNode
	| parser.ArgumentNode

// A dotted key's first step is the member's `name` itself.
const recordMemberSteps = {
	custom(
		steps: Array<parser.IdentifierNode> | undefined,
		member: parser.RecordValueMemberNode,
		visit: Visit,
		state: unknown,
		stops: boolean,
		key: Key,
		place: Place,
	): unknown {
		if (steps === undefined) {
			return undefined
		}

		for (let index = 0; index < steps.length; index++) {
			if (steps[index] === member.name) {
				continue
			}

			let result = visitChild(
				steps[index],
				visit,
				state,
				stops,
				key ?? index,
				place,
			)

			if (result !== undefined) {
				return result
			}
		}

		return undefined
	},
}

// `(name: Type)` labels the Parameter with the name it binds, one Identifier
// in both fields.
const internalName = {
	custom(
		name: parser.IdentifierNode | parser.PatternNode | null,
		parameter: parser.ParameterNode,
		visit: Visit,
		state: unknown,
		stops: boolean,
		key: Key,
		place: Place,
	): unknown {
		if (name === null || name === parameter.externalName) {
			return undefined
		}

		return visitChild(name, visit, state, stops, key, place)
	},
}

// A provided Method's body shares its signature's Parameters and return Type,
// so they are reached through the body when there is one.
const sharedWithBody = {
	custom(
		value: Array<parser.ParameterNode> | parser.TypeDeclarationNode,
		signature: parser.ProtocolMethodSignatureNode,
		visit: Visit,
		state: unknown,
		stops: boolean,
		key: Key,
		place: Place,
	): unknown {
		if (signature.body !== null) {
			return undefined
		}

		if (!Array.isArray(value)) {
			return visitChild(value, visit, state, stops, key, place)
		}

		for (let index = 0; index < value.length; index++) {
			let result = visitChild(
				value[index],
				visit,
				state,
				stops,
				key ?? index,
				place,
			)

			if (result !== undefined) {
				return result
			}
		}

		return undefined
	},
}

const groupsPlace: Place = { field: "groups", container: undefined }

// A forwarded name stands both in `entries` and in its group, and a bare one
// only in `entries`. The bare names and the groups are visited merged by
// Position, which reaches an empty or unfinished group too.
const exportSectionEntries = {
	custom(
		entries: Array<parser.ExportNode>,
		section: parser.ExportSectionNode,
		visit: Visit,
		state: unknown,
		stops: boolean,
		_key: Key,
		place: Place,
	): unknown {
		let groupIndex = 0

		for (let index = 0; index <= entries.length; index++) {
			let entry = entries[index] as parser.ExportNode | undefined

			if (entry !== undefined && entry.source !== null) {
				continue
			}

			while (
				groupIndex < section.groups.length &&
				(entry === undefined ||
					isAtOrBefore(
						section.groups[groupIndex].position.start,
						entry.position.start,
					))
			) {
				let result = visitChild(
					section.groups[groupIndex],
					visit,
					state,
					stops,
					groupIndex,
					groupsPlace,
				)

				groupIndex++

				if (result !== undefined) {
					return result
				}
			}

			let result =
				entry === undefined
					? undefined
					: visitChild(entry, visit, state, stops, index, place)

			if (result !== undefined) {
				return result
			}
		}

		return undefined
	},
}

const sectionsBelow = {
	custom(
		exports: parser.ExportSectionNode | null,
		program: parser.Program,
		visit: Visit,
		state: unknown,
		stops: boolean,
	): unknown {
		return visitSectionsBelow(exports, program.tests, visit, state, stops)
	},
}

const propertyEntry: Entry<parser.NamespacePropertyNode> = {
	name: "node",
	type: "node",
	value: "node",
}

const namespaceProperty = compileEntry(propertyEntry, "properties")

const namespaceMembers = {
	custom(
		_methods: parser.NamespaceMethods,
		namespace: parser.NamespaceDefinitionStatementNode,
		visit: Visit,
		state: unknown,
		stops: boolean,
	): unknown {
		return visitInterleaved(
			namespace,
			namespaceProperty,
			visit,
			state,
			stops,
		)
	},
}

const parserTable: Table<ParserNode> = {
	Program: {
		imports: "node",
		implementation: "node",
		exports: sectionsBelow,
		// Visited with `exports`, in written order.
		tests: "skip",
	},
	ImplementationSection: { nodes: "nodes" },
	TestsSection: { nodes: "nodes" },
	Test: {
		name: "node",
		modifiers: "nodes",
		table: "node",
		properties: "node",
		body: "nodes",
	},
	TestTable: { value: "node", parameters: "nodes" },
	TestProperties: { parameters: "nodes" },
	Suite: { name: "node", modifiers: "nodes", nodes: "nodes" },
	TestModifier: { name: "node", arguments: "nodes" },
	ImportSection: {
		groups: "nodes",
		// The same nodes the groups hold.
		entries: "skip",
	},
	ImportGroup: { source: "node", entries: "nodes" },
	// The group's specifier, reached through the group.
	Import: { name: "node", alias: "node", source: "skip" },
	ExportSection: {
		// Visited from `entries`, in written order.
		groups: "skip",
		entries: exportSectionEntries,
	},
	ExportGroup: { source: "node", entries: "nodes" },
	// A forwarded entry's specifier is its group's.
	Export: { name: "node", alias: "node", source: "skip" },
	ModuleSpecifier: {},
	MethodInvocation: {
		base: "node",
		namespaceSpecifier: "node",
		member: "node",
		arguments: "nodes",
	},
	FunctionInvocation: { name: "node", arguments: "nodes" },
	RecordValue: {
		type: "node",
		members: {
			values: {
				name: "node",
				steps: recordMemberSteps,
				value: "node",
				group: "node",
			},
		},
	},
	StringValue: {},
	InterpolatedStringValue: { segments: { each: { expression: "node" } } },
	IntegerValue: {},
	RationalValue: {},
	BooleanValue: {},
	FunctionValue: { value: "node" },
	ListValue: { values: "nodes" },
	DictionaryValue: { entries: { each: { key: "node", value: "node" } } },
	Lookup: { base: "node", member: "node" },
	MemberPath: { steps: "nodes" },
	Self: {},
	Identifier: {},
	Combination: { lhs: "node", rhs: "node" },
	Match: {
		value: "node",
		returnType: "node",
		handlers: { each: { matcher: "node", guard: "node", body: "nodes" } },
	},
	Define: {
		returnType: "node",
		arms: { each: { value: "node", condition: "node" } },
		otherwise: { fields: { value: "node" } },
	},
	CaseValue: {
		choice: "node",
		typeArguments: "nodes",
		caseName: "node",
		value: "node",
	},
	Start: { expression: "node" },
	Complete: { expression: "node" },
	RefusedValue: { base: "node" },
	CaseMatcher: { choice: "node", caseName: "node", binding: "node" },
	Pattern: {
		members: {
			values: {
				name: "node",
				type: "node",
				value: "node",
				binder: "node",
			},
		},
		binder: "node",
	},
	WildcardMatcher: {},
	LiteralMatcher: { value: "node" },
	ExpectStatement: { matcher: "node", value: "node", snapshot: "node" },
	RequireStatement: { matcher: "node", value: "node", snapshot: "node" },
	Snapshot: { name: "node", value: "node" },
	ConstantDeclarationStatement: { name: "node", type: "node", value: "node" },
	VariableDeclarationStatement: { name: "node", type: "node", value: "node" },
	VariableAssignmentStatement: { name: "node", value: "node" },
	SimpleMethod: { name: "node", method: "node" },
	StaticMethod: { name: "node", method: "node" },
	OverloadedMethod: { name: "node", methods: "nodes" },
	OverloadedStaticMethod: { name: "node", methods: "nodes" },
	NativeMethodSignature: {
		generics: "nodes",
		parameters: "nodes",
		returnType: "node",
	},
	SimpleMethodSignature: { name: "node", signature: "node" },
	StaticMethodSignature: { name: "node", signature: "node" },
	OverloadedMethodSignatures: { name: "node", methods: "nodes" },
	OverloadedStaticMethodSignatures: { name: "node", methods: "nodes" },
	NamespaceDefinitionStatement: {
		name: "node",
		generics: "nodes",
		targetType: "node",
		conformsTo: "nodes",
		// Visited with `methods`, in written order.
		properties: "skip",
		methods: namespaceMembers,
	},
	ConformanceClause: { protocol: "node", conditions: "nodes" },
	WhereCondition: { generic: "node", protocol: "node" },
	ProtocolMethodSignature: {
		parameters: sharedWithBody,
		returnType: sharedWithBody,
		body: "node",
	},
	SimpleProtocolMethod: { name: "node", signature: "node" },
	StaticProtocolMethod: { name: "node", signature: "node" },
	OverloadedProtocolMethod: { name: "node", signatures: "nodes" },
	OverloadedStaticProtocolMethod: { name: "node", signatures: "nodes" },
	ProtocolDeclarationStatement: {
		name: "node",
		conformsTo: "nodes",
		methods: "values",
	},
	ChoiceDeclarationStatement: {
		name: "node",
		generics: "nodes",
		cases: { each: { name: "node", type: "node", defaultValue: "node" } },
	},
	TypeAliasStatement: {
		name: "node",
		generics: "nodes",
		type: "node",
		predicate: "node",
	},
	IfElseStatement: {
		condition: "node",
		trueBody: "nodes",
		falseBody: "nodes",
	},
	IfStatement: { condition: "node", body: "nodes" },
	ReturnStatement: { expression: "node" },
	FunctionStatement: { name: "node", value: "node" },
	OverloadedFunctionStatement: { name: "node", methods: "nodes" },
	GenericDeclarationNode: {
		name: "node",
		constraint: "node",
		defaultType: "node",
	},
	IdentifierTypeDeclaration: { type: "node" },
	RecordTypeDeclaration: {
		members: { values: { name: "node", type: "node" } },
	},
	UnionTypeDeclaration: { types: "nodes" },
	FunctionTypeParameter: { externalName: "node", type: "node" },
	FunctionTypeDeclaration: { parameterTypes: "nodes", returnType: "node" },
	GenericTypeDeclaration: { baseType: "node", generics: "nodes" },
	FunctionDefinition: {
		generics: "nodes",
		parameters: "nodes",
		returnType: "node",
		body: "nodes",
	},
	Parameter: {
		externalName: "node",
		internalName,
		type: "node",
		defaultValue: "node",
	},
	Argument: { name: "node", value: "node" },
}

const walks = childWalks(parserTable)

// Every kind the table names, which is every kind of the tree.
export const parserNodeKinds: ReadonlyArray<string> = Object.keys(parserTable)

// Calls `visit` on each child of `node` in source order, with the walker's
// state, the field holding the child and its index or key there. A walker
// recurses by calling this again from `visit`, and skips a subtree by not
// doing so.
export function forEachParserChild(
	node: ParserNode,
	visit: ChildVisit<ParserNode, undefined, unknown>,
): void
export function forEachParserChild<State>(
	node: ParserNode,
	visit: ChildVisit<ParserNode, State, unknown>,
	state: State,
): void
export function forEachParserChild<State>(
	node: ParserNode,
	visit: ChildVisit<ParserNode, State, unknown>,
	state?: State,
): void {
	walks.forEachChild(node, visit, state as State)
}

// As `forEachParserChild`, but stops at the first child whose visit answers
// anything but `undefined`, and answers that.
export function findParserChild<Result>(
	node: ParserNode,
	visit: ChildVisit<ParserNode, undefined, Result | undefined>,
): Result | undefined
export function findParserChild<State, Result>(
	node: ParserNode,
	visit: ChildVisit<ParserNode, State, Result | undefined>,
	state: State,
): Result | undefined
export function findParserChild<State, Result>(
	node: ParserNode,
	visit: ChildVisit<ParserNode, State, Result | undefined>,
	state?: State,
): Result | undefined {
	return walks.findChild(node, visit, state as State)
}
