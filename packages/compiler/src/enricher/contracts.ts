import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	containsErrors,
	primary,
	reportInformation,
} from "../diagnostics/index"
import {
	deriveGenerator,
	enrichExpression,
	invocationArguments,
	predicateCheck,
} from "./enrichers"
import { childScope } from "./scope"

// NOTE: A checked refinement IS a property, and a Namespace Method that writes
// one in its return Type has already stated the property its answer holds. This
// turns that statement into the test it is: generate the receiver and every
// Argument from the declared Types, call the Method, and expect the answer to
// hold every conjunct the return Type promises. The goals stand in a synthetic
// suite called `contracts`, beside the `examples` suite and for the same reason
// — a reader who asks for a file's tests is shown the ones they wrote and,
// beside them, the ones their declarations promise.
//
// NOTE: A goal that THROWS fails, and that is the contract even where the
// return Type refines nothing: a Method is declared over a domain, and totality
// over the domain it declared is the smallest thing a signature says. So every
// entry gets a goal, and the ones with refinements get expects as well.
//
// NOTE: For a Method written in Essence the prover has already guaranteed the
// refinements, so a stdlib contract run is a Compiler soundness harness rather
// than a check on the library. Where the goals earn their keep is the two seams
// the prover can not see through: a native binding, and a `Generatable`
// conformance that hands back a value its own Type refuses.

// NOTE: The name the answer is bound to inside a goal's body. A `$` name no
// Essence source can spell, so a Method taking an Argument labelled `answer`
// can not collide with it, and one name for every goal because a goal is its
// own Scope.
const ANSWER = "$answer"

// NOTE: The suite every goal is reported under. It collides with a suite an
// author writes under the same name, exactly as `examples` does — a known and
// shared hazard, kept rather than papered over with a name nobody would guess.
export const CONTRACT_SUITE = "contracts"

// NOTE: One Namespace's goals, and what was skipped on the way. The skips are
// carried rather than reported as they happen so that a Namespace whose Methods
// are mostly generic says so ONCE, naming them together, instead of filling a
// report with one remark per Method.
type Synthesis = {
	goals: Array<common.typed.TestNode>
	skipped: Array<{ name: string; reason: string }>
}

// NOTE: The `suite "contracts" { … }` a Module's own declarations promise, or
// null where they promise nothing this can build. It is TYPED rather than
// parsed — the `@example` precedent synthesizes Parser Nodes because what it
// compiles is written down in a Comment, and a goal is written nowhere at all —
// so it is appended to the enriched section after the written walk, where every
// stage below reads it as the ordinary property test it is.
export function contractSuite(
	program: parser.Program,
	scope: enricher.Scope,
	position: common.Position,
	modulePath: string | null,
): common.typed.SuiteNode | null {
	let goals: Array<common.typed.TestNode> = []

	for (let node of program.implementation.nodes) {
		if (node.nodeType !== "NamespaceDefinitionStatement") {
			continue
		}

		// NOTE: The Module's OWN declarations, read out of the Scope the
		// implementation filled rather than out of `getAllNamespacesInScope` —
		// which answers with the whole prelude beside them. The standard
		// library's Methods get their goals when the standard library's own
		// test run compiles ITS declarations, which is the only place they are
		// declared rather than imported.
		let namespace = scope.members[node.name.content]

		if (namespace === undefined || namespace.type !== "Namespace") {
			continue
		}

		let synthesis = namespaceGoals(namespace, scope, position, modulePath)

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
	scope: enricher.Scope,
	position: common.Position,
	modulePath: string | null,
): Synthesis {
	let synthesis: Synthesis = { goals: [], skipped: [] }

	for (let [methodName, method] of Object.entries(namespace.methods)) {
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
			// NOTE: The WHOLE synthesis is speculative. Deriving a generator
			// reports what it can not build, and rebuilding the call reports
			// what does not typecheck — both about code nobody wrote, and both
			// answered once, about the Namespace, by whoever asked. So the
			// collection is opened here and the Diagnostics inside it are read
			// for their first message and then dropped.
			let attempt = collectDiagnostics(() =>
				goalOf(
					namespace,
					methodName,
					entry,
					isStatic,
					name,
					scope,
					position,
					modulePath,
				),
			)

			if (
				attempt.result === null ||
				containsErrors(attempt.diagnostics)
			) {
				synthesis.skipped.push({
					name,
					reason:
						attempt.diagnostics[0]?.message ??
						"its Parameters can not be generated",
				})

				continue
			}

			synthesis.goals.push(attempt.result)
		}
	}

	return synthesis
}

// NOTE: One entry as the property test it is, or null where anything it needs
// refused. Everything here happens inside the caller's speculative collection:
// a null answer and a reported Diagnostic mean the same thing to it, and a goal
// that half-built leaves nothing behind but a Scope nobody keeps.
function goalOf(
	namespace: common.NamespaceType,
	methodName: string,
	entry: common.BaseFunction,
	isStatic: boolean,
	name: string,
	scope: enricher.Scope,
	position: common.Position,
	modulePath: string | null,
): common.typed.TestNode | null {
	// NOTE: A Method whose signature still mentions a Type Parameter is left
	// alone. What a generic Method's contract says is a claim about every
	// instantiation of it, and the values this generates are drawn from ONE —
	// so a goal over it would either not typecheck or quietly prove the
	// contract for an Integer and report it as proven for all of them.
	if (entry.generics.length > 0) {
		return null
	}

	let members: Record<string, common.Type> = {}
	let parameters: Array<common.typed.TestPropertyNode> = []
	let values: Array<parser.ExpressionNode> = []

	for (let [index, parameter] of entry.parameterTypes.entries()) {
		let generator = deriveGenerator(parameter.type, scope, position, [])

		if (generator === null) {
			return null
		}

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

	// NOTE: A Scope of the goal's own, holding one Constant per generated
	// value. Built whole rather than filled Parameter by Parameter, because a
	// Scope with a name written into it after something has read it is a Scope
	// whose memoised Namespace table has already answered without it.
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
		return null
	}

	let body = bodyOf(answer, bodyScope, position)

	if (body === null) {
		return null
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
		// NOTE: A Method that takes nothing and has no receiver has nothing to
		// generate, so its goal is a plain test that runs ONCE. A property test
		// with no Parameters is the shape `for any ()` is refused for.
		properties:
			parameters.length === 0
				? null
				: { nodeType: "TestProperties", parameters, position },
		body,
		keywordPosition: position,
		position,
	}
}

// NOTE: What a goal RUNS: the call, and one `expect` per conjunct the answer's
// Type promises.
//
// With conjuncts the answer is bound, because every expect reads it and a call
// taken apart must run once. Without them the call stands as a bare Expression
// Statement rather than as a Constant nothing reads — `eliminate-dead-code`
// drops one of those wherever the call is provably pure, and a goal that
// dropped its own call would report a Method as total without having run it.
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

		// NOTE: A conjunct nothing can rebuild takes the whole goal with it. A
		// goal reported under the Method's own name claims the Method's whole
		// contract, and one that checked half of it would be a passing test
		// about a promise nobody kept.
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
			// NOTE: A Constant no source wrote, which is what keeps the
			// Simplifier from handing it a probe point: what an Editor draws
			// beside a written Constant is the value the author named, and
			// nobody named this one.
			synthesized: "binding",
		},
		...expects,
	]
}

// NOTE: The call the goal makes, spelled the way an author would have written
// it — a Method through its own Namespace, so that two Namespaces answering one
// name for one Type stay told apart, and a static as the Lookup it is.
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

// NOTE: What one generated value is called inside the goal's body, and what a
// counterexample is reported beside. The Parameter's own LABEL wherever it has
// one, because that is the word the author chose for it; `receiver` for the
// Parameter a non-static signature is prefixed with, and `argument1` upward for
// the positional ones. A name already taken by an earlier Parameter — a label
// spelled `receiver`, two positional Parameters — is numbered until it is free.
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

// NOTE: The Method's full spelling, which is what a reader searching a report
// looks for and what makes the identity stable: a stable name is a stable id,
// and a stable id is what the corpus, the seeds and the shrinking are keyed by.
// The Arguments are spelled as a call site writes them — `label:` where one is
// labelled and `_` where it is positional — so two entries of an Overload are
// told apart by what they TAKE wherever that is enough, and by the entry number
// where it is not.
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

// NOTE: Said ONCE per Namespace, and quietly. A Method whose goal could not be
// built is not a mistake anybody made — a generic Method, a Parameter nothing
// knows how to draw a value of — and a run that stayed silent about them would
// leave a reader believing their whole Namespace was under contract.
function reportSkippedGoals(
	node: parser.NamespaceDefinitionStatementNode,
	skipped: Array<{ name: string; reason: string }>,
): void {
	if (skipped.length === 0) {
		return
	}

	let first = skipped[0]!

	reportInformation(
		`${countOf(skipped.length)} of '${node.name.content}' got no contract test`,
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
				"Write the property as a test of its own, or declare a 'Generatable' conformance for the Type its Parameters could not be drawn from.",
			],
		},
	)
}

function countOf(count: number): string {
	return count === 1 ? "One Method" : `${count} Methods`
}
