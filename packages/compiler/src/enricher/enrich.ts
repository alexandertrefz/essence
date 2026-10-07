import type { common, enricher, parser } from "@essence-lang/interfaces"

import type { CompileMode } from "../compileMode"
import {
	collectDiagnostics,
	collectDiagnosticsInto,
	containsErrors,
	primary,
	report,
	reportError,
	reportWarning,
	secondary,
} from "../diagnostics/index"
import { patternBindings } from "../helpers/patterns"
import {
	closePendingRefinementCopies,
	NotHoistedYet,
	openPendingRefinementCopies,
	pendingRefinementCopiesOf,
} from "../helpers/types"
import { VALUE_COMMENT, valueCommentLines } from "../valueComments"
import { forEachTypedChild, type TypedNode } from "../visitor/index"
import { collectAnnotations } from "./annotations"
import { builtinMembers, builtinProtocols, builtinTypes } from "./builtins"
import { CONTRACT_SUITE, contractSuite } from "./contracts"
import {
	derivePredicateAliases,
	deriveProvidedPredicateAliases,
	enrichExpression,
	enrichNode,
	enrichOverloadedFunctionStatement,
	enrichTestProperties,
	enrichTestTable,
	type HoistedTypes,
	pendingRefinementIn,
	refinementPredicateScope,
	resolveNamespaceDefinitionStatementType,
	resolveRefinementConjuncts,
	resolveTypeAliasStatementSkeleton,
	resolveTypeAliasStatementType,
	settleConformanceClauses,
	typedProvidedReads,
} from "./enrichers"
import { exampleSuite, exampleTestsOf } from "./examples"
import { hoistRefusedDeclarations, typeNamesMentionedBy } from "./refusedHoists"
import {
	collectReachedNames,
	forgetNamespaceTargets,
	invalidateConformancesInScope,
	invalidateNamespacesInScope,
	referencedTypeNames,
	resolveChoiceDeclarationStatementType,
	resolveFunctionSignatureType,
	resolveOverloadedFunctionStatementType,
	resolveProtocolDeclarationStatementType,
} from "./resolvers"
import {
	childScope,
	countTypeDeclaration,
	modulePathOf,
	protocolRegistryFor,
	registerProtocol,
	scopeMap,
} from "./scope"
import { hoistStalls } from "./staticProperties"
import {
	mergedModifiers,
	nameTemplate,
	noModifiers,
	refuseDuplicateNames,
	refuseReservedSuite,
	refuseTableDefaults,
	resolveTestModifiers,
	type TestModifiers,
} from "./tests"
import { enrichInTurns, type LateNames } from "./turns"

// Names to leave out of the top level Scope, per table. A standard library
// source edited as a document declares names the builtin tables already hold,
// and would otherwise redeclare each of them.
export type ShadowedBuiltins = {
	members: Set<string>
	types: Set<string>
	protocols: Set<string>
}

const withoutShadowed = <Value>(
	table: Record<string, Value>,
	names: Set<string> | undefined,
): Record<string, Value> =>
	names === undefined || names.size === 0
		? table
		: Object.fromEntries(
				Object.entries(table).filter(([name]) => !names.has(name)),
			)

export type TopLevelScopeOptions = {
	shadowedBuiltins?: ShadowedBuiltins
	modulePath?: string
	unimportedNamespaces?: () => Array<enricher.UnimportedNamespace>
	// What the parser abandoned in this Program. See
	// `Scope.abandonedDeclarations`.
	recovery?: parser.Recovery
}

// How far a dropped Declaration silences reads of its name. A hoistable one
// (`isHoistable`) at a section's top level covers the file. Any other covers
// its block from its own position on, so a syntax error hides no other mistake.
function abandonedDeclaration(
	record: parser.AbandonedDeclaration,
): enricher.AbandonedDeclaration {
	return {
		name: record.name,
		position: record.position,
		enclosing: record.enclosing,
		hoists: record.hoistable && record.atSectionLevel,
	}
}

// The Scope a Program's top level is enriched in. The builtins and the
// Program's declarations share one table per kind, so a declaration over a
// builtin is a duplicate. Linking seeds imports between the two, so
// `getAllNamespacesInScope` answers builtins, imports, then locals.
export function topLevelScope(
	options: TopLevelScopeOptions = {},
): enricher.Scope {
	let shadowed = options.shadowedBuiltins
	let members: Record<string, common.Type> = scopeMap(
		withoutShadowed(builtinMembers(), shadowed?.members),
	)
	let protocols = scopeMap(
		withoutShadowed(builtinProtocols(), shadowed?.protocols),
	)

	return {
		parent: null,
		modulePath: options.modulePath,
		unimportedNamespaces: options.unimportedNamespaces,
		// The emitted Module may `await` at its top level, so `complete`
		// needs no declaration here.
		completing: "top-level",
		members,
		// Taken while `members` holds only the builtins, since the
		// Program's declarations join the same table later.
		preludeNames: new Set(Object.keys(members)),
		abandonedDeclarations:
			options.recovery === undefined ||
			options.recovery.declarations.length === 0
				? undefined
				: options.recovery.declarations.map(abandonedDeclaration),
		// A builtin is sourceless, so it has no declaration Position.
		declarations: scopeMap(),
		constants: new Set(Object.keys(members)),
		// Present only on the Scope a Program's own Constants are recorded
		// in; every child Scope leaves it off.
		constantValues: scopeMap(),
		types: scopeMap(withoutShadowed(builtinTypes(), shadowed?.types)),
		protocols,
		preludeProtocols: new Set(Object.keys(protocols)),
		protocolRegistry: protocolRegistryFor(protocols),
		programTop: true,
	}
}

// Enriches one Program. The `CompileMode` decides whether its `tests { … }`
// block and its contract goals are read.
export const enrich = (
	program: parser.Program,
	options: CompileMode & {
		shadowedBuiltins?: ShadowedBuiltins
		// Set by the language server, for Hover over a written Type.
		annotations?: boolean
		// The Module's canonical path, which its Choices take their identity
		// from (`choiceIdentity`). Without it, Choices are identified by name.
		// The builtins keep their unqualified identity either way.
		modulePath?: string
		// The Module a test's identity names where the Scope names none, as
		// for a standard library file.
		testsPath?: string
		// The source text, from which a test compile reads `@example` blocks.
		source?: string
	} = {},
): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
	annotations: Array<common.TypeAnnotation>
} => {
	let annotations: Array<common.TypeAnnotation> = []

	let { result, diagnostics } = collectDiagnostics(
		(): common.typed.Program => {
			let scope = topLevelScope({
				...options,
				recovery: program.recovery,
			})

			// The tests section is enriched after the implementation, in
			// the Scope it filled: a test names what the file declares.
			let enrichSections = (): {
				implementation: common.typed.ImplementationSectionNode
				tests: common.typed.TestsSectionNode | null
			} => ({
				implementation: enrichImplementation(
					program.implementation,
					scope,
				),
				tests: testsSectionOf(
					program,
					scope,
					options,
					options.source,
					options.testsPath,
				),
			})

			if (options.annotations !== true) {
				return {
					nodeType: "Program",
					imports: null,
					...enrichSections(),
					exports: null,
					position: program.position,
				}
			}

			// The collector opens after the builtin tables are built, since
			// the first build loads the library and would record its annotations.
			let collected = collectAnnotations(enrichSections)

			annotations = collected.annotations

			return {
				nodeType: "Program",
				imports: null,
				...collected.result,
				exports: null,
				position: program.position,
			}
		},
	)

	return { program: result, diagnostics, annotations }
}

// A `§?` value comment outside the `tests { … }` block, where nothing
// records a value. It is a Warning, and only a compile of the tests reports
// it; to a build it is an ordinary Comment.
function reportStrayValueComments(
	program: parser.Program,
	source: string | undefined,
): void {
	if (source === undefined) {
		return
	}

	let section = program.tests?.position ?? null

	for (let [line, position] of valueCommentLines(source)) {
		if (
			section !== null &&
			line >= section.start.line &&
			line <= section.end.line
		) {
			continue
		}

		reportWarning("This value comment is answered by nothing", position, {
			code: "value-comment-outside-tests",
			labels: [
				primary(position, "no test records the value of this line"),
			],
			notes: [
				`A '${VALUE_COMMENT}' asks for the value of the Statement it ends, and the points that record one are handed out while a 'tests { … }' block is compiled. Everywhere else it is an ordinary Comment.`,
			],
			helps: [
				`Ask it of a Statement inside the 'tests { … }' block, or write '§' for a Comment that asks nothing.`,
			],
		})
	}
}

// The one place the mode flag is read. Null for a compile that did not ask
// for tests, or for a file with none. Only the parser's Program says whether a
// file has tests.
function testsSectionOf(
	program: parser.Program,
	scope: enricher.Scope,
	// The whole mode, since a contract run runs the written tests too.
	mode: CompileMode,
	source: string | undefined,
	testsPath?: string,
): common.typed.TestsSectionNode | null {
	if (mode.tests !== true) {
		return null
	}

	reportStrayValueComments(program, source)

	// The `@example` blocks join the written tests in one enrichment, so a
	// file's tests come out as one manifest.
	let examples = exampleTestsOf(program, source)

	if (
		program.tests === null &&
		examples.length === 0 &&
		mode.contracts !== true
	) {
		return null
	}

	let position = program.tests?.position ?? program.implementation.position
	let written = program.tests?.nodes ?? []
	// A written suite under a synthesized suite's name is refused, and the
	// synthesis dropped, so the collision is reported once.
	let examplesTaken =
		examples.length > 0 &&
		refuseReservedSuite(
			written,
			"examples",
			"this file's '@example' blocks",
		)
	let section = enrichTestsSection(
		{
			nodeType: "TestsSection",
			// The examples come last, so the written tests keep their
			// indices.
			nodes:
				examples.length === 0 || examplesTaken
					? written
					: [...written, exampleSuite(examples, position)],
			position,
		},
		scope,
		testsPath,
	)

	if (mode.contracts !== true) {
		return section
	}

	if (
		refuseReservedSuite(
			written,
			CONTRACT_SUITE,
			"the goals this run's declarations promise",
		)
	) {
		return section
	}

	// After the written tests, in the implementation's Scope rather than the
	// section's. Appended, so every written item keeps its manifest index.
	let contractsSuite = contractSuite(
		program,
		scope,
		position,
		modulePathOf(scope) ?? testsPath ?? null,
	)

	if (contractsSuite === null) {
		return program.tests === null && examples.length === 0 ? null : section
	}

	return { ...section, nodes: [...section.nodes, contractsSuite] }
}

// One Program and the Scope its top level is enriched in. Each Module of a
// group has a Scope of its own, so a name is visible only where imported.
export type EnrichedProgramInput = {
	program: parser.Program
	scope: enricher.Scope
	// The Module's own text, which only a test compile reads.
	source?: string
}

// The mode covers every Program of the group.
export type EnrichProgramsOptions = CompileMode & {
	// Called before every hoist round and once after the last, to seed the
	// imports a cycle of Modules can bind only once their declarations hoist.
	// `true` means something new was bound, which keeps the rounds going.
	// `final` is the last chance to bind a hoisted name before the bodies.
	seedRound?: (final: boolean) => boolean
	// The names a Module of a cycle reads before another Module declares
	// them. Left out, each Program is enriched whole, one after another.
	lateNames?: LateNames
	// The one input whose written annotations a Hover wants.
	annotationsFor?: number
}

// Enriches a group of Programs with one hoist over all of them, collecting
// Diagnostics per Program. See "Hoisting" in DEVELOPMENT.md. Annotations are
// collected around the whole run, since the hoist resolves the written Types,
// and filtered to the Module asked about.
export const enrichPrograms = (
	inputs: Array<EnrichedProgramInput>,
	options: EnrichProgramsOptions = {},
): Array<{
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
	annotations: Array<common.TypeAnnotation>
	reachedNames: Set<string>
}> => {
	if (options.annotationsFor === undefined) {
		return enrichProgramsInner(inputs, options).map((entry) => ({
			...entry,
			annotations: [],
		}))
	}

	let { result, annotations } = collectAnnotations(
		() => enrichProgramsInner(inputs, options),
		{
			modulePath:
				inputs[options.annotationsFor]?.scope.modulePath ?? null,
		},
	)

	return result.map((entry, index) => ({
		...entry,
		annotations: index === options.annotationsFor ? annotations : [],
	}))
}

const enrichProgramsInner = (
	inputs: Array<EnrichedProgramInput>,
	options: EnrichProgramsOptions,
): Array<{
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
	// The names this Program reached a conformance through without
	// writing them, for the linker's unused-import check.
	reachedNames: Set<string>
}> => {
	// The hoist runs before any Program's collection is open, so its
	// Diagnostics are kept per Node and replayed into the Node's own Program.
	let hoistDiagnostics = new Map<
		parser.ImplementationNode,
		Array<common.Diagnostic>
	>()

	let hoistedTypes = hoistDeclarations(
		inputs.map((input) => ({
			nodes: input.program.implementation.nodes,
			scope: input.scope,
		})),
		(node, diagnostics) => {
			let collected = hoistDiagnostics.get(node)

			if (collected === undefined) {
				hoistDiagnostics.set(node, [...diagnostics])
			} else {
				collected.push(...diagnostics)
			}
		},
		options.seedRound,
	)

	let enriched = inputs.map((input) => {
		let diagnostics: Array<common.Diagnostic> = []
		let reachedNames = new Set<string>()
		// Each turn reports into the Program's one collection.
		let within = <Result>(work: () => Result): Result => {
			let { result, names } = collectReachedNames(() =>
				collectDiagnosticsInto(diagnostics, work),
			)

			for (let name of names) {
				reachedNames.add(name)
			}

			return result
		}

		within(() => {
			for (let node of input.program.implementation.nodes) {
				for (let diagnostic of hoistDiagnostics.get(node) ?? []) {
					report(diagnostic)
				}
			}
		})

		return {
			...input,
			diagnostics,
			reachedNames,
			within,
			nodes: [] as Array<common.typed.ImplementationNode>,
			tests: null as common.typed.TestsSectionNode | null,
		}
	})

	enrichInTurns(
		enriched.map((entry) => ({
			nodes: entry.program.implementation.nodes,
			step: (node) => {
				entry.nodes.push(
					...entry.within(() =>
						enrichTopLevelNode(node, entry.scope, hoistedTypes),
					),
				)
			},
			finish: () => {
				entry.tests = entry.within(() =>
					testsSectionOf(
						entry.program,
						entry.scope,
						options,
						entry.source,
					),
				)
			},
		})),
		options.lateNames,
	)

	return enriched.map((entry) => ({
		program: {
			nodeType: "Program",
			imports: null,
			implementation: {
				nodeType: "ImplementationSection",
				nodes: entry.nodes,
				position: entry.program.implementation.position,
			},
			tests: entry.tests,
			exports: null,
			position: entry.program.position,
		},
		diagnostics: entry.diagnostics,
		reachedNames: entry.reachedNames,
	}))
}

// A Program's Nodes and the Scope they hoist into. Each Module has its own,
// so a group's Modules see only what they import from each other.
type HoistUnit = {
	nodes: Array<parser.ImplementationNode>
	scope: enricher.Scope
}

type HoistableStatementNode =
	| parser.TypeAliasStatementNode
	| parser.ChoiceDeclarationStatementNode
	| parser.FunctionStatementNode
	| parser.OverloadedFunctionStatementNode
	| parser.NamespaceDefinitionStatementNode
	| parser.ProtocolDeclarationStatementNode

function isHoistable(
	node: parser.ImplementationNode,
): node is HoistableStatementNode {
	return (
		node.nodeType === "TypeAliasStatement" ||
		node.nodeType === "ChoiceDeclarationStatement" ||
		node.nodeType === "FunctionStatement" ||
		node.nodeType === "OverloadedFunctionStatement" ||
		node.nodeType === "NamespaceDefinitionStatement" ||
		node.nodeType === "ProtocolDeclarationStatement"
	)
}

export type HoistableTypeNode =
	| parser.TypeAliasStatementNode
	| parser.ChoiceDeclarationStatementNode

// A refined Alias whose predicate has not been read yet. `refinement` is the
// object registered in Scope, inside the wrapper for a generic Alias, which
// the fill writes into in place.
type PendingPredicate = {
	node: parser.TypeAliasStatementNode
	scope: enricher.Scope
	refinement: common.RefinementType
}

// A reading that checks a value against a refinement still unread waits,
// and is retried once a pass settles something. In the final call the readings
// still waiting wait on each other, and each cycle among them is reported.
function fillPendingPredicates(
	pending: Array<PendingPredicate>,
	sink: HoistDiagnosticSink,
	hoistedTypes: HoistedTypes,
	final: boolean,
	unread?: (conjunct: common.PredicateConjunct) => boolean,
): void {
	for (;;) {
		let unsettled = pending.length
		let waiting = readPendingPredicates(
			pending,
			sink,
			hoistedTypes,
			final,
			unread,
		)

		if (waiting.size === 0) {
			return
		}

		if (pending.length === unsettled) {
			if (!final) {
				return
			}

			reportPredicateCycle(pending, waiting, sink, hoistedTypes)
		}
	}
}

// One attempt at reading each pending predicate, dropping each one that
// resolves and writing its conjuncts into the Alias and every pending copy.
// Answers the readings that wait, each with the refinement it waits on. See
// "Pending predicates during the hoist" in DEVELOPMENT.md.
function readPendingPredicates(
	pending: Array<PendingPredicate>,
	sink: HoistDiagnosticSink,
	hoistedTypes: HoistedTypes,
	final: boolean,
	unread?: (conjunct: common.PredicateConjunct) => boolean,
): Map<PendingPredicate, common.RefinementType | null> {
	let waiting = new Map<PendingPredicate, common.RefinementType | null>()

	for (let index = pending.length - 1; index >= 0; index--) {
		let entry = pending[index]
		let { node, scope, refinement } = entry
		let reading: {
			result: Array<common.PredicateConjunct> | null
			diagnostics: Array<common.Diagnostic>
		}

		try {
			reading = collectDiagnostics(
				(): Array<common.PredicateConjunct> | null =>
					node.predicate === null
						? null
						: resolveRefinementConjuncts(
								node.predicate,
								refinement.base,
								// Rebuilt per attempt, so a Namespace hoisted
								// since is in Scope.
								refinementPredicateScope(node, scope),
							),
			)
		} catch (error) {
			if (!(error instanceof NotHoistedYet)) {
				throw error
			}

			waiting.set(entry, error.refinement)

			continue
		}

		let { result, diagnostics } = reading

		if (!final && (containsErrors(diagnostics) || result === null)) {
			continue
		}

		// Conjuncts are written once, so a leaf naming an unread alias
		// waits for a later round.
		if (!final && result !== null && result.some(unread ?? (() => false))) {
			continue
		}

		if (result === null) {
			abandonPendingPredicate(entry, hoistedTypes)
		} else {
			sink(node, diagnostics)
			refinement.conjuncts = result

			for (let copy of pendingRefinementCopiesOf(refinement)) {
				copy.conjuncts = result
			}

			// A written receiver skips a pending Alias, so the answers worked
			// out before this fill are dropped.
			countTypeDeclaration()
		}

		pending.splice(index, 1)
	}

	return waiting
}

// Each copy is poisoned to its own instantiated base, so a signature keeps
// what it applied the Alias to. The in-order enrichment reports the Alias.
function abandonPendingPredicate(
	{ node, scope, refinement }: PendingPredicate,
	hoistedTypes: HoistedTypes,
): void {
	let copies = pendingRefinementCopiesOf(refinement)

	poisonRefinementToBase(refinement)

	for (let copy of copies) {
		poisonRefinementToBase(copy)
	}

	hoistedTypes.delete(node)
	delete scope.types[node.name.content]
	countTypeDeclaration()
}

// Every reading still waiting waits on another, so a walk from one comes
// back round. That cycle is reported and abandoned, and what waited on it is
// read in the next pass.
function reportPredicateCycle(
	pending: Array<PendingPredicate>,
	waiting: Map<PendingPredicate, common.RefinementType | null>,
	sink: HoistDiagnosticSink,
	hoistedTypes: HoistedTypes,
): void {
	let path: Array<PendingPredicate> = []
	let next: PendingPredicate | undefined = pending[pending.length - 1]

	while (next !== undefined && !path.includes(next)) {
		path.push(next)

		let awaited: common.RefinementType | null = waiting.get(next) ?? null

		next =
			awaited === null
				? undefined
				: pending.find(
						(entry) =>
							entry.refinement === awaited ||
							pendingRefinementCopiesOf(
								entry.refinement,
							).includes(awaited),
					)
	}

	// A wait leading off the list is a compiler bug. The entry is abandoned
	// unreported, and the in-order enrichment reports the unread predicate.
	let cycle = next === undefined ? [] : path.slice(path.indexOf(next))

	// Reported in the order the Aliases hoisted in.
	for (let entry of [...cycle].sort(
		(left, right) => pending.indexOf(left) - pending.indexOf(right),
	)) {
		let at = cycle.indexOf(entry)
		let names = [...cycle.slice(at), ...cycle.slice(0, at)].map(
			(member) => member.node.name.content,
		)
		let name = entry.node.name.content
		let awaited = names[1] ?? name
		let position = (entry.node.predicate ?? entry.node).position
		let sentence = `'${name}' depends on '${awaited}'`

		for (let step of [...names.slice(2), name]) {
			sentence += `, which depends on '${step}'`
		}

		let { diagnostics } = collectDiagnostics((): void => {
			reportError(
				names.length === 1
					? `The predicate of '${name}' depends on itself`
					: `The predicate of '${name}' depends on itself through '${awaited}'`,
				position,
				{
					code: "recursive-type-declaration",
					labels: [
						primary(
							position,
							`reading this checks a value against '${awaited}'`,
						),
					],
					notes: [
						...(names.length === 1 ? [] : [`${sentence} again.`]),
						"Reading a predicate typechecks it, so one that checks a value against its own refinement, directly or through others, can never be read.",
					],
					helps: [
						"Break the cycle, so that no predicate checks a value against a refinement that depends on it.",
					],
				},
			)
		})

		sink(entry.node, diagnostics)
	}

	for (let entry of next === undefined ? path.slice(-1) : cycle) {
		abandonPendingPredicate(entry, hoistedTypes)
		pending.splice(pending.indexOf(entry), 1)
	}
}

// Turns a Refinement into its base in place, since signatures hold it by
// reference. The base's fields are copied, so a child such as a List's item
// Type stays shared. A generic Alias' wrapper then stands over the plain base.
function poisonRefinementToBase(refinement: common.RefinementType): void {
	let record = refinement as unknown as Record<string, unknown>
	let base = refinement.base as unknown as Record<string, unknown>

	for (let key of Object.keys(record)) {
		delete record[key]
	}

	Object.assign(record, base)

	// Method resolution may have indexed the object as a refinement.
	forgetNamespaceTargets()
}

// A declaration waiting for a round, with the Scope it resolves in. A round
// spans every unit, so the Scope travels with the Node.
export type PendingDeclaration = {
	node: HoistableStatementNode
	scope: enricher.Scope
}

// Where the hoist's own Diagnostics go, with the Node they belong to. A lone
// Program hoists inside its own collection and reports them on.
export type HoistDiagnosticSink = (
	node: parser.ImplementationNode,
	diagnostics: Array<common.Diagnostic>,
) => void

const reportOnwards: HoistDiagnosticSink = (_node, diagnostics) => {
	for (let diagnostic of diagnostics) {
		report(diagnostic)
	}
}

// A generic Choice naming itself in a payload, which `resolveGenericCaseMembers`
// reports as `recursive-generic-choice`. The test mirrors that one, so the
// two never both fire.
function namesItselfInAPayload(node: HoistableTypeNode): boolean {
	return (
		node.nodeType === "ChoiceDeclarationStatement" &&
		node.generics.length > 0 &&
		node.cases.some(
			(choiceCase) =>
				choiceCase.type !== null &&
				referencedTypeNames(choiceCase.type).some(
					(reference) => reference.content === node.name.content,
				),
		)
	)
}

// The graph the cycle search runs on: each declared Type name and the names
// it mentions. A name the Scope already holds is no node, and of two
// declarations of one name only the first. Each edge keeps the first
// Identifier that spells it, for the Diagnostic.
function typeDeclarationGraph(
	nodes: Array<HoistableTypeNode>,
	scope: enricher.Scope,
): {
	declarations: Map<string, HoistableTypeNode>
	edges: Map<string, Map<string, parser.IdentifierNode>>
} {
	let declarations = new Map<string, HoistableTypeNode>()

	for (let node of nodes) {
		if (
			scope.types[node.name.content] == null &&
			!declarations.has(node.name.content)
		) {
			declarations.set(node.name.content, node)
		}
	}

	let edges = new Map<string, Map<string, parser.IdentifierNode>>()

	for (let [name, node] of declarations) {
		let mentioned = new Map<string, parser.IdentifierNode>()

		for (let reference of typeNamesMentionedBy(node)) {
			if (
				declarations.has(reference.content) &&
				!mentioned.has(reference.content)
			) {
				mentioned.set(reference.content, reference)
			}
		}

		edges.set(name, mentioned)
	}

	return { declarations, edges }
}

// The shortest way from `start` back to itself through `members`, as the
// names it passes; empty where `start` names itself. Asked only about a known
// cycle member.
function cyclePathThrough(
	start: string,
	members: Set<string>,
	edges: Map<string, Map<string, parser.IdentifierNode>>,
): Array<string> {
	let previous = new Map<string, string>()
	let queue = [start]

	while (queue.length > 0) {
		let current = queue.shift()!

		for (let target of edges.get(current)?.keys() ?? []) {
			if (!members.has(target)) {
				continue
			}

			if (target === start) {
				let path: Array<string> = []

				for (
					let step = current;
					step !== start;
					step = previous.get(step)!
				) {
					path.unshift(step)
				}

				return path
			}

			if (!previous.has(target)) {
				previous.set(target, current)
				queue.push(target)
			}
		}
	}

	return []
}

// Tarjan's strongly connected components over the declaration graph, linear
// because it runs on every compile. A lone declaration is a cycle only when
// it names itself.
function recursiveTypeDeclarationGroups(
	nodes: Array<HoistableTypeNode>,
	scope: enricher.Scope,
): Array<{
	members: Array<HoistableTypeNode>
	edges: Map<string, Map<string, parser.IdentifierNode>>
}> {
	let { declarations, edges } = typeDeclarationGraph(nodes, scope)
	let indices = new Map<string, number>()
	let lowLinks = new Map<string, number>()
	let stack: Array<string> = []
	let onStack = new Set<string>()
	let groups: Array<Array<string>> = []
	let nextIndex = 0

	let visit = (name: string): void => {
		indices.set(name, nextIndex)
		lowLinks.set(name, nextIndex)
		nextIndex += 1
		stack.push(name)
		onStack.add(name)

		for (let target of edges.get(name)?.keys() ?? []) {
			if (!indices.has(target)) {
				visit(target)
				lowLinks.set(
					name,
					Math.min(lowLinks.get(name)!, lowLinks.get(target)!),
				)
			} else if (onStack.has(target)) {
				lowLinks.set(
					name,
					Math.min(lowLinks.get(name)!, indices.get(target)!),
				)
			}
		}

		if (lowLinks.get(name) !== indices.get(name)) {
			return
		}

		let group: Array<string> = []

		for (;;) {
			let member = stack.pop()!

			onStack.delete(member)
			group.push(member)

			if (member === name) {
				break
			}
		}

		if (group.length > 1 || edges.get(name)?.has(name) === true) {
			groups.push(group)
		}
	}

	for (let name of declarations.keys()) {
		if (!indices.has(name)) {
			visit(name)
		}
	}

	// Members and groups are put back into declaration order, so the
	// Diagnostics read down the file.
	let order = new Map(nodes.map((node, index) => [node, index]))
	let indexOf = (node: HoistableTypeNode) => order.get(node)!

	return groups
		.map((group) => ({
			members: group
				.map((name) => declarations.get(name)!)
				.sort((left, right) => indexOf(left) - indexOf(right)),
			edges,
		}))
		.sort(
			(left, right) =>
				indexOf(left.members[0]) - indexOf(right.members[0]),
		)
}

// Every recursive Type declaration, reported once per cycle member and handed
// back for the hoist to seed as an Error. See "Recursive declarations" in
// DEVELOPMENT.md.
function reportRecursiveTypeDeclarations(
	nodes: Array<HoistableTypeNode>,
	scope: enricher.Scope,
	sink: HoistDiagnosticSink,
): Array<HoistableTypeNode> {
	let recursiveNodes: Array<HoistableTypeNode> = []

	for (let group of recursiveTypeDeclarationGroups(nodes, scope)) {
		if (
			group.members.length === 1 &&
			namesItselfInAPayload(group.members[0])
		) {
			continue
		}

		let members = new Set(group.members.map((node) => node.name.content))

		for (let node of group.members) {
			let name = node.name.content
			// An empty path is a declaration that names itself. Either way the
			// next name is one this declaration mentions, so its edge exists.
			let through = cyclePathThrough(name, members, group.edges)
			let reference = group.edges
				.get(name)!
				.get(through.length === 0 ? name : through[0])!
			let kind =
				node.nodeType === "ChoiceDeclarationStatement"
					? "Choice"
					: "Type"
			let notes = [
				"A Type declaration is substituted wherever it is named, so a declaration that names itself would never finish resolving.",
			]

			if (through.length > 0) {
				let path = [name, ...through, name]
				let sentence = `'${path[0]}' names '${path[1]}'`

				for (let step = 2; step < path.length; step += 1) {
					sentence += `, which names '${path[step]}'`
				}

				notes.unshift(`${sentence} again.`)
			}

			let { diagnostics } = collectDiagnostics((): void => {
				reportError(
					through.length === 0
						? `${kind} '${name}' names itself`
						: `${kind} '${name}' names itself through '${through[0]}'`,
					reference.position,
					{
						code: "recursive-type-declaration",
						labels: [
							primary(
								reference.position,
								through.length === 0
									? "this names the declaration being made"
									: `this names '${through[0]}'`,
							),
						],
						notes,
						helps: [
							"Recursive Type declarations are not part of the language yet — break the cycle.",
						],
					},
				)
			})

			sink(node, diagnostics)
			recursiveNodes.push(node)
		}
	}

	return recursiveNodes
}

// Every Protocol that extends itself, directly or through others, reported
// before the rounds and handed back so the hoist resolves it to its own
// surface. See "Recursive declarations" in DEVELOPMENT.md.
function reportRecursiveProtocolDeclarations(
	nodes: Array<parser.ProtocolDeclarationStatementNode>,
	scope: enricher.Scope,
	sink: HoistDiagnosticSink,
): Set<parser.ProtocolDeclarationStatementNode> {
	let declarations = new Map<
		string,
		parser.ProtocolDeclarationStatementNode
	>()

	for (let node of nodes) {
		if (
			scope.protocols[node.name.content] == null &&
			!declarations.has(node.name.content)
		) {
			declarations.set(node.name.content, node)
		}
	}

	// The shortest way from a Protocol back to itself, as the names it
	// passes; empty where it extends itself.
	let pathBackTo = (start: string): Array<string> | null => {
		let previous = new Map<string, string>()
		let queue = [start]

		while (queue.length > 0) {
			let current = queue.shift()!

			for (let clause of declarations.get(current)?.conformsTo ?? []) {
				let target = clause.protocol.content

				if (!declarations.has(target)) {
					continue
				}

				if (target === start) {
					let path: Array<string> = []

					for (
						let step = current;
						step !== start;
						step = previous.get(step)!
					) {
						path.unshift(step)
					}

					return path
				}

				if (!previous.has(target)) {
					previous.set(target, current)
					queue.push(target)
				}
			}
		}

		return null
	}

	let recursive = new Set<parser.ProtocolDeclarationStatementNode>()

	for (let [name, node] of declarations) {
		let through = pathBackTo(name)

		if (through === null) {
			continue
		}

		let reference = node.conformsTo.find(
			(clause) =>
				clause.protocol.content ===
				(through.length === 0 ? name : through[0]),
		)!.protocol
		let notes = [
			"A Protocol's surface is its own Methods together with every ancestor's, so one that extends itself would never finish resolving.",
		]

		if (through.length > 0) {
			let path = [name, ...through, name]
			let sentence = `'${path[0]}' extends '${path[1]}'`

			for (let step = 2; step < path.length; step += 1) {
				sentence += `, which extends '${path[step]}'`
			}

			notes.unshift(`${sentence} again.`)
		}

		let { diagnostics } = collectDiagnostics((): void => {
			reportError(
				through.length === 0
					? `Protocol '${name}' extends itself`
					: `Protocol '${name}' extends itself through '${through[0]}'`,
				reference.position,
				{
					code: "recursive-protocol",
					labels: [
						primary(
							reference.position,
							through.length === 0
								? "this names the Protocol being declared"
								: `this leads back to '${name}'`,
						),
					],
					notes,
					helps: ["Break the cycle — drop one of the extensions."],
				},
			)
		})

		sink(node, diagnostics)
		recursive.add(node)
	}

	return recursive
}

function pendingProtocolNames(
	pendingNodes: Array<PendingDeclaration>,
): Map<enricher.Scope, Set<string>> {
	let pendingProtocols = new Map<enricher.Scope, Set<string>>()

	for (let { node, scope } of pendingNodes) {
		if (node.nodeType !== "ProtocolDeclarationStatement") {
			continue
		}

		let names = pendingProtocols.get(scope)

		if (names === undefined) {
			pendingProtocols.set(scope, new Set([node.name.content]))
		} else {
			names.add(node.name.content)
		}
	}

	return pendingProtocols
}

// Puts the hoistable declarations' Types into Scope before the in-order
// enrichment. The registry of pending refinement copies is closed in the
// `finally`, so a throw can not leave it open. See "Hoisting" in DEVELOPMENT.md.
function hoistDeclarations(
	units: Array<HoistUnit>,
	sink: HoistDiagnosticSink = reportOnwards,
	seedRound?: (final: boolean) => boolean,
): HoistedTypes {
	openPendingRefinementCopies()

	try {
		return hoistDeclarationsInner(units, sink, seedRound)
	} finally {
		closePendingRefinementCopies()
	}
}

function hoistDeclarationsInner(
	units: Array<HoistUnit>,
	sink: HoistDiagnosticSink,
	seedRound: ((final: boolean) => boolean) | undefined,
): HoistedTypes {
	let hoistedTypes: HoistedTypes = new Map()
	let pendingPredicates: Array<PendingPredicate> = []
	let pendingNodes: Array<PendingDeclaration> = units.flatMap((unit) =>
		unit.nodes
			.filter(isHoistable)
			.map((node) => ({ node, scope: unit.scope })),
	)

	// Recursive Type declarations leave the rounds, each seeded as an Error,
	// once per Scope. The seed bypasses `declareTypeInScope`, which would
	// report a duplicate.
	let recursiveNodes: Array<{
		node: HoistableTypeNode
		scope: enricher.Scope
	}> = []

	for (let scope of new Set(units.map((unit) => unit.scope))) {
		let scopedTypeNodes = pendingNodes
			.filter((pending) => pending.scope === scope)
			.map((pending) => pending.node)
			.filter(
				(node): node is HoistableTypeNode =>
					node.nodeType === "TypeAliasStatement" ||
					node.nodeType === "ChoiceDeclarationStatement",
			)

		for (let node of reportRecursiveTypeDeclarations(
			scopedTypeNodes,
			scope,
			sink,
		)) {
			recursiveNodes.push({ node, scope })
			scope.types[node.name.content] = { type: "Error" }
			countTypeDeclaration()
		}
	}

	if (recursiveNodes.length > 0) {
		let recursive = new Set<parser.ImplementationNode>(
			recursiveNodes.map((entry) => entry.node),
		)

		pendingNodes = pendingNodes.filter(
			(pending) => !recursive.has(pending.node),
		)
	}

	// Protocol extension cycles, per Scope. They stay in the rounds.
	let cyclicProtocols = new Set<parser.ProtocolDeclarationStatementNode>()

	for (let scope of new Set(units.map((unit) => unit.scope))) {
		let scopedProtocolNodes = pendingNodes
			.filter((pending) => pending.scope === scope)
			.map((pending) => pending.node)
			.filter(
				(node): node is parser.ProtocolDeclarationStatementNode =>
					node.nodeType === "ProtocolDeclarationStatement",
			)

		for (let node of reportRecursiveProtocolDeclarations(
			scopedProtocolNodes,
			scope,
			sink,
		)) {
			cyclicProtocols.add(node)
		}
	}

	// The Namespaces and Protocols whose Methods could not all be read as
	// predicate aliases yet, because a body named something still to come.
	// Each is read again once `hoistGeneration` moves, and before the final
	// fill.
	let hoistGeneration = 0
	let unreadAliases: Array<{
		blocks: (conjunct: common.PredicateConjunct) => boolean
		reread: () => boolean
		attemptedAt: number
	}> = []
	let rereadAliases = (force: boolean): void => {
		unreadAliases = unreadAliases.filter((entry) => {
			if (!force && entry.attemptedAt === hoistGeneration) {
				return true
			}

			entry.attemptedAt = hoistGeneration

			return !entry.reread()
		})
	}
	// Whether a leaf could still be read further. An unread Namespace blocks
	// the leaves naming it. An unread Protocol blocks those naming one of its
	// Methods, since a conformer's leaf names its own Namespace.
	let unreadLeaf = (conjunct: common.PredicateConjunct): boolean =>
		unreadAliases.some((entry) => entry.blocks(conjunct))

	while (pendingNodes.length > 0) {
		// Seeded first, so an import the previous round made bindable is in
		// Scope while this round resolves.
		let seeded = seedRound?.(false) ?? false

		if (seeded) {
			hoistGeneration++
		}

		// Filled before the declarations, so whatever reads conjuncts in
		// this round finds them written in.
		rereadAliases(false)

		let unfilled = pendingPredicates.length

		fillPendingPredicates(
			pendingPredicates,
			sink,
			hoistedTypes,
			false,
			unreadLeaf,
		)

		// A filled predicate counts as progress even if nothing hoists.
		let filled = pendingPredicates.length < unfilled

		if (filled) {
			hoistGeneration++
		}

		let remainingNodes: Array<PendingDeclaration> = []
		// The Protocols still pending, per Scope. A Namespace conforming to
		// one throws `NotHoistedYet`, since it must reach Scope with its bounds.
		let pendingProtocols = pendingProtocolNames(pendingNodes)

		for (let pending of pendingNodes) {
			let { node, scope } = pending
			let speculation: {
				result: common.Type | common.ProtocolType
				diagnostics: Array<common.Diagnostic>
			}

			try {
				speculation = collectDiagnostics(
					(): common.Type | common.ProtocolType => {
						// The skeleton; the fill reads the predicate later.
						// See "Reading a refined Alias" in DEVELOPMENT.md.
						if (node.nodeType === "TypeAliasStatement") {
							return resolveTypeAliasStatementSkeleton(
								node,
								scope,
							)
						} else if (
							node.nodeType === "ChoiceDeclarationStatement"
						) {
							return resolveChoiceDeclarationStatementType(
								node,
								scope,
							)
						} else if (node.nodeType === "FunctionStatement") {
							return resolveFunctionSignatureType(
								node.value,
								scope,
							)
						} else if (
							node.nodeType === "OverloadedFunctionStatement"
						) {
							return resolveOverloadedFunctionStatementType(
								node,
								scope,
							)
						} else if (
							node.nodeType === "ProtocolDeclarationStatement"
						) {
							return resolveProtocolDeclarationStatementType(
								node,
								scope,
								{
									deferOnPendingProtocols:
										pendingProtocols.get(scope) ??
										new Set(),
									ignoreExtensions: cyclicProtocols.has(node),
								},
							)
						} else {
							return resolveNamespaceDefinitionStatementType(
								node,
								scope,
								{
									deferOnPendingConformance:
										pendingProtocols.get(scope) ??
										new Set(),
								},
							)
						}
					},
				)
			} catch (error) {
				// Only `NotHoistedYet` is retried. Any other throw is a
				// compiler bug, reported against the declaration.
				if (error instanceof NotHoistedYet) {
					remainingNodes.push(pending)
				} else {
					sink(
						node,
						collectDiagnostics(() =>
							reportInternalError(error, node.position),
						).diagnostics,
					)
				}

				continue
			}

			let targetMap: Record<string, common.Type | common.ProtocolType> =
				node.nodeType === "TypeAliasStatement" ||
				node.nodeType === "ChoiceDeclarationStatement"
					? scope.types
					: node.nodeType === "ProtocolDeclarationStatement"
						? scope.protocols
						: scope.members

			// Only an Error keeps a declaration back. A kept resolution's
			// Warnings go to the sink now, since a hoisted Type is not resolved
			// again.
			if (
				!containsErrors(speculation.diagnostics) &&
				targetMap[node.name.content] == null
			) {
				sink(node, speculation.diagnostics)

				targetMap[node.name.content] = speculation.result
				countTypeDeclaration()

				if (node.nodeType === "ProtocolDeclarationStatement") {
					registerProtocol(
						scope,
						speculation.result as common.ProtocolType,
					)
				}

				// The hoist bypasses `declareVariableInScope`, so it drops the
				// Scope's Namespace memo itself: a bodied static Property is
				// enriched during the rounds.
				if (targetMap === scope.members) {
					invalidateNamespacesInScope(
						scope,
						node.name.content,
						speculation.result as common.Type,
					)
				}

				if (
					node.nodeType === "FunctionStatement" ||
					node.nodeType === "OverloadedFunctionStatement" ||
					node.nodeType === "NamespaceDefinitionStatement"
				) {
					scope.constants.add(node.name.content)
				}

				// The predicate aliases are read once the Namespace is in
				// Scope, since a body's calls on `@` may land on it. See
				// "Predicate aliases" in DEVELOPMENT.md.
				if (node.nodeType === "NamespaceDefinitionStatement") {
					let namespaceType =
						speculation.result as common.NamespaceType
					let reread = (): boolean =>
						derivePredicateAliases(node, namespaceType, scope)

					hoistGeneration++

					if (!reread()) {
						unreadAliases.push({
							blocks: (conjunct) =>
								conjunct.namespaceName === node.name.content,
							reread,
							attemptedAt: hoistGeneration,
						})
					}
				} else if (node.nodeType === "ProtocolDeclarationStatement") {
					// The same for a Protocol's provided Methods.
					let protocolType = speculation.result as common.ProtocolType
					let reread = (): boolean =>
						deriveProvidedPredicateAliases(
							node,
							protocolType,
							scope,
						)

					if (!reread()) {
						let names = new Set(Object.keys(protocolType.methods))

						unreadAliases.push({
							blocks: (conjunct) =>
								names.has(conjunct.methodName),
							reread,
							attemptedAt: hoistGeneration,
						})
					}
				}

				// A refined Alias joins the fill list with the object the fill
				// writes into, inside the wrapper for a generic Alias.
				if (node.nodeType === "TypeAliasStatement") {
					let refinement = pendingRefinementIn(
						speculation.result as common.Type,
					)

					if (refinement !== null) {
						pendingPredicates.push({
							node,
							scope,
							refinement,
						})
					}
				}

				hoistedTypes.set(node, speculation.result)
			} else {
				remainingNodes.push(pending)
			}
		}

		let stuck =
			remainingNodes.length === pendingNodes.length && !seeded && !filled

		if (hoistStalls(units, stuck)) {
			break
		}

		pendingNodes = remainingNodes
	}

	// The last declarations to hoist were never offered to the seeding, and
	// an import naming one still has to bind before the bodies.
	seedRound?.(true)
	hoistRefusedDeclarations(pendingNodes, sink, hoistedTypes)

	// The final reading, after the seeding, since an answering Namespace may
	// arrive through an import. Nothing past hoisting meets `conjuncts: null`.
	rereadAliases(true)
	fillPendingPredicates(pendingPredicates, sink, hoistedTypes, true)

	// After the final seeding, so a clause is dropped only where its Protocol
	// never arrives. The rounds solved against unsettled clauses, so every
	// Scope's memo is dropped.
	let settled: Array<common.NamespaceType> = []

	for (let unit of units) {
		for (let node of unit.nodes) {
			let type = hoistedTypes.get(node)

			if (
				type?.type === "Namespace" &&
				node.nodeType === "NamespaceDefinitionStatement" &&
				settleConformanceClauses(type, node, unit.scope)
			) {
				settled.push(type)
			}
		}
	}

	for (let type of settled) {
		for (let unit of units) {
			invalidateNamespacesInScope(unit.scope, type.name, type)
		}
	}

	// Each recursive declaration is resolved once against the seeded Errors,
	// after the rounds so what else it names has hoisted. Its Diagnostics are
	// reported, so a typo inside a cycle still surfaces.
	for (let { node, scope } of recursiveNodes) {
		let { result, diagnostics } = collectDiagnostics((): common.Type => {
			// A throw here is a compiler bug, reported as one. The seeded
			// Error stays.
			try {
				return node.nodeType === "TypeAliasStatement"
					? resolveTypeAliasStatementType(node, scope)
					: resolveChoiceDeclarationStatementType(node, scope)
			} catch (error) {
				reportInternalError(error, node.position)

				return { type: "Error" }
			}
		})

		sink(node, diagnostics)

		scope.types[node.name.content] = result
		countTypeDeclaration()
		hoistedTypes.set(node, result)
	}

	// Where every declaration hoisted, a provided body whose `@` the
	// syntactic reading loses takes its reads from its typing. Each is typed
	// against the others' syntactic reads, which only ask for more.
	if (pendingNodes.length === 0) {
		let narrowed = units.flatMap((unit) =>
			unit.nodes.flatMap((node) => {
				let type = hoistedTypes.get(node)

				return node.nodeType === "ProtocolDeclarationStatement" &&
					type?.type === "Protocol"
					? [
							{
								type,
								reads: typedProvidedReads(
									node,
									type,
									unit.scope,
								),
							},
						]
					: []
			}),
		)

		for (let { type, reads } of narrowed) {
			Object.assign(type.providedReads ?? {}, reads)
		}

		if (narrowed.some(({ reads }) => Object.keys(reads).length > 0)) {
			for (let scope of new Set(units.map((unit) => unit.scope))) {
				invalidateConformancesInScope(scope)
			}
		}
	}

	return hoistedTypes
}

// `enrichPrograms` passes `hoistedTypes` from its hoist over the whole group.
// A lone Program hoists its own.
const enrichImplementation = (
	implementation: parser.ImplementationSectionNode,
	scope: enricher.Scope,
	hoistedTypes: HoistedTypes = hoistDeclarations([
		{ nodes: implementation.nodes, scope },
	]),
): common.typed.ImplementationSectionNode => {
	return {
		nodeType: "ImplementationSection",
		nodes: implementation.nodes.flatMap((node) =>
			enrichTopLevelNode(node, scope, hoistedTypes),
		),
		position: implementation.position,
	}
}

// An `overload function` block becomes one top-level Function per bodied
// entry, named `<name>__overload$N` for its slot.
const enrichTopLevelNode = (
	node: parser.ImplementationNode,
	scope: enricher.Scope,
	hoistedTypes: HoistedTypes,
): Array<common.typed.ImplementationNode> =>
	guarded(node.position, () =>
		node.nodeType === "OverloadedFunctionStatement"
			? enrichOverloadedFunctionStatement(
					node,
					scope,
					hoistedTypes.get(node),
				)
			: enrichNode(node, scope, hoistedTypes),
	)

// A throw here is a compiler bug. It is reported as an `internal-error`, so
// one broken Statement does not stop the rest of the Program.
const guarded = <NodeType>(
	position: common.Position,
	enrich: () => Array<NodeType>,
): Array<NodeType> => {
	try {
		return enrich()
	} catch (error) {
		reportInternalError(error, position)

		return []
	}
}

function reportInternalError(error: unknown, position: common.Position): void {
	reportError(
		`Internal Compiler Error: ${
			error instanceof Error ? error.message : String(error)
		}`,
		position,
		{
			code: "internal-error",
			labels: [primary(position, "the Compiler threw here")],
			notes: ["This is a bug in the Compiler, not in the Program."],
		},
	)
}

// Where an item of a tests section sits: the path its identity is built from,
// and the Modifiers of the suites covering it.
type TestsContext = {
	suitePath: Array<string>
	covering: TestModifiers
	// What every identity in the section spells as its Module.
	modulePath: string | null
}

// The `tests { … }` block, enriched only where the compile asked for it. In
// a child Scope of the top level it sees every declaration. Its helpers stay
// out of the implementation's reach, and a reused name shadows.
export const enrichTestsSection = (
	section: parser.TestsSectionNode,
	scope: enricher.Scope,
	// See `enrich`'s own `testsPath`.
	testsPath?: string,
): common.typed.TestsSectionNode => {
	return {
		nodeType: "TestsSection",
		// No barrier: the runner awaits each test, so the setup and a plain
		// test may `complete`. `enrichTest` bars the forms that can not wait.
		nodes: enrichTestsNodes(section.nodes, childScope(scope), {
			suitePath: [],
			covering: noModifiers,
			modulePath: modulePathOf(scope) ?? testsPath ?? null,
		}),
		position: section.position,
	}
}

const enrichTestsNodes = (
	nodes: Array<parser.TestsNode>,
	scope: enricher.Scope,
	context: TestsContext,
): Array<common.typed.TestsNode> => {
	refuseDuplicateNames(nodes)

	// Only the ordinary Statements hoist, since a test or a suite declares no
	// name.
	let hoistedTypes = hoistDeclarations([
		{
			nodes: nodes.filter(isStatementOfTests),
			scope,
		},
	])

	return nodes.flatMap((node) =>
		guarded<common.typed.TestsNode>(node.position, () => {
			if (node.nodeType === "Test") {
				return [enrichTest(node, scope, context)]
			}

			if (node.nodeType === "Suite") {
				return [enrichSuite(node, scope, context)]
			}

			if (node.nodeType === "OverloadedFunctionStatement") {
				return enrichOverloadedFunctionStatement(
					node,
					scope,
					hoistedTypes.get(node),
				)
			}

			return enrichNode(node, scope, hoistedTypes)
		}),
	)
}

function isStatementOfTests(
	node: parser.TestsNode,
): node is parser.ImplementationNode {
	return node.nodeType !== "Test" && node.nodeType !== "Suite"
}

// Whether the test's name reads the row the table binds, through any name a
// Pattern Parameter binds. If so, a widened row Type must stay Printable.
function nameReadsTheRow(
	name: parser.StringValueNode | parser.InterpolatedStringValueNode,
	table: parser.TestTableNode,
): boolean {
	if (name.nodeType !== "InterpolatedStringValue") {
		return false
	}

	let parameter = table.parameters[0]?.internalName
	let bound =
		parameter === undefined || parameter === null
			? []
			: parameter.nodeType === "Pattern"
				? patternBindings(parameter).map((one) => one.name.content)
				: [parameter.content]

	return name.segments.some(
		(segment) =>
			segment.kind === "expression" &&
			segment.expression.nodeType === "Identifier" &&
			bound.includes(segment.expression.content),
	)
}

const enrichTest = (
	node: parser.TestNode,
	scope: enricher.Scope,
	context: TestsContext,
): common.typed.TestNode => {
	let modifiers = mergedModifiers(
		resolveTestModifiers(node.modifiers, "test"),
		context.covering,
	)
	// A Scope per test, so tests share only the setup. A benchmark or a
	// property test runs its body many times, measured or replayed, so it can
	// not `complete`; the setup above it can.
	let bodyScope = childScope(scope)

	if (node.form === "benchmark" || node.properties !== null) {
		bodyScope.completing = null
		bodyScope.completingBarrier =
			node.form === "benchmark" ? "benchmark-body" : "property-body"
	}
	// Before the name and the body, which both read the row.
	let table =
		node.table === null
			? null
			: enrichTestTable(
					node.table,
					scope,
					bodyScope,
					modifiers.skipped !== null,
					nameReadsTheRow(node.name, node.table),
				)

	if (node.table !== null) {
		refuseTableDefaults(node.table)
	}
	// Never together with a table.
	let properties =
		node.properties === null
			? null
			: enrichTestProperties(node.properties, scope, bodyScope)

	if (table !== null && properties !== null) {
		refuseBothTestForms(node)
	}

	if (node.form === "benchmark" && properties !== null) {
		refuseGeneratedBenchmark(node)
	}

	let body = node.body.flatMap((child) =>
		guarded(child.position, () => enrichNode(child, bodyScope)),
	)

	if (table !== null) {
		refuseSnapshots(body, "table")
	}

	if (properties !== null) {
		refuseSnapshots(body, "property")
	}

	return {
		nodeType: "Test",
		form: node.form,
		identity: {
			modulePath: context.modulePath,
			suitePath: context.suitePath,
			name: nameTemplate(node.name),
		},
		// Only a table test's name reads the body's Scope. A property differs
		// every case, so its name can not read it.
		name: enrichTestName(
			node.name,
			nameScope(table === null ? scope : bodyScope),
		),
		tags: modifiers.tags,
		skipped: modifiers.skipped,
		focused: modifiers.focused,
		table,
		properties,
		cases: null,
		body,
		keywordPosition: node.keywordPosition,
		position: node.position,
	}
}

// A test name is rendered before the run, so `--filter` matches what a reader
// sees. So it can not `complete` anything.
const nameScope = (scope: enricher.Scope): enricher.Scope =>
	childScope(scope, {
		completing: null,
		completingBarrier: "test-name",
	})

const enrichSuite = (
	node: parser.SuiteNode,
	scope: enricher.Scope,
	context: TestsContext,
): common.typed.SuiteNode => {
	let modifiers = mergedModifiers(
		resolveTestModifiers(node.modifiers, "suite"),
		context.covering,
	)
	let name = nameTemplate(node.name)
	// A suite is a Scope too: what it declares is setup for its own tests.
	let bodyScope = childScope(scope)

	return {
		nodeType: "Suite",
		identity: {
			modulePath: context.modulePath,
			suitePath: context.suitePath,
			name,
		},
		name: enrichTestName(node.name, nameScope(scope)),
		tags: modifiers.tags,
		skipped: modifiers.skipped,
		focused: modifiers.focused,
		nodes: enrichTestsNodes(node.nodes, bodyScope, {
			suitePath: [...context.suitePath, name],
			covering: modifiers,
			modulePath: context.modulePath,
		}),
		keywordPosition: node.keywordPosition,
		position: node.position,
	}
}

// `across` and `for any` each say what the body runs for, so a test may
// write only one.
const refuseBothTestForms = (node: parser.TestNode): void => {
	if (node.table === null || node.properties === null) {
		return
	}

	reportError(
		"A test runs written rows or generated values, not both",
		node.properties.keywordPosition,
		{
			code: "contradictory-test-forms",
			labels: [
				primary(
					node.properties.keywordPosition,
					"this generates a value for every case",
				),
				secondary(node.table.keywordPosition, "and this runs the rows"),
			],
			notes: [
				"A table test runs its body once per row a reader wrote; a property test runs it once per value the runner made up. One body can not do both.",
			],
			helps: [
				"Keep one of them, or write two tests — one over the rows and one over the generated values.",
			],
		},
	)
}

// A benchmark compares runs that do the same work, which generated values do
// not. The properties are still enriched, so the tree stays whole for an
// editor.
const refuseGeneratedBenchmark = (node: parser.TestNode): void => {
	if (node.properties === null) {
		return
	}

	reportError(
		"A benchmark times written work, not generated values",
		node.properties.keywordPosition,
		{
			code: "benchmark-for-any",
			labels: [
				primary(
					node.properties.keywordPosition,
					"this asks for a value the runner makes up",
				),
				secondary(node.keywordPosition, "and this asks for a timing"),
			],
			notes: [
				"A measurement is comparable only where every run does the same work, and a generated value changes the work every case.",
			],
			helps: [
				"Write the inputs: a constant above the benchmark, or the rows to measure — across [ … ].",
			],
		},
	)
}

// Every row of a table test runs one body, so an inline snapshot there would
// have one slot for many values. A named one is stored per row
// (`snapshotted`). A property test may record no snapshot at all.
const refuseSnapshots = (
	nodes: Array<common.typed.ImplementationNode>,
	form: "table" | "property",
): void => {
	let visit = (node: TypedNode): void => {
		let snapshot =
			node.nodeType === "ExpectStatement" ||
			node.nodeType === "RequireStatement"
				? node.snapshot
				: null

		if (
			snapshot !== null &&
			(form === "property" || snapshot.name === null)
		) {
			reportError(
				form === "property"
					? "A property test can not record a snapshot"
					: "A snapshot in a table test has to be named",
				snapshot.position,
				form === "property"
					? {
							code: "snapshot-in-property",
							labels: [
								primary(
									snapshot.position,
									"every case would record here",
								),
							],
							notes: [
								"A property test runs its body once per generated value, so a snapshot written here records a different value every case and only the last of them could ever match.",
							],
							helps: [
								"Assert what holds for every value instead — 'expect …' — and snapshot a value a test WROTE, in a test of its own.",
							],
						}
					: {
							code: "inline-snapshot-in-table",
							labels: [
								primary(
									snapshot.position,
									"this records into the source, and every row would record here",
								),
							],
							notes: [
								"Every row of a table test runs this body, so a snapshot written here holds one value per row — and an inline snapshot is one slot of one line.",
							],
							helps: [
								"Name it: 'matches snapshot from \"…\"'. Each row records an entry of its own, numbered by the row it ran for.",
							],
						},
			)
		}

		forEachTypedChild(node, visit)
	}

	for (let node of nodes) {
		visit(node)
	}
}

// The cast holds: a name is a String Literal or an interpolated one, and
// enriching either answers a Node of the same kind.
const enrichTestName = (
	node: parser.StringValueNode | parser.InterpolatedStringValueNode,
	scope: enricher.Scope,
): common.typed.StringValueNode | common.typed.InterpolatedStringValueNode => {
	return enrichExpression(node, scope) as
		| common.typed.StringValueNode
		| common.typed.InterpolatedStringValueNode
}
