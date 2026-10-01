import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	containsErrors,
	primary,
	reportInformation,
} from "../diagnostics/index"
import { countOf } from "../helpers/describe"
import {
	deriveGenerator,
	enrichExpression,
	invocationArguments,
	predicateCheck,
} from "./enrichers"
import { childScope } from "./scope"

// Each Namespace Method becomes a property test, a goal: generate its
// Arguments, call it, and expect the answer to hold its return Type's
// conjuncts. See "Contract goals" in DEVELOPMENT.md.

// The cases one goal runs unless `--cases` says otherwise.
const CONTRACT_CASES = 25

// A name no Essence source can spell, so no Argument label collides with it.
const ANSWER = "$answer"

export const CONTRACT_SUITE = "contracts"

// The skips are carried, so a Namespace reports them once, together.
type Synthesis = {
	goals: Array<common.typed.TestNode>
	skipped: Array<{ name: string; reason: string; generation: boolean }>
}

// Why one entry got no goal. Only `generic` is skipped silently.
type GoalSkip = {
	skip: "generic" | "generation" | "call" | "conjunct" | "asynchronous"
}

function skipOf(answer: common.typed.TestNode | GoalSkip): GoalSkip | null {
	return "skip" in answer ? answer : null
}

// The `suite "contracts" { … }` a Module's declarations promise, as typed
// Nodes, or null where they promise nothing this can build.
export function contractSuite(
	program: parser.Program,
	scope: enricher.Scope,
	position: common.Position,
	modulePath: string | null,
): common.typed.SuiteNode | null {
	let goals: Array<common.typed.TestNode> = []
	// One generator per Type object for the whole Module, since the entries
	// share their receiver Type. A failure is not kept, so its report stays
	// with the goal that asked.
	let derived = new WeakMap<common.Type, common.typed.TestGenerator>()

	for (let node of program.implementation.nodes) {
		if (node.nodeType !== "NamespaceDefinitionStatement") {
			continue
		}

		// The Module's own Namespaces, read off the Scope rather than through
		// `getAllNamespacesInScope`, which adds the standard library's.
		let namespace = scope.members[node.name.content]

		if (namespace === undefined || namespace.type !== "Namespace") {
			continue
		}

		// Only the Methods this statement wrote, since the Scope answers the
		// merged Namespace.
		let declared = new Set(Object.keys(node.methods))
		let synthesis = namespaceGoals(
			namespace,
			declared,
			scope,
			position,
			modulePath,
			derived,
		)

		goals.push(...synthesis.goals)
		reportSkippedGoals(node, synthesis.skipped)
	}

	if (goals.length === 0) {
		return null
	}

	return {
		nodeType: "Suite",
		identity: { modulePath, suitePath: [], name: CONTRACT_SUITE },
		name: {
			nodeType: "StringValue",
			value: CONTRACT_SUITE,
			position,
			type: { type: "String" },
		},
		tags: [],
		skipped: null,
		focused: null,
		nodes: goals,
		keywordPosition: position,
		position,
	}
}

function namespaceGoals(
	namespace: common.NamespaceType,
	declared: Set<string>,
	scope: enricher.Scope,
	position: common.Position,
	modulePath: string | null,
	derived: WeakMap<common.Type, common.typed.TestGenerator>,
): Synthesis {
	let synthesis: Synthesis = { goals: [], skipped: [] }

	for (let [methodName, method] of Object.entries(namespace.methods)) {
		if (!declared.has(methodName)) {
			continue
		}

		let isStatic =
			method.type === "StaticMethod" ||
			method.type === "OverloadedStaticMethod"
		let entries =
			method.type === "OverloadedMethod" ||
			method.type === "OverloadedStaticMethod"
				? method.overloads
				: [method]

		for (let [index, entry] of entries.entries()) {
			let name = goalName(
				namespace.name,
				methodName,
				entry,
				isStatic,
				entries.length === 1 ? null : index + 1,
			)
			// Speculative: the Diagnostics are read for their first message
			// and dropped, and a throw skips the goal rather than failing the
			// compile.
			let attempt
			try {
				attempt = collectDiagnostics(() =>
					goalOf(
						namespace,
						methodName,
						entry,
						isStatic,
						name,
						scope,
						position,
						modulePath,
						derived,
					),
				)
			} catch (error) {
				synthesis.skipped.push({
					name,
					reason: `an internal Compiler error stopped it: ${
						error instanceof Error ? error.message : String(error)
					}`,
					generation: false,
				})

				continue
			}

			let skip = skipOf(attempt.result)

			if (skip !== null || containsErrors(attempt.diagnostics)) {
				// No conformance could make a generic entry eligible.
				if (skip?.skip === "generic") {
					continue
				}

				let generation =
					skip === null ||
					skip.skip === "generation" ||
					attempt.diagnostics.some(
						(diagnostic) =>
							diagnostic.code === "ungeneratable-type",
					)

				synthesis.skipped.push({
					name,
					reason:
						attempt.diagnostics[0]?.message ??
						(skip?.skip === "call"
							? "the call it would make does not typecheck"
							: skip?.skip === "conjunct"
								? "its return Type's refinement holds a predicate nothing can rebuild as a check"
								: skip?.skip === "asynchronous"
									? "it answers work rather than a value, and a goal that completed it would run it"
									: "its Parameters can not be generated"),
					generation,
				})

				continue
			}

			synthesis.goals.push(attempt.result as common.typed.TestNode)
		}
	}

	return synthesis
}

// One entry's goal, or why it has none. It runs inside the caller's
// collection, where a skip and a reported Diagnostic mean the same thing.
function goalOf(
	namespace: common.NamespaceType,
	methodName: string,
	entry: common.BaseFunction,
	isStatic: boolean,
	name: string,
	scope: enricher.Scope,
	position: common.Position,
	modulePath: string | null,
	derived: WeakMap<common.Type, common.typed.TestGenerator>,
): common.typed.TestNode | GoalSkip {
	// A generic contract speaks of every instantiation, and generated values
	// come from one.
	if (entry.generics.length > 0) {
		return { skip: "generic" }
	}

	let members: Record<string, common.Type> = {}
	let parameters: Array<common.typed.TestPropertyNode> = []
	let values: Array<parser.ExpressionNode> = []

	for (let [index, parameter] of entry.parameterTypes.entries()) {
		let generator =
			derived.get(parameter.type) ??
			deriveGenerator(parameter.type, scope, position, [])

		if (generator === null) {
			return { skip: "generation" }
		}

		derived.set(parameter.type, generator)

		let binding = bindingName(parameter, index, isStatic, members)

		members[binding] = parameter.type

		parameters.push({
			nodeType: "TestProperty",
			name: binding,
			type: parameter.type,
			generator,
			position,
		})
		values.push({ nodeType: "Identifier", content: binding, position })
	}

	// One Constant per generated value, built whole: a name written into a
	// Scope after a read would miss its memoised Namespace table.
	let bodyScope = childScope(scope, {
		members,
		constants: new Set(Object.keys(members)),
	})
	let call = invocation(
		namespace.name,
		methodName,
		entry,
		isStatic,
		values,
		position,
	)
	let answer = enrichExpression(call, bodyScope)

	if (answer.type.type === "Error") {
		return { skip: "call" }
	}

	// The bare call would raise `unused-future` with no position to edit,
	// and completing it would perform its effect.
	if (answer.type.type === "Future" || answer.type.type === "Started") {
		return { skip: "asynchronous" }
	}

	let body = bodyOf(answer, bodyScope, position)

	if (body === null) {
		return { skip: "conjunct" }
	}

	return {
		nodeType: "Test",
		form: "test",
		identity: { modulePath, suitePath: [CONTRACT_SUITE], name },
		name: {
			nodeType: "StringValue",
			value: name,
			position,
			type: { type: "String" },
		},
		tags: [],
		skipped: null,
		focused: null,
		table: null,
		// With nothing to generate, the goal is a plain test that runs once,
		// since a property test needs a Parameter.
		properties:
			parameters.length === 0
				? null
				: { nodeType: "TestProperties", parameters, position },
		cases: parameters.length === 0 ? null : CONTRACT_CASES,
		body,
		keywordPosition: position,
		position,
	}
}

// The call, and one `expect` per conjunct the answer's Type promises, which
// read it from one Constant. Without conjuncts the call stands bare, since
// `eliminate-dead-code` would drop an unread Constant.
function bodyOf(
	answer: common.typed.ExpressionNode,
	scope: enricher.Scope,
	position: common.Position,
): Array<common.typed.ImplementationNode> | null {
	let refinement = answer.type

	if (refinement.type !== "Refinement") {
		return [answer]
	}

	let conjuncts = refinement.conjuncts ?? []

	if (conjuncts.length === 0) {
		return [answer]
	}

	let expects: Array<common.typed.ImplementationNode> = []

	for (let conjunct of conjuncts) {
		let check = predicateCheck(
			conjunct,
			refinement,
			ANSWER,
			scope,
			position,
		)

		// A goal claims the whole contract, so one conjunct it can not check
		// drops the goal.
		if (check === null) {
			return null
		}

		expects.push({
			nodeType: "ExpectStatement",
			value: check,
			matcher: null,
			snapshot: null,
			position,
		})
	}

	return [
		{
			nodeType: "ConstantDeclarationStatement",
			name: {
				nodeType: "Identifier",
				content: ANSWER,
				position,
				type: answer.type,
			},
			value: answer,
			position,
			headPosition: position,
			declaredType: null,
			type: answer.type,
			documentation: null,
			// No source wrote it, so the simplifier gives it no probe point.
			synthesized: "binding",
		},
		...expects,
	]
}

// The call as an author would write it. A Method names its Namespace, so two
// Namespaces answering one name for one Type stay apart.
function invocation(
	namespaceName: string,
	methodName: string,
	entry: common.BaseFunction,
	isStatic: boolean,
	values: Array<parser.ExpressionNode>,
	position: common.Position,
): parser.ExpressionNode {
	if (isStatic) {
		return {
			nodeType: "FunctionInvocation",
			name: {
				nodeType: "Lookup",
				base: {
					nodeType: "Identifier",
					content: namespaceName,
					position,
				},
				member: {
					nodeType: "Identifier",
					content: methodName,
					position,
				},
				position,
			},
			arguments: invocationArguments(
				entry.parameterTypes,
				values,
				position,
			),
			position,
		}
	}

	return {
		nodeType: "MethodInvocation",
		base: values[0]!,
		member: { nodeType: "Identifier", content: methodName, position },
		namespaceSpecifier: {
			nodeType: "Identifier",
			content: namespaceName,
			position,
		},
		arguments: invocationArguments(
			entry.parameterTypes.slice(1),
			values.slice(1),
			position,
		),
		position,
	}
}

// The name a generated value has in the goal and in a counterexample: the
// Parameter's label, else `receiver` or `argument1` upward. A taken name is
// numbered until it is free.
function bindingName(
	parameter: common.Parameter,
	index: number,
	isStatic: boolean,
	taken: Record<string, common.Type>,
): string {
	let preferred =
		parameter.name ??
		(!isStatic && index === 0 ? "receiver" : `argument${index + 1}`)
	let name = preferred
	let attempt = 1

	while (taken[name] !== undefined) {
		attempt += 1
		name = `${preferred}${attempt}`
	}

	return name
}

// The Method's full spelling, a stable identity for stored seeds and
// counterexamples. Labels spell as `label:` and positional Parameters as `_`;
// an Overload's entries also carry their number.
function goalName(
	namespaceName: string,
	methodName: string,
	entry: common.BaseFunction,
	isStatic: boolean,
	overload: number | null,
): string {
	let parameters = isStatic
		? entry.parameterTypes
		: entry.parameterTypes.slice(1)
	let spelled = parameters
		.map((parameter) =>
			parameter.name === null ? "_" : `${parameter.name}:`,
		)
		.join(", ")
	let name = `${namespaceName}${isStatic ? "." : "::"}${methodName}(${spelled})`

	return overload === null ? name : `${name} overload ${overload}`
}

// Said once per Namespace, as Information, so a reader knows which Methods
// are not under contract.
function reportSkippedGoals(
	node: parser.NamespaceDefinitionStatementNode,
	skipped: Synthesis["skipped"],
): void {
	if (skipped.length === 0) {
		return
	}

	let first = skipped[0]!
	// The `Generatable` help applies only where a generation failed.
	let generation = skipped.some((entry) => entry.generation)

	reportInformation(
		`${countOf(skipped.length, "Method")} of '${node.name.content}' got no contract test`,
		node.name.position,
		{
			code: "ungeneratable-contract",
			labels: [
				primary(
					node.name.position,
					`${skipped.length === 1 ? "this Namespace declares one Method" : `${skipped.length} of this Namespace's Methods`} nothing could build a goal for`,
				),
			],
			notes: [
				`${skipped.map((entry) => `'${entry.name}'`).join(", ")}.`,
				`'${first.name}' was left out because ${first.reason}.`,
			],
			helps: [
				generation
					? "Write the property as a test of its own, or declare a 'Generatable' conformance for the Type its Parameters could not be drawn from."
					: "Write the property as a test of its own.",
			],
		},
	)
}
