import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	containsErrors,
	primary,
	report,
	reportError,
	reportWarning,
	secondary,
} from "../diagnostics/index"
import { eraseRefinements } from "../helpers/eraseRefinements"
import {
	applyGenericBindings,
	buildUnion,
	canonicalPredicateConjuncts,
	choiceIdentity,
	closestMatch,
	countOf,
	createFreshenedChoiceInference,
	createFreshenedInference,
	describeSignature,
	describeType,
	displayChoiceName,
	filterMostSpecificByTarget,
	flattenUnionMembers,
	type GenericBindings,
	type MatchableArgument,
	matchArguments,
	matchesType,
	matchesTypeWithBindings,
	mentionsUnsolvedTypeParameter,
	mergeUnionMembers,
	parameterInternalName,
	type PatternBinding,
	type PatternStep,
	patternBindings,
	predicateConjunctKey,
	provenConjuncts,
	refutablePatternMembers,
	refinementWithTypeArguments,
	resolveOverloadedMethodName,
	resolveUnknownSlots,
	typeContainsError,
	typeContainsRefinement,
	typeContainsUnknown,
	typeMentionsGeneric,
	unfreshenBindings,
	unionMembersKeepingNames,
	withArticle,
} from "../helpers/index"
import {
	admittedByEvaluation,
	refinementDecidedBy,
} from "../helpers/predicateEval"
import {
	checkProtocolConformance,
	type CheckedConformance,
	reportReservedTypeName,
	findTypeInScope,
	combinationTypeOf,
	derivedEquatableDescriptorFor,
	derivedEquatableNamespace,
	derivedEquatableNamespaceName,
	invalidateNamespacesInScope,
	namespacesTargeting,
	specializedNamespacesFor,
	listItemTypeOf,
	lookupTypeOf,
	recordValueTypeOf,
	parameterDocumentation,
	reportUnknownDocumentationParameters,
	resolveAliasedType,
	resolveChoiceDeclarationStatementType,
	resolveConformances,
	resolveDeclaredType,
	resolveFunctionSignatureType,
	resolveGenericDeclarations,
	resolveIdentifierType,
	applyTypeArguments,
	resolveMethodLookupNamespacesForReceiverType,
	resolveMethodType,
	resolveOverloadedFunctionStatementType,
	resolveProtocolDeclarationStatementType,
	resolveSelfType,
	resolveType,
	scopeWithGenerics,
	silentCheckedConformances,
	solveConformance,
	suggestionData,
	suggestionHelps,
	suggestionInScope,
} from "./resolvers"
import {
	childScope,
	modulePathOf,
	scopeMap,
	unimportedNamespacesOf,
} from "./scope"

// NOTE: Hoisting resolves each order-independent declaration's Type up front
// (see `hoistDeclarations`) and hands it back keyed by its Node. The in-order
// enrichment reuses that Type rather than resolving the same declaration a
// second time. A Node absent from the Map was not hoisted — it resolves in
// place, reporting its own Diagnostics.
export type HoistedTypes = Map<
	parser.ImplementationNode,
	common.Type | common.ProtocolType
>

// NOTE: A declaration's HEAD — from where it starts to the end of the last
// thing it says about ITSELF, stopping before whatever body follows. The
// Language Server anchors a declaration's Hover here instead of on its whole
// Position, so that the cursor on a blank line inside a forty-line Namespace is
// answered by nothing rather than by the Namespace. `parts` is every piece the
// head may end on, in any order; the one reaching furthest wins, and absent
// ones are skipped — an unannotated Constant ends on its name, an annotated one
// on its annotation.
export function headPositionOf(
	position: common.Position,
	parts: Array<common.Position | null | undefined>,
): common.Position {
	let end = position.start

	for (let part of parts) {
		if (part == null) {
			continue
		}

		if (
			part.end.line > end.line ||
			(part.end.line === end.line && part.end.column > end.column)
		) {
			end = part.end
		}
	}

	return { start: position.start, end }
}

// NOTE: A signature's own span — `<infer Item>(a: Integer) -> String` — which
// NO parser Node covers: a FunctionValue starts at its `(`, leaving a leading
// Type Parameter list outside it, and a FunctionDefinition carries no Position
// at all. Hover needs it to anchor a Method or a Function literal to what it
// declares rather than to what it contains.
export function signatureHeadPositionOf(
	definition: parser.FunctionDefinitionNode,
): common.Position {
	let start = (
		definition.generics[0]?.position ?? definition.parameterListPosition
	).start

	return headPositionOf({ start, end: start }, [
		definition.parameterListPosition,
		definition.returnType?.position,
	])
}

// NOTE: One parsed Node becomes a LIST of typed ones, because one of them can:
// a Declaration whose name is a Pattern is the Constants an author could have
// written instead — the base the members are read off, and one per name the
// Pattern binds. Everything else answers with a list of one.
//
// An Array rather than a Node so that TypeScript names every body walk: a walk
// that mapped where it should flatMap would drop a Pattern's bindings on the
// floor, and nothing downstream would be any the wiser.
export function enrichNode(
	node: parser.ImplementationNode,
	scope: enricher.Scope,
	hoistedTypes?: HoistedTypes,
): Array<common.typed.ImplementationNode> {
	switch (node.nodeType) {
		case "MethodInvocation":
		case "FunctionInvocation":
		case "Combination":
		case "RecordValue":
		case "StringValue":
		case "InterpolatedStringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
		case "FunctionValue":
		case "ListValue":
		case "Lookup":
		case "Identifier":
		case "Self":
		case "Match":
		case "CaseValue":
			return [enrichExpression(node, scope)]
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			return enrichDeclarationStatement(node, scope)
		case "VariableAssignmentStatement":
		case "NamespaceDefinitionStatement":
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "IfElseStatement":
		case "IfStatement":
		case "ReturnStatement":
		case "FunctionStatement":
		case "OverloadedFunctionStatement":
			return [enrichStatement(node, scope, hoistedTypes)]
	}
}

// #region Expressions

// NOTE: `expectedType` is what the surrounding position wants the Expression
// to be — a Declaration's annotation, an Assignment's target, the declared
// return Type at a `<-`. Only bare Case Expressions consume it (they resolve
// against it before scanning the scope); everything else infers bottom-up.
// NOTE: Every Expression that stands where a VALUE is read. A Function or Method
// taken as a value keeps its whole signature and loses its defaults: a default
// is filled in by the callee's own frame, and only a DIRECT call reaches that
// frame — `constant cut = List.slice` binds the native itself, and `constant
// twice = double` binds an emitted Function whose arity is fixed by the
// callbacks it may be handed to. So the Type has to say what the emission does,
// and it says every Parameter is written.
//
// The callee of an Invocation is deliberately not read through here — see
// `enrichCalleeExpression`.
export function enrichExpression(
	node: parser.ExpressionNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.typed.ExpressionNode {
	return asValue(enrichCalleeExpression(node, scope, expectedType))
}

// NOTE: The same Expression read where it is CALLED rather than stored, which
// is the one position a default still applies in. `Terminal.print("…")` is a
// Lookup in exactly the shape `constant print = Terminal.print` is, and the
// difference between them is which of these two the Invocation asked for.
export function enrichCalleeExpression(
	node: parser.ExpressionNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.typed.ExpressionNode {
	switch (node.nodeType) {
		case "MethodInvocation":
			return enrichMethodInvocation(node, scope)
		case "FunctionInvocation":
			return enrichFunctionInvocation(node, scope)
		case "Combination":
			return enrichCombination(node, scope)
		case "RecordValue":
			return enrichRecordValue(node, scope, expectedType)
		case "StringValue":
			return enrichStringValue(node, scope)
		case "InterpolatedStringValue":
			return enrichInterpolatedStringValue(node, scope)
		case "IntegerValue":
			return enrichIntegerValue(node, scope)
		case "RationalValue":
			return enrichRationalValue(node, scope)
		case "BooleanValue":
			return enrichBooleanValue(node, scope)
		case "FunctionValue":
			return enrichFunctionValue(node, scope)
		case "ListValue":
			return enrichListValue(node, scope, expectedType)
		case "Lookup":
			return enrichLookup(node, scope)
		case "Identifier":
			return enrichIdentifierExpression(node, scope)
		case "Self":
			return enrichSelf(node, scope)
		case "Match":
			return enrichMatch(node, scope)
		case "CaseValue":
			return enrichCaseValue(node, scope, expectedType)
	}
}

// NOTE: The Type a signature has once it is a value — the same Parameters, none
// of them omittable. Only a NAME can stand for a Function or a Method, so only
// the two Expressions that are one are asked: everything else answers with a
// Type some Declaration wrote down, and a Function Type written down carries no
// default in the first place.
//
// Answers with the Node it was GIVEN wherever there is nothing to drop, which is
// every Expression in a Program that declares no default.
function asValue(
	node: common.typed.ExpressionNode,
): common.typed.ExpressionNode {
	if (node.nodeType === "Identifier") {
		let type = withoutParameterDefaults(node.type)

		return type === node.type ? node : { ...node, type }
	}

	if (node.nodeType === "Lookup") {
		let type = withoutParameterDefaults(node.type)

		// NOTE: The Lookup and its member Identifier share one Type — see
		// `enrichLookup` — so they go on sharing it here.
		return type === node.type
			? node
			: { ...node, type, member: { ...node.member, type } }
	}

	return node
}

function withoutParameterDefaults(type: common.Type): common.Type {
	switch (type.type) {
		case "Function":
		case "SimpleMethod":
		case "StaticMethod": {
			let parameterTypes = requiredParameters(type.parameterTypes)

			return parameterTypes === type.parameterTypes
				? type
				: { ...type, parameterTypes }
		}
		case "OverloadedMethod":
		case "OverloadedStaticMethod": {
			let overloads = type.overloads.map((overload) => {
				let parameterTypes = requiredParameters(overload.parameterTypes)

				return parameterTypes === overload.parameterTypes
					? overload
					: { ...overload, parameterTypes }
			})

			return overloads.every(
				(overload, index) => overload === type.overloads[index],
			)
				? type
				: { ...type, overloads }
		}
		default:
			return type
	}
}

function requiredParameters(
	parameters: Array<common.Parameter>,
): Array<common.Parameter> {
	if (!parameters.some((parameter) => parameter.hasDefault)) {
		return parameters
	}

	// oxlint-disable-next-line eslint/no-unused-vars -- the key being dropped
	return parameters.map(({ hasDefault, ...parameter }) => parameter)
}

export function enrichCaseValue(
	node: parser.CaseValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.typed.CaseValueNode {
	// NOTE: An Argument carries no expected Type of its own — the Invocation
	// matched it against each candidate's Parameter Type and committed the
	// winner's, which is what this reads back. Everywhere else the surrounding
	// position hands one down directly.
	let context = expectedType ?? recordedContextualCaseValueType(node) ?? null

	// NOTE: The Case is resolved BEFORE its payload is enriched, so that what the
	// position decided is what the payload stands in: the members of a
	// `Box<Box<Integer>>#Full` are the position an inner `Box#Full(1)` reads its
	// own Type Arguments off, and without them a nesting whose outer Type is
	// spelled out in full had nothing to read at all.
	//
	// A position offering SEVERAL instantiations of the one Case — `Box<Integer>
	// | Box<String>` — is the one place that order can not hold: which of them is
	// meant is what the payload says. There the payload is read once per
	// candidate, silently and under that candidate's own members, and the reading
	// the winner was chosen BY is the one committed afterwards. It still never
	// DECIDES a Type Argument; it only chooses among the ones the context already
	// decided.
	let payload = makePayloadReadings(node, scope)
	let type = resolveCaseValueType(node, scope, context, payload.typeUnder)

	if (context !== null) {
		reportUncarriedTypeArgumentDisagreement(
			node,
			type,
			context,
			expectedType === null,
		)
	}

	let value = payload.commit(type)

	if (type.type === "Case") {
		// NOTE: The one-member shorthand rewraps first, so the instantiation
		// below binds the Choice's Generics from the Record the rest of the
		// pipeline sees — `#Done(5)` and `#Done({ value = 5 })` reach it
		// identically.
		if (value !== null) {
			value = wrapSingleMemberShorthand(type, value)
		}

		// NOTE: Held on to before the instantiation drops them — what the
		// refusal below names, since an instantiated Case keeps only the
		// Arguments it was given. Set means the payload rail: every other way in
		// here handed back a Case some position had already decided.
		let choiceGenerics = type.choiceGenerics

		type = instantiateCaseFromPayload(type, value, scope, node.position)

		if (choiceGenerics !== undefined && payloadStandsForCase(type, value)) {
			type = reportUndecidedPayloadTypeArguments(
				node,
				type,
				choiceGenerics,
			)
		}
	}

	return {
		nodeType: "CaseValue",
		// NOTE: The Choice's name is a Type name, not a value — it is typed by
		// Type-scope lookup, so hovering it describes the Choice's Union.
		choice:
			node.choice === null
				? null
				: {
						nodeType: "Identifier",
						content: node.choice.content,
						position: node.choice.position,
						type: findTypeInScope(node.choice.content, scope) ?? {
							type: "Error",
						},
					},
		caseName: {
			nodeType: "Identifier",
			content: node.caseName.content,
			position: node.caseName.position,
			type,
		},
		value,
		position: node.position,
		type,
	}
}

// NOTE: The Type Arguments written at a construction win over the position, and
// the two disagreeing is the ordinary mismatch of a value that does not fit
// where it is put — `Holder<Integer>#Full(1)` under a `Holder<String>`
// annotation is the assignment's to report, exactly as for any other value. It
// can only report what the Types SHOW it, though, and a Case whose members
// mention none of the Choice's Type Parameters is the same Record under every
// instantiation: `matchesType` reads `Box<String>#Tag` and `Box<Integer>#Tag` as
// the one Type, deliberately, because Type Arguments are display spelling there
// and a Case joined across instantiations keeps none at all to compare.
//
// So the two spellings of the identical program disagreed: `Box<String>#Tag("x")`
// bound to a `Box<Integer>` Constant was accepted, while the payload-carrying
// `Box<String>#Full("x")` beside it was not. This is what closes that — the
// written Arguments are compared against the position's directly, and only where
// nothing downstream can see the disagreement, under the code the rail it stands
// in would have used.
//
// Agreement is assignability rather than sameness, for the same reason the
// members are: `Box<Integer>#Empty` stands under a `Box<Integer | String>` just
// as its payload-carrying twin does.
function reportUncarriedTypeArgumentDisagreement(
	node: parser.CaseValueNode,
	written: common.CaseType | common.ErrorType,
	expectedType: common.Type,
	inArgumentPosition: boolean,
): void {
	if (node.typeArguments === null || written.type !== "Case") {
		return
	}

	let writtenArguments = written.typeArguments

	if (writtenArguments === undefined) {
		return
	}

	// NOTE: An instantiation the position offers that keeps no Type Arguments of
	// its own is one joined across several, which agrees with nothing and
	// disagrees with nothing — there is no spelling left in it to compare.
	//
	// NOTE: Nor does one the call this stands in never decided. An Argument's
	// position is a Parameter Type, and a Parameter Type still carrying a Type
	// Parameter the call left unsolved is exactly what 80899b7 refuses to treat as
	// a decision — disagreeing with it here would refuse `id(Box<Integer>#Empty,
	// 1)`, whose `T` the Argument beside it decides, and the help would name a `T`
	// that exists in no scope the caller can see. Everything the call DID decide
	// was substituted in on the way here, so what is left standing is the
	// undecided state the call reports for itself.
	let offered = unionArmsOf(expectedType).flatMap((member) =>
		member.type === "Case" &&
		member.name === written.name &&
		member.choice === written.choice &&
		member.typeArguments !== undefined &&
		!mentionsUnsolvedTypeParameter(member)
			? [
					member as common.CaseType & {
						typeArguments: Array<common.Type>
					},
				]
			: [],
	)

	if (offered.length === 0) {
		return
	}

	let agrees = offered.some(
		(candidate) =>
			candidate.typeArguments.length === writtenArguments.length &&
			candidate.typeArguments.every((argument, index) =>
				matchesType(argument, writtenArguments[index]),
			),
	)

	if (agrees) {
		return
	}

	// NOTE: Where the value's own Type carries the disagreement, the position it
	// is put in is what reports — one Diagnostic, at the site that knows what it
	// wanted and what it got.
	if (offered.some((candidate) => matchesType(candidate, written))) {
		let spell = (typeArguments: Array<common.Type>) =>
			`${displayChoiceName(written.choice)}<${typeArguments.map(describeType).join(", ")}>`

		reportError(
			"These Type Arguments are not the ones this position decided",
			node.position,
			{
				code: inArgumentPosition
					? "argument-type-mismatch"
					: "assignment-type-mismatch",
				labels: [
					primary(
						node.position,
						`this is ${spell(writtenArguments)}`,
					),
				],
				notes: [
					`The position decided ${offered
						.map((candidate) => spell(candidate.typeArguments))
						.join(" or ")}.`,
				],
				helps: [
					`Write '${spell(offered[0].typeArguments)}#${node.caseName.content}'.`,
					"Or leave the Type Arguments out, and let the position decide them.",
				],
			},
		)
	}
}

// NOTE: What a Case expects of its payload — the Record its members spell out
// or, on a one-member Case, that Record OR the member's own Type, because the
// shorthand hands the member's value directly. Both readings are offered at
// once and the payload settles which of them it is, exactly as
// `wrapSingleMemberShorthand` settles it afterwards, so `Box#Full(Box#Empty)`
// and `Box#Full({ value = Box#Empty })` each reach the inner construction with
// the Type its own position decides.
//
// `null` for a Case that is still the DECLARED one — a bare sigil the scope scan
// resolved, whose members are the Choice's own Type Parameters and decide
// nothing for whatever stands in them — and for anything that is no Case at all.
function expectedPayloadType(caseType: common.Type): common.Type | null {
	if (caseType.type !== "Case" || caseType.choiceGenerics !== undefined) {
		return null
	}

	let recordShape: common.RecordType = {
		type: "Record",
		members: caseType.members,
	}
	let memberNames = Object.keys(caseType.members)

	if (memberNames.length !== 1) {
		return recordShape
	}

	return {
		type: "UnionType",
		types: [recordShape, caseType.members[memberNames[0]]],
	}
}

// NOTE: An Argument that can bind no Type Parameter of the call it stands in: a
// prefixed construction with no Type Arguments of its own reads its Choice's off
// the Parameter it is matched against, and answers with an Error where that
// Parameter has not been decided either. So it is matched after every Argument
// that CAN decide one — the same holding-back a contextually typed Function
// literal gets, for the same reason and one kind of Argument over.
//
// A bare form carrying a payload is not one of these: it asks the position
// first, but falls back on its payload where the position has not been decided,
// and that payload still binds. One carrying none has nothing to decide with
// either and waits alongside the prefixed form. Nor is an applied one — its
// members are concrete, and they bind like any other value's.
function bindsNoTypeParameter(argument: parser.ArgumentNode): boolean {
	return (
		argument.value.nodeType === "CaseValue" &&
		argument.value.typeArguments === null &&
		(argument.value.choice !== null || argument.value.value === null)
	)
}

// NOTE: One reading of a construction's payload per Case it is read under, for
// the span of the one construction being enriched. Arm selection asks what the
// payload comes out as under each instantiation the position offers, and the
// instantiation that WINS is the one the payload finally stands under — so the
// winning reading is the real one, already made, and reading it again re-reads
// the whole subtree beneath it.
//
// Read afresh every time, that re-reading multiplied: a construction nested N
// deep under a position offering two instantiations at each level cost 2^N
// readings of its innermost value, and twelve levels took seven minutes where
// the same nesting under a position offering ONE takes ten milliseconds. Each
// reading is kept under the Case it was read for, which is what lets the commit
// find the winner's: `decideCaseFromExpectedType` hands back the very candidate
// it asked about, so the two are the same key.
//
// The Diagnostics are kept WITH the reading rather than reported where it is
// made. Arm selection has to stay silent — every candidate it asks about would
// otherwise be reported on, including the ones it rejects — and the reading that
// is committed says them then, which is the pass the reader hears from.
type PayloadReading = {
	value: common.typed.ExpressionNode
	diagnostics: Array<common.Diagnostic>
}

type PayloadReadings = {
	typeUnder: PayloadReader
	// NOTE: The reading itself, still unreported — what a probe hands to
	// `instantiateCaseFromPayload` to ask what the payload ALONE makes of the
	// construction, which needs the typed Node and not only its Type. `commit` is
	// the same reading with its Diagnostics said, and there is exactly one pass
	// that may say them.
	valueUnder: (under: common.Type) => common.typed.ExpressionNode | null
	commit: (under: common.Type) => common.typed.ExpressionNode | null
}

function makePayloadReadings(
	node: parser.CaseValueNode,
	scope: enricher.Scope,
): PayloadReadings {
	let readings = new Map<common.Type, PayloadReading>()

	function read(under: common.Type): PayloadReading | null {
		let payload = node.value

		if (payload === null) {
			return null
		}

		let reading = readings.get(under)

		if (reading === undefined) {
			let { result, diagnostics } = collectDiagnostics(() =>
				enrichExpression(payload, scope, expectedPayloadType(under)),
			)

			reading = { value: result, diagnostics }

			readings.set(under, reading)
		}

		return reading
	}

	return {
		typeUnder: (under) => read(under)?.value.type ?? null,
		valueUnder: (under) => read(under)?.value ?? null,
		commit: (under) => {
			let reading = read(under)

			if (reading === null) {
				return null
			}

			for (let diagnostic of reading.diagnostics) {
				report(diagnostic)
			}

			return reading.value
		},
	}
}

// NOTE: `#Case(value)` on a single-member Case may hand the member's value
// directly rather than wrapping it in the one-member Record. When the payload
// does not already fit the Record shape it IS that value, so it is wrapped
// into the synthetic Record the Validator and Simplifier expect — the emitted
// `createCase(tag, { member: value })` is then identical to the explicit form.
// The fit check binds the Choice's own Generics (`wrapSingleMemberShorthand`'s
// caller has not instantiated yet), so a Record that fits once they bind reads
// as the Record: `#Done({ value = 5 })` is left alone and only a bare
// `#Done(5)` is wrapped. Record interpretation always wins the ambiguity, which
// keeps every already-explicit construction backwards compatible.
function wrapSingleMemberShorthand(
	caseType: common.CaseType,
	value: common.typed.ExpressionNode,
): common.typed.ExpressionNode {
	let memberNames = Object.keys(caseType.members)

	if (memberNames.length !== 1) {
		return value
	}

	// NOTE: A generic Case's members are still GenericUses here, so a plain
	// `matchesType` would reject a Record that only fits once they bind. Binding
	// the Choice's Generics in a throwaway context makes the question "does this
	// fit AS the Record", independent of any later instantiation. A non-generic
	// Case has no bindable names, so this is exactly `matchesType` for it.
	//
	// Freshened for the same reason the instantiation below is: a payload Typed
	// as a caller Generic sharing a name with one of the Choice's read as the
	// Record itself — `current.carried`, Typed as `myCount`'s own `State`, bound
	// `Step`'s `State` to `{ value: Result }` and was left unwrapped.
	let { rename, context: fitContext } = createFreshenedChoiceInference(
		caseType.choiceGenerics ?? [],
	)

	let recordShape: common.Type = {
		type: "Record",
		members: caseType.members,
	}

	// NOTE: Substituted only where there IS something to substitute. An
	// instantiated Case reaches here with no Generics left and members that can
	// be arbitrarily large — a nesting twenty deep spells its whole tree out —
	// and walking one of those to rename nothing is exactly the per-level cost
	// `makePayloadReadings` exists to keep off this path.
	if (rename.size > 0) {
		recordShape = applyGenericBindings(recordShape, rename)
	}

	if (matchesTypeWithBindings(recordShape, value.type, fitContext)) {
		return value
	}

	let [memberName] = memberNames

	return {
		nodeType: "RecordValue",
		declaredType: null,
		type: { type: "Record", members: { [memberName]: value.type } },
		members: { [memberName]: value },
		position: value.position,
	}
}

// NOTE: A constructed Case of a generic Choice is instantiated here, off its
// (already shorthand-wrapped) payload — the bare or prefixed form resolved to
// the DECLARED Case, whose members are still GenericUses, so this is what makes
// them concrete. The Choice's Generics bind from the payload Record, then
// `applyGenericBindings` substitutes the members and stamps the applied
// `typeArguments`, dropping `choiceGenerics` exactly as an alias application
// would. A Generic no payload mentions stays a GenericUse — a never-`#Done`
// callback keeps `Result` open, which surfaces as an unbound Generic at the
// invocation rather than here. An already instantiated Case (handed back by the
// contextual path, or a non-generic Choice's Case) carries no `choiceGenerics`
// and is returned untouched.
function instantiateCaseFromPayload(
	caseType: common.CaseType,
	value: common.typed.ExpressionNode | null,
	scope: enricher.Scope,
	position: common.Position,
): common.CaseType {
	let choiceGenerics = caseType.choiceGenerics

	if (choiceGenerics === undefined) {
		return caseType
	}

	// NOTE: Freshened first — see `createFreshenedChoiceInference`. The payload
	// is a caller-side Type and may mention a Generic spelled exactly like one of
	// the Choice's, and Generic identity is by name, so the match has to be run
	// under names no source can carry or the payload binds the Parameter it is
	// itself written in terms of.
	let { rename, freshNames, context } =
		createFreshenedChoiceInference(choiceGenerics)

	let mentionsGenerics = Object.values(caseType.members).some((member) =>
		choiceGenerics.some((generic) =>
			typeMentionsGeneric(member, generic.name),
		),
	)

	if (value !== null && mentionsGenerics) {
		matchesTypeWithBindings(
			applyGenericBindings(
				{ type: "Record", members: caseType.members },
				rename,
			),
			value.type,
			context,
		)
	}

	// NOTE: What the payload bound, under the names the Choice declares — and
	// what it did NOT bind, left standing under its fresh name. That is the Type
	// Argument nothing decided, and carrying it out of here under a name no
	// source Generic can spell is what lets the construction be told from one
	// standing in an enclosing Function's own Type Parameter, which IS a
	// decision. `applyGenericBindings` stamps them onto the instantiated Case in
	// declaration order, so both halves land in `typeArguments` together.
	let bindings: GenericBindings = new Map()

	for (let [index, generic] of choiceGenerics.entries()) {
		bindings.set(
			generic.name,
			context.bindings.get(freshNames[index]) ?? {
				type: "GenericUse",
				name: freshNames[index],
			},
		)
	}

	// NOTE: The construction is the other half of where a bound is kept — an
	// annotation checks what it names, and an unannotated `#Full(f)` names
	// nothing, so the Types the payload bound here are what has to answer for
	// the Choice's bounds. Solved for the Diagnostic alone, as at an Alias
	// application; the witnesses a call needs are solved at the call.
	//
	// NOTE: Only what the payload BOUND is asked, never the whole declaration.
	// A Case whose payload never mentions a Generic — `Bare` of a `Holder<Item
	// is Equatable>` — leaves it undetermined on purpose: nothing here decides
	// what a value carrying no Item is a Holder OF, and the bound surfaces at
	// whatever later site does decide, or at the comparison that finds out
	// nothing ever did. Written as a filter rather than left to
	// `resolveConformances` passing over an absent binding, because that pass is
	// there to stop a cascade behind a Diagnostic something else already
	// reported — this one has nothing behind it, and asking for it would make
	// every `Holder#Bare` an error.
	let boundGenerics = choiceGenerics.filter(
		(_, index) => context.bindings.get(freshNames[index]) !== undefined,
	)

	resolveConformances(boundGenerics, bindings, scope, position)

	return applyGenericBindings(caseType, bindings) as common.CaseType
}

// NOTE: The last word on a bare construction carrying a payload — the one
// spelling whose Type Arguments are not all read off a position, and so the one
// that can still be half decided once everything that decides has run. A payload
// binds the Parameters its own members MENTION and no others: `#Stopped({ value
// = "x" })` on a `Progress<State, Result>` says what the Result is and leaves
// `State` standing, and `#Tag({ label = "x" })` on a `Box<Value>` says nothing
// at all. Both used to carry the Choice's own Parameter into the Program as the
// Type of a value, where it resurfaced far from here — as an `unsatisfied-bound`
// about a name nothing applied, or as codegen forwarding a witness no caller
// declares — which is the same leak the unit-Case rail was closed for.
//
// A Parameter the payload left is told from an enclosing Function's own by the
// name it carries: `instantiateCaseFromPayload` matches under freshened names
// and leaves what did not bind under one, and no source Generic can be spelled
// that way. So `Step<Optional<Item>, Optional<Item>>` inside a generic Namespace
// is decided — twice over by a Type Parameter the reader wrote — while the
// `State` of a leaked `Progress` is not.
//
// Asked in the enrichment pass alone, never while a Function literal's return
// Type is being worked out from its body: that pass seeds no expected return
// Type on purpose, so `<- #Done(item)` is read there with nothing around it
// every single time, and answering an Error where the pass needs a Type poisons
// the very inference it exists to do. The construction is asked again once the
// call has committed, under the position the finished call decided, and that is
// the pass that refuses.
function reportUndecidedPayloadTypeArguments(
	node: parser.CaseValueNode,
	caseType: common.CaseType,
	choiceGenerics: Array<common.GenericDeclaration>,
): common.CaseType | common.ErrorType {
	if (inferReturnTypeFromBodyDepth > 0) {
		return caseType
	}

	let undecided = choiceGenerics
		.filter((_, index) => {
			let typeArgument = caseType.typeArguments?.[index]

			return (
				typeArgument !== undefined &&
				mentionsUnsolvedTypeParameter(typeArgument)
			)
		})
		.map((generic) => generic.name)

	if (undecided.length === 0) {
		return caseType
	}

	return reportUndecidedTypeArguments(
		`#${node.caseName.content}(…)`,
		displayChoiceName(caseType.choice),
		node.caseName.content,
		choiceGenerics,
		node.position,
		undecided,
	)
}

// NOTE: Whether there is a payload here to ask about the Type Arguments at all.
// The refusal above is about the Parameters a payload that STOOD leaves behind,
// so a payload that never stood is none of its business: a Case that carries one
// and was written without (`missing-payload`) and one whose payload is not the
// Case's Record (`payload-type-mismatch`) are the Validator's to report against
// a Case whose Type resolves either way, and standing in front of them with a
// message about Type Arguments hid the mistake the reader actually made — `#Full`
// alone was told its payload decides none of them, about a payload it never
// wrote and a `(…)` it never spelled. An Error payload is the third: it binds
// nothing, so every Type Parameter would report as undecided on top of the
// Diagnostic that is the whole reason none of them are.
function payloadStandsForCase(
	caseType: common.CaseType,
	value: common.typed.ExpressionNode | null,
): boolean {
	if (value === null || typeContainsError(value.type)) {
		return false
	}

	return payloadFitsCase(caseType, value.type)
}

export function enrichMethodInvocation(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
): common.typed.MethodInvocationNode {
	// NOTE: The receiver is enriched once and its Type drives Method resolution
	// — the resolved Invocation reuses this same typed base. Each Argument is
	// likewise enriched once, by the typer, and reused for the final Node.
	//
	// NOTE: And with no expected Type, deliberately: the receiver position offers
	// none. Dispatch READS the receiver's Type to find the Namespace, so there is
	// nothing to hand down before that Type exists, and a Namespace found by
	// handing one down would be the Namespace deciding what it is being called
	// on. A construction written directly on a `::` therefore decides for itself
	// or not at all — `Box<Integer>#Full(1)::label()` is the spelling, and the
	// undecided `Box#Full(1)::label()` says which Arguments are missing and how
	// to write them.
	let base = enrichExpression(node.base, scope)
	let typer = makeArgumentTyper(scope)
	let {
		namespace,
		type,
		overloadedMethodIndex,
		conformances,
		omittedParameterIndices,
		derivedDescriptor,
		dispatch,
	} = resolveMethodInvocation(node, base.type, scope, typer)

	return {
		nodeType: "MethodInvocation",
		base,
		member: {
			name: node.member.content,
			position: node.member.position,
		},
		arguments: node.arguments.map((argument) =>
			typer.enrichArgumentNode(argument),
		),
		position: node.position,
		namespace,
		type,
		overloadedMethodIndex,
		conformances,
		omittedParameterIndices,
		derivedDescriptor,
		dispatch,
	}
}

export function enrichFunctionInvocation(
	node: parser.FunctionInvocationNode,
	scope: enricher.Scope,
): common.typed.FunctionInvocationNode {
	// NOTE: The callee and every Argument are enriched once — its Type drives
	// resolution and the same typed Nodes build the final Invocation.
	let name = enrichCalleeExpression(node.name, scope)
	let typer = makeArgumentTyper(scope)
	let { type, conformances, overloadedMethodIndex, omittedParameterIndices } =
		resolveFunctionInvocation(node, name.type, scope, typer)

	return {
		nodeType: "FunctionInvocation",
		name,
		arguments: node.arguments.map((argument) =>
			typer.enrichArgumentNode(argument),
		),
		position: node.position,
		type,
		overloadedMethodIndex,
		conformances,
		omittedParameterIndices,
	}
}

export function enrichCombination(
	node: parser.CombinationNode,
	scope: enricher.Scope,
): common.typed.CombinationNode {
	let lhs = enrichExpression(node.lhs, scope)
	// NOTE: The update is enriched with the value it updates as its expected
	// Type, so each updated member is read against the Type the original
	// declared for it — a bare Case resolves, and one arm of a Union-typed
	// member is enough, exactly as it is at the Declaration.
	let rhs = enrichExpression(node.rhs, scope, lhs.type)

	return {
		nodeType: "Combination",
		lhs,
		rhs,
		position: node.position,
		type: combinationTypeOf(
			lhs.type,
			rhs.type,
			node.lhs.position,
			node.rhs.position,
		),
	}
}

export function enrichMethodFunctionDefinition(
	method: parser.FunctionValueNode,
	scope: enricher.Scope,
	selfType: common.Type | null,
	// NOTE: The Method's already-resolved signature. Its Parameter and return
	// Types seed the typed Node so the annotations are resolved once — the
	// caller resolves the signature anyway, for the FunctionValue's own Type.
	signature: common.FunctionType,
	// NOTE: Constrained Namespace Generics threaded in for a conditional
	// conformance's fulfilling Method — bounded GenericUses in the body scope
	// (so it can call the Protocol's Methods on `Item` values), and leading the
	// typed Generics so their hidden conformance Parameters are emitted first.
	injectedGenerics: Array<common.typed.GenericDeclarationNode> = [],
	// NOTE: A static Method is called on the Namespace, so it has no receiver
	// and its body Scope is marked as the barrier `@` resolution stops at.
	isStatic: boolean = false,
): common.typed.FunctionDefinitionNode {
	// NOTE: `scope` and `selfType` already carry the injected bounds when this
	// is a fulfilling Method (the caller resolved the signature under them too),
	// so the body reads them consistently.
	// The Method's own Generics are registered as GenericUses so that Parameter
	// and Return Types as well as the body can reference them.
	let newScope = scopeWithGenerics(method.value.generics, scope)

	if (isStatic) {
		// NOTE: The Rewriter emits a static Method WITHOUT the `_self`
		// Parameter `@` lowers to, so an `@` accepted here would compile to a
		// name nothing binds. Marking the Scope refuses it outright — leaving
		// it merely undeclared would let the enclosing Namespace's `@` (every
		// instance Method beside it binds one) answer in its place.
		newScope.isStaticMethodBody = true
	} else if (selfType !== null) {
		declareVariableInScope(
			"@",
			shadowSelfTypeGenerics(selfType, method.value.generics, newScope),
			newScope,
			true,
		)
	}

	// NOTE: Read from the signature before the body so that `<-` Expressions can
	// consult it — a bare Case resolves against the declared return Type first.
	let returnType = signature.returnType
	newScope.expectedReturnType = returnType

	let { parameters, bindings } = enrichParameterList(
		method.value.parameters,
		newScope,
		signature.parameterTypes,
	)

	return {
		nodeType: "FunctionDefinition",
		generics: [
			...injectedGenerics,
			...method.value.generics.map((generic) =>
				enrichGenericDeclarationNode(generic, scope),
			),
		],
		parameters,
		// NOTE: A Parameter's Pattern desugars into Constants at the head of the
		// body, exactly as a Matcher's bindings do.
		body: [
			...bindings,
			...method.value.body.flatMap((node) => enrichNode(node, newScope)),
		],
		returnType,
		// NOTE: A Method always writes its annotations — the Parser only
		// allows omitting them for a literal in expression position.
		inferredReturnType: null,
		parameterListPosition: method.value.parameterListPosition,
		headPosition: signatureHeadPositionOf(method.value),
	}
}

// NOTE: A Method Generic SHADOWS a Namespace Generic of the same name — see
// `List.sorted<infer ItemType is Comparable>`, declared on a Namespace that
// already has an unbounded `ItemType`. The Method's Parameter and return Types
// are resolved in a Scope where the name is the Method's, so `@` has to agree:
// the receiver of `sort` is a List of the BOUNDED ItemType, which is what
// lets `first::compare(to second)` in the body resolve through the bound and
// reach the hidden conformance Argument. Left unshadowed, `@` would carry the
// Namespace's opaque Generic, an item read off it would have no bound, and the
// body could call nothing on it.
//
// This is the same substitution `withInjectedBounds` performs for a conditional
// conformance's injected Namespace Generics, applied to the Generics a Method
// declares for itself. Both are needed and neither subsumes the other: the
// injected ones are Namespace Generics the Method never names, these are names
// the Method takes over.
function shadowSelfTypeGenerics(
	selfType: common.Type,
	generics: Array<parser.GenericDeclarationNode>,
	scope: enricher.Scope,
): common.Type {
	if (generics.length === 0) {
		return selfType
	}

	// NOTE: Read back out of the Scope the Method's Generics were just
	// registered in, rather than rebuilt here, so the shadowing `@` sees is the
	// same object its Parameter Types see.
	let bindings: GenericBindings = new Map(
		generics.flatMap((generic) => {
			let shadowing = scope.types[generic.name.content]

			return shadowing === undefined
				? []
				: [[generic.name.content, shadowing] as const]
		}),
	)

	return applyGenericBindings(selfType, bindings)
}

export function enrichGenericDeclarationNode(
	node: parser.GenericDeclarationNode,
	scope: enricher.Scope,
): common.typed.GenericDeclarationNode {
	return {
		nodeType: "GenericDeclaration",
		defaultType: node.defaultType
			? resolveType(node.defaultType, scope)
			: null,
		name: node.name.content,
		inferred: node.inferred,
		constraint: node.constraint?.content ?? null,
		position: node.position,
	}
}

export function enrichFunctionDefinition(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.typed.FunctionDefinitionNode {
	// NOTE: Declared Generics are registered as GenericUses so that
	// Parameter and Return Types can reference them. They stay opaque
	// within the body; binding to concrete Types happens at each use site
	// via Generic Inference.
	let newScope = scopeWithGenerics(node.generics, scope)

	// NOTE: A literal that omitted its annotations was already resolved
	// against the expected signature while the invocation was matched; this
	// pass reads that back rather than re-deriving it, because here the
	// expected Type is gone.
	let contextualType = contextualFunctionTypeOf(node, scope)

	// NOTE: Resolved before the body so that `<-` Expressions can consult it
	// — a bare Case resolves against the declared return Type first.
	let returnType =
		contextualType?.returnType ??
		(node.returnType === null
			? { type: "Error" as const }
			: resolveType(node.returnType, newScope))

	newScope.expectedReturnType = returnType

	let { parameters, bindings } = enrichParameterList(
		node.parameters,
		newScope,
		contextualType?.parameterTypes,
	)

	return {
		nodeType: "FunctionDefinition",
		parameters,
		generics: node.generics.map((generic) =>
			enrichGenericDeclarationNode(generic, scope),
		),
		// NOTE: A Parameter's Pattern desugars into Constants at the head of the
		// body, exactly as a Matcher's bindings do.
		body: [
			...bindings,
			...node.body.flatMap((node) => enrichNode(node, newScope)),
		],
		returnType,
		inferredReturnType: node.returnType === null ? returnType : null,
		parameterListPosition: node.parameterListPosition,
		headPosition: signatureHeadPositionOf(node),
	}
}

// NOTE: A Scope in which the injected Namespace Generics are their bounded
// GenericUses, so a fulfilling Method's signature and body resolve `Item` with
// its `where` bound — and the corresponding constraint-carrying selfType, so a
// Protocol-Method call on `@`'s members resolves through that bound too.
function withInjectedBounds(
	scope: enricher.Scope,
	selfType: common.Type | null,
	injectedGenerics: Array<common.typed.GenericDeclarationNode>,
): { scope: enricher.Scope; selfType: common.Type | null } {
	if (injectedGenerics.length === 0) {
		return { scope, selfType }
	}

	let boundedUses = injectedGenerics.map(
		(generic): common.GenericUse => ({
			type: "GenericUse",
			name: generic.name,
			...(generic.constraint !== null
				? { constraint: generic.constraint }
				: {}),
		}),
	)

	let boundedScope = childScope(scope, {
		types: Object.fromEntries(boundedUses.map((use) => [use.name, use])),
	})

	let bindings = new Map(boundedUses.map((use) => [use.name, use]))

	return {
		scope: boundedScope,
		selfType:
			selfType === null ? null : applyGenericBindings(selfType, bindings),
	}
}

export function enrichMethodFunctionValue(
	node: parser.SimpleMethod | parser.StaticMethod,
	scope: enricher.Scope,
	selfType: common.Type | null,
	injectedGenerics: Array<common.typed.GenericDeclarationNode> = [],
): common.typed.FunctionValueNode {
	let bounded = withInjectedBounds(scope, selfType, injectedGenerics)

	// NOTE: The signature is resolved once and seeds the body enrichment, so the
	// Method's annotations are walked once rather than once here and once again
	// inside the definition.
	let type = resolveFunctionValueType(node.method, bounded.scope)

	return {
		nodeType: "FunctionValue",
		value: enrichMethodFunctionDefinition(
			node.method,
			bounded.scope,
			bounded.selfType,
			type,
			injectedGenerics,
			// NOTE: Read off the Node rather than taken from the caller, so
			// that a static Method can not be enriched as an instance one by a
			// call site that forgot to say which it is. Its `selfType` is the
			// Namespace's target Type, which a static Method's Parameter and
			// return Types may name — it simply never becomes `@`.
			node.nodeType === "StaticMethod",
		),
		position: node.method.position,
		type,
	}
}

export function enrichMethodsFunctionValue(
	node: parser.OverloadedMethod | parser.OverloadedStaticMethod,
	scope: enricher.Scope,
	selfType: common.Type | null,
	// NOTE: One list per Overload — an Overload's woven Generics are exactly
	// the ones its own entry in the resolved Method Type retained, so the two
	// views can not drift apart.
	injectedGenerics: Array<Array<common.typed.GenericDeclarationNode>> = [],
): Array<common.typed.FunctionValueNode> {
	let results: Array<common.typed.FunctionValueNode> = []

	for (let [index, method] of Object.values(node.methods).entries()) {
		let injected = injectedGenerics[index] ?? []
		let bounded = withInjectedBounds(scope, selfType, injected)
		let type = resolveFunctionValueType(method, bounded.scope)

		results.push({
			nodeType: "FunctionValue",
			value: enrichMethodFunctionDefinition(
				method,
				bounded.scope,
				bounded.selfType,
				type,
				injected,
				node.nodeType === "OverloadedStaticMethod",
			),
			position: method.position,
			type,
		})
	}

	return results
}

export function enrichRecordValue(
	node: parser.RecordValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.typed.RecordValueNode {
	// NOTE: The annotation is resolved once here and handed to the core, which
	// is the single place that reports 'record-annotation-not-record'. The
	// enriched Record is reused wherever its Type is wanted — as an Argument the
	// invocation's typer caches it — so the annotation is not resolved again.
	let resolvedAnnotation =
		node.type !== null ? resolveType(node.type, scope) : null

	// NOTE: A member stands in the position its name has in whatever Record the
	// literal is expected to be — its own annotation first, since that is the
	// Type it will HAVE, and the surrounding position otherwise.
	let members = enrichMembers(
		node.members,
		scope,
		expectedRecordMembers(resolvedAnnotation ?? expectedType),
	)

	let memberTypes: Record<string, common.Type> = {}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		memberTypes[memberKey] = memberValue.type
	}

	return {
		nodeType: "RecordValue",
		members,
		position: node.position,
		type: recordValueTypeOf(
			resolvedAnnotation,
			memberTypes,
			node.type?.position ?? null,
		),
		// NOTE: A valid Record annotation is the declared Type; anything else
		// (a non-Record annotation, an Error, or none) leaves it null.
		declaredType:
			resolvedAnnotation !== null && resolvedAnnotation.type === "Record"
				? resolvedAnnotation
				: null,
	}
}

export function enrichStringValue(
	node: parser.StringValueNode,
	_scope: enricher.Scope,
): common.typed.StringValueNode {
	return {
		nodeType: "StringValue",
		value: node.value,
		position: node.position,
		type: { type: "String" },
	}
}

// NOTE: A hole is interpolated by its value's `toString`, so it must be
// `Printable` — resolved through the very machinery a bounded Method's items go
// through (`solveConformance`), which threads the same witness `List::join`
// does. A hole whose Type has no such conformance — an `Optional`, a bare
// structural Union — is refused with `interpolation-not-printable`, and a
// placeholder `parameter` witness keeps the rest of the enrichment going.
export function enrichInterpolatedStringValue(
	node: parser.InterpolatedStringValueNode,
	scope: enricher.Scope,
): common.typed.InterpolatedStringValueNode {
	let segments: Array<common.typed.InterpolationSegmentNode> =
		node.segments.map((segment) => {
			if (segment.kind === "text") {
				return segment
			}

			let expression = enrichExpression(segment.expression, scope)

			reportRedundantInterpolatedToString(expression, scope)

			let solved = solveConformance(
				expression.type,
				"Printable",
				scope,
				expression.position,
			)

			if (!solved.ok) {
				// NOTE: An empty chain means the failure was already reported
				// (an Error-typed hole, an unknown Protocol) — stay silent to
				// avoid a cascade, exactly as `resolveConformances` does.
				if (solved.chain.length > 0) {
					reportError(
						`${describeType(expression.type)} can not be interpolated into a String`,
						expression.position,
						{
							code: "interpolation-not-printable",
							labels: [
								primary(
									expression.position,
									`this is ${describeType(expression.type)}, which is not Printable`,
								),
							],
							notes: solved.chain,
							helps: [
								"Interpolate only Printable values; match an Optional or a Union apart first and interpolate each Case.",
							],
						},
					)
				}

				return {
					kind: "expression",
					expression,
					conformance: {
						genericName: "$interpolation",
						protocolName: "Printable",
						source: { kind: "parameter", name: "$interpolation" },
					},
				}
			}

			return {
				kind: "expression",
				expression,
				conformance: {
					genericName: "$interpolation",
					protocolName: "Printable",
					source: solved.source,
				},
			}
		})

	return {
		nodeType: "InterpolatedStringValue",
		segments,
		position: node.position,
		type: { type: "String" },
	}
}

// NOTE: A hole renders its value through the very `toString` a `Printable`
// receiver's own conformance provides, so writing that call out spells the
// hole's own step a second time — `"{ count::toString() }"` and `"{ count }"`
// are the same String by construction, not by coincidence. Three things keep
// this from flagging a call that means something:
//
// - An Argument makes it a different Method. `Rational`'s
//   `toString(formatAs #Decimal)` picks a form the hole would not have.
// - A non-String answer is a `toString` that merely shares the name; dropping
//   it would change what is interpolated.
// - A receiver that is not itself Printable — an `Optional`, a bare structural
//   Union — has no conformance for the hole to reach, so the explicit call is
//   the ONLY spelling and `interpolation-not-printable` is what the alternative
//   would earn.
function reportRedundantInterpolatedToString(
	expression: common.typed.ExpressionNode,
	scope: enricher.Scope,
): void {
	if (
		expression.nodeType !== "MethodInvocation" ||
		expression.member.name !== "toString" ||
		expression.arguments.length > 0 ||
		expression.type.type !== "String"
	) {
		return
	}

	// NOTE: Solved speculatively. An ambiguous conformance on the receiver is a
	// Diagnostic about the receiver, and this query is one the Program never
	// asked for — reporting from inside it would blame the hole for a Namespace
	// clash the reader would meet again the moment they took the call out.
	let { result: receiver } = collectDiagnostics(() =>
		solveConformance(
			expression.base.type,
			"Printable",
			scope,
			expression.base.position,
		),
	)

	if (!receiver.ok) {
		return
	}

	// NOTE: The span is the call alone — from the end of the receiver to the
	// end of the Invocation — so the greyed-out range is exactly what deleting
	// it would remove, chained receivers (`x::length()::toString()`) and a
	// written Namespace specifier (`::<Integer>toString()`) included.
	let callPosition = {
		start: expression.base.position.end,
		end: expression.position.end,
	}

	reportWarning(
		"A String Interpolation calls 'toString' on its own",
		callPosition,
		{
			code: "redundant-interpolation-to-string",
			labels: [
				primary(callPosition, "this call is redundant"),
				secondary(
					expression.base.position,
					`this is ${describeType(expression.base.type)}, which is Printable`,
				),
			],
			notes: [
				"A hole renders its value through its 'Printable' conformance — the same Method this call names.",
			],
			helps: [
				"Drop the '::toString()' and interpolate the value itself.",
			],
			tags: ["unnecessary"],
		},
	)
}

export function enrichIntegerValue(
	node: parser.IntegerValueNode,
	_scope: enricher.Scope,
): common.typed.IntegerValueNode {
	return {
		nodeType: "IntegerValue",
		value: node.value,
		position: node.position,
		type: { type: "Integer" },
	}
}

export function enrichRationalValue(
	node: parser.RationalValueNode,
	_scope: enricher.Scope,
): common.typed.RationalValueNode {
	return {
		nodeType: "RationalValue",
		numerator: node.numerator,
		denominator: node.denominator,
		position: node.position,
		type: { type: "Rational" },
	}
}

export function enrichBooleanValue(
	node: parser.BooleanValueNode,
	_scope: enricher.Scope,
): common.typed.BooleanValueNode {
	return {
		nodeType: "BooleanValue",
		value: node.value,
		position: node.position,
		type: { type: "Boolean" },
	}
}

export function enrichFunctionValue(
	node: parser.FunctionValueNode,
	scope: enricher.Scope,
): common.typed.FunctionValueNode {
	captureBoundaries.push(scope)

	try {
		return {
			nodeType: "FunctionValue",
			value: enrichFunctionDefinition(node.value, scope),
			position: node.position,
			type: resolveFunctionValueType(node, scope),
		}
	} finally {
		captureBoundaries.pop()
	}
}

// NOTE: The Scopes the Function literals currently being enriched were written
// in, innermost last. A name resolving AT or ABOVE one of them is captured
// rather than local, and a capture is the one thing a later assignment can not
// repair: the body is checked once, here, against the Type the captured name
// has at this moment.
let captureBoundaries: Array<enricher.Scope> = []

// NOTE: Whether `declaringScope` is the Scope the innermost Function literal
// was written in, or one it can see — walking OUTWARDS from the boundary, so
// that the literal's own Parameters and locals, which live in a Scope below it,
// are not mistaken for captures.
function isCapturedFrom(
	boundary: enricher.Scope,
	declaringScope: enricher.Scope,
): boolean {
	let searchScope: enricher.Scope | null = boundary

	while (searchScope !== null) {
		if (searchScope === declaringScope) {
			return true
		}

		searchScope = searchScope.parent
	}

	return false
}

// NOTE: Narrowing decides an undecided Type at the assignment that decides it,
// which is too late for a Function literal written above one: its body was
// already checked against the undecided Type, and `List<Unknown>` fits every
// List, so a captured `items` could be returned as a List of Strings and hold
// Integers at runtime. The capture is refused instead — it is the one place
// where nothing later can make the body's Types true.
function reportUninferableCapture(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
	type: common.Type,
): void {
	let boundary = captureBoundaries[captureBoundaries.length - 1]

	if (boundary === undefined || !typeContainsUnknown(type)) {
		return
	}

	let declaringScope = findDeclaringScope(node.content, scope)

	if (declaringScope === null || !isCapturedFrom(boundary, declaringScope)) {
		return
	}

	let declarationPosition = declaringScope.declarations[node.content] ?? null

	reportError(
		`'${node.content}' is captured before its item Type is decided`,
		node.position,
		{
			code: "uninferable-item-type",
			labels: [
				primary(
					node.position,
					`captured here as ${withArticle(describeType(type))}`,
				),
				...(declarationPosition === null
					? []
					: [
							secondary(
								declarationPosition,
								"declared with nothing to say what it holds",
							),
						]),
			],
			notes: [
				"An empty List Literal leaves its item Type unknown until an assignment decides it, and this Function was checked before that happened.",
			],
			helps: [
				`Annotate the declaration — 'variable ${node.content}: List<Integer> = []' — so the Function is checked against the Type it will hold.`,
			],
		},
	)
}

export function enrichListValue(
	node: parser.ListValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.typed.ListValueNode {
	// NOTE: A List's items stand in the item position of whatever the List is
	// expected to be, so that is the expected Type they are enriched under —
	// `constant items: List<Box<Integer>> = [Box#Empty]` is the same decision the
	// annotation makes for a Case written directly under it.
	let expectedItemType = expectedListItemType(expectedType)

	let values = node.values.map((expr) =>
		enrichExpression(expr, scope, expectedItemType),
	)

	return {
		nodeType: "ListValue",
		values,
		position: node.position,
		type: {
			type: "List",
			itemType: listItemTypeOf(values.map((value) => value.type)),
		},
	}
}

export function enrichLookup(
	node: parser.LookupNode,
	scope: enricher.Scope,
): common.typed.LookupNode {
	let base = enrichExpression(node.base, scope)
	// NOTE: The Lookup and its member Identifier share one Type — the member's
	// Type *is* the Lookup's Type, so it is resolved once and handed to both.
	let type = lookupTypeOf(base.type, node.member.content, {
		member: node.member.position,
		base: node.base.position,
	})

	return {
		nodeType: "Lookup",
		base,
		member: {
			nodeType: "Identifier",
			content: node.member.content,
			position: node.member.position,
			type,
		},
		position: node.position,
		type,
	}
}

export function enrichIdentifier(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
	type: common.Type = resolveIdentifierType(node, scope),
): common.typed.IdentifierNode {
	reportUninferableCapture(node, scope, type)

	return {
		nodeType: "Identifier",
		content: node.content,
		position: node.position,
		type,
	}
}

// NOTE: An Identifier in Expression position can stand for a member of `@`
// instead of for a binding of its own — see `selfMemberAliases`. The alias is
// read off the Scope that DECLARES the name, so an inner binding of the same
// name shadows it exactly like any other declaration would.
function enrichIdentifierExpression(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
): common.typed.ExpressionNode {
	let declaringScope = findDeclaringScope(node.content, scope)
	let alias = declaringScope?.selfMemberAliases?.[node.content]

	if (declaringScope === null || alias === undefined) {
		return enrichIdentifier(node, scope)
	}

	return selfPathLookup(
		alias.path,
		declaringScope.members[node.content]!,
		alias.selfType,
		node.position,
		alias.stepPositions,
	)
}

export function enrichSelf(
	node: parser.SelfNode,
	scope: enricher.Scope,
	type: common.Type = resolveSelfType(node, scope),
): common.typed.SelfNode {
	// TODO: Can a namespace ever be a valid Type for Self?
	if (type.type === "Namespace") {
		if (type.targetType) {
			type = type.targetType
		}
	}

	return {
		nodeType: "Self",
		position: node.position,
		type,
	}
}

// NOTE: A wildcard Handler stands for whatever the Handlers before it have not
// already caught, so it resolves to the Union of the still-unhandled members.
// That is what lets `@` inside `case _` keep the matched Union's own member
// Type instead of degrading to Unknown — `case #Empty` followed by `case _`
// types `@` as the Optional's other Case. A wildcard with nothing left to catch
// falls back to Unknown, which matches anything, so a redundant `case _` stays
// harmless rather than becoming un-typeable.
function resolveWildcardMatcherType(
	valueType: common.Type,
	handledMatchers: Array<common.Type>,
): common.Type {
	let isHandled = (memberType: common.Type) =>
		handledMatchers.some((handledMatcher) =>
			matchesType(handledMatcher, memberType),
		)

	if (valueType.type !== "UnionType") {
		return isHandled(valueType) ? { type: "Unknown" } : valueType
	}

	// NOTE: Handling is checked member by member for the same reason the
	// Validator's exhaustiveness check flattens — but a named nested Union
	// (`Number`, a Choice) whose members are all still unhandled stays whole,
	// so `@` Hovers print its name. Once a Handler has taken some of its
	// members, only the remaining ones survive, and those are necessarily
	// spelled out.
	let remainingTypes: Array<common.Type> = []

	for (let memberType of unionMembersKeepingNames(valueType)) {
		if (memberType.type === "UnionType") {
			let flattened = flattenUnionMembers(memberType)
			let remaining = flattened.filter((member) => !isHandled(member))

			if (remaining.length === flattened.length) {
				remainingTypes.push(memberType)
			} else {
				remainingTypes.push(...remaining)
			}
		} else if (!isHandled(memberType)) {
			remainingTypes.push(memberType)
		}
	}

	if (remainingTypes.length === 0) {
		return { type: "Unknown" }
	}

	if (remainingTypes.length === 1) {
		return remainingTypes[0]
	}

	return buildUnion(remainingTypes)
}

// NOTE: A checked refinement can not stand where a runtime test is emitted — the
// predicate is a check the runtime never hears of, so the test could only ask
// about the base and the arm would run for values the predicate refuses, typed
// as evidence nothing proved. Refused wherever a Matcher narrows by Type: the
// Matcher itself, and the annotation on a Pattern's member. Refused however
// DEEP the refinement stands, too — `List<NonZero>` spells no refinement at its
// top level, but the emitted check could still only ask about `List<Integer>`,
// and the arm would bind items the predicate refuses. The Error Type is the
// usual poison, so the one Diagnostic does not cascade.
function refuseRefinementMatcher(
	type: common.Type,
	position: common.Position,
): common.Type {
	if (!typeContainsRefinement(type)) {
		return type
	}

	let described = describeType(type)
	let base = describeType(eraseRefinements(type))

	reportError(`A Matcher can not test for '${described}'`, position, {
		code: "refinement-as-matcher",
		labels: [
			primary(
				position,
				type.type === "Refinement"
					? "this is a checked refinement"
					: "this carries a checked refinement",
			),
		],
		notes: [
			`A refinement's predicate erases before the Program runs, so the emitted check could only ask about '${base}' — and the arm would run for values the predicate refuses.`,
		],
		helps: [
			`Match on '${base}' and prove the predicate inside the arm, the way every '${described}' is proven: an 'if' condition, a Case naming a written value, or a written value.`,
		],
	})

	return { type: "Error" }
}

export function enrichMatch(
	node: parser.MatchNode,
	scope: enricher.Scope,
): common.typed.MatchNode {
	let value = enrichExpression(node.value, scope)
	let returnType = resolveType(node.returnType, scope)
	let handledMatchers: Array<common.Type> = []
	// NOTE: The values the Handlers above have NAMED, as the questions they asked
	// — `case 0` asked `@::is(0)`, and every Handler below it is reached by a value
	// that answered no. See `refinedSelfType`, which is what reads them.
	let namedValues: Array<common.PredicateConjunct> = []

	return {
		nodeType: "Match",
		value,
		handlers: node.handlers.map((handler) => {
			// NOTE: `expectedReturnType` is what a Handler's `<-` yields — a
			// bare Case there resolves against the Match's declared return
			// Type first.
			let bodyScope = childScope(scope, {
				expectedReturnType: returnType,
			})

			let literal: common.typed.ExpressionNode | null = null
			let memberLiterals: Record<
				string,
				common.typed.ExpressionNode
			> | null = null
			let memberTypes: Record<string, common.Type> | null = null
			let payload: PayloadRequirements | null = null
			let matcher: common.Type

			if (handler.matcher.nodeType === "LiteralMatcher") {
				// NOTE: A literal Matcher binds `@` to the literal's own Type —
				// inside `case 0` the value is known to be an Integer.
				literal = enrichExpression(handler.matcher.value, scope)
				matcher = literal.type
			} else if (handler.matcher.nodeType === "WildcardMatcher") {
				matcher = resolveWildcardMatcherType(
					value.type,
					handledMatchers,
				)
			} else if (handler.matcher.nodeType === "CaseMatcher") {
				let literals: Record<string, common.typed.ExpressionNode> = {}

				matcher = resolveCaseMatcherType(
					handler.matcher,
					value.type,
					scope,
				)

				// NOTE: What the payload Pattern requires — beside the Matcher
				// rather than inside it, so the Case stays the arm it is and
				// only the Handler becomes conditional. It also says what the
				// arm PROVED, which is what its bindings are read at.
				payload = resolvePayloadRequirements(
					handler.matcher,
					matcher,
					scope,
					literals,
				)

				memberTypes = payload.memberTypes
				memberLiterals =
					Object.keys(literals).length > 0 ? literals : null
			} else if (handler.matcher.nodeType === "Pattern") {
				let literals: Record<string, common.typed.ExpressionNode> = {}

				matcher = resolvePatternMatcherType(
					handler.matcher,
					value.type,
					scope,
					literals,
				)

				memberLiterals =
					Object.keys(literals).length > 0 ? literals : null
			} else {
				matcher = refuseRefinementMatcher(
					resolveType(handler.matcher, scope),
					handler.matcher.position,
				)
			}

			// NOTE: Only an unconditional Handler retires a Type. A literal
			// Matcher, a value-constrained Record member, a payload Pattern
			// requiring something of a member, or a Guard can all decline a
			// value whose Type they accepted, so a later wildcard still has to
			// account for that Type.
			if (
				literal === null &&
				memberLiterals === null &&
				memberTypes === null &&
				handler.guard === null
			) {
				handledMatchers.push(matcher)
			}

			// NOTE: Read from the values the Cases ABOVE this one named, which is
			// why this Handler's own joins the list only afterwards.
			declareVariableInScope(
				"@",
				refinedSelfType(matcher, namedValues, literal, scope),
				bodyScope,
				true,
			)

			// NOTE: And what this Handler leaves to the ones below it — nothing at
			// all where a Guard could decline the value it named.
			let namedValue =
				literal === null || handler.guard !== null
					? null
					: namedValueConjunct(literal)

			if (namedValue !== null) {
				namedValues.push(namedValue)
			}

			// NOTE: Resolved before the Guard is enriched, so that the Guard
			// can name them — and reported here, once, rather than once per
			// place a name is lent to.
			let bindings = resolveMatcherBindings(
				handler.matcher,
				matcher,
				payload,
			)

			// NOTE: A Guard proves things about `@` the same way an `if`'s
			// condition proves them about a Constant, and it runs before any
			// Statement of the body — the Matcher's own check is ANDed in front
			// of it — so whatever it establishes holds throughout. Which is why
			// the two are worked out together: what a Guard proves is read in the
			// very Scope it was enriched in.
			let guard: common.typed.ExpressionNode | null = null
			let guardNarrowings: Array<Narrowing> = []

			if (handler.guard !== null) {
				// NOTE: The Guard is enriched in the body Scope so that it can
				// use `@` — narrowing is what makes a Guard worth writing. A
				// Matcher's bindings are lent to it through an alias Scope
				// rather than through the Constants the body reads: see
				// `selfMemberAliases`.
				let guardScope =
					bindings.length === 0
						? bodyScope
						: scopeLendingBindings(bindings, matcher, bodyScope)

				guard = enrichExpression(handler.guard, guardScope)

				// NOTE: That Scope is the only one where the value a Handler NAMED
				// is a name at all — the body Scope has never heard of it, so a
				// Guard about the payload binding proved nothing about anything.
				guardNarrowings = narrowingsFor(
					conditionEvidence(guard, guardScope),
					guardScope,
					predicateConjunctKey,
				)
			}

			// NOTE: What the Guard established for a Matcher's own bindings is
			// not SHADOWED but DECLARED. A binding comes into being at the head
			// of the body, so there is no earlier declaration for a shadow to
			// stand in front of — and a shadow one Scope further out would be
			// the wrong shape anyway: the Constant it stood in front of is a
			// Statement of this very body, so a body re-declaring that name is
			// declaring it twice, and a Scope between the two would quietly make
			// that legal and emit one block holding two Constants of one name.
			//
			// Everything else the Guard established is shadowed as an `if`'s
			// condition shadows it, and the body goes one Scope deeper only when
			// something WAS established — so a Handler that narrows nothing
			// keeps declaring its bindings in the Scope it always did.
			//
			// Every bound name is excluded, not just the first: a Pattern binds
			// as many as it names, and one of them being narrowed must not leave
			// the others shadowed.
			let boundNames = new Set(
				bindings.map((binding) => binding.name.content),
			)
			let bindingNarrowings = new Map(
				guardNarrowings
					.filter((narrowing) => boundNames.has(narrowing.name))
					.map((narrowing) => [narrowing.name, narrowing.type]),
			)
			let shadowedNarrowings = guardNarrowings.filter(
				(narrowing) => !boundNames.has(narrowing.name),
			)
			let handlerScope =
				shadowedNarrowings.length === 0
					? bodyScope
					: childScope(scopeShadowing(shadowedNarrowings, bodyScope))

			// NOTE: `case #Value(item)` and `case { x, y }` alike — desugared
			// here rather than carried through the typed tree, so the
			// Simplifier, Rewriter and every walker downstream see the Constants
			// an author could have written themselves. `@` is untouched and
			// still means the narrowed scrutinee, so an arm can bind the parts
			// AND hand the whole value onwards.
			let bindingStatements = declareMatcherBindings(
				bindings,
				matcher,
				handlerScope,
				bindingNarrowings,
			)

			return {
				body: [
					...bindingStatements,
					...handler.body.flatMap((node) =>
						enrichNode(node, handlerScope),
					),
				],
				literal,
				memberLiterals,
				memberTypes,
				guard,
				matcher,
				matcherPosition: handler.matcher.position,
			}
		}),
		position: node.position,
		type: returnType,
	}
}

// #endregion

// #region Statements

// NOTE: The two Declarations are NOT among these — they are the only Statements
// that can become several, so `enrichNode` routes them through
// `enrichDeclarationStatement` before they get here. Excluding them from the
// parameter Type rather than leaving unreachable cases in the switch is what
// keeps that routing a fact TypeScript checks.
export function enrichStatement(
	node: Exclude<
		parser.StatementNode,
		| parser.ConstantDeclarationStatementNode
		| parser.VariableDeclarationStatementNode
	>,
	scope: enricher.Scope,
	hoistedTypes?: HoistedTypes,
): common.typed.StatementNode {
	// NOTE: A hoisted declaration's Type is already resolved and in scope — the
	// enrichment reuses it rather than resolving the same Node again. The cast
	// is sound because the Map is keyed by Node and each entry was produced by
	// the very resolver the matching case reuses it in.
	let hoistedType = hoistedTypes?.get(node)

	switch (node.nodeType) {
		case "VariableAssignmentStatement":
			return enrichVariableAssignmentStatement(node, scope)
		case "NamespaceDefinitionStatement":
			return enrichNamespaceDefinitionStatement(
				node,
				scope,
				hoistedType as common.NamespaceType | undefined,
			)
		case "ProtocolDeclarationStatement":
			return enrichProtocolDeclarationStatement(
				node,
				scope,
				hoistedType as common.ProtocolType | undefined,
			)
		case "TypeAliasStatement":
			return enrichTypeAliasStatement(
				node,
				scope,
				hoistedType as common.Type | undefined,
			)
		case "ChoiceDeclarationStatement":
			return enrichChoiceDeclarationStatement(
				node,
				scope,
				hoistedType as
					| common.UnionType
					| common.GenericAliasType
					| undefined,
			)
		case "IfElseStatement":
			return enrichIfElseStatementNode(node, scope)
		case "IfStatement":
			return enrichIfStatement(node, scope)
		case "ReturnStatement":
			return enrichReturnStatement(node, scope)
		case "FunctionStatement":
			return enrichFunctionStatement(
				node,
				scope,
				hoistedType as common.FunctionType | undefined,
			)
		case "OverloadedFunctionStatement":
			// NOTE: This declares a name and nothing to emit, and is handled
			// before enrichment by `enrichImplementation` — the top level is the
			// only place it is valid. Reaching here means one was nested in a
			// body (a `declarations`-mode Program only), which the Compiler has
			// no typed Node to represent.
			throw new Error(
				`A '${node.nodeType}' may only appear at the top level of a 'declarations { … }' Program`,
			)
	}
}

// NOTE: The value shapes that can not be a Function, whatever they are made
// of. A List of Functions is still a List, and takes no Parameters itself.
const parameterlessValues = new Set([
	"RecordValue",
	"StringValue",
	"InterpolatedStringValue",
	"IntegerValue",
	"RationalValue",
	"BooleanValue",
	"ListValue",
	"CaseValue",
])

// NOTE: The Parameters the value of a Declaration holds, or null where they
// can not be read off it. A `§§` block above a `constant` documents whatever
// it holds, so a `@param` there names a Parameter of a Function written as its
// value — that much is visible here.
//
// `constant alias = greet` is function-valued too, and is exactly why the
// answer is nullable: its Parameters live in a resolved Type, which keeps only
// the external names, so a `@param` naming an internal one could not be told
// from a typo. Answering null leaves such a Declaration unchecked, which is
// the honest outcome — the alternative was telling it that it takes no
// Parameters while Hover showed them.
function heldParameters(
	value: parser.ExpressionNode | null,
): Array<parser.ParameterNode> | null {
	if (value === null) {
		return null
	}

	if (value.nodeType === "FunctionValue") {
		return value.value.parameters
	}

	return parameterlessValues.has(value.nodeType) ? [] : null
}

function reportUnknownDocumentationOfValue(
	documentation: common.Documentation | null,
	value: parser.ExpressionNode | null,
): void {
	let parameters = heldParameters(value)

	if (parameters !== null) {
		reportUnknownDocumentationParameters(documentation, [parameters])
	}
}

// NOTE: A Declaration is one Statement or several — several exactly when its
// name is a Pattern, which is the only thing in the language that declares more
// than one name at a time.
function enrichDeclarationStatement(
	node:
		| parser.ConstantDeclarationStatementNode
		| parser.VariableDeclarationStatementNode,
	scope: enricher.Scope,
): Array<common.typed.ImplementationNode> {
	if (node.name.nodeType === "Pattern") {
		return enrichPatternDeclarationStatement(node, node.name, scope)
	}

	return [
		node.nodeType === "ConstantDeclarationStatement"
			? enrichConstantDeclarationStatement(node, node.name, scope)
			: enrichVariableDeclarationStatement(node, node.name, scope),
	]
}

export function enrichConstantDeclarationStatement(
	node: parser.ConstantDeclarationStatementNode,
	name: parser.IdentifierNode,
	scope: enricher.Scope,
): common.typed.ConstantDeclarationStatementNode {
	reportUnknownDocumentationOfValue(node.documentation, node.value)

	// NOTE: The annotation is the value's expected Type — a bare Case in the
	// value resolves against it before the scope scan.
	let declaredType = node.type !== null ? resolveType(node.type, scope) : null
	let value = enrichExpression(node.value, scope, declaredType)

	declareVariableInScope(name, declaredType ?? value.type, scope, true)

	return {
		nodeType: "ConstantDeclarationStatement",
		name: enrichIdentifier(name, scope),
		value,
		position: node.position,
		headPosition: headPositionOf(node.position, [
			name.position,
			node.type?.position,
		]),
		type: value.type,
		declaredType,
		documentation: node.documentation,
	}
}

export function enrichVariableDeclarationStatement(
	node: parser.VariableDeclarationStatementNode,
	name: parser.IdentifierNode,
	scope: enricher.Scope,
): common.typed.VariableDeclarationStatementNode {
	reportUnknownDocumentationOfValue(node.documentation, node.value)

	// NOTE: The annotation is the value's expected Type — a bare Case in the
	// value resolves against it before the scope scan.
	let declaredType = node.type !== null ? resolveType(node.type, scope) : null
	let value = enrichExpression(node.value, scope, declaredType)

	declareVariableInScope(name, declaredType ?? value.type, scope)

	return {
		nodeType: "VariableDeclarationStatement",
		name: enrichIdentifier(name, scope, value.type),
		value,
		position: node.position,
		headPosition: headPositionOf(node.position, [
			name.position,
			node.type?.position,
		]),
		type: value.type,
		declaredType,
		documentation: node.documentation,
	}
}

// NOTE: `constant { matching, rest } = list::partition(where …)` — the Pattern
// desugars into the Statements an author could have written instead: one
// Constant holding the value, and one per name the Pattern binds, each reading
// its way down that Constant.
//
// The base is a Constant even where the Declaration was a `variable`, and even
// where the value is a bare name that could have been read again: the value
// must be evaluated EXACTLY ONCE, because it is one Expression in the source
// and an author reading `partition(…)` twice is not what was written. Only the
// bindings themselves follow the Declaration's own keyword, so
// `variable { index, total } = …` gives two Variables.
//
// The base KEEPS its Position, because what it holds is the Declaration's own
// value Expression — real source, on the line the author wrote it, and the
// statement a debugger should stop on for that line. Dropping it was tried and
// is wrong: an unmapped statement is how the debug adapter recognises Compiler
// glue, so it answered a Step Over there with a step OUT and one step across a
// Pattern Declaration abandoned the rest of the body.
//
// Only its NAME is the Compiler's, and that name is unspellable in Essence for
// the same reason the Optimiser's are: the Lexer reads `_` as a Symbol, so no
// user Identifier holds one. It is derived from the Pattern's own Position so
// that enriching a body twice — which is what return-Type inference does —
// mints the same name both times, and `isSynthesizedName` is what every place
// that must not SHOW it asks.
function enrichPatternDeclarationStatement(
	node:
		| parser.ConstantDeclarationStatementNode
		| parser.VariableDeclarationStatementNode,
	pattern: parser.PatternNode,
	scope: enricher.Scope,
): Array<common.typed.ImplementationNode> {
	reportUnknownDocumentationOfValue(node.documentation, node.value)

	refuseRefutablePattern(pattern, "Declaration")

	let declaredType = node.type !== null ? resolveType(node.type, scope) : null
	let value = enrichExpression(node.value, scope, declaredType)

	// NOTE: The members are read off what the author DECLARED where they
	// declared anything, not off what the value happened to be — otherwise the
	// bindings and the annotation could disagree about the same value.
	let subjectType = declaredType ?? value.type
	let baseName = synthesizedName("pattern", pattern.position)

	declareVariableInScope(baseName, subjectType, scope, true)

	let base: common.typed.ConstantDeclarationStatementNode = {
		nodeType: "ConstantDeclarationStatement",
		name: {
			nodeType: "Identifier",
			content: baseName,
			position: pattern.position,
			type: subjectType,
		},
		value,
		position: pattern.position,
		headPosition: pattern.position,
		declaredType,
		type: value.type,
		documentation: null,
		synthesized: "base",
	}

	return [
		base,
		...declarePatternBindings(
			pattern,
			baseName,
			subjectType,
			scope,
			node.nodeType === "ConstantDeclarationStatement",
		),
	]
}

// NOTE: The Statements a Pattern in an IRREFUTABLE position desugars into — a
// Parameter's and a Declaration's alike. Both hold the value under one name
// first (a Parameter already is one; a Declaration has to make one), and both
// then read each binding off it.
//
// `isConstant` follows the Declaration's own keyword, so
// `variable { index, total } = state` gives two Variables while a Parameter's
// bindings, which nothing may assign to, are always Constants.
function declarePatternBindings(
	pattern: parser.PatternNode,
	baseName: string,
	subjectType: common.Type,
	scope: enricher.Scope,
	isConstant: boolean,
): Array<common.typed.ImplementationNode> {
	return irrefutablePatternBindings(pattern).map((binding) => {
		let type = memberTypeInIrrefutablePosition(binding, subjectType, scope)
		// NOTE: Carried as a written annotation rather than checked here, so
		// that a member annotated `width: String` over an Integer fails as the
		// `assignment-type-mismatch` the Validator reports for every other
		// annotated Declaration — the same Diagnostic, at the member's own span.
		let declaredType =
			binding.type === null ? null : resolveType(binding.type, scope)

		declareVariableInScope(
			binding.name,
			declaredType ?? type,
			scope,
			isConstant,
		)

		return {
			nodeType: isConstant
				? "ConstantDeclarationStatement"
				: "VariableDeclarationStatement",
			name: {
				nodeType: "Identifier",
				content: binding.name.content,
				position: binding.name.position,
				type,
			},
			value: memberPathLookup(
				baseName,
				subjectType,
				binding,
				type,
				pattern.position,
			),
			position: binding.name.position,
			headPosition: binding.name.position,
			declaredType,
			type,
			documentation: null,
			synthesized: "binding",
		} as common.typed.ImplementationNode
	})
}

// NOTE: What a binding actually reads in an irrefutable position, resolved
// through `lookupTypeOf` — the very resolver the Lookup an author could have
// written instead goes through.
//
// That is the whole point rather than a convenience: a Declaration Pattern
// PROMISES to be the Constants an author could have written, so it may not
// admit what those are refused for. `constant x = value.x` on a Union reports
// `type-without-members`, and on a misspelled member `unknown-member`; a
// `constant { x } = value` that quietly answered `Unknown` instead would bind
// a name to nothing and hand the body a value the checker had blessed.
//
// A Matcher is the opposite case and asks `memberTypeOf` instead: naming a
// member only some arms carry is how a Matcher DISCRIMINATES, and an arm that
// no value reaches is `unreachable-case` rather than an error.
function memberTypeInIrrefutablePosition(
	binding: PatternBinding,
	subjectType: common.Type,
	scope: enricher.Scope,
): common.Type {
	let type = subjectType

	for (let step of binding.steps) {
		type = lookupTypeOf(type, step.name.content, {
			member: step.name.position,
			base: step.name.position,
		})

		// NOTE: An annotation on an INTERMEDIATE step constrains that step and
		// nothing below it, so it is checked here and then stepped past — the
		// binding's own annotation is the last one, and the Validator checks
		// that through `declaredType` like any other.
		let annotation = step.type

		if (annotation !== null && step !== binding.steps.at(-1)) {
			let declared = resolveType(annotation, scope)

			if (!matchesType(declared, type)) {
				reportPatternMemberMismatch(step.name, declared, type)
			}

			type = declared
		}
	}

	return type
}

// NOTE: An intermediate step's annotation fails the way every annotation fails,
// under the code a reader already knows — this only has to be reported by hand
// because such a step becomes no Statement of its own for the Validator to
// check.
function reportPatternMemberMismatch(
	name: parser.IdentifierNode,
	declared: common.Type,
	actual: common.Type,
): void {
	reportError(
		`This value does not fit the declared Type of member '${name.content}'`,
		name.position,
		{
			code: "assignment-type-mismatch",
			labels: [
				primary(
					name.position,
					`this is ${withArticle(describeType(actual))}`,
				),
			],
			notes: [
				`'${name.content}' is declared as ${describeType(declared)}.`,
			],
		},
	)
}

export function enrichVariableAssignmentStatement(
	node: parser.VariableAssignmentStatementNode,
	scope: enricher.Scope,
): common.typed.VariableAssignmentStatementNode {
	let declaringScope = findDeclaringScope(node.name.content, scope)

	let declarationPosition =
		declaringScope?.declarations[node.name.content] ?? null

	if (declaringScope?.constants.has(node.name.content)) {
		reportError(
			`'${node.name.content}' can not be reassigned`,
			node.name.position,
			{
				code: "constant-reassignment",
				labels: [
					primary(node.name.position, "assigned to here"),
					...(declarationPosition === null
						? []
						: [
								secondary(
									declarationPosition,
									"declared as a Constant here",
								),
							]),
				],
				helps: [
					"Declare it with 'variable' instead of 'constant' if it needs to change.",
				],
			},
		)
	}

	let name = enrichIdentifier(node.name, scope)

	// NOTE: The target Variable's Type is the value's expected Type — a bare
	// Case in the value resolves against it before the scope scan.
	let value = enrichExpression(node.value, scope, name.type)

	narrowUnknownSlots(node.name.content, declaringScope, value.type)

	return {
		nodeType: "VariableAssignmentStatement",
		name,
		value,
		declarationPosition,
		position: node.position,
	}
}

// NOTE: An empty List Literal leaves its item Type Unknown, so `variable items
// = []` declares a name whose Type has a slot nothing has decided. The FIRST
// assignment that decides one decides it for good: from here on `items` is a
// List of Integers, a later `items = ["a"]` is the assignment-type-mismatch it
// looks like, and no annotation can be handed a List of Integers under the name
// of a List of Strings. Reads written ABOVE this point keep the undecided Type,
// which is sound — the value they read is genuinely empty — while a Function
// literal that captured it is not, and `enrichIdentifier` refuses that.
//
// Two Handlers of a Match assigning different item Types therefore leave the
// second one mismatched rather than widening to a Union: the declaration is
// where a name that holds both belongs, and an annotation there says so.
function narrowUnknownSlots(
	name: string,
	declaringScope: enricher.Scope | null,
	valueType: common.Type,
): void {
	// NOTE: A Constant's reassignment was reported already, and letting the
	// statement that was refused decide the Type every accepted one is judged
	// against would make the refusal change the Program.
	if (declaringScope === null || declaringScope.constants.has(name)) {
		return
	}

	let storedType = declaringScope.members[name]
	let narrowed = resolveUnknownSlots(storedType, valueType)

	if (narrowed !== storedType) {
		declaringScope.members[name] = narrowed
	}
}

export function enrichNamespaceDefinitionStatement(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.NamespaceType,
): common.typed.NamespaceDefinitionStatementNode {
	// NOTE: The Namespace's own block. Its Methods and Properties each check
	// their own, so this is only about a `@param` written above `namespace`.
	reportUnknownDocumentationParameters(node.documentation, [])

	function enrichProperties(
		properties: Record<string, parser.NamespacePropertyNode>,
		namespaceType: common.NamespaceType,
		scope: enricher.Scope,
	): Record<string, common.typed.NamespaceProperty> {
		let result: Record<string, common.typed.NamespaceProperty> = {}

		// NOTE: The Namespace as its own static Properties see it, seeded the
		// way the resolution pass seeded it — every native bound, every bodied
		// Property Error until its value has been enriched here — so a value
		// enriched in this pass is typed exactly as the one that pass read the
		// Namespace Type off was. The Methods are the finished ones either way.
		let boundProperties = scopeMap<common.Type>()

		for (let [propertyKey, propertyValue] of Object.entries(properties)) {
			boundProperties[propertyKey] =
				propertyValue.value === null
					? namespaceType.properties[propertyKey]
					: { type: "Error" }
		}

		let selfScope = scopeWithNamespaceSelf(
			node,
			{ ...namespaceType, properties: boundProperties },
			scope,
		)

		for (let [propertyKey, propertyValue] of Object.entries(properties)) {
			// NOTE: A native static Property has no value to enrich, so there
			// is nothing for a typed Node to hold — it is in the Namespace
			// Type (that is what resolution reads) but not in the typed tree
			// the Rewriter emits from, exactly like a native Method.
			if (propertyValue.value === null) {
				continue
			}

			reportUnknownDocumentationOfValue(
				propertyValue.documentation,
				propertyValue.value,
			)

			let type: common.Type
			let value: common.typed.ExpressionNode = enrichExpression(
				propertyValue.value,
				selfScope,
			)

			if (propertyValue.type === null) {
				type = value.type
			} else {
				type = resolveType(propertyValue.type, scope)
			}

			result[propertyKey] = {
				// NOTE: As with a Method, the name is a typed Identifier of
				// its own so that the cursor can land on it.
				name: {
					nodeType: "Identifier",
					content: propertyKey,
					position: propertyValue.name.position,
					type,
				},
				type,
				value,
				documentation: propertyValue.documentation,
			}

			boundProperties[propertyKey] = type
		}

		return result
	}

	// NOTE: When hoisted, the Namespace Type is reused from the hoist pass —
	// resolving it re-enriches every property value, so skipping that here is
	// the win. A non-hoisted Namespace (nested, or one that could not hoist)
	// still resolves in place.
	let type =
		hoistedType ?? resolveNamespaceDefinitionStatementType(node, scope)

	if (hoistedType === undefined) {
		declareVariableInScope(node.name, type, scope, true)
	}

	let checkedConformances = checkProtocolConformance(node, type, scope)

	// NOTE: The mirror of `infer-on-applied-parameter`: a Namespace is the one
	// declaration whose Type Parameters have nothing BUT a use to work them out
	// from — every receiver hands the Arguments over, and the marker is what says
	// so. Written without it the Parameter is opaque and can never bind, so the
	// target Type matches no receiver at all and the Namespace is simply never
	// found: `namespace Maybe<T> for Maybe<T> is Equatable` was passed over in
	// silence and a generic Choice's DERIVED equality answered `is` instead,
	// contradicting the Methods right there in the file. Refused rather than
	// quietly re-read as `infer`, so the two spellings never mean the same thing.
	for (let generic of node.generics) {
		if (!generic.inferred) {
			reportError(
				"A Namespace's Type Parameters must be inferred",
				generic.position,
				{
					code: "uninferred-namespace-parameter",
					labels: [
						primary(
							generic.position,
							"nothing can ever bind this Parameter",
						),
					],
					notes: [
						"A Namespace's Type Parameters are worked out from the receiver at every call, which is what 'infer' says.",
					],
					helps: [`Declare it as 'infer ${generic.name.content}'.`],
				},
			)
		}
	}

	// NOTE: A bound on a Namespace's own Type Parameter is still rejected — a
	// conditional conformance (`is Comparable where Item is Comparable`) is
	// where a Namespace-level bound belongs, so its conformance parameter can
	// be threaded into exactly the fulfilling Methods rather than all of them.
	for (let generic of node.generics) {
		if (generic.constraint !== null) {
			reportError(
				"A Namespace's Type Parameters can not carry Protocol bounds",
				generic.constraint.position,
				{
					code: "protocol-bound-namespace-generic",
					labels: [
						primary(
							generic.constraint.position,
							"this bound is not supported here",
						),
					],
					helps: [
						`Bound it per conformance: 'is ${generic.constraint.content} where ${generic.name.content} is ${generic.constraint.content}'.`,
					],
				},
			)
		}
	}

	// NOTE: Idempotent, and run a second time on purpose: the hoist already wove
	// these bounds into the Namespace Type so that use sites ABOVE this
	// Statement see the same Type the ones below it do. What is only available
	// here is the typed half — the Generic Declarations the Rewriter emits the
	// hidden conformance Parameters from.
	let injectedGenerics = weaveMethodBounds(
		node,
		type,
		checkedConformances,
		scope,
		true,
	)

	// NOTE: Namespace Generics are visible in every Method — bodies reference
	// them as opaque GenericUses.
	let methodScope = scopeWithGenerics(node.generics, scope)

	return {
		nodeType: "NamespaceDefinitionStatement",
		targetType: type.targetType,
		generics: node.generics.map((generic) =>
			enrichGenericDeclarationNode(generic, scope),
		),
		conformsTo: node.conformsTo.map((clause) => ({
			name: clause.protocol.content,
			position: clause.protocol.position,
			conditions: clause.conditions.map((condition) => ({
				generic: condition.generic.content,
				genericPosition: condition.generic.position,
				protocol: condition.protocol.content,
				protocolPosition: condition.protocol.position,
			})),
		})),
		name: enrichIdentifier(node.name, scope),
		properties: enrichProperties(node.properties, type, scope),
		methods: enrichMethods(
			node.methods,
			methodScope,
			type.targetType,
			type.methods,
			injectedGenerics,
		),
		position: node.position,
		headPosition: headPositionOf(node.position, [
			node.name.position,
			...node.generics.map((generic) => generic.position),
			node.targetType?.position,
			// NOTE: A clause's Position covers its `where` conditions too.
			...node.conformsTo.map((clause) => clause.position),
		]),
		type,
		documentation: node.documentation,
	}
}

// NOTE: Threads each conditional conformance's bounds into the Methods that
// fulfil it, in place on the Namespace Type, and answers the Generic
// Declarations to inject into their typed Nodes. Run TWICE for every hoisted
// Namespace — once speculatively while it hoists, so a use site above the
// Statement solves against the bounded Type, and once from the Statement, which
// is the only pass with typed Nodes to inject into. Idempotent on the Type:
// `retainNamespaceBounds` retains and bounds the same set every time.
//
// `report` is off for the speculative pass: a Diagnostic during hoisting keeps
// the Namespace out of Scope entirely. The injected Declarations are built in
// the reporting pass alone — resolving a Generic's default Type can report as
// well, and they have nowhere to go until there are typed Nodes.
function weaveMethodBounds(
	node: parser.NamespaceDefinitionStatementNode,
	type: common.NamespaceType,
	checkedConformances: Array<CheckedConformance>,
	scope: enricher.Scope,
	report: boolean,
): Map<string, Array<Array<common.typed.GenericDeclarationNode>>> {
	// NOTE: Which Namespace Generic each fulfilling Method must treat as bound,
	// gathered from every conditional conformance clause. A Method fulfilling
	// two clauses that bound the same Generic to different Protocols is a
	// conflict — one hidden conformance Parameter can not be two things.
	let methodBounds = new Map<string, Map<string, string>>()

	for (let conformance of checkedConformances) {
		if (conformance.conditions.length === 0) {
			continue
		}

		// NOTE: The map's VALUES are the fulfilling Methods' emitted names; an
		// overloaded fulfiller carries a `__overload$N` suffix, stripped here
		// to recover the Namespace Method's own name.
		let fulfillingMethods = new Set(
			Object.values(conformance.methodMap).map((emittedName) =>
				emittedName.replace(/__overload\$\d+$/, ""),
			),
		)

		for (let methodName of fulfillingMethods) {
			let bounds = methodBounds.get(methodName)

			if (bounds === undefined) {
				bounds = new Map()
				methodBounds.set(methodName, bounds)
			}

			for (let condition of conformance.conditions) {
				let existing = bounds.get(condition.generic)

				if (existing !== undefined && existing !== condition.protocol) {
					if (report) {
						let clause = node.conformsTo.find(
							(candidate) =>
								candidate.protocol.content ===
								conformance.protocolName,
						)

						reportError(
							`Method '${methodName}' can not satisfy conflicting conformance conditions`,
							clause?.position ?? node.name.position,
							{
								code: "conflicting-where-condition",
								labels: [
									primary(
										clause?.position ?? node.name.position,
										`Method '${methodName}' would need both '${condition.generic} is ${existing}' and '${condition.generic} is ${condition.protocol}'`,
									),
								],
							},
						)
					}

					continue
				}

				bounds.set(condition.generic, condition.protocol)
			}
		}
	}

	// NOTE: The constrained Namespace Generics to weave into each fulfilling
	// Method, as typed Generic Declarations, ONE LIST PER OVERLOAD (a
	// non-overloaded Method has exactly one). They lead the Method's own
	// Generics so `simplifyFunctionDefinition` emits their hidden conformance
	// Parameters first, in Namespace declaration order.
	//
	// INVARIANT (the three views of a Method's Type Parameters must agree, per
	// Overload): the resolved Method Type, the typed Node the Rewriter emits
	// from, and the witnesses `$type.boundConformance` curries onto a
	// conformance value are all derived from ONE retained list. A Namespace
	// Generic is retained on an Overload when its signature mentions it OR when
	// a conditional conformance this Method fulfils bounds it — the latter is
	// what makes the hidden conformance Parameter honest, because
	// `boundConformance` curries a witness for every `where` condition onto
	// EVERY fulfilling Method uniformly, whatever each Overload happens to
	// mention. Pruning a bound Generic from one Overload would leave that
	// Overload's emitted signature and its call sites disagreeing about how
	// many hidden Arguments there are.
	//
	// NOTE: A NATIVE Method has only TWO of those three views — there is no
	// typed Node, because there is no body to emit. The retention below still
	// runs over it (it is keyed off the parser Node, which exists either way),
	// so its resolved Method Type carries the bound Namespace Generics exactly
	// as a bodied one does; the typed-Node half is simply absent, and
	// `enrichMethods` drops the corresponding injected list on the floor. That
	// is the whole difference: the Type view and the witness view still agree,
	// which is what call sites and `boundConformance` read.
	let injectedGenerics = new Map<
		string,
		Array<Array<common.typed.GenericDeclarationNode>>
	>()

	for (let [methodName, bounds] of methodBounds) {
		let methodNode = node.methods[methodName]
		let methodType = type.methods[methodName]

		if (methodNode === undefined || methodType === undefined) {
			continue
		}

		// NOTE: The Generics each form declares for itself, per Overload — what
		// tells a retained Namespace Generic apart from a Method Generic that
		// shadows its name, which no amount of inspecting the merged list can.
		let ownGenerics = ownGenericNames(methodNode)

		// NOTE: Force the bound Namespace Generics back onto every Overload the
		// signature-driven merge pruned them from, and retrofit the bound onto
		// the entries that survived — on fresh Generic objects, so the shared
		// unbounded Namespace Generics (and every other Method) stay untouched.
		// Idempotent: re-running retains and bounds exactly the same set.
		methodType = retainNamespaceBounds(
			methodType,
			ownGenerics,
			bounds,
			type.generics,
		)

		type.methods[methodName] = methodType

		if (!report) {
			continue
		}

		// NOTE: The typed Node's Generics are READ BACK OFF the retained Type,
		// per Overload, rather than derived a second way — that is what keeps
		// the two views in step by construction.
		let retained =
			methodType.type === "SimpleMethod" ||
			methodType.type === "StaticMethod"
				? [methodType.generics]
				: methodType.overloads.map((overload) => overload.generics)

		let injected = retained.map((generics, index) =>
			node.generics
				.filter(
					(generic) =>
						bounds.has(generic.name.content) &&
						!(ownGenerics[index] ?? new Set()).has(
							generic.name.content,
						) &&
						generics.some(
							(candidate) =>
								candidate.name === generic.name.content,
						),
				)
				.map(
					(generic): common.typed.GenericDeclarationNode => ({
						nodeType: "GenericDeclaration",
						name: generic.name.content,
						inferred: generic.inferred,
						defaultType: generic.defaultType
							? resolveType(generic.defaultType, scope)
							: null,
						constraint: bounds.get(generic.name.content)!,
						position: generic.position,
					}),
				),
		)

		if (injected.some((list) => list.length > 0)) {
			injectedGenerics.set(methodName, injected)
		}
	}

	return injectedGenerics
}

// NOTE: The Type Parameter names each form of a Namespace Method declares for
// ITSELF, one Set per Overload. A Method Generic shadows a Namespace Generic of
// the same name, and once the two are merged into one list the entry no longer
// says which it came from — this is what remembers.
function ownGenericNames(
	method: parser.NamespaceMethods[string],
): Array<Set<string>> {
	let namesOf = (generics: Array<parser.GenericDeclarationNode>) =>
		new Set(generics.map((generic) => generic.name.content))

	if (
		method.nodeType === "SimpleMethod" ||
		method.nodeType === "StaticMethod"
	) {
		return [namesOf(method.method.value.generics)]
	}

	if (
		method.nodeType === "SimpleMethodSignature" ||
		method.nodeType === "StaticMethodSignature"
	) {
		return [namesOf(method.signature.generics)]
	}

	return method.methods.map((overload) =>
		namesOf(
			overload.nodeType === "NativeMethodSignature"
				? overload.generics
				: overload.value.generics,
		),
	)
}

// NOTE: Returns a copy of a Method Type whose every Overload carries the bound
// Namespace Generics — re-adding the ones the signature-driven merge pruned
// because that Overload's signature never mentions them, and retrofitting the
// bound onto the ones that survived. A conditional conformance's witnesses are
// curried onto every fulfilling Method uniformly, so an Overload that drops one
// would emit a signature its call sites do not agree with; retaining them is
// what keeps the arity honest (and, as at HEAD, is what makes an unbindable
// Type Parameter the reportable error it should be).
// Fresh Generic objects throughout, so the shared unbounded Namespace Generics
// are never mutated. Idempotent: re-running retains and bounds the same set.
function retainNamespaceBounds(
	method: common.MethodType,
	ownGenerics: Array<Set<string>>,
	bounds: Map<string, string>,
	namespaceGenerics: Array<common.GenericDeclaration>,
): common.MethodType {
	let apply = (
		generics: Array<common.GenericDeclaration>,
		own: Set<string>,
	): Array<common.GenericDeclaration> => {
		let leading: Array<common.GenericDeclaration> = []

		for (let namespaceGeneric of namespaceGenerics) {
			// NOTE: A Method Generic of the same name shadows this one
			// outright — it is the Method's entry that is in the list, and
			// re-adding would duplicate the name.
			if (own.has(namespaceGeneric.name)) {
				continue
			}

			let existing = generics.find(
				(generic) => generic.name === namespaceGeneric.name,
			)
			let constraint = bounds.get(namespaceGeneric.name)

			if (existing === undefined && constraint === undefined) {
				continue
			}

			let base = existing ?? namespaceGeneric

			leading.push(
				constraint === undefined ? base : { ...base, constraint },
			)
		}

		return [
			...leading,
			...generics.filter((generic) => own.has(generic.name)),
		]
	}

	if (method.type === "SimpleMethod" || method.type === "StaticMethod") {
		return {
			...method,
			generics: apply(method.generics, ownGenerics[0] ?? new Set()),
		}
	}

	return {
		...method,
		overloads: method.overloads.map((overload, index) => ({
			...overload,
			generics: apply(overload.generics, ownGenerics[index] ?? new Set()),
		})),
	}
}

export function enrichProtocolDeclarationStatement(
	node: parser.ProtocolDeclarationStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.ProtocolType,
): common.typed.ProtocolDeclarationStatementNode {
	// NOTE: The Protocol's own block. Each Method signature it holds checks
	// its own as its Parameter Types are resolved.
	reportUnknownDocumentationParameters(node.documentation, [])

	let protocolType =
		hoistedType ?? resolveProtocolDeclarationStatementType(node, scope)

	if (hoistedType === undefined) {
		declareProtocolInScope(node.name, protocolType, scope)
	}

	return {
		nodeType: "ProtocolDeclarationStatement",
		// NOTE: A Protocol is not a Type, so its name carries no Type of its
		// own — Unknown, rather than misleadingly borrowing one.
		name: enrichIdentifier(node.name, scope, { type: "Unknown" }),
		protocolType,
		position: node.position,
		headPosition: headPositionOf(node.position, [node.name.position]),
		documentation: node.documentation,
	}
}

// NOTE: `infer` marks a Type Parameter a USE works out for itself, from the
// Arguments it hands over — a call's, a Method's receiver's. A Choice and a Type
// Alias have no such use: every one of theirs APPLIES its Arguments outright, in
// a Type position or at a construction, so there is nothing for the marker to
// mean and it was accepted and ignored. Ignored, it read as a promise that some
// use site would work the Argument out, and the one thing that came close — a
// construction reading its Type Arguments off its payload — is exactly what
// `undecided-type-arguments` replaced.
//
// Reported here rather than at the Parser, because the Generic list is the same
// grammar a Function, a Method and a Namespace write, where `infer` is the whole
// point. It is reported in the enrichment pass rather than while the Type
// resolves, so a Choice that only wrote the marker wrongly still hoists and
// everything that names it stays about itself.
function reportInferredTypeParameters(
	generics: Array<parser.GenericDeclarationNode>,
	declaration: "Choice" | "Type Alias",
): void {
	for (let generic of generics) {
		if (!generic.inferred) {
			continue
		}

		reportError(
			`A ${declaration}'s Type Parameters can not be inferred`,
			generic.position,
			{
				code: "infer-on-applied-parameter",
				labels: [
					primary(generic.position, "'infer' has nothing to do here"),
				],
				notes: [
					`A ${declaration}'s Type Parameters are applied at every use, never inferred from one.`,
				],
				helps: [`Remove the 'infer' before '${generic.name.content}'.`],
			},
		)
	}
}

export function enrichTypeAliasStatement(
	node: parser.TypeAliasStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.Type,
): common.typed.TypeAliasStatementNode {
	reportUnknownDocumentationParameters(node.documentation, [])
	reportInferredTypeParameters(node.generics, "Type Alias")

	let type = hoistedType ?? resolveTypeAliasStatementType(node, scope)

	if (hoistedType === undefined) {
		declareTypeInScope(node.name, type, scope)
	}

	return {
		nodeType: "TypeAliasStatement",
		name: enrichIdentifier(node.name, scope, type),
		generics: node.generics.map((generic) =>
			enrichGenericDeclarationNode(generic, scope),
		),
		type,
		predicate:
			node.predicate === null
				? null
				: enrichAliasPredicate(node, node.predicate, type, scope),
		position: node.position,
		documentation: node.documentation,
	}
}

// NOTE: The typed predicate the Node carries, for the Language Server alone —
// the Type above already holds the conjunct keys the Compiler compares, and the
// clause was resolved to reach them.
//
// Its Diagnostics are DROPPED, which is the whole reason this is a function of
// its own. Whatever the clause has to be told was told: either hoisting resolved
// it cleanly, in which case a second reading finds nothing, or it did not, in
// which case the line above resolved it in place and reported. Re-reporting here
// would say it twice for every refined Alias in the Program.
//
// NOTE: A GENERIC refined Alias is a Generic Alias wrapping the refinement, so
// `@` is bound to the base one level further in — and in the Alias' own generic
// Scope, the way the resolution that read the predicate bound it. Reading it
// against the wrapper instead left `@` typed as a Type that takes Arguments, and
// the Language Server got an Error where the Compiler had a Boolean.
function enrichAliasPredicate(
	node: parser.TypeAliasStatementNode,
	predicate: parser.ExpressionNode,
	type: common.Type,
	scope: enricher.Scope,
): common.typed.ExpressionNode {
	let refined =
		type.type === "GenericAlias" && type.aliasedType.type === "Refinement"
			? type.aliasedType
			: type

	return collectDiagnostics(() =>
		enrichExpression(
			predicate,
			scopeWithRefinedSelf(
				refined.type === "Refinement" ? refined.base : refined,
				refinementPredicateScope(node, scope),
			),
		),
	).result
}

export function enrichChoiceDeclarationStatement(
	node: parser.ChoiceDeclarationStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.UnionType | common.GenericAliasType,
): common.typed.ChoiceDeclarationStatementNode {
	reportUnknownDocumentationParameters(node.documentation, [])
	reportInferredTypeParameters(node.generics, "Choice")

	let type = hoistedType ?? resolveChoiceDeclarationStatementType(node, scope)

	if (hoistedType === undefined) {
		declareTypeInScope(node.name, type, scope)
	}

	// NOTE: A generic Choice resolves to a Generic Alias over the anonymous
	// Union of its Cases — the Cases to describe are that body Union's members.
	let bodyUnion = type.type === "GenericAlias" ? type.aliasedType : type
	let caseTypes =
		bodyUnion.type === "UnionType"
			? bodyUnion.types.filter(
					(member): member is common.CaseType =>
						member.type === "Case",
				)
			: []
	let isUnitChoice =
		caseTypes.length > 0 &&
		caseTypes.every((member) => member.unitChoice === true)

	return {
		nodeType: "ChoiceDeclarationStatement",
		name: enrichIdentifier(node.name, scope, type),
		generics: node.generics.map((generic) =>
			enrichGenericDeclarationNode(generic, scope),
		),
		// NOTE: A duplicate Case was already diagnosed and dropped from the
		// Union — its name Identifier borrows the surviving Case's Type so the
		// typed tree stays complete.
		//
		// NOTE: The fallback stands for a Case of this same Choice, so it
		// carries what the Choice was stamped with: where every Case that DID
		// survive is payload-less, so is the one being stood in for, and a
		// hovering reader gets the same Type either way.
		cases: node.cases.map((choiceCase) => {
			let caseType = caseTypes.find(
				(candidate) => candidate.name === choiceCase.name.content,
			) ?? {
				type: "Case" as const,
				choice: choiceIdentity(modulePathOf(scope), node.name.content),
				name: choiceCase.name.content,
				members: {},
				...(isUnitChoice ? { unitChoice: true as const } : {}),
			}

			return {
				name: {
					nodeType: "Identifier" as const,
					content: choiceCase.name.content,
					position: choiceCase.name.position,
					type: caseType,
				},
				type: caseType,
			}
		}),
		type,
		position: node.position,
		headPosition: headPositionOf(node.position, [
			node.name.position,
			...node.generics.map((generic) => generic.position),
		]),
		documentation: node.documentation,
	}
}

// NOTE: The condition is enriched BEFORE the branch Scopes exist, which is the
// whole reason this reads the way it does: what a branch narrows is read off the
// TYPED condition — which Namespace answered each question, which Overload of it,
// and what the receiver's Type was where it was asked — and none of that is
// knowable from the Node the Parser produced.
export function enrichIfElseStatementNode(
	node: parser.IfElseStatementNode,
	scope: enricher.Scope,
): common.typed.IfElseStatementNode {
	let condition = enrichExpression(node.condition, scope)
	let trueScope = trueBranchScope(condition, scope)
	let falseScope = falseBranchScope(condition, scope)

	return {
		nodeType: "IfElseStatement",
		condition,
		trueBody: node.trueBody.flatMap((node) => enrichNode(node, trueScope)),
		falseBody: node.falseBody.flatMap((node) =>
			enrichNode(node, falseScope),
		),
		position: node.position,
	}
}

export function enrichIfStatement(
	node: parser.IfStatementNode,
	scope: enricher.Scope,
): common.typed.IfStatementNode {
	let condition = enrichExpression(node.condition, scope)
	let bodyScope = trueBranchScope(condition, scope)

	return {
		nodeType: "IfStatement",
		condition,
		body: node.body.flatMap((node) => enrichNode(node, bodyScope)),
		position: node.position,
	}
}

export function enrichReturnStatement(
	node: parser.ReturnStatementNode,
	scope: enricher.Scope,
): common.typed.ReturnStatementNode {
	return {
		nodeType: "ReturnStatement",
		// NOTE: The nearest declared return Type is the expected Type — the
		// enclosing Function's, or the Match's for a Handler body.
		expression: enrichExpression(
			node.expression,
			scope,
			findExpectedReturnType(scope),
		),
		position: node.position,
	}
}

// NOTE: The nearest Scope that has an answer, which a Scope carrying the
// barrier `null` is — a `<-` inside a Function whose own return Type is still
// being worked out has no expected Type, and the enclosing Function's is not it.
function findExpectedReturnType(scope: enricher.Scope): common.Type | null {
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		if (searchScope.expectedReturnType !== undefined) {
			return searchScope.expectedReturnType
		}

		searchScope = searchScope.parent
	}

	return null
}

export function enrichFunctionStatement(
	node: parser.FunctionStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.FunctionType,
): common.typed.FunctionStatementNode {
	let type = hoistedType ?? resolveFunctionSignatureType(node.value, scope)

	if (hoistedType === undefined) {
		declareVariableInScope(node.name, type, scope, true)
	}

	return {
		nodeType: "FunctionStatement",
		name: enrichIdentifier(node.name, scope, type),
		value: enrichFunctionDefinition(node.value, scope),
		position: node.position,
		headPosition: headPositionOf(node.position, [
			node.name.position,
			...node.value.generics.map((generic) => generic.position),
			node.value.parameterListPosition,
			node.value.returnType?.position,
		]),
		type,
	}
}

// NOTE: A bodied entry inside an `overload function` block becomes its own
// top-level Function, exactly as a bodied `overload` Method becomes one of a
// Namespace's — the two forms never fork. Only the BODIED entries reach the
// typed tree; a native entry has no body to emit and survives only in the
// hoisted `OverloadedStaticMethod` Type, the Rewriter reaching it through the
// runtime bindings instead. Each survivor is named for its ORIGINAL position in
// that Type's `overloads` — `loop__overload$N` — so a native sitting between two
// bodied entries keeps its slot and the emitted name is the one every call site
// resolves to; naming it by its position among only the bodied entries would
// define a name nobody calls and clobber the native export that owns the real
// one. Unlike a source `function`, that name is a synthetic emit target: it is
// baked into the Node here rather than mangled by the Simplifier (a free
// `FunctionStatement` passes its name through verbatim), and it is never declared
// into Scope — the block's base name is already the hoisted member.
export function enrichOverloadedFunctionStatement(
	node: parser.OverloadedFunctionStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.Type | common.ProtocolType,
): Array<common.typed.FunctionStatementNode> {
	let overloadedType =
		hoistedType !== undefined &&
		hoistedType.type === "OverloadedStaticMethod"
			? hoistedType
			: resolveOverloadedFunctionStatementType(node, scope)

	let statements: Array<common.typed.FunctionStatementNode> = []

	for (let [index, entry] of node.methods.entries()) {
		if (entry.nodeType === "NativeMethodSignature") {
			continue
		}

		// NOTE: The per-entry Function Type is exactly what the call site
		// resolves against — the hoisted `overloads[index]` lifted to a
		// `Function` Type.
		let type: common.FunctionType = {
			type: "Function",
			...overloadedType.overloads[index]!,
		}

		statements.push({
			nodeType: "FunctionStatement",
			name: {
				nodeType: "Identifier",
				content: resolveOverloadedMethodName(node.name.content, index),
				position: entry.position,
				type,
			},
			value: enrichFunctionDefinition(entry.value, scope),
			position: entry.position,
			headPosition: headPositionOf(entry.position, [
				...entry.value.generics.map((generic) => generic.position),
				entry.value.parameterListPosition,
				entry.value.returnType?.position,
			]),
			type,
		})
	}

	return statements
}

// #endregion

// #region Helpers

// NOTE: A name declared by the Compiler rather than in Essence — `@`, the
// builtins — is passed as a bare string and has no Position to point at. The
// Diagnostic is still worth reporting; it just has nothing to underline.
function reportDuplicateDeclaration(
	identifier: parser.IdentifierNode | string,
	name: string,
	firstDeclarationPosition: common.Position | null,
	code: common.DiagnosticCode,
	kind: string,
): void {
	let message = `${kind} '${name}' is already declared`

	if (typeof identifier === "string") {
		reportError(message, null, { code, labels: [] })

		return
	}

	reportError(message, identifier.position, {
		code,
		labels: [
			primary(identifier.position, "declared a second time here"),
			...(firstDeclarationPosition === null
				? []
				: [secondary(firstDeclarationPosition, "first declared here")]),
		],
	})
}

function declareVariableInScope(
	identifier: parser.IdentifierNode | string,
	type: common.Type,
	scope: enricher.Scope,
	isConstant = false,
): enricher.Scope {
	const variableName =
		typeof identifier === "string" ? identifier : identifier.content

	if (scope.members[variableName] != null) {
		reportDuplicateDeclaration(
			identifier,
			variableName,
			scope.declarations[variableName] ?? null,
			"duplicate-variable",
			"Variable",
		)
	}

	scope.members[variableName] = type

	invalidateNamespacesInScope(scope, variableName, type)

	if (typeof identifier !== "string") {
		scope.declarations[variableName] = identifier.position
	}

	if (isConstant) {
		scope.constants.add(variableName)
	} else {
		scope.constants.delete(variableName)
	}

	return scope
}

function findDeclaringScope(
	name: string,
	scope: enricher.Scope,
): enricher.Scope | null {
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		if (searchScope.members[name] != null) {
			return searchScope
		}

		searchScope = searchScope.parent
	}

	return null
}

// NOTE: Where the name a use refers to was declared, or null when it was
// declared by the Compiler rather than in this file. What lets a Diagnostic
// about a use point back at the declaration that constrains it.
export function findDeclarationPosition(
	name: string,
	scope: enricher.Scope,
): common.Position | null {
	return findDeclaringScope(name, scope)?.declarations[name] ?? null
}

function declareTypeInScope(
	identifier: parser.IdentifierNode | string,
	type: common.Type,
	scope: enricher.Scope,
): enricher.Scope {
	const variableName =
		typeof identifier === "string" ? identifier : identifier.content

	if (variableName === "Self") {
		reportReservedTypeName(
			typeof identifier === "string" ? null : identifier.position,
		)
	} else if (scope.types[variableName] != null) {
		reportDuplicateDeclaration(
			identifier,
			variableName,
			null,
			"duplicate-type",
			"Type",
		)
	}

	scope.types[variableName] = type

	return scope
}

function declareProtocolInScope(
	identifier: parser.IdentifierNode,
	protocolType: common.ProtocolType,
	scope: enricher.Scope,
): enricher.Scope {
	if (scope.protocols[identifier.content] != null) {
		reportDuplicateDeclaration(
			identifier,
			identifier.content,
			null,
			"duplicate-protocol",
			"Protocol",
		)
	}

	scope.protocols[identifier.content] = protocolType

	return scope
}

function enrichMembers(
	members: Record<string, parser.RecordValueMemberNode>,
	scope: enricher.Scope,
	expectedMemberTypes: Record<string, common.Type> | null = null,
): Record<string, common.typed.ExpressionNode> {
	let result: Record<string, common.typed.ExpressionNode> = {}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		result[memberKey] = enrichExpression(
			memberValue.value,
			scope,
			expectedMemberTypes?.[memberKey] ?? null,
		)
	}

	return result
}

// NOTE: What the item position of an expected Type wants, for the Expressions
// that react to one. A Union spells its members out — `List<Box<Integer>> |
// String` still wants a Box in its items — and several Lists in one Union offer
// the Union of their item Types, which is what a single item may be any of. `null`
// where nothing there is a List at all, which is what "no expected Type" means to
// everything downstream.
function expectedListItemType(
	expectedType: common.Type | null,
): common.Type | null {
	if (expectedType === null) {
		return null
	}

	let itemTypes = unionArmsOf(expectedType).flatMap((member) =>
		member.type === "List" ? [member.itemType] : [],
	)

	return itemTypes.length === 0 ? null : buildUnion(itemTypes)
}

// NOTE: The same for a Record's members, keyed by name — a member missing from
// one arm of a Union simply is not offered by it, and one offered by several is
// their Union, as at an item position.
function expectedRecordMembers(
	expectedType: common.Type | null,
): Record<string, common.Type> | null {
	if (expectedType === null) {
		return null
	}

	let records = unionArmsOf(expectedType).flatMap((member) =>
		member.type === "Record" ? [member] : [],
	)

	if (records.length === 0) {
		return null
	}

	// NOTE: A null prototype, because the keys are the SOURCE's member names — a
	// member called 'toString' would otherwise find Object.prototype's function
	// where the `??=` expects a missing entry.
	let members: Record<string, Array<common.Type>> = Object.create(null)

	for (let record of records) {
		for (let [name, type] of Object.entries(record.members)) {
			;(members[name] ??= []).push(type)
		}
	}

	return Object.fromEntries(
		Object.entries(members).map(([name, types]) => [
			name,
			buildUnion(types),
		]),
	)
}

function enrichMethods(
	members: parser.NamespaceMethods,
	scope: enricher.Scope,
	selfType: common.Type | null,
	methodTypes: Record<string, common.MethodType>,
	// NOTE: The constrained Namespace Generics to weave into each conditional
	// conformance's fulfilling Methods, one list per Overload — empty for every
	// other Method.
	injectedGenerics: Map<
		string,
		Array<Array<common.typed.GenericDeclarationNode>>
	> = new Map(),
): common.typed.Methods {
	let result: common.typed.Methods = {}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		// NOTE: A native Method has no body, so there is nothing to enrich and
		// nothing for the Rewriter to emit — the runtime already implements
		// it. It stays in the Namespace Type (which is what resolution,
		// Completion and Hover read) and is simply absent here.
		if (
			memberValue.nodeType === "SimpleMethodSignature" ||
			memberValue.nodeType === "StaticMethodSignature"
		) {
			continue
		}

		// NOTE: The name is typed as the Method itself, so that whatever
		// resolves a Type at the cursor describes the Method when the cursor
		// is on its name.
		let name: common.typed.IdentifierNode = {
			nodeType: "Identifier",
			content: memberKey,
			position: memberValue.name.position,
			type: methodTypes[memberKey] ?? { type: "Unknown" },
		}

		let injected = injectedGenerics.get(memberKey) ?? []

		if (memberValue.nodeType === "SimpleMethod") {
			result[memberKey] = {
				nodeType: "SimpleMethod",
				name,
				method: enrichMethodFunctionValue(
					memberValue,
					scope,
					selfType,
					injected[0] ?? [],
				),
			}
		} else if (memberValue.nodeType === "StaticMethod") {
			result[memberKey] = {
				nodeType: "StaticMethod",
				name,
				method: enrichMethodFunctionValue(
					memberValue,
					scope,
					selfType,
					injected[0] ?? [],
				),
			}
		} else if (memberValue.nodeType === "OverloadedMethod") {
			result[memberKey] = {
				nodeType: "OverloadedMethod",
				name,
				methods: enrichMethodsFunctionValue(
					memberValue,
					scope,
					selfType,
					injected,
				),
				// NOTE: Every Overload is bodied here, so the Node's order and
				// the Type's are the identity.
				overloadIndices: memberValue.methods.map((_, index) => index),
			}
		} else if (memberValue.nodeType === "OverloadedStaticMethod") {
			result[memberKey] = {
				nodeType: "OverloadedStaticMethod",
				name,
				methods: enrichMethodsFunctionValue(
					memberValue,
					scope,
					selfType,
					injected,
				),
				overloadIndices: memberValue.methods.map((_, index) => index),
			}
		} else {
			// NOTE: An Overload block in a `declarations { … }` Program may MIX
			// bodied and native entries. Only the bodied ones have anything to
			// emit, so only they reach the typed Node — together with the
			// Generics that were woven into THEIR entry of the resolved Type,
			// picked out by the original Overload index so the two views stay
			// aligned even when a native sits between them.
			// NOTE: Each survivor's ORIGINAL index travels with it in
			// `overloadIndices`. That index — its position in the Method
			// Type's `overloads`, not in this filtered list — is what the
			// `__overload$N` name is built from, both where a call site
			// resolves it and where the Simplifier emits the definition. A
			// native occupies its slot in that numbering even though nothing
			// is emitted for it, because the runtime export it binds to
			// already answers to that name.
			let bodied: Array<parser.FunctionValueNode> = []
			let bodiedIndices: Array<number> = []
			let bodiedInjected: Array<
				Array<common.typed.GenericDeclarationNode>
			> = []

			for (let [index, overload] of memberValue.methods.entries()) {
				if (overload.nodeType === "NativeMethodSignature") {
					continue
				}

				bodied.push(overload)
				bodiedIndices.push(index)
				bodiedInjected.push(injected[index] ?? [])
			}

			if (bodied.length === 0) {
				continue
			}

			let nodeType =
				memberValue.nodeType === "OverloadedMethodSignatures"
					? ("OverloadedMethod" as const)
					: ("OverloadedStaticMethod" as const)

			result[memberKey] = {
				nodeType,
				name,
				methods: enrichMethodsFunctionValue(
					{
						nodeType,
						name: memberValue.name,
						methods: bodied,
						documentation: memberValue.documentation,
					},
					scope,
					selfType,
					bodiedInjected,
				),
				overloadIndices: bodiedIndices,
			}
		}
	}

	return result
}

// NOTE: A Parameter list and the Statements its Patterns desugar into, which
// belong at the HEAD of the body those Parameters were declared for — the same
// shape a Matcher's bindings take, and for the same reason: a body that reads
// `width` reads a Constant an author could have written on its first line.
function enrichParameterList(
	nodes: Array<parser.ParameterNode>,
	scope: enricher.Scope,
	contextualParameters?: Array<common.Parameter | undefined>,
): {
	parameters: Array<common.typed.ParameterNode>
	bindings: Array<common.typed.ImplementationNode>
} {
	let parameters: Array<common.typed.ParameterNode> = []
	let bindings: Array<common.typed.ImplementationNode> = []
	// NOTE: Built once for the whole list rather than per Parameter — every
	// default is barred from the same set of names, and which of them are "still
	// to come" is a comparison against the index rather than a second walk. A
	// list with no default anywhere builds nothing at all.
	let barred = nodes.some((node) => node.defaultValue !== null)
		? barredParameterNames(nodes)
		: null

	for (let [index, node] of nodes.entries()) {
		let enriched = enrichParameter(
			node,
			scope,
			contextualParameters?.[index],
			barred === null ? null : { names: barred, index },
		)

		parameters.push(enriched.parameter)
		bindings.push(...enriched.bindings)
	}

	return { parameters, bindings }
}

// NOTE: Every name this Parameter list binds, with what a default written in it
// is allowed to make of each. A Parameter's own name is barred from its own
// default and from every default before it — it is not bound yet — and a Pattern
// binding is barred from all of them, since a Pattern desugars into Constants at
// the head of the BODY and the Parameter list is bound before the body's first
// Statement runs.
function barredParameterNames(
	nodes: Array<parser.ParameterNode>,
): Map<string, enricher.BarredParameterName> {
	let names = new Map<string, enricher.BarredParameterName>()

	for (let [index, node] of nodes.entries()) {
		let name = node.internalName

		if (name === null) {
			continue
		}

		if (name.nodeType === "Identifier") {
			names.set(name.content, {
				kind: "parameter",
				index,
				position: name.position,
			})

			continue
		}

		// NOTE: Exactly the bindings `declarePatternBindings` declares, asked
		// the same way — a name that is going to be in Scope for the body is a
		// name a default has to be told about.
		for (let binding of irrefutablePatternBindings(name)) {
			names.set(binding.name.content, {
				kind: "pattern",
				index,
				position: binding.name.position,
			})
		}
	}

	return names
}

function enrichParameter(
	node: parser.ParameterNode,
	scope: enricher.Scope,
	// NOTE: Set for an unannotated Parameter, whose Type and label both came
	// from the expected signature rather than from anything written here.
	contextualParameter?: common.Parameter,
	// NOTE: The names this Parameter list binds and which Parameter this one is,
	// so a default can be told what it may not read. Null for a list that
	// declares no default at all.
	barrier: enricher.Scope["parameterDefaultBarrier"] | null = null,
): {
	parameter: common.typed.ParameterNode
	bindings: Array<common.typed.ImplementationNode>
} {
	let type =
		contextualParameter?.type ??
		(node.type === null
			? { type: "Error" as const }
			: resolveType(node.type, scope))

	let defaultValue = enrichParameterDefault(node, type, scope, barrier)

	// NOTE: A Pattern where the internal name goes. The Parameter still needs a
	// name of its own — the desugared Constants read off it, and the Simplifier
	// would otherwise mint `_0` for it and collide with a sibling `_: Type` at
	// the same index — so one is synthesized from the Pattern's Position, which
	// no source could have written and which is the same on every pass.
	if (node.internalName?.nodeType === "Pattern") {
		let pattern = node.internalName
		let internalName = synthesizedName("parameter", pattern.position)

		refuseRefutablePattern(pattern, "Parameter")
		declareVariableInScope(internalName, type, scope, true)

		return {
			parameter: {
				nodeType: "Parameter",
				externalName: node.externalName
					? enrichIdentifier(node.externalName, scope, type)
					: null,
				internalName: {
					nodeType: "Identifier",
					content: internalName,
					position: pattern.position,
					type,
				},
				position: node.position,
				inferredType: node.type === null ? type : null,
				defaultValue,
			},
			bindings: declarePatternBindings(
				pattern,
				internalName,
				type,
				scope,
				true,
			),
		}
	}

	// NOTE: `_: Type` binds no name, so there is nothing to declare — leaving
	// it out of Scope is what makes the Parameter unreferenceable rather than
	// merely unused.
	if (node.internalName !== null) {
		declareVariableInScope(node.internalName, type, scope, true)
	}

	return {
		parameter: {
			nodeType: "Parameter",
			externalName: node.externalName
				? enrichIdentifier(node.externalName, scope, type)
				: null,
			internalName: node.internalName
				? enrichIdentifier(node.internalName, scope)
				: null,
			position: node.position,
			inferredType: node.type === null ? type : null,
			defaultValue,
		},
		bindings: [],
	}
}

// NOTE: The `= expression` a caller may leave out, enriched in the Parameter
// list's own Scope and BEFORE this Parameter is declared into it. That one
// ordering is most of the scoping rule: `@` is already bound — a Method's body
// Scope binds it before the Parameter list is walked, and a static Method sets
// the barrier that makes `@` there an `at-in-static-method` — and the Parameters
// to the left are declared.
//
// The rest of it is `parameterDefaultBarrier`, which is what an outer binding of
// the same name makes necessary: leaving this Parameter and the ones after it
// merely UNDECLARED would let a module Constant called `x` answer for the
// Parameter called `x`, and the emitted `(x = x)` would read the Parameter out
// of its own temporal dead zone instead.
//
// Evaluated per call in the callee's frame, never here: it is checked for its
// Type and lowered, and nothing about it is folded at the Declaration.
function enrichParameterDefault(
	node: parser.ParameterNode,
	type: common.Type,
	scope: enricher.Scope,
	barrier: enricher.Scope["parameterDefaultBarrier"] | null,
): common.typed.ExpressionNode | null {
	if (node.defaultValue === null) {
		return null
	}

	if (barrier !== null) {
		scope.parameterDefaultBarrier = barrier
	}

	let value = enrichExpression(node.defaultValue, scope, type)

	delete scope.parameterDefaultBarrier

	let valueType = value.type

	// NOTE: A default written down where a refinement stands is admitted by
	// deciding the predicate here, exactly as an Argument written down there is
	// — `1` really is a NonZeroInteger. The default IS the Argument a call that
	// omits it passes, so the two questions have to be the same one; asking
	// only about assignability would refuse the very literal every written call
	// is admitted by.
	if (
		type.type === "Refinement" &&
		admittedByEvaluation(
			refinementDecidedBy(type, valueType) ?? type,
			value,
		)
	) {
		return value
	}

	if (
		!typeContainsError(type) &&
		!typeContainsError(valueType) &&
		!matchesType(type, valueType)
	) {
		let name =
			parameterInternalName(node)?.content ??
			node.externalName?.content ??
			null

		reportError(
			name === null
				? "This default does not fit its Parameter"
				: `This default does not fit Parameter '${name}'`,
			node.defaultValue.position,
			{
				code: "default-type-mismatch",
				labels: [
					primary(
						node.defaultValue.position,
						`this is ${withArticle(describeType(valueType))}`,
					),
				],
				notes: [
					name === null
						? `The Parameter is ${describeType(type)}.`
						: `Parameter '${name}' is ${describeType(type)}.`,
				],
				helps: [`Write a value of Type ${describeType(type)}.`],
			},
		)
	}

	return value
}

// #endregion

// #region Flow Narrowing

// NOTE: What a condition PROVES about one binding at the point it was asked —
// the conjuncts spelled about it, and the Type the binding has there. The Type is
// read off the typed receiver rather than out of the Scope, because a branch may
// already have narrowed the name: an `else if` asks its question of a binding the
// `else` around it has shadowed, and the evidence that shadow carries counts
// towards what the next branch establishes.
type ProvenConjuncts = {
	receiverType: common.Type
	conjuncts: Array<common.PredicateConjunct>
}

// NOTE: Keyed by the name a shadow is declared under — an Identifier's own, or
// "@", which is the name a Match Handler's receiver is bound under too.
type ConditionEvidence = Map<string, ProvenConjuncts>

// NOTE: A binding and the refinement a branch has established for it.
type Narrowing = { name: string; type: common.RefinementType }

// NOTE: The Scope a true branch's body is enriched in — the surrounding one plus
// whatever the condition established, and a plain child Scope when it established
// nothing.
function trueBranchScope(
	condition: common.typed.ExpressionNode,
	scope: enricher.Scope,
): enricher.Scope {
	return childScope(
		scopeShadowing(
			narrowingsFor(
				conditionEvidence(condition, scope),
				scope,
				predicateConjunctKey,
			),
			scope,
		),
	)
}

// NOTE: And the Scope for the branch the condition answered `false` in. An
// `else if` needs nothing of its own here: the nested If lives in the `falseBody`
// Array and is enriched in this very Scope, so it asks its question of the
// complement and adds to it.
function falseBranchScope(
	condition: common.typed.ExpressionNode,
	scope: enricher.Scope,
): enricher.Scope {
	return childScope(
		scopeShadowing(
			narrowingsFor(
				complementEvidence(condition, scope),
				scope,
				predicateShapeKey,
			),
			scope,
		),
	)
}

// NOTE: The WRAPPER Scope a branch's shadows are declared in, or the Scope itself
// when there are none. It exists because a shadow is a declaration and the
// duplicate check is per-Scope: a body that legally re-declares the very name the
// condition narrowed — `if d::isNot(0) { constant d = 1 … }` — would otherwise be
// told the name is already declared, by a declaration nobody wrote and no
// Diagnostic can point at. The body's own Scope nests INSIDE this one, so its
// declarations shadow the shadows exactly as they shadow anything else.
function scopeShadowing(
	narrowings: Array<Narrowing>,
	scope: enricher.Scope,
): enricher.Scope {
	if (narrowings.length === 0) {
		return scope
	}

	let narrowScope = childScope(scope)

	for (let narrowing of narrowings) {
		declareVariableInScope(
			narrowing.name,
			narrowing.type,
			narrowScope,
			true,
		)
	}

	return narrowScope
}

// NOTE: The evidence a condition hands its true branch. A condition is read as a
// conjunction and flattened exactly as a `where` clause is — `d::isNot(0)` proves
// one thing about `d` and `d::isNot(0)::and(d::isLessThan(10))` proves two — and
// anything else contributes nothing at all.
//
// Nothing here reports. A `where` clause is a CLAIM, so a leaf it can not be
// compared by is a mistake worth naming; an `if` is a question, and a question
// that happens to prove nothing is an ordinary question.
function conditionEvidence(
	condition: common.typed.ExpressionNode,
	scope: enricher.Scope,
): ConditionEvidence {
	let evidence: ConditionEvidence = new Map()

	collectConditionEvidence(condition, scope, evidence)

	return evidence
}

function collectConditionEvidence(
	condition: common.typed.ExpressionNode,
	scope: enricher.Scope,
	evidence: ConditionEvidence,
): void {
	if (condition.nodeType !== "MethodInvocation") {
		return
	}

	if (isConjunction(condition)) {
		collectConditionEvidence(condition.base, scope, evidence)
		collectConditionEvidence(condition.arguments[0].value, scope, evidence)

		return
	}

	let name = narrowableReceiverName(condition.base, scope)

	if (name === null) {
		return
	}

	let args: Array<string | boolean> = []

	for (let argument of condition.arguments) {
		let literal = literalPredicateArgument(argument.value)

		if (literal === null) {
			return
		}

		args.push(literal)
	}

	let conjunct: common.PredicateConjunct = {
		namespaceName: condition.namespace.name,
		methodName: condition.member.name,
		overloadIndex: condition.overloadedMethodIndex,
		args,
	}

	let proven = evidence.get(name)

	if (proven === undefined) {
		evidence.set(name, {
			receiverType: condition.base.type,
			conjuncts: [conjunct],
		})
	} else {
		proven.conjuncts.push(conjunct)
	}
}

// NOTE: The name a condition's receiver may be narrowed under, or null when it
// may not be. A Constant and `@` are the only two, and the reason is
// reassignment: a Variable a branch has proven something about can be written to
// inside that very branch, and the evidence would then be about a value that is
// gone. Nothing carries a narrowing forwards through an assignment in v1, so a
// Variable simply never narrows.
//
// NOTE: A Match Handler's payload binding is a Constant like any other and
// narrows like one — but a GUARD reads it as `@.member` rather than under its
// name, because the Constant the body reads does not exist yet where a Guard runs
// (`scopeLendingBinding` says why). What the Program wrote is the name, and the
// name is what a shadow can be declared under, so a member read of a LENT name
// answers with it. `@.item` written out by hand answers the same, and says the
// same thing about the same value.
function narrowableReceiverName(
	base: common.typed.ExpressionNode,
	scope: enricher.Scope,
): string | null {
	if (base.nodeType === "Self") {
		return "@"
	}

	if (base.nodeType === "Lookup") {
		let path = selfLookupPath(base)

		return path === null ? null : lentBindingName(path, scope)
	}

	if (base.nodeType !== "Identifier") {
		return null
	}

	return findDeclaringScope(base.content, scope)?.constants.has(base.content)
		? base.content
		: null
}

// NOTE: The spine of member names a chain of Lookups reads off `@`, outermost
// step last — `@.state.total` gives `["state", "total"]`. Null where the chain
// does not bottom out in `@` at all.
function selfLookupPath(
	node: common.typed.ExpressionNode,
): Array<string> | null {
	if (node.nodeType === "Self") {
		return []
	}

	if (node.nodeType !== "Lookup") {
		return null
	}

	let prefix = selfLookupPath(node.base)

	return prefix === null ? null : [...prefix, node.member.content]
}

// NOTE: The name a member of `@` is LENT to in this Scope, or null where the
// member is nobody's name — an ordinary `@.x` on a Record scrutinee is a member of
// a value rather than a binding of its own, and nothing narrows it. Nearest Scope
// first, as every name search is, so the innermost Handler's binding answers for
// its own Guard.
//
// The walk stops at the Scope that BINDS the `@` being read, because nothing
// further out lends a member of it: a Handler nested inside a Guard has an `@` of
// its own, and the member names of two Cases can agree while their values have
// nothing to do with each other.
function lentBindingName(
	path: Array<string>,
	scope: enricher.Scope,
): string | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		for (let [name, alias] of Object.entries(
			current.selfMemberAliases ?? {},
		)) {
			// NOTE: The WHOLE spine, not its last step. A Pattern lends several
			// names off one `@`, and `@.x` must not answer with a nested
			// `origin.x` binding that happens to end in the same member.
			if (
				alias.path.length === path.length &&
				alias.path.every((step, index) => step === path[index])
			) {
				return name
			}
		}

		if (current.members["@"] != null) {
			return null
		}
	}

	return null
}

// NOTE: The refinements a branch's evidence establishes. A declared refinement is
// established for a binding when its base accepts the binding's Type and every
// conjunct it proves is one the branch has proven — set INCLUSION, so a
// two-conjunct condition establishes a one-conjunct refinement and never the
// other way round. Where several qualify, the one proving the MOST wins, because
// it is the one that forgets the least.
//
// `keyOf` is what "the same question" means here, and the complement path passes
// a looser one — see `predicateShapeKey`.
//
// NOTE: A GENERIC refined Alias stands for a different refinement at every use, so
// it is no candidate until a receiver has decided its Type Arguments — which is
// why the candidate set is worked out per binding rather than once for the branch.
function narrowingsFor(
	evidence: ConditionEvidence,
	scope: enricher.Scope,
	keyOf: (conjunct: common.PredicateConjunct) => string,
): Array<Narrowing> {
	if (evidence.size === 0) {
		return []
	}

	let declared = refinementCandidatesInScope(scope)

	if (declared.concrete.length === 0 && declared.generic.length === 0) {
		return []
	}

	let narrowings: Array<Narrowing> = []

	for (let [name, proven] of evidence) {
		// NOTE: An Error matches everything in both directions, so a poisoned
		// binding would qualify for whichever refinement is declared first and
		// walk out of the branch better typed than it went in. Whatever produced
		// the Error was reported; the branch stays about that.
		if (typeContainsError(proven.receiverType)) {
			continue
		}

		let keys = new Set(proven.conjuncts.map(keyOf))

		// NOTE: Evidence the binding's Type already carries is evidence the branch
		// has. A Parameter declared `NonZeroInteger` asking `if n::isOdd()` has
		// proven both things, which is what lets an `else if` inside an `else` add
		// to what the `else` established rather than start over.
		if (proven.receiverType.type === "Refinement") {
			for (let conjunct of provenConjuncts(proven.receiverType)) {
				keys.add(keyOf(conjunct))
			}
		}

		let established: common.RefinementType | null = null

		for (let refinement of refinementsFor(declared, proven.receiverType)) {
			if (
				!matchesType(refinement.base, proven.receiverType) ||
				// NOTE: A shadow that forgets something the binding's Type already
				// carries is no narrowing — `if n::isOdd()` on a NonZeroInteger must
				// not hand the branch a plain Odd — and this is exactly the question
				// assignability answers: the established Type has to flow into the
				// declared one.
				!matchesType(proven.receiverType, refinement) ||
				!provenConjuncts(refinement).every((conjunct) =>
					keys.has(keyOf(conjunct)),
				)
			) {
				continue
			}

			// NOTE: Strictly GREATER, so where two candidates prove the same
			// number of conjuncts the one walked FIRST stands. That walk is
			// ordered, and the order is the whole tie-break: nearest Scope first,
			// insertion order within a table — which puts the builtins ahead of a
			// Program's own declarations — and every concrete candidate ahead of a
			// generic one instantiated at this receiver. So a Program declaring a
			// second Alias with the standard library's own predicate narrows to
			// `NonZeroInteger` rather than to the name it wrote, while one declared
			// inside a Function beats both. Pinned in `enricher.spec.ts`.
			//
			// Deterministic, and nothing rests on WHICH of them it is: two
			// refinements proving the same conjuncts over the same base are one
			// Type to everything that reads conjuncts — assignability, dispatch
			// specificity and literal admission ask the conjunct set and nothing
			// besides — so the tie decides the name a Hover prints, not what the
			// branch may write.
			if (
				established === null ||
				provenConjuncts(refinement).length >
					provenConjuncts(established).length
			) {
				established = refinement
			}
		}

		if (established !== null) {
			narrowings.push({ name, type: established })
		}
	}

	return narrowings
}

// NOTE: The refinements declared in scope, told apart by whether a receiver still
// has to decide something about them: a `concrete` one is a candidate as it
// stands, a `generic` one is the Generic Alias wrapping a refinement and stands
// for nothing until its Type Arguments are worked out.
type RefinementCandidates = {
	concrete: Array<common.RefinementType>
	generic: Array<common.GenericAliasType>
}

// NOTE: Every refinement a Type name in scope stands for — the candidates a
// branch may establish. Nearest Scope first, and a name already seen is skipped,
// so an inner declaration shadows an outer one here exactly as it does everywhere
// else.
//
// NOTE: A generic refined Alias is invisible to a search for `type ===
// "Refinement"` — it is registered as the Generic Alias that applies its
// Arguments, with the refinement one level in — which is why the two are collected
// through one walk and kept apart, under the one `seen` set: `NonEmptyList` occupies
// its name in the Type Scope exactly as `NonZeroInteger` occupies its own.
function refinementCandidatesInScope(
	scope: enricher.Scope,
): RefinementCandidates {
	let concrete: Array<common.RefinementType> = []
	let generic: Array<common.GenericAliasType> = []
	let seen = new Set<string>()

	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		for (let [name, type] of Object.entries(current.types)) {
			if (seen.has(name)) {
				continue
			}

			seen.add(name)

			if (type.type === "Refinement") {
				concrete.push(type)
			} else if (
				type.type === "GenericAlias" &&
				type.aliasedType.type === "Refinement"
			) {
				generic.push(type)
			}
		}
	}

	return { concrete, generic }
}

// NOTE: The candidates ONE receiver could establish — the refinements declared
// outright, and every generic one this receiver decided the Type Arguments of.
function refinementsFor(
	declared: RefinementCandidates,
	receiverType: common.Type,
): Array<common.RefinementType> {
	if (declared.generic.length === 0) {
		return declared.concrete
	}

	let refinements = [...declared.concrete]

	for (let alias of declared.generic) {
		let instantiated = instantiatedRefinementFor(alias, receiverType)

		if (instantiated !== null) {
			refinements.push(instantiated)
		}
	}

	return refinements
}

// NOTE: The refinement a generic Alias stands for AT this receiver — its declared
// base unified against the receiver's Type to work the Arguments out, then
// substituted through, mirroring `instantiateChoiceAlias`: receiver-driven,
// reporting nothing (the receiver is a Type the Enricher already accepted), and
// stamping the applied spelling so a Hover reads `NonEmptyList<String>` rather than
// half of it.
//
// A unification that leaves a single Parameter undecided is no candidate at all.
// An empty List Literal's `List<Unknown>` is accepted by `List<Item>` without
// deciding `Item` — the Unknown is a slot nothing has filled, not a Type — and a
// refinement over a base nobody decided would put a Type nobody wrote into the
// branch.
function instantiatedRefinementFor(
	alias: common.GenericAliasType,
	receiverType: common.Type,
): common.RefinementType | null {
	let refinement = alias.aliasedType

	if (refinement.type !== "Refinement") {
		return null
	}

	let bindings: GenericBindings = new Map()

	if (
		!matchesTypeWithBindings(refinement.base, receiverType, {
			// NOTE: Every Parameter, unlike a signature's, where only an `infer`
			// one binds — a Type Alias' Parameters are APPLIED rather than
			// declared bindable, and a receiver standing in front of a branch is
			// the one thing they are ever worked out FROM.
			bindableNames: new Set(
				alias.generics.map((generic) => generic.name),
			),
			bindings,
		}) ||
		alias.generics.some((generic) => !bindings.has(generic.name))
	) {
		return null
	}

	let instantiated = applyGenericBindings(refinement, bindings)

	// NOTE: A substitution that changed nothing came back as the DECLARED object,
	// whose base still names the Alias' own Parameters. No value in the branch is
	// of that Type, and handing the declared object out as a shadow would put a
	// Parameter nobody can see into the Scope — as well as stamp a spelling onto
	// the very object a pending predicate is written into.
	//
	// NOTE: The stamp goes through the same door every other copy of a refinement
	// does. Narrowing only ever runs past hoisting, where the copy above would
	// have thrown on a pending predicate long before this line — so this is not
	// where a pending one is expected, it is where the rule stays the same
	// wherever a refinement is copied.
	return instantiated.type === "Refinement" && instantiated !== refinement
		? refinementWithTypeArguments(
				instantiated,
				alias.generics.map(
					(generic) =>
						bindings.get(generic.name) ?? { type: "Error" },
				),
			)
		: null
}

// NOTE: `a::and(b)` — the one Expression a condition is read THROUGH rather than
// as a question of its own.
function isConjunction(condition: common.typed.MethodInvocationNode): boolean {
	return (
		condition.namespace.name === "Boolean" &&
		condition.member.name === "and" &&
		condition.arguments.length === 1
	)
}

// NOTE: What a condition answering `false` proves, which is only readable where
// the condition asked exactly ONE question. A conjunction answering false says
// that one of its questions failed and nothing about which — and that is why the
// chain is refused HERE rather than by counting the conjuncts that came back:
// `collectConditionEvidence` drops every leaf it can not read, which is right for
// the true branch, where each conjunct it DID read really is proven, and would
// make `d::isNot(0)::and(flag)` look like the single question it is not.
function complementEvidence(
	condition: common.typed.ExpressionNode,
	scope: enricher.Scope,
): ConditionEvidence {
	let complemented: ConditionEvidence = new Map()

	if (condition.nodeType !== "MethodInvocation" || isConjunction(condition)) {
		return complemented
	}

	let evidence: ConditionEvidence = new Map()

	collectConditionEvidence(condition, scope, evidence)

	for (let [name, proven] of evidence) {
		let complement = complementConjunct(proven.conjuncts[0])

		if (complement !== null) {
			complemented.set(name, {
				receiverType: proven.receiverType,
				conjuncts: [complement],
			})
		}
	}

	return complemented
}

// NOTE: The Methods the standard library declares as each other's opposites, for
// the emptiness pairs that are not spelled `is`/`isNot`. Named per Namespace,
// because a String's `isEmpty` has a differently spelled opposite than a List's.
//
// Hardcoded, deliberately: nothing in Essence lets a Method DECLARE that it
// answers the negation of another, so a table someone can read is honest where an
// inference from names would be a guess.
const predicateOpposites = new Map<string, string>([
	["String::isEmpty", "hasAnyContent"],
	["String::hasAnyContent", "isEmpty"],
	["List::isEmpty", "hasItems"],
	["List::hasItems", "isEmpty"],
])

function complementConjunct(
	conjunct: common.PredicateConjunct,
): common.PredicateConjunct | null {
	let opposite =
		conjunct.methodName === "is"
			? "isNot"
			: conjunct.methodName === "isNot"
				? "is"
				: predicateOpposites.get(
						`${conjunct.namespaceName}::${conjunct.methodName}`,
					)

	// NOTE: The Overload is dropped rather than guessed — see
	// `predicateShapeKey`, which is the key a complemented conjunct is compared
	// by.
	return opposite === undefined
		? null
		: { ...conjunct, methodName: opposite, overloadIndex: null }
}

// NOTE: A conjunct's identity WITHOUT which Overload answered it. The two paths
// that SYNTHESIZE a conjunct rather than reading one off a typed Invocation
// compare by this, and they have to: the opposite of `is` is `isNot`, and which
// Overload of either a receiver would have answered with is not something a
// Method name and a list of literals can say — `String::is` is overloaded where
// `String::isNot` is not, so either spelling of the pair would be wrong for the
// other half. Two Overloads of one Method taking literals that spell the same are
// conflated by this, which no Namespace in the standard library declares.
function predicateShapeKey(conjunct: common.PredicateConjunct): string {
	return `${conjunct.namespaceName}::${conjunct.methodName}${JSON.stringify(
		conjunct.args,
	)}`
}

// NOTE: The Type `@` is bound to inside a Match Handler — the Matcher's own,
// unless a declared refinement says more about the value than the Matcher does.
// A Match on written values is the second doorway a refinement has, and it is the
// one nobody has to write a Function for: `case 0` proves the value IS zero, and
// the Case below it is reached only by a value none of the Cases above named,
// which is the very `isNot` a `NonZeroInteger` is declared by.
//
// NOTE: The evidence is read off the MATCHERS alone, so it holds whatever the
// Validator makes of the Match's shape — this can not lean on a check that runs
// after it. Only an unguarded literal Matcher hands evidence DOWN (a Guard can
// decline the value it named, so the value reaches the Handlers below and the
// complement would be a claim about a value that is standing right there), while
// a Handler's own literal proves what it named either way: a Guard runs after the
// Matcher matched, not instead of it.
//
// NOTE: The Matcher itself is untouched. Only `@`'s declared Type carries the
// evidence, which is what leaves the Rewriter with the Match it always had —
// literal Cases lowering to `anyIs` and a wildcard to a check on the base.
function refinedSelfType(
	matcher: common.Type,
	namedAbove: Array<common.PredicateConjunct>,
	literal: common.typed.ExpressionNode | null,
	scope: enricher.Scope,
): common.Type {
	let proven: Array<common.PredicateConjunct> = []

	for (let named of namedAbove) {
		let complement = complementConjunct(named)

		if (complement !== null) {
			proven.push(complement)
		}
	}

	let named = literal === null ? null : namedValueConjunct(literal)

	if (named !== null) {
		proven.push(named)
	}

	if (proven.length === 0) {
		return matcher
	}

	// NOTE: The same machinery an `if` narrows through, asked of `@` — which is
	// what makes a refinement over the wrong base, over a poisoned Type or over a
	// wildcard nothing is known about (`Unknown`) establish nothing here either,
	// without a second reading of any of those rules.
	let narrowings = narrowingsFor(
		new Map([["@", { receiverType: matcher, conjuncts: proven }]]),
		scope,
		predicateShapeKey,
	)

	return narrowings[0]?.type ?? matcher
}

// NOTE: The question a literal Matcher ASKS, as a conjunct — `case 0` is
// `@::is(0)`, and the Handlers below it are reached by a value that answered
// `false` to exactly that.
//
// NOTE: Integer and String only, and null for every other kind of value. The
// Namespace that answers `is` has to be one whose meaning is known here, and what
// the Matcher compiles to (`anyIs`) has to answer exactly what that Namespace's
// `is` answers — those two hold for the two scalars a refinement can be declared
// over, and a Rational or a Case would need the same argument made about it
// before its evidence could be trusted.
function namedValueConjunct(
	literal: common.typed.ExpressionNode,
): common.PredicateConjunct | null {
	if (literal.type.type !== "Integer" && literal.type.type !== "String") {
		return null
	}

	let argument = literalPredicateArgument(literal)

	return argument === null
		? null
		: {
				namespaceName: literal.type.type,
				methodName: "is",
				// NOTE: Unknowable from here, and dropped by the key this is
				// compared under — see `predicateShapeKey`.
				overloadIndex: null,
				args: [argument],
			}
}

// #endregion

// #region Body Return Type Inference

// NOTE: Every `<-` the body reaches, ignoring those belonging to a nested
// Function literal — those return out of their own literal, not this one.
function collectReturnedTypes(
	nodes: Array<common.typed.ImplementationNode>,
	types: Array<common.Type>,
): void {
	for (let node of nodes) {
		switch (node.nodeType) {
			case "ReturnStatement":
				types.push(node.expression.type)
				break
			case "IfElseStatement":
				collectReturnedTypes(node.trueBody, types)
				collectReturnedTypes(node.falseBody, types)
				break
			case "IfStatement":
				collectReturnedTypes(node.body, types)
				break
			default:
				break
		}
	}
}

// NOTE: One `<-` gives its Type outright; several give the Union of the
// distinct ones, which is what a Function returning either a value or
// `nothing` needs.
function unionOfTypes(types: Array<common.Type>): common.Type | null {
	let distinct = mergeUnionMembers(types)

	if (distinct.length === 0) {
		return null
	}

	if (distinct.length === 1) {
		return distinct[0]
	}

	return buildUnion(distinct)
}

// NOTE: How many of these passes are running, innermost counted with the rest —
// a nested Function literal's body is worked out inside its enclosing one's.
// Read by `reportUndecidedPayloadTypeArguments`, which stays silent for the span
// and answers with the Type it was handed: dropping the Diagnostics is not
// enough on its own, because an Error TYPE reported here is what the pass hands
// back as the literal's return Type, and the call then has nothing left to solve
// its own Parameters from.
let inferReturnTypeFromBodyDepth = 0

// NOTE: Working out what a Function literal returns means enriching its body —
// the Type of `<- total` can not be known without the Constants the body itself
// declares. The body is enriched twice as a result — once here to find the Type,
// once for real once it is known — so this pass's Diagnostics are collected and
// dropped rather than reported. `collectDiagnostics` exists for exactly this.
function inferReturnTypeFromBody(
	node: parser.FunctionDefinitionNode,
	parameterTypes: Array<common.Parameter>,
	scope: enricher.Scope,
): common.Type | null {
	inferReturnTypeFromBodyDepth += 1

	try {
		let { result } = collectDiagnostics(() => {
			let inferenceScope = childScope(scope)

			// NOTE: Declared through the same path the real pass uses, rather
			// than by hand: a Parameter whose internal name is a Pattern brings
			// in as many names as the Pattern binds, and a body reading one of
			// them would otherwise report `unknown-name` HERE — where the
			// Diagnostics are dropped — and hand back no return Type at all.
			// The bindings it produces are discarded; only the Scope matters.
			enrichParameterList(node.parameters, inferenceScope, parameterTypes)

			// NOTE: No `expectedReturnType` is seeded — there is none yet,
			// which is the whole reason this runs. A bare Case in return
			// position has nothing to resolve against and stays unresolved, so
			// a literal returning one still has to write its `-> Type`.
			//
			// Null rather than left out, because leaving it out is not the
			// absence of one: the search walks out to the ENCLOSING Function,
			// whose expected return Type this literal's `<-` has nothing to do
			// with — `<-` returns from the callback, never from the walk around
			// it. A `loop` nested in another `loop`'s `step` read the outer
			// callback's `Step<State, Result>` that way and decided its own
			// `#Done` payload against it, so the inner call finished with the
			// OUTER's Result Type while the value it actually carried was the
			// inner one's.
			inferenceScope.expectedReturnType = null

			let types: Array<common.Type> = []

			collectReturnedTypes(
				node.body.flatMap((bodyNode) =>
					enrichNode(bodyNode, inferenceScope),
				),
				types,
			)

			// NOTE: A body that returns nothing at all is left to the
			// Validator, which reports the missing return against the Function
			// itself.
			if (types.some((type) => type.type === "Error")) {
				return null
			}

			return unionOfTypes(types)
		})

		return result
	} finally {
		inferReturnTypeFromBodyDepth -= 1
	}
}

// #endregion

// #region Invocation, contextual Function & CaseValue resolution
//
// NOTE: Typing an invocation, a contextually typed Function literal, a
// CaseValue Expression, a Namespace's property values, or a Type Alias' `where`
// clause all needs to enrich Expressions — so it lives here, on the enrichment
// side, rather than in the Resolver. Enrichment imports the Resolver, never the
// other way round.

// NOTE: Enriches each Argument value at most once per invocation resolution.
// The typed Node is reused for every overload probe and, afterwards, for the
// final typed Invocation. A Function literal that omitted its annotations is the
// exception: it reacts to the expected Type, so it is re-resolved against each
// probe's Parameter Type — its final typed Node is built later from the
// resolution the winning probe recorded.
type ArgumentTyper = {
	getType: (
		value: parser.ExpressionNode,
		expectedType: common.Type,
		bindings?: GenericBindings | null,
	) => common.Type
	enrichArgumentNode: (
		argument: parser.ArgumentNode,
	) => common.typed.ArgumentNode
	// NOTE: Whether any Argument of this Invocation typed as Error, which is
	// the poison value a Diagnostic already reported. `matchTypes` lets an
	// Error match anything — including a Type Parameter, which it then leaves
	// UNBOUND — so an Invocation asks this before reporting that a Type
	// Parameter could not be inferred. The answer is only meaningful once the
	// Arguments have been matched, which is where every Type is asked for.
	hasErrorArgument: () => boolean
	// NOTE: Runs `probe` with that answer held aside, and reports what the probe
	// alone saw. An Argument can type as Error against ONE candidate's Parameter
	// Types and fine against another's, so the Error belongs to the candidate
	// until a candidate is committed — `noteErrorArgument` is how the committed
	// one hands it back to the Invocation.
	probeErrorArguments: <Result>(probe: () => Result) => {
		result: Result
		sawErrorArgument: boolean
	}
	noteErrorArgument: () => void
}

function makeArgumentTyper(scope: enricher.Scope): ArgumentTyper {
	let cache = new Map<parser.ExpressionNode, common.typed.ExpressionNode>()
	let admissions = new Map<parser.ExpressionNode, Map<string, boolean>>()
	let sawErrorArgument = false

	function noteErrors(type: common.Type): common.Type {
		if (type.type === "Error") {
			sawErrorArgument = true
		}

		return type
	}

	function enrichOnce(
		value: parser.ExpressionNode,
	): common.typed.ExpressionNode {
		let cached = cache.get(value)

		if (cached === undefined) {
			cached = enrichExpression(value, scope)
			cache.set(value, cached)
		}

		return cached
	}

	// NOTE: Whether this written value is admitted into the refinement its
	// position demands. Asked again and again — once per Overload candidate, then
	// once more for the winner as the committed Argument is matched — and a pure
	// question about a literal, so the answer is kept.
	//
	// Keyed by the refinement's SPELLING, which is its printing identity —
	// Arguments and all, because a generic refined Alias stands for a different
	// Type at every one of them: `NonEmptyList<Integer>` and `NonEmptyList<String>` are
	// one name and two questions about a written List, and keyed by the name alone
	// the first Overload probed decided both. Two refinements one Argument
	// position could be matched against under a single SPELLING would have to be
	// declared in two Modules and added to one Namespace's Overloads from both,
	// and the Validator asks the whole committed call the same question again
	// afterwards.
	function admitted(
		value: parser.ExpressionNode,
		refinement: common.RefinementType,
	): boolean {
		let bySpelling = admissions.get(value)

		if (bySpelling === undefined) {
			bySpelling = new Map()
			admissions.set(value, bySpelling)
		}

		let spelling = describeType(refinement)
		let answer = bySpelling.get(spelling)

		if (answer === undefined) {
			answer = admittedByEvaluation(refinement, enrichOnce(value))
			bySpelling.set(spelling, answer)
		}

		return answer
	}

	// NOTE: An Argument's position is the Parameter Type of whichever candidate
	// wins, and that is not known while the candidates are still being probed. A
	// prefixed Case construction reads its Choice's Type Arguments off exactly
	// that position, so each probe asks silently and RECORDS the Parameter Type
	// that decided — the winner's recording is committed, and the one real
	// enrichment below runs under it and reports what is left to report.
	//
	// A probe that decides but whose payload does not FIT what it decided answers
	// with the DECLARED Case all the same: a Case's members are what an Argument
	// is matched by, and the mismatch is the Validator's, one stage too late to
	// keep a candidate from winning on it. `take(Box#Full(5))` against a
	// `Box<String>` overload beside a `Box<Integer>` one picked the String one
	// otherwise, and then reported the Integer payload for not being a String. It
	// is still RECORDED, so a call where no candidate fits commits a decided
	// context and reports the one Diagnostic it has rather than that one and
	// `undecided-type-arguments` on top.
	//
	// NOTE: A Parameter Type that still mentions the CALL's own unsolved Type
	// Parameters is no decision at all, and recording it committed the undecided
	// state the whole rail exists to refuse: `take(Holder#Full(1))` against
	// `take<infer Item>(_ h: Holder<Item>)` became a `Holder<Item>#Full` whose
	// payload was then forbidden from deciding `Item`, so nothing ever did — the
	// Validator compared the payload against a Type Parameter and codegen emitted
	// a call forwarding a conformance witness no caller declares. It is refused
	// here instead, which leaves the construction to report
	// `undecided-type-arguments` for itself, and answered with an Error so that
	// the unsolved Parameter does not report a second time as uninferable and the
	// return Type it appears in does not carry it onward.
	//
	// NOTE: A bare form CARRYING a payload asks here too, though its payload is
	// what answers when the position says nothing. It used to skip the rail
	// altogether, on the grounds that its payload decides — but a payload decides
	// only what it MENTIONS, so `steps::contains(#Done(2))` leaked the `State`
	// its prefixed twin reads straight off the Parameter Type and was refused
	// for it. Where the position decides nothing — an unrelated Parameter Type, an
	// instantiation the payload does not fit, one still mentioning the call's own
	// unsolved Parameters — `payloadDecidedCaseType` answers instead, and no
	// recording is left behind: the enrichment pass reads that recording back, and
	// a position that decided nothing must not be what it reads.
	function probedCaseValueType(
		node: parser.CaseValueNode,
		expectedType: common.Type,
		bindings: GenericBindings | null,
	): common.Type {
		let payload = makePayloadReadings(node, scope)
		let { result } = collectDiagnostics(() =>
			resolveCaseValueType(node, scope, expectedType, payload.typeUnder),
		)
		let payloadDecides = node.choice === null && node.value !== null

		if (result.type === "Case") {
			// NOTE: A Case still carrying its Choice's `choiceGenerics` is the
			// DECLARED one — the bare scan's answer where the position named no
			// such Case at all, and the one shape that reaches here undecided
			// without mentioning an unsolved Parameter of the call.
			if (
				mentionsUnsolvedTypeParameter(result) ||
				result.choiceGenerics !== undefined
			) {
				return payloadDecides
					? payloadDecidedCaseType(node, payload)
					: { type: "Error" }
			}

			// NOTE: Read under what this candidate decided, which is the Type
			// the real enrichment will read it under too — a nested construction
			// is only itself once its own position is decided. Where arm
			// selection already read it under this very Case, that reading
			// answers.
			let payloadType = payload.typeUnder(result)
			let fits =
				payloadType === null || payloadFitsCase(result, payloadType)

			// NOTE: The prefixed form is recorded even where its payload does
			// not fit — the paragraph above says why. The bare one is not: it
			// falls back on reading its payload from here, and the enrichment
			// pass reads this recording back, so a recording left behind is the
			// position the fallback was made FOR deciding the construction
			// anyway. `1::take(#Full(5))` between a `Box<String>` overload and a
			// `Box<Integer>` one became a `Box<String>#Full` that way, off the
			// candidate it does not fit and never picked.
			if (fits || !payloadDecides) {
				recordContextualCaseValueType(node, { expectedType, bindings })
			}

			if (fits) {
				return result
			}
		}

		if (payloadDecides) {
			return payloadDecidedCaseType(node, payload)
		}

		let { result: declared } = collectDiagnostics(() =>
			node.choice === null
				? resolveBareCaseReference(node.caseName, scope)
				: resolveCaseReference(node.choice, node.caseName, scope),
		)

		return declared
	}

	// NOTE: What the payload ALONE makes of a bare construction — the fallback for
	// the candidate whose position decided nothing. Read here, silently and kept
	// nowhere, rather than by enriching the construction for real: that enrichment
	// is the one the committed Argument Node is built from and it happens exactly
	// once, so a probe that ran it early reported from a position no candidate
	// committed to and handed its answer to every candidate after. A `take(_:
	// String)` Overload declared ahead of a `take(_: Pair<Integer, Integer>)` one
	// refused `#Left({ a = 1 })` for the `B` its payload leaves standing that way,
	// while the very Overload that decides both went on to win — a call that
	// resolved or not by the order the Overloads were written in.
	//
	// A Parameter the payload left standing is answered as an Error, which is what
	// the prefixed rail answers an undecided position with and for the same reason:
	// the candidate must not win on a reading nothing decided, and the unsolved
	// Parameter must not report a second time as uninferable. The refusal itself is
	// the enrichment pass's, under whatever the committed call decided.
	function payloadDecidedCaseType(
		node: parser.CaseValueNode,
		payload: PayloadReadings,
	): common.Type {
		let { result } = collectDiagnostics(() => {
			let declared = resolveBareCaseReference(node.caseName, scope)

			if (declared.type !== "Case") {
				return declared
			}

			let value = payload.valueUnder(declared)

			if (value === null) {
				return declared
			}

			return instantiateCaseFromPayload(
				declared,
				wrapSingleMemberShorthand(declared, value),
				scope,
				node.position,
			)
		})

		return mentionsUnsolvedTypeParameter(result)
			? { type: "Error" }
			: result
	}

	return {
		getType(value, expectedType, bindings = null) {
			// NOTE: Only a Function literal with omitted annotations reacts to
			// the expected Type, and it may resolve differently per probe — so it
			// is resolved fresh here rather than enriched once.
			// `resolveFunctionValueType` records the resolution AND the position
			// it was resolved against, which the final enriched Node reads back
			// as the finished call decided it. Every other Expression ignores the
			// expected Type, so its one enriched Type serves every probe.
			if (
				value.nodeType === "FunctionValue" &&
				needsContext(value.value)
			) {
				return noteErrors(
					resolveFunctionValueType(
						value,
						scope,
						expectedType,
						bindings,
					),
				)
			}

			// NOTE: The other Expression that reacts — a Case construction,
			// whichever way it is spelled. The prefixed form and the bare unit
			// sigil have nothing of their own to read their Choice's Type
			// Arguments off and take the position's answer whatever it is; the
			// bare form carrying a payload asks the position first and reads its
			// payload where the position decided nothing.
			if (value.nodeType === "CaseValue") {
				return noteErrors(
					probedCaseValueType(value, expectedType, bindings),
				)
			}

			let type = noteErrors(enrichOnce(value).type)

			// NOTE: The third — and the only one that answers a Type the
			// Expression itself was never resolved to. A value written DOWN where
			// a refinement stands is admitted by deciding the predicate while
			// compiling: `3` really is a NonZeroInteger, so the Argument answers
			// with the refinement and the call needs no branch in front of it.
			//
			// The Node keeps its own Type and nothing is written to it. That is
			// what makes this safe under the Overload probes: the admission is an
			// answer about THIS position, given to whichever candidate asked, and
			// a candidate that loses leaves nothing behind for the winner to read.
			// It is also why the Node needs nothing — a refinement erases to its
			// base, which is the Type the literal already has.
			//
			// NOTE: Asked about the refinement THIS value decides rather than about
			// the Parameter Type as it stands — the two differ only where the
			// Parameter's own Type Arguments are still open, and there the Parameter
			// as it stands is not yet a Type any value could be of. What comes back
			// is matched against the Parameter as DECLARED, which is what binds the
			// Type Parameter the value just decided.
			if (expectedType.type === "Refinement") {
				let asked = refinementDecidedBy(expectedType, type)

				if (asked !== null && admitted(value, asked)) {
					return asked
				}
			}

			return type
		},
		hasErrorArgument() {
			return sawErrorArgument
		},
		probeErrorArguments(probe) {
			let outerSawErrorArgument = sawErrorArgument

			sawErrorArgument = false

			try {
				return { result: probe(), sawErrorArgument }
			} finally {
				sawErrorArgument = outerSawErrorArgument
			}
		},
		noteErrorArgument() {
			sawErrorArgument = true
		},
		enrichArgumentNode(argument) {
			let value = enrichOnce(argument.value)

			return {
				nodeType: "Argument",
				name: argument.name ? argument.name.content : null,
				value,
				type: value.type,
			}
		},
	}
}

// NOTE: A Function literal's Type. Every annotation present makes it a plain
// signature (resolved on the Resolver side); an omitted one is worked out
// contextually — from the expected Type while an invocation is matched, or from
// the body when the expected Type leaves it Generic. The result is recorded per
// Node so the separate enrichment pass, which has no expected Type left, reads
// it back rather than re-deriving it.
function resolveFunctionDefinitionType(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
	bindings: GenericBindings | null = null,
): common.FunctionType {
	if (!needsContext(node)) {
		return resolveFunctionSignatureType(node, scope)
	}

	if (expectedType === null) {
		let recorded = recordedContextualFunctionType(node)

		if (recorded !== undefined) {
			return decidedContextualFunctionType(node, scope, recorded)
		}
	}

	let functionScope = scopeWithGenerics(node.generics, scope)
	let expectedFunction =
		expectedType !== null && expectedType.type === "Function"
			? expectedType
			: null

	let parameterTypes = resolveContextualParameterTypes(
		node,
		functionScope,
		expectedFunction,
	)

	let resolved: common.FunctionType = {
		type: "Function",
		generics: resolveGenericDeclarations(node.generics, scope),
		parameterTypes,
		returnType: resolveContextualReturnType(
			node,
			functionScope,
			parameterTypes,
			expectedFunction,
		),
		documentation: node.documentation ?? undefined,
	}

	recordContextualFunctionType(node, {
		resolved,
		expectedType: expectedFunction,
		bindings,
	})

	return resolved
}

// NOTE: The result of inferring one invocation against one signature —
// `unboundGenerics` lists Type Parameters that neither a default, the
// receiver nor any Argument could bind. They are substituted as Error Types
// in `returnType`; the caller reports them once the candidate is selected.
type InferredInvocation = {
	returnType: common.Type
	unboundGenerics: Array<string>
	// NOTE: What the invocation bound each Type Parameter to — conformance
	// resolution for Protocol bounds reads the winning candidate's bindings.
	bindings: GenericBindings
	// NOTE: Which Parameters this call wrote no Argument for, indexed over the
	// FULL signature — the receiver Parameter included, since that is the list
	// the Simplifier emits an Argument list against. Empty for every call that
	// omits nothing, which is every call in a Program that declares no default.
	omittedParameterIndices: Array<number>
}

// NOTE: Matches an invocation's Arguments left to right against a signature,
// binding `infer` Generics on their first occurrence (for Methods the
// receiver is the first Argument), and seeding plain Generics with their
// definition-time defaults. Returns undefined when the Arguments do not
// match; a fresh context per call keeps bindings from leaking between
// overload candidates.
function inferInvocation(
	signature: common.BaseFunction,
	matchableArguments: Array<MatchableArgument>,
): InferredInvocation | undefined {
	if (signature.generics.length === 0) {
		let matched = matchArguments(
			signature.parameterTypes,
			matchableArguments,
		)

		if (matched.type !== "Match") {
			return undefined
		}

		return {
			returnType: signature.returnType,
			unboundGenerics: [],
			bindings: new Map(),
			omittedParameterIndices: matched.omittedParameterIndices,
		}
	}

	let { parameterTypes, context, freshToOriginal } =
		createFreshenedInference(signature)

	let matched = matchArguments(parameterTypes, matchableArguments, {
		inference: context,
	})

	if (matched.type !== "Match") {
		return undefined
	}

	return substituteInferredReturnType(
		signature,
		unfreshenBindings(context.bindings, freshToOriginal),
		matched.omittedParameterIndices,
	)
}

// NOTE: Substitutes the collected bindings into the return Type — Generics
// that stayed unbound are substituted as Error Types, so that a single
// "Could not infer" Diagnostic does not cascade.
function substituteInferredReturnType(
	signature: common.BaseFunction,
	bindings: GenericBindings,
	omittedParameterIndices: Array<number> = [],
): InferredInvocation {
	let originalBindings = bindings
	let unboundGenerics = signature.generics
		.filter((generic) => !bindings.has(generic.name))
		.map((generic) => generic.name)

	if (unboundGenerics.length > 0) {
		bindings = new Map(bindings)

		for (let name of unboundGenerics) {
			bindings.set(name, { type: "Error" })
		}
	}

	return {
		returnType: applyGenericBindings(signature.returnType, bindings),
		unboundGenerics,
		bindings: originalBindings,
		omittedParameterIndices,
	}
}

// NOTE: The Overload an Invocation settled on: which slot it was, what it
// inferred, and the conformances its bounds solved to. `diagnostics` are what
// probing that candidate reported, held back rather than reported — a candidate
// is probed before it is known to win (and a Method is probed once per
// Namespace), so the caller replays them only for the candidate it commits.
type SelectedOverload = {
	index: number
	inferred: InferredInvocation
	conformances: Array<common.Conformance>
	diagnostics: Array<common.Diagnostic>
}

type ProbedOverload = {
	inferred: InferredInvocation
	conformances: Array<common.Conformance>
	// NOTE: What solving this candidate's bounds reported. Held back always, on
	// both rails of the loop below: which bound failed is only news once the
	// candidate that failed it is the one being committed to.
	diagnostics: Array<common.Diagnostic>
	// NOTE: Whether typing an Argument against THIS candidate's Parameter Types
	// produced an Error — which is not a candidate matching but a candidate the
	// Arguments could not be read under at all.
	sawErrorArgument: boolean
}

// NOTE: One candidate, matched and its bounds solved, with the bound solve's
// reports and the Errors its Argument typing produced handed back rather than
// left where the caller can not tell them apart from the Invocation's own.
function probeOverload(
	overload: common.BaseFunction,
	matchableArguments: Array<MatchableArgument>,
	scope: enricher.Scope,
	position: common.Position,
	typer: ArgumentTyper,
): ProbedOverload | undefined {
	let { result, sawErrorArgument } = typer.probeErrorArguments(() => {
		let inferred = inferInvocation(overload, matchableArguments)

		if (inferred === undefined) {
			return undefined
		}

		let { result: conformances, diagnostics } = collectDiagnostics(() =>
			resolveConformances(
				overload.generics,
				inferred.bindings,
				scope,
				position,
			),
		)

		return { inferred, conformances, diagnostics }
	})

	if (result === undefined) {
		return undefined
	}

	return { ...result, sawErrorArgument }
}

// NOTE: The order the candidates are PROBED in, which is not the order they were
// written in as soon as one of them asks for evidence. Selection is first fit and
// a refinement is freely assignable to its base, so an entry taking the base Type
// accepts every Argument a refined entry would have taken — a refined entry
// written after it could never win a single call. The entries asking for a
// refinement are probed first instead, and the base entry becomes what a value
// carrying no evidence falls through to. That is also what lets the Standard
// Library APPEND its refined entries rather than write them where they need to be
// read: an Overload's slot is emitted into its name (`divide__overload$3`) and its
// native binding is keyed by position, so declaration order there is not free.
//
// The partition is stable, and answers with the written order when no entry asks
// for anything: an Overload set with no refinement in it anywhere is probed in
// exactly the order it always was, which is the whole of what changes for a
// Program that declares none. Each candidate carries the slot it was DECLARED in
// either way — that index is what the Simplifier mangles the callee with, not the
// order it was tried in.
//
// A lone candidate is answered without asking anything: every plain Function,
// SimpleMethod and static Method invocation in a Program comes through here as an
// Overload set of one, and one candidate has no order to put it in.
function overloadProbeOrder(
	overloads: Array<common.BaseFunction>,
): Array<[number, common.BaseFunction]> {
	let candidates = [...overloads.entries()]

	if (candidates.length < 2) {
		return candidates
	}

	let asking: Array<[number, common.BaseFunction]> = []
	let rest: Array<[number, common.BaseFunction]> = []

	for (let candidate of candidates) {
		let [, overload] = candidate

		if (
			overload.parameterTypes.some((parameter) =>
				typeContainsRefinement(parameter.type),
			)
		) {
			asking.push(candidate)
		} else {
			rest.push(candidate)
		}
	}

	return asking.length === 0 ? candidates : [...asking, ...rest]
}

// NOTE: Bounds are part of selecting an Overload, not a check run on the
// Overload that matching happened to pick first: a candidate whose Type
// Parameter bounds the Arguments can not satisfy is no candidate at all while a
// later one takes them. Neither is a candidate the Arguments only match because
// reading one of them against its Parameter Types failed — a prefixed Case
// construction against a Parameter Type that mentions the call's own unsolved
// Type Parameters types as Error, and `matchTypes` lets an Error match anything.
// Without either rule, an Invocation resolved or failed depending on the order
// the Overloads were declared in.
//
// The probe's conformances are handed back so the winner is solved exactly once
// — solving again on the way out would report every Diagnostic twice, and
// `resolveConformances` is not free.
//
// When no candidate holds up, the FIRST arg-matching one is selected anyway: its
// Diagnostics say which bound failed and how to satisfy it, which is what a call
// with one plausible Overload needs to hear. Turning it into "no Overload
// accepts these Arguments" would be a worse report about a call whose Arguments
// were accepted. First is first in `overloadProbeOrder`, which is where a
// refinement-asking entry is read as if it stood where it needs to be read.
function selectOverload(
	overloads: Array<common.BaseFunction>,
	matchableArguments: Array<MatchableArgument>,
	scope: enricher.Scope,
	position: common.Position,
	typer: ArgumentTyper,
): SelectedOverload | undefined {
	let firstArgumentMatch:
		| { selected: SelectedOverload; sawErrorArgument: boolean }
		| undefined

	for (let [index, overload] of overloadProbeOrder(overloads)) {
		// NOTE: Up to and including the first candidate whose Arguments match, a
		// probe reports and records where it stands — an Argument is enriched
		// exactly once, so a report held back there would be held back forever.
		// Past that candidate a probe is speculative, since a candidate to settle
		// on already exists, and one that loses must leave nothing behind: an
		// unannotated Function literal Argument is re-resolved against every
		// candidate's Parameter Types and reports from inside its own body, so
		// probing on turned calls that used to compile red. A speculative probe's
		// reports and recordings are therefore held, and only the candidate the
		// call commits to hands them on.
		let probe = () =>
			probeOverload(overload, matchableArguments, scope, position, typer)
		let held =
			firstArgumentMatch === undefined
				? undefined
				: probeContextualFunctionTypes(() => collectDiagnostics(probe))
		let { result: probed, diagnostics: argumentDiagnostics } =
			held?.result ?? { result: probe(), diagnostics: [] }

		if (probed === undefined) {
			continue
		}

		let candidate = {
			index,
			inferred: probed.inferred,
			conformances: probed.conformances,
			diagnostics: [...argumentDiagnostics, ...probed.diagnostics],
		}

		if (
			!containsErrors(candidate.diagnostics) &&
			!probed.sawErrorArgument
		) {
			commitContextualFunctionTypes(held?.recording)

			return candidate
		}

		firstArgumentMatch ??= {
			selected: candidate,
			sawErrorArgument: probed.sawErrorArgument,
		}
	}

	if (firstArgumentMatch === undefined) {
		return undefined
	}

	// NOTE: Nothing held up, so the Invocation owns this candidate's Error
	// Argument after all — it is why a Type Parameter went unbound, and
	// `reportUnboundGenerics` asks for exactly that before reporting a cascade on
	// top of the Argument's own Diagnostic.
	if (firstArgumentMatch.sawErrorArgument) {
		typer.noteErrorArgument()
	}

	return firstArgumentMatch.selected
}

// NOTE: Silent when an Argument already typed as Error — that Argument's own
// Diagnostic has been reported, and it is exactly why nothing bound the Type
// Parameter: `matchTypes` short-circuits an Error to a match without binding
// anything. Reporting on top of it would point at the call rather than at the
// Argument that actually failed, which is the cascade the poison Type exists to
// prevent.
function reportUnboundGenerics(
	unboundGenerics: Array<string>,
	position: common.Position,
	typer: ArgumentTyper,
): void {
	if (typer.hasErrorArgument()) {
		return
	}

	for (let name of unboundGenerics) {
		reportError(
			`Type Parameter '${name}' could not be inferred`,
			position,
			{
				code: "uninferable-type-parameter",
				labels: [
					primary(
						position,
						"nothing here determines what it binds to",
					),
				],
				helps: ["Write the Type Argument explicitly."],
			},
		)
	}
}

// NOTE: A Method that is called on its Namespace (`Namespace.method(…)`)
// rather than on a value. `undefined` answers false: a Namespace that does not
// declare the name at all is not the static case, it is the unknown-Method one.
function isStaticMethodType(methodType: common.Type | undefined): boolean {
	return (
		methodType !== undefined &&
		(methodType.type === "StaticMethod" ||
			methodType.type === "OverloadedStaticMethod")
	)
}

// NOTE: Which of the Namespaces declaring the Method can answer an INSTANCE
// call, and which only declare it as static. Every Method Invocation is an
// instance call — the receiver written left of the `::` is the first Argument —
// so a static declaration is not a candidate at all. Keeping the static ones
// rather than dropping them is what lets the Diagnostic say the Method exists
// and is called differently, instead of claiming there is no such Method.
function partitionInstanceMethodNamespaces(
	methodName: string,
	namespaces: Map<string, common.NamespaceType>,
): {
	instanceNamespaces: Map<string, common.NamespaceType>
	staticNamespaces: Map<string, common.NamespaceType>
} {
	let instanceNamespaces = new Map<string, common.NamespaceType>()
	let staticNamespaces = new Map<string, common.NamespaceType>()

	for (let [name, namespace] of namespaces) {
		if (isStaticMethodType(namespace.methods[methodName])) {
			staticNamespaces.set(name, namespace)
		} else {
			instanceNamespaces.set(name, namespace)
		}
	}

	return { instanceNamespaces, staticNamespaces }
}

function resolveInvokedMethodInNamespace(
	node: parser.MethodInvocationNode,
	resolvedNamespace: common.NamespaceType,
	baseType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
	receiverType: common.Type | null = null,
):
	| {
			returnType: common.Type
			overloadedMethodIndex: number | null
			unboundGenerics: Array<string>
			conformances: Array<common.Conformance>
			omittedParameterIndices: Array<number>
			// NOTE: What selecting this Overload reported, for the caller to
			// replay once it commits to this Namespace — see `selectOverload`.
			selectionDiagnostics: Array<common.Diagnostic>
	  }
	| undefined {
	let methodType = resolvedNamespace.methods[node.member.content]

	// NOTE: `value::method(…)` is instance-call syntax, and a static Method has
	// no receiver Parameter for the value to occupy — resolving one here would
	// match the written Arguments against the whole signature and leave the
	// Simplifier to prepend the receiver anyway, shifting every runtime
	// Argument one place to the right. Static Methods are filtered out before
	// resolution reaches this (`reportStaticMethodOnValue` says so); refusing
	// them again here is what keeps that filtering from being load-bearing.
	if (isStaticMethodType(methodType)) {
		return
	}

	let matchableArguments: Array<MatchableArgument> = node.arguments.map(
		(argument) => ({
			name: argument.name?.content ?? null,
			getType: (expectedType, bindings) =>
				typer.getType(argument.value, expectedType, bindings),
			bindsNothing: bindsNoTypeParameter(argument),
		}),
	)

	// NOTE: Union dispatch resolves the Method once per member Type — the
	// override stands in for the receiver so each member is matched as if
	// the receiver had that Type. Otherwise the receiver is the Type the
	// base was already enriched to.
	matchableArguments.unshift({
		name: null,
		getType: () => receiverType ?? baseType,
	})

	// NOTE: A SimpleMethod is its own single candidate — one signature to match
	// and one set of bounds to solve is what `selectOverload` does for one
	// Overload, so both Method shapes take the same path and can not drift.
	let overloads =
		methodType.type === "SimpleMethod"
			? [methodType]
			: methodType.type === "OverloadedMethod"
				? methodType.overloads
				: undefined

	if (overloads === undefined) {
		return undefined
	}

	let selected = selectOverload(
		overloads,
		matchableArguments,
		scope,
		node.position,
		typer,
	)

	if (selected === undefined) {
		return undefined
	}

	return {
		returnType: selected.inferred.returnType,
		overloadedMethodIndex:
			methodType.type === "SimpleMethod" ? null : selected.index,
		unboundGenerics: selected.inferred.unboundGenerics,
		conformances: selected.conformances,
		omittedParameterIndices: selected.inferred.omittedParameterIndices,
		selectionDiagnostics: selected.diagnostics,
	}
}

// NOTE: Failed Method Invocations resolve to a placeholder Namespace and an
// Error Type — the Diagnostic has already been reported, and later stages
// only run when there are no Error Diagnostics. Dispatched Invocations reuse
// the placeholder Namespace: their targets live in `dispatch` instead.
function placeholderNamespace(): { name: string; type: common.NamespaceType } {
	return {
		name: "",
		type: {
			type: "Namespace",
			targetType: null,
			name: "",
			generics: [],
			properties: {},
			methods: {},
		},
	}
}

type ResolvedMethodInvocation = {
	namespace: { name: string; type: common.NamespaceType }
	type: common.Type
	overloadedMethodIndex: number | null
	conformances: Array<common.Conformance>
	omittedParameterIndices: Array<number>
	// NOTE: Set only for a *generic* Choice's derived `is`/`isNot` — the plan
	// its widened runtime helper interprets. Absent for every other call, so a
	// non-generic Choice emits the plain `choiceIs`.
	derivedDescriptor?: common.DerivedEquatableDescriptor
	dispatch: Array<common.DispatchCase> | null
}

function resolveFailedMethodInvocation(): ResolvedMethodInvocation {
	return {
		namespace: placeholderNamespace(),
		type: { type: "Error" },
		overloadedMethodIndex: null,
		conformances: [],
		omittedParameterIndices: [],
		dispatch: null,
	}
}

// NOTE: A Namespace has to be imported before a Method can dispatch through it,
// which makes a forgotten import indistinguishable from a misspelling by
// everything the Scope can see. So the Modules this one depends on are asked as
// well, by exactly the rule dispatch is decided by — `namespacesTargeting` — and
// what comes back names the Namespace AND the Module it is in, which is what the
// auto-import Quick Fix reads. Empty for a Program that is no Module, so a single
// file compile's Diagnostics are the ones it always had.
function unimportedNamespaceHelps(
	memberName: string,
	baseType: common.Type,
	scope: enricher.Scope,
): Array<string> {
	let candidates = unimportedNamespacesOf(scope).filter(
		(candidate) => candidate.namespace.methods[memberName] !== undefined,
	)

	if (candidates.length === 0) {
		return []
	}

	let targeting = namespacesTargeting(
		new Map(
			candidates.map((candidate) => [
				candidate.name,
				candidate.namespace,
			]),
		),
		baseType,
	)

	return candidates
		.filter((candidate) => targeting.has(candidate.name))
		.map(
			(candidate) =>
				`'${candidate.name}' in ${candidate.specifier} declares '${memberName}' for ${describeType(baseType)} — import it.`,
		)
}

// NOTE: The Namespaces that were searched are the useful half of "no such
// Method" — without them the reader can not tell whether they misspelled the
// Method or the value is not the Type they thought it was. The near miss is
// offered from the same set, so a suggestion is always a Method that would
// actually resolve.
// NOTE: Every Method name a set of Namespaces declares, for the near miss two
// unknown-method reports each want — the one for a plain receiver, and the one
// per-member dispatch raises for a Union.
function methodNamesOf(
	namespaces: Map<string, common.NamespaceType>,
): Array<string> {
	let methodNames = new Set<string>()

	for (let namespace of namespaces.values()) {
		for (let methodName of Object.keys(namespace.methods)) {
			methodNames.add(methodName)
		}
	}

	return [...methodNames]
}

function reportUnknownMethod(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	namespaces: Map<string, common.NamespaceType>,
	scope: enricher.Scope,
): void {
	let suggestion = closestMatch(
		node.member.content,
		methodNamesOf(namespaces),
	)
	let namespaceNames = [...namespaces.keys()]

	reportError(
		`No Method named '${node.member.content}' for this value`,
		node.member.position,
		{
			code: "unknown-method",
			labels: [
				primary(node.member.position, "no Method of this name"),
				secondary(
					node.base.position,
					`this is ${withArticle(describeType(baseType))}`,
				),
			],
			notes:
				namespaceNames.length === 0
					? []
					: [
							`Searched ${namespaceNames.length === 1 ? "Namespace" : "Namespaces"} ${namespaceNames
								.map((name) => `'${name}'`)
								.join(", ")}.`,
						],
			helps: [
				...(suggestion === null
					? []
					: [`Did you mean '${suggestion}'?`]),
				...unimportedNamespaceHelps(
					node.member.content,
					baseType,
					scope,
				),
			],
			...suggestionData(suggestion),
		},
	)
}

// NOTE: The Method is there, it is simply not called this way — which is a
// different mistake from a misspelling, and the only one of the two whose fix
// is a rewritten call rather than a rewritten name. `memberType` is set only
// for a Union receiver's per-member dispatch, where the Namespace that
// declared it static was found for ONE member rather than for the value.
function reportStaticMethodOnValue(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	memberType: common.Type | null,
	staticNamespaces: Map<string, common.NamespaceType>,
): void {
	let namespaceNames = [...staticNamespaces.keys()]

	reportError(
		memberType === null
			? `'${node.member.content}' is a static Method`
			: `'${node.member.content}' is a static Method for ${describeType(memberType)}`,
		node.member.position,
		{
			code: "static-method-on-value",
			labels: [
				primary(
					node.member.position,
					"a static Method is called on its Namespace, not on a value",
				),
				secondary(
					node.base.position,
					`this is ${withArticle(describeType(baseType))}`,
				),
			],
			notes: namespaceNames.map(
				(name) =>
					`'${name}' declares '${node.member.content}' as static.`,
			),
			helps: [
				`Write '${namespaceNames[0]}.${node.member.content}(…)', passing the value as an Argument if it needs one.`,
			],
		},
	)
}

// NOTE: The receiver occupies the first Parameter of every non-static Method
// signature, but it is written to the left of the `::` rather than inside the
// parentheses — listing it among the Arguments would describe a call nobody
// can write.
function describeMethodOverloads(
	methodType: common.Type | undefined,
): Array<Array<common.Parameter>> {
	if (methodType === undefined) {
		return []
	}

	let dropsReceiver =
		methodType.type === "SimpleMethod" ||
		methodType.type === "OverloadedMethod"

	switch (methodType.type) {
		case "SimpleMethod":
		case "StaticMethod":
			return [
				dropsReceiver
					? methodType.parameterTypes.slice(1)
					: methodType.parameterTypes,
			]
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return methodType.overloads.map((overload) =>
				dropsReceiver
					? overload.parameterTypes.slice(1)
					: overload.parameterTypes,
			)
		default:
			return []
	}
}

// NOTE: One Note per candidate signature, each read off the Namespace
// SPECIALIZED against this receiver — a `List<Integer>` is told its `prepend`
// takes an `Integer`, not an `ItemType`. The reader is being shown what the
// call would have had to pass, and a Namespace Generic is not something they
// wrote.
function describeCandidateSignatures(
	node: parser.MethodInvocationNode,
	namespaces: Map<string, common.NamespaceType>,
	baseType: common.Type,
): Array<string> {
	return [...specializedNamespacesFor(namespaces, baseType)].flatMap(
		([namespaceName, namespaceType]) =>
			describeMethodOverloads(
				namespaceType.methods[node.member.content],
			).map(
				(parameterTypes) =>
					`'${namespaceName}::${node.member.content}' ${describeSignature(parameterTypes)}.`,
			),
	)
}

function reportNoMatchingOverload(
	node: parser.MethodInvocationNode,
	namespaces: Map<string, common.NamespaceType>,
	baseType: common.Type,
): void {
	reportError(
		`No overload of '${node.member.content}' accepts these Arguments`,
		node.position,
		{
			code: "no-matching-overload",
			labels: [
				primary(
					node.position,
					`this call passes ${countOf(node.arguments.length, "Argument")}`,
				),
			],
			notes: describeCandidateSignatures(node, namespaces, baseType),
		},
	)
}

function reportAmbiguousNamespace(
	node: parser.MethodInvocationNode,
	namespaceNames: Array<string>,
): void {
	reportError(
		`'${node.member.content}' is provided by more than one Namespace`,
		node.position,
		{
			code: "ambiguous-namespace",
			labels: [
				primary(
					node.member.position,
					"these Arguments match all of them",
				),
			],
			notes: namespaceNames.map(
				(name) => `'${name}' declares '${node.member.content}'.`,
			),
			helps: [
				`Name the Namespace at the call, e.g. '${namespaceNames[0]}::${node.member.content}(…)'.`,
			],
		},
	)
}

// NOTE: A receiver with an undecided slot in it — the `List<Unknown>` an empty
// List Literal has — is matched by every Namespace whose target is a List, in
// both directions, because an Unknown fits anything and anything fits it. The
// specificity order then reads that as a genuine overlap and hands the call to
// the narrower target, so `[]::tag()` would silently be the nested Namespace's
// `tag` rather than the flat one's. What is undecided must not be what decides,
// which is why more than one match over such a receiver is refused here instead
// of ordered: the receiver has to say what it holds first. Exactly one match is
// left alone — nothing was picked by the Unknown when there was nothing to pick
// between.
function reportUndecidedReceiverType(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	memberType: common.Type | null,
	namespaceNames: Array<string>,
): void {
	let undecidedType = memberType ?? baseType

	reportError(
		`'${node.member.content}' is called on a value whose Type is not fully known here`,
		node.base.position,
		{
			code: "undecided-receiver-type",
			labels: [
				primary(
					node.base.position,
					`this is ${withArticle(describeType(baseType))}`,
				),
				secondary(
					node.member.position,
					`'${node.member.content}' is looked up in its Namespaces`,
				),
			],
			notes: [
				...(memberType === null
					? []
					: [
							`${describeType(memberType)} is a member of this Union.`,
						]),
				...namespaceNames.map(
					(name) => `'${name}' declares '${node.member.content}'.`,
				),
				`${describeType(undecidedType)} is matched by all of them, so which one runs would be decided by a Type nothing has decided.`,
			],
			helps: [
				"Annotate what the receiver comes from — 'constant items: List<Integer> = []' — so its Type is decided before the call.",
			],
		},
	)
}

// NOTE: Which of the Namespaces found for a receiver actually declare the
// Method — and the ONE door the derived Equatable Namespace comes through, for
// both the whole-Union lookup and the per-member one. It is consulted only when
// the written Namespaces have already come up empty, which is what makes the
// derived equality a fallback rather than a competitor: a Namespace that writes
// its own `is` is never tied against it, so it can not be made ambiguous by it.
function namespacesDeclaringMethod(
	methodName: string,
	namespaces: Map<string, common.NamespaceType>,
	baseType: common.Type,
	scope: enricher.Scope,
): Map<string, common.NamespaceType> {
	let matchingNamespaces = new Map<string, common.NamespaceType>()

	for (let [name, namespace] of namespaces) {
		if (Object.hasOwn(namespace.methods, methodName)) {
			matchingNamespaces.set(name, namespace)
		}
	}

	if (matchingNamespaces.size > 0) {
		return matchingNamespaces
	}

	let derived = derivedEquatableNamespace(baseType, scope)

	if (derived !== null && Object.hasOwn(derived.methods, methodName)) {
		matchingNamespaces.set(derivedEquatableNamespaceName, derived)
	}

	return matchingNamespaces
}

function resolveMethodInvocation(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
): ResolvedMethodInvocation {
	let namespaces = resolveMethodLookupNamespacesForReceiverType(
		baseType,
		node.namespaceSpecifier,
		scope,
	)

	let { instanceNamespaces: matchingNamespaces, staticNamespaces } =
		partitionInstanceMethodNamespaces(
			node.member.content,
			namespacesDeclaringMethod(
				node.member.content,
				namespaces,
				baseType,
				scope,
			),
		)

	// NOTE: A Union-typed receiver falls back to per-member dispatch whenever
	// no Namespace covering the whole Union can resolve the Method — a
	// covering Namespace that can (`Ordering`) keeps taking precedence.
	if (matchingNamespaces.size === 0) {
		if (baseType.type === "UnionType") {
			return resolveUnionMethodDispatch(node, baseType, scope, typer)
		}

		// NOTE: The name resolves, just not to something an instance call can
		// reach — reported before the two "no such Method" Diagnostics, which
		// would both be untrue.
		if (staticNamespaces.size > 0) {
			reportStaticMethodOnValue(node, baseType, null, staticNamespaces)

			return resolveFailedMethodInvocation()
		}

		// NOTE: Nothing targets the value at all, versus something does but
		// has no Method of this name — two different mistakes, so they keep
		// two different Diagnostics.
		if (namespaces.size === 0) {
			if (baseType.type !== "Error") {
				reportError(
					`No Namespace provides Methods for this value`,
					node.base.position,
					{
						code: "no-namespace-for-value",
						labels: [
							primary(
								node.base.position,
								`this is ${withArticle(describeType(baseType))}`,
							),
							secondary(
								node.member.position,
								`'${node.member.content}' is looked up in its Namespaces`,
							),
						],
						notes: [
							`No Namespace in scope targets ${describeType(baseType)}.`,
						],
						helps: unimportedNamespaceHelps(
							node.member.content,
							baseType,
							scope,
						),
					},
				)
			}
		} else {
			reportUnknownMethod(node, baseType, namespaces, scope)
		}

		return resolveFailedMethodInvocation()
	}

	let resolvedMethods = []

	// NOTE: Every Namespace is probed even after one has matched — that is how
	// an ambiguity is found — and a probe RECORDS what an unannotated Function
	// literal Argument resolved to against that candidate's Parameter Types.
	// Each probe's recordings are therefore held aside and only the selected
	// candidate's are committed, so the literal's body is typed by the
	// Namespace that actually won rather than by whichever was probed last.
	let lastRecording: ContextualFunctionTypeRecording | undefined

	for (let [namespaceName, namespaceType] of matchingNamespaces) {
		let { result: resolvedMethod, recording } =
			probeContextualFunctionTypes(() =>
				resolveInvokedMethodInNamespace(
					node,
					namespaceType,
					baseType,
					scope,
					typer,
				),
			)

		lastRecording = recording

		if (resolvedMethod) {
			resolvedMethods.push({
				namespace: {
					name: namespaceName,
					type: namespaceType,
				},
				overloadedMethodIndex: resolvedMethod.overloadedMethodIndex,
				type: resolvedMethod.returnType,
				unboundGenerics: resolvedMethod.unboundGenerics,
				conformances: resolvedMethod.conformances,
				omittedParameterIndices: resolvedMethod.omittedParameterIndices,
				selectionDiagnostics: resolvedMethod.selectionDiagnostics,
				recording,
			})
		}
	}

	if (resolvedMethods.length > 1) {
		// NOTE: An undecided receiver is refused before the order is asked
		// anything — see `reportUndecidedReceiverType`. The shared filter itself
		// stays as it is: Completion runs it over the same Namespaces and must
		// keep listing them for a receiver the user is still writing.
		if (typeContainsUnknown(baseType)) {
			commitContextualFunctionTypes(lastRecording)

			reportUndecidedReceiverType(
				node,
				baseType,
				null,
				resolvedMethods.map((method) => method.namespace.name),
			)

			return resolveFailedMethodInvocation()
		}

		// NOTE: The Namespaces here are the raw, unspecialized ones the Scope
		// holds, so a generic candidate still spells its target with its own
		// Generics — which is what the specificity order compares.
		resolvedMethods = filterMostSpecificByTarget(
			resolvedMethods,
			(candidate) => candidate.namespace.type,
		)
	}

	if (resolvedMethods.length === 0) {
		// NOTE: The covering Namespace has the Method but its overloads
		// reject the Arguments — per-member dispatch may still accept them,
		// since each member is matched with its own receiver Type.
		if (baseType.type === "UnionType") {
			return resolveUnionMethodDispatch(
				node,
				baseType,
				scope,
				typer,
				matchingNamespaces,
			)
		}

		// NOTE: No candidate to commit, so the last probe's recordings stand
		// in: the Invocation is an Error either way, and a literal left with no
		// recording at all would report its Parameters as uninferable on top of
		// the Diagnostic below.
		commitContextualFunctionTypes(lastRecording)

		reportNoMatchingOverload(node, matchingNamespaces, baseType)

		return resolveFailedMethodInvocation()
	} else if (resolvedMethods.length === 1) {
		let resolvedMethod = resolvedMethods[0]

		commitContextualFunctionTypes(resolvedMethod.recording)

		// NOTE: Unbound Type Parameters are only reported for the selected
		// candidate — losing overloads and Namespaces must not leak
		// Diagnostics.
		reportUnboundGenerics(
			resolvedMethod.unboundGenerics,
			node.position,
			typer,
		)

		// NOTE: The Overload was selected while this Namespace was probed; what
		// that selection reported becomes the call's Diagnostics now that the
		// Namespace is the one being committed.
		for (let diagnostic of resolvedMethod.selectionDiagnostics) {
			report(diagnostic)
		}

		return {
			namespace: resolvedMethod.namespace,
			type: resolvedMethod.type,
			overloadedMethodIndex: resolvedMethod.overloadedMethodIndex,
			conformances: resolvedMethod.conformances,
			omittedParameterIndices: resolvedMethod.omittedParameterIndices,
			// NOTE: A direct `is`/`isNot` on a generic Choice widens at emission
			// — the descriptor its runtime helper follows is recovered from the
			// receiver's Choice, whose DECLARED Alias the applied receiver Type
			// erased.
			derivedDescriptor:
				resolvedMethod.namespace.name === derivedEquatableNamespaceName
					? (derivedEquatableDescriptorFor(
							baseType,
							scope,
							node.position,
						) ?? undefined)
					: undefined,
			dispatch: null,
		}
	} else {
		// NOTE: As above — an ambiguity leaves no winner, so the last probe's
		// recordings stand in rather than none at all.
		commitContextualFunctionTypes(lastRecording)

		reportAmbiguousNamespace(
			node,
			resolvedMethods.map((method) => method.namespace.name),
		)

		return resolveFailedMethodInvocation()
	}
}

// NOTE: Per-member dispatch for a Union-typed receiver — the Method is
// resolved statically for every member Type, and the Invocation is only
// valid when every member resolves unambiguously. Its Type is the Union of
// the branch return Types. The receiver's actual Type picks the branch at
// runtime, so more specific member Types are ordered first — an open Record
// member would otherwise swallow values of any member assignable to it.
function resolveUnionMethodDispatch(
	node: parser.MethodInvocationNode,
	unionType: common.UnionType,
	scope: enricher.Scope,
	typer: ArgumentTyper,
	// NOTE: The Namespaces that cover the WHOLE Union and declare this Method,
	// when per-member dispatch is being tried as a second chance after their
	// Overloads rejected the Arguments. Empty when the whole-receiver lookup
	// found nothing, which is the other way in here.
	//
	// It decides what a failure says. With a covering Namespace in hand the
	// truth is "the receiver has this Method and the Arguments are wrong", so
	// the report names the receiver as written; without one it is "no member
	// provides this Method", and naming the member is the whole point. Reporting
	// the member either way was how `firstItem()::value(withDefault 0)` on an
	// `Optional<Rational>` came to say `for Optional#Value` — a Case the writer
	// never mentioned.
	coveringNamespaces: Map<string, common.NamespaceType> = new Map(),
): ResolvedMethodInvocation {
	let members = flattenUnionMembers(unionType)
	let dispatchCases: Array<common.DispatchCase> = []
	let caseReturnTypes: Array<common.Type> = []

	for (let [memberIndex, memberType] of members.entries()) {
		let namespaces = resolveMethodLookupNamespacesForReceiverType(
			memberType,
			node.namespaceSpecifier,
			scope,
		)

		let { instanceNamespaces: matchingNamespaces, staticNamespaces } =
			partitionInstanceMethodNamespaces(
				node.member.content,
				namespacesDeclaringMethod(
					node.member.content,
					namespaces,
					memberType,
					scope,
				),
			)

		if (matchingNamespaces.size === 0) {
			// NOTE: As for a non-Union receiver — this member's Method exists
			// and is called on its Namespace, which is not the same as the
			// member not providing it at all.
			if (staticNamespaces.size > 0) {
				reportStaticMethodOnValue(
					node,
					unionType,
					memberType,
					staticNamespaces,
				)

				return resolveFailedMethodInvocation()
			}

			// NOTE: A covering Namespace declares the Method — this member
			// simply does not, which is not what went wrong. What went wrong is
			// the Arguments, and the receiver they were passed to is the Union
			// as written.
			if (coveringNamespaces.size > 0) {
				reportNoMatchingOverload(node, coveringNamespaces, unionType)

				return resolveFailedMethodInvocation()
			}

			// NOTE: The near miss is looked for on the Namespaces that target
			// the WHOLE Union, not on this member's — a covering Namespace is
			// the likeliest thing a mistyped call meant, and it is exactly
			// where per-member dispatch does not look. `Optional` is the
			// everyday case: `firstItem()::hasValu()` reaches here because no
			// Case declares the name, and the Method it meant is one letter
			// away on the Namespace over both Cases.
			let suggestion = closestMatch(
				node.member.content,
				methodNamesOf(
					resolveMethodLookupNamespacesForReceiverType(
						unionType,
						node.namespaceSpecifier,
						scope,
					),
				),
			)

			reportError(
				`No Method named '${node.member.content}' for ${describeType(memberType)}`,
				node.member.position,
				{
					code: "unknown-method",
					labels: [
						primary(
							node.member.position,
							`${describeType(memberType)} has no Method of this name`,
						),
						secondary(
							node.base.position,
							`this is ${withArticle(describeType(unionType))}`,
						),
					],
					notes: [
						`Every member of the Union must provide '${node.member.content}' — the receiver's Type is only known at runtime.`,
					],
					helps:
						suggestion === null
							? []
							: [`Did you mean '${suggestion}'?`],
					...suggestionData(suggestion),
				},
			)

			return resolveFailedMethodInvocation()
		}

		let resolvedMethods = []
		// NOTE: As in `resolveMethodInvocation` — every Namespace is probed
		// before one is selected, so what a probe recorded for a contextually
		// typed Function literal Argument is held aside until this member's
		// branch has picked its Namespace.
		let lastRecording: ContextualFunctionTypeRecording | undefined

		for (let [namespaceName, namespaceType] of matchingNamespaces) {
			let { result: resolvedMethod, recording } =
				probeContextualFunctionTypes(() =>
					resolveInvokedMethodInNamespace(
						node,
						namespaceType,
						unionType,
						scope,
						typer,
						memberType,
					),
				)

			lastRecording = recording

			if (resolvedMethod) {
				resolvedMethods.push({
					namespaceName,
					namespaceType,
					recording,
					...resolvedMethod,
				})
			}
		}

		if (resolvedMethods.length > 1) {
			// NOTE: As in `resolveMethodInvocation` — a member Type with an
			// undecided slot in it must not have its Namespace picked for it by
			// the order.
			if (typeContainsUnknown(memberType)) {
				commitContextualFunctionTypes(lastRecording)

				reportUndecidedReceiverType(
					node,
					unionType,
					memberType,
					resolvedMethods.map((method) => method.namespaceName),
				)

				return resolveFailedMethodInvocation()
			}

			resolvedMethods = filterMostSpecificByTarget(
				resolvedMethods,
				(candidate) => candidate.namespaceType,
			)
		}

		if (resolvedMethods.length === 0) {
			commitContextualFunctionTypes(lastRecording)

			// NOTE: As above — a covering Namespace's rejection is the one
			// worth reporting, since it is the receiver the call was written
			// against.
			if (coveringNamespaces.size > 0) {
				reportNoMatchingOverload(node, coveringNamespaces, unionType)

				return resolveFailedMethodInvocation()
			}

			reportError(
				`No overload of '${node.member.content}' accepts these Arguments for ${describeType(memberType)}`,
				node.position,
				{
					code: "no-matching-overload",
					labels: [
						primary(
							node.position,
							`this call passes ${countOf(node.arguments.length, "Argument")}`,
						),
						secondary(
							node.base.position,
							`${describeType(memberType)} is a member of this Union`,
						),
					],
					notes: describeCandidateSignatures(
						node,
						matchingNamespaces,
						memberType,
					),
				},
			)

			return resolveFailedMethodInvocation()
		}

		if (resolvedMethods.length > 1) {
			commitContextualFunctionTypes(lastRecording)

			reportError(
				`'${node.member.content}' is provided by more than one Namespace for ${describeType(memberType)}`,
				node.position,
				{
					code: "ambiguous-namespace",
					labels: [
						primary(
							node.member.position,
							"these Arguments match all of them",
						),
					],
					notes: resolvedMethods.map(
						(method) =>
							`'${method.namespaceName}' declares '${node.member.content}'.`,
					),
					helps: [
						`Name the Namespace at the call, e.g. '${resolvedMethods[0].namespaceName}::${node.member.content}(…)'.`,
					],
				},
			)

			return resolveFailedMethodInvocation()
		}

		let resolvedMethod = resolvedMethods[0]

		// NOTE: One recording per member, each committed as its branch is
		// settled — so the Invocation's own Argument Nodes, enriched once when
		// this returns, are typed by the LAST branch that resolved them. That is
		// a choice about the shared Nodes only: a contextually typed literal
		// means whatever the branch it is passed to says it means, and the copy
		// each branch keeps below is what the emitted dispatch actually hands
		// it. The last branch's typing stands for the shared Node because it has
		// to stand for something and every branch that cares carries its own.
		commitContextualFunctionTypes(resolvedMethod.recording)

		// NOTE: Unbound Type Parameters depend on the Arguments, which every
		// branch shares — reporting them for the first member only keeps the
		// Diagnostic from repeating per member.
		if (memberIndex === 0) {
			reportUnboundGenerics(
				resolvedMethod.unboundGenerics,
				node.position,
				typer,
			)
		}

		// NOTE: As in `resolveMethodInvocation` — the branch's own selection
		// Diagnostics, replayed now that its Namespace is settled. Every branch
		// selects against the same Arguments, so a shared failure deduplicates to
		// one report.
		for (let diagnostic of resolvedMethod.selectionDiagnostics) {
			report(diagnostic)
		}

		dispatchCases.push({
			memberType,
			namespaceName: resolvedMethod.namespaceName,
			overloadedMethodIndex: resolvedMethod.overloadedMethodIndex,
			conformances: resolvedMethod.conformances,
			omittedParameterIndices: resolvedMethod.omittedParameterIndices,
			contextualArguments: contextualArgumentsForBranch(
				node,
				scope,
				resolvedMethod.recording,
			),
			// NOTE: A branch resolving to a generic Choice's derived `is`/`isNot`
			// widens the same way a direct call does — the descriptor recovered
			// from this member's Choice.
			derivedDescriptor:
				resolvedMethod.namespaceName === derivedEquatableNamespaceName
					? (derivedEquatableDescriptorFor(
							memberType,
							scope,
							node.position,
						) ?? undefined)
					: undefined,
		})
		caseReturnTypes.push(resolvedMethod.returnType)
	}

	let catchAllCases = dispatchCases.filter((dispatchCase) =>
		isRuntimeCatchAllType(dispatchCase.memberType),
	)

	if (catchAllCases.length > 1) {
		reportError(
			`'${node.member.content}' can not be dispatched on this value`,
			node.position,
			{
				code: "undispatchable-method",
				labels: [
					primary(
						node.base.position,
						`this is ${withArticle(describeType(unionType))}`,
					),
				],
				notes: [
					`${countOf(catchAllCases.length, "member Type")} of the Union are indistinguishable at runtime: ${catchAllCases
						.map((dispatchCase) =>
							describeType(dispatchCase.memberType),
						)
						.join(", ")}.`,
				],
				helps: [
					"Narrow the value with a Match Expression before calling the Method.",
				],
			},
		)

		return resolveFailedMethodInvocation()
	}

	return {
		namespace: placeholderNamespace(),
		type: buildUnion(mergeUnionMembers(caseReturnTypes)),
		overloadedMethodIndex: null,
		conformances: [],
		// NOTE: Held on each branch instead — every branch resolves to a
		// different Method, so there is no one answer here.
		omittedParameterIndices: [],
		dispatch: orderDispatchCasesBySpecificity(dispatchCases),
	}
}

// NOTE: The Arguments a dispatch branch needs a copy of its own — a Function
// literal that omitted its annotations, which is the only Expression whose Type
// the Method it is passed to decides. Each is enriched again under the branch's
// own recording, so its Parameters are the Types THIS branch's Method declared
// and its body resolves against them: the same `(item) { <- item::label() }`
// compiles to a call on one Namespace's `label` for one branch and on another's
// for the next, and the runtime hands each branch the copy that was compiled
// for it. Nothing else in the Invocation reads its context, so nothing else is
// copied — a literal nested inside another Argument is typed by the Function
// IT is passed to, which no branch changes.
//
// NOTE: Enriching a body per branch is what lets a Diagnostic that holds for one
// branch only be reported at all: until now a literal was compiled against one
// Method and passed to every branch, so what its body meant to the other
// branches was never asked. Every member of a Union must provide what is asked
// of it, so a body that does not compile against a member's Method is an error
// about the call. Diagnostics deduplicate, so a fault every branch shares is
// still reported once.
function contextualArgumentsForBranch(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
	recording: ContextualFunctionTypeRecording,
): common.DispatchCase["contextualArguments"] {
	let contextualArguments: common.DispatchCase["contextualArguments"] = []

	for (let [index, argument] of node.arguments.entries()) {
		if (
			argument.value.nodeType !== "FunctionValue" ||
			!needsContext(argument.value.value)
		) {
			continue
		}

		let value = withContextualFunctionTypes(recording, () =>
			enrichExpression(argument.value, scope),
		)

		contextualArguments.push({
			index,
			argument: {
				nodeType: "Argument",
				name: argument.name ? argument.name.content : null,
				value,
				type: value.type,
			},
		})
	}

	return contextualArguments
}

// NOTE: Is `dispatchCase` the branch that has to be tried FIRST of the two —
// every value the runtime would hand to it would also be accepted by `other`,
// but not the other way round. A runtime catch-all accepts every value there
// is, so anything else outranks it without the Types being compared at all.
function dispatchCaseIsMoreSpecific(
	dispatchCase: common.DispatchCase,
	other: common.DispatchCase,
): boolean {
	let caseIsCatchAll = isRuntimeCatchAllType(dispatchCase.memberType)
	let otherIsCatchAll = isRuntimeCatchAllType(other.memberType)

	if (caseIsCatchAll !== otherIsCatchAll) {
		return otherIsCatchAll
	}

	return (
		matchesType(other.memberType, dispatchCase.memberType) &&
		!matchesType(dispatchCase.memberType, other.memberType)
	)
}

// NOTE: `dispatchMethod` takes the FIRST branch whose member Type the receiver
// matches, and that match is open — a Record value "may carry more besides",
// so `{ width: Integer }` accepts a `{ width: Integer, height: Integer }`.
// Every branch must therefore stand before the branches that would swallow it.
//
// A `sort` can not do this: "strictly more specific" is a PARTIAL order, its
// comparator has to answer 0 for the incomparable pairs, and `sort` only ever
// compares the pairs its own algorithm reaches. With an incomparable member
// (`Boolean`) sitting between an open Record and the more specific Record it
// swallows, the two are never compared and the array keeps declaration order —
// which made a Union's runtime behaviour depend on how its members were
// spelled. Emitting each branch after everything strictly more specific than it
// compares every pair that matters, and walking the branches in declaration
// order keeps the rest of the order — and the emitted code — stable.
function orderDispatchCasesBySpecificity(
	dispatchCases: Array<common.DispatchCase>,
): Array<common.DispatchCase> {
	let ordered: Array<common.DispatchCase> = []
	let placed = new Set<common.DispatchCase>()

	function place(dispatchCase: common.DispatchCase): void {
		if (placed.has(dispatchCase)) {
			return
		}

		// NOTE: Marked before the recursion rather than after, so that a
		// relation that somehow cycles terminates here instead of overflowing
		// the stack. A cycle can not arise from the definition above — it takes
		// two Types each strictly more specific than the other — which is
		// exactly why nothing but termination has to be salvaged.
		placed.add(dispatchCase)

		for (let other of dispatchCases) {
			if (
				other !== dispatchCase &&
				dispatchCaseIsMoreSpecific(other, dispatchCase)
			) {
				place(other)
			}
		}

		ordered.push(dispatchCase)
	}

	for (let dispatchCase of dispatchCases) {
		place(dispatchCase)
	}

	return ordered
}

// NOTE: `isValueOfType` answers true for every value on these — such a
// member can only ever be the last dispatch branch, and two of them can not
// coexist in one dispatched Union.
function isRuntimeCatchAllType(type: common.Type): boolean {
	return type.type === "GenericUse" || type.type === "Unknown"
}

// NOTE: An Identifier callee names itself and a `Namespace.method` Lookup
// spells both halves; anything else that answers with a Function has no one
// name to give, and the Position the Diagnostic carries says which call is
// meant either way. The Validator's own `describeCallee` stops at the
// Identifier and says "This call" for everything else — it names a callee only
// inside "This is a bug in the Compiler" messages, which nobody reads for the
// signature they should have passed.
function describeInvocationCallee(name: parser.ExpressionNode): string {
	if (name.nodeType === "Identifier") {
		return `'${name.content}'`
	}

	if (name.nodeType === "Lookup" && name.base.nodeType === "Identifier") {
		return `'${name.base.content}.${name.member.content}'`
	}

	return "This callee"
}

function resolveFunctionInvocation(
	node: parser.FunctionInvocationNode,
	nameType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
): {
	type: common.Type
	conformances: Array<common.Conformance>
	// NOTE: Which overload the Arguments picked, or null when the callee is not
	// overloaded. The Simplifier reads it to mangle the callee to `__overload$N`
	// — for an Identifier callee (an overloaded free Function) as much as for a
	// `Namespace.method` Lookup.
	overloadedMethodIndex: number | null
	omittedParameterIndices: Array<number>
} {
	const type = nameType

	if (
		type.type === "Function" ||
		type.type === "SimpleMethod" ||
		type.type === "StaticMethod"
	) {
		let matchableArguments: Array<MatchableArgument> = node.arguments.map(
			(argument) => ({
				name: argument.name?.content ?? null,
				getType: (expectedType, bindings) =>
					typer.getType(argument.value, expectedType, bindings),
				bindsNothing: bindsNoTypeParameter(argument),
			}),
		)

		// NOTE: A callee without an `overload` block is its own single
		// candidate — one signature to match, one set of bounds to solve and
		// one set of bindings to keep is what `selectOverload` does for one
		// Overload, so both callee shapes take the same path and can not drift.
		// The same reasoning already puts a SimpleMethod through it, see
		// `resolveInvokedMethodInNamespace`.
		let selected = selectOverload(
			[type],
			matchableArguments,
			scope,
			node.position,
			typer,
		)

		if (selected !== undefined) {
			reportUnboundGenerics(
				selected.inferred.unboundGenerics,
				node.position,
				typer,
			)

			// NOTE: What selecting this candidate reported was held back until
			// it was known to be the selection; it is the call's to report now.
			for (let diagnostic of selected.diagnostics) {
				report(diagnostic)
			}

			return {
				type: selected.inferred.returnType,
				conformances: selected.conformances,
				overloadedMethodIndex: null,
				omittedParameterIndices:
					selected.inferred.omittedParameterIndices,
			}
		}

		// NOTE: With one candidate a mismatch is not "no Overload accepts these
		// Arguments" but a plain Argument mismatch, which is the Validator's to
		// report against the one signature there is. The Arguments are matched
		// once more all the same: a Function literal that omitted its
		// annotations takes them from the Parameter it is passed to, and
		// matching is what hands each Argument the Parameter's Type to read them
		// off. Every Argument is asked — a probe stops at the first mismatch, so
		// without this the literals behind it were left with no context at all
		// and reported as uninferable, while the identical literal passed to a
		// METHOD resolved fine. The Type Parameters nothing bound are
		// substituted as Errors rather than handed on as Generics no Scope
		// declares.
		let { parameterTypes, context, freshToOriginal } =
			createFreshenedInference(type)

		matchArguments(parameterTypes, matchableArguments, {
			collectAllMismatches: true,
			inference: context,
		})

		return {
			type: substituteInferredReturnType(
				type,
				unfreshenBindings(context.bindings, freshToOriginal),
			).returnType,
			conformances: [],
			overloadedMethodIndex: null,
			omittedParameterIndices: [],
		}
	} else if (
		type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod"
	) {
		const matchableArguments: Array<MatchableArgument> = node.arguments.map(
			(argument) => ({
				name: argument.name?.content ?? null,
				getType: (expectedType, bindings) =>
					typer.getType(argument.value, expectedType, bindings),
				bindsNothing: bindsNoTypeParameter(argument),
			}),
		)

		let selected = selectOverload(
			type.overloads,
			matchableArguments,
			scope,
			node.position,
			typer,
		)

		if (selected !== undefined) {
			reportUnboundGenerics(
				selected.inferred.unboundGenerics,
				node.position,
				typer,
			)

			// NOTE: What selecting this candidate reported was held back until it
			// was known to be the selection; it is the call's to report now.
			for (let diagnostic of selected.diagnostics) {
				report(diagnostic)
			}

			return {
				type: selected.inferred.returnType,
				conformances: selected.conformances,
				overloadedMethodIndex: selected.index,
				omittedParameterIndices:
					selected.inferred.omittedParameterIndices,
			}
		}

		// NOTE: Every candidate is listed the way THIS call writes it — a Method
		// reached through its Namespace passes its receiver as an ordinary first
		// Argument, so unlike the `::` twin nothing is dropped from the
		// signature.
		let callee = describeInvocationCallee(node.name)

		reportError("No overload accepts these Arguments", node.position, {
			code: "no-matching-overload",
			labels: [
				primary(
					node.position,
					`this call passes ${countOf(node.arguments.length, "Argument")}`,
				),
			],
			notes: type.overloads.map(
				(overload) =>
					`${callee} ${describeSignature(overload.parameterTypes)}.`,
			),
		})

		return {
			type: { type: "Error" },
			conformances: [],
			overloadedMethodIndex: null,
			omittedParameterIndices: [],
		}
	} else {
		if (type.type !== "Error") {
			reportError(
				"This Expression is not a Function",
				node.name.position,
				{
					code: "not-a-function",
					labels: [
						primary(
							node.name.position,
							`this is ${withArticle(describeType(type))}`,
						),
					],
				},
			)
		}

		return {
			type: { type: "Error" },
			conformances: [],
			overloadedMethodIndex: null,
			omittedParameterIndices: [],
		}
	}
}

// NOTE: Resolves `ChoiceName#CaseName` to the Case's Type. The Choice's name
// resolves through the ordinary Type scope, so a Type Alias of a Choice works
// too (`type Op = CalculatorOperation` admits `Op#Add`).
export function resolveCaseReference(
	choice: parser.IdentifierNode,
	caseName: parser.IdentifierNode,
	scope: enricher.Scope,
): common.CaseType | common.ErrorType {
	let choiceType = findTypeInScope(choice.content, scope)

	if (choiceType === null) {
		reportError(
			`Type '${choice.content}' is not declared`,
			choice.position,
			{
				code: "unknown-type",
				labels: [primary(choice.position, "no such Type")],
				helps: suggestionHelps(choice.content, scope, "types"),
				...suggestionData(
					suggestionInScope(choice.content, scope, "types"),
				),
			},
		)

		return { type: "Error" }
	}

	if (choiceType.type === "Error") {
		return { type: "Error" }
	}

	// NOTE: A generic Choice is a Generic Alias over the anonymous Union of its
	// Cases — `Step#Done` resolves the DECLARED (still GenericUse-membered)
	// Case out of that body Union, the way a use site would then instantiate it.
	let members =
		choiceType.type === "UnionType"
			? flattenUnionMembers(choiceType)
			: choiceType.type === "GenericAlias" &&
				  choiceType.aliasedType.type === "UnionType"
				? flattenUnionMembers(choiceType.aliasedType)
				: [choiceType]

	let caseType = members.find(
		(member): member is common.CaseType =>
			member.type === "Case" && member.name === caseName.content,
	)

	if (caseType === undefined) {
		reportUnknownCase(
			caseName,
			`'${choice.content}'`,
			members.flatMap((member) =>
				member.type === "Case" ? [member.name] : [],
			),
		)

		return { type: "Error" }
	}

	return caseType
}

// NOTE: The bare form (`#Add({ … })`) resolves the way Method lookup
// resolves its Namespace — every Choice in Type scope is scanned for the
// Case, and only actual ambiguity asks for the prefix. Shadowed Type names
// are skipped, mirroring `getAllNamespacesInScope`.
//
// NOTE: Every Case rather than only the ones spelled a given way, because the
// near miss a failed resolution offers is drawn from the same scan — a
// candidate set narrowed to exact matches has nothing left to suggest from.
function findCaseTypesInScope(scope: enricher.Scope): Array<common.CaseType> {
	let seenTypeNames = new Set<string>()
	let cases = new Map<string, common.CaseType>()
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		for (let [typeName, type] of Object.entries(searchScope.types)) {
			if (seenTypeNames.has(typeName)) {
				continue
			}

			seenTypeNames.add(typeName)

			// NOTE: A generic Choice is a Generic Alias over the anonymous
			// Union of its Cases — a bare `#Continue` scans that body Union too,
			// finding the DECLARED Case the way it finds a plain Choice's.
			let members =
				type.type === "UnionType"
					? flattenUnionMembers(type)
					: type.type === "GenericAlias" &&
						  type.aliasedType.type === "UnionType"
						? flattenUnionMembers(type.aliasedType)
						: [type]

			for (let member of members) {
				if (member.type === "Case") {
					cases.set(`${member.choice}#${member.name}`, member)
				}
			}
		}

		searchScope = searchScope.parent
	}

	return [...cases.values()]
}

export function resolveBareCaseReference(
	caseName: parser.IdentifierNode,
	scope: enricher.Scope,
): common.CaseType | common.ErrorType {
	let casesInScope = findCaseTypesInScope(scope)
	let candidates = casesInScope.filter(
		(candidate) => candidate.name === caseName.content,
	)

	if (candidates.length === 1) {
		return candidates[0]
	}

	if (candidates.length === 0) {
		reportError(
			`No Choice in scope declares a Case '#${caseName.content}'`,
			caseName.position,
			{
				code: "unknown-case",
				labels: [primary(caseName.position, "no such Case")],
				// NOTE: Drawn from every Choice in scope, which is exactly what
				// the message says was searched. The Cases are NOT listed as a
				// note the way a named Choice's are: the scan reaches the whole
				// prelude, and a Diagnostic that prints every Case in the
				// language buries the one line worth reading.
				...caseSuggestion(
					caseName.content,
					casesInScope.map((candidate) => candidate.name),
				),
			},
		)
	} else {
		reportAmbiguousCase(
			caseName,
			candidates.map((candidate) => candidate.choice),
			"in scope",
		)
	}

	return { type: "Error" }
}

// NOTE: Contextual resolution for the bare form — the expected Type of the
// position (a Declaration's annotation, an Assignment's target, the declared
// return Type at a `<-`) is consulted before the scope scan, exactly like a
// Matcher consults the scrutinee. `null` means the context does not pin the
// Case down, and the scan decides.
function resolveCaseInExpectedType(
	caseName: parser.IdentifierNode,
	expectedType: common.Type,
): common.CaseType | common.ErrorType | null {
	let members =
		expectedType.type === "UnionType"
			? flattenUnionMembers(expectedType)
			: [expectedType]

	let candidates = members.filter(
		(member): member is common.CaseType =>
			member.type === "Case" && member.name === caseName.content,
	)

	if (candidates.length === 0) {
		return null
	}

	if (candidates.length > 1) {
		reportAmbiguousCase(
			caseName,
			candidates.map((candidate) => candidate.choice),
			"in the expected Type",
		)

		return { type: "Error" }
	}

	return candidates[0]
}

// NOTE: The payload's Type is asked for rather than handed over, because
// resolving the Case is what decides the Type the payload should be READ under
// — a question only the one position that offers several instantiations of the
// same Case has to ask, and then once per candidate. Asked about the CASE rather
// than about the Type its payload is expected to be, so that the answer can be
// kept per candidate and the candidate that wins can be committed without
// reading its payload a second time.
export type PayloadReader = (under: common.Type) => common.Type | null

export function resolveCaseValueType(
	node: parser.CaseValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
	payloadTypeUnder: PayloadReader = () => null,
): common.CaseType | common.ErrorType {
	if (node.choice === null) {
		if (expectedType !== null) {
			let contextual = resolveCaseInExpectedType(
				node.caseName,
				expectedType,
			)

			if (contextual !== null) {
				return contextual
			}
		}

		let bareCase = resolveBareCaseReference(node.caseName, scope)

		// NOTE: A unit Case of a generic Choice carries no payload to read a Type
		// Argument off, so a bare `#Bare` nothing around decides is exactly as
		// undecided as the prefixed `Holder#Bare` is, and reports as one. It used
		// to resolve to the DECLARED Case and stand: the Choice's own Type
		// Parameters escaped into the Program as raw GenericUses and resurfaced far
		// from here, as an `unsatisfied-bound` about a name nothing applied or as
		// nothing at all.
		//
		// The payload-carrying bare form is untouched — it is the one form whose
		// payload still decides, and the form a Function literal with no written
		// return Type answers with, which is what the standard library's folds are
		// written on (`<- #Done(item)`).
		if (
			bareCase.type === "Case" &&
			bareCase.choiceGenerics !== undefined &&
			Object.keys(bareCase.members).length === 0
		) {
			return reportUndecidedTypeArguments(
				`#${node.caseName.content}`,
				displayChoiceName(bareCase.choice),
				node.caseName.content,
				bareCase.choiceGenerics,
				node.position,
			)
		}

		return bareCase
	}

	return resolvePrefixedCaseValueType(
		node,
		node.choice,
		scope,
		expectedType,
		payloadTypeUnder,
	)
}

// NOTE: A Choice's Type Parameters are APPLIED, never inferred. A prefixed
// construction is therefore decided by exactly two things: the Arguments it
// writes itself (`Holder<Integer>#Bare`) and, failing those, the position it
// stands in — the same annotation, declared return Type or Parameter Type a
// bare `#Bare` already resolves against. Neither is `undecided-type-arguments`.
// The payload is CHECKED against whatever was decided (the Validator's
// `payload-type-mismatch`), and where a position offers several instantiations
// of the one Case it picks which of them is meant, but it never decides an
// Argument of its own: `Holder#Full({ value = 1 })` written where nothing
// expects a Holder is as undecided as `Holder#Bare` is, and used to quietly
// become a `Holder<Integer>` because its payload happened to be one.
//
// The written Arguments win over the position, and the two disagreeing is the
// ordinary mismatch of a value that does not fit where it is put — the
// construction IS a `Holder<Integer>#Bare` and the annotation says otherwise, so
// the assignment is what reports, exactly as for any other value.
//
// A Choice with no Type Parameters has nothing to decide and is never asked —
// `Ordering#Equal` stands anywhere, as does every Case of every plain Choice.
// Writing Arguments at one is still refused, by the application rail itself.
function resolvePrefixedCaseValueType(
	node: parser.CaseValueNode,
	choice: parser.IdentifierNode,
	scope: enricher.Scope,
	expectedType: common.Type | null,
	payloadTypeUnder: PayloadReader,
): common.CaseType | common.ErrorType {
	let declaredCase = resolveCaseReference(choice, node.caseName, scope)

	if (declaredCase.type === "Error") {
		return declaredCase
	}

	if (node.typeArguments !== null) {
		return resolveAppliedCase(
			node.typeArguments,
			declaredCase,
			choice,
			scope,
		)
	}

	if (declaredCase.choiceGenerics === undefined) {
		return declaredCase
	}

	if (expectedType !== null) {
		let decided = decideCaseFromExpectedType(
			declaredCase,
			expectedType,
			payloadTypeUnder,
		)

		if (decided !== null) {
			return decided
		}
	}

	return reportUndecidedTypeArguments(
		`${choice.content}#${node.caseName.content}`,
		choice.content,
		node.caseName.content,
		declaredCase.choiceGenerics,
		node.position,
	)
}

// NOTE: The one Diagnostic all three undecided rails report — the prefixed
// `Holder#Bare`, the bare `#Bare` of a unit Case and the bare `#Full(…)` whose
// payload left a Parameter standing — spelled with the form the source wrote,
// since the annotation that is one way out is written around that very spelling.
// The Choice's name is handed in rather than read off the Case, so the prefixed
// rail keeps naming the Alias the reader wrote where one stood in for the
// Choice.
//
// NOTE: The Choice's own Parameter names stand in for the Arguments in both
// helps — they are what the declaration calls them, so the reader has a name to
// replace rather than an ellipsis to decode.
function reportUndecidedTypeArguments(
	construction: string,
	choiceName: string,
	caseName: string,
	choiceGenerics: Array<common.GenericDeclaration>,
	position: common.Position,
	// NOTE: The payload rail's extra — the Parameters the payload did NOT
	// decide, so the label can say which half of the application is missing
	// rather than claim there is nothing here at all. Absent for the two rails
	// that carry no payload to decide anything with, whose label is unchanged.
	undecided?: Array<common.GenericName>,
): common.ErrorType {
	let parameterNames = choiceGenerics.map((generic) => generic.name)
	let application = `${choiceName}<${parameterNames.join(", ")}>`
	let payloadSuffix = undecided === undefined ? "" : "(…)"

	reportError(
		`Nothing decides the Type Arguments of '${construction}'`,
		position,
		{
			code: "undecided-type-arguments",
			labels: [
				primary(position, undecidedLabel(parameterNames, undecided)),
			],
			notes: [
				`'${choiceName}' takes ${countOf(parameterNames.length, "Type Parameter")}: ${quotedNames(parameterNames)}.`,
				undecided === undefined
					? "A Choice's Type Parameters are applied, never inferred — the payload is checked against them, it does not choose them."
					: "A payload binds only the Type Parameters its own members mention — the rest are applied, at the construction or by the position around it.",
			],
			helps: [
				`Annotate the declaration: 'constant left: ${application} = ${construction}'.`,
				`Or apply the Type Arguments: '${application}#${caseName}${payloadSuffix}'.`,
			],
		},
	)

	return { type: "Error" }
}

// NOTE: What the primary label says under the construction. The two rails with
// no payload say nothing decides them, which is the whole of it there. The
// payload rail says which Parameters the payload DID decide beside the ones it
// left, because a reader looking at `#Stopped({ value = "x" })` can see the
// String going in and needs telling that the OTHER Parameter is the one nothing
// answers for.
function undecidedLabel(
	parameterNames: Array<common.GenericName>,
	undecided: Array<common.GenericName> | undefined,
): string {
	if (undecided === undefined) {
		return "no Type Arguments here, and nothing around it decides them"
	}

	let decided = parameterNames.filter((name) => !undecided.includes(name))

	if (decided.length === 0) {
		return "its payload decides none of them"
	}

	return `its payload decides ${quotedNames(decided)}, and nothing decides ${quotedNames(undecided)}`
}

function quotedNames(names: Array<common.GenericName>): string {
	return names.map((name) => `'${name}'`).join(", ")
}

// NOTE: `Holder<Integer>#Full(…)` — the Type Arguments written at the value.
// Applied through the rail an annotation's `Holder<Integer>` takes, so the arity
// check, the bounds and the refusal of a Type that takes no Arguments are the
// SAME ones, and then the Case is picked out of what came back. A Case the
// applied Choice does not carry is impossible here — the declared Case was found
// in that same Choice — so `null` from the lookup only ever means the application
// itself failed and has already reported.
function resolveAppliedCase(
	typeArguments: Array<parser.TypeDeclarationNode>,
	declaredCase: common.CaseType,
	choice: parser.IdentifierNode,
	scope: enricher.Scope,
): common.CaseType | common.ErrorType {
	// NOTE: Looked up raw rather than resolved, so a Generic Alias does not apply
	// its defaults before these Arguments get a chance to — the same reason
	// `resolveGenericTypeDeclarationType` looks its own base Type up this way. The
	// name is in scope: `resolveCaseReference` just found the Case in it.
	let baseType = findTypeInScope(choice.content, scope) ?? {
		type: "Error" as const,
	}

	let applied = applyTypeArguments(
		baseType,
		typeArguments,
		scope,
		choice.position,
	)

	return instantiatedCaseOf(declaredCase, applied) ?? { type: "Error" }
}

// NOTE: The instantiation the surrounding position decides for a prefixed
// construction — `constant left: Holder<String> = Holder#Bare` is the `Bare` of
// `Holder<String>`, exactly what the bare `#Bare` resolves to there. `null` when
// the position says nothing about this Choice at all, which is the undecided
// state its caller reports.
//
// A Union can offer SEVERAL instantiations of the one Case (`Box<Integer> |
// Box<String>` carries `Box#Full` twice), and then the payload picks which of
// them is meant, the way any value picks the arm of a Union annotation it fits.
// Each is asked what the payload comes out as under ITS members, so a payload
// that is itself a construction is read against a decided Type rather than
// against nothing at all. A payload that fits none leaves the first standing, so
// the mismatch is reported against a concrete instantiation rather than
// swallowed here; a unit Case fits every one of them and takes the first, which
// is the same value under every arm.
function decideCaseFromExpectedType(
	declaredCase: common.CaseType,
	expectedType: common.Type,
	payloadTypeUnder: PayloadReader,
): common.CaseType | null {
	let candidates = unionArmsOf(expectedType).filter(
		(member): member is common.CaseType =>
			member.type === "Case" &&
			member.name === declaredCase.name &&
			member.choice === declaredCase.choice,
	)

	if (candidates.length <= 1) {
		return candidates[0] ?? null
	}

	return (
		candidates.find((candidate) => {
			let payloadType = payloadTypeUnder(candidate)

			if (payloadType === null) {
				return true
			}

			// NOTE: A payload that could not even be READ under a candidate has
			// not fit it. An Error matches everything, which is what keeps one
			// mistake from becoming several — but here it would make the first
			// arm win every time a payload the next arm decides is undecided
			// under this one, which is exactly the question being asked.
			return (
				!typeContainsError(payloadType) &&
				payloadFitsCase(candidate, payloadType)
			)
		}) ?? candidates[0]
	)
}

// NOTE: Whether a payload can stand for an instantiated Case's Record — either
// as written, or through the one-member shorthand `wrapSingleMemberShorthand`
// applies afterwards, so that `Box#Full("hello")` picks `Box<String>` out of a
// `Box<Integer> | Box<String>` rather than being read against Integer first.
function payloadFitsCase(
	caseType: common.CaseType,
	payloadType: common.Type,
): boolean {
	let recordShape: common.RecordType = {
		type: "Record",
		members: caseType.members,
	}

	if (matchesType(recordShape, payloadType)) {
		return true
	}

	let memberNames = Object.keys(caseType.members)

	if (memberNames.length !== 1) {
		return false
	}

	return matchesType(recordShape, {
		type: "Record",
		members: { [memberNames[0]]: payloadType },
	})
}

// NOTE: What a Type offers as its arms, with a nested Union spelled out, so
// `Walk<Integer> | String` offers Walk's Cases as readily as `Walk<Integer>`
// does. A Type that is no Union is its own only arm — every caller here is
// asking "what could a value of this be", and one shape is an answer to that.
function unionArmsOf(type: common.Type): Array<common.Type> {
	return type.type === "UnionType" ? flattenUnionMembers(type) : [type]
}

// NOTE: The scrutinee's own member for a declared Case — the same Choice and
// the same Case name, but with the Type Arguments the matched value applied
// substituted into its payload. `null` when the matched value has no such
// member at all, which its caller reports: the DECLARED Case can not stand in
// for one, because its members are still the Choice's Type Parameters, bounds
// and all, and a Handler reaching through one solves the bound against a hidden
// conformance Parameter no call site in sight ever fills.
function instantiatedCaseOf(
	declaredCase: common.CaseType,
	valueType: common.Type,
): common.CaseType | null {
	return joinCaseInstantiations(
		unionArmsOf(valueType).filter(
			(member): member is common.CaseType =>
				member.type === "Case" &&
				member.name === declaredCase.name &&
				member.choice === declaredCase.choice,
		),
	)
}

// NOTE: One Matcher for several instantiations of the same Case — a scrutinee
// typed `Box<Integer> | Box<String>` carries `Box#Full` twice, and both are
// this Handler's, because the emitted check starts at the tag both of them
// share. So what the Handler may assume of the payload is what EVERY
// instantiation carries: each member joined across them, which makes `@.value`
// an `Integer | String` the Handler has to narrow further before using. Taking
// the first instantiation instead typed the payload by whichever member the
// Union happened to name first, and a `Box<String>`'s String arrived typed
// Integer — `@.value::add(1)` compiled clean and answered "hello1".
//
// NOTE: The joined Case carries no `typeArguments`: the instantiations disagree
// about them, and they are display spelling — the members decide assignability.
function joinCaseInstantiations(
	instantiations: Array<common.CaseType>,
): common.CaseType | null {
	if (instantiations.length === 0) {
		return null
	}

	if (instantiations.length === 1) {
		return instantiations[0]
	}

	let members: Record<string, common.Type> = {}

	for (let name of Object.keys(instantiations[0].members)) {
		members[name] = buildUnion(
			instantiations.flatMap((instantiation) => {
				let member = instantiation.members[name]

				return member === undefined ? [] : [member]
			}),
		)
	}

	return {
		type: "Case",
		choice: instantiations[0].choice,
		name: instantiations[0].name,
		members,
		// NOTE: Whether the Choice's Cases all have empty payloads is a fact
		// about the DECLARATION, which every instantiation being joined here
		// shares — so it survives the join that `typeArguments` does not.
		...(instantiations[0].unitChoice === true
			? { unitChoice: true as const }
			: {}),
	}
}

// NOTE: The Type a value has for ONE member, asked silently. The Lookup
// resolver reports `type-without-members` on a Union base, and a Union base is
// exactly the shape asked here — a Pattern discriminating `Click | KeyPress`
// names members only some arms carry, which is the whole reason to write one.
// Arms without the member contribute nothing.
//
// No arm carrying it answers `Unknown`, which constrains nothing at runtime and
// is the honest degradation for "binds, and says nothing about the Type". It is
// deliberately NOT a Diagnostic here: a Matcher naming a member no arm carries
// makes an arm that can never be taken, and `unreachable-case` is the Validator's
// to report. Where the position can not decline anything — a Parameter, a
// Declaration — the caller asks about the member itself and does report.
function memberTypeOf(type: common.Type, name: string): common.Type {
	let found: Array<common.Type> = []

	for (let arm of unionArmsOf(type)) {
		// NOTE: `Object.hasOwn` before the read — a member named after one of
		// `Object.prototype`'s would otherwise answer with a JavaScript function
		// the arm does not carry.
		let member =
			(arm.type === "Record" || arm.type === "Case") &&
			Object.hasOwn(arm.members, name)
				? arm.members[name]
				: undefined

		if (member !== undefined) {
			found.push(member)
		}
	}

	return found.length === 0 ? { type: "Unknown" } : buildUnion(found)
}

// NOTE: The Type at the end of a Pattern binding's spine — `["state", "total"]`
// walked from the value the Pattern took apart.
function typeAtPath(type: common.Type, path: Array<string>): common.Type {
	return path.reduce(memberTypeOf, type)
}

// NOTE: What a value PROVES by passing a Pattern's requirements — each arm of
// the value's Type that could pass, with the required members merged over its
// declared ones. One Type serves both halves of a Handler: the emitted test
// asks it and the bindings read it, so an `as` binder keeps every member the
// arm proved rather than only the ones the Pattern named. Arms without members
// contribute nothing, and where none is left the requirement stands alone — a
// test nothing passes, which is the arm the Validator can prove unreachable.
function provenPatternType(
	valueType: common.Type,
	required: common.Type,
): common.Type {
	if (required.type !== "Record") {
		return required
	}

	let narrowed = unionArmsOf(valueType).flatMap((arm) =>
		arm.type === "Record" || arm.type === "Case"
			? [{ ...arm, members: { ...arm.members, ...required.members } }]
			: [],
	)

	return narrowed.length === 0 ? required : buildUnion(narrowed)
}

// NOTE: What a Pattern in Matcher position establishes about the value it
// matched. Every member contributes a Type, so `@` is a Record and `@.name`
// works inside the Handler whatever form the member took: a value-constrained
// member takes its literal's Type, an annotated one the Type it wrote, and a
// bare one the Type the VALUE has for that member — a bare member being the
// annotated one with its annotation elided, read off the scrutinee rather than
// off the source.
//
// `literals` is filled with the value-constrained members, keyed by the DOTTED
// SPINE that reaches each one. A member name can not hold a dot, so the two can
// not be confused, and the Rewriter walks the spine to build the member reads
// its test ANDs together. That is what lets a nested Pattern constrain by value
// at all — `case #Rect({ origin as { x = 0 } })`.
function resolvePatternMatcherType(
	pattern: parser.PatternNode,
	valueType: common.Type,
	scope: enricher.Scope,
	literals: Record<string, common.typed.ExpressionNode>,
	path: Array<string> = [],
	// NOTE: Set only where a member the VALUE has not got is a mistake rather
	// than a discrimination. A Matcher over a Union names members only some
	// arms carry — that is what a Record Matcher is FOR — and an arm nothing
	// reaches is the Validator's `unreachable-case`. A Case payload is
	// different: the Validator reads only the tag there, so a member nothing
	// carries would make the arm silently unreachable with nothing said.
	reportUnknownIn: parser.PatternNode | null = null,
): common.Type {
	let members: Record<string, common.Type> = {}

	for (let [name, member] of Object.entries(pattern.members)) {
		let memberPath = [...path, name]

		if (member.kind === "Value") {
			let enrichedValue = enrichExpression(member.value, scope)

			literals[memberPath.join(".")] = enrichedValue
			members[name] = enrichedValue.type

			continue
		}

		let declaredType =
			member.type === null
				? null
				: refuseRefinementMatcher(
						resolveType(member.type, scope),
						member.type.position,
					)

		if (member.binder?.nodeType === "Pattern") {
			// NOTE: A written annotation is what the arm narrows to, and the
			// nested Pattern requires its members ON TOP of it — the two are one
			// requirement, the annotation's arms with the nested requirements
			// merged over them. Keeping only the annotation would drop what the
			// nested Pattern asks, and the arm would run for a value without the
			// very members it reads.
			let memberType = declaredType ?? memberTypeOf(valueType, name)
			let nested = resolvePatternMatcherType(
				member.binder,
				memberType,
				scope,
				literals,
				memberPath,
				reportUnknownIn === null ? null : member.binder,
			)

			members[name] = provenPatternType(memberType, nested)

			continue
		}

		let memberType = declaredType ?? memberTypeOf(valueType, name)

		if (
			reportUnknownIn !== null &&
			declaredType === null &&
			memberType.type === "Unknown" &&
			!typeContainsError(valueType)
		) {
			reportUnknownPayloadMember(member.name, valueType)

			memberType = { type: "Error" }
		}

		members[name] = memberType
	}

	return { type: "Record", members }
}

// NOTE: A name no source could have written, derived from the Position of what
// it stands for. The Lexer reads `_` as a Symbol, so no Essence Identifier holds
// one, and the `$` keeps it clear of the Rewriter's own `_self` — the same
// convention the Optimiser's lowered bindings follow.
//
// Derived from a Position rather than from a counter because a Function
// literal's body is enriched TWICE where its return Type is inferred from it,
// and a counter would mint a different name on each pass.
function synthesizedName(kind: string, position: common.Position): string {
	return `$${kind}_${position.start.line}_${position.start.column}`
}

// NOTE: The Statements a Pattern that can DECLINE a value would need somewhere
// to fall through to. A Matcher has the next arm; a Declaration and a Parameter
// have nothing, so a member matched against a written value is refused there.
//
// A member constrained by TYPE is not refused: in an irrefutable position that
// is an annotation, and it fails as `assignment-type-mismatch` like any other.
function refuseRefutablePattern(
	pattern: parser.PatternNode,
	kind: string,
): void {
	for (let { member } of refutablePatternMembers(pattern)) {
		reportError(
			`A ${kind} can not match a value against a Pattern`,
			member.position,
			{
				code: "refutable-pattern",
				labels: [
					primary(member.position, "this can decline the value"),
				],
				notes: [
					`A Matcher may constrain a member by value, because an arm that declines falls through to the next one. A ${kind} has nowhere to fall through to.`,
				],
				helps: [
					`Write only '${member.name.content}' to bind it, and ask about its value with 'match'.`,
				],
			},
		)
	}
}

// NOTE: What a Pattern binds in an irrefutable position, INCLUDING the members
// that were refused. A refused member still brings its name in — recovery, not
// semantics: the Program does not compile either way, and a body reading
// `width` after the Diagnostic about `{ width = 0 }` must not be told a second
// time that `width` is not declared. The Diagnostic that explains the mistake
// is the one worth reading, and a cascade buries it.
function irrefutablePatternBindings(
	pattern: parser.PatternNode,
): Array<PatternBinding> {
	return [
		...patternBindings(pattern),
		...refutablePatternMembers(pattern).map(({ member, path }) => ({
			name: member.name,
			path,
			// NOTE: A refused member is recovered as if it had been written
			// bare, so the spine ends at its own name and carries no Type.
			steps: path.map((step, index) => ({
				name:
					index === path.length - 1
						? member.name
						: {
								nodeType: "Identifier" as const,
								content: step,
								position: member.name.position,
							},
				type: null,
			})),
			type: null,
			member: member.name,
		})),
	]
}

// NOTE: A binding's value in an irrefutable position — the synthesized base
// Constant, read down the binding's spine. A whole-value binder has an empty
// spine and is therefore the base itself.
//
// The last step carries the MEMBER's span where one was written, so that
// renaming the Record's member rewrites the member and not the name it was
// bound under; every other span is the binder's, which is where a reader's
// cursor is when they ask about it.
function memberPathLookup(
	baseName: string,
	baseType: common.Type,
	binding: PatternBinding,
	type: common.Type,
	basePosition: common.Position,
): common.typed.ExpressionNode {
	let node: common.typed.ExpressionNode = {
		nodeType: "Identifier",
		content: baseName,
		position: basePosition,
		type: baseType,
	}

	let currentType = baseType

	for (let [index, step] of binding.steps.entries()) {
		let isLast = index === binding.steps.length - 1
		let stepType = isLast
			? type
			: memberTypeOf(currentType, step.name.content)

		node = {
			nodeType: "Lookup",
			base: node,
			member: {
				nodeType: "Identifier",
				content: step.name.content,
				// NOTE: The span the step was WRITTEN at, every step of the
				// way. An intermediate step given the innermost binder's span
				// instead made the Language Server index it as an occurrence of
				// the outer member, so renaming `origin` overwrote `x` and `y`.
				position: step.name.position,
				type: stepType,
			},
			position: binding.name.position,
			type: stepType,
		}

		currentType = stepType
	}

	return node
}

// NOTE: One name a Matcher brings into scope, with the spine that reaches it
// from `@` and the Type at the end of that spine. An empty spine is `@` itself,
// which only a payload Pattern's own `as` binder can be.
type MatcherBinding = {
	name: parser.IdentifierNode
	member: parser.IdentifierNode | null
	path: Array<string>
	// NOTE: Where each step of the spine was written — see `selfPathLookup`.
	stepPositions: Array<common.Position>
	type: common.Type
}

// NOTE: Every name a Handler's Matcher binds. Two Matchers bind anything: a
// Pattern binds what its members name, and a Case Matcher binds what its
// payload binder names.
function resolveMatcherBindings(
	node: parser.MatcherNode,
	matcher: common.Type,
	payload: PayloadRequirements | null = null,
): Array<MatcherBinding> {
	if (node.nodeType === "Pattern") {
		return bindingsOf(node, matcher, [])
	}

	if (node.nodeType !== "CaseMatcher" || node.binding === null) {
		return []
	}

	// NOTE: An unresolved Case already reported; adding a second Diagnostic
	// about its payload would bury the one that matters.
	if (matcher.type !== "Case") {
		return []
	}

	if (node.binding.nodeType === "Pattern") {
		// NOTE: Read at what the arm PROVED, not at what the Case declared. The
		// requirements the Handler tests are exactly the narrowing, so
		// `case #Some({ value: Integer })` binds an Integer — the same answer
		// the equivalent Record Matcher gives, which is the whole point of the
		// two spellings meaning one thing.
		let subject = payload ?? {
			subjectType: payloadPatternSubject(node.binding, matcher).type,
			subjectPath: payloadPatternSubject(node.binding, matcher).path,
			memberTypes: null,
		}

		return bindingsOf(
			node.binding,
			subject.subjectType,
			subject.subjectPath.map((step) => ({
				name: {
					nodeType: "Identifier" as const,
					content: step,
					position: node.position,
				},
				type: null,
			})),
		)
	}

	let binding = node.binding
	let memberNames = Object.keys(matcher.members)

	// NOTE: A binder that is one NAME names what the constructor takes, which
	// for a one-member Case is that member's value. A Case with no members has
	// nothing to name, and one with several has nothing SINGLE to name — for
	// those the Pattern form is the answer, and the help says so.
	if (memberNames.length !== 1) {
		reportError(
			`'${describeType(matcher)}' has no single value to bind`,
			binding.position,
			{
				code: "unbindable-case-payload",
				labels: [
					primary(
						binding.position,
						memberNames.length === 0
							? "this Case carries no value"
							: `this Case carries ${countOf(memberNames.length, "value")}`,
					),
				],
				notes: [
					memberNames.length === 0
						? "A binding names the value a Case carries, and this one carries none."
						: `Its values are ${memberNames.map((name) => `'${name}'`).join(", ")}.`,
				],
				helps:
					memberNames.length === 0
						? ["Drop the binding — the Matcher alone is the test."]
						: [
								`Take the payload apart instead: '#${node.caseName.content}({ ${memberNames.join(", ")} })'.`,
							],
			},
		)

		return []
	}

	let memberName = memberNames[0]!

	return [
		{
			name: binding,
			member: null,
			path: [memberName],
			// NOTE: The shorthand's one step is not written anywhere, so it
			// stands at the binder the reader DID write.
			stepPositions: [binding.position],
			type: matcher.members[memberName]!,
		},
	]
}

// NOTE: What a Case Matcher's payload Pattern REQUIRES, keyed by the dotted
// spine that reaches each requirement from the matched value. Without it a
// payload Pattern would say where to read and never what must be there:
// `case #Fired({ x, y })` on a `Fired { payload: Click | KeyPress }` would
// accept every `#Fired` and then read `x` off a KeyPress.
//
// Beside the Matcher rather than inside it, which is the same split
// `memberLiterals` makes and for the same reason: `matcher` says WHICH ARM this
// is, and the Validator reads it to decide both coverage and reachability.
// Narrowing it would claim the Case is only partly handled AND that the Handler
// is dead — the second of which is plainly false.
//
// Only the member the Pattern's own spine reaches is required. Anything deeper
// is already inside that requirement, because a Pattern's Type is a Record whose
// members are Records in turn, and the runtime check walks the whole of it.
//
// The value-constrained members are collected on the way, under the same
// spines — which is where the tie-break shows in the emitted test: the Record
// reading compares `@.width`, the shorthand reading `@.state.index`.
// NOTE: A payload Pattern naming a member no arm of the payload carries. The
// same shape `reportUnknownMember` writes for a Lookup, because it is the same
// mistake — the Pattern reads a member off the payload, and the payload has not
// got one.
function reportUnknownPayloadMember(
	name: parser.IdentifierNode,
	valueType: common.Type,
): void {
	let memberNames = [
		...new Set(
			unionArmsOf(valueType).flatMap((arm) =>
				arm.type === "Record" || arm.type === "Case"
					? Object.keys(arm.members)
					: [],
			),
		),
	]
	let suggestion = closestMatch(name.content, memberNames)

	reportError(
		`'${describeType(valueType)}' has no member '${name.content}'`,
		name.position,
		{
			code: "unknown-member",
			labels: [primary(name.position, "no such member")],
			notes:
				memberNames.length === 0
					? [`'${describeType(valueType)}' has no members.`]
					: [
							`'${describeType(valueType)}' has ${memberNames
								.map((member) => `'${member}'`)
								.join(", ")}.`,
						],
			helps: suggestion === null ? [] : [`Did you mean '${suggestion}'?`],
		},
	)
}

type PayloadRequirements = {
	// NOTE: What the Handler TESTS, keyed by dotted spine.
	memberTypes: Record<string, common.Type> | null
	// NOTE: What the Handler PROVED — where the payload Pattern's bindings are
	// read, and at which Type. A requirement is a narrowing, so an arm that
	// tests `value: Integer` must bind an Integer and not the Union the Case
	// declared: the test and the binding are two halves of one statement.
	subjectPath: Array<string>
	subjectType: common.Type
}

function resolvePayloadRequirements(
	node: parser.CaseMatcherNode,
	caseType: common.Type,
	scope: enricher.Scope,
	literals: Record<string, common.typed.ExpressionNode>,
): PayloadRequirements {
	let fallback = { memberTypes: null, subjectPath: [], subjectType: caseType }

	if (node.binding?.nodeType !== "Pattern" || caseType.type !== "Case") {
		return fallback
	}

	let subject = payloadPatternSubject(node.binding, caseType)
	let required = resolvePatternMatcherType(
		node.binding,
		typeAtPath(caseType, subject.path),
		scope,
		literals,
		subject.path,
		// NOTE: A payload member no arm of the payload carries is a typo, and
		// is reported HERE because nothing downstream can see it: the Validator
		// reads only `matcher`, which for a Case Matcher is the tag. Left
		// silent, the emitted test demanded a member nothing has and the arm
		// simply never ran.
		node.binding,
	)

	if (required.type !== "Record") {
		return {
			...fallback,
			subjectPath: subject.path,
			subjectType: subject.type,
		}
	}

	// NOTE: The SHORTHAND reading requires its one member to be the Record the
	// Pattern describes; the Record reading has no spine of its own and
	// requires each named member individually.
	//
	// A requirement the DECLARED Type already guarantees is dropped, and that
	// is what keeps the everyday `case #Rectangle({ width, height })`
	// unconditional: naming members the Case itself declares asks nothing new,
	// so the arm still retires its Case and a Match over a Choice stays
	// exhaustive without a `case _`. Only a Pattern that asks for MORE than the
	// Case promises — the union-typed payload it can decline — makes it
	// conditional.
	let requirements: Record<string, common.Type> = {}
	let require = (path: string, requiredType: common.Type) => {
		if (!matchesType(requiredType, typeAtPath(caseType, path.split(".")))) {
			requirements[path] = requiredType
		}
	}

	if (subject.path.length > 0) {
		require(subject.path.join("."), required)
	} else {
		for (let [name, memberType] of Object.entries(required.members)) {
			require(name, memberType)
		}
	}

	return {
		memberTypes: Object.keys(requirements).length > 0 ? requirements : null,
		subjectPath: subject.path,
		// NOTE: What the arm proved about the payload — the subject's declared
		// arms with the Pattern's requirements merged over them, so the bindings
		// below read the narrowed Types AND an `as` binder keeps the declared
		// members the Pattern did not name.
		subjectType: provenPatternType(subject.type, required),
	}
}

// NOTE: Which of the two readings a payload Pattern is. Construction faces the
// same fork — `#Done(x)` and `#Done({ value = x })` are two spellings of one
// value — and answers it by trying the payload Record first; the Matcher
// mirrors that, so a reader who knows how a value is built knows how it comes
// apart. The question is different only in what it can ask: a Pattern carries no
// Type to compare, so it asks whether the Case carries the members the Pattern
// names.
//
// The Record reading is also what a Case with any number of members but one
// gets, because the shorthand exists only for a one-member Case. A member the
// Case does not carry then answers `Unknown` and shows up as an arm the
// Validator can prove unreachable, which is the same answer a Record Matcher
// naming a stray member has always given.
function payloadPatternSubject(
	pattern: parser.PatternNode,
	matcher: common.CaseType,
): { path: Array<string>; type: common.Type } {
	let memberNames = Object.keys(matcher.members)
	let fitsPayloadRecord = Object.keys(pattern.members).every((name) =>
		Object.hasOwn(matcher.members, name),
	)

	if (fitsPayloadRecord || memberNames.length !== 1) {
		return { path: [], type: matcher }
	}

	let memberName = memberNames[0]!

	return { path: [memberName], type: matcher.members[memberName]! }
}

// NOTE: `patternBindings` decides WHICH names a Pattern brings in and under
// which spine; this only has to say what each one's Type is. `subjectType` is
// the Type at the end of `prefix`, so a binding's own steps are the ones past
// it.
//
// The prefix is a step the SOURCE DID NOT WRITE — the one member a one-member
// Case carries, which the shorthand reading walks through without naming. It
// stands at the Matcher's own Position, because that is the nearest thing a
// reader could point at.
function bindingsOf(
	pattern: parser.PatternNode,
	subjectType: common.Type,
	prefix: Array<PatternStep>,
): Array<MatcherBinding> {
	return patternBindings(pattern, prefix).map((binding) => ({
		name: binding.name,
		member: binding.member,
		path: binding.path,
		stepPositions: binding.steps.map((step) => step.name.position),
		type: typeAtPath(subjectType, binding.path.slice(prefix.length)),
	}))
}

// NOTE: The Scope a Guard is enriched in when its Handler binds anything. Each
// name is declared for real — shadowing a Namespace, refusing reassignment —
// but resolves through `selfMemberAliases` into the `@.member` spine it stands
// for rather than through the body's Constant, which does not exist where a
// Guard runs. A Scope of its own so that the body's Constants are still the
// body's, declared in the Scope the body is enriched in and reported against
// whatever they collide with there.
function scopeLendingBindings(
	bindings: Array<MatcherBinding>,
	matcher: common.Type,
	bodyScope: enricher.Scope,
): enricher.Scope {
	let guardScope = childScope(bodyScope, {
		selfMemberAliases: Object.fromEntries(
			bindings.map((binding) => [
				binding.name.content,
				{
					path: binding.path,
					stepPositions: binding.stepPositions,
					selfType: matcher,
				},
			]),
		),
	})

	for (let binding of bindings) {
		declareVariableInScope(binding.name, binding.type, guardScope, true)
	}

	return guardScope
}

// NOTE: Desugared into the Constants an author could have written —
// `constant item = @.item` at the head of the arm — so the Simplifier, the
// Rewriter and every walker downstream see nothing new.
//
// NOTE: `narrowings` holds what the Handler's Guard proved about a binding, and
// it is what the SCOPE holds while the body is enriched. The Statement keeps the
// Matcher's own Type, because a refinement is evidence the Enricher carries and
// never something the emitted Program has heard of — which is the shape a
// narrowing takes everywhere: a Scope entry the body reads, and a typed tree that
// says what it always said.
function declareMatcherBindings(
	bindings: Array<MatcherBinding>,
	matcher: common.Type,
	bodyScope: enricher.Scope,
	narrowings: Map<string, common.RefinementType>,
): Array<common.typed.ImplementationNode> {
	return bindings.map((binding) => {
		declareVariableInScope(
			binding.name,
			narrowings.get(binding.name.content) ?? binding.type,
			bodyScope,
			true,
		)

		return {
			nodeType: "ConstantDeclarationStatement",
			name: {
				nodeType: "Identifier",
				content: binding.name.content,
				position: binding.name.position,
				type: binding.type,
			},
			value: selfPathLookup(
				binding.path,
				binding.type,
				matcher,
				binding.name.position,
				binding.stepPositions,
			),
			position: binding.name.position,
			headPosition: binding.name.position,
			declaredType: null,
			type: binding.type,
			documentation: null,
			synthesized: "binding",
		} satisfies common.typed.ConstantDeclarationStatementNode
	})
}

// NOTE: A `Self` Node at the bottom, not an Identifier spelled "@" — the
// Rewriter escapes an Identifier as a user name, and inside a lifted Handler the
// scrutinee is the `_self` Parameter.
//
// `memberPosition` is where the LAST step of the spine was written, which is a
// different span from the binding's own name wherever `as` renamed it. The
// Language Server reads a member Lookup off this tree to join a Pattern member
// to the Record member it reads, so handing it the binder's span would make
// renaming the member rewrite the binder's text instead.
function selfPathLookup(
	path: Array<string>,
	type: common.Type,
	selfType: common.Type,
	position: common.Position,
	// NOTE: Where each step of the spine was WRITTEN, where the caller knows —
	// a Matcher's bindings do, a Guard's lent alias does not, because the alias
	// stands for a Lookup nobody wrote. Every step given the same span would
	// make the Language Server index an intermediate member as an occurrence of
	// the binder, and renaming the member would overwrite the binder's text.
	stepPositions?: Array<common.Position>,
): common.typed.ExpressionNode {
	let base: common.typed.ExpressionNode = {
		nodeType: "Self",
		position,
		type: selfType,
	}

	let baseType = selfType

	for (let [index, step] of path.entries()) {
		let isLast = index === path.length - 1
		let stepType = isLast ? type : memberTypeOf(baseType, step)

		base = {
			nodeType: "Lookup",
			base,
			member: {
				nodeType: "Identifier",
				content: step,
				position: stepPositions?.[index] ?? position,
				type: stepType,
			},
			position,
			type: stepType,
		}

		baseType = stepType
	}

	return base
}

// NOTE: A bare Case Matcher (`case #Add`) resolves against the matched
// value's own Union — the Case's name never has to be in scope by itself.
// Ambiguity (two Choices in one Union sharing a Case name) asks for the
// prefixed form instead of guessing.
export function resolveCaseMatcherType(
	node: parser.CaseMatcherNode,
	valueType: common.Type,
	scope: enricher.Scope,
): common.Type {
	if (node.choice !== null) {
		let declaredCase = resolveCaseReference(
			node.choice,
			node.caseName,
			scope,
		)

		if (declaredCase.type === "Error") {
			return declaredCase
		}

		// NOTE: The prefix only says WHICH Choice's Case is meant — never with
		// which Type Arguments. A generic Choice's DECLARED Case still carries
		// its Type Parameters (`Walk#Done` is `{ value: Result }`), and the
		// scrutinee is what applied them, so `@` binds to the matching member of
		// the scrutinee's own Union, exactly as the bare form does. Written out,
		// `case Walk#Done` left `@.value` an opaque `Result` while the identical
		// `case #Done` narrowed it to Integer — and the prefix is the form the
		// ambiguity Diagnostic asks for.
		let instantiated = instantiatedCaseOf(declaredCase, valueType)

		if (instantiated !== null) {
			return instantiated
		}

		// NOTE: The prefix names a Case the matched value can not be, which the
		// bare form says outright and this one used to answer with the declared
		// Case instead — a Handler that can never run, typed by Type Parameters
		// nothing here binds.
		if (!typeContainsError(valueType)) {
			reportError(
				`The matched value has no Case '${node.choice.content}#${node.caseName.content}'`,
				node.position,
				{
					code: "unknown-case",
					labels: [
						primary(node.position, "no such Case in this Union"),
					],
					notes: [`The matched value is ${describeType(valueType)}.`],
				},
			)
		}

		return { type: "Error" }
	}

	if (valueType.type === "Error") {
		return { type: "Error" }
	}

	let members = unionArmsOf(valueType)

	let candidates = members.filter(
		(member): member is common.CaseType =>
			member.type === "Case" && member.name === node.caseName.content,
	)

	// NOTE: Several candidates of ONE Choice are instantiations of the same
	// Case, which no Matcher can tell apart at runtime — they are joined, the
	// way the prefixed form joins them. Only candidates of DIFFERENT Choices
	// are an ambiguity the prefix can resolve.
	if (
		candidates.length > 0 &&
		new Set(candidates.map((candidate) => candidate.choice)).size === 1
	) {
		return joinCaseInstantiations(candidates) ?? { type: "Error" }
	}

	if (candidates.length === 0) {
		// NOTE: De-duplicated by name, because the matched Union may be
		// `A | B` with both Choices declaring the same Case — which is the
		// `ambiguous-case` branch below when it IS the name written, and
		// nothing but a repeated entry in this list when it is not.
		let memberCaseNames = [
			...new Set(
				members.flatMap((member) =>
					member.type === "Case" ? [member.name] : [],
				),
			),
		]

		// NOTE: The name alone, not the whole Matcher — a Quick Fix rewrites
		// exactly what the Diagnostic underlines, and the `#` the reader
		// already wrote is not part of the near miss.
		reportError(
			`The matched value has no Case '#${node.caseName.content}'`,
			node.caseName.position,
			{
				code: "unknown-case",
				labels: [
					primary(
						node.caseName.position,
						"no such Case in this Union",
					),
				],
				notes:
					memberCaseNames.length === 0
						? []
						: [
								`The matched value declares ${memberCaseNames
									.map((name) => `'#${name}'`)
									.join(", ")}.`,
							],
				...caseSuggestion(node.caseName.content, memberCaseNames),
			},
		)
	} else {
		reportAmbiguousCase(
			node.caseName,
			candidates.map((candidate) => candidate.choice),
			"in the matched Union",
		)
	}

	return { type: "Error" }
}

export function resolveFunctionValueType(
	node: parser.FunctionValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
	bindings: GenericBindings | null = null,
): common.FunctionType {
	return resolveFunctionDefinitionType(
		node.value,
		scope,
		expectedType,
		bindings,
	)
}

// NOTE: The Enricher builds a Function literal's typed Nodes in a separate
// pass from the one that matched it against a signature, so the Types its
// omitted annotations resolved to have to be read back rather than worked out
// again — there is no expected Type left to work them out from.
//
// A literal that is not an Argument was never matched against anything, so
// nothing recorded it. Its annotations can only have come from its own body,
// and this is the first and last chance to work them out.
export function contextualFunctionTypeOf(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.FunctionType | undefined {
	let recorded = recordedContextualFunctionType(node)

	if (recorded !== undefined) {
		return decidedContextualFunctionType(node, scope, recorded)
	}

	if (!needsContext(node)) {
		return undefined
	}

	return resolveFunctionDefinitionType(node, scope)
}

// NOTE: The literal read back as the FINISHED call decided its position, rather
// than as the match could see it while it was still running. A callback is
// matched before the call has solved every Type Parameter — the general `loop`
// entry's `step` is matched against `(_: State) -> Step<State, Result>` with
// `Result` bound by nothing but this very literal — and a return Type that still
// carries one is no context at all, so the literal fell back to reading its own
// body. Reading it off the body loses whatever the position DID say: a `<-
// #Done(item)` decided `Step`'s `Result` from its payload and left `State`
// standing as the Choice's own Parameter, which is the undecided Type the body
// then enriched against.
//
// So the position is re-read once the call has committed and its bindings are
// final, and only when they turn a position the match left open into a decided
// one — the literal is resolved again against that, and the second resolution is
// what the enrichment pass reads. Silent, because everything a resolution of
// this literal can report was reported when it was matched: a decided expected
// Type resolves a superset of the annotations the open one did, so this pass has
// only fewer things to say, never more.
function decidedContextualFunctionType(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
	recorded: RecordedContextualFunctionType,
): common.FunctionType {
	if (
		recorded.expectedType === null ||
		recorded.bindings === null ||
		!mentionsUnsolvedTypeParameter(recorded.expectedType)
	) {
		return recorded.resolved
	}

	let decided = applyGenericBindings(recorded.expectedType, recorded.bindings)

	// NOTE: Still open, so the call never decided it and the body stays the only
	// thing that could — `map`'s `(_ item: ItemType) -> Result` where the literal
	// itself is what binds `Result`.
	if (mentionsUnsolvedTypeParameter(decided)) {
		return recorded.resolved
	}

	let { result } = collectDiagnostics(() =>
		resolveFunctionDefinitionType(node, scope, decided, recorded.bindings),
	)

	return result
}

// NOTE: What a contextually typed Function literal resolved to, and the position
// it was resolved against. It is worked out while the invocation's signature is
// being matched — the only moment the expected Type is known — and read back
// when the same Node is enriched, which happens separately and without that
// context. Keyed by the Node, so a re-parse starts empty and nothing has to be
// invalidated.
//
// NOTE: The position is kept with the call's bindings rather than substituted on
// the spot, for the same reason a prefixed Case construction's is: the Map is
// the one the match keeps filling, so reading the record back once the call has
// finished reads the position as the call finally decided it. `expectedType` is
// null for a literal no invocation matched, and `bindings` for one matched
// against a signature with no Generics to solve — neither has anything left to
// decide.
type RecordedContextualFunctionType = {
	resolved: common.FunctionType
	expectedType: common.FunctionType | null
	bindings: GenericBindings | null
}

const contextualFunctionTypes = new WeakMap<
	parser.FunctionDefinitionNode,
	RecordedContextualFunctionType
>()

// NOTE: The Parameter Type an Argument was matched against, for the prefixed
// Case constructions that read their Choice's Type Arguments off it — the
// Argument counterpart of an annotation, and the reason `take(Holder#Bare)`
// needs no application of its own.
//
// NOTE: Kept with the call's bindings rather than substituted on the spot,
// because an Argument is matched before the Arguments after it have bound
// anything: the Parameter Type of `id(Box<Integer>#Empty, 1)` against
// `id<infer T>(_ b: Box<T>, _ seed: T)` is recorded while `T` is still open, and
// only `1` decides it. The Map is the one the match keeps filling, so reading
// the record back once the call has finished reads the position as the call
// finally decided it — `Box<Integer>`, agreeing with what was written — rather
// than as a `T` that exists in no scope the caller can see.
type RecordedCaseValueContext = {
	expectedType: common.Type
	bindings: GenericBindings | null
}

const contextualCaseValueTypes = new WeakMap<
	parser.CaseValueNode,
	RecordedCaseValueContext
>()

// NOTE: What ONE probe of a candidate resolved for the Nodes that react to an
// expected Type — a contextually typed Function literal's signature, and the
// Parameter Type a prefixed Case construction reads its Type Arguments off.
// Both are only right for the candidate that wins, so both are held aside
// together and committed together.
type ContextualFunctionTypeRecording = {
	functions: Map<
		parser.FunctionDefinitionNode,
		RecordedContextualFunctionType
	>
	cases: Map<parser.CaseValueNode, RecordedCaseValueContext>
}

// NOTE: The recordings of the probes currently running, innermost last. An
// Invocation probes EVERY candidate — that is how an ambiguity is found — and
// resolving a contextually typed Function literal against a candidate's
// Parameter Type records what the literal's omitted annotations resolved to. A
// candidate that then LOSES resolution must not leave that recording behind:
// the enrichment pass reads it back to type the literal's body, so the losing
// candidate would decide what the body means. Probes hold their recordings
// aside and the caller commits the winner's. A stack rather than one recording,
// because an Argument's own Invocation is probed while the outer one is.
let probeRecordings: Array<ContextualFunctionTypeRecording> = []

// NOTE: A nested probe commits into the enclosing probe's recording rather than
// straight into the shared one, so an inner Invocation's winner is still
// discarded when the outer candidate it was probed for loses.
function recordContextualFunctionType(
	node: parser.FunctionDefinitionNode,
	recorded: RecordedContextualFunctionType,
): void {
	let innermost = probeRecordings[probeRecordings.length - 1]

	if (innermost === undefined) {
		contextualFunctionTypes.set(node, recorded)
	} else {
		innermost.functions.set(node, recorded)
	}
}

// NOTE: Innermost first, so a probe sees what it recorded itself before what an
// enclosing one recorded, and the committed record answers when no probe did.
function recordedContextualFunctionType(
	node: parser.FunctionDefinitionNode,
): RecordedContextualFunctionType | undefined {
	for (let index = probeRecordings.length - 1; index >= 0; index--) {
		let recorded = probeRecordings[index].functions.get(node)

		if (recorded !== undefined) {
			return recorded
		}
	}

	return contextualFunctionTypes.get(node)
}

function recordContextualCaseValueType(
	node: parser.CaseValueNode,
	recorded: RecordedCaseValueContext,
): void {
	let innermost = probeRecordings[probeRecordings.length - 1]

	if (innermost === undefined) {
		contextualCaseValueTypes.set(node, recorded)
	} else {
		innermost.cases.set(node, recorded)
	}
}

// NOTE: The recorded Parameter Type with the call's bindings substituted in —
// the position as the finished call decided it. A Type Parameter that nothing
// ever bound is left standing, which is the undecided state
// `mentionsUnsolvedTypeParameter` answers for and the call reports for itself.
export function recordedContextualCaseValueType(
	node: parser.CaseValueNode,
): common.Type | undefined {
	let recorded = recordedCaseValueContext(node)

	if (recorded === undefined) {
		return undefined
	}

	return recorded.bindings === null
		? recorded.expectedType
		: applyGenericBindings(recorded.expectedType, recorded.bindings)
}

function recordedCaseValueContext(
	node: parser.CaseValueNode,
): RecordedCaseValueContext | undefined {
	for (let index = probeRecordings.length - 1; index >= 0; index--) {
		let recorded = probeRecordings[index].cases.get(node)

		if (recorded !== undefined) {
			return recorded
		}
	}

	return contextualCaseValueTypes.get(node)
}

function probeContextualFunctionTypes<Result>(probe: () => Result): {
	result: Result
	recording: ContextualFunctionTypeRecording
} {
	let recording: ContextualFunctionTypeRecording = {
		functions: new Map(),
		cases: new Map(),
	}

	probeRecordings.push(recording)

	try {
		return { result: probe(), recording }
	} finally {
		probeRecordings.pop()
	}
}

function commitContextualFunctionTypes(
	recording: ContextualFunctionTypeRecording | undefined,
): void {
	if (recording === undefined) {
		return
	}

	for (let [node, resolved] of recording.functions) {
		recordContextualFunctionType(node, resolved)
	}

	for (let [node, recorded] of recording.cases) {
		recordContextualCaseValueType(node, recorded)
	}
}

// NOTE: Enriches under a recording that is NOT the committed one — how a
// dispatch branch builds its own typed copy of a shared Function literal, which
// only exists as long as the copy is being built. A COPY of the recording is
// pushed, so what the copy's own body records while it is enriched (a nested
// Invocation's literal, resolved against the copy's Parameter Types) is dropped
// with it rather than added to the branch recording the caller also commits.
function withContextualFunctionTypes<Result>(
	recording: ContextualFunctionTypeRecording,
	work: () => Result,
): Result {
	probeRecordings.push({
		functions: new Map(recording.functions),
		cases: new Map(recording.cases),
	})

	try {
		return work()
	} finally {
		probeRecordings.pop()
	}
}

function needsContext(node: parser.FunctionDefinitionNode): boolean {
	return (
		node.returnType === null ||
		node.parameters.some((parameter) => parameter.type === null)
	)
}

// NOTE: An unannotated Parameter takes its Type *and* its label from the
// expected signature, positionally — which is why the Parser records no
// external name for one. An annotated Parameter is resolved exactly as it
// always was, so the two forms can be mixed across a Parameter list.
function resolveContextualParameterTypes(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
	expectedFunction: common.FunctionType | null,
): Array<common.Parameter> {
	reportUnknownDocumentationParameters(node.documentation, [node.parameters])

	return node.parameters.map((parameter, index) => {
		let documentation = parameterDocumentation(
			parameter,
			node.documentation,
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
			reportError(
				`The Type of Parameter '${parameterLabel(parameter)}' could not be inferred`,
				parameter.position,
				{
					code: "uninferable-parameter-type",
					labels: [
						primary(
							parameter.position,
							"this Parameter has no Type",
						),
					],
					notes: [
						expectedFunction === null
							? "Only a Function passed as an Argument takes its Types from the surrounding context."
							: `The expected Function Type takes ${countOf(expectedFunction.parameterTypes.length, "Parameter")}, so there is nothing for Parameter ${index + 1} to infer from.`,
					],
					helps: ["Write the Parameter's Type explicitly."],
				},
			)

			return { name: null, type: { type: "Error" }, documentation }
		}

		return {
			name: expectedParameter.name,
			type: expectedParameter.type,
			documentation,
		}
	})
}

function resolveContextualReturnType(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
	parameterTypes: Array<common.Parameter>,
	expectedFunction: common.FunctionType | null,
): common.Type {
	if (node.returnType !== null) {
		return resolveType(node.returnType, scope)
	}

	// NOTE: A Parameter that could not be inferred has already been reported,
	// and its Error Type poisons whatever the body returns — a second
	// Diagnostic here would only restate the first in vaguer terms.
	if (parameterTypes.some((parameter) => parameter.type.type === "Error")) {
		return { type: "Error" }
	}

	// NOTE: With no expected signature the body is the only thing that could
	// say what this Function returns, and reading a Type off a body that
	// nothing else constrains is exactly the inference that is hard to follow
	// across a whole Program. A literal in Argument position is the one place
	// the Type is still written down — just elsewhere — so it is the one place
	// an omitted `-> Type` is allowed.
	if (expectedFunction === null) {
		reportError(
			"This Function must write its return Type",
			node.parameterListPosition,
			{
				code: "missing-return-type",
				labels: [
					primary(node.parameterListPosition, "no '-> Type' here"),
				],
				notes: [
					"Only a Function passed as an Argument takes its Types from the surrounding context.",
				],
			},
		)

		return { type: "Error" }
	}

	// NOTE: An expected return Type the CALL has not solved says nothing — in
	// `map`'s `(_ item: ItemType) -> Result` nothing binds `Result` but this
	// literal's own body, so the body is what it is read off.
	//
	// A Type Parameter of an enclosing Namespace or Function is not that: it is
	// a decision, a generic one, and reading `List.firstItem(where:)`'s fold off
	// its body instead threw away the `Step<Optional<ItemType>,
	// Optional<ItemType>>` its `reduce` had already decided — leaving the
	// `#Done(item)` in it carrying whichever Parameters its payload happened to
	// mention. `mentionsUnsolvedTypeParameter` tells the two apart by the fresh
	// name only a call still matching can produce.
	if (mentionsUnsolvedTypeParameter(expectedFunction.returnType)) {
		let inferred = inferReturnTypeFromBody(node, parameterTypes, scope)

		if (inferred !== null) {
			return inferred
		}

		let position = functionLiteralPosition(node)
		let message = "The return Type could not be inferred from the body"
		let helps = ["Give the Function an explicit '-> Type'."]

		if (position === null) {
			reportError(message, null, {
				code: "uninferable-return-type",
				labels: [],
				helps,
			})
		} else {
			reportError(message, position, {
				code: "uninferable-return-type",
				labels: [
					primary(position, "the body's Type is not determined here"),
				],
				helps,
			})
		}

		return { type: "Error" }
	}

	return expectedFunction.returnType
}

function parameterLabel(parameter: parser.ParameterNode): string {
	return (
		parameterInternalName(parameter)?.content ??
		parameter.externalName?.content ??
		"_"
	)
}

function functionLiteralPosition(
	node: parser.FunctionDefinitionNode,
): common.Position | null {
	return node.parameters[0]?.position ?? null
}

// NOTE: What a Type Alias means, `where` clause and all. Without a clause this
// is nothing but `resolveAliasedType`; with one the Alias declares a checked
// refinement, and the Type it answers with is the evidence every value of the
// name carries.
//
// NOTE: The predicate is enriched on EVERY call, and no resolution of it is kept
// anywhere. Hoisting resolves speculatively, round after round, and the first
// round a refined Alias is offered in may well be the one before the Namespace
// answering its predicate has hoisted at all — the standard library declares
// `type NonZeroInteger` in the same file as `namespace Integer`. That round
// reports `unknown-method` into a collection it then throws away, and the next
// one resolves cleanly. A cached first answer would be the wrong one forever.
export function resolveTypeAliasStatementType(
	node: parser.TypeAliasStatementNode,
	scope: enricher.Scope,
): common.Type {
	let type = resolveTypeAliasStatementSkeleton(node, scope)
	let refinement = pendingRefinementIn(type)

	if (refinement === null || node.predicate === null) {
		return type
	}

	let conjuncts = resolveRefinementConjuncts(
		node.predicate,
		refinement.base,
		refinementPredicateScope(node, scope),
	)

	// NOTE: Poison recovery — a refused clause leaves the Alias meaning exactly
	// what it would have meant without one. A Diagnostic has already named the
	// clause, and every use of the name downstream is then about itself rather
	// than about an Error Type nobody wrote. A generic Alias keeps its wrapper —
	// what it stands for without the clause is still `List<Item>` applied at each
	// use, and dropping the wrapper would leave every `NonEmptyList<String>` naming a
	// Type that takes no Arguments.
	if (conjuncts === null) {
		return type.type === "GenericAlias"
			? { ...type, aliasedType: refinement.base }
			: refinement.base
	}

	refinement.conjuncts = conjuncts

	return type
}

// NOTE: The refinement a skeleton hoisted with its predicate unread, or null when
// the Type is not one. A GENERIC refined Alias resolves to a Generic Alias
// WRAPPING the refinement — the Arguments are applied through the wrapper, and the
// refinement one level in is the object the fill writes into — so every reader
// that means "is this predicate still pending" has to look inside.
export function pendingRefinementIn(
	type: common.Type,
): common.RefinementType | null {
	let refinement =
		type.type === "GenericAlias" && type.aliasedType.type === "Refinement"
			? type.aliasedType
			: type

	return refinement.type === "Refinement" && refinement.conjuncts === null
		? refinement
		: null
}

// NOTE: The Scope a refined Alias' predicate resolves in. A generic one's base
// mentions its Type Parameters (`@: List<Item>`), so the Parameters have to be in
// Scope as the opaque Generics they are — which is also what makes an
// item-dependent predicate (`@::contains(0)`) fail as the ordinary typechecking
// mistake it is, rather than needing a special refusal of its own.
export function refinementPredicateScope(
	node: parser.TypeAliasStatementNode,
	scope: enricher.Scope,
): enricher.Scope {
	return node.generics.length === 0
		? scope
		: scopeWithGenerics(node.generics, scope)
}

// NOTE: The Alias' Type up to — but not including — reading its predicate,
// which is the half hoisting can always resolve on its own. A refined Alias and
// the Namespace answering its predicate may name each other (`NonZeroInteger`
// asks Integer's `isNot`; `namespace Integer` declares a `divide` taking a
// NonZeroInteger), and reading the predicate here would deadlock the two. So
// what comes back for a clean refined Alias is the Refinement with `conjuncts:
// null` — registered once, shared by reference, and written into in place when
// the predicate is read — while every REFUSAL that needs no predicate (a base
// outside the three) is decided and reported here, so a broken clause never
// hoists as a Refinement at all: it poisons to its base exactly as it always did.
//
// NOTE: A GENERIC refined Alias comes back as the Generic Alias `resolveAliasedType`
// built with the refinement in place of its body — `NonEmptyList<Item>` is a Generic
// Alias over `List<Item> where @::hasItems()`, and a use site applies its Arguments
// through the wrapper, substituting them into the base the refinement stands on.
// The refinement itself is what the predicate is about, so the admissibility of the
// base is asked of the BODY rather than of the wrapper.
export function resolveTypeAliasStatementSkeleton(
	node: parser.TypeAliasStatementNode,
	scope: enricher.Scope,
): common.Type {
	let aliasedType = resolveAliasedType(node, scope)

	if (node.predicate === null) {
		return aliasedType
	}

	let base =
		aliasedType.type === "GenericAlias"
			? aliasedType.aliasedType
			: aliasedType

	if (!refinementSkeletonAdmissible(node, base)) {
		return aliasedType
	}

	let refinement: common.RefinementType = {
		type: "Refinement",
		name: node.name.content,
		base,
		conjuncts: null,
	}

	return aliasedType.type === "GenericAlias"
		? { ...aliasedType, aliasedType: refinement }
		: refinement
}

// NOTE: The Scope a predicate is read in — the surrounding one plus `@`, bound
// to the base as a CONSTANT, which is what a Match Handler's `@` is too. A child
// Scope, so the binding never reaches the Program's own.
function scopeWithRefinedSelf(
	base: common.Type,
	scope: enricher.Scope,
): enricher.Scope {
	return declareVariableInScope("@", base, childScope(scope), true)
}

// NOTE: The refusals that need no predicate reading — decided from the written
// declaration and the resolved base alone, which is what lets the skeleton
// above answer them without touching a Namespace. Every refusal reports before
// it answers, so a false here is always a Diagnostic there.
function refinementSkeletonAdmissible(
	node: parser.TypeAliasStatementNode,
	aliasedType: common.Type,
): boolean {
	// NOTE: A poisoned base says nothing about the clause — the Type it names is
	// not declared, or names itself — and whatever produced the Error has already
	// been reported. Refused silently, exactly as the Boolean check in
	// `resolveRefinementConjuncts` refuses an Error-typed predicate.
	if (typeContainsError(aliasedType)) {
		return false
	}

	if (!isRefinableBase(aliasedType)) {
		let described = describeRefinementBase(aliasedType)

		reportError(
			`A 'where' clause can not refine ${described}`,
			node.type.position,
			{
				code: "invalid-refinement-predicate",
				labels: [primary(node.type.position, `this is ${described}`)],
				notes: [
					"A checked refinement is written on an Integer, a String or an applied List — 'List<String>', never a bare 'List'.",
				],
				helps: [`Drop the 'where' clause from '${node.name.content}'.`],
			},
		)

		return false
	}

	return true
}

// NOTE: The predicate read at last — the half that needs the answering
// Namespace in Scope, which is why hoisting calls it apart from the skeleton:
// per round for an Alias whose Namespace is still on its way, with a Diagnostic
// here read as "not this round". Null when the clause is refused, and every
// refusal reports before it returns — either here or, for an Error-typed
// predicate, wherever the Error was made.
export function resolveRefinementConjuncts(
	predicateNode: parser.ExpressionNode,
	base: common.Type,
	scope: enricher.Scope,
): Array<common.PredicateConjunct> | null {
	let predicate = enrichExpression(
		predicateNode,
		scopeWithRefinedSelf(base, scope),
	)

	// NOTE: The same question `validateCondition` asks of an `if` — a predicate
	// that is not a Boolean proves nothing — and an Error Type is let through
	// silently, because whatever produced it has already been reported.
	if (predicate.type.type !== "Boolean") {
		if (predicate.type.type !== "Error") {
			reportError(
				"This predicate is not a Boolean",
				predicateNode.position,
				{
					code: "predicate-not-boolean",
					labels: [
						primary(
							predicateNode.position,
							`this is ${describeType(predicate.type)}`,
						),
					],
					notes: [
						"A 'where' clause is a question about the value being refined, so it has to answer 'true' or 'false'.",
					],
				},
			)
		}

		return null
	}

	let conjuncts = extractPredicateConjuncts(predicate)

	if (conjuncts === null) {
		return null
	}

	return canonicalPredicateConjuncts(conjuncts)
}

// NOTE: The bases a `where` clause may be written on. Integer and String are the
// two scalars every predicate in the standard library's own slice is about, and an
// APPLIED List is the third — `List<String>` or `List<Item>`, never a bare `List`,
// whose item Type nothing has decided. The list is short because each base is a
// promise: every Method a base answers, a refinement of it answers too, and every
// one of those has to keep meaning what it meant.
//
// NOTE: A generic Alias' base is an applied List whose item Type is still its Type
// Parameter, which passes for the same reason `List<String>` does — what nothing has
// decided about a bare `List` is decided here, by the use site. That the Parameter is
// OPAQUE while the predicate is read is what keeps the conjuncts item-agnostic: a
// predicate about the items (`@::contains(0)`) is refused by ordinary typechecking,
// and the ones that survive ask nothing a Type Argument could answer differently.
function isRefinableBase(type: common.Type): boolean {
	return (
		type.type === "Integer" ||
		type.type === "String" ||
		type.type === "List"
	)
}

// NOTE: An anonymous Union takes the Alias' own name as it resolves, so
// describing a refused base straight would report that 'Weird' is Weird. The
// refusal is about the SHAPE, so the borrowed name is dropped and the members
// are spelled out.
function describeRefinementBase(type: common.Type): string {
	return type.type === "UnionType" && type.name !== undefined
		? describeType({ ...type, name: undefined })
		: describeType(type)
}

// NOTE: The conjunct set a typed predicate spells, or null when it spells
// something a refinement can not be compared by — every refusal reports before
// it returns, so a null here is always a Diagnostic there.
//
// A predicate is a conjunction, flattened: `@::isPositive()::and(@::isNot(1))`
// is two conjuncts and so is the mirror image of it, which is what makes
// assignability set inclusion rather than Expression comparison. Everything else
// is one leaf, and a leaf is a single Method call directly on `@` with literal
// Arguments — a chain (`@::trim()::hasAnyContent()`) would need the intermediate
// value's evidence, and a computed Argument would need evaluating.
function extractPredicateConjuncts(
	predicate: common.typed.ExpressionNode,
): Array<common.PredicateConjunct> | null {
	if (predicate.nodeType !== "MethodInvocation") {
		reportInvalidPredicateLeaf(
			predicate.position,
			"this is not a Method call on '@'",
			"Write a Method call on '@' — '@::isNot(0)' — optionally joined with '::and(…)'.",
		)

		return null
	}

	if (isConjunction(predicate)) {
		let left = extractPredicateConjuncts(predicate.base)
		let right = extractPredicateConjuncts(predicate.arguments[0].value)

		return left === null || right === null ? null : [...left, ...right]
	}

	if (predicate.base.nodeType !== "Self") {
		reportInvalidPredicateLeaf(
			predicate.base.position,
			"this is not '@'",
			"Call the Method on '@' directly.",
		)

		return null
	}

	let args: Array<string | boolean> = []

	for (let argument of predicate.arguments) {
		let literal = literalPredicateArgument(argument.value)

		if (literal === null) {
			reportInvalidPredicateLeaf(
				argument.value.position,
				"this is not a literal value",
				"Pass a written Integer, Rational, String or Boolean.",
			)

			return null
		}

		args.push(literal)
	}

	return [
		{
			namespaceName: predicate.namespace.name,
			methodName: predicate.member.name,
			overloadIndex: predicate.overloadedMethodIndex,
			args,
		},
	]
}

function reportInvalidPredicateLeaf(
	position: common.Position,
	label: string,
	help: string,
): void {
	reportError(
		"This is not a predicate a refinement can be checked by",
		position,
		{
			code: "invalid-refinement-predicate",
			labels: [primary(position, label)],
			notes: [
				"A predicate is one Method call on '@' with literal Arguments, or several of them joined with '::and(…)'.",
			],
			helps: [help],
		},
	)
}

// NOTE: A literal Argument as the stable scalar a conjunct key is built from.
// The Integer's digits rather than its value, because a value is a number or a
// bigint at run time and neither spells every Integer in JSON; the Rational's
// two halves under the slash it was written with, which no Integer's digits can
// spell.
function literalPredicateArgument(
	value: common.typed.ExpressionNode,
): string | boolean | null {
	switch (value.nodeType) {
		case "IntegerValue":
		case "StringValue":
			return value.value
		case "BooleanValue":
			return value.value
		case "RationalValue":
			return `${value.numerator}/${value.denominator}`
		default:
			return null
	}
}

// NOTE: A Namespace's own name, bound to the Namespace itself — what makes
// `Reader.readsBase` inside `namespace Reader` read exactly like the same
// spelling written outside it. Every body a Namespace holds gets it: a Method's
// signature and body, and a static Property's value.
//
// The Namespace is injected as a MEMBER only — injecting it as a Type would
// shadow a same-named Type Alias (`namespace Event for Event`).
function scopeWithNamespaceSelf(
	node: parser.NamespaceDefinitionStatementNode,
	type: common.NamespaceType,
	scope: enricher.Scope,
): enricher.Scope {
	return childScope(scope, {
		members: { [node.name.content]: type },
		declarations: { [node.name.content]: node.name.position },
		constants: new Set([node.name.content]),
	})
}

export function resolveNamespaceDefinitionStatementType(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
	// NOTE: Set by hoisting alone, to the Protocol names that have not hoisted
	// yet. It turns on the speculative bound weave — the Type this pass registers
	// is what every use site ABOVE the Namespace's Statement solves against, so
	// it has to carry the conditional conformances' bounds already — and lets a
	// clause naming a Protocol still on its way throw, which the hoist loop reads
	// as "not this round".
	options: { deferOnPendingConformance?: ReadonlySet<string> } = {},
): common.NamespaceType {
	// NOTE: Namespace Generics are visible in the target Type and in every
	// Method signature — `namespace Boxes<infer Item> for List<Item>`.
	let genericScope = scopeWithGenerics(node.generics, scope)

	let conformanceConditions: Record<
		string,
		Array<{ generic: string; protocol: string }>
	> = {}

	for (let clause of node.conformsTo) {
		if (clause.conditions.length > 0) {
			conformanceConditions[clause.protocol.content] =
				clause.conditions.map((condition) => ({
					generic: condition.generic.content,
					protocol: condition.protocol.content,
				}))
		}
	}

	// NOTE: The maps the Type is built from are the ones it CARRIES, filled in
	// place as they resolve, so the Namespace injected into its own body sees
	// every member resolved so far — a Property naming one above it reads the
	// Type that one resolved to.
	let properties: Record<string, common.Type> = {}
	let methods: Record<string, common.MethodType> = {}

	let resultType: common.NamespaceType = {
		type: "Namespace",
		targetType:
			node.targetType === null
				? null
				: resolveType(node.targetType, genericScope),
		name: node.name.content,
		generics: resolveGenericDeclarations(node.generics, scope),
		properties,
		methods,
		conformsTo: node.conformsTo.map((clause) => clause.protocol.content),
		conformanceConditions,
	}

	// NOTE: The natives first, and in one pass of their own: a value-LESS
	// Property is answered by the runtime rather than by an initialiser, so it
	// has a value wherever it is written, and a Property above it may read it.
	for (let [memberKey, memberValue] of Object.entries(node.properties)) {
		if (memberValue.value !== null) {
			// NOTE: A bodied Property has no Type until its value is enriched,
			// and the Property BELOW is the one whose read is too early, so it
			// is seeded as Error rather than left out — the read resolves, and
			// the Validator, which is the pass that knows the order the
			// initialisers run in, is the one that refuses it.
			properties[memberKey] = { type: "Error" }

			continue
		}

		// NOTE: A native static Property declares its Type instead of carrying
		// a value — `static Pi: Transcendental` — so the annotation IS the
		// Type. Resolved in the outer Scope, like the bodied form's value.
		//
		// With neither a value nor an annotation there is nothing left to say
		// what the Property is. Silently resolving to Error would let a
		// Namespace ship a Property of no Type at all, and the standard
		// library's zero-Diagnostic gate would wave it through.
		if (memberValue.type === null) {
			reportError(
				`Native Property '${memberKey}' declares no Type`,
				memberValue.name.position,
				{
					code: "native-property-without-type",
					labels: [
						primary(
							memberValue.name.position,
							"no Type and no value",
						),
					],
					helps: [`Annotate it: 'static ${memberKey}: Type'.`],
				},
			)
		}

		properties[memberKey] = resolveDeclaredType(memberValue.type, scope)
	}

	// NOTE: Before the Property values, so that one of them may CALL a Method of
	// its own Namespace: a Method is installed with the class, ahead of every
	// static initialiser, so it answers whatever order the two are written in.
	for (let [methodName, methodValue] of Object.entries(node.methods)) {
		methods[methodName] = resolveMethodType(
			methodValue,
			scopeWithNamespaceSelf(node, resultType, genericScope),
			resultType.targetType,
			resultType.generics,
		)
	}

	let selfScope = scopeWithNamespaceSelf(node, resultType, scope)

	for (let [memberKey, memberValue] of Object.entries(node.properties)) {
		if (memberValue.value === null) {
			continue
		}

		// NOTE: A property's Type is its value's, read off the enriched
		// Expression — the same walk the Node build uses, so the two agree.
		// Enriching an Expression declares nothing, so this is safe under the
		// speculative resolution hoisting runs.
		properties[memberKey] = enrichExpression(
			memberValue.value,
			selfScope,
		).type
	}

	if (options.deferOnPendingConformance !== undefined) {
		weaveMethodBounds(
			node,
			resultType,
			silentCheckedConformances(
				node,
				resultType,
				scope,
				options.deferOnPendingConformance,
			),
			scope,
			false,
		)
	}

	return resultType
}

// NOTE: The qualified spelling is shown rather than described — "prefix it
// with its Choice's name" leaves the reader to work out what that looks like,
// and the whole point of the Diagnostic is that they can not tell the two
// Choices apart.
//
// NOTE: Handed the Choices' identities, since every caller has Cases rather than
// written names in hand, and spelling them out is this function's business: what
// a reader has to write to pick one is the Choice's name, never the Module path
// its identity carries in front of it.
function reportAmbiguousCase(
	caseName: parser.IdentifierNode,
	choiceIdentities: Array<string>,
	where: string,
): void {
	let choiceNames = choiceIdentities.map(displayChoiceName)

	reportError(
		`Case '#${caseName.content}' is declared by more than one Choice`,
		caseName.position,
		{
			code: "ambiguous-case",
			labels: [
				primary(
					caseName.position,
					`${countOf(choiceNames.length, "Choice")} ${where} declare${choiceNames.length === 1 ? "s" : ""} it`,
				),
			],
			notes: choiceNames.map(
				(choiceName) =>
					`'${choiceName}' declares '#${caseName.content}'.`,
			),
			// NOTE: One Help per candidate, not just the first. WHICH Choice was
			// meant is exactly what this Diagnostic can not decide, so naming
			// only one quietly recommends it — and since `Optional` became a
			// builtin Choice, `#Empty` and `#Value` collide with names a
			// Program is likely to declare, where the builtin is the one it
			// almost certainly did NOT mean.
			helps: choiceNames.map(
				(choiceName) =>
					`Write '${choiceName}#${caseName.content}' to pick '${choiceName}'.`,
			),
		},
	)
}

// NOTE: An unknown Case is reported from three places — a named Choice, the
// matched value's Union, and the scan of every Choice in scope — which differ
// in what they can say about where the Case was looked for, but not in what
// they offer instead. Computing the near miss once is what keeps the terminal
// and the editor in step: the Help is the Quick Fix's title, and a site that
// wrote only one of them would show a suggestion nothing applies, or apply one
// nothing announced.
function caseSuggestion(
	name: string,
	candidateNames: Array<string>,
): { helps: Array<string>; data?: common.DiagnosticData } {
	let suggestion = closestMatch(name, candidateNames)

	return {
		helps: suggestion === null ? [] : [`Did you mean '#${suggestion}'?`],
		// NOTE: The bare name, without the `#` the Help renders it with —
		// a Quick Fix replaces the Case's name, and the `#` beside it is
		// not part of what the Diagnostic underlines.
		...suggestionData(suggestion),
	}
}

function reportUnknownCase(
	caseName: parser.IdentifierNode,
	choiceDescription: string,
	declaredCaseNames: Array<string>,
): void {
	reportError(
		`${choiceDescription} has no Case '#${caseName.content}'`,
		caseName.position,
		{
			code: "unknown-case",
			labels: [primary(caseName.position, "no such Case")],
			notes:
				declaredCaseNames.length === 0
					? []
					: [
							`${choiceDescription} declares ${declaredCaseNames
								.map((name) => `'#${name}'`)
								.join(", ")}.`,
						],
			...caseSuggestion(caseName.content, declaredCaseNames),
		},
	)
}
// #endregion
