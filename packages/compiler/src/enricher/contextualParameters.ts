import { isDeepStrictEqual } from "node:util"

import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	primary,
	report,
	reportError,
} from "../diagnostics/index"
import { countOf, describeType, withArticle } from "../helpers/describe"
import { eraseRefinements } from "../helpers/eraseRefinements"
import { parameterInternalName } from "../helpers/names"
import { pairedByPlace } from "../helpers/readerPairing"
import {
	applyGenericBindings,
	createFreshenedInference,
	type GenericBindings,
	type MatchableArgument,
	matchArguments,
	matchesType,
	mentionsUnsolvedTypeParameter,
	pairArguments,
	insideHoist,
	typeContainsError,
	typeContainsRefinement,
} from "../helpers/types"
import { findParserChild, type ParserNode } from "../visitor/index"
import { type ArgumentTyper, inferReturnTypeFromBody } from "./enrichers"
import { insideRefusedCall, underRefusedCall } from "./refusedCalls"
import {
	parameterDocumentation,
	reportDocumentationParameters,
	resolveDeclaredType,
	scopeWithGenerics,
} from "./resolvers"
import { firstRead } from "./waitingReads"

// What Function literals reported while a call's candidates were probed: per
// literal, a list per resolution with the candidate it was read against. See
// "Literals a candidate does not fit" in DEVELOPMENT.md.
type HeldReports = {
	candidate: number
	// Whether more candidates than one take the call's labels, so a literal's
	// body may be what tells them apart.
	several: boolean
	// What each candidate's literals answer, for `chooseByAnswers`.
	answers: Map<number, Map<parser.ExpressionNode, LiteralAnswer>>
	// The candidates found to fit so far, in the order they were probed.
	fitting: Array<number>
	byLiteral: Map<
		parser.FunctionDefinitionNode,
		Array<{ candidate: number; diagnostics: Array<common.Diagnostic> }>
	>
}

// Whether a Function literal leaves an annotation out, so it takes its Types
// from the Parameter it is passed to.
export function needsContext(node: parser.FunctionDefinitionNode): boolean {
	return (
		node.returnType === null ||
		node.parameters.some((parameter) => parameter.type === null)
	)
}

// Null stands for a call being enriched, so no call around it holds its
// reports.
let heldReports: Array<HeldReports | null> = []

// Enriches a call, whose Arguments read their own places. No refused call's
// flag and no hold of a call around it reaches them.
export function enteringCall<T>(work: () => T): T {
	heldReports.push(null)

	try {
		return underRefusedCall(false, work)
	} finally {
		heldReports.pop()
	}
}

// Where a call's candidate probing puts what its own literals reported, while
// a caller decides whether those reports stand. Null reports them at once.
let holding: Array<common.Diagnostic> | null = null

// What the call's own literals reported while its candidates were probed. A
// committed winner reads its literals again, so they stand only where none is
// committed. A report made directly, as an Argument's first enrichment, is not
// held. See "Literals a candidate does not fit" in DEVELOPMENT.md.
export function holdLiteralReports(): {
	during: <T>(work: () => T) => T
	release: (stands: boolean) => void
} {
	let held: Array<common.Diagnostic> = []

	return {
		during: (work) => {
			let outer = holding

			holding = held

			try {
				return work()
			} finally {
				holding = outer
			}
		},
		release: (stands) => {
			for (let diagnostic of held.splice(0)) {
				if (stands) {
					report(diagnostic)
				}
			}
		},
	}
}

// Runs `work`, a probe that only asks whether a call fits. What its literals
// reported is dropped, since the call reads them again once it chooses.
export function discardingLiteralReports<T>(work: () => T): T {
	return holdLiteralReports().during(work)
}

// Probes a call's candidates. Once one is selected, only what a literal reported
// against it stands. Where none is, a literal reports what every resolution of
// it did.
export function probingCandidates<T extends { index: number }>(
	probe: () => T | undefined,
	candidates: Array<common.BaseFunction>,
	matchableArguments: Array<MatchableArgument>,
): T | undefined {
	let held: HeldReports = {
		candidate: -1,
		several:
			candidates.filter((candidate) =>
				pairsLabels(candidate.parameterTypes, matchableArguments),
			).length > 1,
		answers: new Map(),
		fitting: [],
		byLiteral: new Map(),
	}
	let into = holding
	let selected: T | undefined

	// A call inside an Argument reports as usual.
	holding = null
	heldReports.push(held)

	try {
		selected = probe()
	} finally {
		heldReports.pop()
		holding = into
	}

	for (let batches of held.byLiteral.values()) {
		for (let diagnostic of standingReports(batches, selected?.index)) {
			if (into === null) {
				report(diagnostic)
			} else {
				into.push(diagnostic)
			}
		}
	}

	return selected
}

// The candidate selected over an Argument holding an Error. Where several take
// the call's labels, the hole may be what chose it. The call then answers the
// hole. See "Choosing an Overload" in DEVELOPMENT.md.
export function holeDecided<
	Selected extends { inferred: { returnType: common.Type } },
>(match: { selected: Selected; sawErrorArgument: boolean }): Selected {
	if (!match.sawErrorArgument || heldReports.at(-1)?.several !== true) {
		return match.selected
	}

	return {
		...match.selected,
		inferred: { ...match.selected.inferred, returnType: { type: "Error" } },
	}
}

// Whether a candidate pairs every Argument with a Parameter of its label.
function pairsLabels(
	parameters: common.BaseFunction["parameterTypes"],
	matchableArguments: Array<MatchableArgument>,
): boolean {
	let pairing = pairArguments(parameters, matchableArguments)

	return (
		pairing !== null &&
		pairing.forParameter.every(
			(index, at) =>
				index === null ||
				matchableArguments[index].name === parameters[at].name,
		)
	)
}

// The literal a candidate is reading as one of the call's Arguments. Only its
// reports are held: a literal inside another Argument is read once, against
// whichever candidate came first, so its report stands.
let probedLiteral: parser.FunctionDefinitionNode | null = null

export function readingArgumentLiteral<T>(
	node: parser.FunctionDefinitionNode,
	work: () => T,
): T {
	let outer = probedLiteral

	probedLiteral = node

	try {
		return work()
	} finally {
		probedLiteral = outer
	}
}

// Marks the candidate a probe reads the call's literals against.
export function probingCandidate<T>(index: number, work: () => T): T {
	let held = heldReports.at(-1)

	if (held !== undefined && held !== null) {
		held.candidate = index
	}

	return work()
}

// What a literal's resolutions reported that stands: those against the selected
// candidate, if any read it. Otherwise each place every resolution reported.
function standingReports(
	batches: Array<{
		candidate: number
		diagnostics: Array<common.Diagnostic>
	}>,
	selected: number | undefined,
): Array<common.Diagnostic> {
	let own = batches.filter((batch) => batch.candidate === selected)

	if (own.length > 0) {
		return own.flatMap((batch) => batch.diagnostics)
	}

	// The fewest reports came from the candidate whose Function takes the most
	// Parameters, which says what the closest one takes.
	let [fewest = [], ...others] = batches
		.map((batch) => batch.diagnostics)
		.sort((left, right) => left.length - right.length)

	return fewest.filter((diagnostic) =>
		others.every((batch) => batch.some(atPlaceOf(diagnostic))),
	)
}

function atPlaceOf(
	diagnostic: common.Diagnostic,
): (other: common.Diagnostic) => boolean {
	return (other) =>
		other.position?.start.line === diagnostic.position?.start.line &&
		other.position?.start.column === diagnostic.position?.start.column
}

// An unannotated Parameter takes its Type and label from the expected signature
// by position, so the Parser records no external name for it. Annotated and
// unannotated Parameters may mix.
export function resolveContextualParameterTypes(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
	expectedFunction: common.FunctionType | null,
): Array<common.Parameter> {
	reportDocumentationParameters(node.documentation, [node.parameters])

	let held = probedLiteral === node ? (heldReports.at(-1) ?? null) : null
	let batch: Array<common.Diagnostic> = []
	let parameters = node.parameters.map(
		(parameter, index): common.Parameter => {
			let documentation = parameterDocumentation(
				parameter,
				node.documentation,
				index,
			)

			if (parameter.type !== null) {
				return {
					name: parameter.externalName?.content ?? null,
					type: resolveDeclaredType(parameter.type, scope),
					documentation,
				}
			}

			let expectedParameter = expectedFunction?.parameterTypes[index]

			if (expectedParameter === undefined) {
				// Silent inside a refused call where no Function stands at the
				// literal's place; see `callRefused`.
				if (expectedFunction === null && insideRefusedCall()) {
					return {
						name: null,
						type: { type: "Error" },
						documentation,
					}
				}

				let reportHere = () =>
					reportUninferableParameter(
						node,
						parameter,
						index,
						expectedFunction,
					)

				if (held === null) {
					reportHere()
				} else {
					batch.push(...collectDiagnostics(reportHere).diagnostics)
				}

				return { name: null, type: { type: "Error" }, documentation }
			}

			return {
				name: expectedParameter.name,
				type: expectedParameter.type,
				documentation,
			}
		},
	)

	held?.byLiteral.set(node, [
		...(held.byLiteral.get(node) ?? []),
		{ candidate: held.candidate, diagnostics: batch },
	])

	return parameters
}

function reportUninferableParameter(
	node: parser.FunctionDefinitionNode,
	parameter: parser.ParameterNode,
	index: number,
	expectedFunction: common.FunctionType | null,
): void {
	reportError(
		`The Type of Parameter '${parameterLabel(parameter)}' could not be inferred`,
		parameter.position,
		{
			code: "uninferable-parameter-type",
			labels: [primary(parameter.position, "this Parameter has no Type")],
			notes: [
				expectedFunction === null
					? "Only a Function passed as an Argument takes its Types from the surrounding context."
					: `The expected Function Type takes ${countOf(expectedFunction.parameterTypes.length, "Parameter")}, so there is nothing for Parameter ${index + 1} to infer from.`,
			],
			// A literal typed by nothing around it also lacks its return Type,
			// which is asked only once every Parameter has one. Both are named
			// here to save a round trip.
			helps: [
				node.returnType === null && expectedFunction === null
					? "Write the Parameter's Type and the Function's return Type — a literal outside Argument position takes neither from around it."
					: "Write the Parameter's Type explicitly.",
			],
		},
	)
}

function parameterLabel(parameter: parser.ParameterNode): string {
	return (
		parameterInternalName(parameter)?.content ??
		parameter.externalName?.content ??
		"_"
	)
}

// The one signature a refused call could have meant. Its Function literals read
// the Parameter at their place, so a mistake inside one is still reported.
export function readLiteralsByPlace(
	signatures: Array<common.BaseFunction>,
	matchableArguments: Array<MatchableArgument>,
): void {
	if (signatures.length !== 1) {
		return
	}

	let { parameterTypes, context } = createFreshenedInference(signatures[0])

	underRefusedCall(true, () =>
		matchArguments(...pairedByPlace(parameterTypes, matchableArguments), {
			collectAllMismatches: true,
			inference: context,
		}),
	)
}

// A literal's `missing-return-type` Help per Scope it stands in, since what
// its body answers depends on the reading around it. Each reading of an
// enclosing literal makes a new Scope, and every reading of this one reports.
const returnTypeHelps = new WeakMap<
	parser.FunctionDefinitionNode,
	WeakMap<enricher.Scope, string>
>()

export function returnTypeHelpIn(
	node: parser.FunctionDefinitionNode,
	place: enricher.Scope,
	spell: () => string,
): string {
	let helps =
		returnTypeHelps.get(node) ?? new WeakMap<enricher.Scope, string>()
	let help = helps.get(place) ?? spell()

	returnTypeHelps.set(node, helps.set(place, help))

	return help
}

// What a literal's body answers under the Parameter Types one candidate gives
// it, beside the answer that candidate declares.
type LiteralAnswer = {
	answer: common.Type
	declared: common.Type
	// The Argument's Function Type, whose labels a Help spells a call with.
	type: common.FunctionType
}

// A literal's body read silently under one candidate's Parameter Types.
type BodyReading = {
	node: parser.FunctionDefinitionNode
	parameterTypes: Array<common.Type>
	refused: boolean
	answer: common.Type | null
}

// A literal's readings, kept per Program, per literal and per the Types of the
// bindings around its call that its body reads. The spelling of those Types
// keys a bucket, which is searched for the Types themselves. See "Literals a
// candidate does not fit" in DEVELOPMENT.md.
type Shared = {
	context: Array<[string, common.Type]>
	readings: Array<BodyReading>
}

const sharedByContext = new WeakMap<
	enricher.Scope,
	WeakMap<parser.FunctionDefinitionNode, Map<string, Array<Shared>>>
>()

// The readings a literal shares with every call reading it again where the
// bindings its body reads hold the same Types. A hoist may still miss a name,
// so it shares nothing.
function sharedReadings(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): Array<BodyReading> | null {
	let locals = new Map<string, common.Type>()
	let top = scope

	while (top.programTop !== true && top.parent !== null) {
		for (let [name, type] of Object.entries(top.members)) {
			if (!locals.has(name)) {
				locals.set(name, type)
			}
		}

		top = top.parent
	}

	if (insideHoist() || top.programTop !== true) {
		return null
	}

	let context = namesRead(node, new Set(locals.keys())).map(
		(name): [string, common.Type] => [name, locals.get(name)!],
	)
	let key = context
		.map(([name, type]) => `${name}: ${spellingOf(type)}`)
		.join(", ")
	let byNode =
		sharedByContext.get(top) ??
		new WeakMap<parser.FunctionDefinitionNode, Map<string, Array<Shared>>>()
	let byKey = byNode.get(node) ?? new Map<string, Array<Shared>>()
	let bucket = byKey.get(key) ?? []
	let shared = bucket.find((entry) =>
		isDeepStrictEqual(entry.context, context),
	)

	if (shared === undefined) {
		shared = { context, readings: [] }
		bucket.push(shared)
	}

	sharedByContext.set(top, byNode.set(node, byKey.set(key, bucket)))

	return shared.readings
}

// A Type's spelling, kept per Type object, since each lookup asks again.
const spellings = new WeakMap<common.Type, string>()

function spellingOf(type: common.Type): string {
	let spelling = spellings.get(type) ?? describeType(type)

	spellings.set(type, spelling)

	return spelling
}

// The names among `locals` a literal's body reads, sorted. Asked once per
// literal and set of names, since the walk reads the body.
const namesReadMemo = new WeakMap<
	parser.FunctionDefinitionNode,
	Map<string, Array<string>>
>()

function namesRead(
	node: parser.FunctionDefinitionNode,
	locals: ReadonlySet<string>,
): Array<string> {
	let byNames = namesReadMemo.get(node) ?? new Map<string, Array<string>>()
	let key = [...locals].sort().join(",")
	let known = byNames.get(key)

	if (known !== undefined) {
		return known
	}

	let read: Array<string> = []
	let left = new Set(locals)

	for (
		let found = firstRead(node, left);
		found !== undefined;
		found = firstRead(node, left)
	) {
		read.push(found.content)
		left.delete(found.content)
	}

	if (locals.has("@") && readsSelf(node) !== undefined) {
		read.push("@")
	}

	read.sort()
	namesReadMemo.set(node, byNames.set(key, read))

	return read
}

function readsSelf(node: ParserNode): true | undefined {
	return node.nodeType === "Self" ? true : findParserChild(node, readsSelf)
}

// A literal read under one of several candidates reads as an Error Argument
// there where its body has errors of its own. So it does where its answer
// does not fit the candidate's. See "Literals a candidate does not fit" in
// DEVELOPMENT.md.
export function typerReadingLiteralBodies(
	scope: enricher.Scope,
	typer: ArgumentTyper,
): ArgumentTyper {
	// One reading per literal and Parameter Types, whichever candidate asks.
	let readings: Array<BodyReading> = []

	let readingOf = (
		node: parser.FunctionDefinitionNode,
		parameters: Array<common.Parameter>,
	): BodyReading => {
		let parameterTypes = parameters.map((parameter) => parameter.type)
		let shared = sharedReadings(node, scope)
		let found = [...readings, ...(shared ?? [])].find(
			(reading) =>
				reading.node === node &&
				isDeepStrictEqual(reading.parameterTypes, parameterTypes),
		)

		if (found !== undefined) {
			return found
		}

		let refused = { body: false }
		let answer = inferReturnTypeFromBody(
			node,
			parameters,
			scopeWithGenerics(node.generics, scope),
			refused,
		)
		let reading = { node, parameterTypes, refused: refused.body, answer }

		readings.push(reading)
		shared?.push(reading)

		return reading
	}

	return {
		...typer,
		getType(value, expectedType, bindings, declaredType) {
			let type = typer.getType(
				value,
				expectedType,
				bindings,
				declaredType,
			)
			let held = heldReports.at(-1)
			let read = decidedReading(type, expectedType, bindings)

			if (held?.several !== true || read === null) {
				return type
			}

			// An entry whose answer takes what one that fits answers can not
			// be the narrowest, so its body is not read.
			if (dominated(held, value, read.declared)) {
				typer.noteErrorArgument()

				return type
			}

			let literal =
				value.nodeType === "FunctionValue" ? value.value : null
			let reading =
				literal !== null && needsContext(literal)
					? readingOf(literal, read.parameters)
					: null
			// A written `-> Type`, or the Type of a named Function, is the
			// answer as it stands.
			let answer =
				literal?.returnType === null
					? (reading?.answer ?? null)
					: read.answer

			if (
				reading?.refused === true ||
				(answer !== null && !admits(read.declared, answer))
			) {
				typer.noteErrorArgument()
			} else if (answer !== null) {
				let answers = held.answers.get(held.candidate) ?? new Map()

				held.answers.set(
					held.candidate,
					answers.set(value, {
						answer,
						declared: read.declared,
						type: read.type,
					}),
				)
			}

			return type
		},
	}
}

// Whether a candidate fitting already answers only this Argument, with an
// answer the asking candidate's declared answer takes. The asking one then
// can not be the narrowest, and takes whichever is.
function dominated(
	held: HeldReports,
	argument: parser.ExpressionNode,
	declared: common.Type,
): boolean {
	return held.fitting.some((candidate) => {
		let answers = held.answers.get(candidate)
		let theirs = answers?.get(argument)

		return (
			answers?.size === 1 &&
			theirs !== undefined &&
			admits(declared, theirs.declared)
		)
	})
}

// What a candidate makes of a Function-typed Argument, where it is decided:
// the Parameter Types it gives, the Argument's answer and the candidate's. A
// return Type still open was read off the body while matching, and open
// Parameter Types decide nothing yet.
function decidedReading(
	type: common.Type,
	expectedType: common.Type,
	bindings: GenericBindings | null | undefined,
): {
	type: common.FunctionType
	parameters: Array<common.Parameter>
	answer: common.Type
	declared: common.Type
} | null {
	if (type.type !== "Function" || expectedType.type !== "Function") {
		return null
	}

	let decided = (open: common.Type): common.Type =>
		bindings == null ? open : applyGenericBindings(open, bindings)
	let parameters = type.parameterTypes.map((parameter) => ({
		...parameter,
		type: decided(parameter.type),
	}))
	let declared = decided(expectedType.returnType)

	if (
		mentionsUnsolvedTypeParameter(declared) ||
		parameters.some((parameter) =>
			mentionsUnsolvedTypeParameter(parameter.type),
		)
	) {
		return null
	}

	return { type, parameters, answer: decided(type.returnType), declared }
}

// Whether a declared answer takes what a body answers. A refinement is judged
// by its base, since the validator proves a written answer against it.
function admits(declared: common.Type, answer: common.Type): boolean {
	return (
		typeContainsError(answer) ||
		matchesType(declared, answer) ||
		(typeContainsRefinement(declared) &&
			matchesType(eraseRefinements(declared), answer))
	)
}

// Whether a candidate's literals were measured by their answers, which then
// choose among the candidates that fit.
export function answeredBy(candidate: number): boolean {
	return heldReports.at(-1)?.answers.has(candidate) === true
}

// Notes a candidate that fits, so a later one its answer dominates is not read.
export function noteFitting(candidate: number): void {
	heldReports.at(-1)?.fitting.push(candidate)
}

// The candidate whose declared answers every other fitting one takes, whatever
// order they are written in. Where none does, the call is refused, and the
// first stands for it. See "Literals a candidate does not fit" in
// DEVELOPMENT.md.
export function chooseByAnswers(fitting: Array<number>): {
	candidate: number
	// The refusal, which the caller reports only where it commits the call.
	refusal: Array<common.Diagnostic> | null
} {
	let held = heldReports.at(-1)
	let answered = fitting.filter((candidate) => held?.answers.has(candidate))

	if (held === null || held === undefined || answered.length < 2) {
		return { candidate: fitting[0]!, refusal: null }
	}

	let answersOf = (candidate: number) => held.answers.get(candidate)!
	let takes = (wider: number, narrower: number): boolean =>
		[...answersOf(narrower)].every(([literal, mine]) => {
			let theirs = answersOf(wider).get(literal)

			return (
				theirs === undefined || admits(theirs.declared, mine.declared)
			)
		})
	let minimum = answered.find((candidate) =>
		answered.every((other) => takes(other, candidate)),
	)

	if (minimum !== undefined) {
		return { candidate: minimum, refusal: null }
	}

	let { diagnostics } = collectDiagnostics(() =>
		reportAmbiguousAnswers(answered.map(answersOf)),
	)

	return { candidate: fitting[0]!, refusal: diagnostics }
}

// Reports the first literal whose answer the fitting candidates disagree on,
// with a Help writing each one's declared answer as its `-> Type`.
function reportAmbiguousAnswers(
	answers: Array<Map<parser.ExpressionNode, LiteralAnswer>>,
): void {
	let [first] = answers
	let argument = [...(first?.keys() ?? [])].find(
		(node) =>
			new Set(
				answers.map((each) =>
					describeType(each.get(node)?.declared ?? { type: "Error" }),
				),
			).size > 1,
	)
	let mine = argument === undefined ? undefined : first?.get(argument)

	if (argument === undefined || mine === undefined) {
		return
	}

	let position =
		argument.nodeType === "FunctionValue"
			? argument.value.parameterListPosition
			: argument.position
	let spellings = [
		...new Set(
			answers.flatMap((each) => {
				let declared = each.get(argument)?.declared

				return declared === undefined ? [] : [describeType(declared)]
			}),
		),
	].filter(
		(spelling) => !spelling.includes("…") && !spelling.includes("Unknown"),
	)
	let quoted = spellings.map((spelling) => `'${spelling}'`)
	let listed =
		quoted.length < 2
			? "more than one entry takes"
			: `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)} ${quoted.length === 2 ? "both" : "all"} take`

	reportError(
		"More than one Overload takes what this Function answers",
		position,
		{
			code: "ambiguous-overload-answer",
			labels: [
				primary(
					position,
					`this answers ${withArticle(describeType(mine.answer))}, which ${listed}`,
				),
			],
			notes: [
				"An Overload is selected by the Types its Arguments write, and a Function by what it answers. The entry whose answer every other one takes is selected, and none does here.",
			],
			helps: answerHelps(argument, mine.type, spellings),
		},
	)
}

// A Help per answer that writes it: after a literal's Parameter list, or as a
// literal calling a named Function in its place.
function answerHelps(
	argument: parser.ExpressionNode,
	type: common.FunctionType,
	spellings: Array<string>,
): Array<string> {
	let lead = (index: number) => (index === 0 ? "Write" : "Or write")

	if (argument.nodeType === "FunctionValue") {
		return spellings.map(
			(spelling, index) =>
				`${lead(index)} the return Type after the Parameter list — '-> ${spelling}', for the entry that answers it.`,
		)
	}

	let callee = spelledName(argument)

	if (callee === null) {
		return [
			"Pass a Function literal that writes the answer Type of the entry you mean in its place.",
		]
	}

	// Named apart from the name the literal calls, so none shadows it.
	let root = callee.split(".")[0]
	let names: Array<string> = []

	for (let next = 1; names.length < type.parameterTypes.length; next += 1) {
		if (`p${next}` !== root) {
			names.push(`p${next}`)
		}
	}

	let passed = type.parameterTypes.map((parameter, index) =>
		parameter.name === null || parameter.name === "_"
			? names[index]
			: `${parameter.name} ${names[index]}`,
	)

	return spellings.map(
		(spelling, index) =>
			`${lead(index)} a Function literal in its place — '(${names.join(", ")}) -> ${spelling} { <- ${callee}(${passed.join(", ")}) }', for the entry that answers it.`,
	)
}

// A name or a chain of member reads over one, as written.
function spelledName(node: parser.ExpressionNode): string | null {
	if (node.nodeType === "Identifier") {
		return node.content
	}

	if (node.nodeType === "Lookup") {
		let base = spelledName(node.base)

		return base === null ? null : `${base}.${node.member.content}`
	}

	return null
}
