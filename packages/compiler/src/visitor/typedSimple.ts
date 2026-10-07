import type { common } from "@essence-lang/interfaces"

import {
	type ChildVisit,
	childWalks,
	type CompiledEntry,
	compileEntry,
	type Entry,
	type Key,
	type Table,
	type Visit,
} from "./table"

// Every kind of the simplified typed AST. See "Adding a node kind" in
// DEVELOPMENT.md.
export type SimpleNode =
	| common.typedSimple.Program
	| common.typedSimple.ImplementationSectionNode
	| common.typedSimple.ImportSectionNode
	| common.typedSimple.ImportNode
	| common.typedSimple.ExportSectionNode
	| common.typedSimple.ExportNode
	| common.typedSimple.TestsSectionNode
	| common.typedSimple.TestEntryNode
	| common.typedSimple.TestRowsNode
	| common.typedSimple.TestPropertiesNode
	| common.typedSimple.TestScopeNode
	| common.typedSimple.CoverageSectionNode
	| common.typedSimple.ExpressionNode
	| common.typedSimple.StatementNode
	| common.typedSimple.FunctionDefinitionNode
	| common.typedSimple.ParameterNode
	| common.typedSimple.ArgumentNode

// The kinds whose nodes differ by `kind`, each with an entry per `kind`.
type ByKind = "Intrinsic" | "IntrinsicStatement"

type TestGenerator = common.typedSimple.TestGenerator

// A generator nests itself, which the data forms can not spell, so a nested
// one is reached through its kind's entry. Every generator stands in a
// property's `parameters`, so that is the container of all it holds.
const generator = {
	custom(
		value: TestGenerator,
		_owner: unknown,
		visit: Visit,
		state: unknown,
		stops: boolean,
		key: Key,
	): unknown {
		return compiledGenerators[value.kind](value, visit, state, stops, key)
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
	dictionary: { key: generator, value: generator, keyConformance: "node" },
	record: { members: { each: { generator } } },
	case: { members: { each: { generator } } },
	union: { members: generators },
	refined: { base: generator, checks: "nodes" },
	generated: { call: "node", shrink: "node" },
}

const compiledGenerators: Record<string, CompiledEntry> = Object.fromEntries(
	Object.entries(generatorEntries).map(([kind, entry]) => [
		kind,
		compileEntry(entry, "parameters", `simple/TestGenerator.${kind}`),
	]),
)

const handler: Entry<common.typedSimple.MatchHandler> = {
	typeTest: "node",
	literal: "node",
	memberLiterals: "values",
	memberTests: "values",
	guard: "node",
	body: "nodes",
}

const callback: Entry<common.typedSimple.InlineLoopCallback> = {
	parameters: "nodes",
	body: "nodes",
}

// Each driver's Expressions in the order its loop evaluates them, which one
// key order serves for every driver.
const driver: Entry<common.typedSimple.InlineLoopDriver> = {
	from: "node",
	through: "node",
	items: "node",
	seed: "node",
	predicate: { fields: callback },
	step: { fields: callback },
	transform: { fields: callback },
	check: { fields: callback },
}

// Where a lowered Statement's answer goes, first, as the declaration it was
// lowered from writes its name.
const result: Entry<common.typedSimple.StatementResult> = { name: "node" }

const temporaries = { each: { value: "node" } } as const

// The children of each node in the order the optimiser's walk reaches them,
// which is the order they run in. A name it does not offer stands where it is
// written.
const simpleTable: Table<SimpleNode, ByKind> = {
	Program: {
		imports: "node",
		implementation: "node",
		exports: "node",
		tests: "node",
		coverage: "node",
	},
	ImplementationSection: { nodes: "nodes" },
	ImportSection: { entries: "nodes" },
	Import: {},
	ExportSection: { entries: "nodes" },
	Export: {},
	TestsSection: { nodes: "nodes" },
	TestEntry: { name: "node", body: "nodes" },
	TestRows: { name: "node", rows: "nodes", bindings: "nodes", body: "nodes" },
	TestProperties: {
		name: "node",
		parameters: { each: { generator } },
		body: "nodes",
	},
	TestScope: { nodes: "nodes" },
	CoverageSection: {},
	Start: { expression: "node" },
	Complete: { expression: "node" },
	TestTrace: { value: "node" },
	CoverageCounter: { value: "node" },
	CaseValue: { value: "node" },
	// A witness of the group stands beside the group's own conditions.
	ConformanceValue: {
		conditions: "nodes",
		groupConditions: "nodes",
		providedWitnesses: "nodes",
	},
	FunctionInvocation: { name: "node", arguments: "nodes" },
	MethodInvocation: { base: "node", arguments: "nodes" },
	UnionMethodInvocation: {
		base: "node",
		arguments: "nodes",
		cases: {
			each: {
				conformanceArguments: "nodes",
				contextualArguments: { each: { argument: "node" } },
			},
		},
	},
	RecordValue: { members: "values" },
	StringValue: {},
	InterpolatedStringValue: {
		segments: { each: { expression: "node", witness: "node" } },
	},
	IntegerValue: {},
	RationalValue: {},
	BooleanValue: {},
	FunctionValue: { value: "node" },
	ListValue: { values: "nodes" },
	DictionaryValue: {
		entries: { each: { key: "node", value: "node" } },
		keyConformance: "node",
	},
	Lookup: { base: "node", member: "node" },
	Identifier: {},
	Combination: { lhs: "node", rhs: "node", keyConformance: "node" },
	Match: { value: "node", handlers: { each: handler } },
	// Each arm's Condition runs before its value.
	Define: {
		arms: { each: { condition: "node", value: "node" } },
		otherwise: "node",
	},
	Intrinsic: {
		kinds: {
			"omitted-argument": {},
			"tag-test": { value: "node" },
			"type-test": { value: "node", descriptor: "node" },
			"type-descriptor": {},
			"pooled-reference": { value: "node" },
			"essence-boolean": { value: "node" },
			"raw-boolean": { value: "node" },
			"raw-boolean-op": { operand: "node", other: "node" },
			"raw-compare": { left: "node", right: "node" },
			"raw-equals": { left: "node", right: "node" },
			"raw-arithmetic": { left: "node", right: "node" },
			"direct-method": {},
			"direct-record": { members: "values" },
			"direct-case": { members: "values", payload: "node" },
			"direct-list": { values: "nodes" },
			"dispatch-chain": {
				temporaries,
				receiver: "node",
				arguments: "nodes",
				cases: {
					each: {
						test: "node",
						conformanceArguments: "nodes",
						contextualArguments: { each: { value: "node" } },
					},
				},
			},
			"inline-loop": { driver: { fields: driver } },
			"list-build": { additions: { each: { value: "node" } } },
			"spread-combination": {
				lhs: "node",
				members: "values",
				rhs: "node",
			},
			"member-or-default": { base: "node", fallback: "node" },
		},
	},
	VariableDeclarationStatement: { name: "node", value: "node" },
	VariableAssignmentStatement: { name: "node", value: "node" },
	NamespaceDefinitionStatement: {
		name: "node",
		properties: "values",
		methods: { values: { method: "node" } },
		nativeShims: { each: { parameters: "nodes", prologue: "nodes" } },
	},
	ProtocolDeclarationStatement: {
		name: "node",
		methods: { values: { method: "node" } },
	},
	TypeAliasStatement: { name: "node" },
	ConditionalStatement: {
		condition: "node",
		trueBody: "nodes",
		falseBody: "nodes",
	},
	ReturnStatement: { expression: "node" },
	FunctionStatement: { name: "node", value: "node" },
	// The asserted value runs before the Matcher tests it.
	TestAssertionStatement: { value: "node", matcher: { fields: handler } },
	TailCallStatement: {
		bindings: { each: { value: "node" } },
		assignments: { each: { value: "node" } },
	},
	IntrinsicStatement: {
		kinds: {
			"statement-match": {
				result: { fields: result },
				value: "node",
				handlers: { each: handler },
			},
			"held-expression": {
				result: { fields: result },
				temporaries,
				expression: "node",
			},
			"inline-loop": {
				result: { fields: result },
				driver: { fields: driver },
			},
		},
	},
	FunctionDefinition: { parameters: "nodes", body: "nodes" },
	Parameter: {
		externalName: "node",
		internalName: "node",
		defaultValue: "node",
	},
	Argument: { value: "node" },
}

const walks = childWalks(simpleTable, "simple")

// Every kind the table names, which is every kind of the tree. A kind told
// apart by `kind` is spelled with it, as `Intrinsic tag-test`.
export const simpleNodeKinds: ReadonlyArray<string> = Object.entries(
	simpleTable as Record<string, object>,
).flatMap(([nodeType, entry]) =>
	"kinds" in entry
		? Object.keys(entry.kinds as object).map(
				(kind) => `${nodeType} ${kind}`,
			)
		: [nodeType],
)

// Calls `visit` on each child of `node` in the order the optimiser's walk
// reaches them. It hands over the walker's state, the field holding the child
// and its index or key there. A walker recurses by calling this again from
// `visit`, and skips a subtree by not doing so.
export function forEachSimpleChild<Parent extends SimpleNode>(
	node: Parent,
	visit: ChildVisit<SimpleNode, undefined, unknown, Parent>,
): void
export function forEachSimpleChild<Parent extends SimpleNode, State>(
	node: Parent,
	visit: ChildVisit<SimpleNode, State, unknown, Parent>,
	state: State,
): void
export function forEachSimpleChild<Parent extends SimpleNode, State>(
	node: Parent,
	visit: ChildVisit<SimpleNode, State, unknown, Parent>,
	state?: State,
): void {
	walks.forEachChild(node, visit, state as State)
}

// As `forEachSimpleChild`, but stops at the first child whose visit answers
// anything but `undefined`, and answers that.
export function findSimpleChild<Parent extends SimpleNode, Result>(
	node: Parent,
	visit: ChildVisit<SimpleNode, undefined, Result | undefined, Parent>,
): Result | undefined
export function findSimpleChild<Parent extends SimpleNode, State, Result>(
	node: Parent,
	visit: ChildVisit<SimpleNode, State, Result | undefined, Parent>,
	state: State,
): Result | undefined
export function findSimpleChild<Parent extends SimpleNode, State, Result>(
	node: Parent,
	visit: ChildVisit<SimpleNode, State, Result | undefined, Parent>,
	state?: State,
): Result | undefined {
	return walks.findChild(node, visit, state as State)
}
