import type { common } from "@essence-lang/interfaces"

import {
	applyEntry,
	type ChildVisit,
	childWalks,
	type CompiledEntry,
	compileEntry,
	type Entry,
	type Key,
	type Table,
	type Visit,
	visitInterleaved,
	visitSectionsBelow,
} from "./table"

// Every kind of the typed AST. See "Adding a node kind" in DEVELOPMENT.md.
export type TypedNode =
	| common.typed.Program
	| common.typed.ImplementationSectionNode
	| common.typed.TestsSectionNode
	| common.typed.TestNode
	| common.typed.TestTableNode
	| common.typed.TestPropertiesNode
	| common.typed.TestPropertyNode
	| common.typed.SuiteNode
	| common.typed.ImportSectionNode
	| common.typed.ImportNode
	| common.typed.ExportSectionNode
	| common.typed.ExportNode
	| common.typed.ExpressionNode
	| common.typed.StatementNode
	| common.typed.SnapshotNode
	| common.typed.SimpleMethod
	| common.typed.StaticMethod
	| common.typed.OverloadedMethod
	| common.typed.OverloadedStaticMethod
	| common.typed.NativeShimNode
	| common.typed.ParameterNode
	| common.typed.GenericDeclarationNode
	| common.typed.FunctionDefinitionNode
	| common.typed.ArgumentNode

type TestGenerator = common.typed.TestGenerator

// A generator nests itself, which the data forms can not spell, so a nested
// one is reached through its kind's entry. Every generator stands in a
// property's `generator`, so that is the container of all it holds.
const generator = {
	custom(
		value: TestGenerator,
		_owner: unknown,
		visit: Visit,
		state: unknown,
		stops: boolean,
		key: Key,
	): unknown {
		return applyEntry(
			compiledGenerators[value.kind],
			value,
			visit,
			state,
			stops,
			key,
		)
	},
}

const generators = {
	custom(
		values: ReadonlyArray<TestGenerator>,
		owner: unknown,
		visit: Visit,
		state: unknown,
		stops: boolean,
		key: Key,
	): unknown {
		for (let index = 0; index < values.length; index++) {
			let result = generator.custom(
				values[index],
				owner,
				visit,
				state,
				stops,
				key ?? index,
			)

			if (result !== undefined) {
				return result
			}
		}

		return undefined
	},
}

// One entry per kind of generator, held to its kind's fields as a node's
// entry is. Only `refined` and `generated` hold Expressions of their own.
const generatorEntries: {
	[Kind in TestGenerator["kind"]]: Entry<
		Extract<TestGenerator, { kind: Kind }>
	>
} = {
	boolean: {},
	integer: {},
	rational: {},
	string: {},
	list: { item: generator },
	dictionary: { key: generator, value: generator },
	record: { members: { each: { generator } } },
	case: { members: { each: { generator } } },
	union: { members: generators },
	refined: { base: generator, checks: "nodes" },
	generated: { call: "node", shrink: "node" },
}

const compiledGenerators: Record<string, CompiledEntry> = Object.fromEntries(
	Object.entries(generatorEntries).map(([kind, entry]) => [
		kind,
		compileEntry(entry, "generator"),
	]),
)

const sectionsBelow = {
	custom(
		exports: common.typed.ExportSectionNode | null,
		program: common.typed.Program,
		visit: Visit,
		state: unknown,
		stops: boolean,
	): unknown {
		return visitSectionsBelow(exports, program.tests, visit, state, stops)
	},
}

const propertyEntry: Entry<common.typed.NamespaceProperty> = {
	name: "node",
	value: "node",
}

const namespaceProperty = compileEntry(propertyEntry, "properties")

const namespaceMembers = {
	custom(
		_methods: common.typed.Methods,
		namespace: common.typed.NamespaceDefinitionStatementNode,
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

const typedTable: Table<TypedNode> = {
	Program: {
		imports: "node",
		implementation: "node",
		exports: sectionsBelow,
		// Visited with `exports`, in written order.
		tests: "skip",
	},
	ImplementationSection: { nodes: "nodes" },
	TestsSection: { nodes: "nodes" },
	Test: { name: "node", table: "node", properties: "node", body: "nodes" },
	TestTable: { rows: "nodes", bindings: "nodes" },
	TestProperties: { parameters: "nodes" },
	TestProperty: { generator },
	Suite: { name: "node", nodes: "nodes" },
	ImportSection: { entries: "nodes" },
	Import: {},
	ExportSection: { entries: "nodes" },
	Export: {},
	MethodInvocation: {
		base: "node",
		arguments: "nodes",
		// Per-branch typed copies of Arguments the call already holds.
		dispatch: "skip",
	},
	FunctionInvocation: { name: "node", arguments: "nodes" },
	RecordValue: { members: "values" },
	StringValue: {},
	InterpolatedStringValue: { segments: { each: { expression: "node" } } },
	IntegerValue: {},
	RationalValue: {},
	BooleanValue: {},
	FunctionValue: { value: "node" },
	ListValue: { values: "nodes" },
	DictionaryValue: { entries: { each: { key: "node", value: "node" } } },
	Lookup: { base: "node", member: "node" },
	Identifier: {},
	Self: {},
	Combination: { lhs: "node", rhs: "node" },
	Match: {
		value: "node",
		handlers: {
			each: {
				literal: "node",
				memberLiterals: "values",
				guard: "node",
				body: "nodes",
			},
		},
	},
	Define: {
		arms: { each: { value: "node", condition: "node" } },
		otherwise: { fields: { value: "node" } },
	},
	CaseValue: { choice: "node", caseName: "node", value: "node" },
	Start: { expression: "node" },
	Complete: { expression: "node" },
	RefusedValue: { base: "node" },
	ConstantDeclarationStatement: { name: "node", value: "node" },
	VariableDeclarationStatement: { name: "node", value: "node" },
	VariableAssignmentStatement: { name: "node", value: "node" },
	NamespaceDefinitionStatement: {
		name: "node",
		generics: "nodes",
		// Visited with `methods`, in written order.
		properties: "skip",
		methods: namespaceMembers,
		nativeShims: "nodes",
	},
	SimpleMethod: { name: "node", method: "node" },
	StaticMethod: { name: "node", method: "node" },
	OverloadedMethod: { name: "node", methods: "nodes" },
	OverloadedStaticMethod: { name: "node", methods: "nodes" },
	NativeShim: { parameters: "nodes" },
	ProtocolDeclarationStatement: { name: "node", methods: "values" },
	TypeAliasStatement: { name: "node", generics: "nodes", predicate: "node" },
	ChoiceDeclarationStatement: {
		name: "node",
		generics: "nodes",
		cases: { each: { name: "node", defaultValue: "node" } },
	},
	IfElseStatement: {
		condition: "node",
		trueBody: "nodes",
		falseBody: "nodes",
	},
	IfStatement: { condition: "node", body: "nodes" },
	ReturnStatement: { expression: "node" },
	FunctionStatement: { name: "node", value: "node" },
	// `require MATCHER = EXPR` writes the Matcher first.
	ExpectStatement: {
		matcher: { fields: { literal: "node", memberLiterals: "values" } },
		value: "node",
		snapshot: "node",
	},
	RequireStatement: {
		matcher: { fields: { literal: "node", memberLiterals: "values" } },
		value: "node",
		snapshot: "node",
	},
	Snapshot: {},
	Parameter: {
		externalName: "node",
		internalName: "node",
		defaultValue: "node",
	},
	GenericDeclaration: {},
	FunctionDefinition: {
		generics: "nodes",
		parameters: "nodes",
		body: "nodes",
	},
	Argument: { value: "node" },
}

const walks = childWalks(typedTable)

// Every kind the table names, which is every kind of the tree.
export const typedNodeKinds: ReadonlyArray<string> = Object.keys(typedTable)

// Calls `visit` on each child of `node` in source order, with the walker's
// state, the field holding the child and its index or key there. A walker
// recurses by calling this again from `visit`, and skips a subtree by not
// doing so.
export function forEachTypedChild(
	node: TypedNode,
	visit: ChildVisit<TypedNode, undefined, unknown>,
): void
export function forEachTypedChild<State>(
	node: TypedNode,
	visit: ChildVisit<TypedNode, State, unknown>,
	state: State,
): void
export function forEachTypedChild<State>(
	node: TypedNode,
	visit: ChildVisit<TypedNode, State, unknown>,
	state?: State,
): void {
	walks.forEachChild(node, visit, state as State)
}

// As `forEachTypedChild`, but stops at the first child whose visit answers
// anything but `undefined`, and answers that.
export function findTypedChild<Result>(
	node: TypedNode,
	visit: ChildVisit<TypedNode, undefined, Result | undefined>,
): Result | undefined
export function findTypedChild<State, Result>(
	node: TypedNode,
	visit: ChildVisit<TypedNode, State, Result | undefined>,
	state: State,
): Result | undefined
export function findTypedChild<State, Result>(
	node: TypedNode,
	visit: ChildVisit<TypedNode, State, Result | undefined>,
	state?: State,
): Result | undefined {
	return walks.findChild(node, visit, state as State)
}
