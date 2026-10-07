import { isDeepStrictEqual } from "node:util"

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
import { providedMethodProtocol } from "../helpers/conformance"
import {
	booleanQuestionFor,
	asynchronyState,
	barredCompletion,
	choiceIdentity,
	countOf,
	describeParameter,
	describeSignature,
	describeType,
	displayChoiceName,
	displayGenericName,
	displayProtocolName,
	namespaceHead,
	receiverAnnotationHelp,
	specifierTo,
	spellChoiceName,
	spellType,
	undispatchableHelps,
	unnameableTarget,
	recordMismatchEvidence,
	undecidedSlotAnnotation,
	unwaitedWorkReport,
	withArticle,
	writtenValueHelps,
} from "../helpers/describe"
import { eraseRefinements } from "../helpers/eraseRefinements"
import { parameterInternalName, synthesizedName } from "../helpers/names"
import {
	patternBindings,
	refutablePatternMembers,
	type PatternBinding,
	type PatternStep,
} from "../helpers/patterns"
import {
	admissionOfWrittenValue,
	admittedMergeValue,
	admittedPartialType,
	admittedTypeOf,
	describePredicate,
	fitsWritten,
	reducedRationalSpelling,
	refinementInside,
} from "../helpers/predicateEval"
import { typedBodyNamespaceReaches } from "../helpers/providedReach"
import { readsEveryEntry, typedBodyReads } from "../helpers/providedReads"
import { pairedByPlace } from "../helpers/readerPairing"
import { closestMatch, editDistance } from "../helpers/suggest"
import {
	answersForBase,
	applyGenericBindings,
	type ArgumentMismatchDetail,
	buildUnion,
	caseWithBlanks,
	canonicalPredicateConjuncts,
	createFreshenedChoiceInference,
	createFreshenedInference,
	filterMostSpecificByTarget,
	flattenUnionMembers,
	genericNamesMentioned,
	holdsFunctionRefusedAsValue,
	type GenericInferenceContext,
	impliedConjunctKeys,
	isPartialOf,
	isReportedValue,
	matchArguments,
	matchesType,
	matchesTypeWithBindings,
	returnedTypeOf,
	measuredValue,
	mentionsUnsolvedTypeParameter,
	mergeUnionMembers,
	mergedRecordType,
	namespaceAnswersForBase,
	negatedPredicateConjunct,
	NotHoistedYet,
	pairArguments,
	predicateConjunctKey,
	provenConjuncts,
	refinableBaseTag,
	refinementWithTypeArguments,
	resolveOverloadedMethodName,
	resolveUnknownSlots,
	type GenericBindings,
	type MatchableArgument,
	typeContainsError,
	typeContainsRefinement,
	typeContainsUnknown,
	typeMentionsGeneric,
	unfreshenBindings,
	unionMembersKeepingNames,
} from "../helpers/types"
import {
	isWrittenLiteral,
	undeclaredMembers,
} from "../helpers/undeclaredMembers"
import { printSignature, printType, signaturesOf } from "../printType"
import { aliasTypeParameters, offeredCases, payloadCase } from "./aliasCases"
import { reportAmbiguousNamespace } from "./ambiguousNamespaces"
import { argumentTypeRefusal } from "./argumentRefusals"
import { askAssertionQuestions } from "./assertionQuestions"
import { wrapSingleMemberShorthand } from "./caseShorthand"
import {
	enteringCall,
	holdLiteralReports,
	holeDecided,
	needsContext,
	probingCandidate,
	probingCandidates,
	readingArgumentLiteral,
	readLiteralsByPlace,
	resolveContextualParameterTypes,
	returnTypeHelpIn,
	typerReadingLiteralBodies,
} from "./contextualParameters"
import {
	branchNamespaces,
	takesWitnesses,
	unboundToReport,
} from "./dispatchReceivers"
import { namespaceCallHelps, valueOf } from "./namespaceValues"
import { noteOuterRead, refuseShadowingAfterRead } from "./outerReads"
import {
	bindsLastStep,
	refuseBareNames,
	reportBarePathKeys,
} from "./pathKeyShorthand"
import {
	isOneShapeMatch,
	isUnknownMember,
	misspellsPayloadMember,
	unresolvedCaseBindings,
} from "./patternMembers"
import {
	answeringNamespaces,
	compilesWithoutPick,
	reportPickedRequirement,
} from "./protocolPicks"
import { type InvokingCall, providedNamespaceMember } from "./providedBodies"
import { recordWrittenConstant, refuseReassignment } from "./reassignment"
import { pinnedForReceiver } from "./receiverPins"
import {
	holdsOnlyHoles,
	typerAroundRefusedFunctions,
	typerRefusingErrorPlaces,
} from "./refusedArguments"
import {
	insideRefusedCall,
	noteRefusedCallNamespaces,
	refusedPosition,
	underRefusedCall,
} from "./refusedCalls"
import { carriesRefusedCapture, noteRefusedCapture } from "./refusedCaptures"
import {
	readDroppedEntries,
	readDroppedPathValues,
	refusePathKeys,
} from "./refusedPathKeys"
import {
	checkProtocolConformance,
	type CheckedConformance,
	reportReservedTypeName,
	findTypeInScope,
	combinationTypeOf,
	derivedEquatableDescriptorFor,
	derivedCaseTags,
	derivedEnumerableNamespaceFor,
	derivedEnumerableNamespaceName,
	derivedEquatableNamespace,
	derivedEquatableNamespaceName,
	derivedPrintableNamespace,
	derivedPrintableNamespaceName,
	describeProtocol,
	enclosingNamespaceOf,
	enumerableMethodName,
	findCaseTypesInScope,
	getAllNamespacesInScope,
	impliedTargetBounds,
	incompatibleRestatements,
	isStaticMethod,
	methodGenericSplits,
	type MethodGenericSplit,
	protocolMethodBody,
	invalidateNamespacesInScope,
	namespacesDeclaringMethod,
	namespacesTargeting,
	partitionInstanceMethodNamespaces,
	specializedNamespacesFor,
	listItemTypeOf,
	lookupTypeOf,
	type MemberAccessContext,
	namespaceNamedByType,
	knownProtocol,
	protocolImport,
	protocolNameTaken,
	protocolOf,
	protocolSpelling,
	recordValueTypeOf,
	reportDocumentationParameters,
	reportProvidedBodyReaches,
	resolvedDocumentation,
	resolveAliasedType,
	resolveChoiceDeclarationStatementType,
	resolveConformances,
	resolveDeclaredType,
	resolveFunctionSignatureType,
	resolveGenericDeclarations,
	resolveIdentifierType,
	type NameContext,
	applyTypeArguments,
	resolveMethodLookupNamespacesForReceiverType,
	routedRecordCall,
	resolveMethodType,
	resolveOverloadedFunctionStatementType,
	resolveProtocolDeclarationStatementType,
	resolveSelfType,
	resolveType,
	resolveWrittenProtocol,
	scopeWithGenerics,
	protocolsDeclaringMethod,
	silentCheckedConformances,
	solveConformance,
	typeParameterBoundReport,
} from "./resolvers"
import {
	bodyCanWait,
	childScope,
	completionBarrierIn,
	completionContextIn,
	countTypeDeclaration,
	declarationWasAbandoned,
	expectedReturnTypeIn,
	memberDeclarationWasAbandoned,
	modulePathOf,
	registerProtocol,
	scopeMap,
	typeDeclarationCount,
	unimportedNamespacesOf,
} from "./scope"
import { reportEmptyLookup, specifierWasRefused } from "./specifiers"
import {
	declaredCaseOf,
	reportAmbiguousCase,
	spellingIn,
	suggestionData,
	unknownTypeRemedy,
} from "./spelling"
import { reportStaticMethodOnValue } from "./staticMethods"
import { settleProperty, typeBodiedProperties } from "./staticProperties"
import { reportPropertyParameters, reportRowTypeMismatch } from "./tests"
import {
	boundNamespaceGenerics,
	conformanceBoundHelps,
	namespaceParameterNames,
	refuseDuplicateTypeParameters,
	refuseUndecidedTypeParameters,
} from "./typeParameters"
import {
	answersStepOffTypeParameter,
	isUnwrittenTypeParameter,
	stepOffValueAdvice,
	stopsAtUndecidedStep,
} from "./typeParameterSteps"
import {
	markDeclaredValue,
	reportUndecidedBareCase,
	reportUndecidedTypeArguments,
} from "./undecidedCases"
import { dividedUnionNotes, reportNarrowedUnionMember } from "./unionDispatch"

// Hoisting resolves each order-independent declaration's Type up front, keyed
// by its Node, and the in-order enrichment reuses it. A Node absent from the
// Map resolves in place and reports its own Diagnostics.
export type HoistedTypes = Map<
	parser.ImplementationNode,
	common.Type | common.ProtocolType
>

// A declaration's head: from its start to the end of the last part that
// describes the declaration itself, before any body. Hover anchors here, so a
// blank line inside a Namespace answers nothing. The part reaching furthest
// wins.
function headPositionOf(
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

// A signature's own span, such as `<infer Item>(a: Integer) -> String`. No
// parser Node covers it: a FunctionValue starts at its `(`, and a
// FunctionDefinition has no Position.
function signatureHeadPositionOf(
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

// One parsed Node becomes a list of typed ones. A declaration whose name is a
// Pattern becomes the Constants it stands for: the base, then one per bound
// name. Returning an Array makes every body walk flatMap rather than drop
// bindings.
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
		case "DictionaryValue":
		case "Lookup":
		case "MemberPath":
		case "Identifier":
		case "Self":
		case "Match":
		case "Define":
		case "CaseValue":
		case "Start":
		case "Complete":
		case "RefusedValue":
			return [enrichExpression(node, scope)]
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			return enrichDeclarationStatement(node, scope)
		// The Parser reports `expect-outside-test` for an assertion outside a
		// test, but the Statement is still typed so that Hover over it answers.
		case "ExpectStatement":
		case "RequireStatement":
			return enrichAssertionStatement(node, scope)
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

// `expectedType` is what the surrounding position wants: an annotation, an
// Assignment's target, the declared return Type at a `<-`.
//
// A Function or Method read as a value loses its defaults, because only a
// direct call reaches the callee's frame that fills them in. The callee of an
// Invocation is read through `enrichCalleeExpression` instead.
export function enrichExpression(
	node: parser.ExpressionNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.typed.ExpressionNode {
	return asValue(enrichCalleeExpression(node, scope, expectedType))
}

// The same Expression read where it is called, the one position where a default
// still applies. `Terminal.print("…")` and `constant print = Terminal.print`
// hold the same Lookup.
function enrichCalleeExpression(
	node: parser.ExpressionNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
	// The Invocation that asked for this Expression. Only a Lookup reads it,
	// to tell `names.length()` from `names.length` when the member is missing.
	call: InvokingCall | null = null,
): common.typed.ExpressionNode {
	switch (node.nodeType) {
		// A call reads its own Arguments' positions; see `enteringCall`.
		case "MethodInvocation":
			return enteringCall(() =>
				enrichMethodInvocation(node, scope, expectedType),
			)
		case "FunctionInvocation":
			return enteringCall(() =>
				enrichFunctionInvocation(node, scope, expectedType),
			)
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
		case "DictionaryValue":
			return enrichDictionaryValue(node, scope, expectedType)
		case "Lookup":
			return enrichLookup(node, scope, call)
		case "MemberPath":
			return enrichMemberPath(node, scope, expectedType)
		case "Identifier":
			return enrichIdentifierExpression(node, scope, {
				applied: call !== null,
			})
		case "Self":
			return enrichSelf(node, scope)
		case "Match":
			return enrichMatch(node, scope)
		case "Define":
			return enrichDefine(node, scope, expectedType)
		case "CaseValue":
			return enrichCaseValue(node, scope, expectedType)
		case "Start":
			return enrichStart(node, scope)
		case "Complete":
			return enrichComplete(node, scope)
		case "RefusedValue":
			return enrichRefusedValue(node, scope)
	}
}

// A value the Parser refused and reported where it was written, such as
// `primes[0]`. The base is still enriched so that rename reaches its names, but
// its Type becomes an Error and its Diagnostics are dropped. Readers stay
// silent on an Error. The base's own reports would be about where the Parser
// cut, such as a label read as the indexed value.
function enrichRefusedValue(
	node: parser.RefusedValueNode,
	scope: enricher.Scope,
): common.typed.RefusedValueNode {
	let { result: base } = collectDiagnostics(() =>
		enrichExpression(node.base, scope),
	)

	return {
		nodeType: "RefusedValue",
		base,
		position: node.position,
		type: { type: "Error" },
	}
}

// The Type a signature has once it is a value: the same Parameters, none of
// them omittable. Only a name can stand for a Function or a Method, so only an
// Identifier or a Lookup changes. Returns the given Node when nothing is
// dropped.
function asValue(
	node: common.typed.ExpressionNode,
): common.typed.ExpressionNode {
	if (node.nodeType === "Identifier") {
		let type = withoutParameterDefaults(node.type)

		return type === node.type ? node : { ...node, type }
	}

	if (node.nodeType === "Lookup") {
		let type = withoutParameterDefaults(node.type)

		// The Lookup and its member Identifier share one Type.
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

// A Function taken as a value fills in no default, whole or per member. A
// partial default sets `defaultMembers` without `hasDefault`, so every default
// key is checked and dropped.
function requiredParameters(
	parameters: Array<common.Parameter>,
): Array<common.Parameter> {
	if (
		!parameters.some(
			(parameter) =>
				parameter.hasDefault || parameter.defaultMembers !== undefined,
		)
	) {
		return parameters
	}

	return parameters.map(
		// oxlint-disable-next-line eslint/no-unused-vars -- the keys being dropped
		({ hasDefault, defaultMembers, defaultNesting, ...parameter }) =>
			parameter,
	)
}

// Whether the position this construction stands in was itself refused. A Case
// then stays silent about which Choice or Type Arguments it means, since the
// real error is reported elsewhere. An unknown Case is still reported.
function positionWasRefused(expectedType: common.Type | null): boolean {
	return expectedType?.type === "Error"
}

function enrichCaseValue(
	node: parser.CaseValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.typed.CaseValueNode {
	// An Argument's expected Type is the one the Invocation committed for the
	// winning candidate's Parameter, read back here. A refused call's Argument
	// stands in a refused position; see `positionWasRefused`.
	let context =
		expectedType ??
		recordedContextualCaseValueType(node) ??
		refusedPosition()

	// The Case resolves before its payload, so the position's members are what
	// the payload stands in: `Box<Box<Integer>>#Full(Box#Full(1))` reads the
	// inner Type Arguments off the outer. Where the position offers several
	// instantiations, the payload is read silently under each and chooses among
	// them. It decides one only where the position offers none the prefix can
	// write, and the position then refuses it.
	let payload = makePayloadReadings(node, scope)
	let type = resolveCaseValueType(node, scope, context, payload.valueUnder)

	if (context !== null) {
		reportUncarriedTypeArgumentDisagreement(
			node,
			type,
			context,
			expectedType === null,
			scope,
		)
	}

	let value = payload.commit(type)

	if (type.type === "Case") {
		// The one-member shorthand rewraps first, so `#Done(5)` and `#Done({
		// value = 5 })` bind the Choice's Type Parameters from the same Record.
		if (value !== null) {
			value = wrapSingleMemberShorthand(type, value)
		}

		// Kept before the instantiation drops them, for the undecided report.
		// Set only on the payload path; every other path returns a Case a
		// position decided.
		let choiceGenerics = type.choiceGenerics

		type = instantiateCaseFromPayload(type, value, scope, node.position)

		if (
			choiceGenerics !== undefined &&
			payloadStandsForCase(type, value) &&
			!positionWasRefused(context)
		) {
			type = reportUndecidedPayloadTypeArguments(
				node,
				type,
				choiceGenerics,
				scope,
			)
		}
	}

	return {
		nodeType: "CaseValue",
		// The Choice's name is a Type name, typed by Type-scope lookup, so
		// hovering it describes the Choice's Union.
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

// Reports written Type Arguments that disagree with the position where no other
// report can see it. See "Written Type Arguments at a construction" in
// DEVELOPMENT.md.
function reportUncarriedTypeArgumentDisagreement(
	node: parser.CaseValueNode,
	written: common.CaseType | common.ErrorType,
	expectedType: common.Type,
	inArgumentPosition: boolean,
	scope: enricher.Scope,
): void {
	if (node.typeArguments === null || written.type !== "Case") {
		return
	}

	let writtenArguments = written.typeArguments

	if (writtenArguments === undefined) {
		return
	}

	// An offered instantiation that keeps no Type Arguments is no decision to
	// compare against. Nor is one that mentions a Type Parameter the call has
	// not solved.
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

	// Where the value's own Type does not match, the position reports the
	// mismatch itself.
	if (offered.some((candidate) => matchesType(candidate, written))) {
		let reader = spellingIn(scope)
		let spell = (typeArguments: Array<common.Type>) =>
			`${spellChoiceName(written, reader)}<${typeArguments.map((typeArgument) => spellType(typeArgument, reader)).join(", ")}>`

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

// What a Case expects of its payload: its Record, or on a one-member Case that
// Record or the member's own Type. `null` for a declared Case, whose members
// are the Choice's Type Parameters, and for anything that is no Case.
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

// An Argument that reads its Choice's Type Arguments off its Parameter and so
// binds none of the call's. It is matched after the Arguments that can. See
// "Written Type Arguments at a construction" in DEVELOPMENT.md.
function bindsNoTypeParameter(argument: parser.ArgumentNode): boolean {
	return (
		argument.value.nodeType === "CaseValue" &&
		argument.value.typeArguments === null &&
		(argument.value.choice !== null || argument.value.value === null)
	)
}

// The payload read once per candidate Case, with its Diagnostics held until the
// commit. See "Case construction" in DEVELOPMENT.md.
type PayloadReading = {
	value: common.typed.ExpressionNode
	diagnostics: Array<common.Diagnostic>
}

type PayloadReadings = {
	typeUnder: (under: common.Type) => common.Type | null
	// The reading, still unreported, for a probe that needs the typed Node.
	// `commit` reports the reading's Diagnostics and is called once.
	valueUnder: PayloadReader
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
			// A Record Literal payload merges into the Case's payload default
			// as an Argument merges into a Parameter's, so it may carry path
			// keys.
			let { result, diagnostics } = collectDiagnostics(() =>
				payload.nodeType === "RecordValue"
					? enrichRecordValue(
							payload,
							scope,
							expectedPayloadType(under),
							true,
						)
					: enrichExpression(
							payload,
							scope,
							expectedPayloadType(under),
						),
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

// Instantiates a generic Case from its already wrapped payload. See
// "Instantiating a generic Case from its payload" in DEVELOPMENT.md.
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

	// Freshened, because the payload may mention a caller Type Parameter
	// spelled like one of the Choice's.
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

	// What the payload bound, under the Choice's names, and what it did not,
	// under its fresh name. `applyGenericBindings` stamps both onto
	// `typeArguments` in declaration order.
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

	// The construction checks the Choice's bounds for what its payload bound,
	// since an unannotated `#Full(f)` has no annotation to check them. Only
	// bound Type Parameters are asked, so `Holder#Bare` raises no bound error.
	let boundGenerics = choiceGenerics.filter(
		(_, index) => context.bindings.get(freshNames[index]) !== undefined,
	)

	resolveConformances(boundGenerics, bindings, scope, position)

	return applyGenericBindings(caseType, bindings) as common.CaseType
}

// Refuses a payload construction that leaves a Type Argument undecided. See
// "Instantiating a generic Case from its payload" in DEVELOPMENT.md.
function reportUndecidedPayloadTypeArguments(
	node: parser.CaseValueNode,
	caseType: common.CaseType,
	choiceGenerics: Array<common.GenericDeclaration>,
	scope: enricher.Scope,
): common.CaseType | common.ErrorType {
	if (inferReturnTypeFromBodyDepth > 0) {
		return caseType
	}

	let hasUndecided = choiceGenerics.some((_, index) => {
		let typeArgument = caseType.typeArguments?.[index]

		return (
			typeArgument !== undefined &&
			mentionsUnsolvedTypeParameter(typeArgument)
		)
	})

	if (!hasUndecided) {
		return caseType
	}

	return reportUndecidedBareCase(
		`#${node.caseName.content}(…)`,
		caseType,
		choiceGenerics,
		node,
		true,
		scope,
	)
}

// Whether a payload stands for the Case. A missing payload or one of the wrong
// Type is the validator's to report, and an Error payload binds nothing.
function payloadStandsForCase(
	caseType: common.CaseType,
	value: common.typed.ExpressionNode | null,
): boolean {
	if (value === null || typeContainsError(value.type)) {
		return false
	}

	return payloadFitsCase(caseType, value.type, value)
}

function enrichMethodInvocation(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
	// Handed to the typer: the position only decides a Type Parameter the
	// Arguments left open. See `decidedSeedBindings`.
	expectedType: common.Type | null = null,
): common.typed.MethodInvocationNode {
	// The receiver is enriched once, with no expected Type. Dispatch reads its
	// Type to find the Namespace, so a construction on a `::` decides its own
	// Type Arguments. `writtenReceiver` adds what a written receiver proves
	// about itself, so Hover over the `4` in `4::squareRoot()` agrees with
	// dispatch.
	let base = writtenReceiver(enrichExpression(node.base, scope), scope)
	let typer = makeArgumentTyper(scope, expectedType)
	let resolved = resolveMethodInvocation(node, base.type, scope, typer)
	let {
		namespace,
		type,
		overloadedMethodIndex,
		conformances,
		omittedParameterIndices,
		derivedDescriptor,
		derivedMembers,
		dispatch,
	} = resolved

	reportDeadFallbackOnMethodInvocation(
		node,
		base.type,
		scope,
		typer,
		resolved,
	)

	if (resolved.failed === true) {
		noteRefusedCallNamespaces(node, base.type, scope)
	}

	return {
		nodeType: "MethodInvocation",
		base,
		member: {
			name: node.member.content,
			position: node.member.position,
		},
		arguments: underRefusedCall(resolved.failed === true, () =>
			node.arguments.map((argument) =>
				typer.enrichArgumentNode(argument),
			),
		),
		position: node.position,
		namespace,
		type,
		overloadedMethodIndex,
		conformances,
		omittedParameterIndices,
		derivedDescriptor,
		derivedMembers,
		dispatch,
	}
}

function enrichFunctionInvocation(
	node: parser.FunctionInvocationNode,
	scope: enricher.Scope,
	// Read as a Method Invocation's is.
	expectedType: common.Type | null = null,
): common.typed.FunctionInvocationNode {
	// The callee and every Argument are enriched once and reused for the final
	// Node.
	let typer = makeArgumentTyper(scope, expectedType)
	let name = enrichCalleeExpression(node.name, scope, null, { node, typer })
	let {
		type,
		conformances,
		overloadedMethodIndex,
		omittedParameterIndices,
		selected,
		refused,
	} = resolveFunctionInvocation(node, name.type, scope, typer)

	reportDeadFallbackOnFunctionInvocation(node, name.type, scope, typer, {
		type,
		selected,
		overloadedMethodIndex,
	})

	return {
		nodeType: "FunctionInvocation",
		name,
		// A call answering an Error is no refusal while it selected a candidate.
		// A lone signature says for itself whether it refused its Arguments.
		arguments: underRefusedCall(
			refused ?? (type.type === "Error" && !selected),
			() =>
				node.arguments.map((argument) =>
					typer.enrichArgumentNode(argument),
				),
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
	// A refined base updates as its base does and answers a Dictionary, because
	// a set key proves nothing the refinement asked. An update proves only that
	// it holds an entry; see `literalValueOf` in `helpers/predicateEval.ts`.
	let baseType = lhs.type.type === "Refinement" ? lhs.type.base : lhs.type

	if (baseType.type === "Dictionary") {
		return enrichDictionaryCombination(node, lhs, baseType, scope)
	}

	// Brackets over a Record are reported here and answer the base's Type, so
	// the ordinary reading does not report a second time.
	if (node.brackets === true && baseType.type === "Record") {
		reportUpdateBrackets(node, lhs, baseType)

		return combinationOfWrongBrackets(node, lhs, scope)
	}

	let keys =
		node.bare === true && node.rhs.nodeType === "RecordValue"
			? refuseBareNames(node.lhs, node.rhs, scope)
			: node.rhs

	if (keys.nodeType === "RecordValue" && hasPathKeys(keys)) {
		reportBarePathKeys(keys, scope)

		if (updatableThroughPaths(node.lhs, lhs)) {
			return enrichPathCombination(node, lhs, keys, scope)
		}

		// The path keys are dropped, so a member called `server.port` does not
		// raise a second Diagnostic. Their values are still read.
		readDroppedPathValues(
			keys.members,
			expectedRecordMembers(lhs.type),
			scope,
		)
		keys = { ...keys, members: withoutPathKeys(keys.members) }
	}

	// The update is read against the updated value's Type. A bare Case
	// resolves, and one arm of a Union-typed member is enough, as at the
	// Declaration.
	let rhs = enrichExpression(keys, scope, lhs.type)

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
			rhs,
		),
	}
}

// `[ages with "kim" = 7]` sets the entries it names, and `[ages with other]`
// merges a whole Dictionary in, the Argument winning on a shared key. Both
// answer the base's Type and are checked against the base's slots. An Unknown
// slot, as after `[=]`, is decided by the update and checks nothing.
function enrichDictionaryCombination(
	node: parser.CombinationNode,
	lhs: common.typed.ExpressionNode,
	baseType: common.DictionaryType,
	scope: enricher.Scope,
): common.typed.CombinationNode {
	if (reportUpdateBrackets(node, lhs, baseType)) {
		return combinationOfWrongBrackets(node, lhs, scope)
	}

	let declaredKeyType =
		baseType.keyType.type === "Unknown" ? null : baseType.keyType
	let declaredValueType =
		baseType.valueType.type === "Unknown" ? null : baseType.valueType

	let rhs =
		node.rhs.nodeType === "DictionaryValue"
			? enrichDictionaryUpdateKeys(
					node.rhs,
					scope,
					declaredKeyType,
					declaredValueType,
				)
			: enrichExpression(node.rhs, scope, baseType)

	let merged =
		rhs.nodeType === "DictionaryValue"
			? rhs.type
			: reportUnmergeableDictionary(node, baseType, rhs)

	let type: common.DictionaryType = {
		type: "Dictionary",
		keyType: declaredKeyType ?? dictionarySlotOf(merged, "keyType"),
		valueType: declaredValueType ?? dictionarySlotOf(merged, "valueType"),
	}

	if (rhs.nodeType === "DictionaryValue") {
		reportUnsettableEntries(rhs, declaredKeyType, declaredValueType, lhs)
	}

	// The witness is the base's, since the emitted `set` compares a written key
	// with the keys the Dictionary already holds. A base without a key Type
	// takes the update's, and an update that decided neither needs none.
	let keyConformance =
		type.keyType.type === "Unknown"
			? null
			: equatableKeyConformance(type.keyType, scope, node.position)

	return {
		nodeType: "Combination",
		lhs,
		rhs,
		position: node.position,
		type,
		...(keyConformance === null ? {} : { keyConformance }),
	}
}

// The key list of an update carries no witness of its own: the base's
// Equatable, recorded on the Combination, compares its keys.
function enrichDictionaryUpdateKeys(
	node: parser.DictionaryValueNode,
	scope: enricher.Scope,
	expectedKeyType: common.Type | null,
	expectedValueType: common.Type | null,
): common.typed.DictionaryValueNode {
	let entries = enrichDictionaryEntries(
		node.entries,
		scope,
		expectedKeyType,
		expectedValueType,
	)

	return {
		nodeType: "DictionaryValue",
		entries,
		position: node.position,
		type: {
			type: "Dictionary",
			keyType: listItemTypeOf(entries.map((entry) => entry.key.type)),
			valueType: listItemTypeOf(entries.map((entry) => entry.value.type)),
		},
		keyConformance: null,
	}
}

function dictionarySlotOf(
	type: common.Type,
	slot: "keyType" | "valueType",
): common.Type {
	return type.type === "Dictionary" ? type[slot] : { type: "Unknown" }
}

// Each entry measured against the slot it is written into. The Diagnostic
// points at the half that did not fit, which a Record's `partial-type-mismatch`
// can not.
function reportUnsettableEntries(
	rhs: common.typed.DictionaryValueNode,
	keyType: common.Type | null,
	valueType: common.Type | null,
	lhs: common.typed.ExpressionNode,
): void {
	for (let entry of rhs.entries) {
		if (keyType !== null && !fitsWritten(keyType, entry.key)) {
			reportError(
				"This is not a key the Dictionary can hold",
				entry.key.position,
				{
					code: "partial-type-mismatch",
					labels: [
						primary(
							entry.key.position,
							`this is ${withArticle(describeType(entry.key.type))}`,
						),
						secondary(
							lhs.position,
							`this is ${withArticle(describeType(lhs.type))}`,
						),
					],
					notes: [
						"An update may only set keys of the Dictionary's key Type, with the Type it declared for its values.",
					],
				},
			)
		}

		// A Function refused as a value is reported where it is written, so it
		// is a hole here.
		let held = measuredValue(entry.value)

		if (valueType !== null && !fitsWritten(valueType, held)) {
			// The labels name the entry and the Dictionary. A Record value's
			// refusing member goes into the notes rather than a third label.
			let record = recordMismatchEvidence(valueType, held.type, null)

			reportError(
				"This is not a value the Dictionary holds",
				entry.value.position,
				{
					code: "partial-type-mismatch",
					labels: [
						primary(
							entry.value.position,
							`this is ${withArticle(describeType(held.type))}`,
						),
						secondary(
							lhs.position,
							`this is ${withArticle(describeType(lhs.type))}`,
						),
					],
					notes: [
						"An update may only set keys of the Dictionary's key Type, with the Type it declared for its values.",
						...record.notes,
					],
					helps: record.helps,
				},
			)
		}
	}
}

// What is merged in must be a Dictionary the base could hold. Answers the Type
// the merge decided, so a base with Unknown slots takes them from it.
function reportUnmergeableDictionary(
	node: parser.CombinationNode,
	baseType: common.DictionaryType,
	rhs: common.typed.ExpressionNode,
): common.Type {
	if (rhs.type.type === "Error" || matchesType(baseType, rhs.type)) {
		return rhs.type
	}

	reportError(
		"This is not a Dictionary the update can merge in",
		node.rhs.position,
		{
			code: "partial-type-mismatch",
			labels: [
				primary(
					node.rhs.position,
					`this is ${withArticle(describeType(rhs.type))}`,
				),
				secondary(
					node.lhs.position,
					`this is ${withArticle(describeType(baseType))}`,
				),
			],
			notes: [
				"A whole-value update merges one Dictionary into another, so what is merged in has to hold the same key and value Types. The Argument wins on a key both hold.",
			],
			helps: [
				"Write the entries to set instead: '[base with \"key\" = value]'.",
			],
		},
	)

	return { type: "Error" }
}

// Braces update a Record and brackets a Dictionary. A base that wants the other
// pair is told so rather than reported as a Type mismatch. See "Record and
// Dictionary updates" in DEVELOPMENT.md.
function reportUpdateBrackets(
	node: parser.CombinationNode,
	lhs: common.typed.ExpressionNode,
	baseType: common.Type,
): boolean {
	let wantsBrackets = baseType.type === "Dictionary"

	if (wantsBrackets === (node.brackets === true)) {
		return false
	}

	reportError(
		wantsBrackets
			? "A Dictionary is updated in brackets"
			: "A Record is updated in braces",
		node.position,
		{
			code: "wrong-update-brackets",
			labels: [
				primary(
					node.position,
					wantsBrackets
						? "this update is written in braces"
						: "this update is written in brackets",
				),
				secondary(
					node.lhs.position,
					`this is ${withArticle(describeType(lhs.type))}`,
				),
			],
			notes: [
				"A Record's keys are the member names it declares, and a Dictionary's are values of its key Type — so the two are written differently and never interchangeably.",
			],
			helps: [
				wantsBrackets
					? "Write the update in brackets: '[base with \"key\" = value]'."
					: "Write the update in braces: '{ base with member = value }'.",
			],
		},
	)

	return true
}

// The update was written in the other pair and already reported. The right side
// is enriched silently for the language server, and the Combination answers the
// base's Type.
function combinationOfWrongBrackets(
	node: parser.CombinationNode,
	lhs: common.typed.ExpressionNode,
	scope: enricher.Scope,
): common.typed.CombinationNode {
	let { result: rhs } = collectDiagnostics(() =>
		enrichExpression(node.rhs, scope),
	)

	return {
		nodeType: "Combination",
		lhs,
		rhs,
		position: node.position,
		type: lhs.type,
	}
}

// A braced descend, `server.{ port = 1 }`, is a path key too.
function hasPathKeys(record: parser.RecordValueNode): boolean {
	return Object.values(record.members).some(
		(member) => member.steps !== undefined,
	)
}

function withoutPathKeys(
	members: Record<string, parser.RecordValueMemberNode>,
): Record<string, parser.RecordValueMemberNode> {
	return Object.fromEntries(
		Object.entries(members).filter(
			([, member]) => member.steps === undefined,
		),
	)
}

// The desugar mentions the updated value once per level, so it must be a place.
// A base that is no Record, or an Error, is left to the ordinary reading. See
// "Path keys" in DEVELOPMENT.md.
function updatableThroughPaths(
	node: parser.ExpressionNode,
	lhs: common.typed.ExpressionNode,
): boolean {
	if (lhs.type.type !== "Record") {
		return false
	}

	if (isPlace(node)) {
		return true
	}

	reportError("A path key updates a value it can name", node.position, {
		code: "path-on-computed-value",
		labels: [primary(node.position, "this is worked out here, not named")],
		notes: [
			"A path reaches into the value one level at a time, so the value is read once for each level it reaches through. A name, '@', or a chain of member reads over one of those reads the same value every time; anything worked out on the spot would be worked out again for each level.",
		],
		helps: [
			"Bind it to a Constant first, and update the Constant.",
			"Or write the nesting out by hand, so the value is worked out once.",
		],
	})

	return false
}

function isPlace(node: parser.ExpressionNode): boolean {
	switch (node.nodeType) {
		case "Identifier":
		case "Self":
			return true
		case "Lookup":
			return isPlace(node.base)
		default:
			return false
	}
}

// Desugars dotted keys into nested updates, one level per shared first step.
// See "Path keys" in DEVELOPMENT.md.
function enrichPathCombination(
	node: parser.CombinationNode,
	lhs: common.typed.ExpressionNode,
	keys: parser.RecordValueNode,
	scope: enricher.Scope,
): common.typed.CombinationNode {
	let rhs = pathUpdate(
		lhs,
		lhs.type as common.RecordType,
		pathKeyEntries(keys),
		keys.position,
		scope,
	)

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
			rhs,
		),
	}
}

export type PathKeyEntry = {
	// The steps still to walk, the first being the member this level writes.
	// Never empty.
	steps: Array<parser.IdentifierNode>
	member: parser.RecordValueMemberNode
}

function pathKeyEntries(record: parser.RecordValueNode): Array<PathKeyEntry> {
	return Object.values(record.members).map((member) => ({
		steps: member.steps ?? [member.name],
		member,
	}))
}

// What an entry writes one step further in. That is the rest of its path, or
// the member list of its braced descend once the path is used up.
export function stepInto(entry: PathKeyEntry): Array<PathKeyEntry> {
	if (entry.steps.length > 1) {
		return [{ steps: entry.steps.slice(1), member: entry.member }]
	}

	return pathKeyEntries(entry.member.group!)
}

function pathUpdate(
	base: common.typed.ExpressionNode,
	baseType: common.RecordType,
	entries: Array<PathKeyEntry>,
	position: common.Position,
	scope: enricher.Scope,
): common.typed.RecordValueNode {
	let groups = new Map<string, Array<PathKeyEntry>>()

	for (let entry of entries) {
		let group = groups.get(entry.steps[0].content)

		if (group === undefined) {
			groups.set(entry.steps[0].content, [entry])
		} else {
			group.push(entry)
		}
	}

	let members: Record<string, common.typed.ExpressionNode> = {}
	// Where each key of this level was written. The written AST has no Node for
	// it; see `typed.RecordValueNode.memberPositions`.
	let memberPositions: Record<string, common.Position> = {}

	for (let [name, group] of groups) {
		memberPositions[name] = group[0].steps[0].position

		// The Parser already refused a group holding both a whole member and a
		// path into it with `duplicate-member`. The whole member stands on its
		// own.
		let whole = group.find(
			(entry) =>
				entry.steps.length === 1 && entry.member.group === undefined,
		)

		if (whole !== undefined) {
			members[name] = enrichMember(
				whole.member,
				scope,
				baseType.members[name] ?? null,
			)

			continue
		}

		let step = group[0].steps[0]
		let stepType = pathKeyStepType(step, baseType, base.position)

		if (stepType.type !== "Record") {
			readDroppedEntries(group.flatMap(stepInto), null, scope)

			continue
		}

		let lookup: common.typed.LookupNode = {
			nodeType: "Lookup",
			base: clonePlace(base),
			member: {
				nodeType: "Identifier",
				content: step.content,
				position: step.position,
				type: stepType,
			},
			position: step.position,
			type: stepType,
		}
		let inner = pathUpdate(
			lookup,
			stepType,
			group.flatMap(stepInto),
			groupPosition(group),
			scope,
		)

		members[name] = {
			nodeType: "Combination",
			lhs: lookup,
			rhs: inner,
			position: inner.position,
			type: combinationTypeOf(
				stepType,
				inner.type,
				step.position,
				inner.position,
				inner,
			),
		}
	}

	let memberTypes: Record<string, common.Type> = {}

	for (let [name, member] of Object.entries(members)) {
		memberTypes[name] = member.type
	}

	return {
		nodeType: "RecordValue",
		members,
		position,
		type: recordValueTypeOf(null, memberTypes, null),
		declaredType: null,
		memberPositions,
	}
}

// A step a path key reaches through must be a Record. A Case is not updated,
// since rebuilding one is a construction. Silent on an Error.
function pathKeyStepType(
	step: parser.IdentifierNode,
	baseType: common.RecordType,
	basePosition: common.Position,
): common.Type {
	let stepType = lookupTypeOf(baseType, step.content, {
		member: step.position,
		base: basePosition,
	})

	if (stepType.type === "Record" || stepType.type === "Error") {
		return stepType
	}

	reportError("A path key steps through Records only", step.position, {
		code: "path-step-not-a-record",
		labels: [
			primary(
				step.position,
				`this is ${withArticle(describeType(stepType))}`,
			),
		],
		notes: [
			"Every step but the last names the value the step after it reaches into, and only a Record has members to reach.",
		],
		helps: [`Set '${step.content}' as a whole instead.`],
	})

	return { type: "Error" }
}

// The span of one level's keys, starting after the step that opened the level
// so two labels never share a span. `server.port = 1` gives `port = 1`, and
// `server.{ port = 1 }` gives the braces.
function groupPosition(group: Array<PathKeyEntry>): common.Position {
	let first = group[0]
	let last = group[group.length - 1].member

	return {
		start: (first.steps[1] ?? first.member.group!).position.start,
		end: (last.value ?? last.group!).position.end,
	}
}

// The same place as a Node of its own, so the optimiser never rewrites one Node
// in several places.
function clonePlace(
	node: common.typed.ExpressionNode,
): common.typed.ExpressionNode {
	if (node.nodeType !== "Lookup") {
		return { ...node }
	}

	return { ...node, base: clonePlace(node.base), member: { ...node.member } }
}

// The Scope a Method's Parameter list and body are read in. It holds the
// Method's Type Parameters as opaque uses, then `@` bound to the receiver or
// refused. A native Method's defaults are read in the same Scope.
function methodScope(
	generics: Array<parser.GenericDeclarationNode>,
	scope: enricher.Scope,
	selfType: common.Type | null,
	isStatic: boolean,
): enricher.Scope {
	let newScope = scopeWithGenerics(generics, scope)

	if (isStatic) {
		// A static Method is emitted without the `_self` Parameter `@` lowers
		// to. The mark refuses `@`, rather than letting the Namespace's `@`
		// answer.
		newScope.isStaticMethodBody = true
	} else if (selfType !== null) {
		declareVariableInScope(
			"@",
			shadowSelfTypeGenerics(selfType, generics, newScope),
			newScope,
			true,
		)
	}

	return newScope
}

export function enrichMethodFunctionDefinition(
	method: parser.FunctionValueNode,
	scope: enricher.Scope,
	selfType: common.Type | null,
	// The Method's resolved signature, so the annotations resolve once.
	signature: common.FunctionType,
	// Constrained Namespace Type Parameters of a conditional conformance's
	// fulfilling Method. They are bounded in the body Scope and lead the typed
	// Generics, so their hidden conformance Parameters are emitted first.
	injectedGenerics: Array<common.typed.GenericDeclarationNode> = [],
	// A static Method has no receiver, and its body Scope stops `@` resolution.
	isStatic: boolean = false,
	// The Method a bound report names; see `Scope.methodName`.
	methodName: string | null = null,
): common.typed.FunctionDefinitionNode {
	// `scope` and `selfType` already carry any injected bounds. The Method's
	// own Type Parameters are registered as GenericUses for its signature and
	// body.
	refuseUndecidedTypeParameters(
		method.value.generics,
		namespaceParameterNames(scope),
	)

	let newScope = methodScope(method.value.generics, scope, selfType, isStatic)

	if (methodName !== null) {
		newScope.methodName = methodName
	}

	// Set before the body so a bare Case after `<-` resolves against the
	// declared return Type.
	let returnType = signature.returnType
	let completing = method.value.completing === true

	newScope.expectedReturnType = returnedTypeOf(returnType, completing)

	// A default suspends nothing, as in `enrichFunctionDefinition`.
	newScope.completing = null
	newScope.completingBarrier = "parameter-default"

	let { parameters, bindings } = enrichParameterList(
		method.value.parameters,
		newScope,
		signature.parameterTypes,
	)

	newScope.completing = completing ? returnType : null
	delete newScope.completingBarrier

	return {
		nodeType: "FunctionDefinition",
		generics: [
			...injectedGenerics,
			...method.value.generics.map((generic) =>
				enrichGenericDeclarationNode(generic, scope),
			),
		],
		parameters,
		// A Parameter's Pattern desugars into Constants at the head of the
		// body, as a Matcher's bindings do.
		body: [
			...bindings,
			...method.value.body.flatMap((node) => enrichNode(node, newScope)),
		],
		returnType,
		// A Method always writes its annotations; only a Function literal may
		// omit them.
		inferredReturnType: null,
		parameterListPosition: method.value.parameterListPosition,
		headPosition: signatureHeadPositionOf(method.value),
		...(completing ? { completing: true as const } : {}),
	}
}

// A Method's Type Parameter shadows a Namespace's of the same name, as in
// `List.sorted<infer ItemType is Comparable>`. `@` must then carry the Method's
// bounded Type Parameter so the body can call through the bound.
// `withInjectedBounds` does the same for injected Namespace Type Parameters.
function shadowSelfTypeGenerics(
	selfType: common.Type,
	generics: Array<parser.GenericDeclarationNode>,
	scope: enricher.Scope,
): common.Type {
	if (generics.length === 0) {
		return selfType
	}

	// Read from the Scope the Method's Type Parameters were registered in, so
	// `@` and the Parameter Types share one object.
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

function enrichGenericDeclarationNode(
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

function enrichFunctionDefinition(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.typed.FunctionDefinitionNode {
	refuseDuplicateTypeParameters(node.generics)
	refuseUndecidedTypeParameters(node.generics, new Set())

	// Declared Type Parameters are opaque GenericUses in the body; each call
	// site binds them through inference.
	let newScope = scopeWithGenerics(node.generics, scope)

	// A literal that omitted its annotations was resolved against the expected
	// signature during overload matching. The expected Type is gone here, so it
	// is read back.
	let contextualType = contextualFunctionTypeOf(node, scope)

	// Resolved before the body so a bare Case after `<-` resolves against the
	// declared return Type.
	let returnType =
		contextualType?.returnType ??
		(node.returnType === null
			? { type: "Error" as const }
			: resolveType(node.returnType, newScope))

	let completing = node.completing === true

	newScope.expectedReturnType = returnedTypeOf(returnType, completing)

	// A default suspends nothing: the emitted Function fills it in outside the
	// async closure of a completing body. The barrier stands while the
	// Parameters are read.
	newScope.completing = null
	newScope.completingBarrier = "parameter-default"

	let { parameters, bindings } = enrichParameterList(
		node.parameters,
		newScope,
		contextualType?.parameterTypes,
	)

	newScope.completing = completing ? returnType : null
	delete newScope.completingBarrier

	return {
		nodeType: "FunctionDefinition",
		parameters,
		generics: node.generics.map((generic) =>
			enrichGenericDeclarationNode(generic, scope),
		),
		// A Parameter's Pattern desugars into Constants at the head of the
		// body, as a Matcher's bindings do.
		// A body stands in no Argument; see `callRefused`.
		body: [
			...bindings,
			...underRefusedCall(false, () =>
				node.body.flatMap((node) => enrichNode(node, newScope)),
			),
		],
		returnType,
		inferredReturnType: node.returnType === null ? returnType : null,
		...declaredReturnShape(node),
		parameterListPosition: node.parameterListPosition,
		headPosition: signatureHeadPositionOf(node),
		...(completing ? { completing: true as const } : {}),
	}
}

// The return Type the expected signature declared for an omitted one, its
// Type Parameters left open, which a `<-` names members against.
function declaredReturnShape(node: parser.FunctionDefinitionNode): {
	returnShape?: common.Type
} {
	let shape = recordedContextualFunctionType(node)?.declaredReturn ?? null

	return node.returnType === null && shape !== null
		? { returnShape: shape }
		: {}
}

// A Scope where the injected Namespace Type Parameters carry their `where`
// bounds, with the matching `selfType`. A fulfilling Method then resolves
// Protocol Methods on `Item` and on the members of `@`.
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

	// `namespaceDeclaringGeneric` asks only the Scope that declares a name.
	// INVARIANT: a Scope declaring one of a Namespace's Type Parameters carries
	// the Namespace.
	let enclosing = enclosingNamespaceOf(scope)
	let boundedScope = childScope(scope, {
		types: Object.fromEntries(boundedUses.map((use) => [use.name, use])),
		...(enclosing === null ? {} : { namespace: enclosing }),
	})

	let bindings = new Map(boundedUses.map((use) => [use.name, use]))

	return {
		scope: boundedScope,
		selfType:
			selfType === null ? null : applyGenericBindings(selfType, bindings),
	}
}

// One form of a Method without the `<…>` entries that bound the Namespace's own
// Type Parameters. `withInjectedBounds` brings those in already bounded. Left
// in, the name would be declared twice and two witness Parameters emitted.
function methodWithOwnGenerics(
	method: parser.FunctionValueNode,
	own: Array<parser.GenericDeclarationNode>,
): parser.FunctionValueNode {
	return own.length === method.value.generics.length
		? method
		: { ...method, value: { ...method.value, generics: own } }
}

function enrichMethodFunctionValue(
	node: parser.SimpleMethod | parser.StaticMethod,
	scope: enricher.Scope,
	selfType: common.Type | null,
	injectedGenerics: Array<common.typed.GenericDeclarationNode> = [],
	own: Array<parser.GenericDeclarationNode> = node.method.value.generics,
): common.typed.FunctionValueNode {
	let bounded = withInjectedBounds(scope, selfType, injectedGenerics)
	let method = methodWithOwnGenerics(node.method, own)

	// The signature is resolved once and seeds the body enrichment.
	let type = resolveFunctionValueType(method, bounded.scope)

	return {
		nodeType: "FunctionValue",
		value: enrichMethodFunctionDefinition(
			method,
			bounded.scope,
			bounded.selfType,
			type,
			injectedGenerics,
			// Read off the Node, so a call site can not enrich a static Method
			// as an instance one. Its `selfType` is still the target Type,
			// which its signature may name.
			node.nodeType === "StaticMethod",
			node.name.content,
		),
		position: node.method.position,
		type,
	}
}

function enrichMethodsFunctionValue(
	node: parser.OverloadedMethod | parser.OverloadedStaticMethod,
	scope: enricher.Scope,
	selfType: common.Type | null,
	// One list per Overload, matching the Overload's own entry in the resolved
	// Method Type.
	injectedGenerics: Array<Array<common.typed.GenericDeclarationNode>> = [],
	// One list per Overload, since a per-Method bound is written on one form's
	// `<…>`.
	ownGenerics: Array<Array<parser.GenericDeclarationNode>> = [],
): Array<common.typed.FunctionValueNode> {
	let results: Array<common.typed.FunctionValueNode> = []

	for (let [index, entry] of Object.values(node.methods).entries()) {
		let injected = injectedGenerics[index] ?? []
		let bounded = withInjectedBounds(scope, selfType, injected)
		let method = methodWithOwnGenerics(
			entry,
			ownGenerics[index] ?? entry.value.generics,
		)
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
				node.name.content,
			),
			position: method.position,
			type,
		})
	}

	return results
}

function enrichRecordValue(
	node: parser.RecordValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
	// Set where the Literal merges into a default: an Argument for a Record
	// Parameter, or a Case payload. Only there may it carry path keys. See
	// "Path keys" in DEVELOPMENT.md.
	mergeable = false,
): common.typed.RecordValueNode {
	// The annotation is resolved once and handed to the core, the one place
	// that reports `record-annotation-not-record`.
	let resolvedAnnotation =
		node.type !== null ? resolveType(node.type, scope) : null

	// A member's expected Type comes from the Literal's own annotation first,
	// then from the surrounding position.
	let expectedMembers = expectedRecordMembers(
		resolvedAnnotation ?? expectedType,
	)

	if (hasPathKeys(node) && mergeable) {
		reportBarePathKeys(node, scope)
	}

	let level =
		hasPathKeys(node) && mergeable
			? mergedLevel(pathKeyEntries(node), scope, expectedMembers)
			: {
					members: enrichMembers(
						hasPathKeys(node)
							? refusePathKeys(
									node.members,
									scope,
									expectedMembers,
								)
							: node.members,
						scope,
						expectedMembers,
					),
					memberPositions: undefined,
				}

	let memberTypes: Record<string, common.Type> = {}

	for (let [memberKey, memberValue] of Object.entries(level.members)) {
		memberTypes[memberKey] = memberValue.type
	}

	return {
		nodeType: "RecordValue",
		members: level.members,
		position: node.position,
		// Where each key of a merged Literal was written, so a Diagnostic about
		// a path can underline its step. Absent on a Literal without path keys.
		...(level.memberPositions === undefined
			? {}
			: { memberPositions: level.memberPositions }),
		type: recordValueTypeOf(
			resolvedAnnotation,
			memberTypes,
			node.type?.position ?? null,
		),
		// Only a Record annotation is a declared Type.
		declaredType:
			resolvedAnnotation !== null && resolvedAnnotation.type === "Record"
				? resolvedAnnotation
				: null,
	}
}

// One level of a merged Literal, with its path keys written out as nested
// partial Records. See "Path keys" in DEVELOPMENT.md.
function mergedLevel(
	entries: Array<PathKeyEntry>,
	scope: enricher.Scope,
	expectedMembers: Record<string, common.Type> | null,
): {
	members: Record<string, common.typed.ExpressionNode>
	memberPositions: Record<string, common.Position>
} {
	let groups = new Map<string, Array<PathKeyEntry>>()

	for (let entry of entries) {
		let group = groups.get(entry.steps[0].content)

		if (group === undefined) {
			groups.set(entry.steps[0].content, [entry])
		} else {
			group.push(entry)
		}
	}

	let members: Record<string, common.typed.ExpressionNode> = {}
	let memberPositions: Record<string, common.Position> = {}

	for (let [name, group] of groups) {
		memberPositions[name] = group[0].steps[0].position

		// The Parser already refused a group holding both a whole member and a
		// path into it with `duplicate-member`. The whole member stands on its
		// own.
		let whole = group.find(
			(entry) =>
				entry.steps.length === 1 && entry.member.group === undefined,
		)

		if (whole !== undefined) {
			members[name] = enrichMember(
				whole.member,
				scope,
				expectedMembers?.[name] ?? null,
			)

			continue
		}

		let inner = mergedLevel(
			group.flatMap(stepInto),
			scope,
			expectedRecordMembers(expectedMembers?.[name] ?? null),
		)
		let innerTypes: Record<string, common.Type> = {}

		for (let [innerKey, innerValue] of Object.entries(inner.members)) {
			innerTypes[innerKey] = innerValue.type
		}

		members[name] = {
			nodeType: "RecordValue",
			members: inner.members,
			position: groupPosition(group),
			type: { type: "Record", members: innerTypes },
			declaredType: null,
			memberPositions: inner.memberPositions,
			merged: true,
		}
	}

	return { members, memberPositions }
}

function enrichStringValue(
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

// A hole prints through its value's `toString`, so its Type must be
// `Printable`, solved as a bounded Method's items are. Otherwise it reports
// `interpolation-not-printable`, and a placeholder witness keeps enriching.
function enrichInterpolatedStringValue(
	node: parser.InterpolatedStringValueNode,
	scope: enricher.Scope,
): common.typed.InterpolatedStringValueNode {
	let segments: Array<common.typed.InterpolationSegmentNode> =
		node.segments.map((segment) => {
			if (segment.kind === "text") {
				return segment
			}

			// A hole holding only a name may not be meant as a hole, as in
			// `"use { and } carefully"`, so an undeclared name there is
			// answered differently.
			let expression =
				segment.expression.nodeType === "Identifier"
					? enrichIdentifierExpression(segment.expression, scope, {
							inStringHole: true,
						})
					: enrichExpression(segment.expression, scope)

			reportRedundantInterpolatedToString(expression, scope)

			let solved = solveConformance(
				expression.type,
				"Printable",
				scope,
				expression.position,
			)

			if (!solved.ok) {
				// An empty chain was already reported, as in
				// `resolveConformances`.
				if (solved.chain.length > 0) {
					let answer = interpolationAnswer(expression.type, scope)

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
							notes: [...solved.chain, ...answer.notes],
							helps: answer.helps,
							...(answer.data === undefined
								? {}
								: { data: answer.data }),
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

// What a hole that can not print its value is told. A Future or a Started is a
// forgotten `complete`, and a Type Parameter a missing bound. Anything else,
// such as an Optional, is told to match it apart first.
function interpolationAnswer(
	type: common.Type,
	scope: enricher.Scope,
): {
	notes: Array<string>
	helps: Array<string>
	data?: common.DiagnosticData
} {
	let erased = eraseRefinements(type)
	let waiting = unwaitedWorkReport(
		erased,
		bodyCanWait(scope),
		completionBarrierIn(scope),
	)

	if (waiting !== null) {
		return waiting
	}

	if (erased.type === "GenericUse") {
		// The bound it already carries goes with the question, since a second
		// bound is the one-bound rule.
		let bound = typeParameterBoundReport(
			erased.name,
			"Printable",
			scope,
			erased.constraint ?? null,
		)

		return { notes: bound.notes, helps: bound.helps }
	}

	return {
		notes: [],
		helps: [
			"Interpolate only Printable values; match an Optional or a Union apart first and interpolate each Case.",
		],
	}
}

// A hole already renders its value through the `Printable` receiver's
// `toString`. The call is kept when it takes an Argument, answers no String, or
// has a receiver that is not itself Printable.
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

	// Solved silently: an ambiguous conformance is the receiver's Diagnostic,
	// not the hole's.
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

	// The span runs from the end of the receiver to the end of the Invocation.
	// The greyed range is then exactly what deleting the call removes.
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

function enrichIntegerValue(
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

function enrichRationalValue(
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

function enrichBooleanValue(
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

function enrichFunctionValue(
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

// The Scopes of the Function literals being enriched, innermost last. A name
// resolving at or above one is captured, and the body is checked once against
// the Type the captured name has now.
let captureBoundaries: Array<enricher.Scope> = []

// Whether `declaringScope` is the innermost literal's Scope or an ancestor of
// it. The literal's own Parameters and locals live below the boundary and are
// no captures.
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

// A capture of an undecided Type, such as a `List<Unknown>` from `[]`, is
// refused. The body was checked against a Type that fits every List, and a
// later assignment can not make that check true.
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
	// A Dictionary has two slots rather than an item Type. The Help's
	// annotation is the captured Type with its blanks filled where they stand,
	// under the Declaration's own keyword.
	let annotation = undecidedSlotAnnotation(
		type,
		declaringScope.constants.has(node.content) ? "constant" : "variable",
		node.content,
	)
	let dictionary = annotation.container === "Dictionary"

	reportError(
		dictionary
			? `'${node.content}' is captured before its key and value Types are decided`
			: `'${node.content}' is captured before its item Type is decided`,
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
				dictionary
					? "An empty Dictionary Literal leaves its key and value Types unknown until an assignment decides them, and this Function was checked before that happened."
					: "An empty List Literal leaves its item Type unknown until an assignment decides it, and this Function was checked before that happened.",
			],
			// The printed Type is made up, since nothing decided the blank, so
			// the Help says it is an example.
			helps: [
				`Annotate the declaration — '${annotation.annotation}', for instance — so the Function is checked against the ${dictionary ? "Types" : "Type"} it will hold.`,
			],
		},
	)

	capturesReportedUndecided.add(node)
	noteRefusedCapture(type)
}

// Captures already refused for an undecided Type. The call around one has an
// undecided receiver, so its unbound Type Parameters are not reported again.
let capturesReportedUndecided = new WeakSet<parser.IdentifierNode>()

function enrichListValue(
	node: parser.ListValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.typed.ListValueNode {
	// The items are read under the expected List's item Type, so `constant
	// items: List<Box<Integer>> = [Box#Empty]` decides the Case as an
	// annotation would.
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

// `["alex" = 39, "sam" = 25]` and `[=]`. Each slot is decided as a List's item
// Type is, and is Unknown where nothing was written. A Dictionary compares its
// keys, so a literal with entries carries an Equatable witness for the
// construction.
function enrichDictionaryValue(
	node: parser.DictionaryValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.typed.DictionaryValueNode {
	let expected = expectedDictionarySlots(expectedType)
	let entries = enrichDictionaryEntries(
		node.entries,
		scope,
		expected?.keyType ?? null,
		expected?.valueType ?? null,
	)
	let type: common.DictionaryType = {
		type: "Dictionary",
		keyType: listItemTypeOf(entries.map((entry) => entry.key.type)),
		valueType: listItemTypeOf(entries.map((entry) => entry.value.type)),
	}

	return {
		nodeType: "DictionaryValue",
		entries,
		position: node.position,
		type,
		// The empty Dictionary has an Unknown key Type and no key to compare,
		// so it asks for no witness.
		keyConformance:
			entries.length === 0
				? null
				: equatableKeyConformance(type.keyType, scope, node.position),
	}
}

// One bracket list's entries, enriched and checked for a key written twice.
// Shared by the literal and by the key list of an update.
function enrichDictionaryEntries(
	entries: Array<parser.DictionaryEntryNode>,
	scope: enricher.Scope,
	expectedKeyType: common.Type | null,
	expectedValueType: common.Type | null,
): Array<common.typed.DictionaryEntryNode> {
	// Each half is read under the expected slot, so a bare `#Red` resolves
	// under a `Dictionary<Suit, Integer>` as under a `List<Suit>`.
	let enriched = entries.map((entry) => ({
		key: enrichExpression(entry.key, scope, expectedKeyType),
		value: enrichExpression(entry.value, scope, expectedValueType),
		position: entry.position,
	}))

	reportDuplicateKeys(enriched)

	return enriched
}

// The key and value Types an expected Type wants, unwrapping a Union as
// `expectedListItemType` does. `null` where no arm is a Dictionary.
function expectedDictionarySlots(
	expectedType: common.Type | null,
): { keyType: common.Type; valueType: common.Type } | null {
	if (expectedType === null) {
		return null
	}

	let dictionaries = unionArmsOf(expectedType).flatMap((member) =>
		member.type === "Dictionary" ? [member] : [],
	)

	if (dictionaries.length === 0) {
		return null
	}

	return {
		keyType: buildUnion(
			dictionaries.map((dictionary) => dictionary.keyType),
		),
		valueType: buildUnion(
			dictionaries.map((dictionary) => dictionary.valueType),
		),
	}
}

// The Equatable witness a construction compares its keys through. It resolves
// as the bound of `Dictionary.of` does, so both refuse a key Type in the same
// words. `null` where the bound went unsatisfied and was reported.
function equatableKeyConformance(
	keyType: common.Type,
	scope: enricher.Scope,
	position: common.Position,
): common.Conformance | null {
	return (
		resolveConformances(
			[
				{
					name: "KeyType",
					infer: true,
					defaultType: null,
					constraint: "Equatable",
				},
			],
			new Map([["KeyType", keyType]]),
			scope,
			position,
		)[0] ?? null
	)
}

// Two keys in one bracket list that are the same value. At runtime the later
// one silently wins, so a key written twice loses an entry. Only keys
// comparable as written are reported.
function reportDuplicateKeys(
	entries: Array<common.typed.DictionaryEntryNode>,
): void {
	let seen = new Map<string, common.typed.DictionaryEntryNode>()

	for (let entry of entries) {
		let identity = writtenKeyIdentity(entry.key)

		if (identity === null) {
			continue
		}

		let first = seen.get(identity)

		if (first === undefined) {
			seen.set(identity, entry)

			continue
		}

		reportError("This key is written twice", entry.key.position, {
			code: "duplicate-key",
			labels: [
				primary(entry.key.position, "written a second time here"),
				secondary(first.key.position, "first written here"),
			],
			notes: [
				"A Dictionary holds one value per key, so the second entry would take the first one's place and nothing would say the first was ever there.",
			],
			helps: ["Keep one entry for the key."],
		})
	}
}

// What makes two written keys the same key, or null where this can not decide.
// It agrees with the runtime's key encoding: Strings compare NFC-normalised,
// Rationals in lowest terms, and `3/1` as the Integer `3`. A Case with a
// payload is not read, because a Namespace may define its own `is` for it.
function writtenKeyIdentity(key: common.typed.ExpressionNode): string | null {
	switch (key.nodeType) {
		case "IntegerValue":
			return /^-?\d+$/.test(key.value)
				? `Integer ${BigInt(key.value)}`
				: null
		case "RationalValue": {
			let spelling = reducedRationalSpelling(
				key.numerator,
				key.denominator,
			)
			let whole = spelling.match(/^(-?\d+)\/1$/)

			return whole === null
				? `Rational ${spelling}`
				: `Integer ${whole[1]}`
		}
		case "StringValue":
			return `String ${JSON.stringify(key.value.normalize("NFC"))}`
		case "BooleanValue":
			return `Boolean ${key.value}`
		case "CaseValue":
			return key.value === null && key.type.type === "Case"
				? `Case ${key.type.choice}#${key.type.name}`
				: null
		default:
			return null
	}
}

// The base of a Lookup, enriched knowing the member's name. `user?.name` is one
// Identifier, and its Help offers `user::map(.name)`.
function enrichLookupBase(
	node: parser.LookupNode,
	scope: enricher.Scope,
): common.typed.ExpressionNode {
	if (node.base.nodeType !== "Identifier") {
		return enrichExpression(node.base, scope)
	}

	return enrichIdentifierExpression(node.base, scope, {
		readMember: node.member.content,
	})
}

function enrichLookup(
	node: parser.LookupNode,
	scope: enricher.Scope,
	// The Invocation that calls this Lookup. A missing member that is called
	// is a Method call written with another language's separator, and the
	// Diagnostic says so. A provided member's Arguments choose its Protocol.
	call: InvokingCall | null = null,
): common.typed.LookupNode {
	// A base naming a Type, such as a Choice or a bounded Type Parameter, reads
	// its member off a Namespace nobody declared. Asked before enriching the
	// base, which would report `unknown-name`, and only for a member that
	// Namespace offers.
	let named = namespaceNamedByType(node, scope)
	let base: common.typed.ExpressionNode =
		named === null || node.base.nodeType !== "Identifier"
			? enrichLookupBase(node, scope)
			: {
					nodeType: "Identifier",
					content: node.base.content,
					position: node.base.position,
					// Typed as what the author named, not as the fabricated
					// Namespace, whose name Hover would otherwise show.
					type: named.targetType ?? { type: "Error" },
				}
	// A Method a conformance puts in reach is read off the Namespace, as in
	// `Number.isLessThan(a, b)`. Asked before `lookupTypeOf`, and only for a
	// name the Namespace does not declare.
	let provided =
		base.type.type === "Namespace" &&
		!Object.hasOwn(base.type.properties, node.member.content) &&
		!Object.hasOwn(base.type.methods, node.member.content)
			? providedNamespaceMember(base.type, node, scope, call)
			: null
	// A Method no Namespace holds: a Choice's derived `cases`, or what a
	// bounded Type Parameter's conformance answers. Both carry what the
	// emission needs.
	let fabricated = fabricatedMember(
		named,
		base.type,
		node.member.content,
		scope,
	)
	// The Lookup and its member Identifier share one Type.
	let type =
		provided?.type ??
		fabricated?.type ??
		lookupTypeOf(
			base.type,
			node.member.content,
			{
				member: node.member.position,
				base: node.base.position,
			},
			memberAccessContext(
				node,
				base.type,
				scope,
				call !== null,
				call?.node.arguments.length ?? 0,
			),
			scope,
		)

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
		...(provided === null ? {} : { providedBy: provided.providedBy }),
		...(fabricated?.derivedCases === undefined
			? {}
			: { derivedCases: fabricated.derivedCases }),
		...(fabricated?.conformanceName === undefined
			? {}
			: { conformanceName: fabricated.conformanceName }),
		...(fabricated?.namespaceName === undefined
			? {}
			: { namespaceName: fabricated.namespaceName }),
	}
}

// The base of a Lookup as the reader wrote it, a name or a run of members read
// off one, and null otherwise. A Help prints the reader's own text or nothing,
// as `writtenValueText` in the Parser does.
function spelledLookupBase(base: parser.ExpressionNode): string | null {
	if (base.nodeType === "Identifier") {
		return base.content
	}

	if (base.nodeType === "Lookup") {
		let inner = spelledLookupBase(base.base)

		return inner === null ? null : `${inner}.${base.member.content}`
	}

	return null
}

// What a Lookup that finds no member is answered with; see
// `MemberAccessContext`. The Method question is a thunk, so a Lookup that finds
// its member never walks the Namespaces. Null for a Namespace base, whose
// members a `.` reaches.
function memberAccessContext(
	node: parser.LookupNode,
	baseType: common.Type,
	scope: enricher.Scope,
	isCalled: boolean,
	writtenArguments: number,
): MemberAccessContext | null {
	if (baseType.type === "Namespace") {
		return null
	}

	return {
		// The `.` and any whitespace around it, which a fix overwrites whole.
		separator: {
			start: node.base.position.end,
			end: node.member.position.start,
		},
		isCalled,
		writtenArguments,
		spelledBase: spelledLookupBase(node.base),
		methodNamed: (name) => {
			let declaring = namespacesDeclaringMethod(
				name,
				resolveMethodLookupNamespacesForReceiverType(
					baseType,
					null,
					scope,
				),
				baseType,
				scope,
				node.member.position,
			)

			for (let namespace of declaring.values()) {
				let method = namespace.methods[name]

				if (method !== undefined) {
					return method
				}
			}

			return null
		},
	}
}

// A member of a Namespace nobody declared, with what its emission needs. A
// Choice's derived `cases` is emitted from the Case tags. A bounded Type
// Parameter's member is emitted against the hidden witness Parameter.
function fabricatedMember(
	named: common.NamespaceType | null,
	baseType: common.Type,
	memberName: string,
	scope: enricher.Scope,
): {
	type: common.MethodType
	derivedCases?: Array<string>
	conformanceName?: string
	namespaceName?: string
} | null {
	let namespace =
		named ??
		(baseType.type === "Namespace" && memberName === enumerableMethodName
			? derivedEnumerableNamespaceFor(baseType, scope)
			: null)

	if (namespace === null || namespace.targetType === null) {
		return null
	}

	let method = namespace.methods[memberName]

	if (method === undefined) {
		return null
	}

	return {
		type: method,
		...(namespace.name === derivedEnumerableNamespaceName
			? { derivedCases: derivedCaseTags(namespace.targetType) ?? [] }
			: {}),
		...(namespace.targetType.type === "GenericUse"
			? { conformanceName: namespace.name }
			: {}),
		// A Namespace that writes the Method the derive would answer. The base
		// spells the Choice, so the emission needs the Namespace's name.
		...(namespace.name !== derivedEnumerableNamespaceName &&
		namespace.targetType.type !== "GenericUse"
			? { namespaceName: namespace.name }
			: {}),
	}
}

// `.price` and `.address.city`: the Function the compiler writes for the
// position the path stands in. See "Member paths" in DEVELOPMENT.md.
function enrichMemberPath(
	node: parser.MemberPathNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.typed.FunctionValueNode {
	// An Argument is matched in one pass and enriched in another, so a path
	// matched as an Argument reads back what the matching recorded.
	let expected = expectedType ?? recordedMemberPathType(node)
	let rootType = memberPathRootType(expected)

	if (rootType === null) {
		// Silent inside a refused call, and at a position that is itself an
		// Error; see `callRefused` and `positionWasRefused`.
		if (!insideRefusedCall() && !positionWasRefused(expected)) {
			reportPathWithoutContext(node, expected)
		}

		return memberPathFunction(
			node,
			{ type: "Error" },
			node.steps.map(() => ({ type: "Error" })),
		)
	}

	return memberPathFunction(
		node,
		rootType,
		memberPathStepTypes(node, rootType, scope),
	)
}

// What a path reads its first member off: the one Parameter of the Function the
// position expects, and nothing else.
function memberPathRootType(expected: common.Type | null): common.Type | null {
	if (
		expected === null ||
		expected.type !== "Function" ||
		expected.parameterTypes.length !== 1
	) {
		return null
	}

	return expected.parameterTypes[0].type
}

// The Type each step reads, in written order, so the last is the Function's
// return Type. A step reads off a Record or a Case only.
function memberPathStepTypes(
	node: parser.MemberPathNode,
	rootType: common.Type,
	scope: enricher.Scope,
): Array<common.Type> {
	let stepTypes: Array<common.Type> = []
	let baseType = rootType
	let basePosition = node.position

	for (let step of node.steps) {
		let stepType = memberPathStepType(
			node,
			step,
			baseType,
			basePosition,
			scope,
		)

		stepTypes.push(stepType)
		baseType = stepType
		basePosition = step.position
	}

	return stepTypes
}

function memberPathStepType(
	node: parser.MemberPathNode,
	step: parser.IdentifierNode,
	baseType: common.Type,
	basePosition: common.Position,
	scope: enricher.Scope,
): common.Type {
	if (baseType.type === "Record" || baseType.type === "Case") {
		return lookupTypeOf(baseType, step.content, {
			member: step.position,
			base: basePosition,
		})
	}

	// Silent on an Error and an Unknown, which the Invocation reports itself.
	// A Type Parameter the reader wrote has no members.
	if (
		baseType.type === "Error" ||
		baseType.type === "Unknown" ||
		(baseType.type === "GenericUse" &&
			answersStepOffTypeParameter(node, step, baseType, scope))
	) {
		return { type: "Error" }
	}

	reportError("A member path steps through Records only", step.position, {
		code: "path-step-not-a-record",
		labels: [
			primary(
				step.position,
				`read off ${withArticle(describeType(baseType))}`,
			),
		],
		...stepOffValueAdvice(baseType, step.content),
	})

	return { type: "Error" }
}

// How a path is written, for Diagnostics that quote it.
function memberPathSpelling(node: parser.MemberPathNode): string {
	return `.${node.steps.map((step) => step.content).join(".")}`
}

function reportPathWithoutContext(
	node: parser.MemberPathNode,
	expected: common.Type | null,
): void {
	reportError(
		"A member path stands where no Function is expected",
		node.position,
		{
			code: "path-without-context",
			labels: [primary(node.position, "this path names no value")],
			notes: [
				"A member path is a Function the Compiler writes for you, so it needs a Parameter Type to read the members off — and only a position expecting a Function of one Parameter names one.",
				pathContextNote(expected),
			],
			helps: pathWithoutContextHelps(node, expected),
		},
	)
}

// The edit a reader can make here. A position wanting a value gets a member
// read off a value. Otherwise the Help writes the literal with both Types as
// `<Type>` blanks, since a literal outside an Argument must annotate them.
function pathWithoutContextHelps(
	node: parser.MemberPathNode,
	expected: common.Type | null,
): Array<string> {
	let spelling = memberPathSpelling(node)

	if (expected !== null && expected.type !== "Function") {
		return [
			`This position expects ${withArticle(describeType(expected))} rather than a Function — read the members off a value instead, writing what this answers with in place of '<value>': '<value>${spelling}'.`,
		]
	}

	// A position asking for a Function of another arity gets a literal of that
	// arity, with the Parameters left to the reader.
	if (expected !== null && expected.parameterTypes.length !== 1) {
		return [
			`Write the Function literal instead, with ${countOf(expected.parameterTypes.length, "Parameter")} and a return Type, reading '${spelling.slice(1)}' off the one you mean.`,
		]
	}

	return [
		`Pass the path where a Function of one Parameter is expected — '::map(${spelling})'.`,
		`Or write the Function literal, with the Parameter and return Types a path leaves out — '(_ item: <Type>) -> <Type> { <- item${spelling} }', filling each '<Type>' in.`,
	]
}

// What the position asks for. A Function of the wrong arity is named by its
// Parameter count rather than printed in full again.
function pathContextNote(expected: common.Type | null): string {
	if (expected === null) {
		return "This position expects no particular Type."
	}

	if (expected.type === "Function") {
		return `This position expects a Function of ${countOf(expected.parameterTypes.length, "Parameter")}, and a path reads its members off exactly one.`
	}

	return `This position expects ${withArticle(describeType(expected))}.`
}

// The one Parameter of the synthesized Function. No source can spell `_0`. See
// "Member paths" in DEVELOPMENT.md.
const memberPathParameterName = "_0"

// `stepTypes[i]` is the Type of the Lookup that reads `steps[i]`. A refused
// path carries Error the whole way down but keeps its shape.
function memberPathFunction(
	node: parser.MemberPathNode,
	rootType: common.Type,
	stepTypes: Array<common.Type>,
): common.typed.FunctionValueNode {
	let returnType = stepTypes[stepTypes.length - 1] ?? rootType
	// The Parameter and the name the body reads it under stand at the first
	// step, so the leading dot is inside the Function's span only.
	let rootPosition = node.steps[0].position
	let expression: common.typed.ExpressionNode = {
		nodeType: "Identifier",
		content: memberPathParameterName,
		position: rootPosition,
		type: rootType,
	}

	for (let [index, step] of node.steps.entries()) {
		let stepType = stepTypes[index] ?? { type: "Error" }

		expression = {
			nodeType: "Lookup",
			base: expression,
			member: {
				nodeType: "Identifier",
				content: step.content,
				position: step.position,
				type: stepType,
			},
			position: { start: rootPosition.start, end: step.position.end },
			type: stepType,
		}
	}

	return {
		nodeType: "FunctionValue",
		value: {
			nodeType: "FunctionDefinition",
			generics: [],
			parameters: [
				{
					nodeType: "Parameter",
					externalName: null,
					internalName: {
						nodeType: "Identifier",
						content: memberPathParameterName,
						position: rootPosition,
						type: rootType,
					},
					position: rootPosition,
					type: rootType,
					// Null: an Inlay Hint draws an `inferredType`, and a path
					// has no annotation slot to draw one into.
					inferredType: null,
					defaultValue: null,
				},
			],
			body: [
				{
					nodeType: "ReturnStatement",
					expression,
					position: node.position,
				},
			],
			returnType,
			inferredReturnType: null,
			parameterListPosition: node.position,
			headPosition: node.position,
		},
		position: node.position,
		type: memberPathSignature(rootType, returnType),
		synthesized: "path",
	}
}

// The Type of the Function a path stands for. The Argument match asks for it
// before any Node is built.
function memberPathSignature(
	rootType: common.Type,
	returnType: common.Type,
): common.FunctionType {
	return {
		type: "Function",
		generics: [],
		parameterTypes: [{ name: null, type: rootType }],
		returnType,
	}
}

function enrichIdentifier(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
	type: common.Type = resolveIdentifierType(node, scope),
): common.typed.IdentifierNode {
	reportUninferableCapture(node, scope, type)

	// A value read out of a refused capture is refused with it.
	if (carriesRefusedCapture(type)) {
		capturesReportedUndecided.add(node)
	}

	return {
		nodeType: "Identifier",
		content: node.content,
		position: node.position,
		type,
	}
}

// An Identifier may stand for a member of `@`; see `selfMemberAliases`. The
// alias is read off the Scope that declares the name, so an inner binding
// shadows it.
function enrichIdentifierExpression(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
	// What the position knows about the name; see `NameContext`. It only
	// changes what an undeclared name is answered with.
	context: NameContext = {},
): common.typed.ExpressionNode {
	let declaringScope = findDeclaringScope(node.content, scope)
	let alias = declaringScope?.selfMemberAliases?.[node.content]

	if (declaringScope === null || alias === undefined) {
		let type = resolveIdentifierType(node, scope, context)

		noteOuterRead(node, type, scope)

		return valueOf(enrichIdentifier(node, scope, type), context)
	}

	return selfPathLookup(
		alias.path,
		declaringScope.members[node.content]!,
		alias.selfType,
		node.position,
		alias.stepPositions,
	)
}

function enrichSelf(
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

// A wildcard Handler stands for what the earlier Handlers have not caught, so
// `case _` after `case #Empty` types `@` as the other Case. With nothing left
// it is Unknown, so a redundant `case _` stays harmless.
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

	// Handling is checked member by member, as the validator's exhaustiveness
	// check does. A named nested Union with no member handled stays whole, so
	// Hover prints its name.
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

// A checked refinement can not be tested at runtime, since its predicate
// erases. A Matcher or a Pattern member annotation carrying one at any depth,
// such as `List<NonZero>`, is refused and answers an Error.
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

// Everything a Matcher establishes about its value, worked out once. A `match`
// Handler and an assertion share it, so an assertion never drifts from the arm
// it is spelled like.
type ResolvedMatcher = {
	matcher: common.Type
	literal: common.typed.ExpressionNode | null
	memberLiterals: Record<string, common.typed.ExpressionNode> | null
	memberTypes: Record<string, common.Type> | null
	// What a Case Matcher's payload Pattern requires and proved, which its
	// bindings are read at. Null for other Matchers and for a plain-name
	// payload.
	payload: PayloadRequirements | null
}

// `handledMatchers` is what earlier arms retired, which a wildcard stands for.
// An assertion hands an empty list. A Match's arms share `held`, so a subject
// holding the Choice its Cases name is reported once, by the first.
// `oneShape` is `isOneShapeMatch`, which an assertion never is.
function resolveMatcher(
	node: parser.MatcherNode,
	valueType: common.Type,
	handledMatchers: Array<common.Type>,
	scope: enricher.Scope,
	held = { reported: false },
	oneShape = false,
): ResolvedMatcher {
	if (node.nodeType === "LiteralMatcher") {
		// A literal Matcher types `@` as the literal's Type.
		let literal = enrichExpression(node.value, scope)

		return {
			matcher: literal.type,
			literal,
			memberLiterals: null,
			memberTypes: null,
			payload: null,
		}
	}

	if (node.nodeType === "WildcardMatcher") {
		return {
			matcher: resolveWildcardMatcherType(valueType, handledMatchers),
			literal: null,
			memberLiterals: null,
			memberTypes: null,
			payload: null,
		}
	}

	if (node.nodeType === "CaseMatcher") {
		let literals: Record<string, common.typed.ExpressionNode> = {}
		let matcher = resolveCaseMatcherType(node, valueType, scope, held)
		// The payload Pattern's requirements stand beside the Matcher, so the
		// Case stays the arm and only the Handler becomes conditional.
		let payload = resolvePayloadRequirements(node, matcher, scope, literals)

		return {
			matcher,
			literal: null,
			memberLiterals: Object.keys(literals).length > 0 ? literals : null,
			memberTypes: payload.memberTypes,
			payload,
		}
	}

	if (node.nodeType === "Pattern") {
		let literals: Record<string, common.typed.ExpressionNode> = {}
		let matcher = resolvePatternMatcherType(
			node,
			valueType,
			scope,
			literals,
			[],
			oneShape,
		)

		return {
			matcher,
			literal: null,
			memberLiterals: Object.keys(literals).length > 0 ? literals : null,
			memberTypes: null,
			payload: null,
		}
	}

	return {
		matcher: refuseRefinementMatcher(
			resolveType(node, scope),
			node.position,
		),
		literal: null,
		memberLiterals: null,
		memberTypes: null,
		payload: null,
	}
}

// What `start` and `complete` answer, member by member, as the runtime answers
// each member of a Union of work. One level: anonymous Unions are already flat,
// and a named Union stays whole. Null where no member is work.
function unwrapWork(
	type: common.Type,
	unwrap: (member: common.Type) => common.Type | null,
): common.Type | null {
	if (type.type !== "UnionType") {
		return unwrap(type)
	}

	let unwrapped = false
	let members = type.types.map((member) => {
		let answer = unwrap(member)

		if (answer === null) {
			return member
		}

		unwrapped = true

		return answer
	})

	return unwrapped ? buildUnion(members) : null
}

// `start expr` turns a `Future<Value>` into the `Started<Value>` of one run. It
// waits for nothing, so it is legal anywhere. An operand that is no Future
// answers itself, so the Warning does not cascade.
function enrichStart(
	node: parser.StartNode,
	scope: enricher.Scope,
): common.typed.StartNode {
	let expression = enrichExpression(node.expression, scope)
	let type = expression.type
	let started = unwrapWork(type, (member) =>
		member.type === "Future"
			? { type: "Started", valueType: member.valueType }
			: null,
	)

	if (started !== null) {
		return {
			nodeType: "Start",
			expression,
			position: node.position,
			type: started,
		}
	}

	if (!isReportedValue(type)) {
		reportWarning(
			type.type === "Started"
				? "This is already in flight"
				: "This is not a Future, so there is nothing to start",
			node.position,
			{
				code: "needless-start",
				labels: [
					primary(
						node.expression.position,
						`this is ${withArticle(describeType(type))}`,
					),
				],
				tags: ["unnecessary"],
				// A Started is already work, so its Note says it is in flight
				// rather than that it is no work.
				notes: [
					type.type === "Started"
						? "A Started is one run of a Future, and it belongs to whoever started it — there is no second run to ask for."
						: "'start' puts a Future in flight and answers the one run of it — a value that is not a Future describes no work to run.",
				],
				helps: ["Drop the 'start'."],
			},
		)
	}

	return {
		nodeType: "Start",
		expression,
		position: node.position,
		type,
	}
}

// `complete expr` answers the `Value` of a `Future<Value>` or `Started<Value>`.
// It suspends, so `scope.completing` decides where it may stand. The operand is
// typed first, so Hover works on a misplaced `complete`.
function enrichComplete(
	node: parser.CompleteNode,
	scope: enricher.Scope,
): common.typed.CompleteNode {
	let expression = enrichExpression(node.expression, scope)
	let type = expression.type
	let answered = unwrapWork(type, (member) =>
		member.type === "Future" || member.type === "Started"
			? member.valueType
			: null,
	)
	let notWork = answered === null && !isReportedValue(type)
	// A misplaced `complete` before no work is one mistake, reported once.
	let misplaced = reportMisplacedComplete(node, scope, notWork)

	if (answered !== null) {
		return {
			nodeType: "Complete",
			expression,
			position: node.position,
			type: answered,
		}
	}

	if (notWork && !misplaced) {
		reportWarning("This is not work to wait for", node.position, {
			code: "needless-complete",
			labels: [
				primary(
					node.expression.position,
					`this is ${withArticle(describeType(type))}`,
				),
			],
			tags: ["unnecessary"],
			notes: [notWorkNote],
			helps: ["Drop the 'complete'."],
		})
	}

	return {
		nodeType: "Complete",
		expression,
		position: node.position,
		type,
	}
}

const notWorkNote =
	"'complete' waits for what a Future or a Started answers with — a value that is neither is already the answer."

// Decides `complete-outside-future`, and answers whether it reported. The Parser
// marks every body that writes `complete` as completing. What is left to be
// wrong is a declared return Type that is no Future. Before an operand that is
// no work, the word itself is the mistake, so the Help drops it.
function reportMisplacedComplete(
	node: parser.CompleteNode,
	scope: enricher.Scope,
	notWork: boolean,
): boolean {
	let context = completionContextOf(scope)

	// The top level and a Future body can wait. An Error is a return annotation
	// already reported.
	if (
		context === "top-level" ||
		context?.type === "Future" ||
		context?.type === "Error"
	) {
		return false
	}

	// A named Function that declared another Type lacks a `Future`. A position
	// that can not suspend, such as a default or a test's name, can only move
	// the word.
	let declared = context === null || context === undefined ? null : context
	let barred = barredCompletion(completionBarrierIn(scope))

	reportError("'complete' waits, and nothing here can wait", node.position, {
		code: "complete-outside-future",
		labels: [
			primary(
				node.position,
				declared === null
					? "this suspends, and this position can not"
					: `this Function returns ${describeType(declared)}`,
			),
		],
		notes: notWork
			? [notWorkNote]
			: declared === null
				? [barred.note]
				: [
						"A body that writes 'complete' suspends, so it hands back a Future the caller completes in its turn — which is what its declared Type has to say.",
					],
		helps: notWork
			? ["Drop the 'complete'."]
			: declared === null
				? barred.helps
				: [
						`Declare the return Type 'Future<${describeType(declared)}>'.`,
					],
		...(notWork ? { data: { kind: "not-work" as const } } : {}),
	})

	return true
}

// The walks live beside `modulePathOf` in `scope.ts`, so the resolver answers
// the same questions the same way.
const completionContextOf = completionContextIn
const findExpectedReturnType = expectedReturnTypeIn

function enrichMatch(
	node: parser.MatchNode,
	scope: enricher.Scope,
): common.typed.MatchNode {
	let value = enrichExpression(node.value, scope)
	let returnType = resolveType(node.returnType, scope)
	let handledMatchers: Array<common.Type> = []
	// The values earlier Handlers named, as the questions they asked: after
	// `case 0`, every Handler is reached by a value that is not `0`. See
	// `refinedSelfType`.
	let namedValues: Array<common.PredicateConjunct> = []
	let oneShape = isOneShapeMatch(node, value.type)
	let held = { reported: false }

	return {
		nodeType: "Match",
		value,
		handlers: node.handlers.map((handler) => {
			// A bare Case after a Handler's `<-` resolves against the Match's
			// return Type. `isMatchHandlerBody` tells a Handler's `@` from a
			// Method's for `namespaceReach`.
			let bodyScope = childScope(scope, {
				expectedReturnType: returnType,
				isMatchHandlerBody: true,
			})

			let { matcher, literal, memberLiterals, memberTypes, payload } =
				resolveMatcher(
					handler.matcher,
					value.type,
					handledMatchers,
					scope,
					held,
					oneShape,
				)

			// Only an unconditional Handler retires a Type for a later
			// wildcard. See "Match Handlers and Guards" in DEVELOPMENT.md.
			if (
				literal === null &&
				memberLiterals === null &&
				memberTypes === null &&
				handler.guard === null
			) {
				handledMatchers.push(matcher)
			}

			// Read from the values earlier Handlers named, so this Handler's
			// own joins the list afterwards.
			declareVariableInScope(
				"@",
				refinedSelfType(matcher, namedValues, literal, scope),
				bodyScope,
				true,
			)

			// What this Handler leaves to later ones: nothing where a Guard
			// could decline the value it named.
			let namedValue =
				literal === null || handler.guard !== null
					? null
					: namedValueConjunct(literal)

			if (namedValue !== null) {
				namedValues.push(namedValue)
			}

			// Resolved before the Guard so it can name them, and reported once
			// here.
			let bindings = resolveMatcherBindings(
				handler.matcher,
				matcher,
				payload,
			)

			// A Guard runs before the body, so what it proves holds throughout.
			// It is read in the Scope it was enriched in.
			let guard: common.typed.ExpressionNode | null = null
			let guardNarrowings: Array<Narrowing> = []

			if (handler.guard !== null) {
				// The Guard is enriched in the body Scope so it can use `@`. A
				// Matcher's bindings are lent to it through an alias Scope; see
				// `selfMemberAliases`.
				let guardScope =
					bindings.length === 0
						? bodyScope
						: scopeLendingBindings(bindings, matcher, bodyScope)

				guard = enrichExpression(handler.guard, guardScope)

				// Only that Scope knows the names the Handler bound.
				guardNarrowings = narrowingsFor(
					conditionEvidence(guard, guardScope),
					guardScope,
				)
			}

			// A Guard's proofs about a binding are declared with the binding,
			// and its other proofs are shadowed. See "Match Handlers and
			// Guards" in DEVELOPMENT.md.
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
			// The Handler's statements are a block inside the Scope the Guard is
			// read in, as an `if` body is, since the emitted Guard runs first.
			let handlerScope = childScope(
				shadowedNarrowings.length === 0
					? bodyScope
					: scopeShadowing(shadowedNarrowings, bodyScope),
			)

			// Bindings desugar into Constants at the head of the body. `@`
			// still means the narrowed value, so an arm can bind parts and pass
			// the whole value on.
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

// An arm narrows by the complements of the earlier conditions and by its own.
// The answer Type comes from the arrow, the position or the arms. See "define
// arms" in DEVELOPMENT.md.
function enrichDefine(
	node: parser.DefineNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): common.typed.DefineNode {
	let declaredType =
		node.returnType === null ? null : resolveType(node.returnType, scope)
	// The Type every arm is read against, which is not necessarily what the
	// `define` answers. `settledAnswerType` settles that off the arms.
	let answerType = declaredType ?? expectedType
	// The Scope the next arm is read in, with every complement earlier arms
	// left.
	let armScope = scope
	let arms: Array<common.typed.DefineArm> = []
	// The first arm that could not decide a Type. Reported after the arm's own
	// Diagnostic, since it is about the `define`.
	let undecided: common.typed.ExpressionNode | null = null

	let enrichAnswer = (
		value: parser.ExpressionNode,
		valueScope: enricher.Scope,
	): common.typed.ExpressionNode => {
		if (answerType !== null) {
			return enrichExpression(value, valueScope, answerType)
		}

		// Watched through the Diagnostics, since an undeclared Case is an Error
		// too and needs a different fix. The Diagnostics are passed on in
		// order.
		let answer = collectDiagnostics(() =>
			enrichExpression(value, valueScope),
		)

		for (let diagnostic of answer.diagnostics) {
			report(diagnostic)
		}

		if (
			undecided === null &&
			answer.diagnostics.some(
				(diagnostic) => diagnostic.code === "undecided-type-arguments",
			)
		) {
			undecided = answer.result
		}

		return answer.result
	}

	for (let arm of node.arms) {
		// The condition is typed before the value, because narrowing reads the
		// typed condition. Its Diagnostics follow the value's, in written
		// order.
		let asked = collectDiagnostics(() =>
			enrichExpression(arm.condition, armScope),
		)
		let condition = asked.result
		let narrowings = trueBranchNarrowings(condition, armScope)
		let value = enrichAnswer(
			arm.value,
			scopeShadowing(narrowings, armScope),
		)

		for (let diagnostic of asked.diagnostics) {
			report(diagnostic)
		}

		// What this arm's condition leaves later arms: the next arm's Scope,
		// and whether it established anything.
		let complements = falseBranchNarrowings(condition, armScope)

		arms.push({
			value,
			condition,
			narrows: narrowings.length > 0,
			narrowsBelow: complements.length > 0,
			position: arm.position,
		})

		armScope = scopeShadowing(complements, armScope)
	}

	// The `otherwise` arm holds every complement and no evidence of its own.
	let otherwise = {
		value: enrichAnswer(node.otherwise.value, armScope),
		position: node.otherwise.position,
	}

	// Every value the `define` answers with, the `otherwise` arm's included.
	let answers = [...arms.map((arm) => arm.value), otherwise.value]

	// The arrow is a claim and is taken. The position is an offer, read by
	// `settledAnswerType`. Otherwise the arms' Union decides. `unionOfTypes`
	// answers null only for an empty list, which a `define` with its
	// `otherwise` never is.
	let type =
		declaredType ??
		(expectedType === null
			? null
			: settledAnswerType(expectedType, answers)) ??
		unionOfTypes(answers.map((answer) => answer.type)) ??
		otherwise.value.type

	if (undecided !== null) {
		reportUndecidedAnswerType(node, undecided)
	}

	return {
		nodeType: "Define",
		arms,
		otherwise,
		position: node.position,
		type,
		...(declaredType === null ? {} : { declared: true as const }),
	}
}

// What a `define` answers where the position offered a Type: the offers its
// arms took. See "define arms" in DEVELOPMENT.md.
function settledAnswerType(
	expectedType: common.Type,
	answers: Array<common.typed.ExpressionNode>,
): common.Type {
	let offered =
		expectedType.type === "UnionType" &&
		expectedType.name === undefined &&
		expectedType.alias === undefined
			? expectedType.types
			: [expectedType]

	if (offered.length < 2) {
		return expectedType
	}

	let taken = offered.filter((offer) =>
		answers.some((answer) => fitsWritten(offer, answer)),
	)

	if (
		taken.length === offered.length ||
		!answers.every((answer) =>
			taken.some((offer) => fitsWritten(offer, answer)),
		)
	) {
		return expectedType
	}

	return buildUnion(taken)
}

// An arm decided no Type, as a bare Case does, and the `define` had none to
// hand it. The arrow always works, so it leads the Helps. An Argument position
// hands nothing down, since a call picks its Overload by the Arguments.
function reportUndecidedAnswerType(
	node: parser.DefineNode,
	undecided: common.typed.ExpressionNode,
): void {
	reportError("Nothing decides what this 'define' answers", node.position, {
		code: "define-without-answer-type",
		labels: [
			primary(node.position, "this 'define' has no answer Type"),
			secondary(
				undecided.position,
				"this arm has none of its own to lend it",
			),
		],
		notes: [
			"A 'define' takes its answer Type from its arrow, from the position it stands in, or from what its arms answer with — and an arm that decides no Type Arguments of its own leaves nothing to take.",
		],
		helps: [
			"Write the answer Type on the 'define' itself: 'define -> Type { … }' — it is pushed into every arm.",
			"Or annotate the Declaration it stands in, where it stands in one. An Argument position hands nothing down: a call picks its Overload BY the Arguments, so no Parameter Type is decided before they are read.",
		],
	})
}

// #endregion

// #region Assertions

// The two Statements have identical fields, but a `nodeType` typed as their
// Union fits neither, so TypeScript needs the branch.
function assertionNode(
	nodeType: "ExpectStatement" | "RequireStatement",
	value: common.typed.ExpressionNode,
	matcher: common.typed.AssertionMatcherNode | null,
	snapshot: common.typed.SnapshotNode | null,
	position: common.Position,
): common.typed.ImplementationNode {
	return nodeType === "ExpectStatement"
		? { nodeType, value, matcher, snapshot, position }
		: { nodeType, value, matcher, snapshot, position }
}

// The one Parameter a table test should have, spelled from the rows the reader
// wrote. The first row's Type, with refinements erased, is the row Type. A
// Record row also shows the Pattern that takes it apart.
function oneRowParameterHelp(rows: Array<common.typed.ExpressionNode>): string {
	let first = rows[0]
	let rowType =
		first === undefined || typeContainsError(first.type)
			? null
			: eraseRefinements(first.type)

	if (rowType === null) {
		return "Write one Parameter: '(row: <Type>)', filling '<Type>' in with the Type one row has — or take the row apart where it is bound, '({ … }: <Type>)', where a row is a Record."
	}

	let spelled = describeType(rowType)

	if (rowType.type !== "Record") {
		return `Write one Parameter: '(row: ${spelled})'.`
	}

	return `Write one Parameter: '(row: ${spelled})', or take the row apart where it is bound: '({ ${Object.keys(
		rowType.members,
	).join(", ")} }: ${spelled})'.`
}

// The Parameter list as the reader wrote it, for the Help that asks for the
// rows. A schematic `<Type>` where the Parameter has no written Type.
function rowParameterSpelling(
	node: parser.TestTableNode,
	declaredType: common.Type | null,
): string {
	let parameter = node.parameters[0]
	let name =
		parameter?.internalName?.nodeType === "Identifier"
			? parameter.internalName.content
			: "row"

	return declaredType === null || typeContainsError(declaredType)
		? `(${name}: <Type>)`
		: `(${name}: ${describeType(declaredType)})`
}

// `across [ … ] (row: Row)`: the rows a table test runs for and the name the
// body reads a row under. The rows must be written, since each is a test
// numbered at compile time. A Pattern Parameter's Constants stand on the table,
// since the test's name reads them too.
export function enrichTestTable(
	node: parser.TestTableNode,
	scope: enricher.Scope,
	bodyScope: enricher.Scope,
	// Whether the test is skipped. An empty table is reported unless `skipped
	// "…"` already says why.
	skipped: boolean = false,
	// Whether the test's name reads a row, so the row mismatch Help can say a
	// widened row Type must stay Printable.
	nameReadsTheRow: boolean = false,
): common.typed.TestTableNode {
	let parameter = node.parameters[0]

	// Null where the Parameter list is refused, which silences the row check. A
	// table naming two Parameters has no row Type.
	let declaredType =
		node.parameters.length !== 1 ||
		parameter?.type === undefined ||
		parameter.type === null
			? null
			: resolveType(parameter.type, scope)
	let rows = enrichTableRows(
		node.value,
		declaredType,
		scope,
		skipped,
		nameReadsTheRow,
		rowParameterSpelling(node, declaredType),
	)

	// Reported after the rows are read, because the Help spells the row's Type
	// from them.
	if (node.parameters.length !== 1) {
		reportError(
			node.parameters.length === 0
				? "A table test has to name its row"
				: "A table test takes one row at a time",
			node.parameterListPosition,
			{
				code: "table-parameters",
				labels: [
					primary(
						node.parameterListPosition,
						node.parameters.length === 0
							? "no Parameter to bind a row to"
							: `${node.parameters.length} Parameters for one row`,
					),
					secondary(node.keywordPosition, "the rows are here"),
				],
				notes: [
					"Each item of the List is one row, and one row is one value — a test that wanted several values per row would say so by writing a Record.",
				],
				helps: [oneRowParameterHelp(rows)],
			},
		)
	}
	// Error for the bindings where the list was refused, as for any dropped
	// Declaration, so the body's calls do not report again.
	let type =
		node.parameters.length !== 1
			? ({ type: "Error" } as const)
			: (declaredType ?? listItemTypeOf(rows.map((row) => row.type)))
	let pattern =
		parameter?.internalName?.nodeType === "Pattern"
			? parameter.internalName
			: null
	let binding =
		parameter?.internalName?.nodeType === "Identifier"
			? parameter.internalName.content
			: synthesizedName("row", node.parameterListPosition)

	declareVariableInScope(
		{
			nodeType: "Identifier",
			content: binding,
			position: parameter?.position ?? node.parameterListPosition,
		},
		type,
		bodyScope,
		true,
	)

	// The extra Parameters of a refused list are declared too, binding the row,
	// so no unknown names cascade under the one report.
	for (let extra of node.parameters.slice(1)) {
		if (extra.internalName?.nodeType === "Identifier") {
			declareVariableInScope(extra.internalName, type, bodyScope, true)
		}
	}

	return {
		nodeType: "TestTable",
		rows,
		binding,
		type,
		bindings:
			pattern === null
				? []
				: declarePatternBindings(
						pattern,
						binding,
						type,
						bodyScope,
						true,
					),
		position: node.position,
	}
}

// The items of the written List, each read against the declared Type. A value
// that is no written List is reported and has no rows, and the body is still
// enriched.
function enrichTableRows(
	node: parser.ExpressionNode,
	declaredType: common.Type | null,
	scope: enricher.Scope,
	skipped: boolean,
	nameReadsTheRow: boolean,
	// The Parameter list written after the rows; see `rowParameterSpelling`.
	parameterSpelling: string = "(row: <Type>)",
): Array<common.typed.ExpressionNode> {
	if (node.nodeType === "ListValue") {
		// No rows is no tests, and nothing in a report would show it. A skipped
		// test is left alone, since its reason is what the report shows.
		if (node.values.length === 0 && !skipped) {
			reportError(
				"A table test with no rows in it runs no test",
				node.position,
				{
					code: "table-without-rows",
					labels: [primary(node.position, "no rows to run")],
					notes: [
						"Every row is a test of its own, so a table test with none is nothing at all: it is reported by no line and counted in no total, and nothing would say it had stopped running.",
					],
					helps: [
						"Write the rows the test is for, or say why there are none with 'skipped \"…\"'.",
					],
				},
			)
		}

		return node.values.map((value) => {
			let row = enrichExpression(value, scope, declaredType)

			// The one place a row is checked. The declared Type only hints to
			// `enrichExpression`, which refuses nothing. `fitsWritten` reads a
			// written row's evidence, so `across [1, 2] (n: NonZeroInteger)`
			// decides each predicate. A written row names only declared members.
			if (
				declaredType !== null &&
				!typeContainsError(declaredType) &&
				!typeContainsError(row.type) &&
				(!fitsWritten(declaredType, row) ||
					undeclaredMembers(declaredType, row).length > 0)
			) {
				reportRowTypeMismatch(row, declaredType, nameReadsTheRow)
			}

			return row
		})
	}

	reportError(
		"The rows of a table test have to be written here",
		node.position,
		{
			code: "table-not-written",
			labels: [primary(node.position, "this is not a written List")],
			notes: [
				"Every row is a test of its own — it carries its row number in the identity a stored snapshot and the Editor's own results are keyed by — so the rows have to be countable before anything runs.",
			],
			helps: [
				`Write the rows as a List: 'across [ … ] ${parameterSpelling}'. A row itself can be any Expression.`,
			],
		},
	)

	return []
}

// `for any (a: Integer, b: NonEmptyList<String>)`: the Parameters a property
// test generates per case. Each writes a Type, which says what to generate, and
// a name, which a shrunk counterexample is reported beside.
export function enrichTestProperties(
	node: parser.TestPropertiesNode,
	scope: enricher.Scope,
	bodyScope: enricher.Scope,
): common.typed.TestPropertiesNode {
	if (node.parameters.length === 0) {
		reportPropertyParameters(
			node.parameterListPosition,
			"A property test has to name what it generates",
			"no Parameter to generate a value for",
			"Write a Parameter and its Type: 'for any (n: Integer)'.",
		)
	}

	// The names the Parameters write, which a refused Pattern leaves to them.
	let named = new Set(
		node.parameters.flatMap((parameter) =>
			parameter.internalName?.nodeType === "Identifier"
				? [parameter.internalName.content]
				: [],
		),
	)

	return {
		nodeType: "TestProperties",
		parameters: node.parameters.map((parameter) =>
			enrichTestProperty(parameter, scope, bodyScope, named),
		),
		position: node.position,
	}
}

function enrichTestProperty(
	parameter: parser.ParameterNode,
	scope: enricher.Scope,
	bodyScope: enricher.Scope,
	named: ReadonlySet<string>,
): common.typed.TestPropertyNode {
	let name =
		parameter.internalName?.nodeType === "Identifier"
			? parameter.internalName.content
			: synthesizedName("any", parameter.position)
	// A Parameter without a Type is still bound, to an Error, so the body does
	// not cascade unknown names. A table binds an unreadable Parameter
	// likewise.
	let type: common.Type =
		parameter.type === null
			? { type: "Error" }
			: resolveType(parameter.type, scope)

	if (parameter.internalName?.nodeType === "Pattern") {
		reportPropertyParameters(
			parameter.position,
			"A generated Parameter has to be a name",
			"this takes a value apart",
			`Name the whole value — 'for any (value: ${type.type === "Error" ? "…" : spellType(type, spellingIn(scope))})' — and take it apart inside the body.`,
			"A counterexample is reported beside the name it was generated for, and a Pattern names no value.",
		)

		// Its names are still bound at their members' Types, so the body does
		// not report them again but is still checked. An annotated last step
		// narrows as in a Matcher, and an annotation earlier on binds Error.
		for (let bound of patternBindings(parameter.internalName)) {
			let annotated = bound.steps.findIndex((step) => step.type !== null)
			let boundType: common.Type =
				annotated === -1
					? typeAtPath(type, bound.path)
					: annotated === bound.steps.length - 1 &&
						  bound.type !== null
						? resolveType(bound.type, scope)
						: { type: "Error" }

			if (!named.has(bound.name.content)) {
				declareVariableInScope(bound.name, boundType, bodyScope, true)
			}
		}
	}

	// `_` binds no name, so a counterexample has nothing to stand beside.
	if (parameter.internalName === null) {
		reportPropertyParameters(
			parameter.position,
			"A generated Parameter has to be a name",
			"this binds no name",
			`Name the value — 'for any (value: ${type.type === "Error" ? "…" : spellType(type, spellingIn(scope))})'.`,
			"A counterexample is reported beside the name it was generated for, and '_' names no value.",
		)
	}

	// `a: Integer` records one Identifier as both names, so a label is two
	// different words. `on _` is a label too.
	if (
		parameter.externalName !== null &&
		(parameter.internalName === null ||
			(parameter.internalName.nodeType === "Identifier" &&
				parameter.externalName.content !==
					parameter.internalName.content))
	) {
		reportPropertyParameters(
			parameter.externalName.position,
			"A generated Parameter takes no label",
			"nothing calls this test",
			`Write the name alone: 'for any (${parameter.internalName === null ? "value" : name}: …)'.`,
			"A label is what a caller writes at a call site, and nothing calls a test.",
		)
	}

	if (parameter.defaultValue !== null) {
		reportPropertyParameters(
			parameter.defaultValue.position,
			"A generated Parameter takes no default",
			"this value is never used",
			"Remove the default — every case generates a value of the Type.",
		)
	}

	declareVariableInScope(
		binding(name, parameter.position),
		type,
		bodyScope,
		true,
	)

	if (parameter.type === null) {
		// `for any (Integer)` is read with `Integer` as the name. Whether that
		// name resolves to a Type says which half is missing.
		let wroteAType = findTypeInScope(name, scope) !== null

		reportPropertyParameters(
			parameter.position,
			"A generated Parameter has to write its Type",
			"nothing here says what to generate",
			wroteAType
				? `Write a name for it: 'for any (value: ${name})'.`
				: `Write the Type: 'for any (${name}: …)'.`,
			"The Type is the whole of what a generator is derived from.",
		)

		return {
			nodeType: "TestProperty",
			name,
			type,
			generator: { kind: "boolean" },
			position: parameter.position,
		}
	}

	return {
		nodeType: "TestProperty",
		name,
		type,
		// The placeholder stands where a Diagnostic was reported, so it is
		// never emitted. A Boolean keeps the Parameter in place for the body.
		generator: deriveGenerator(
			type,
			scope,
			parameter.position,
			[],
			conformableTypeName(parameter.type, type),
		) ?? {
			kind: "boolean",
		},
		position: parameter.position,
	}
}

// The name a `Generatable` conformance could be declared under, or null. A
// Namespace targets a named Type, and only a Record or a Choice has a shape a
// generator can be written against.
function conformableTypeName(
	written: parser.TypeDeclarationNode,
	type: common.Type,
): string | null {
	if (written.nodeType !== "IdentifierTypeDeclaration") {
		return null
	}

	let cases = type.type === "UnionType" ? flattenUnionMembers(type) : [type]
	let isChoice = cases.length > 0 && cases.every((one) => one.type === "Case")

	return type.type === "Record" || isChoice ? written.type.content : null
}

// An Identifier Node rather than a string, so a duplicate declaration, rename
// and go-to-definition have a position.
function binding(
	name: string,
	position: common.Position,
): parser.IdentifierNode {
	return { nodeType: "Identifier", content: name, position }
}

// What to draw a value of one Type from. A Namespace's own `Generatable`
// conformance comes first, for invariants no structure states. `enclosing`
// holds the Choices being derived, refusing a Choice that contains itself.
export function deriveGenerator(
	type: common.Type,
	scope: enricher.Scope,
	position: common.Position,
	enclosing: Array<string>,
	// The Parameter's own Type as written, which a `Generatable` conformance
	// would be declared for, rather than a nested member the walk refused.
	declared: string | null = null,
): common.typed.TestGenerator | null {
	let conformance = generatableConformance(type, scope, position)

	if (conformance !== null) {
		return conformance
	}

	switch (type.type) {
		case "Boolean":
			return { kind: "boolean" }
		case "Integer":
			return { kind: "integer" }
		case "Rational":
			return { kind: "rational" }
		case "String":
			return { kind: "string" }
		case "List": {
			let item = deriveGenerator(
				type.itemType,
				scope,
				position,
				enclosing,
				declared,
			)

			return item === null ? null : { kind: "list", item }
		}
		// A List with no Type Argument holds what a Type Parameter admits.
		case "GenericList":
			return { kind: "list", item: anyValueGenerator() }
		case "Dictionary": {
			let key = deriveGenerator(
				type.keyType,
				scope,
				position,
				enclosing,
				declared,
			)

			if (key === null) {
				return null
			}

			let value = deriveGenerator(
				type.valueType,
				scope,
				position,
				enclosing,
				declared,
			)

			// Both slots or nothing; the half that answered null already
			// reported.
			if (value === null) {
				return null
			}

			// The key Type's own Equatable, so a drawn Dictionary holds the
			// keys the Program calls distinct. A witness from a Type Parameter
			// is not carried, since no binding of it exists in the tests
			// section.
			let keyConformance = equatableKeyConformance(
				type.keyType,
				scope,
				position,
			)

			return {
				kind: "dictionary",
				key,
				value,
				...(keyConformance === null ||
				keyConformance.source.kind === "parameter"
					? {}
					: { keyConformance }),
			}
		}
		// Both slots of a Dictionary with no Type Arguments hold what a Type
		// Parameter admits.
		case "GenericDictionary":
			return {
				kind: "dictionary",
				key: anyValueGenerator(),
				value: anyValueGenerator(),
			}
		// A Type Parameter draws an Integer, a String and a small Record, which
		// exercise a scalar, a sequence and a structure.
		case "GenericUse":
			return anyValueGenerator()
		case "Record": {
			let members = deriveMembers(
				type.members,
				scope,
				position,
				enclosing,
				declared,
			)

			return members === null ? null : { kind: "record", members }
		}
		case "Case": {
			if (enclosing.includes(type.choice)) {
				return refuseUngeneratableType(
					type,
					position,
					`'${displayChoiceName(type.choice)}' names itself in a payload`,
					declared,
					"A generator is finite, and a Type that contains itself has no smallest value to build.",
				)
			}

			let members = deriveMembers(
				type.members,
				scope,
				position,
				[...enclosing, type.choice],
				declared,
			)

			return members === null
				? null
				: { kind: "case", tag: `${type.choice}#${type.name}`, members }
		}
		case "UnionType": {
			let members: Array<common.typed.TestGenerator> = []

			for (let member of flattenUnionMembers(type)) {
				let generator = deriveGenerator(
					member,
					scope,
					position,
					enclosing,
					declared,
				)

				if (generator === null) {
					return null
				}

				members.push(generator)
			}

			return members.length === 0 ? null : { kind: "union", members }
		}
		case "Refinement":
			return refinedGenerator(type, scope, position, enclosing, declared)
		// An Error Type has already been reported.
		case "Error":
			return null
		default:
			return refuseUngeneratableType(
				type,
				position,
				`nothing knows how to build ${withArticle(printType(type))}`,
				declared,
			)
	}
}

// What a Type Parameter admits: an Integer, a String, and a Record small enough
// to read in a counterexample.
function anyValueGenerator(): common.typed.TestGenerator {
	return {
		kind: "union",
		members: [
			{ kind: "integer" },
			{ kind: "string" },
			{
				kind: "record",
				members: [
					{ name: "name", generator: { kind: "string" } },
					{ name: "count", generator: { kind: "integer" } },
				],
			},
		],
	}
}

function deriveMembers(
	members: Record<string, common.Type>,
	scope: enricher.Scope,
	position: common.Position,
	enclosing: Array<string>,
	declared: string | null,
): Array<common.typed.TestGeneratorMember> | null {
	let derived: Array<common.typed.TestGeneratorMember> = []

	for (let [name, memberType] of Object.entries(members)) {
		let generator = deriveGenerator(
			memberType,
			scope,
			position,
			enclosing,
			declared,
		)

		if (generator === null) {
			return null
		}

		derived.push({ name, generator })
	}

	return derived
}

// A checked refinement. A recognised conjunct narrows the generator, any other
// is enriched as a filter check, and a conjunct that is neither is refused.
function refinedGenerator(
	type: common.RefinementType,
	scope: enricher.Scope,
	position: common.Position,
	enclosing: Array<string>,
	declared: string | null,
): common.typed.TestGenerator | null {
	let base = deriveGenerator(type.base, scope, position, enclosing, declared)

	if (base === null) {
		return null
	}

	let binding = synthesizedName("candidate", position)
	let narrowing: common.typed.TestNarrowing = {}
	let checks: Array<common.typed.ExpressionNode> = []

	for (let conjunct of type.conjuncts ?? []) {
		if (narrowedBy(conjunct, type.base, narrowing)) {
			continue
		}

		let check = predicateCheck(conjunct, type, binding, scope, position)

		if (check === null) {
			// A refinement names itself as what to declare a conformance for,
			// since a conformance on the base would draw values the predicate
			// refuses.
			return refuseUngeneratableType(
				type,
				position,
				`nothing knows how to hold '@::${conjunct.methodName}(…)'`,
				null,
				`'${type.name}' is a checked refinement, and a generated value has to satisfy its predicate.`,
				`Declare a 'Generatable' conformance for '${type.name}': 'namespace ${type.name} for ${type.name} is Generatable { … }'.`,
			)
		}

		checks.push(check)
	}

	return {
		kind: "refined",
		name: type.name,
		base,
		binding,
		checks,
		narrowing,
	}
}

// The predicates a generator holds by construction. A conjunct arrives
// resolved, so `isZero` is `is(0)` and `hasItems` is `isEmpty` negated, and
// each primitive row reads both polarities. Rational bounds are not built in
// and are filtered. Answering `true` means the narrowing holds the conjunct
// entirely.
function narrowedBy(
	conjunct: common.PredicateConjunct,
	base: common.Type,
	narrowing: common.typed.TestNarrowing,
): boolean {
	let digits = conjunct.args[0]
	let whole =
		typeof digits === "string" && /^-?\d+$/.test(digits) ? digits : null

	// The Namespace must be the base's own, since a Program's own `isPositive`
	// on Integer may mean something else.
	if (conjunct.namespaceName !== base.type) {
		return false
	}

	if (base.type === "Integer" && conjunct.args.length === 1) {
		if (whole === null) {
			return false
		}

		switch (conjunct.methodName) {
			case "is":
				if (!conjunct.negated) {
					return atLeast(narrowing, whole) && atMost(narrowing, whole)
				}

				narrowing.notEqualTo = [...(narrowing.notEqualTo ?? []), whole]

				return true
			case "isGreaterThan":
				return conjunct.negated
					? atMost(narrowing, whole)
					: atLeast(narrowing, step(whole, 1n))
			case "isLessThan":
				return conjunct.negated
					? atLeast(narrowing, whole)
					: atMost(narrowing, step(whole, -1n))
			default:
				return false
		}
	}

	// A Dictionary's length counts entries, so `NonEmptyDictionary` draws a
	// Dictionary that holds something.
	if (
		(base.type === "List" ||
			base.type === "String" ||
			base.type === "Dictionary") &&
		conjunct.args.length === 0 &&
		conjunct.methodName === "isEmpty"
	) {
		if (conjunct.negated) {
			narrowing.minimumLength = Math.max(narrowing.minimumLength ?? 0, 1)
		} else {
			narrowing.maximumLength = 0
		}

		return true
	}

	return false
}

function atLeast(
	narrowing: common.typed.TestNarrowing,
	bound: string,
): boolean {
	narrowing.atLeast =
		narrowing.atLeast === undefined ||
		BigInt(narrowing.atLeast) < BigInt(bound)
			? bound
			: narrowing.atLeast

	return true
}

function atMost(narrowing: common.typed.TestNarrowing, bound: string): boolean {
	narrowing.atMost =
		narrowing.atMost === undefined ||
		BigInt(narrowing.atMost) > BigInt(bound)
			? bound
			: narrowing.atMost

	return true
}

function step(digits: string, by: bigint): string {
	return (BigInt(digits) + by).toString()
}

// A conjunct as the Boolean Expression an author could write, such as
// `<candidate>::isEven()`. It is enriched where the test stands, so it resolves
// and is emitted in the test's Module. Its Diagnostics are dropped, and the
// Type is refused once instead.
export function predicateCheck(
	conjunct: common.PredicateConjunct,
	refinement: common.RefinementType,
	binding: string,
	scope: enricher.Scope,
	position: common.Position,
): common.typed.ExpressionNode | null {
	// Typed as the refinement's base, since the check asks whether a drawn
	// value has earned the refinement.
	let checkScope = childScope(scope, {
		members: { [binding]: refinement.base },
		declarations: { [binding]: position },
		constants: new Set([binding]),
	})

	// A conjunct names no Overload, so every entry of the Method is tried in
	// order. The one that rebuilds into a call this Scope accepts is the one
	// meant.
	for (let signature of predicateSignatures(conjunct, scope)) {
		let call = predicateCall(
			conjunct,
			signature,
			refinement.base,
			binding,
			position,
		)

		if (call === null) {
			continue
		}

		let attempt = collectDiagnostics(() =>
			enrichExpression(call, checkScope),
		)

		if (
			!containsErrors(attempt.diagnostics) &&
			attempt.result.type.type === "Boolean"
		) {
			return attempt.result
		}
	}

	return null
}

// One conjunct rebuilt against one signature, or null where its scalars do not
// fit the signature's Types.
function predicateCall(
	conjunct: common.PredicateConjunct,
	signature: common.BaseFunction,
	base: common.Type,
	binding: string,
	position: common.Position,
): parser.MethodInvocationNode | null {
	// The Parameters the Arguments stand for. A signature with one more
	// Parameter than the conjunct has Arguments carries the receiver first.
	let parameters =
		signature.parameterTypes.length === conjunct.args.length + 1
			? signature.parameterTypes.slice(1)
			: signature.parameterTypes

	if (parameters.length !== conjunct.args.length) {
		return null
	}

	let values: Array<parser.ExpressionNode> = []

	for (let [index, parameter] of parameters.entries()) {
		let value = predicateArgument(
			conjunct.args[index]!,
			parameter.type,
			base,
			position,
		)

		if (value === null) {
			return null
		}

		values.push(value)
	}

	let call: parser.MethodInvocationNode = {
		nodeType: "MethodInvocation",
		base: { nodeType: "Identifier", content: binding, position },
		member: {
			nodeType: "Identifier",
			content: conjunct.methodName,
			position,
		},
		// The Namespace the predicate resolved to, written out, since two
		// Namespaces may answer one Method name for one Type.
		namespaceSpecifier: {
			nodeType: "Identifier",
			content: conjunct.namespaceName,
			position,
		},
		arguments: invocationArguments(parameters, values, position),
		position,
	}

	// A negated leaf is built as `@::isEmpty()::negate()`, the spelling that
	// holds for every leaf.
	return conjunct.negated
		? {
				nodeType: "MethodInvocation",
				base: call,
				member: {
					nodeType: "Identifier",
					content: "negate",
					position,
				},
				namespaceSpecifier: null,
				arguments: [],
				position,
			}
		: call
}

// The Arguments of a call the compiler builds: one per Parameter, in order,
// labelled with the Parameter's external name where it has one. Shared by
// refinement checks and contract goals, so both spell calls alike.
export function invocationArguments(
	parameters: Array<common.Parameter>,
	values: Array<parser.ExpressionNode>,
	position: common.Position,
): Array<parser.ArgumentNode> {
	return parameters.map((parameter, index) => ({
		nodeType: "Argument",
		name:
			parameter.name === null
				? null
				: {
						nodeType: "Identifier",
						content: parameter.name,
						position,
					},
		value: values[index]!,
	}))
}

// The signatures the conjunct's Method could have resolved to: the Namespace's
// own, or the Protocol's where a conformance provides it. They give each
// Argument's label and Type. Every Overload entry comes back, in order.
function predicateSignatures(
	conjunct: common.PredicateConjunct,
	scope: enricher.Scope,
): Array<common.BaseFunction> {
	// The lookup reports a name that is no Namespace here, which suits a
	// written `::<Name>method()`. Nobody wrote this one, so its Diagnostics are
	// dropped.
	let found = collectDiagnostics(() =>
		getAllNamespacesInScope(scope, {
			nodeType: "Identifier",
			content: conjunct.namespaceName,
			position: {
				start: { line: 1, column: 1 },
				end: { line: 1, column: 1 },
			},
		}).get(conjunct.namespaceName),
	)
	let namespace = found.result

	if (namespace === undefined || containsErrors(found.diagnostics)) {
		return []
	}

	let method = namespace.methods[conjunct.methodName]

	if (method === undefined) {
		for (let identity of namespace.conformsTo ?? []) {
			let provided = protocolOf(identity, scope).methods[
				conjunct.methodName
			]

			if (provided !== undefined) {
				method = provided

				break
			}
		}
	}

	if (method === undefined) {
		return []
	}

	return method.type === "OverloadedMethod" ||
		method.type === "OverloadedStaticMethod"
		? method.overloads
		: [method]
}

// What a Type Parameter in a Method's signature stands for, given the
// refinement's base, or null to keep it as declared. `Self` is the base, a List
// has one slot, and a Dictionary's slot is told by name.
function refinementBaseGeneric(
	name: string,
	base: common.Type,
): common.Type | null {
	if (name === "Self") {
		return base
	}

	if (base.type === "List") {
		return base.itemType
	}

	if (base.type === "Dictionary") {
		return name === "KeyType"
			? base.keyType
			: name === "ValueType"
				? base.valueType
				: null
	}

	return null
}

// One stable scalar as the Literal it was written as. Integer digits and String
// characters share one field, so the Parameter's Type says which it is.
function predicateArgument(
	argument: string | boolean,
	declared: common.Type | common.GenericUse,
	base: common.Type,
	position: common.Position,
): parser.ExpressionNode | null {
	let type =
		declared.type === "GenericUse"
			? (refinementBaseGeneric(declared.name, base) ?? declared)
			: declared

	if (typeof argument === "boolean") {
		return type.type === "Boolean"
			? { nodeType: "BooleanValue", value: argument, position }
			: null
	}

	switch (type.type) {
		case "Integer":
			return /^-?\d+$/.test(argument)
				? { nodeType: "IntegerValue", value: argument, position }
				: null
		case "String": {
			// A String scalar arrives as the JSON of its characters, starting
			// with a quote.
			if (!argument.startsWith('"')) {
				return null
			}

			let text: unknown = JSON.parse(argument)

			return typeof text === "string"
				? { nodeType: "StringValue", value: text, position }
				: null
		}
		case "Rational": {
			let [numerator, denominator] = argument.split("/")

			return numerator === undefined || denominator === undefined
				? null
				: {
						nodeType: "RationalValue",
						numerator,
						denominator,
						position,
					}
		}
		default:
			return null
	}
}

// A Namespace conforming to `Generatable`, as the calls an author could write:
// `Team.generate(from <source>)` and `<drawn>::<Team>shrink()`. It replaces the
// structural answer. Both are enriched in the test's Scope; a Namespace that
// writes no `shrink` gets `Generatable`'s provided one.
function generatableConformance(
	type: common.Type,
	scope: enricher.Scope,
	position: common.Position,
): common.typed.TestGenerator | null {
	// Each candidate is specialized against the Type first, as
	// `solveConformance` does, since a generic target such as `Pair<Item>`
	// matches no applied Type. The raw Namespace says whether it was generic.
	let raw = namespacesTargeting(getAllNamespacesInScope(scope, null), type)
	let targeting = specializedNamespacesFor(raw, type)
	let generic: common.NamespaceType | null = null

	for (let [name, namespace] of targeting) {
		if (
			!(namespace.conformsTo ?? []).includes(GENERATABLE_PROTOCOL) ||
			!targetsExactly(namespace, type)
		) {
			continue
		}

		// A generic Namespace's conformance can not be reached from here. It is
		// refused only after the search, since a Namespace for the applied Type
		// may answer.
		let declared = raw.get(name)

		if (declared !== undefined && declared.generics.length > 0) {
			generic ??= declared

			continue
		}

		let source = synthesizedName("source", position)
		let call: parser.FunctionInvocationNode = {
			nodeType: "FunctionInvocation",
			name: {
				nodeType: "Lookup",
				base: { nodeType: "Identifier", content: name, position },
				member: {
					nodeType: "Identifier",
					content: GENERATABLE_METHOD,
					position,
				},
				position,
			},
			arguments: [
				{
					nodeType: "Argument",
					name: {
						nodeType: "Identifier",
						content: GENERATABLE_LABEL,
						position,
					},
					value: {
						nodeType: "Identifier",
						content: source,
						position,
					},
				},
			],
			position,
		}
		let sourceScope = childScope(scope, {
			members: { [source]: { type: "Randomness" } },
			declarations: { [source]: position },
			constants: new Set([source]),
		})
		let attempt = collectDiagnostics(() =>
			enrichExpression(call, sourceScope),
		)

		if (containsErrors(attempt.diagnostics)) {
			continue
		}

		let drawn = synthesizedName("drawn", position)
		// Named at the call, as a predicate's Namespace is, since a second
		// Namespace for the Type may write its own `shrink`.
		let shrinking: parser.MethodInvocationNode = {
			nodeType: "MethodInvocation",
			base: { nodeType: "Identifier", content: drawn, position },
			member: {
				nodeType: "Identifier",
				content: GENERATABLE_SHRINK,
				position,
			},
			namespaceSpecifier: {
				nodeType: "Identifier",
				content: name,
				position,
			},
			arguments: [],
			position,
		}
		let drawnScope = childScope(scope, {
			members: { [drawn]: type },
			declarations: { [drawn]: position },
			constants: new Set([drawn]),
		})
		let shrunk = collectDiagnostics(() =>
			enrichExpression(shrinking, drawnScope),
		)

		// A conformance whose `shrink` does not resolve was already refused by
		// the conformance check, so it is passed over.
		if (containsErrors(shrunk.diagnostics)) {
			continue
		}

		return {
			kind: "generated",
			name,
			binding: source,
			call: attempt.result,
			shrinkBinding: drawn,
			shrink: shrunk.result,
		}
	}

	return generic === null
		? null
		: refuseUnreachableConformance(generic, type, position)
}

// A generic Namespace's `Generatable` conformance, which nothing here can call.
// The static `generate` takes only a `Randomness`, so no Argument decides the
// Namespace's Type Parameters. It is refused rather than silently replaced.
function refuseUnreachableConformance(
	namespace: common.NamespaceType,
	type: common.Type,
	position: common.Position,
): null {
	let parameters = namespace.generics
		.map((generic) => `'${generic.name}'`)
		.join(", ")

	reportError(
		`Namespace '${namespace.name}' is generic, so its '${GENERATABLE_PROTOCOL}' conformance can not be reached`,
		position,
		{
			code: "unreachable-conformance",
			labels: [
				primary(
					position,
					`nothing here binds ${parameters} for the draw`,
				),
			],
			notes: [
				`'${GENERATABLE_METHOD}' is a static taking a 'Randomness' and nothing else, so a call has no Argument to work ${parameters} out from — and a call can not be written with a Type Argument.`,
				`Passed over, the structural generator would draw and shrink ${withArticle(printType(type))} instead, which is what this conformance was written to replace.`,
			],
			helps: [
				`Declare '${GENERATABLE_PROTOCOL}' on a Namespace whose target Type is already applied, rather than on a generic one.`,
			],
		},
	)

	return null
}

// Whether a Namespace targets this Type rather than one it flows into. A
// refinement flows into its base, so only mutual assignability keeps a
// Namespace for Integer from drawing values a refinement refuses.
function targetsExactly(
	namespace: common.NamespaceType,
	type: common.Type,
): boolean {
	let target = namespace.targetType

	return (
		target !== null &&
		matchesType(target, type) &&
		matchesType(type, target)
	)
}

const GENERATABLE_PROTOCOL = "Generatable"
const GENERATABLE_METHOD = "generate"
const GENERATABLE_LABEL = "from"
const GENERATABLE_SHRINK = "shrink"

function refuseUngeneratableType(
	type: common.Type,
	position: common.Position,
	label: string,
	// The Parameter's own Type a conformance would be declared for, or null
	// where there is none, as for a Function or a Type Parameter.
	declared: string | null,
	note = "A property test generates a value of every Parameter's Type, once per case.",
	help = "Write a Type a value can be built of, or declare a 'Generatable' conformance for this one.",
): null {
	reportError(
		`Nothing can generate ${withArticle(printType(type))}`,
		position,
		{
			code: "ungeneratable-type",
			labels: [primary(position, label)],
			notes: [note],
			...(declared === null
				? {}
				: {
						data: {
							kind: "ungeneratable" as const,
							typeName: declared,
						},
					}),
			// `Generatable` provides a `shrink` that answers no candidates, so
			// the second Help asks for one.
			helps: [
				help,
				"Write 'shrink' in the conformance as well: 'Generatable' provides one that answers no candidates, and a counterexample is otherwise reported as it was drawn.",
			],
		},
	)

	return null
}

// What a snapshot records: the value rendered through `Printable`, built as the
// interpolation `"{value}"` an author could write.
function enrichSnapshotValue(
	node: parser.ExpressionNode,
	scope: enricher.Scope,
): common.typed.ExpressionNode {
	let expression = enrichExpression(node, scope)
	let solved = solveConformance(
		expression.type,
		"Printable",
		scope,
		expression.position,
	)

	if (!solved.ok && solved.chain.length > 0) {
		reportError(
			`${describeType(expression.type)} can not be recorded as a snapshot`,
			expression.position,
			{
				code: "snapshot-not-printable",
				labels: [
					primary(
						expression.position,
						`this is ${describeType(expression.type)}, which is not Printable`,
					),
				],
				notes: [
					"A snapshot records what a value LOOKS like, which is what 'Printable::toString' answers — so a value with no such answer has nothing to record.",
					...solved.chain,
				],
				// The conformance comes first, since it works for any value a
				// `for` clause can name. A bare Case is named by its Choice, since
				// a Namespace can not target one Case.
				helps:
					unnameableTarget(expression.type) !== null
						? [
								`Snapshot a String you build yourself — no Namespace can be declared for ${unnameableTarget(expression.type)}.`,
							]
						: expression.type.type === "Case"
							? [
									`Declare a 'Printable' conformance for '${spellChoiceName(expression.type, spellingIn(scope))}' and annotate the value at it — a bare Case binds the Case, not the Choice.`,
									"Or snapshot a String you build yourself.",
								]
							: [
									`Declare a 'Printable' conformance for it — '${namespaceHead(expression.type, "namespace …", spellingIn(scope))} is Printable { … }'.`,
									"Or snapshot a String you build yourself.",
								],
			},
		)
	}

	return {
		nodeType: "InterpolatedStringValue",
		segments: [
			{ kind: "text", value: "" },
			{
				kind: "expression",
				expression,
				conformance: {
					genericName: "$snapshot",
					protocolName: "Printable",
					source: solved.ok
						? solved.source
						: { kind: "parameter", name: "$snapshot" },
				},
			},
			{ kind: "text", value: "" },
		],
		position: expression.position,
		type: { type: "String" },
	}
}

// `expect` and `require` differ only in what a failure does and in whether a
// Matcher may take the value apart. `require MATCHER = EXPR` becomes three
// Statements: the asserted value's Constant, the assertion, and its bindings.
function enrichAssertionStatement(
	node: parser.ExpectStatementNode | parser.RequireStatementNode,
	scope: enricher.Scope,
): Array<common.typed.ImplementationNode> {
	// A snapshot compares the value as it prints, so it binds nothing.
	if (node.snapshot !== null) {
		return [
			assertionNode(
				node.nodeType,
				enrichSnapshotValue(node.value, scope),
				null,
				{
					nodeType: "Snapshot",
					name:
						node.snapshot.name === null
							? null
							: node.snapshot.name.value,
					recorded:
						node.snapshot.value === null
							? null
							: node.snapshot.value.value,
					valuePosition: node.snapshot.valuePosition,
					position: node.snapshot.position,
				},
				node.position,
			),
		]
	}

	// The Boolean form reads its Expression once and binds nothing. The
	// validator refuses a value that is no Boolean with `expect-not-boolean`,
	// offering the questions noted here.
	if (node.matcher === null) {
		let value = enrichExpression(node.value, scope)

		askAssertionQuestions(value, scope)

		return [assertionNode(node.nodeType, value, null, null, node.position)]
	}

	// From here on this is `require MATCHER = EXPR`. The Parser refuses a
	// Matcher on an `expect`, which carries on past a miss and so can bind no
	// names.
	let value = enrichExpression(node.value, scope)
	let resolved = resolveMatcher(node.matcher, value.type, [], scope)
	let baseName = synthesizedName("assertion", node.value.position)

	declareVariableInScope(baseName, value.type, scope, true)

	let base: common.typed.ConstantDeclarationStatementNode = {
		nodeType: "ConstantDeclarationStatement",
		name: {
			nodeType: "Identifier",
			content: baseName,
			position: node.value.position,
			type: value.type,
		},
		value,
		position: node.value.position,
		headPosition: node.value.position,
		declaredType: null,
		type: value.type,
		documentation: null,
		synthesized: "subject",
	}

	recordConstantValue(baseName, value, scope)

	let assertion = assertionNode(
		node.nodeType,
		// The name rather than the Expression, so a Method Invocation runs once
		// however many parts the Matcher reads.
		{
			nodeType: "Identifier",
			content: baseName,
			position: node.value.position,
			type: value.type,
		},
		{
			matcher: resolved.matcher,
			matcherPosition: node.matcher.position,
			literal: resolved.literal,
			memberLiterals: resolved.memberLiterals,
			memberTypes: resolved.memberTypes,
		},
		null,
		node.position,
	)

	let bindings = resolveMatcherBindings(
		node.matcher,
		resolved.matcher,
		resolved.payload,
	)

	return [
		base,
		assertion,
		...bindings.map((binding) =>
			declareAssertionBinding(binding, baseName, resolved.matcher, scope),
		),
	]
}

// The Constant a `require` Matcher binds, such as
// `constant row = $assertion.value`, declared in the enclosing block. The base
// is read at the Matcher's Type, since the rest of the block runs only where
// the Matcher matched.
function declareAssertionBinding(
	binding: MatcherBinding,
	baseName: string,
	matcher: common.Type,
	scope: enricher.Scope,
): common.typed.ConstantDeclarationStatementNode {
	declareVariableInScope(binding.name, binding.type, scope, true)

	let base: common.typed.ExpressionNode = {
		nodeType: "Identifier",
		content: baseName,
		position: binding.name.position,
		type: matcher,
	}

	let baseType = matcher

	for (let [index, step] of binding.path.entries()) {
		let isLast = index === binding.path.length - 1
		let stepType = isLast ? binding.type : memberTypeOf(baseType, step)

		base = {
			nodeType: "Lookup",
			base,
			member: {
				nodeType: "Identifier",
				content: step,
				// Where each step was written, so the language server joins a
				// Pattern member to its Record member and a rename does not
				// rewrite the binder.
				position: binding.stepPositions[index] ?? binding.name.position,
				type: stepType,
			},
			position: binding.name.position,
			type: stepType,
		}

		baseType = stepType
	}

	return {
		nodeType: "ConstantDeclarationStatement",
		name: {
			nodeType: "Identifier",
			content: binding.name.content,
			position: binding.name.position,
			type: binding.type,
		},
		value: base,
		position: binding.name.position,
		headPosition: binding.name.position,
		declaredType: null,
		type: binding.type,
		documentation: null,
		synthesized: "binding",
	}
}

// #endregion

// #region Statements

// The two Declarations are excluded from the parameter Type: they may become
// several Statements, so `enrichNode` routes them to
// `enrichDeclarationStatement`.
export function enrichStatement(
	node: Exclude<
		parser.StatementNode,
		| parser.ConstantDeclarationStatementNode
		| parser.VariableDeclarationStatementNode
		| parser.ExpectStatementNode
		| parser.RequireStatementNode
	>,
	scope: enricher.Scope,
	hoistedTypes?: HoistedTypes,
): common.typed.StatementNode {
	// A hoisted declaration's Type is reused. The casts hold because each entry
	// was produced by the resolver the matching case calls.
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
			// The top-level walk in `enrich.ts` enriches this with
			// `enrichOverloadedFunctionStatement`. One nested in a body has no
			// typed Node.
			throw new Error(
				`A '${node.nodeType}' may only appear at the top level of a 'declarations { … }' Program`,
			)
	}
}

// Value shapes that can not be a Function. A List of Functions takes no
// Parameters itself.
const parameterlessValues = new Set([
	"RecordValue",
	"StringValue",
	"InterpolatedStringValue",
	"IntegerValue",
	"RationalValue",
	"BooleanValue",
	"ListValue",
	"DictionaryValue",
	"CaseValue",
])

// The Parameters a Declaration's value holds, so a `§§` block's `@param` can be
// checked against them. Null where they can not be read off the value, as for
// `constant alias = greet`, whose resolved Type keeps only external names.
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
		reportDocumentationParameters(documentation, [parameters])
	}
}

// Several Statements exactly when the name is a Pattern.
function enrichDeclarationStatement(
	node:
		| parser.ConstantDeclarationStatementNode
		| parser.VariableDeclarationStatementNode,
	scope: enricher.Scope,
): Array<common.typed.ImplementationNode> {
	if (node.name.nodeType === "Pattern") {
		return enrichPatternDeclarationStatement(node, node.name, scope)
	}

	markDeclaredValue(node.value)

	return [
		node.nodeType === "ConstantDeclarationStatement"
			? enrichConstantDeclarationStatement(node, node.name, scope)
			: enrichVariableDeclarationStatement(node, node.name, scope),
	]
}

function enrichConstantDeclarationStatement(
	node: parser.ConstantDeclarationStatementNode,
	name: parser.IdentifierNode,
	scope: enricher.Scope,
): common.typed.ConstantDeclarationStatementNode {
	reportUnknownDocumentationOfValue(node.documentation, node.value)

	// The annotation is the value's expected Type, so a bare Case resolves
	// against it.
	let declaredType = node.type !== null ? resolveType(node.type, scope) : null
	let value = enrichExpression(node.value, scope, declaredType)

	declareVariableInScope(name, declaredType ?? value.type, scope, true)

	recordConstantValue(name.content, value, scope)
	recordWrittenConstant(name.content, scope)

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

// What a Constant was given, so a Case payload default may name it; see
// `Scope.constantValues`. Only a top-level Scope carries one. A redeclaration
// overwrites, as `declareVariableInScope` does.
function recordConstantValue(
	name: string,
	value: common.typed.ExpressionNode,
	scope: enricher.Scope,
): void {
	if (scope.constantValues !== undefined) {
		scope.constantValues[name] = value
	}
}

function enrichVariableDeclarationStatement(
	node: parser.VariableDeclarationStatementNode,
	name: parser.IdentifierNode,
	scope: enricher.Scope,
): common.typed.VariableDeclarationStatementNode {
	reportUnknownDocumentationOfValue(node.documentation, node.value)

	// The annotation is the value's expected Type, so a bare Case resolves
	// against it.
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

// Desugars a Pattern Declaration into a base Constant and one Declaration per
// binding. See "Pattern declarations" in DEVELOPMENT.md.
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

	// Members are read off the declared Type where there is one, so bindings
	// and annotation agree.
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

	recordConstantValue(baseName, value, scope)

	let isConstant = node.nodeType === "ConstantDeclarationStatement"
	let bindings = declarePatternBindings(
		pattern,
		baseName,
		subjectType,
		scope,
		isConstant,
	)

	for (let binding of isConstant ? irrefutablePatternBindings(pattern) : []) {
		recordWrittenConstant(binding.name.content, scope)
	}

	return [base, ...bindings]
}

// The Statements a Pattern in a Declaration or a Parameter desugars into, each
// reading a binding off the base name. `isConstant` follows the Declaration's
// keyword; a Parameter's bindings are always Constants.
function declarePatternBindings(
	pattern: parser.PatternNode,
	baseName: string,
	subjectType: common.Type,
	scope: enricher.Scope,
	isConstant: boolean,
): Array<common.typed.ImplementationNode> {
	return irrefutablePatternBindings(pattern).map((binding) => {
		let type = memberTypeInIrrefutablePosition(binding, subjectType, scope)
		// Carried as a written annotation, so a mismatch is the validator's
		// `assignment-type-mismatch` at the member's span.
		let declaredType =
			binding.type === null ? null : resolveType(binding.type, scope)

		declareVariableInScope(
			binding.name,
			declaredType ?? type,
			scope,
			isConstant,
		)

		let value = memberPathLookup(
			baseName,
			subjectType,
			binding,
			type,
			pattern.position,
		)

		// Recorded like any Constant, so a payload default naming a binding is
		// refused for being no literal rather than for an undeclared name.
		if (isConstant) {
			recordConstantValue(binding.name.content, value, scope)
		}

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
			value,
			position: binding.name.position,
			headPosition: binding.name.position,
			declaredType,
			type,
			documentation: null,
			synthesized: "binding",
		} as common.typed.ImplementationNode
	})
}

// What a binding reads in a Declaration or a Parameter, through the resolver a
// written Lookup uses. See "Pattern declarations" in DEVELOPMENT.md.
function memberTypeInIrrefutablePosition(
	binding: PatternBinding,
	subjectType: common.Type,
	scope: enricher.Scope,
): common.Type {
	let type = subjectType

	for (let step of binding.steps) {
		type = lookupTypeOf(
			type,
			step.name.content,
			{
				member: step.name.position,
				base: step.name.position,
			},
			null,
			scope,
		)

		// An annotation on an intermediate step constrains that step only, so
		// it is checked here. The validator checks the last one through
		// `declaredType`.
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

// Reported by hand because an intermediate step becomes no Statement for the
// validator to check.
function reportPatternMemberMismatch(
	name: parser.IdentifierNode,
	declared: common.Type,
	actual: common.Type,
): void {
	// Notes and no labels: the step is a member read off the subject, with no
	// Literal to point into.
	let record = recordMismatchEvidence(declared, actual, null)

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
				...record.notes,
			],
			helps: record.helps,
		},
	)
}

function enrichVariableAssignmentStatement(
	node: parser.VariableAssignmentStatementNode,
	scope: enricher.Scope,
): common.typed.VariableAssignmentStatementNode {
	let declaringScope = findDeclaringScope(node.name.content, scope)

	let declarationPosition =
		declaringScope?.declarations[node.name.content] ?? null

	// A name that can be no Variable at all has no Type to judge the value by.
	let { refused, type } = refuseReassignment(node.name, declaringScope, scope)
	let name = enrichIdentifier(node.name, scope, type)

	noteOuterRead(node.name, name.type, scope, true)

	// The Variable's Type is the value's expected Type, so a bare Case resolves
	// against it.
	let value = enrichExpression(node.value, scope, name.type)
	let pinned = narrowUnknownSlots(
		node.name.content,
		declaringScope,
		value.type,
	)

	return {
		nodeType: "VariableAssignmentStatement",
		// Carries the Type the assignment decided, which the validator judges
		// it against. Rebuilt rather than re-enriched, so the capture check
		// stays where the name was read.
		name: pinned === null ? name : { ...name, type: pinned },
		value,
		declarationPosition,
		...(refused ? { refused: true as const } : {}),
		position: node.position,
	}
}

// The first assignment that decides an empty literal's Unknown slot decides it
// for good. Answers the decided Type, or null. See "Undecided slots" in
// DEVELOPMENT.md.
function narrowUnknownSlots(
	name: string,
	declaringScope: enricher.Scope | null,
	valueType: common.Type,
): common.Type | null {
	// A refused Constant reassignment decides nothing.
	if (declaringScope === null || declaringScope.constants.has(name)) {
		return null
	}

	let storedType = declaringScope.members[name]
	let narrowed = resolveUnknownSlots(storedType, valueType)

	if (narrowed === storedType) {
		return null
	}

	declaringScope.members[name] = narrowed

	return narrowed
}

function enrichNamespaceDefinitionStatement(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.NamespaceType,
): common.typed.NamespaceDefinitionStatementNode {
	// Methods and Properties check their own blocks, so this only checks the
	// Namespace's own `@param` lines.
	reportDocumentationParameters(node.documentation, [])

	// `namespace Self for Integer { … }`: a Namespace is named and reached like
	// a Type, so `Self` is reserved for it too. Reported here because hoisting
	// may resolve a Namespace's Type more than once, and this pass runs once.
	if (node.name.content === "Self") {
		reportReservedTypeName(node.name.position)
	}

	function enrichProperties(
		properties: Record<string, parser.NamespacePropertyNode>,
		namespaceType: common.NamespaceType,
		scope: enricher.Scope,
	): Record<string, common.typed.NamespaceProperty> {
		let result: Record<string, common.typed.NamespaceProperty> = {}

		// The Namespace as its static Properties see it, seeded as the
		// resolution pass seeded it: natives bound, bodied Properties Error
		// until enriched here.
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
			// A native static Property has no value, so it is in the Namespace
			// Type but not in the typed tree, like a native Method.
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
				// A typed Identifier of its own, so the cursor can land on the
				// name.
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
			settleProperty(namespaceType, propertyKey, value)
		}

		return result
	}

	// A hoisted Namespace reuses its Type, since resolving it again re-enriches
	// every Property value. A nested or unhoisted one resolves in place.
	let type =
		hoistedType ?? resolveNamespaceDefinitionStatementType(node, scope)

	if (hoistedType === undefined) {
		declareVariableInScope(node.name, type, scope, true)
	}

	let checkedConformances = checkProtocolConformance(node, type, scope)

	// A Namespace's Type Parameters can only be worked out from a receiver,
	// which is what `infer` says. Without it the target matches no receiver and
	// the Namespace is never found, so the spelling is refused rather than
	// re-read as `infer`.
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

	// A bound on a Namespace's own Type Parameter would apply to every Method.
	// It belongs on a Method's `<…>`. A Method that fulfils a conformance can
	// carry no bound of its own, so its bound goes on that conformance's
	// `where`. The Help names only conformances this Namespace declares.
	for (let generic of node.generics) {
		if (generic.constraint !== null) {
			let parameter = generic.name.content
			let protocolName = generic.constraint.content

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
					notes: [
						`A bound written here would apply to every Method of '${node.name.content}', including the ones that do not need it.`,
						"A 'where' condition reaches the Methods that fulfil its conformance, which is the part a bound on the Namespace itself could never say.",
					],
					helps: [
						`Bound it on each Method that needs it: write '<${parameter} is ${protocolName}>' after that Method's name.`,
						...conformanceBoundHelps(node, parameter, protocolName),
					],
				},
			)
		}
	}

	refuseDuplicateTypeParameters(node.generics)
	refuseMalformedMethodBounds(node, type)

	// Run again on purpose. The hoist wove these bounds into the Namespace Type
	// for earlier use sites. Only this pass makes the typed Generic
	// Declarations the rewriter emits witnesses from.
	let injectedGenerics = weaveMethodBounds(
		node,
		type,
		checkedConformances,
		scope,
		true,
	)

	// Namespace Type Parameters are opaque GenericUses in every Method.
	let methodScope = scopeWithGenerics(node.generics, scope)

	// Read by one Diagnostic. A Method body does not see the Namespace's name
	// as a binding; `Clock.noon` resolves through the surrounding Scope. See
	// `Scope.namespace`.
	methodScope.namespace = { name: node.name.content, type }

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
		...enrichMethods(
			node.methods,
			methodScope,
			type.targetType,
			type.methods,
			injectedGenerics,
			type.generics,
		),
		position: node.position,
		headPosition: headPositionOf(node.position, [
			node.name.position,
			...node.generics.map((generic) => generic.position),
			node.targetType?.position,
			// A clause's Position covers its `where` conditions.
			...node.conformsTo.map((clause) => clause.position),
		]),
		type,
		documentation: node.documentation,
	}
}

// Refuses the two entries a Method may write against a Namespace Type Parameter
// that are no bound. See "Method bounds on Namespace Type Parameters" in
// DEVELOPMENT.md.
function refuseMalformedMethodBounds(
	node: parser.NamespaceDefinitionStatementNode,
	type: common.NamespaceType,
): void {
	// Every Method, generic Namespace or not, checked per form: two Overloads
	// may each name `Item`.
	for (let method of Object.values(node.methods)) {
		for (let form of methodGenericForms(method)) {
			refuseDuplicateTypeParameters(form)
		}
	}

	if (type.generics.length === 0) {
		return
	}

	let declared = new Map(
		type.generics.map((generic) => [generic.name, generic] as const),
	)

	for (let [methodName, method] of Object.entries(node.methods)) {
		// One report per Parameter per Method, across the forms of an Overload
		// set and across a list that names it twice.
		let reported = new Set<string>()

		for (let entry of methodGenericEntries(method)) {
			let parameter = entry.name.content

			if (!declared.has(parameter) || reported.has(parameter)) {
				continue
			}

			reported.add(parameter)

			// `infer` is asked first, because the word decides which mistake
			// this is. `<infer Item>` is no shadow: the receiver binds it, so
			// it restates the Namespace's own declaration.
			if (entry.inferred) {
				// With a bound the edit keeps the bound and drops `infer`.
				// Without one the edit removes the entry, so `data` names the
				// edit rather than the code.
				let bound = entry.constraint
				let restated =
					bound === null
						? {
								notes: [
									`'${parameter}' is worked out from the receiver at every call to '${methodName}' already, so this entry re-states what '${node.name.content}' declares and adds nothing to it.`,
								],
								helps: [
									`Drop '${parameter}' from '${methodName}'s Type Parameters.`,
								],
								data: {
									kind: "shadowed-type-parameter" as const,
									parameter,
								},
							}
						: {
								notes: [
									`A Method bounds a Type Parameter it shares rather than declaring one of its own, so '<${parameter} is ${bound.content}>' is the whole of what '${methodName}' has to say about it.`,
								],
								helps: [
									`Write '<${parameter} is ${bound.content}>' on '${methodName}'.`,
								],
								data: {
									kind: "restated-inferred-parameter" as const,
									parameter,
									protocol: bound.content,
								},
							}

				reportError(
					`'${parameter}' is already inferred by this Namespace`,
					entry.position,
					{
						code: "restated-inferred-parameter",
						labels: [
							primary(
								entry.position,
								`'infer' belongs on '${node.name.content}'s own declaration, where it is`,
							),
						],
						...restated,
					},
				)

				continue
			}

			if (entry.constraint === null) {
				// Nothing can bind this entry, since the receiver binds the
				// Namespace's Parameter. Where the body needs a bound, dropping
				// the entry raises `unsatisfied-bound`, which names the
				// Protocol.
				reportError(
					`'${parameter}' is already this Namespace's Type Parameter`,
					entry.position,
					{
						code: "shadowed-type-parameter",
						labels: [
							primary(
								entry.position,
								`'${node.name.content}' declares '${parameter}' already`,
							),
						],
						notes: [
							`'${parameter}' is worked out from the receiver at every call to '${methodName}', so a second one here could only shadow it — and nothing would ever bind that.`,
						],
						helps: [
							`Drop '${parameter}' from '${methodName}'s Type Parameters.`,
						],
						data: {
							kind: "shadowed-type-parameter" as const,
							parameter,
						},
					},
				)
			}
		}
	}
}

// Every `<…>` list a Namespace Method writes, one per form.
function methodGenericForms(
	method: parser.NamespaceMethods[string],
): Array<Array<parser.GenericDeclarationNode>> {
	switch (method.nodeType) {
		case "SimpleMethod":
		case "StaticMethod":
			return [method.method.value.generics]
		case "SimpleMethodSignature":
		case "StaticMethodSignature":
			return [method.signature.generics]
		default:
			return method.methods.map((overload) =>
				overload.nodeType === "NativeMethodSignature"
					? overload.generics
					: overload.value.generics,
			)
	}
}

// Every `<…>` entry a Namespace Method writes, across all its forms.
function methodGenericEntries(
	method: parser.NamespaceMethods[string],
): Array<parser.GenericDeclarationNode> {
	switch (method.nodeType) {
		case "SimpleMethod":
		case "StaticMethod":
			return method.method.value.generics
		case "SimpleMethodSignature":
		case "StaticMethodSignature":
			return method.signature.generics
		default:
			return method.methods.flatMap((overload) =>
				overload.nodeType === "NativeMethodSignature"
					? overload.generics
					: overload.value.generics,
			)
	}
}

// Threads per-Method and conditional conformance bounds into the Methods they
// reach, and answers the Generic Declarations to inject into their typed Nodes.
// See "Method bounds on Namespace Type Parameters" in DEVELOPMENT.md.
function weaveMethodBounds(
	node: parser.NamespaceDefinitionStatementNode,
	type: common.NamespaceType,
	checkedConformances: Array<CheckedConformance>,
	scope: enricher.Scope,
	report: boolean,
): Map<string, Array<Array<common.typed.GenericDeclarationNode>>> {
	// Which Namespace Type Parameter each Method treats as bound, one map per
	// Overload, keyed by Method name. The Overload index orders the retained
	// Type, the typed Node and the witness list alike.
	let methodBounds = new Map<string, Array<Map<string, string>>>()
	let splitsOf = new Map<string, Array<MethodGenericSplit>>()

	let boundsFor = (methodName: string): Array<Map<string, string>> => {
		let existing = methodBounds.get(methodName)

		if (existing !== undefined) {
			return existing
		}

		let methodNode = node.methods[methodName]
		let splits =
			methodNode === undefined
				? []
				: methodGenericSplits(methodNode, type.generics, scope)

		splitsOf.set(methodName, splits)

		// Seeded from the Method's own bounds and those its target Type
		// implies, so a conflicting condition is reported rather than
		// overwriting one.
		let implied = impliedTargetBounds(node, scope)
		let bounds = splits.map(
			(split) => new Map([...implied, ...split.bounds]),
		)

		methodBounds.set(methodName, bounds)

		return bounds
	}

	// Per-Method bounds first, since a Method that fulfils no conformance needs
	// them too.
	for (let methodName of Object.keys(node.methods)) {
		boundsFor(methodName)
	}

	let refuseConflict = (
		methodName: string,
		generic: string,
		existing: string,
		wanted: string,
		position: common.Position,
	) => {
		if (!report) {
			return
		}

		reportError(
			`Method '${methodName}' can not satisfy conflicting Protocol bounds`,
			position,
			{
				code: "conflicting-where-condition",
				labels: [
					primary(
						position,
						`Method '${methodName}' would need both '${generic} is ${describeProtocol(existing, scope)}' and '${generic} is ${describeProtocol(wanted, scope)}'`,
					),
				],
				notes: [
					`One hidden conformance Argument stands for '${generic}' in '${methodName}', so it can carry one Protocol.`,
				],
				helps: [
					`Write one bound for '${generic}' on '${methodName}', or split the Method in two.`,
				],
			},
		)
	}

	for (let conformance of checkedConformances) {
		if (conformance.conditions.length === 0) {
			continue
		}

		// The values are emitted names, and an overloaded fulfiller's carries a
		// `__overload$N` suffix.
		let fulfillingMethods = new Set(
			Object.values(conformance.methodMap).map((emittedName) =>
				emittedName.replace(/__overload\$\d+$/, ""),
			),
		)

		for (let methodName of fulfillingMethods) {
			let clause = node.conformsTo.find(
				(candidate) =>
					resolveWrittenProtocol(candidate.protocol, scope)
						?.identity === conformance.protocolName,
			)

			for (let bounds of boundsFor(methodName)) {
				for (let condition of conformance.conditions) {
					let existing = bounds.get(condition.generic)

					if (
						existing !== undefined &&
						existing !== condition.protocol
					) {
						refuseConflict(
							methodName,
							condition.generic,
							existing,
							condition.protocol,
							clause?.position ?? node.name.position,
						)

						continue
					}

					bounds.set(condition.generic, condition.protocol)
				}
			}
		}
	}

	// The bounded Namespace Type Parameters to inject per Overload, leading the
	// Method's own so their witness Parameters are emitted first. INVARIANT:
	// the Method Type, the typed Node and the curried witnesses agree. See
	// "Method bounds on Namespace Type Parameters" in DEVELOPMENT.md.
	let injectedGenerics = new Map<
		string,
		Array<Array<common.typed.GenericDeclarationNode>>
	>()

	for (let [methodName, bounds] of methodBounds) {
		let methodNode = node.methods[methodName]
		let methodType = type.methods[methodName]

		if (
			methodNode === undefined ||
			methodType === undefined ||
			bounds.every((entry) => entry.size === 0)
		) {
			continue
		}

		// The names each form declares itself, telling a retained Namespace
		// Type Parameter from a Method one that shadows it.
		let ownGenerics = ownGenericNames(splitsOf.get(methodName) ?? [])

		// Puts bound Namespace Type Parameters back on Overloads that pruned
		// them, on fresh objects so shared ones stay untouched. Idempotent.
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

		// Read back off the retained Type, so the two views agree by
		// construction.
		let retained =
			methodType.type === "SimpleMethod" ||
			methodType.type === "StaticMethod"
				? [methodType.generics]
				: methodType.overloads.map((overload) => overload.generics)

		let injected = retained.map((generics, index) => {
			let entryBounds = bounds[index] ?? new Map()

			return node.generics
				.filter(
					(generic) =>
						entryBounds.has(generic.name.content) &&
						!(ownGenerics[index] ?? new Set()).has(
							generic.name.content,
						) &&
						generics.some(
							(candidate) =>
								candidate.name === generic.name.content,
						),
				)
				.map((generic): common.typed.GenericDeclarationNode => {
					let identity = entryBounds.get(generic.name.content)!

					return {
						nodeType: "GenericDeclaration",
						name: generic.name.content,
						inferred: generic.inferred,
						defaultType: generic.defaultType
							? resolveType(generic.defaultType, scope)
							: null,
						constraint: identity,
						spelling: describeProtocol(identity, scope),
						position: generic.position,
					}
				})
		})

		if (injected.some((list) => list.length > 0)) {
			injectedGenerics.set(methodName, injected)
		}
	}

	return injectedGenerics
}

// The Type Parameter names each form of a Namespace Method declares for itself,
// one Set per Overload. An entry that only bounds the Namespace's Parameter
// counts as neither.
function ownGenericNames(
	splits: Array<MethodGenericSplit>,
): Array<Set<string>> {
	return splits.map(
		(split) => new Set(split.own.map((generic) => generic.name.content)),
	)
}

// A copy of a Method Type whose every Overload carries the bound Namespace Type
// Parameters its own entry of `bounds` names, re-added where pruned. Fresh
// objects throughout, and idempotent. See "Method bounds on Namespace Type
// Parameters" in DEVELOPMENT.md.
function retainNamespaceBounds(
	method: common.MethodType,
	ownGenerics: Array<Set<string>>,
	bounds: Array<Map<string, string>>,
	namespaceGenerics: Array<common.GenericDeclaration>,
): common.MethodType {
	let apply = (
		generics: Array<common.GenericDeclaration>,
		own: Set<string>,
		entryBounds: Map<string, string>,
	): Array<common.GenericDeclaration> => {
		let leading: Array<common.GenericDeclaration> = []

		for (let namespaceGeneric of namespaceGenerics) {
			// A Method Type Parameter of the same name shadows this one, and
			// re-adding it would duplicate the name.
			if (own.has(namespaceGeneric.name)) {
				continue
			}

			let existing = generics.find(
				(generic) => generic.name === namespaceGeneric.name,
			)
			let constraint = entryBounds.get(namespaceGeneric.name)

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
			generics: apply(
				method.generics,
				ownGenerics[0] ?? new Set(),
				bounds[0] ?? new Map(),
			),
		}
	}

	return {
		...method,
		overloads: method.overloads.map((overload, index) => ({
			...overload,
			generics: apply(
				overload.generics,
				ownGenerics[index] ?? new Set(),
				bounds[index] ?? new Map(),
			),
		})),
	}
}

function enrichProtocolDeclarationStatement(
	node: parser.ProtocolDeclarationStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.ProtocolType,
): common.typed.ProtocolDeclarationStatementNode {
	// The Protocol's own block. Each Method signature it holds checks
	// its own as its Parameter Types are resolved.
	reportDocumentationParameters(node.documentation, [])

	let protocolType =
		hoistedType ?? resolveProtocolDeclarationStatementType(node, scope)

	if (hoistedType === undefined) {
		declareProtocolInScope(node.name, protocolType, scope)
	}

	// A Protocol is not a Type, so its name carries Unknown rather than a
	// Type borrowed from something else.
	let name = enrichIdentifier(node.name, scope, { type: "Unknown" })

	refuseIncompatibleRestatements(node, protocolType, scope)

	let methods = enrichProvidedMethods(node, protocolType, scope)

	for (let method of Object.values(methods)) {
		if (method.nodeType === "SimpleMethod") {
			reportProvidedBodyReaches(
				typedBodyNamespaceReaches(method.method),
				protocolType.identity,
				scope,
			)
		}
	}

	// Nothing solved before this point reaches a Protocol that did not
	// hoist, so its bodies' typed reads stand in before anything asks.
	if (hoistedType === undefined) {
		Object.assign(
			protocolType.providedReads ?? {},
			narrowedReads(protocolType, methods, scope),
		)
	}

	return {
		nodeType: "ProtocolDeclarationStatement",
		name,
		protocolType,
		conformsTo: node.conformsTo.map((clause) => ({
			name: clause.protocol.content,
			position: clause.protocol.position,
		})),
		methods,
		position: node.position,
		headPosition: headPositionOf(node.position, [
			node.name.position,
			...node.conformsTo.map((clause) => clause.position),
		]),
		documentation: node.documentation,
	}
}

// The bodies of a Protocol's own provided Methods. `@` is `Self` bounded by the
// Protocol, so a body calls the Protocol's surface through the bound's hidden
// witness. An inherited Method is emitted once, where it was written.
function enrichProvidedMethods(
	node: parser.ProtocolDeclarationStatementNode,
	protocolType: common.ProtocolType,
	scope: enricher.Scope,
): common.typed.Methods {
	let methods: common.typed.Methods = {}

	for (let [methodName, methodValue] of Object.entries(node.methods)) {
		let body = protocolMethodBody(methodValue)

		if (body === null) {
			refuseUnwritableProvidedMethod(methodValue)

			continue
		}

		if (
			providedMethodProtocol(protocolType, methodName) !==
			protocolType.identity
		) {
			continue
		}

		let selfDeclaration: common.typed.GenericDeclarationNode = {
			nodeType: "GenericDeclaration",
			name: "Self",
			inferred: true,
			defaultType: null,
			constraint: protocolType.identity,
			position: node.name.position,
		}
		let boundSelf: common.GenericUse = {
			type: "GenericUse",
			name: "Self",
			constraint: protocolType.identity,
		}
		let bodyScope = childScope(scope, {
			types: { Self: boundSelf },
			providedMethodOf: protocolType.identity,
		})
		let type = resolveFunctionValueType(body, bodyScope)

		methods[methodName] = {
			nodeType: "SimpleMethod",
			name: enrichIdentifier(methodValue.name, scope, {
				type: "Unknown",
			}),
			method: {
				nodeType: "FunctionValue",
				value: enrichMethodFunctionDefinition(
					body,
					bodyScope,
					boundSelf,
					type,
					[selfDeclaration],
					false,
				),
				position: body.position,
				type,
			},
		}
	}

	return methods
}

// What each body the syntactic reading takes to read its whole witness
// reads once typed. The typing is a probe that reports and records nothing, and
// says nothing where it finds an Error, since the typing kept may then differ.
export function typedProvidedReads(
	node: parser.ProtocolDeclarationStatementNode,
	protocolType: common.ProtocolType,
	scope: enricher.Scope,
): Record<string, Array<string>> {
	if (
		!Object.values(protocolType.providedReads ?? {}).some((reads) =>
			readsEveryEntry(reads, protocolType.methods),
		)
	) {
		return {}
	}

	try {
		let typed = probeContextualFunctionTypes(() =>
			collectDiagnostics(() =>
				enrichProvidedMethods(node, protocolType, scope),
			),
		).result

		return containsErrors(typed.diagnostics)
			? {}
			: narrowedReads(protocolType, typed.result, scope)
	} catch {
		return {}
	}
}

function narrowedReads(
	protocolType: common.ProtocolType,
	methods: common.typed.Methods,
	scope: enricher.Scope,
): Record<string, Array<string>> {
	let narrowed: Record<string, Array<string>> = {}

	for (let [methodName, reads] of Object.entries(
		protocolType.providedReads ?? {},
	)) {
		let method = methods[methodName]

		if (
			method?.nodeType === "SimpleMethod" &&
			readsEveryEntry(reads, protocolType.methods)
		) {
			narrowed[methodName] = typedBodyReads(
				method.method.value,
				protocolType.methods,
				(identity) => knownProtocol(identity, scope)?.methods ?? null,
			)
		}
	}

	return narrowed
}

// A body on a `static` or an `overload` entry is refused. A static Method has
// no receiver for `Self`, and an Overload has no name of its own to emit under.
// The signatures still stand as requirements.
function refuseUnwritableProvidedMethod(
	method: parser.ProtocolMethods[string],
): void {
	let isStatic = method.nodeType === "StaticProtocolMethod"
	let signatures =
		method.nodeType === "StaticProtocolMethod"
			? [method.signature]
			: method.nodeType === "OverloadedProtocolMethod" ||
				  method.nodeType === "OverloadedStaticProtocolMethod"
				? method.signatures
				: []
	let bodied = signatures.find((signature) => signature.body !== null)

	if (bodied === undefined) {
		return
	}

	let position = bodied.body?.position ?? bodied.position

	reportError(
		isStatic
			? "A static Protocol Method can not carry a body"
			: "An overloaded Protocol Method can not carry a body",
		position,
		{
			code: "unwritable-provided-method",
			labels: [
				primary(
					position,
					isStatic
						? "this body has no receiver to run on"
						: "this body has no name of its own to be emitted under",
				),
			],
			notes: [
				isStatic
					? "A provided Method is written on '@', the conforming value, and a static Method is called on the Namespace instead."
					: "A provided Method is emitted once, under the Protocol's name and the Method's — and an entry of an 'overload' block is named for its slot in a Method Type the Protocol has no conformer to resolve against.",
			],
			helps: [
				`Write '${method.name.content}' as a requirement, and give each conforming Namespace a body of its own.`,
			],
		},
	)
}

// Reported at the Protocol rather than where a bounded value reaches the
// ancestor's bound.
function refuseIncompatibleRestatements(
	node: parser.ProtocolDeclarationStatementNode,
	protocolType: common.ProtocolType,
	scope: enricher.Scope,
): void {
	for (let { methodName, refused, source } of incompatibleRestatements(
		protocolType,
	)) {
		let inherited = refused.ancestor.methods[methodName]
		let ancestorName = describeProtocol(refused.ancestor.identity, scope)
		let declared = quotedSignatures(methodName, inherited)
		let conforms = `Whatever conforms to '${node.name.content}' conforms to '${ancestorName}' as well, so a call through '${ancestorName}'`

		if (source === null) {
			let written = node.methods[methodName]
			let overloads =
				written.nodeType === "OverloadedProtocolMethod" &&
				inherited.type === "SimpleMethod"

			reportError(
				`Protocol '${node.name.content}' restates '${methodName}' with a signature '${ancestorName}' does not accept`,
				written.name.position,
				{
					code: "incompatible-restatement",
					labels: [
						primary(
							written.name.position,
							`'${ancestorName}' declares it as ${declared}`,
						),
					],
					notes: [
						`${conforms} reaches this '${methodName}' and calls it as '${ancestorName}' declares it.`,
						...(overloads
							? [
									`A call through '${ancestorName}' reaches the one '${methodName}' it declares, and an 'overload' block keeps each of its signatures as an entry of its own, so none of them is that one.`,
								]
							: []),
					],
					helps: [
						overloads
							? `Restate '${methodName}' as the one signature '${ancestorName}' declares for it, ${declared}, and give the other signatures a name of their own.`
							: `Restate '${methodName}' with the signature '${ancestorName}' declares for it, ${declared}, or give this Method a name of its own.`,
					],
				},
			)

			continue
		}

		let sourceName = describeProtocol(source.ancestor.identity, scope)

		reportError(
			`Protocol '${node.name.content}' inherits '${methodName}' with a signature '${ancestorName}' does not accept`,
			source.clause.protocol.position,
			{
				code: "incompatible-restatement",
				labels: [
					primary(
						source.clause.protocol.position,
						`'${methodName}' comes from '${sourceName}' as ${quotedSignatures(methodName, protocolType.methods[methodName])}`,
					),
					secondary(
						refused.clause.protocol.position,
						`'${ancestorName}' declares it as ${declared}`,
					),
				],
				notes: [
					`${conforms} reaches the '${methodName}' '${sourceName}' declares and calls it as '${ancestorName}' declares it.`,
				],
				helps: [
					`Declare '${methodName}' with one signature in '${sourceName}' and '${ancestorName}', or give one of the two Methods a name of its own.`,
				],
			},
		)
	}
}

// A Method's signatures as a reader writes them, each quoted.
function quotedSignatures(
	methodName: string,
	method: common.MethodType,
): string {
	let prefix =
		method.type === "StaticMethod" ||
		method.type === "OverloadedStaticMethod"
			? "static "
			: ""

	return (signaturesOf(method) ?? [])
		.map(
			(signature) =>
				`'${prefix}${printSignature(signature, methodName)}'`,
		)
		.join(" and ")
}

// `infer` marks a Type Parameter a use works out from its Arguments. A Choice
// and a Type Alias apply theirs at every use, so the marker means nothing
// there. Reported in enrichment rather than resolution, so the Choice still
// hoists.
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

function enrichTypeAliasStatement(
	node: parser.TypeAliasStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.Type,
): common.typed.TypeAliasStatementNode {
	reportDocumentationParameters(node.documentation, [])
	reportInferredTypeParameters(node.generics, "Type Alias")
	refuseDuplicateTypeParameters(node.generics)

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

// The typed predicate, for the language server alone; the Type already holds
// the conjunct keys. Its Diagnostics are dropped, since resolution reported
// them. A generic refined Alias binds `@` to the base one level in.
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

function enrichChoiceDeclarationStatement(
	node: parser.ChoiceDeclarationStatementNode,
	scope: enricher.Scope,
	hoistedType?: common.UnionType | common.GenericAliasType,
): common.typed.ChoiceDeclarationStatementNode {
	reportDocumentationParameters(node.documentation, [])
	reportInferredTypeParameters(node.generics, "Choice")
	refuseDuplicateTypeParameters(node.generics)

	let type = hoistedType ?? resolveChoiceDeclarationStatementType(node, scope)

	if (hoistedType === undefined) {
		declareTypeInScope(node.name, type, scope)
	}

	// A generic Choice is a Generic Alias over the Union of its Cases.
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
		// A duplicate Case was reported and dropped from the Union, so its name
		// borrows the surviving Case's Type. The fallback carries `unitChoice`
		// when every Case does.
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
				defaultValue: enrichCasePayloadDefault(
					choiceCase,
					caseType,
					scope,
				),
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

// A Case payload's `= { … }`, read against the payload Record in the Module's
// own Scope and baked into the Case Type. See "Case payload defaults" in
// DEVELOPMENT.md.
function enrichCasePayloadDefault(
	choiceCase: parser.ChoiceCaseNode,
	caseType: common.CaseType,
	scope: enricher.Scope,
): common.typed.ExpressionNode | null {
	if (choiceCase.defaultValue === null) {
		return null
	}

	let payloadType: common.RecordType = {
		type: "Record",
		members: caseType.members,
	}
	let value = enrichExpression(choiceCase.defaultValue, scope, payloadType)

	// Already reported by the resolver for a generic Choice. Enriched anyway,
	// so the language server answers inside it.
	if (caseType.choiceGenerics !== undefined) {
		return value
	}

	// The resolver registers no default that is not a Record Literal, so it is
	// refused here, and `payloadDefault` is present after this check.
	if (
		value.nodeType !== "RecordValue" ||
		value.type.type !== "Record" ||
		caseType.payloadDefault === undefined
	) {
		reportCaseDefaultNotARecordLiteral(value, caseType)

		return value
	}

	// A written member carries its own evidence for a refinement, and a
	// Function refused as a value is a hole, reported where it is written.
	let written = admittedPartialType(payloadType, value.type, value)

	if (!isPartialOf(payloadType, written)) {
		// A partial, so a member the default leaves out is not missing. Only
		// what it writes can be wrong.
		let record = recordMismatchEvidence(payloadType, written, value, {
			partial: true,
			subject: `'#${caseType.name}'`,
		})

		reportError(
			`This default does not fit Case '#${caseType.name}'`,
			record.lead?.position ?? choiceCase.defaultValue.position,
			{
				code: "default-type-mismatch",
				labels: [
					record.lead ??
						primary(
							choiceCase.defaultValue.position,
							`this is ${withArticle(describeType(value.type))}`,
						),
					...record.labels,
				],
				notes: [
					`'#${caseType.name}' carries ${withArticle(describeType(payloadType))}.`,
					...record.notes,
					"A payload default may fill in only some of those members; it may not name one the payload does not declare, nor give one a value of another Type.",
				],
				helps: [
					...record.helps,
					`Write the members of ${describeType(payloadType)} this default means to fill in.`,
				],
				data: record.data,
			},
		)

		return value
	}

	let literal = true
	let baked: Record<string, common.typed.ExpressionNode> = {}

	for (let [name, member] of Object.entries(value.members)) {
		let result = bakeCaseDefaultValue(member, scope, [])

		if ("baked" in result) {
			baked[name] = result.baked
		} else {
			literal = false
		}
	}

	if (literal) {
		caseType.payloadDefault.values = baked
	}

	return value
}

// A payload default's value as data baked into the Case Type, or the Node the
// walk gave up at.
type BakedCaseDefault =
	| { baked: common.typed.ExpressionNode }
	| { offending: common.typed.ExpressionNode }

// One value of a payload default resolved to data. See "Case payload defaults"
// in DEVELOPMENT.md.
function bakeCaseDefaultValue(
	node: common.typed.ExpressionNode,
	scope: enricher.Scope,
	through: ReadonlyArray<string>,
): BakedCaseDefault {
	switch (node.nodeType) {
		// An interpolated String holds Expressions and is absent. A bare
		// `#Case` is a Case value with a null payload.
		case "IntegerValue":
		case "RationalValue":
		case "StringValue":
		case "BooleanValue":
			return { baked: node }
		case "ListValue": {
			let values: Array<common.typed.ExpressionNode> = []
			let changed = false

			for (let value of node.values) {
				let result = bakeCaseDefaultValue(value, scope, through)

				if (!("baked" in result)) {
					return result
				}

				changed ||= result.baked !== value
				values.push(result.baked)
			}

			// The Node itself where nothing under it was a name.
			return { baked: changed ? { ...node, values } : node }
		}
		case "RecordValue": {
			let members: Record<string, common.typed.ExpressionNode> = {}
			let changed = false

			for (let [name, member] of Object.entries(node.members)) {
				let result = bakeCaseDefaultValue(member, scope, through)

				if (!("baked" in result)) {
					return result
				}

				changed ||= result.baked !== member
				members[name] = result.baked
			}

			return { baked: changed ? { ...node, members } : node }
		}
		case "CaseValue": {
			if (node.value === null) {
				return { baked: node }
			}

			let result = bakeCaseDefaultValue(node.value, scope, through)

			if (!("baked" in result)) {
				return result
			}

			return {
				baked:
					result.baked === node.value
						? node
						: { ...node, value: result.baked },
			}
		}
		case "Identifier":
			return bakeNamedCaseDefaultValue(node, scope, through)
		default:
			if (through.length === 0 && !alreadyReportedAbout(node)) {
				reportCaseDefaultNotWrittenDown(node)
			}

			return { offending: node }
	}
}

// Whether the value was already reported: an Error, such as a Constant named
// before its declaration, or a Function refused as a value.
function alreadyReportedAbout(node: common.typed.ExpressionNode): boolean {
	return typeContainsError(node.type) || isReportedValue(node.type)
}

// A name in a payload default stands for this Module's Constant whose value is
// written down. Anything else is refused.
function bakeNamedCaseDefaultValue(
	node: common.typed.IdentifierNode,
	scope: enricher.Scope,
	through: ReadonlyArray<string>,
): BakedCaseDefault {
	let name = node.content
	// The declaring Scope's map, so a binding that shadows a Module Constant
	// answers nothing.
	let declaring = findDeclaringScope(name, scope)
	let value = declaring?.constantValues?.[name]

	// A Constant can only name Constants declared before it, so no cycle
	// arises, but the guard keeps the walk terminating regardless.
	if (value === undefined || through.includes(name)) {
		if (through.length === 0 && !alreadyReportedAbout(node)) {
			reportCaseDefaultNameNotAConstant(node, declaring)
		}

		return { offending: node }
	}

	let result = bakeCaseDefaultValue(value, scope, [...through, name])

	if ("baked" in result || through.length > 0) {
		return result
	}

	reportCaseDefaultConstantNotALiteral(node, declaring, result.offending)

	return result
}

// One code, read four ways: a payload default must be data by the time the Case
// Type carries it.
const CASE_DEFAULT_NOTE =
	"A payload default is spliced into every construction of its Case, and a construction may stand in a Module that never named the Choice — so the value travels with the Case Type, and a name read where the Case is built would be a name that is not there."

const CASE_DEFAULT_HELP =
	"Write a literal — a Number, a String, a Boolean, or a List, Record or Case value built out of those — or name a Constant of this Module whose value is one."

function reportCaseDefaultNotARecordLiteral(
	node: common.typed.ExpressionNode,
	caseType: common.CaseType,
): void {
	reportError(
		`The default for Case '#${caseType.name}' is not a Record Literal`,
		node.position,
		{
			code: "case-default-not-a-literal",
			labels: [
				primary(
					node.position,
					"this names a value rather than writing one",
				),
			],
			notes: [
				"Which members a default fills in is read off the ones it writes, so the default itself is spelled out even where the values in it are names.",
				CASE_DEFAULT_NOTE,
			],
			// The member names fill the Help, while the values stay `…`, since
			// which value the reader meant can not be known.
			helps: [
				`Write the members out — '= { ${Object.keys(caseType.members)
					.map((member) => `${member} = …`)
					.join(
						", ",
					)} }' names every member of '#${caseType.name}', and a default may fill in any of them.`,
			],
		},
	)
}

function reportCaseDefaultNotWrittenDown(
	node: common.typed.ExpressionNode,
): void {
	reportError(
		"This value in a payload default is not a literal",
		node.position,
		{
			code: "case-default-not-a-literal",
			labels: [
				primary(
					node.position,
					"this is worked out rather than written down",
				),
			],
			notes: [CASE_DEFAULT_NOTE],
			helps: [CASE_DEFAULT_HELP],
		},
	)
}

function reportCaseDefaultNameNotAConstant(
	node: common.typed.IdentifierNode,
	declaring: enricher.Scope | null,
): void {
	let name = node.content

	reportError(`'${name}' is not a Constant of this Module`, node.position, {
		code: "case-default-not-a-literal",
		labels: [
			primary(node.position, `this default value names '${name}'`),
			...declarationLabel(name, declaring),
		],
		notes: [
			declaring !== null && !declaring.constants.has(name)
				? "A Variable holds whatever it was last assigned; a payload default is read once, where the Choice is declared."
				: "A payload default is read where the Choice is declared, so the only name it can follow is a Constant declared in the same Module.",
			CASE_DEFAULT_NOTE,
		],
		helps: [CASE_DEFAULT_HELP],
	})
}

function reportCaseDefaultConstantNotALiteral(
	node: common.typed.IdentifierNode,
	declaring: enricher.Scope | null,
	offending: common.typed.ExpressionNode,
): void {
	let name = node.content

	reportError(
		`The Constant '${name}' does not hold a literal`,
		node.position,
		{
			code: "case-default-not-a-literal",
			labels: [
				primary(node.position, `this default value names '${name}'`),
				secondary(
					offending.position,
					"this is worked out rather than written down",
				),
				...declarationLabel(name, declaring, offending.position),
			],
			notes: [CASE_DEFAULT_NOTE],
			helps: [
				`Give '${name}' a value that is written down, or write this default's value out here.`,
			],
		},
	)
}

// Left out for a name the compiler declared, which has no source. Also left out
// where the declaration stands on a span a label marks, as a Pattern binding's
// does.
function declarationLabel(
	name: string,
	declaring: enricher.Scope | null,
	taken?: common.Position,
): Array<common.DiagnosticLabel> {
	let position = declaring?.declarations[name]

	if (
		position === undefined ||
		(taken !== undefined &&
			position.start.line === taken.start.line &&
			position.start.column === taken.start.column &&
			position.end.line === taken.end.line &&
			position.end.column === taken.end.column)
	) {
		return []
	}

	return [secondary(position, `'${name}' is declared here`)]
}

// The condition is enriched before the branch Scopes exist, because narrowing
// reads the typed condition: which Namespace and Overload answered, and the
// receiver's Type.
function enrichIfElseStatementNode(
	node: parser.IfElseStatementNode,
	scope: enricher.Scope,
): common.typed.IfElseStatementNode {
	let condition = enrichExpression(node.condition, scope)
	let narrowings = trueBranchNarrowings(condition, scope)
	// What the condition leaves its `else`: that branch's Scope, and whether it
	// established anything.
	let complements = falseBranchNarrowings(condition, scope)
	let trueScope = branchScope(narrowings, scope)
	let falseScope = branchScope(complements, scope)
	let trueBody = node.trueBody.flatMap((node) => enrichNode(node, trueScope))

	reportRedundantKeyCheck(condition, trueBody)

	return {
		nodeType: "IfElseStatement",
		condition,
		narrows: narrowings.length > 0,
		narrowsFalse: complements.length > 0,
		trueBody,
		falseBody: node.falseBody.flatMap((node) =>
			enrichNode(node, falseScope),
		),
		position: node.position,
	}
}

function enrichIfStatement(
	node: parser.IfStatementNode,
	scope: enricher.Scope,
): common.typed.IfStatementNode {
	let condition = enrichExpression(node.condition, scope)
	let narrowings = trueBranchNarrowings(condition, scope)
	let bodyScope = branchScope(narrowings, scope)
	let body = node.body.flatMap((node) => enrichNode(node, bodyScope))

	reportRedundantKeyCheck(condition, body)

	return {
		nodeType: "IfStatement",
		condition,
		narrows: narrowings.length > 0,
		body,
		position: node.position,
	}
}

// The label a Dictionary lookup writes its key under, shared by both `value`
// Overloads.
const keyArgumentLabel = "at"

// `hasKey` is the lookup itself: its body is `@::value(at key)::hasValue()`. A
// branch guarded by it that opens with the same `value(at:)` asks twice.
// Reported only for a plain `hasKey` on a name, with a key written alike and no
// call, and the lookup in the branch's first Statement.
function reportRedundantKeyCheck(
	condition: common.typed.ExpressionNode,
	body: Array<common.typed.ImplementationNode>,
): void {
	let check = writtenKeyCheck(condition)
	let first = body[0]

	if (check === null || first === undefined) {
		return
	}

	let lookup = writtenKeyLookup(first, check)

	if (lookup === null) {
		return
	}

	reportWarning("This key is looked up twice", condition.position, {
		code: "redundant-key-check",
		labels: [
			primary(condition.position, "asked here"),
			secondary(lookup.position, "and answered here"),
		],
		notes: [
			"'hasKey' is a lookup of its own — it asks the Dictionary for the key's value and answers whether it found one.",
		],
		helps: [
			"Ask 'value(at:)' once and match its Optional, or use 'value(at:defaultingTo:)' or 'update(at:with:)'.",
		],
	})
}

// The guarded Dictionary's name and the key's spelling, which the branch must
// repeat.
type WrittenKeyCheck = { receiver: string; key: string }

// A condition that is exactly one `hasKey` on a named Dictionary, or null.
function writtenKeyCheck(
	condition: common.typed.ExpressionNode,
): WrittenKeyCheck | null {
	if (
		condition.nodeType !== "MethodInvocation" ||
		condition.member.name !== "hasKey" ||
		condition.base.nodeType !== "Identifier" ||
		refinableBaseTag(condition.base.type) !== "Dictionary" ||
		condition.arguments.length !== 1
	) {
		return null
	}

	let key = writtenKeySpelling(condition.arguments[0]!.value)

	return key === null ? null : { receiver: condition.base.content, key }
}

// How a key was written, as a comparable String, or null for a key that was
// worked out. A literal, a name, a bare Case and a member path of a name read
// alike both times and run nothing.
function writtenKeySpelling(node: common.typed.ExpressionNode): string | null {
	switch (node.nodeType) {
		case "StringValue":
			return `string:${node.value}`
		case "IntegerValue":
			return `integer:${node.value}`
		case "RationalValue":
			return `rational:${node.numerator}/${node.denominator}`
		case "BooleanValue":
			return `boolean:${node.value}`
		case "Identifier":
			return `name:${node.content}`
		case "CaseValue":
			return node.value === null
				? `case:${node.choice?.content ?? ""}#${node.caseName.content}`
				: null
		case "Lookup":
			// A path off a name, so the chain's base is only read.
			if (
				node.base.nodeType !== "Identifier" &&
				node.base.nodeType !== "Lookup"
			) {
				return null
			}

			let base = writtenKeySpelling(node.base)

			return base === null ? null : `${base}.${node.member.content}`
		default:
			return null
	}
}

// The `value(at:)` the guard already asked, found in the Statement's own
// Expressions. Every Node kind is named, because a Function literal's body and
// a Match Handler's are left out on purpose.
function writtenKeyLookup(
	node: common.typed.ImplementationNode,
	check: WrittenKeyCheck,
): common.typed.MethodInvocationNode | null {
	switch (node.nodeType) {
		case "MethodInvocation":
			if (isKeyLookup(node, check)) {
				return node
			}

			return firstWrittenKeyLookup(
				[
					node.base,
					...node.arguments.map((argument) => argument.value),
				],
				check,
			)
		case "FunctionInvocation":
			return firstWrittenKeyLookup(
				[
					node.name,
					...node.arguments.map((argument) => argument.value),
				],
				check,
			)
		case "Lookup":
			return writtenKeyLookup(node.base, check)
		case "Combination":
			return firstWrittenKeyLookup([node.lhs, node.rhs], check)
		case "CaseValue":
			return node.value === null
				? null
				: writtenKeyLookup(node.value, check)
		case "RecordValue":
			return firstWrittenKeyLookup(Object.values(node.members), check)
		case "ListValue":
			return firstWrittenKeyLookup(node.values, check)
		case "DictionaryValue":
			return firstWrittenKeyLookup(
				node.entries.flatMap((entry) => [entry.key, entry.value]),
				check,
			)
		case "InterpolatedStringValue":
			return firstWrittenKeyLookup(
				node.segments.flatMap((segment) =>
					segment.kind === "expression" ? [segment.expression] : [],
				),
				check,
			)
		// The subject is read where the Match stands; its Handlers are bodies.
		case "Match":
			return writtenKeyLookup(node.value, check)
		// A `define` evaluates its first arm's condition unconditionally, or
		// its `otherwise` value without arms. Everything else runs
		// conditionally and is a body here.
		case "Define": {
			let first = node.arms[0]

			return writtenKeyLookup(
				first === undefined ? node.otherwise.value : first.condition,
				check,
			)
		}
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
		case "ExpectStatement":
		case "RequireStatement":
			return writtenKeyLookup(node.value, check)
		case "ReturnStatement":
			return writtenKeyLookup(node.expression, check)
		case "IfStatement":
		case "IfElseStatement":
			return writtenKeyLookup(node.condition, check)
		// Neither keyword opens a body, so the walk carries on through the
		// operand.
		case "Start":
		case "Complete":
			return writtenKeyLookup(node.expression, check)
		// A refused value stops the walk, so no Diagnostic cascades inside
		// refused text.
		case "RefusedValue":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
		case "FunctionValue":
		case "NamespaceDefinitionStatement":
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "FunctionStatement":
			return null
	}
}

function firstWrittenKeyLookup(
	nodes: Array<common.typed.ImplementationNode>,
	check: WrittenKeyCheck,
): common.typed.MethodInvocationNode | null {
	for (let node of nodes) {
		let found = writtenKeyLookup(node, check)

		if (found !== null) {
			return found
		}
	}

	return null
}

// Both `value` Overloads count, the Optional one and the `defaultingTo` one,
// since the guard is redundant either way.
function isKeyLookup(
	node: common.typed.MethodInvocationNode,
	check: WrittenKeyCheck,
): boolean {
	let key = node.arguments[0]

	return (
		node.member.name === "value" &&
		node.base.nodeType === "Identifier" &&
		node.base.content === check.receiver &&
		key !== undefined &&
		key.name === keyArgumentLabel &&
		writtenKeySpelling(key.value) === check.key
	)
}

function enrichReturnStatement(
	node: parser.ReturnStatementNode,
	scope: enricher.Scope,
): common.typed.ReturnStatementNode {
	return {
		nodeType: "ReturnStatement",
		// The nearest declared return Type, the Function's or a Handler's
		// Match's, is the expected Type.
		expression: enrichExpression(
			node.expression,
			scope,
			findExpectedReturnType(scope),
		),
		position: node.position,
	}
}

function enrichFunctionStatement(
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

// A bodied entry of an `overload function` block becomes its own top-level
// Function, named `loop__overload$N` for its index among all the block's
// entries. A native entry keeps its slot, so call sites and native exports
// agree. The name is baked in here and never declared into Scope.
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

		// The hoisted `overloads[index]` as a Function Type, which call sites
		// resolve against.
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

// A name the compiler declared, such as `@` or a builtin, is a bare string with
// no Position to underline.
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

	refuseShadowingAfterRead(identifier, scope)

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
	countTypeDeclaration()

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
	registerProtocol(scope, protocolType)

	return scope
}

function enrichMembers(
	members: Record<string, parser.RecordValueMemberNode>,
	scope: enricher.Scope,
	expectedMemberTypes: Record<string, common.Type> | null = null,
): Record<string, common.typed.ExpressionNode> {
	let result: Record<string, common.typed.ExpressionNode> = {}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		result[memberKey] = enrichMember(
			memberValue,
			scope,
			expectedMemberTypes?.[memberKey] ?? null,
		)
	}

	return result
}

// A shorthand member's value is its own name, read with the flag that says it
// stands in both positions. `asValue` drops a Function's defaults as anywhere
// else. A path key's leaf is read here too.
export function enrichMember(
	member: parser.RecordValueMemberNode,
	scope: enricher.Scope,
	expectedType: common.Type | null,
): common.typed.ExpressionNode {
	// A member without a value is a braced descend, which `pathUpdate` reaches
	// through `stepInto` and never asks for here.
	let value = member.value!

	// A bare path key, reported where its key list was read, reads a binding
	// only where the Scope holds one. Otherwise it is a refused value, so the
	// name is not reported again.
	if (
		member.steps !== undefined &&
		member.shorthand === true &&
		!bindsLastStep(member, scope)
	) {
		return enrichRefusedValue(
			{ nodeType: "RefusedValue", base: value, position: value.position },
			scope,
		)
	}

	if (member.shorthand === true && value.nodeType === "Identifier") {
		return asValue(
			enrichIdentifierExpression(value, scope, { shorthandMember: true }),
		)
	}

	return enrichExpression(value, scope, expectedType)
}

// What the item position of an expected Type wants. Several Lists in a Union
// offer the Union of their item Types. `null` where no arm is a List.
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

// The same for a Record's members, keyed by name. A member offered by several
// arms is their Union.
export function expectedRecordMembers(
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

	// A null prototype, since the keys are source member names, and a member
	// called `toString` would otherwise find the prototype's function.
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

// The frame a native Method's default needs. A native has no body, but a
// default on it is an Essence Expression to enrich and lower; see
// `NativeShimNode`. Its Scope matches a bodied Method's of the same shape.
function enrichNativeShim(
	memberName: string,
	overloadIndex: number | null,
	signature: parser.NativeMethodSignatureNode,
	scope: enricher.Scope,
	selfType: common.Type | null,
	methodType: common.Type | undefined,
	isStatic: boolean,
): common.typed.NativeShimNode | null {
	if (
		!signature.parameters.some(
			(parameter) => parameter.defaultValue !== null,
		)
	) {
		return null
	}

	let newScope = methodScope(signature.generics, scope, selfType, isStatic)

	// `signaturesOf` already drops the receiver Parameter. An Overload block's
	// entry is its numbered slot; any other Method has one entry.
	let resolved = signaturesOf(methodType ?? { type: "Error" })?.[
		overloadIndex ?? 0
	]

	let { parameters } = enrichParameterList(
		signature.parameters,
		newScope,
		resolved?.parameterTypes,
	)

	return {
		nodeType: "NativeShim",
		memberName,
		overloadIndex,
		isStatic,
		parameters,
		// Read off the resolved signature, which the native contract generator
		// counts witness slots from, so frame and contract agree.
		conformances: (resolved?.generics ?? [])
			.filter((generic) => generic.constraint != null)
			.map((generic) => generic.name),
	}
}

function enrichMethods(
	members: parser.NamespaceMethods,
	scope: enricher.Scope,
	selfType: common.Type | null,
	methodTypes: Record<string, common.MethodType>,
	// The constrained Namespace Type Parameters for each fulfilling Method, one
	// list per Overload.
	injectedGenerics: Map<
		string,
		Array<Array<common.typed.GenericDeclarationNode>>
	> = new Map(),
	// The Namespace's own Type Parameters, so a Method's `<…>` is split here as
	// resolution split it.
	namespaceGenerics: Array<common.GenericDeclaration> = [],
): {
	methods: common.typed.Methods
	nativeShims: Array<common.typed.NativeShimNode>
} {
	let result: common.typed.Methods = {}
	let nativeShims: Array<common.typed.NativeShimNode> = []

	let addShim = (shim: common.typed.NativeShimNode | null): void => {
		if (shim !== null) {
			nativeShims.push(shim)
		}
	}

	for (let [memberKey, memberValue] of Object.entries(members)) {
		// A native Method has no body to enrich or emit. It stays in the
		// Namespace Type, and a default on it gets a synthesized frame.
		if (
			memberValue.nodeType === "SimpleMethodSignature" ||
			memberValue.nodeType === "StaticMethodSignature"
		) {
			addShim(
				enrichNativeShim(
					memberKey,
					null,
					memberValue.signature,
					scope,
					selfType,
					methodTypes[memberKey],
					memberValue.nodeType === "StaticMethodSignature",
				),
			)

			continue
		}

		// Typed as the Method, so a Type at the cursor on the name describes
		// the Method.
		let name: common.typed.IdentifierNode = {
			nodeType: "Identifier",
			content: memberKey,
			position: memberValue.name.position,
			type: methodTypes[memberKey] ?? { type: "Unknown" },
		}

		let injected = injectedGenerics.get(memberKey) ?? []
		let own = methodGenericSplits(
			memberValue,
			namespaceGenerics,
			scope,
		).map((split) => split.own)

		if (memberValue.nodeType === "SimpleMethod") {
			result[memberKey] = {
				nodeType: "SimpleMethod",
				name,
				method: enrichMethodFunctionValue(
					memberValue,
					scope,
					selfType,
					injected[0] ?? [],
					own[0] ?? memberValue.method.value.generics,
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
					own[0] ?? memberValue.method.value.generics,
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
					own,
				),
				// Every Overload is bodied, so the indices are the identity.
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
					own,
				),
				overloadIndices: memberValue.methods.map((_, index) => index),
			}
		} else {
			// An Overload block in a `declarations { … }` Program may mix
			// bodied and native entries, and only bodied ones reach the typed
			// Node. Each keeps its original index in `overloadIndices`, which
			// the `__overload$N` name is built from.
			let bodied: Array<parser.FunctionValueNode> = []
			let bodiedIndices: Array<number> = []
			let bodiedInjected: Array<
				Array<common.typed.GenericDeclarationNode>
			> = []
			let bodiedOwn: Array<Array<parser.GenericDeclarationNode>> = []

			let isStatic =
				memberValue.nodeType === "OverloadedStaticMethodSignatures"

			for (let [index, overload] of memberValue.methods.entries()) {
				if (overload.nodeType === "NativeMethodSignature") {
					addShim(
						enrichNativeShim(
							memberKey,
							index,
							overload,
							scope,
							selfType,
							methodTypes[memberKey],
							isStatic,
						),
					)

					continue
				}

				bodied.push(overload)
				bodiedIndices.push(index)
				bodiedInjected.push(injected[index] ?? [])
				bodiedOwn.push(own[index] ?? overload.value.generics)
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
						position: memberValue.position,
						documentation: memberValue.documentation,
					},
					scope,
					selfType,
					bodiedInjected,
					bodiedOwn,
				),
				overloadIndices: bodiedIndices,
			}
		}
	}

	return { methods: result, nativeShims }
}

// A Parameter list and the Statements its Patterns desugar into, which belong
// at the head of the body, as a Matcher's bindings do.
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
	// Built once for the whole list, since every default is barred from the
	// same names. A list without defaults builds nothing.
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

// Every name this Parameter list binds, with what a default may make of each.
// See "Parameter defaults" in DEVELOPMENT.md.
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

		// Exactly the bindings `declarePatternBindings` declares.
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
	// Set for an unannotated Parameter, whose Type and label came from the
	// expected signature.
	contextualParameter?: common.Parameter,
	// The names the list binds and this Parameter's index, so a default is told
	// what it may not read. Null for a list without defaults.
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

	// A Pattern in place of the internal name. The Parameter still needs a name
	// for the Constants to read off. The simplifier's `_0` could collide with a
	// sibling `_: Type`, so one is synthesized from the Pattern's Position.
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
				type,
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

	// `_: Type` binds no name, which makes the Parameter unreferenceable.
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
			type,
			inferredType: node.type === null ? type : null,
			defaultValue,
		},
		bindings: [],
	}
}

// The `= expression` a caller may leave out, read before this Parameter is
// declared and under `parameterDefaultBarrier`. See "Parameter defaults" in
// DEVELOPMENT.md.
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
	// A Function refused as a value is reported where it is written, so it is
	// a hole here.
	let measured = measuredValue(value)

	// A Literal default names only what its Type declares. See "Undeclared
	// members" in packages/compiler/src/helpers/DEVELOPMENT.md.
	let undeclared = undeclaredMembers(type, value).length > 0

	// A written default is admitted by deciding a refinement's predicate, as a
	// written Argument is.
	if (!undeclared && fitsWritten(type, measured)) {
		return value
	}

	// A Record default may be a partial Literal; `Parameter.defaultMembers`
	// records what it leaves out, agreeing with `recordDefaultMembers`. Its
	// written members carry their own evidence for a refinement.
	if (
		!undeclared &&
		type.type === "Record" &&
		valueType.type === "Record" &&
		node.defaultValue.nodeType === "RecordValue" &&
		isPartialOf(type, admittedPartialType(type, valueType, value))
	) {
		return value
	}

	if (
		!typeContainsError(type) &&
		!typeContainsError(valueType) &&
		(undeclared || !matchesType(type, measured.type))
	) {
		let name =
			parameterInternalName(node)?.content ??
			node.externalName?.content ??
			null

		// Not a partial, so a member it does not write is missing and named
		// with the rest.
		let record = recordMismatchEvidence(type, measured.type, value, {
			subject: "the Parameter's Type",
		})

		reportError(
			name === null
				? "This default does not fit its Parameter"
				: `This default does not fit Parameter '${name}'`,
			record.lead?.position ?? node.defaultValue.position,
			{
				code: "default-type-mismatch",
				labels: [
					record.lead ??
						primary(
							node.defaultValue.position,
							`this is ${withArticle(describeType(measured.type))}`,
						),
					...record.labels,
				],
				notes: [
					name === null
						? `The Parameter is ${describeType(type)}.`
						: `Parameter '${name}' is ${describeType(type)}.`,
					...record.notes,
				],
				helps: [
					...record.helps,
					`Write a value of Type ${describeType(type)}.`,
				],
				data: record.data,
			},
		)
	}

	return value
}

// #endregion

// #region Flow Narrowing

// What a condition proves about one binding, and the binding's Type where it
// was asked. The Type comes from the typed receiver, since an enclosing `else`
// may already have narrowed the name.
type ProvenConjuncts = {
	receiverType: common.Type
	conjuncts: Array<common.PredicateConjunct>
}

// Keyed by the name a shadow is declared under: an Identifier's, or `@`.
type ConditionEvidence = Map<string, ProvenConjuncts>

// A binding and the refinement a branch has established for it.
type Narrowing = { name: string; type: common.RefinementType }

// What a condition establishes for the branch it opens. The answer is also
// recorded for coverage, which can not tell later, since refinements are erased
// before the optimiser runs.
function trueBranchNarrowings(
	condition: common.typed.ExpressionNode,
	scope: enricher.Scope,
): Array<Narrowing> {
	return narrowingsFor(conditionEvidence(condition, scope), scope)
}

// The Scope a branch's body is enriched in: a child of the shadows, so the body
// may declare a narrowed name again.
function branchScope(
	narrowings: Array<Narrowing>,
	scope: enricher.Scope,
): enricher.Scope {
	return childScope(scopeShadowing(narrowings, scope))
}

// What a condition establishes for the branch it answered `false` in. A nested
// `else if` is enriched in that Scope, so it adds to the complement.
function falseBranchNarrowings(
	condition: common.typed.ExpressionNode,
	scope: enricher.Scope,
): Array<Narrowing> {
	return narrowingsFor(complementEvidence(condition, scope), scope)
}

// The Scope a branch's shadows are declared in, or the Scope itself when there
// are none. A shadow carries the name's `selfMemberAliases`. See "Narrowing" in
// DEVELOPMENT.md.
function scopeShadowing(
	narrowings: Array<Narrowing>,
	scope: enricher.Scope,
): enricher.Scope {
	if (narrowings.length === 0) {
		return scope
	}

	let narrowScope = childScope(scope)

	for (let narrowing of narrowings) {
		let alias = findDeclaringScope(narrowing.name, scope)
			?.selfMemberAliases?.[narrowing.name]

		if (alias !== undefined) {
			;(narrowScope.selfMemberAliases ??= scopeMap())[narrowing.name] =
				alias
		}

		declareVariableInScope(
			narrowing.name,
			narrowing.type,
			narrowScope,
			true,
		)
	}

	return narrowScope
}

// The evidence a condition hands its true branch, read as a flattened
// conjunction. Nothing here reports, since an `if` asks rather than claims.
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

	let conjunct = resolvedConjunct(condition, args, scope)
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

// The name a receiver may be narrowed under: a Constant, `@`, or a member of
// `@` lent to a Guard. A Variable never narrows. See "Narrowing" in
// DEVELOPMENT.md.
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

// The member names a chain of Lookups reads off `@`, outermost last:
// `@.state.total` gives `["state", "total"]`. Null where it does not start at
// `@`.
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

// The name a member of `@` is lent to, or null for an ordinary member. Nearest
// Scope first, stopping at the Scope that binds this `@`.
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
			// The whole path, so `@.x` does not answer with a nested `origin.x`
			// binding.
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

// The refinements a branch's evidence establishes. See "Choosing a refinement"
// in DEVELOPMENT.md.
function narrowingsFor(
	evidence: ConditionEvidence,
	scope: enricher.Scope,
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
		// An Error matches every Type, so a poisoned binding establishes
		// nothing.
		if (typeContainsError(proven.receiverType)) {
			continue
		}

		// Evidence the binding's Type already carries counts, closed over what
		// all the leaves imply together.
		let keys = impliedConjunctKeys(
			proven.receiverType.type === "Refinement"
				? [...proven.conjuncts, ...provenConjuncts(proven.receiverType)]
				: proven.conjuncts,
			proven.receiverType,
		)

		let established: common.RefinementType | null = null

		for (let refinement of refinementsFor(declared, proven.receiverType)) {
			if (
				!matchesType(refinement.base, proven.receiverType) ||
				// The shadow must flow into the binding's Type, so it forgets
				// nothing the Type already proves.
				!matchesType(proven.receiverType, refinement) ||
				!provenConjuncts(refinement).every((conjunct) =>
					keys.has(predicateConjunctKey(conjunct)),
				)
			) {
				continue
			}

			// The refinement answering the most implied questions wins, and on
			// a tie the one walked first stands. The tie only decides the name
			// Hover prints.
			if (
				established === null ||
				impliedConjunctKeys(
					provenConjuncts(refinement),
					refinement.base,
				).size >
					impliedConjunctKeys(
						provenConjuncts(established),
						established.base,
					).size
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

// The refinements declared in scope. A `generic` one stands for nothing until a
// receiver decides its Type Arguments.
type RefinementCandidates = {
	concrete: Array<common.RefinementType>
	generic: Array<common.GenericAliasType>
}

// Every refinement a Type name in scope stands for, nearest Scope first, an
// inner name shadowing an outer one. Generic refined Aliases are collected in
// the same walk.
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
		for (let name in current.types) {
			if (seen.has(name)) {
				continue
			}

			seen.add(name)

			let type = current.types[name]!

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

// The candidates one receiver could establish: the concrete ones, and every
// generic one this receiver instantiates.
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

// The refinement a generic Alias stands for at this receiver, with the applied
// spelling stamped on. A unification that leaves a Type Parameter undecided is
// no candidate. See "Choosing a refinement" in DEVELOPMENT.md.
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
			// Every Type Parameter binds, since an Alias applies its Parameters
			// and a receiver is what they are worked out from here.
			bindableNames: new Set(
				alias.generics.map((generic) => generic.name),
			),
			bindings,
		}) ||
		alias.generics.some((generic) => !bindings.has(generic.name))
	) {
		return null
	}

	// Remembered per Alias and receiver, after the cheap unification, so a
	// receiver gets the same object each time. A pending predicate is never
	// remembered.
	let remembered =
		refinement.conjuncts === null
			? undefined
			: (instantiatedRefinementMemos.get(alias) ?? {
					byType: new WeakMap<common.Type, common.RefinementType>(),
					bySpelling: new Map<string, common.RefinementType>(),
				})
	let spelling: string | null = null

	if (remembered !== undefined) {
		instantiatedRefinementMemos.set(alias, remembered)

		let answer = remembered.byType.get(receiverType)

		if (answer !== undefined) {
			return answer
		}

		if (spellingIdentifies(receiverType)) {
			spelling = describeType(receiverType)
			answer = remembered.bySpelling.get(spelling)

			if (answer !== undefined) {
				return answer
			}
		}
	}

	let instantiated = applyGenericBindings(refinement, bindings)

	// An unchanged substitution is the declared object, whose base names the
	// Alias' own Parameters. The stamp goes through
	// `refinementWithTypeArguments`, like every refinement copy.
	if (instantiated.type !== "Refinement" || instantiated === refinement) {
		return null
	}

	let stamped = refinementWithTypeArguments(
		instantiated,
		alias.generics.map(
			(generic) => bindings.get(generic.name) ?? { type: "Error" },
		),
	)

	if (remembered !== undefined) {
		if (spelling === null) {
			remembered.byType.set(receiverType, stamped)
		} else {
			remembered.bySpelling.set(spelling, stamped)
		}
	}

	return stamped
}

// Remembered by spelling where the spelling identifies the Type, and by
// identity otherwise, since a name may be declared twice and print alike.
type RefinementInstantiations = {
	byType: WeakMap<common.Type, common.RefinementType>
	bySpelling: Map<string, common.RefinementType>
}

let instantiatedRefinementMemos = new WeakMap<
	common.GenericAliasType,
	RefinementInstantiations
>()

// Whether `describeType` tells this Type apart from every other: scalars, and
// Lists and Dictionaries of them.
function spellingIdentifies(type: common.Type): boolean {
	switch (type.type) {
		case "Integer":
		case "Rational":
		case "String":
		case "Boolean":
			return true
		case "List":
			return spellingIdentifies(type.itemType)
		// Both slots, since `describeType` prints both.
		case "Dictionary":
			return (
				spellingIdentifies(type.keyType) &&
				spellingIdentifies(type.valueType)
			)
		default:
			return false
	}
}

// The conjunction Types written receivers were given, keyed by base, conjuncts
// and name, so equal proofs share one object. Hung off the Module's root Scope,
// so it lives only as long as the Module.
let literalReceiverConjunctions = new WeakMap<
	enricher.Scope,
	Map<string, common.RefinementType>
>()

// The Scope with no parent, which `topLevelScope` builds per Module.
function rootScopeOf(scope: enricher.Scope): enricher.Scope {
	let current = scope

	while (current.parent !== null) {
		current = current.parent
	}

	return current
}

// What a written receiver proves about itself: the conjunction of every
// refinement in scope that admits it. See "Written receivers" in
// DEVELOPMENT.md.
function refinedLiteralReceiverType(
	base: common.typed.ExpressionNode,
	scope: enricher.Scope,
): common.RefinementType | null {
	if (erasingRefinementProof) {
		return null
	}

	// Remembered per Scope and written value; see `remembersRefinedReceivers`.
	// A written List is not remembered, since its item Type is part of the
	// question.
	let key = writtenReceiverKey(base)

	if (key === null) {
		return provenLiteralReceiverType(base, scope)
	}

	let answers = remembersRefinedReceivers(scope)

	if (answers.has(key)) {
		return answers.get(key) ?? null
	}

	let answer = provenLiteralReceiverType(base, scope)

	answers.set(key, answer)

	return answer
}

// This Scope's answers, dropped whenever a Type is declared anywhere, so no
// answer outlives its candidates.
function remembersRefinedReceivers(
	scope: enricher.Scope,
): Map<string, common.RefinementType | null> {
	let declarations = typeDeclarationCount()
	let remembered = refinedReceiverAnswers.get(scope)

	if (remembered === undefined || remembered.declarations !== declarations) {
		remembered = { declarations, answers: new Map() }
		refinedReceiverAnswers.set(scope, remembered)
	}

	return remembered.answers
}

let refinedReceiverAnswers = new WeakMap<
	enricher.Scope,
	{
		declarations: number
		answers: Map<string, common.RefinementType | null>
	}
>()

// The written value as a key, with its kind, since an already refined receiver
// is a different question. Null takes the value off the memo.
function writtenReceiverKey(base: common.typed.ExpressionNode): string | null {
	switch (base.nodeType) {
		case "IntegerValue":
			return base.type.type === "Integer" ? `I${base.value}` : null
		case "RationalValue":
			return base.type.type === "Rational"
				? `R${base.numerator}/${base.denominator}`
				: null
		case "StringValue":
			return base.type.type === "String" ? `S${base.value}` : null
		case "BooleanValue":
			return `B${base.value}`
		default:
			return null
	}
}

function provenLiteralReceiverType(
	base: common.typed.ExpressionNode,
	scope: enricher.Scope,
): common.RefinementType | null {
	let admits = admissionOfWrittenValue(base)

	if (admits === null) {
		return null
	}

	let declared = refinementCandidatesInScope(scope)

	if (declared.concrete.length === 0 && declared.generic.length === 0) {
		return null
	}

	let admitted: Array<common.RefinementType> = []
	let proven = new Set<string>()

	for (let refinement of refinementsFor(declared, base.type)) {
		// A predicate not read yet is no candidate. This runs while
		// declarations hoist, where throwing would escape the hoisting round.
		if (refinement.conjuncts !== null && admits(refinement)) {
			admitted.push(refinement)

			for (let conjunct of refinement.conjuncts) {
				proven.add(predicateConjunctKey(conjunct))
			}
		}
	}

	// One admitted refinement is the conjunction itself.
	if (admitted.length <= 1) {
		return admitted[0] ?? null
	}

	// A refinement whose implied keys cover the whole conjunction names it:
	// `PositiveInteger` covers the three refinements `3` is admitted into.
	let named = admitted.find((refinement) => {
		let implied = impliedConjunctKeys(
			provenConjuncts(refinement),
			refinement.base,
		)

		return (
			implied.size >= proven.size &&
			[...proven].every((key) => implied.has(key))
		)
	})

	if (named !== undefined) {
		return named
	}

	let conjuncts = canonicalPredicateConjuncts(
		admitted.flatMap(provenConjuncts),
	)
	let name = `${describeType(base.type)} where ${describePredicate({
		type: "Refinement",
		name: "",
		base: base.type,
		conjuncts,
	})}`
	let conjunction: common.RefinementType = {
		type: "Refinement",
		name,
		base: base.type,
		conjuncts,
		receiverConjunction: true,
	}

	// Remembered only where the base's spelling identifies it, since the key is
	// a spelling.
	if (!spellingIdentifies(base.type)) {
		return conjunction
	}

	let root = rootScopeOf(scope)
	let byKey = literalReceiverConjunctions.get(root)

	if (byKey === undefined) {
		byKey = new Map()
		literalReceiverConjunctions.set(root, byKey)
	}

	let key = `${name}${conjuncts.map(predicateConjunctKey).join("")}`
	let remembered = byKey.get(key)

	if (remembered === undefined) {
		remembered = conjunction
		byKey.set(key, remembered)
	}

	return remembered
}

// The receiver Node carrying what it proved about itself. Only written values
// and a Dictionary update are refined; every other Expression comes back
// untouched. See "Written receivers" in DEVELOPMENT.md.
function writtenReceiver(
	base: common.typed.ExpressionNode,
	scope: enricher.Scope,
): common.typed.ExpressionNode {
	let refinement = refinedLiteralReceiverType(base, scope)

	if (refinement === null) {
		return base
	}

	switch (base.nodeType) {
		case "IntegerValue":
			return { ...base, type: refinement }
		case "RationalValue":
			return { ...base, type: refinement }
		case "StringValue":
			return { ...base, type: refinement }
		case "ListValue":
			return { ...base, type: refinement }
		case "DictionaryValue":
			return { ...base, type: refinement }
		case "Combination":
			return { ...base, type: refinement }
		default:
			return base
	}
}

// `a::and(b)`, the one Expression a condition is read through.
function isConjunction(condition: common.typed.MethodInvocationNode): boolean {
	return (
		condition.namespace.name === "Boolean" &&
		condition.member.name === "and" &&
		condition.arguments.length === 1
	)
}

// What a condition answering `false` proves, readable only for a single
// question. A conjunction is refused here, since `collectConditionEvidence`
// drops leaves it can not read and `d::isNot(0)::and(flag)` would look like one
// question.
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
		complemented.set(name, {
			receiverType: proven.receiverType,
			// The opposite of a leaf is the leaf with its polarity flipped. A
			// conjunct is stored resolved, so contrary Methods are one leaf in
			// two polarities: the false branch of `if n::isZero()` proves
			// `NonZeroInteger`.
			conjuncts: [negatedPredicateConjunct(proven.conjuncts[0]!)],
		})
	}

	return complemented
}

// The Type of `@` in a Match Handler: the Matcher's, unless a declared
// refinement says more given the values earlier Handlers named. See "Match
// Handlers and Guards" in DEVELOPMENT.md.
function refinedSelfType(
	matcher: common.Type,
	namedAbove: Array<common.PredicateConjunct>,
	literal: common.typed.ExpressionNode | null,
	scope: enricher.Scope,
): common.Type {
	let proven = namedAbove.map(negatedPredicateConjunct)
	let named = literal === null ? null : namedValueConjunct(literal)

	if (named !== null) {
		proven.push(named)
	}

	if (proven.length === 0) {
		return matcher
	}

	// The machinery an `if` narrows through, so the wrong base, an Error or an
	// Unknown wildcard establishes nothing here either.
	let narrowings = narrowingsFor(
		new Map([["@", { receiverType: matcher, conjuncts: proven }]]),
		scope,
	)

	return narrowings[0]?.type ?? matcher
}

// The question a literal Matcher asks, as a conjunct: `case 0` is `@::is(0)`.
// Integer and String only, the literals a `match` admits, where `anyIs` answers
// exactly what the Namespace's `is` does.
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
				args: [argument],
				negated: false,
			}
}

// #endregion

// #region Body Return Type Inference

// Every `<-` the body reaches, skipping nested Function literals, which return
// from themselves.
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

// One `<-` gives its Type, several the Union of the distinct ones.
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

// How many inference passes are running, nested literals included. See "Return
// Type inference from a body" in DEVELOPMENT.md.
let inferReturnTypeFromBodyDepth = 0

// The codes this pass causes by reading without an expected Type, which the
// real pass silences. See "Return Type inference from a body" in
// DEVELOPMENT.md.
const undecidedWithoutAReturnType: ReadonlySet<common.DiagnosticCode> = new Set(
	["ambiguous-case", "undecided-type-arguments"],
)

// Infers a Function literal's return Type by enriching its body, with the
// Diagnostics dropped. See "Return Type inference from a body" in
// DEVELOPMENT.md.
export function inferReturnTypeFromBody(
	node: parser.FunctionDefinitionNode,
	parameterTypes: Array<common.Parameter>,
	scope: enricher.Scope,
	// Set where the body has errors of its own, so the caller does not restate
	// them as an unreadable return Type.
	refused?: { body: boolean },
): common.Type | null {
	inferReturnTypeFromBodyDepth += 1

	try {
		let { result, diagnostics } = collectDiagnostics(() => {
			let inferenceScope = childScope(scope)

			// Declared as the real pass declares them, so Pattern bindings are
			// in scope. The bindings themselves are discarded.
			enrichParameterList(node.parameters, inferenceScope, parameterTypes)

			// Null rather than unset, so the search does not walk out to the
			// enclosing Function's return Type. A bare Case after `<-`
			// therefore stays unresolved.
			inferenceScope.expectedReturnType = null

			// The same barrier for asynchrony, so the enclosing body's is not
			// consulted.
			inferenceScope.completing = null

			let types: Array<common.Type> = []

			collectReturnedTypes(
				node.body.flatMap((bodyNode) =>
					enrichNode(bodyNode, inferenceScope),
				),
				types,
			)

			// An Error among the returned Types answers the hole. A body with
			// no `<-` answers null, and the validator reports the missing
			// return.
			if (types.some((type) => type.type === "Error")) {
				return { type: "Error" as const }
			}

			let answer: common.Type | null = unionOfTypes(types)

			// A completing body's `<-` answers the value, so the return Type
			// wraps it: `(url) { <- complete headline(url) }` is `(_: String)
			// -> Future<String>`.
			return answer === null || node.completing !== true
				? answer
				: { type: "Future" as const, valueType: answer }
		})

		// Errors here will be reported by the real pass, which is what
		// `refused` says. The codes this pass causes itself are left out.
		if (
			refused !== undefined &&
			containsErrors(
				diagnostics.filter(
					(diagnostic) =>
						!undecidedWithoutAReturnType.has(diagnostic.code),
				),
			)
		) {
			refused.body = true
		}

		// An Error this pass raised itself, as a bare Case it could not resolve
		// does, answers null. Any other was reported where it was written.
		return result?.type === "Error" && containsErrors(diagnostics)
			? null
			: result
	} finally {
		inferReturnTypeFromBodyDepth -= 1
	}
}

// #endregion

// #region Invocation, contextual Function & CaseValue resolution

// A written List, Dictionary or Record literal's Node with the Type a call
// decided for its Parameter, or null. A Node built from other Nodes keeps their
// Types, and a name keeps what its Declaration decided.
function decidedLiteralNode(
	node: common.typed.ExpressionNode,
	decided: common.Type,
): common.typed.ExpressionNode | null {
	if (node.nodeType === "ListValue" && decided.type === "List") {
		return { ...node, type: decided }
	}

	if (node.nodeType === "DictionaryValue" && decided.type === "Dictionary") {
		return { ...node, type: decided }
	}

	if (node.nodeType === "RecordValue" && decided.type === "Record") {
		return { ...node, type: decided }
	}

	return null
}

// Enriches each Argument value at most once per Invocation, reusing the typed
// Node for every overload probe and the final Node. A Function literal without
// annotations is re-resolved per probe and built from the winner's recording.
export type ArgumentTyper = {
	getType: (
		value: parser.ExpressionNode,
		expectedType: common.Type,
		bindings?: GenericBindings | null,
		declaredType?: common.Type,
	) => common.Type
	enrichArgumentNode: (
		argument: parser.ArgumentNode,
	) => common.typed.ArgumentNode
	// The enriched value of one Argument, from the same cache. A candidate may
	// need to see what was written, such as a Record Literal with path keys.
	enrichedArgumentValue: (
		value: parser.ExpressionNode,
	) => common.typed.ExpressionNode
	// Whether any Argument typed as Error. An Error matches anything and leaves
	// a Type Parameter unbound, so this is asked before reporting one as
	// uninferable.
	hasErrorArgument: () => boolean
	// Runs `probe` with that answer held aside. An Argument may be an Error
	// under one candidate only; `noteErrorArgument` hands the committed one's
	// back.
	probeErrorArguments: <Result>(probe: () => Result) => {
		result: Result
		sawErrorArgument: boolean
	}
	noteErrorArgument: () => void
	// Writes the Type a finished call decided onto a written container Literal
	// at that Parameter; see `decideWrittenArguments`.
	decideArgument: (value: parser.ExpressionNode, decided: common.Type) => void
	// What the position around the Invocation asks it to be, or null. Read by
	// `decidedSeedBindings`, for a Type Parameter the Arguments left open, such
	// as `List<Unknown>` from `startingWith []`, and by `namespaceCallHelps`.
	expectedType: common.Type | null
}

function makeArgumentTyper(
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
): ArgumentTyper {
	let cache = new Map<parser.ExpressionNode, common.typed.ExpressionNode>()
	let admissions = new Map<
		parser.ExpressionNode,
		Map<string, common.Type | null>
	>()
	let sawErrorArgument = false

	// A value holding an Error anywhere counts, as `Colr | Integer` does. A
	// Function literal counts where its body was refused, which types its
	// return as an Error. Only the return position counts, since an Error
	// elsewhere was not reported about this Argument.
	function noteErrors(type: common.Type): common.Type {
		if (
			type.type === "Function"
				? type.returnType.type === "Error"
				: typeContainsError(type)
		) {
			sawErrorArgument = true
		}

		return type
	}

	// A Record Literal Argument merges into the Parameter's default, so it may
	// carry path keys.
	function enrichOnce(
		value: parser.ExpressionNode,
	): common.typed.ExpressionNode {
		let cached = cache.get(value)

		if (cached === undefined) {
			cached =
				value.nodeType === "RecordValue"
					? enrichRecordValue(value, scope, null, true)
					: enrichExpression(value, scope)
			cache.set(value, cached)
		}

		return cached
	}

	// The Type this written value is admitted at, kept per position spelling,
	// since each candidate asks again. The spelling includes Type Arguments,
	// because `NonEmptyList<Integer>` and `NonEmptyList<String>` are different
	// questions. Two refinements spelled alike, from two Modules in one
	// Overload, would share an answer; the validator asks the committed call
	// again.
	function admitted(
		value: parser.ExpressionNode,
		expectedType: common.Type,
	): common.Type | null {
		if (!refinementInside(expectedType)) {
			return null
		}

		let bySpelling = admissions.get(value)

		if (bySpelling === undefined) {
			bySpelling = new Map()
			admissions.set(value, bySpelling)
		}

		let spelling = describeType(expectedType)

		if (!bySpelling.has(spelling)) {
			bySpelling.set(
				spelling,
				admittedTypeOf(expectedType, enrichOnce(value)),
			)
		}

		return bySpelling.get(spelling) ?? null
	}

	// What one candidate's Parameter Type makes of a Case construction,
	// recording the position it decided. See "Arguments that read their
	// position" in DEVELOPMENT.md.
	function probedCaseValueType(
		node: parser.CaseValueNode,
		expectedType: common.Type,
		bindings: GenericBindings | null,
	): common.Type {
		let payload = makePayloadReadings(node, scope)
		let { result } = collectDiagnostics(() =>
			resolveCaseValueType(node, scope, expectedType, payload.valueUnder),
		)
		let payloadDecides = node.choice === null && node.value !== null

		if (result.type === "Case") {
			// A Case still carrying `choiceGenerics` is the declared one, which
			// the position did not decide.
			if (
				mentionsUnsolvedTypeParameter(result) ||
				result.choiceGenerics !== undefined
			) {
				return payloadDecides
					? payloadDecidedCaseType(node, payload)
					: { type: "Error" }
			}

			// Read under what this candidate decided, as the real enrichment
			// will. Arm selection may already have read it.
			let payloadType = payload.typeUnder(result)
			let fits =
				payloadType === null ||
				payloadFitsCase(result, payloadType, payload.valueUnder(result))

			// A prefixed form is recorded even where its payload does not fit.
			// A bare form is not, since the enrichment would read the recording
			// back and let a candidate it does not fit decide it.
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

	// What one candidate's Parameter Type makes of a member path. See
	// "Arguments that read their position" in DEVELOPMENT.md.
	function probedMemberPathType(
		node: parser.MemberPathNode,
		expectedType: common.Type,
		bindings: GenericBindings | null,
	): common.Type {
		let rootType = memberPathRootType(expectedType)

		if (rootType === null) {
			return { type: "Error" }
		}

		let { result: stepTypes } = collectDiagnostics(() =>
			memberPathStepTypes(node, rootType, scope),
		)
		let returnType = stepTypes[stepTypes.length - 1] ?? { type: "Error" }

		// A path stopped by a Type Parameter the call has not decided keeps
		// that reading, which the Error answered here would otherwise bind.
		let kept = stopsAtUndecidedStep(rootType, stepTypes) ? null : bindings

		recordContextualMemberPathType(node, { expectedType, bindings: kept })

		if (stepTypes.some((stepType) => stepType.type === "Error")) {
			return { type: "Error" }
		}

		return memberPathSignature(rootType, returnType)
	}

	// What the payload alone makes of a bare construction, read silently and
	// kept nowhere, so no probe enriches the committed Node early. A Type
	// Parameter it leaves open answers an Error.
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

	let typer: ArgumentTyper = {
		expectedType,
		getType(value, expectedType, bindings = null, declaredType) {
			// A Function literal without annotations is resolved fresh per
			// probe. `resolveFunctionDefinitionType` records the resolution and
			// its position for the final Node.
			if (
				value.nodeType === "FunctionValue" &&
				needsContext(value.value)
			) {
				return noteErrors(
					readingArgumentLiteral(value.value, () =>
						resolveFunctionDefinitionType(
							value.value,
							scope,
							expectedType,
							bindings,
							declaredType,
						),
					),
				)
			}

			// A Case construction reads its position too. See "Arguments that
			// read their position" in DEVELOPMENT.md.
			if (value.nodeType === "CaseValue") {
				return noteErrors(
					probedCaseValueType(value, expectedType, bindings),
				)
			}

			// So does a member path. Asked silently; the enrichment reports
			// under the committed candidate.
			if (value.nodeType === "MemberPath") {
				return noteErrors(
					probedMemberPathType(value, expectedType, bindings),
				)
			}

			let type = noteErrors(enrichOnce(value).type)

			// A written value where a refinement stands is admitted by deciding
			// the predicate, so `3` answers as a NonZeroInteger. The Node keeps
			// its own Type, so a losing candidate leaves nothing behind.
			// Skipped while the caller's proof is erased.
			if (!erasingRefinementProof) {
				let asked = admitted(value, expectedType)

				if (asked !== null) {
					return asked
				}
			}

			return erasingRefinementProof ? withoutRefinement(type) : type
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
		enrichedArgumentValue(value) {
			return enrichOnce(value)
		},
		decideArgument(value, decided) {
			let enriched = cache.get(value)

			// A Parameter Type mentioning the call's own unsolved Type
			// Parameters is no decision, and must not be written onto a Node.
			if (
				enriched === undefined ||
				mentionsUnsolvedTypeParameter(decided)
			) {
				return
			}

			let type = resolveUnknownSlots(enriched.type, decided)

			if (type === enriched.type) {
				return
			}

			let node = decidedLiteralNode(enriched, type)

			if (node === null) {
				return
			}

			// Written through the probe recordings, so a losing candidate
			// leaves nothing on a Node the winner reads.
			recordDecidedArgument(() => {
				cache.set(value, node)
			})
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

	return typerRefusingErrorPlaces(typerReadingLiteralBodies(scope, typer))
}

// A Function literal's Type. A fully annotated one is a plain signature. An
// omitted annotation is worked out from the expected Type or the body, and
// recorded per Node for the enrichment pass to read back.
function resolveFunctionDefinitionType(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
	bindings: GenericBindings | null = null,
	// The Parameter's Type as declared, whose return shape a `<-` is held to.
	declaredType: common.Type | null = null,
): common.FunctionType {
	if (!needsContext(node)) {
		return resolveFunctionSignatureType(node, scope)
	}

	// A reading where no Function was expected decides nothing, and what it
	// reported may have been dropped with a probe, so it is read again.
	if (expectedType === null) {
		let recorded = recordedContextualFunctionType(node)

		if (recorded !== undefined && recorded.expectedType !== null) {
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
		documentation: resolvedDocumentation(
			node.documentation,
			node.parameters,
		),
	}

	recordContextualFunctionType(node, {
		resolved,
		expectedType: expectedFunction,
		bindings,
		declaredReturn:
			declaredType?.type === "Function" ? declaredType.returnType : null,
	})

	return resolved
}

// One Invocation inferred against one signature. `unboundGenerics` are the Type
// Parameters nothing bound, substituted as Error in `returnType` and reported
// once a candidate is selected.
type InferredInvocation = {
	returnType: common.Type
	unboundGenerics: Array<string>
	// What each Type Parameter was bound to, read for the winner's
	// conformances.
	bindings: GenericBindings
	// The Parameters this call wrote no Argument for, indexed over the full
	// signature, receiver included, as the simplifier emits Arguments.
	omittedParameterIndices: Array<number>
}

// Matches the Arguments left to right against a signature, binding `infer` Type
// Parameters on first occurrence. Undefined when they do not match. A fresh
// context per call keeps bindings from leaking between candidates.
function inferInvocation(
	signature: common.BaseFunction,
	matchableArguments: Array<MatchableArgument>,
	typer: ArgumentTyper,
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

	// Asked even of a failed match, since an undecided seed can be why it
	// failed. `[[]]::append([1])` must decide the item Type rather than be
	// measured against it. See `invocationWithDecidedSeeds`.
	let decided = invocationWithDecidedSeeds(
		signature,
		parameterTypes,
		context,
		freshToOriginal,
		matchableArguments,
		typer,
	)

	if (decided !== undefined) {
		return decided
	}

	if (matched.type !== "Match") {
		return undefined
	}

	return substituteInferredReturnType(
		signature,
		unfreshenBindings(context.bindings, freshToOriginal),
		matched.omittedParameterIndices,
	)
}

// The Type Parameters this call bound to a Type with an undecided slot, as an
// empty seed does. See "Seeds an Invocation decides" in DEVELOPMENT.md.
function undecidedBindingNames(
	context: GenericInferenceContext,
): Set<common.GenericName> {
	let undecided = new Set<common.GenericName>()

	for (let [name, type] of context.bindings) {
		if (typeContainsUnknown(type)) {
			undecided.add(name)
		}
	}

	return undecided
}

// This call's bindings with the slots its Arguments left open filled from the
// position, the checked Arguments and literal bodies, or null. See "Seeds an
// Invocation decides" in DEVELOPMENT.md.
function decidedSeedBindings(
	signature: common.BaseFunction,
	parameterTypes: common.BaseFunction["parameterTypes"],
	context: GenericInferenceContext,
	freshToOriginal: Map<common.GenericName, common.GenericName>,
	matchableArguments: Array<MatchableArgument>,
	expectedType: common.Type | null,
): GenericBindings | null {
	let undecided = undecidedBindingNames(context)

	if (undecided.size === 0) {
		return null
	}

	// What the Arguments did decide, under freshened names, substituted into
	// the Types while the open Parameters stay standing.
	let settled: GenericBindings = new Map()

	for (let [name, type] of context.bindings) {
		if (!undecided.has(name)) {
			settled.set(name, type)
		}
	}

	let decisions: GenericBindings = new Map()

	// One unification, bindable over only the open Parameters. A failed one
	// decides nothing.
	let decideFrom = (declared: common.Type, answer: common.Type): void => {
		let open = new Set(
			[...undecided].filter((name) => !decisions.has(name)),
		)

		if (open.size === 0) {
			return
		}

		// An anonymous Union answer is unified branch by branch, since a Union
		// is not one Type. A branch the declared Type can not be read against
		// is skipped.
		let anonymous =
			answer.type === "UnionType" &&
			answer.name === undefined &&
			answer.alias === undefined
		let candidates = new Map<common.GenericName, Array<common.Type>>()

		for (let branch of anonymous
			? (answer as common.UnionType).types
			: [answer]) {
			let probe: GenericInferenceContext = {
				bindableNames: open,
				bindings: new Map(),
			}

			if (
				!matchesTypeWithBindings(
					applyGenericBindings(declared, settled),
					branch,
					probe,
				)
			) {
				continue
			}

			for (let [name, candidate] of probe.bindings) {
				candidates.set(name, [
					...(candidates.get(name) ?? []),
					candidate,
				])
			}
		}

		// The branches' findings join as a Union, which `resolveUnknownSlots`
		// weighs slot by slot.
		for (let [name, found] of candidates) {
			let bound = context.bindings.get(name)

			if (bound === undefined) {
				continue
			}

			let filled = resolveUnknownSlots(bound, buildUnion(found))

			if (filled !== bound) {
				decisions.set(name, filled)
			}
		}
	}

	if (expectedType !== null) {
		// The return Type under this call's freshened names.
		let rename: GenericBindings = new Map()

		for (let [fresh, original] of freshToOriginal) {
			rename.set(original, { type: "GenericUse", name: fresh })
		}

		decideFrom(
			applyGenericBindings(signature.returnType, rename),
			expectedType,
		)
	}

	let argumentFor = argumentsByParameter(parameterTypes, matchableArguments)
	let waitsOnAnOpenParameter = (type: common.Type): boolean =>
		decisions.size < undecided.size &&
		[...genericNamesMentioned(type)].some(
			(name) => undecided.has(name) && !decisions.has(name),
		)

	// The Arguments checked against an open Parameter rather than binding it.
	// An undecided slot accepts every check, so what they say is read here.
	for (let [index, parameter] of parameterTypes.entries()) {
		let argument = argumentFor(index)

		if (
			parameter.type.type === "Function" ||
			argument === undefined ||
			!waitsOnAnOpenParameter(parameter.type)
		) {
			continue
		}

		decideFrom(
			applyGenericBindings(parameter.type, settled),
			argument.getType(
				applyGenericBindings(parameter.type, context.bindings),
				context.bindings,
			),
		)
	}

	// The bindings so far, so a body is read with what is already decided.
	let bindingsSoFar = (): GenericBindings => {
		let bindings = new Map(context.bindings)

		for (let [name, type] of decisions) {
			bindings.set(name, type)
		}

		return bindings
	}

	// Rounds, because one body may decide a second Type Parameter only once a
	// first is decided. A round that decides nothing ends the loop.
	let decidedBefore = -1

	while (decisions.size > decidedBefore && decisions.size < undecided.size) {
		decidedBefore = decisions.size

		for (let [index, parameter] of parameterTypes.entries()) {
			let argument = argumentFor(index)

			if (
				parameter.type.type !== "Function" ||
				argument === undefined ||
				!waitsOnAnOpenParameter(parameter.type.returnType)
			) {
				continue
			}

			// Read against the Parameter Types as the seed left them, with the
			// return Type left unsolved, so `resolveContextualReturnType` reads
			// the body.
			let bindings = bindingsSoFar()
			let substituted = applyGenericBindings(parameter.type, bindings)
			let open = applyGenericBindings(parameter.type, settled)

			if (substituted.type !== "Function" || open.type !== "Function") {
				continue
			}

			// Silent, since the return Type is held open on purpose and no
			// reading commits to it. The kept readings report for themselves.
			let { result: answered } = collectDiagnostics(() =>
				argument.getType(
					{ ...substituted, returnType: open.returnType },
					bindings,
				),
			)

			if (answered.type === "Function") {
				decideFrom(open.returnType, answered.returnType)
			}
		}
	}

	if (decisions.size === 0) {
		return null
	}

	let decided = new Map(context.bindings)

	for (let [name, type] of decisions) {
		decided.set(name, type)
	}

	return unfreshenBindings(decided, freshToOriginal)
}

// The Invocation matched a second time with the open slots decided, or
// undefined. See "Seeds an Invocation decides" in DEVELOPMENT.md.
function invocationWithDecidedSeeds(
	signature: common.BaseFunction,
	parameterTypes: common.BaseFunction["parameterTypes"],
	context: GenericInferenceContext,
	freshToOriginal: Map<common.GenericName, common.GenericName>,
	matchableArguments: Array<MatchableArgument>,
	typer: ArgumentTyper,
): InferredInvocation | undefined {
	// An Error Argument seen here belongs to the decision, and counts only if
	// the second match is kept.
	let { result, sawErrorArgument } = typer.probeErrorArguments(() => {
		// Under a recording of its own, which is dropped. The match the call
		// keeps records its own positions.
		let { result: decided } = probeContextualFunctionTypes(() =>
			decidedSeedBindings(
				signature,
				parameterTypes,
				context,
				freshToOriginal,
				matchableArguments,
				typer.expectedType,
			),
		)

		if (decided === null) {
			return undefined
		}

		let second = createFreshenedInference(signature)

		for (let [fresh, original] of second.freshToOriginal) {
			let type = decided.get(original)

			if (type !== undefined) {
				second.context.bindings.set(fresh, type)
			}
		}

		let { result, recording } = probeContextualFunctionTypes(() =>
			collectDiagnostics(() =>
				matchArguments(second.parameterTypes, matchableArguments, {
					inference: second.context,
				}),
			),
		)

		// A second match that fails leaves the first one's answer standing.
		if (result.result.type !== "Match") {
			return undefined
		}

		commitContextualFunctionTypes(recording)

		for (let diagnostic of result.diagnostics) {
			report(diagnostic)
		}

		decideWrittenArguments(
			second.parameterTypes,
			second.context,
			matchableArguments,
		)

		return substituteInferredReturnType(
			signature,
			unfreshenBindings(second.context.bindings, second.freshToOriginal),
			result.result.omittedParameterIndices,
		)
	})

	if (result !== undefined && sawErrorArgument) {
		typer.noteErrorArgument()
	}

	return result
}

// The decision written onto Argument Nodes written as container literals, so
// the validator's re-match agrees. A name keeps its Declaration's Type. See
// "Seeds an Invocation decides" in DEVELOPMENT.md.
function decideWrittenArguments(
	parameterTypes: common.BaseFunction["parameterTypes"],
	context: GenericInferenceContext,
	matchableArguments: Array<MatchableArgument>,
): void {
	let argumentFor = argumentsByParameter(parameterTypes, matchableArguments)

	for (let [index, parameter] of parameterTypes.entries()) {
		argumentFor(index)?.decide?.(
			applyGenericBindings(parameter.type, context.bindings),
		)
	}
}

// The Argument at each Parameter, or undefined where the call wrote none or its
// Arguments could not be paired.
function argumentsByParameter(
	parameterTypes: common.BaseFunction["parameterTypes"],
	matchableArguments: Array<MatchableArgument>,
): (index: number) => MatchableArgument | undefined {
	let pairing = pairArguments(parameterTypes, matchableArguments)

	return (index) => {
		let argumentIndex = pairing?.forParameter[index]

		return argumentIndex === null || argumentIndex === undefined
			? undefined
			: matchableArguments[argumentIndex]
	}
}

// Substitutes the bindings into the return Type. An unbound Type Parameter
// becomes an Error, so one report does not cascade.
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

// The Overload an Invocation settled on. `diagnostics` are what probing it
// reported, held until the candidate is committed.
type SelectedOverload = {
	index: number
	inferred: InferredInvocation
	conformances: Array<common.Conformance>
	diagnostics: Array<common.Diagnostic>
}

type ProbedOverload = {
	inferred: InferredInvocation
	conformances: Array<common.Conformance>
	// What solving this candidate's bounds reported, held until it is
	// committed.
	diagnostics: Array<common.Diagnostic>
	// Whether an Argument typed as Error against this candidate's Parameter
	// Types.
	sawErrorArgument: boolean
}

// One candidate matched and its bounds solved, with its reports and Argument
// Errors handed back separately.
function probeOverload(
	overload: common.BaseFunction,
	matchableArguments: Array<MatchableArgument>,
	scope: enricher.Scope,
	position: common.Position,
	typer: ArgumentTyper,
	// Carried for `resolveConformances`, which decides one Help by it; see
	// `printingEscapeHelps`.
	atPrintingCall = false,
): ProbedOverload | undefined {
	let { result, sawErrorArgument } = typer.probeErrorArguments(() => {
		let inferred = inferInvocation(overload, matchableArguments, typer)

		if (inferred === undefined) {
			return undefined
		}

		let { result: conformances, diagnostics } = collectDiagnostics(() =>
			resolveConformances(
				overload.generics,
				inferred.bindings,
				scope,
				position,
				atPrintingCall,
			),
		)

		return { inferred, conformances, diagnostics }
	})

	if (result === undefined) {
		return undefined
	}

	return { ...result, sawErrorArgument }
}

// The order candidates are probed in: entries asking for a refinement first,
// then the rest, stably. See "Choosing an Overload" in DEVELOPMENT.md.
function overloadProbeOrder(
	overloads: Array<common.BaseFunction>,
	receiverParameters: number,
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
			overload.parameterTypes
				.slice(receiverParameters)
				.some((parameter) => typeContainsRefinement(parameter.type))
		) {
			asking.push(candidate)
		} else {
			rest.push(candidate)
		}
	}

	return asking.length === 0 ? candidates : [...asking, ...rest]
}

// Selects an Overload, counting bounds and Error Arguments as part of fitting.
// Falls back on the first candidate whose Arguments matched. A literal's report
// against a candidate it does not fit waits for the selection. See "Choosing an
// Overload" in DEVELOPMENT.md.
export function selectOverload(
	...args: Parameters<typeof selectFittingOverload>
): SelectedOverload | undefined {
	return probingCandidates(
		() => selectFittingOverload(...args),
		args[0],
		args[1],
	)
}

function selectFittingOverload(
	overloads: Array<common.BaseFunction>,
	matchableArguments: Array<MatchableArgument>,
	scope: enricher.Scope,
	position: common.Position,
	typer: ArgumentTyper,
	// How many leading Parameters the call did not write: one for a Method's
	// receiver, else none. Read only by `overloadProbeOrder`.
	receiverParameters = 0,
	// Handed to every probe for the one Help it decides.
	atPrintingCall = false,
): SelectedOverload | undefined {
	let firstArgumentMatch:
		| { selected: SelectedOverload; sawErrorArgument: boolean }
		| undefined

	for (let [index, overload] of overloadProbeOrder(
		overloads,
		receiverParameters,
	)) {
		// Up to the first candidate whose Arguments match, a probe reports and
		// records. Later probes are speculative, so their reports and
		// recordings are held until one is committed.
		let probe = () =>
			probingCandidate(index, () =>
				probeOverload(
					overload,
					matchableArguments,
					scope,
					position,
					typer,
					atPrintingCall,
				),
			)
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

	// Nothing held up, so the Invocation owns this candidate's Error Argument,
	// which `reportUnboundGenerics` asks about.
	if (firstArgumentMatch.sawErrorArgument) {
		typer.noteErrorArgument()
	}

	return holeDecided(firstArgumentMatch)
}

// The one written Argument that is a Function literal without `-> Type`. Null
// for none or several, since a Help naming the wrong literal misleads.
function unannotatedLiteralArgument(
	writtenArguments: Array<parser.ArgumentNode>,
): parser.FunctionValueNode | null {
	let literals = writtenArguments
		.map((argument) => argument.value)
		.filter(
			(value): value is parser.FunctionValueNode =>
				value.nodeType === "FunctionValue" &&
				value.value.returnType === null,
		)

	return literals.length === 1
		? (literals[0] as parser.FunctionValueNode)
		: null
}

// Silent when an Argument already typed as Error, whose own Diagnostic
// explains the call.
function reportUnboundGenerics(
	unboundGenerics: Array<string>,
	// What the call answers, each unbound Type Parameter in it an Error.
	answer: common.Type,
	position: common.Position,
	typer: ArgumentTyper,
	receiver: parser.ExpressionNode | null = null,
	// The call's written Arguments. A Function literal among them decides
	// whether to report and which edit binds the Parameter.
	writtenArguments: Array<parser.ArgumentNode> = [],
): void {
	if (typer.hasErrorArgument() || unboundGenerics.length === 0) {
		return
	}

	// Silent over a receiver already refused for being read before its Type was
	// decided.
	if (
		receiver?.nodeType === "Identifier" &&
		capturesReportedUndecided.has(receiver)
	) {
		return
	}

	let literal = unannotatedLiteralArgument(writtenArguments)

	// A literal whose return Type could not be read was already refused, and
	// its answer Type's Parameters are unbound because of it. A literal that
	// only left `-> Type` off still reports here.
	if (literal !== null && literalsAnsweringNothing.has(literal.value)) {
		return
	}

	// `[=]::length()` binds neither of a Dictionary's Type Parameters, so the
	// empty Dictionary gets one report naming the annotation that decides it.
	if (
		receiver?.nodeType === "DictionaryValue" &&
		receiver.entries.length === 0
	) {
		reportError(
			`Type Parameters ${unboundGenerics
				.map((name) => `'${name}'`)
				.join(" and ")} could not be inferred`,
			position,
			{
				code: "uninferable-type-parameter",
				labels: [
					primary(position, "nothing here determines what it holds"),
				],
				helps: [
					"Annotate the declaration — 'constant d: Dictionary<…, …> = [=]', with the Type you mean in place of each '…'.",
				],
			},
		)

		return
	}

	// The return Type of the Parameter Type the literal was matched against,
	// such as `Step<State, Answer>` for `loop`. Only the names it mentions does
	// the literal's `-> Type` bind.
	let literalAnswers =
		literal === null
			? null
			: (recordedContextualFunctionType(literal.value)?.expectedType
					?.returnType ?? null)

	// Compared by the names as shown, since inference renames a callee's Type
	// Parameters for one call.
	let answeredNames = new Set(
		[...genericNamesMentioned(literalAnswers ?? { type: "Unknown" })].map(
			displayGenericName,
		),
	)

	for (let name of unboundGenerics) {
		let boundByTheLiteral = answeredNames.has(displayGenericName(name))

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
				// No Type Argument can be written at a call, and an annotation
				// on the binding does not reach into it. Where the literal's
				// `-> Type` would bind this name, that is the edit; otherwise
				// the Helps name the signature and the value.
				helps: boundByTheLiteral
					? [
							`Write the Function literal's return Type — '-> Type' after its Parameter list — which is what binds '${name}'.`,
						]
					: [
							"Give the Type Parameter a place among the Parameters, so that an Argument binds it.",
							...writtenValueHelps(answer),
						],
			},
		)
	}
}

// What every written Argument offers a match: its label, its Type under the
// Parameter Type tried, and the typer's other answers.
export function argumentMatchables(
	args: Array<parser.ArgumentNode>,
	typer: ArgumentTyper,
): Array<MatchableArgument> {
	return args.map((argument) => ({
		name: argument.name?.content ?? null,
		getType: (
			expectedType: common.Type,
			bindings: GenericBindings | null,
			declaredType?: common.Type,
		) =>
			typer.getType(argument.value, expectedType, bindings, declaredType),
		bindsNothing: bindsNoTypeParameter(argument),
		decide: (decided: common.Type) =>
			typer.decideArgument(argument.value, decided),
		mergedValue: (into) =>
			admittedMergeValue(
				into,
				typer.enrichedArgumentValue(argument.value),
			),
		spellsItsMembers: argument.value.nodeType === "RecordValue",
		writtenLiteral: isWrittenLiteral(argument.value),
	}))
}

// The Arguments of a `::` call with the receiver in front, as it occupies every
// instance Method's first Parameter. Shared by selection and its failure
// report. `receiverType` stands in per member of a Union receiver.
function methodMatchableArguments(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	typer: ArgumentTyper,
	receiverType: common.Type | null = null,
): Array<MatchableArgument> {
	return [
		{ name: null, getType: () => receiverType ?? baseType },
		...argumentMatchables(node.arguments, typer),
	]
}

// Where each of those Arguments is written, the receiver first.
function methodArgumentPositions(
	node: parser.MethodInvocationNode,
): Array<common.Position> {
	return [
		node.base.position,
		...node.arguments.map((argument) => argument.value.position),
	]
}

// What each written Argument came to. It enriches, so only the fallback report
// asks; the typer keeps the one Node per Argument. That report refuses the call,
// so a Function literal typed here takes no Types and reports nothing.
function writtenArgumentTypes(
	args: Array<parser.ArgumentNode>,
	typer: ArgumentTyper,
): Array<common.Type> {
	let typeOf = (argument: parser.ArgumentNode) =>
		typer.enrichedArgumentValue(argument.value).type

	return underRefusedCall(true, () => args.map(typeOf))
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
			// What selecting this Overload reported, replayed once the caller
			// commits to this Namespace.
			selectionDiagnostics: Array<common.Diagnostic>
	  }
	| undefined {
	let receiver = receiverType ?? baseType
	let methodType = pinnedForReceiver(resolvedNamespace, node, receiver)

	// A static Method has no receiver Parameter for `value::method(…)`. Static
	// Methods are filtered out earlier, and refusing them here keeps that
	// filter from being load-bearing.
	if (isStaticMethod(methodType)) {
		return
	}

	let matchableArguments = methodMatchableArguments(
		node,
		baseType,
		typer,
		receiverType,
	)

	// A SimpleMethod is a set of one candidate, so both Method shapes take the
	// same path.
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
		1,
	)

	if (selected === undefined) {
		return undefined
	}

	// Collected, since a Warning about the chosen entry is news only once the
	// call commits to this Namespace.
	let { diagnostics: nestingDiagnostics } = collectDiagnostics(() =>
		reportAmbiguousNestingLevel(
			node,
			receiver,
			overloads,
			selected,
			matchableArguments,
			scope,
			typer,
		),
	)

	return {
		returnType: selected.inferred.returnType,
		overloadedMethodIndex:
			methodType.type === "SimpleMethod" ? null : selected.index,
		unboundGenerics: selected.inferred.unboundGenerics,
		conformances: selected.conformances,
		omittedParameterIndices: selected.inferred.omittedParameterIndices,
		selectionDiagnostics: [...selected.diagnostics, ...nestingDiagnostics],
	}
}

// A failed Method Invocation resolves to a placeholder Namespace and an Error
// Type, after its Diagnostic. A dispatched one reuses the placeholder and keeps
// its targets in `dispatch`.
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
	// Set only for a generic Choice's derived `is` or `isNot`, the plan its
	// runtime helper interprets.
	derivedDescriptor?: common.DerivedEquatableDescriptor
	// Set only for a Record receiver that routes a declared member: the names
	// its runtime helper is curried with, in the order of the conformances.
	derivedMembers?: Array<string>
	dispatch: Array<common.DispatchCase> | null
	// Set where no Method resolved, rather than one answering an Error.
	failed?: true
}

function resolveFailedMethodInvocation(): ResolvedMethodInvocation {
	return {
		failed: true,
		namespace: placeholderNamespace(),
		type: { type: "Error" },
		overloadedMethodIndex: null,
		conformances: [],
		omittedParameterIndices: [],
		dispatch: null,
	}
}

// A Namespace in a Module this one depends on but did not import, found by the
// rule dispatch uses. The Help names the Namespace and its Module for the
// auto-import Quick Fix. Empty outside a Module.
function unimportedNamespaceHelps(
	memberName: string,
	baseType: common.Type,
	scope: enricher.Scope,
): Array<string> {
	// `Object.hasOwn`, so `valueOf` and `toString` are not read off the
	// prototype.
	let candidates = unimportedNamespacesOf(scope).filter((candidate) =>
		Object.hasOwn(candidate.namespace.methods, memberName),
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

// Every Method name a set of Namespaces declares, for near-miss suggestions.
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

// What a receiver holds, since a Method missing on the receiver may exist one
// level in: `first::add(1)` on a `List<Integer>`. A Future, a Started, a List,
// a Dictionary and a Case hold something; a Record's members are reached with
// `.`.
type HeldValue = {
	type: common.Type
	kind: "future" | "started" | "list" | "dictionary" | "case"
	// Which Case carries it, as a report spells it. Set only for a Case.
	carrier?: string
}

function heldValuesOf(receiverType: common.Type): Array<HeldValue> {
	// Refinements erased first, so a `NonEmptyList<Integer>` holds what its
	// List does.
	let type = eraseRefinements(receiverType)

	switch (type.type) {
		case "Future":
			return [{ type: type.valueType, kind: "future" }]
		case "Started":
			return [{ type: type.valueType, kind: "started" }]
		case "List":
			return [{ type: type.itemType, kind: "list" }]
		case "Dictionary":
			return [{ type: type.valueType, kind: "dictionary" }]
		case "Case":
			return payloadsOf(type)
		case "UnionType":
			return flattenUnionMembers(type).flatMap((member) =>
				member.type === "Case" ? payloadsOf(member) : [],
			)
		default:
			return []
	}
}

function payloadsOf(caseType: common.CaseType): Array<HeldValue> {
	return Object.values(caseType.members).map((payload) => ({
		type: payload,
		kind: "case" as const,
		carrier: describeType(caseType),
	}))
}

// Whether a `::` call of this name resolves for this Type, by the lookup a call
// uses, so unimported Namespaces do not count. Asked only after the call failed
// on the receiver itself.
export function methodAnswersFor(
	methodName: string,
	receiverType: common.Type,
	scope: enricher.Scope,
	position: common.Position,
): boolean {
	let namespaces = resolveMethodLookupNamespacesForReceiverType(
		receiverType,
		null,
		scope,
	)

	return (
		partitionInstanceMethodNamespaces(
			methodName,
			namespacesDeclaringMethod(
				methodName,
				namespaces,
				receiverType,
				scope,
				position,
			),
		).instanceNamespaces.size > 0
	)
}

// The ways a value is read out of its holder, tried in order. Each must be
// declared with these labels and answer the held value itself:
// `List::firstItem()` answers an Optional, while `NonEmptyList::firstItem()`
// does not.
const readingSpellings: Array<{ name: string; labels: Array<string> }> = [
	{ name: "firstItem", labels: [] },
	{ name: "value", labels: ["defaultingTo"] },
	{ name: "value", labels: ["at", "defaultingTo"] },
	{ name: "item", labels: ["at", "defaultingTo"] },
]

function readingSpellingFor(
	namespaces: Map<string, common.NamespaceType>,
	receiverType: common.Type,
	held: common.Type,
): string | null {
	// Specialized against the receiver, so the answer is the Type the reader
	// gets.
	let specialized = specializedNamespacesFor(namespaces, receiverType)

	for (let spelling of readingSpellings) {
		for (let namespace of specialized.values()) {
			let { signatures, receiverParameters } = methodOverloadSignatures(
				namespace.methods[spelling.name],
			)

			for (let signature of signatures) {
				let parameters =
					signature.parameterTypes.slice(receiverParameters)

				if (
					parameters.length === spelling.labels.length &&
					parameters.every(
						(parameter, index) =>
							parameter.name === spelling.labels[index],
					) &&
					matchesType(held, signature.returnType)
				) {
					return `::${spelling.name}(${spelling.labels
						.map((label) => `${label} …`)
						.join(", ")})`
				}
			}
		}
	}

	return null
}

// Whether `::map` hands the held value straight to the reader's Function. Asked
// about the transform, since `Dictionary::map` passes a `{ key, value }`.
function mapsOverHeldValue(
	namespaces: Map<string, common.NamespaceType>,
	receiverType: common.Type,
	held: common.Type,
): boolean {
	for (let namespace of specializedNamespacesFor(
		namespaces,
		receiverType,
	).values()) {
		let { signatures, receiverParameters } = methodOverloadSignatures(
			namespace.methods["map"],
		)

		for (let signature of signatures) {
			let parameter = signature.parameterTypes[receiverParameters]

			if (
				signature.parameterTypes.length === receiverParameters + 1 &&
				parameter?.name == null &&
				parameter?.type.type === "Function" &&
				parameter.type.parameterTypes.length === 1 &&
				matchesType(
					held,
					parameter.type.parameterTypes[0]?.type as common.Type,
				)
			) {
				return true
			}
		}
	}

	return false
}

// What `unknown-method` says when the receiver holds something that answers the
// Method, in place of a near miss. Null where nothing held answers it.
function heldValueEvidence(
	node: parser.MethodInvocationNode,
	receiverType: common.Type,
	namespaces: Map<string, common.NamespaceType>,
	scope: enricher.Scope,
): { notes: Array<string>; helps: Array<string> } | null {
	let methodName = node.member.content
	let held = heldValuesOf(receiverType).find((candidate) =>
		methodAnswersFor(methodName, candidate.type, scope, node.position),
	)

	if (held === undefined) {
		return null
	}

	// The Arguments are not invented: an ellipsis stands for them, and a call
	// without Arguments keeps its empty parentheses.
	let call = `::${methodName}${node.arguments.length === 0 ? "()" : "(…)"}`
	let inner = describeType(held.type)
	let binder =
		held.kind === "list" || held.kind === "dictionary" ? "item" : "value"
	let through = mapsOverHeldValue(namespaces, receiverType, held.type)
		? `::map((${binder}) { <- ${binder}${call} })`
		: null

	if (held.kind === "future" || held.kind === "started") {
		return asynchronyEvidence(node, receiverType, held, scope, {
			inner,
			call,
			through,
		})
	}

	let reading = readingSpellingFor(namespaces, receiverType, held.type)

	if (held.kind === "case") {
		// Two Helps: the spellings that reach the value, where the Choice's
		// Namespaces have them, and a `match`, which always works.
		let reaching =
			reading === null && through === null
				? []
				: [
						reading === null
							? `Reach through it with '${through}'.`
							: through === null
								? `Read the value out with '${reading}' and call '${call}' on it.`
								: `Read the value out with '${reading}' and call '${call}' on it, or reach through it with '${through}'.`,
					]

		return {
			notes: [
				`'${methodName}' is a Method of ${inner}, and '${held.carrier}' carries one.`,
			],
			helps: [
				...reaching,
				`${reaching.length === 0 ? "Take" : "Or take"} it apart with a 'match', and call '${call}' on the payload.`,
			],
		}
	}

	return {
		notes: [
			`'${methodName}' is a Method of ${inner}, which is what ${withArticle(
				describeType(receiverType),
			)} holds — a Method of its ${held.kind === "list" ? "items" : "values"} rather than of the ${
				held.kind === "list" ? "List" : "Dictionary"
			} itself.`,
		],
		helps: [
			...(through === null
				? []
				: [`Call '${call}' on each ${binder} — '${through}'.`]),
			...(reading === null
				? []
				: [
						`${through === null ? "Read" : "Or read"} one out with '${reading}' and call '${call}' on it.`,
					]),
		],
	}
}

// A Future or a Started needs a wait rather than a reach. A `complete` is
// offered only where it may stand, and the note warns that it takes the whole
// chain behind it. `::map` is offered beside it, answering another Future.
function asynchronyEvidence(
	node: parser.MethodInvocationNode,
	receiverType: common.Type,
	held: HeldValue,
	scope: enricher.Scope,
	spelling: { inner: string; call: string; through: string | null },
): { notes: Array<string>; helps: Array<string> } {
	let waits = bodyCanWait(scope)
	let barrier = completionBarrierIn(scope)
	let barred = barredCompletion(barrier)
	let state = asynchronyState(
		held.kind === "future" ? "unstarted" : "in-flight",
	)
	let reaching =
		spelling.through === null
			? []
			: [
					`${waits ? "Or reach" : "Reach"} through it with '${spelling.through}', which answers another ${held.kind === "future" ? "Future" : "Started"}.`,
				]

	return {
		notes: [
			`'${node.member.content}' is a Method of ${spelling.inner}. ${state} — the ${spelling.inner} is what ${withArticle(
				describeType(receiverType),
			)} answers with, once something waits for it.`,
			...(waits
				? [
						"'complete' takes the whole chain behind it, so a 'complete' written in front of this call would wait for the call rather than for the receiver.",
					]
				: [
						barrier === null
							? "'complete' only stands in a body that answers a Future, and this position is not one."
							: barred.note,
					]),
		],
		helps: waits
			? [
					`Wait for it on a line of its own — 'constant answered = complete …' — and call '${spelling.call}' on 'answered'.`,
					...reaching,
				]
			: [
					...reaching,
					// The edit the barrier admits. A property body has no
					// Function to declare, and a default is filled in before
					// its Function's asynchrony begins.
					...(barred.helps.length > 0
						? barred.helps
						: [
								"Or declare the enclosing Function '-> Future<…>', which is what lets its body wait.",
							]),
				],
	}
}

// Names the Namespaces searched, so the reader can tell a misspelling from a
// wrong Type. The near miss comes from the same set, so it would resolve.
function reportUnknownMethod(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	namespaces: Map<string, common.NamespaceType>,
	scope: enricher.Scope,
): void {
	// A Method the Parser dropped from its Namespace is declared, so a call of
	// it is no misspelling; see `memberDeclarationWasAbandoned`.
	if (memberDeclarationWasAbandoned(scope, node.member.content)) {
		return
	}

	let held = heldValueEvidence(node, baseType, namespaces, scope)
	// The near miss is tried last, and not where the value holds the answer.
	// Its Quick Fix would rewrite the name rather than the call.
	let suggestion = held === null ? closestMethodName(node, namespaces) : null
	let namespaceNames = [...namespaces.keys()]

	// A receiver known only by its Protocol bound, such as `@` in a provided
	// Method, is told the Protocol's surface.
	if (baseType.type === "GenericUse" && baseType.constraint !== undefined) {
		let surface = Object.keys(
			protocolOf(baseType.constraint, scope).methods,
		).sort()
		let bound = describeProtocol(baseType.constraint, scope)

		reportError(
			`'${bound}' has no Method named '${node.member.content}'`,
			node.member.position,
			{
				code: "method-not-on-protocol",
				labels: [
					primary(
						node.member.position,
						`'${bound}' does not declare this Method`,
					),
					secondary(
						node.base.position,
						`'${baseType.name}' is only known to conform to '${bound}'`,
					),
				],
				notes:
					surface.length === 0
						? [`'${bound}' declares no Methods.`]
						: [
								`'${bound}' declares ${surface
									.map((name) => `'${name}'`)
									.join(", ")}.`,
							],
				helps: [
					...(suggestion === null
						? []
						: [`Did you mean '${suggestion}'?`]),
					`Declare '${node.member.content}' on '${bound}', or bound '${baseType.name}' by a Protocol that has it.`,
				],
				...suggestionData(suggestion),
			},
		)

		return
	}

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
			notes: [
				...(held?.notes ?? []),
				...(namespaceNames.length === 0
					? []
					: [
							`Searched ${namespaceNames.length === 1 ? "Namespace" : "Namespaces"} ${namespaceNames
								.map((name) => `'${name}'`)
								.join(", ")}.`,
						]),
			],
			helps: [
				...(held?.helps ?? []),
				...(suggestion === null
					? []
					: [`Did you mean '${suggestion}'?`]),
				...unimportedNamespaceHelps(
					node.member.content,
					baseType,
					scope,
				),
				...undeclaredProtocolHelps(namespaces, scope),
			],
			...suggestionData(suggestion),
		},
	)
}

// The near miss for a Method name, first from the names whose shape fits the
// call. Where none is close, any declared name one edit away counts, but only
// for a call that wrote a label: `primes::lenght(of 1)` suggests `length`.
function closestMethodName(
	node: parser.MethodInvocationNode,
	namespaces: Map<string, common.NamespaceType>,
): string | null {
	let written = node.member.content
	let fitting = closestMatch(
		written,
		methodNamesFittingCall(node, namespaces),
	)

	if (
		fitting !== null ||
		!node.arguments.some((argument) => argument.name !== null)
	) {
		return fitting
	}

	let anyName = closestMatch(written, methodNamesOf(namespaces))

	return anyName !== null && editDistance(written, anyName) <= 1
		? anyName
		: null
}

// Measured on the shape alone, since no candidate was selected to enrich the
// Arguments against.
function methodNamesFittingCall(
	node: parser.MethodInvocationNode,
	namespaces: Map<string, common.NamespaceType>,
): Array<string> {
	let written = node.arguments.map(
		(argument) => argument.name?.content ?? null,
	)

	return methodNamesOf(namespaces).filter((name) =>
		[...namespaces.values()].some((namespace) => {
			let { signatures, receiverParameters } = methodOverloadSignatures(
				namespace.methods[name],
			)

			return signatures.some((signature) =>
				callShapeFits(
					signature.parameterTypes.slice(receiverParameters),
					written,
				),
			)
		}),
	)
}

// Whether these Arguments could pair with these Parameters, by the walk
// `pairArguments` makes, read without Types.
function callShapeFits(
	parameters: common.BaseFunction["parameterTypes"],
	written: Array<string | null>,
): boolean {
	let next = 0

	for (let parameter of parameters) {
		if (next < written.length && written[next] === parameter.name) {
			next += 1
		} else if (!parameter.hasDefault) {
			return false
		}
	}

	return next === written.length
}

// A Protocol's provided Methods are reached through the Protocol, so a Module
// that did not import it sees only the written Methods. Named once per Protocol
// the searched Namespaces declare.
function undeclaredProtocolHelps(
	namespaces: Map<string, common.NamespaceType>,
	scope: enricher.Scope,
): Array<string> {
	let missing = new Map<string, string>()

	for (let namespace of namespaces.values()) {
		for (let identity of namespace.conformsTo ?? []) {
			let name = displayProtocolName(identity)

			if (protocolSpelling(identity, scope) !== null) {
				continue
			}

			// Under the name its Module exports it as. Where this file holds
			// that name, the import needs a name of its own.
			let importing = protocolImport(identity, scope)
			let imported = importing?.exportedAs ?? name
			let taken =
				importing === null
					? protocolNameTaken(identity, scope)
					: importing.taken
			let holder =
				taken === "protocol"
					? `the '${imported}' named here is a different Protocol`
					: `this file binds '${imported}' already`
			let importerPath = modulePathOf(scope)
			let from =
				importing === null || importerPath === null
					? ""
					: ` from ${specifierTo(importerPath, importing.modulePath)}`

			if (importing !== null && importing.exportedAs === null) {
				let { modulePath } = importing
				let fileName = modulePath.slice(modulePath.lastIndexOf("/") + 1)

				missing.set(
					name,
					taken === null
						? `'${name}' is declared in ${fileName}, which does not export it — export it there and import it here, since this value conforms to it and a Protocol's provided Methods are only reachable where the Protocol is.`
						: `'${name}' is declared in ${fileName}, which does not export it — export it there and import it under a name of its own, '${name} as …', since this value conforms to it and ${holder}.`,
				)

				continue
			}

			missing.set(
				name,
				taken === null
					? `Import '${imported}'${from} — this value conforms to it, and a Protocol's provided Methods are only reachable where the Protocol is.`
					: `Import '${imported}'${from} under a name of its own, '${imported} as …' — this value conforms to it, and ${holder}.`,
			)
		}
	}

	return [...missing.keys()].sort().map((name) => missing.get(name)!)
}

// One entry a refused call was measured against. `receiverParameters` is how
// many leading Parameters the call wrote left of the parentheses, so the report
// leaves them out and counts `Parameter 1` after them.
type OverloadCandidate = {
	// Spelled as a report writes it, quotes included, or "This callee" for a
	// callee that is no name.
	name: string
	// For a provided Method: the Protocol that wrote it, beside the Namespace
	// that reached it. Empty for a written Method.
	qualifier: string
	signature: common.BaseFunction
	receiverParameters: number
}

// Why one candidate refused the call: the first Parameter it could not answer,
// or null where the Arguments could not be paired at all.
type CandidateRefusal = {
	candidate: OverloadCandidate
	detail: ArgumentMismatchDetail | null
}

// The signatures one Method declares, receiver still in front. None for a name
// no Namespace declares.
function methodOverloadSignatures(methodType: common.Type | undefined): {
	signatures: Array<common.BaseFunction>
	receiverParameters: number
} {
	switch (methodType?.type) {
		case "SimpleMethod":
			return { signatures: [methodType], receiverParameters: 1 }
		case "StaticMethod":
			return { signatures: [methodType], receiverParameters: 0 }
		case "OverloadedMethod":
			return { signatures: methodType.overloads, receiverParameters: 1 }
		case "OverloadedStaticMethod":
			return { signatures: methodType.overloads, receiverParameters: 0 }
		default:
			return { signatures: [], receiverParameters: 0 }
	}
}

// The candidates a `::` call reached, read off Namespaces specialized against
// the receiver, so a `List<Integer>` is told `prepend` takes an `Integer`. A
// provided Method also names the Protocol that wrote it.
function methodCandidates(
	node: parser.MethodInvocationNode,
	namespaces: Map<string, common.NamespaceType>,
	baseType: common.Type,
	scope: enricher.Scope,
): Array<OverloadCandidate> {
	return [...specializedNamespacesFor(namespaces, baseType)].flatMap(
		([namespaceName, namespaceType]) => {
			let { signatures, receiverParameters } = methodOverloadSignatures(
				namespaceType.methods[node.member.content],
			)

			return signatures.map((signature) => ({
				name: `'${candidateNamespaceName(namespaceName, namespaceType)}::${node.member.content}'`,
				qualifier:
					namespaceType.providedBy === undefined
						? ""
						: ` (provided by ${describeProtocol(namespaceType.providedBy, scope)})`,
				signature,
				receiverParameters,
			}))
		},
	)
}

// What the call would have had to write at one Parameter of one candidate. The
// receiver is written left of the `::`, so it is named rather than counted.
function describeCandidateParameter(
	candidate: OverloadCandidate,
	parameterIndex: number,
): string {
	let written = parameterIndex - candidate.receiverParameters

	return written < 0
		? "its receiver"
		: describeParameter(
				candidate.signature.parameterTypes[parameterIndex],
				written,
			)
}

// Every candidate matched once more for the report, under silenced Diagnostics
// and dropped recordings. See "The no-matching-overload report" in
// DEVELOPMENT.md.
function refusedCandidates(
	candidates: Array<OverloadCandidate>,
	matchableArguments: Array<MatchableArgument>,
): Array<CandidateRefusal> {
	let { result } = probeContextualFunctionTypes(() =>
		collectDiagnostics(() =>
			candidates.map((candidate) => ({
				candidate,
				detail: candidateRefusal(candidate, matchableArguments),
			})),
		),
	)

	return result.result
}

// One candidate's first refusal, or null where the Arguments could not be
// paired. A generic signature is matched under a fresh inference, as
// `inferInvocation` matches it.
function candidateRefusal(
	candidate: OverloadCandidate,
	matchableArguments: Array<MatchableArgument>,
): ArgumentMismatchDetail | null {
	let explain: Array<ArgumentMismatchDetail> = []
	let { signature } = candidate

	if (signature.generics.length === 0) {
		matchArguments(signature.parameterTypes, matchableArguments, {
			explain,
		})
	} else {
		let { parameterTypes, context } = createFreshenedInference(signature)

		matchArguments(parameterTypes, matchableArguments, {
			explain,
			inference: context,
		})
	}

	return explain[0] ?? null
}

// Whether a candidate accepts these Arguments, asked only of rearranged
// Arguments after the call was refused. Probed silently, as `refusedCandidates`
// does.
function candidateAccepts(
	candidate: OverloadCandidate,
	matchableArguments: Array<MatchableArgument>,
): boolean {
	let { result } = probeContextualFunctionTypes(() =>
		collectDiagnostics(() => {
			let { signature } = candidate

			if (signature.generics.length === 0) {
				return (
					matchArguments(signature.parameterTypes, matchableArguments)
						.type === "Match"
				)
			}

			let { parameterTypes, context } =
				createFreshenedInference(signature)

			return (
				matchArguments(parameterTypes, matchableArguments, {
					inference: context,
				}).type === "Match"
			)
		}),
	)

	return result.result
}

// The Arguments after one edit: two exchanged where `swap` says so, each taking
// the label its new Parameter declares, as a reader would write it.
function rearrangedArguments(
	candidate: OverloadCandidate,
	matchableArguments: Array<MatchableArgument>,
	first: number,
	second: number,
	swap: boolean,
): Array<MatchableArgument> {
	let rearranged = [...matchableArguments]
	let labelled = (argument: MatchableArgument, at: number) => ({
		...argument,
		name: candidate.signature.parameterTypes[at]?.name ?? null,
	})

	if (swap) {
		rearranged[first] = labelled(
			matchableArguments[second] as MatchableArgument,
			first,
		)
		rearranged[second] = labelled(
			matchableArguments[first] as MatchableArgument,
			second,
		)
	} else {
		rearranged[first] = labelled(
			matchableArguments[first] as MatchableArgument,
			first,
		)
		rearranged[second] = labelled(
			matchableArguments[second] as MatchableArgument,
			second,
		)
	}

	return rearranged
}

// The two Arguments a call wrote the other way round, as in
// `[1, 2, 3]::reduce((total, item) { … }, 0)`, or null. See "The
// no-matching-overload report" in DEVELOPMENT.md.
function argumentsInOtherOrder(
	candidate: OverloadCandidate,
	matchableArguments: Array<MatchableArgument>,
): { first: number; second: number } | null {
	let found: { first: number; second: number } | null = null

	for (
		let first = candidate.receiverParameters;
		first < matchableArguments.length;
		first++
	) {
		for (
			let second = first + 1;
			second < matchableArguments.length;
			second++
		) {
			if (
				!candidateAccepts(
					candidate,
					rearrangedArguments(
						candidate,
						matchableArguments,
						first,
						second,
						true,
					),
				) ||
				candidateAccepts(
					candidate,
					rearrangedArguments(
						candidate,
						matchableArguments,
						first,
						second,
						false,
					),
				)
			) {
				continue
			}

			if (found !== null) {
				return null
			}

			found = { first, second }
		}
	}

	return found
}

// The report for a call that wrote two Arguments the other way round.
function swappedOrderReport(
	candidate: OverloadCandidate,
	swapped: { first: number; second: number },
	positions: Array<common.Position>,
	call: { position: common.Position; callee: common.Position },
	notes: Array<string>,
): {
	labels: [common.DiagnosticLabel, ...Array<common.DiagnosticLabel>]
	notes: Array<string>
	helps: Array<string>
} {
	let firstName = describeCandidateParameter(candidate, swapped.second)
	let secondName = describeCandidateParameter(candidate, swapped.first)
	let swapHelp = swappedOrderHelp(candidate, swapped)
	let written = (at: number) => positions[at] ?? call.position

	return {
		labels: [
			primary(
				written(swapped.first),
				`this Argument is what ${firstName} takes`,
			),
			secondary(
				written(swapped.second),
				`and this one is what ${secondName} takes`,
			),
		],
		notes: ["This call passes the Arguments in the other order.", ...notes],
		helps: [swapHelp],
	}
}

// The one edit, labels and all, since a moved Argument takes its label along.
function swappedOrderHelp(
	candidate: OverloadCandidate,
	swapped: { first: number; second: number },
): string {
	let names = [swapped.first, swapped.second]
		.map((at) => candidate.signature.parameterTypes[at]?.name)
		.filter((name) => name != null)
		.map((name) => `'${name}'`)

	if (names.length === 0) {
		return "Write them the other way round."
	}

	return `Write them the other way round, with ${joinedWithAnd(names)} before the ${
		names.length === 1 ? "value it labels" : "values they label"
	}.`
}

// The candidate a report leads with. See "The no-matching-overload report" in
// DEVELOPMENT.md.
function closestRefusal(
	refusals: Array<CandidateRefusal>,
): { candidate: OverloadCandidate; detail: ArgumentMismatchDetail } | null {
	let closest: {
		candidate: OverloadCandidate
		detail: ArgumentMismatchDetail
	} | null = null

	for (let { candidate, detail } of refusals) {
		if (detail === null) {
			continue
		}

		if (
			closest === null ||
			detail.matchedParameters > closest.detail.matchedParameters ||
			(detail.matchedParameters === closest.detail.matchedParameters &&
				detail.argumentType !== null &&
				closest.detail.argumentType === null)
		) {
			closest = { candidate, detail }
		}
	}

	return closest
}

// How many candidates a report lists. `Number.highest(1)` reaches fourteen
// entries, too many to read.
const listedCandidateNotes = 5

// The first five in declaration order and a count of the rest. The closest
// candidate's note moves to the front if it would fall outside.
function cappedNotes(notes: Array<string>, closest: number): Array<string> {
	if (notes.length <= listedCandidateNotes) {
		return notes
	}

	let listed =
		closest < listedCandidateNotes
			? notes.slice(0, listedCandidateNotes)
			: [
					notes[closest] as string,
					...notes.slice(0, listedCandidateNotes - 1),
				]

	return [
		...listed,
		`And ${countOf(notes.length - listed.length, "more Overload")} of this name, not listed.`,
	]
}

// One note per candidate: what it takes, and how this call disagreed with it
// where the labels do not already say so.
function candidateNote(
	{ candidate, detail }: CandidateRefusal,
	matchableArguments: Array<MatchableArgument>,
	lead: ArgumentMismatchDetail | null,
): string {
	let written = candidate.signature.parameterTypes.slice(
		candidate.receiverParameters,
	)

	return `${candidate.name}${candidate.qualifier} ${describeSignature(written)}${
		detail === null || refusedAlike(detail, lead)
			? ""
			: ` — ${refusalClause(candidate, detail, matchableArguments)}`
	}.`
}

// Whether two candidates were refused over the same Argument the same way,
// Types compared as spelled, since an Argument may type differently per
// candidate.
function refusedAlike(
	detail: ArgumentMismatchDetail,
	lead: ArgumentMismatchDetail | null,
): boolean {
	if (lead === null || detail.argumentIndex !== lead.argumentIndex) {
		return false
	}

	return detail.argumentType === null || lead.argumentType === null
		? detail.argumentType === lead.argumentType
		: describeType(detail.argumentType) === describeType(lead.argumentType)
}

// What this call did at the refused Parameter, said from the call's side.
function refusalClause(
	candidate: OverloadCandidate,
	detail: ArgumentMismatchDetail,
	matchableArguments: Array<MatchableArgument>,
): string {
	let parameter = candidate.signature.parameterTypes[detail.parameterIndex]
	let name = describeCandidateParameter(candidate, detail.parameterIndex)

	if (detail.argumentType === null) {
		let label = matchableArguments[detail.argumentIndex]?.name ?? null

		if (parameter?.name == null) {
			return `this call writes '${label}' where ${name} takes no label`
		}

		return label === null
			? `this call writes no label where ${name} is expected`
			: `this call writes '${label}' where ${name} is expected`
	}

	return `this call passes ${describeWrittenArgument(detail.argumentType)} as ${name}`
}

// An Argument as a report names it. An Error already has its own Diagnostic, so
// the report does not print it as a Type.
function describeWrittenArgument(type: common.Type): string {
	return typeContainsError(type)
		? "an Argument whose Type could not be read"
		: withArticle(describeType(type))
}

// An English list, for naming several Types in a row.
export function joinedWithAnd(described: Array<string>): string {
	if (described.length < 2) {
		return described.join("")
	}

	return `${described.slice(0, -1).join(", ")} and ${described[described.length - 1]}`
}

// A label no candidate declares, for the report about the call's shape. Such a
// label takes an Argument from the Parameter that needed it, so the count looks
// wrong: `numbers::slice(at 1)`.
function unknownLabelEvidence(
	refusals: Array<CandidateRefusal>,
	matchableArguments: Array<MatchableArgument>,
	callee: string,
): { notes: Array<string>; helps: Array<string> } {
	let declared = new Set<string>()

	for (let { candidate } of refusals) {
		for (let parameter of candidate.signature.parameterTypes) {
			if (parameter.name != null) {
				declared.add(parameter.name)
			}
		}
	}

	let notes: Array<string> = []
	let helps: Array<string> = []

	for (let { name } of matchableArguments) {
		if (name === null || declared.has(name)) {
			continue
		}

		let suggestion = closestMatch(name, [...declared])

		notes.push(`No Parameter of ${callee} is labelled '${name}'.`)

		if (suggestion !== null) {
			helps.push(`Did you mean '${suggestion}'?`)
		}
	}

	return { notes, helps }
}

// What a call whose shape no candidate takes passed: the count and each
// Argument's Type. The Types are left out when one could not be read.
function passedArgumentsLabel(passed: Array<common.Type>): string {
	let counted = `this call passes ${countOf(passed.length, "Argument")}`

	return passed.length === 0 || passed.some(typeContainsError)
		? counted
		: `${counted}: ${joinedWithAnd(passed.map((type) => withArticle(describeType(type))))}`
}

// The labels, notes and helps of every `no-matching-overload` report. See "The
// no-matching-overload report" in DEVELOPMENT.md.
function overloadRefusalReport(
	refusals: Array<CandidateRefusal>,
	matchableArguments: Array<MatchableArgument>,
	// Where each matchable Argument is written, receiver included, parallel to
	// `matchableArguments`.
	positions: Array<common.Position>,
	call: {
		position: common.Position
		// Where the callee is named, for the label saying what it takes.
		callee: common.Position
		// The callee's name, as a report writes it, quotes included.
		name: string
		// Asked only for the report about the call's shape, and lazily, since
		// reading the Types enriches.
		passed: () => Array<common.Type>
		// Whether the enclosing body may write `complete`; see `bodyCanWait`.
		// Decides how a Future Argument is answered.
		canWait?: boolean
		// Which barrier refused `complete`, since each leaves a different edit;
		// see `barredCompletion`.
		barrier?: enricher.CompletionBarrier | null
		// Whether the only Errors in an Argument's Type are holes for the
		// Functions refused as values it holds. Each is reported where it
		// stands, so the Type is described.
		holesOnly?: (argumentIndex: number) => boolean
	},
): {
	labels: [common.DiagnosticLabel, ...Array<common.DiagnosticLabel>]
	notes: Array<string>
	helps: Array<string>
	// The data for the Quick Fix that writes `complete`, which the validator's
	// `argument-type-mismatch` carries too.
	data?: common.DiagnosticData
} {
	let closest = closestRefusal(refusals)
	let notes = cappedNotes(
		refusals.map((refusal) =>
			candidateNote(refusal, matchableArguments, closest?.detail ?? null),
		),
		closest === null
			? -1
			: refusals.findIndex(
					(refusal) => refusal.candidate === closest.candidate,
				),
	)

	if (closest === null) {
		let unknownLabels = unknownLabelEvidence(
			refusals,
			matchableArguments,
			call.name,
		)

		return {
			labels: [
				primary(call.position, passedArgumentsLabel(call.passed())),
			],
			notes: [...unknownLabels.notes, ...notes],
			helps: unknownLabels.helps,
		}
	}

	let { candidate, detail } = closest

	// Asked first, since a swap is a mistake about two Arguments, not one.
	let swapped = argumentsInOtherOrder(candidate, matchableArguments)

	if (swapped !== null) {
		return swappedOrderReport(candidate, swapped, positions, call, notes)
	}

	let parameter = candidate.signature.parameterTypes[detail.parameterIndex]
	let parameterName = describeCandidateParameter(
		candidate,
		detail.parameterIndex,
	)
	let position = positions[detail.argumentIndex] ?? call.position

	// A label mismatch: the Argument's Type was never read, so it is not
	// enriched now. The Help is the validator's own.
	if (detail.argumentType === null) {
		let label = matchableArguments[detail.argumentIndex]?.name ?? null

		return {
			labels: [
				primary(
					position,
					label === null
						? "this Argument carries no label"
						: `this is labelled '${label}'`,
				),
				secondary(
					call.callee,
					parameter?.name == null
						? `${candidate.name} takes no label on ${parameterName}`
						: `${candidate.name} takes ${parameterName} here`,
				),
			],
			notes,
			helps: [
				parameter?.name == null
					? "Pass the value with no label."
					: `Write '${parameter.name}' before the value.`,
			],
		}
	}

	return argumentTypeRefusal(
		{ ...detail, argumentType: detail.argumentType },
		candidate,
		parameterName,
		position,
		call,
		notes,
		matchableArguments[detail.argumentIndex]?.mergedValue?.(
			detail.expectedType,
		),
	)
}

// What a candidate is called in a report. A provided Method's pseudo Namespace
// is keyed by its conformance source; the reader sees the Namespace's own name.
function candidateNamespaceName(
	key: string,
	namespaceType: common.NamespaceType,
): string {
	return namespaceType.providedBy === undefined ? key : namespaceType.name
}

// A derived Method answers only where no written Namespace declares the name.
// When one replaced it, a note says so. The receiver's Namespaces are looked up
// again, since a Printable derive reads the whole set.
function replacedFallbackNotes(
	methodName: string,
	answered: Map<string, common.NamespaceType>,
	baseType: common.Type,
	scope: enricher.Scope,
): Array<string> {
	let namespaces = resolveMethodLookupNamespacesForReceiverType(
		baseType,
		null,
		scope,
	)
	let derived = derivedEquatableNamespace(baseType, scope)
	let printable = derivedPrintableNamespace(
		baseType,
		namespaces.values(),
		scope,
	)

	if (
		(derived === null || !Object.hasOwn(derived.methods, methodName)) &&
		(printable === null || !Object.hasOwn(printable.methods, methodName))
	) {
		return []
	}

	return answered.has(derivedEquatableNamespaceName) ||
		answered.has(derivedPrintableNamespaceName)
		? []
		: [
				`${describeType(baseType)} derives '${methodName}', and a Namespace declaring the name replaces it.`,
			]
}

// `memberType` is set only for one member of a Union receiver's dispatch, the
// receiver every candidate is measured against.
function reportNoMatchingOverload(
	node: parser.MethodInvocationNode,
	namespaces: Map<string, common.NamespaceType>,
	baseType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
	memberType: common.Type | null = null,
): void {
	let receiverType = memberType ?? baseType

	if (holdsFunctionRefusedAsValue(receiverType)) {
		return
	}

	let measured = typerAroundRefusedFunctions(node.arguments, typer)
	let matchableArguments = methodMatchableArguments(
		node,
		baseType,
		measured ?? typer,
		memberType,
	)
	let candidates = methodCandidates(node, namespaces, receiverType, scope)

	// Refused only for a Function the validator reports where it stands.
	if (
		measured !== null &&
		candidates.some((candidate) =>
			candidateAccepts(candidate, matchableArguments),
		)
	) {
		return
	}

	readLiteralsByPlace(
		candidates.map((candidate) => candidate.signature),
		matchableArguments,
	)

	let { labels, notes, helps, data } = overloadRefusalReport(
		refusedCandidates(candidates, matchableArguments),
		matchableArguments,
		methodArgumentPositions(node),
		{
			position: node.position,
			callee: node.member.position,
			name: `'${node.member.content}'`,
			passed: () =>
				writtenArgumentTypes(node.arguments, measured ?? typer),
			canWait: bodyCanWait(scope),
			barrier: completionBarrierIn(scope),
			// The receiver stands first among the matched Arguments.
			holesOnly: (index) =>
				holdsOnlyHoles(node.arguments[index - 1], typer),
		},
	)

	reportError(
		memberType === null
			? `No overload of '${node.member.content}' accepts these Arguments`
			: `No overload of '${node.member.content}' accepts these Arguments for ${describeType(memberType)}`,
		node.position,
		{
			code: "no-matching-overload",
			labels:
				memberType === null
					? labels
					: [
							...labels,
							secondary(
								node.base.position,
								`${describeType(memberType)} is a member of this Union`,
							),
						],
			notes: [
				...notes,
				...replacedFallbackNotes(
					node.member.content,
					namespaces,
					receiverType,
					scope,
				),
			],
			helps,
			...(data === undefined ? {} : { data }),
		},
	)
}

// A receiver with an undecided slot, such as `[]`'s `List<Unknown>`, matches
// every List Namespace both ways, so specificity would pick by a Type nothing
// decided. More than one match is refused; exactly one is left alone.
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
			helps: [receiverAnnotationHelp(baseType)],
		},
	)
}

// A Type Parameter without a bound reaches no Namespace. The Helps offer each
// Protocol in scope that declares the Method as the bound. Empty for any other
// receiver, or where nothing declares the name.
function unboundedParameterHelps(
	baseType: common.Type,
	methodName: string,
	scope: enricher.Scope,
): Array<string> {
	if (baseType.type !== "GenericUse" || baseType.constraint !== undefined) {
		return []
	}

	return protocolsDeclaringMethod(methodName, scope).map(
		(protocolName) =>
			`Bound the Type Parameter by a Protocol that declares '${methodName}' — '<infer ${baseType.name} is ${protocolName}>' at the Declaration that introduces it.`,
	)
}

export function resolveMethodInvocation(
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

	// A specifier that names no Namespace was already refused, and its empty
	// lookup is no second mistake.
	if (specifierWasRefused(node.namespaceSpecifier)) {
		return resolveFailedMethodInvocation()
	}

	let { instanceNamespaces: matchingNamespaces, staticNamespaces } =
		partitionInstanceMethodNamespaces(
			node.member.content,
			namespacesDeclaringMethod(
				node.member.content,
				namespaces,
				baseType,
				scope,
				node.position,
				node.namespaceSpecifier,
			),
		)

	// A Union receiver falls back to per-member dispatch when no covering
	// Namespace resolves the Method. A covering one, such as `Ordering`, takes
	// precedence.
	if (matchingNamespaces.size === 0) {
		let helps = () => [
			...unboundedParameterHelps(baseType, node.member.content, scope),
			...unimportedNamespaceHelps(node.member.content, baseType, scope),
		]

		// A pick of a requirement is refused before a Union dispatches it.
		if (reportPickedRequirement(node, baseType, scope, typer, helps)) {
			return resolveFailedMethodInvocation()
		}

		if (baseType.type === "UnionType") {
			return resolveUnionMethodDispatch(node, baseType, scope, typer)
		}

		// The name resolves, but only to a static Method, which neither "no
		// such Method" report would say.
		if (staticNamespaces.size > 0) {
			reportStaticMethodOnValue(
				node,
				baseType,
				null,
				staticNamespaces,
				scope,
			)

			return resolveFailedMethodInvocation()
		}

		// No Namespace targets the value, or one does without a Method of this
		// name: two mistakes, two Diagnostics.
		if (namespaces.size === 0) {
			if (
				!isReportedValue(baseType) &&
				!isUnwrittenTypeParameter(baseType, scope)
			) {
				reportEmptyLookup(
					node,
					baseType,
					scope,
					answeringNamespaces(
						node.member.content,
						baseType,
						scope,
						node.position,
					),
					helps(),
					baseType,
					() => compilesWithoutPick(node, baseType, scope, typer),
				)
			}
		} else {
			reportUnknownMethod(node, baseType, namespaces, scope)
		}

		return resolveFailedMethodInvocation()
	}

	let resolvedMethods = []

	// Every Namespace is probed, to find an ambiguity. Each probe's recordings
	// and literal reports are held, and only the selected candidate's stand.
	let lastRecording: ContextualFunctionTypeRecording | undefined
	let literalReports = holdLiteralReports()

	for (let [namespaceName, namespaceType] of matchingNamespaces) {
		let { result: resolvedMethod, recording } =
			probeContextualFunctionTypes(() =>
				literalReports.during(() =>
					resolveInvokedMethodInNamespace(
						node,
						namespaceType,
						baseType,
						scope,
						typer,
					),
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
		// An undecided receiver is refused before the specificity order is
		// asked; see `reportUndecidedReceiverType`. Completion still lists
		// every Namespace.
		if (typeContainsUnknown(baseType)) {
			commitContextualFunctionTypes(lastRecording)
			literalReports.release(true)

			reportUndecidedReceiverType(
				node,
				baseType,
				null,
				resolvedMethods.map((method) =>
					candidateNamespaceName(
						method.namespace.name,
						method.namespace.type,
					),
				),
			)

			return resolveFailedMethodInvocation()
		}

		// The raw Namespaces, whose generic targets keep their own Type
		// Parameters for the specificity order to compare.
		resolvedMethods = filterMostSpecificByTarget(
			resolvedMethods,
			(candidate) => candidate.namespace.type,
		)
	}

	// A committed winner reads its literals again.
	literalReports.release(resolvedMethods.length !== 1)

	if (resolvedMethods.length === 0) {
		// The covering Namespace rejects the Arguments, but per-member dispatch
		// may accept them with each member's own receiver Type.
		if (baseType.type === "UnionType") {
			return resolveUnionMethodDispatch(
				node,
				baseType,
				scope,
				typer,
				matchingNamespaces,
			)
		}

		// No candidate to commit, so the last probe's recordings stand in,
		// keeping a literal from also reporting its Parameters as uninferable.
		commitContextualFunctionTypes(lastRecording)

		reportNoMatchingOverload(
			node,
			matchingNamespaces,
			baseType,
			scope,
			typer,
		)

		return resolveFailedMethodInvocation()
	} else if (resolvedMethods.length === 1) {
		let resolvedMethod = resolvedMethods[0]

		commitContextualFunctionTypes(resolvedMethod.recording)

		// Reported only for the selected candidate, so losing Overloads and
		// Namespaces leak nothing.
		reportUnboundGenerics(
			resolvedMethod.unboundGenerics,
			resolvedMethod.type,
			node.position,
			typer,
			node.base,
			node.arguments,
		)

		// What selecting the Overload reported, now that this Namespace is
		// committed.
		for (let diagnostic of resolvedMethod.selectionDiagnostics) {
			report(diagnostic)
		}

		// A direct `is`, `isNot` or `toString` on a Record. The builtin Record
		// Namespace declares no `where`, so its members' conformances are
		// solved here as the call's hidden Arguments.
		let routedRecord = routedRecordCall(
			resolvedMethod.namespace.name,
			resolvedMethod.namespace.type,
			node.member.content,
			baseType,
			scope,
			node.position,
		)

		return {
			namespace: resolvedMethod.namespace,
			type: resolvedMethod.type,
			overloadedMethodIndex: resolvedMethod.overloadedMethodIndex,
			conformances:
				routedRecord === null
					? resolvedMethod.conformances
					: routedRecord.conformances,
			omittedParameterIndices: resolvedMethod.omittedParameterIndices,
			...(routedRecord === null
				? {}
				: { derivedMembers: routedRecord.members }),
			// A direct `is` or `isNot` on a generic Choice: the runtime
			// helper's descriptor comes from the Choice's declared Alias, which
			// the applied receiver erased.
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
		// An ambiguity leaves no winner, so the last probe's recordings stand
		// in.
		commitContextualFunctionTypes(lastRecording)

		reportAmbiguousNamespace(
			node,
			resolvedMethods.map(({ namespace }) => ({
				key: namespace.name,
				namespaceType: namespace.type,
			})),
			scope,
		)

		return resolveFailedMethodInvocation()
	}
}

// Per-member dispatch for a Union receiver: the Method resolves for each
// member, and the Type is the Union of the branches' return Types. More
// specific members come first, so an open Record member does not swallow the
// others at runtime.
function resolveUnionMethodDispatch(
	node: parser.MethodInvocationNode,
	unionType: common.UnionType,
	scope: enricher.Scope,
	typer: ArgumentTyper,
	// The Namespaces covering the whole Union that declare the Method, when
	// dispatch is a second chance after their Overloads refused. With them, a
	// failure reports the receiver as written rather than one member.
	coveringNamespaces: Map<string, common.NamespaceType> = new Map(),
): ResolvedMethodInvocation {
	let members = flattenUnionMembers(unionType)
	let dispatchCases: Array<common.DispatchCase> = []
	let caseReturnTypes: Array<common.Type> = []

	for (let memberType of members) {
		let { instanceNamespaces: matchingNamespaces, staticNamespaces } =
			partitionInstanceMethodNamespaces(
				node.member.content,
				branchNamespaces(node, memberType, scope),
			)

		if (matchingNamespaces.size === 0) {
			// As for a plain receiver: the member's Method exists but is
			// static.
			if (staticNamespaces.size > 0) {
				reportStaticMethodOnValue(
					node,
					unionType,
					memberType,
					staticNamespaces,
					scope,
				)

				return resolveFailedMethodInvocation()
			}

			// A specifier narrowed this member's lookup, not its Methods.
			if (node.namespaceSpecifier !== null) {
				reportNarrowedUnionMember(
					node,
					unionType,
					memberType,
					scope,
					typer,
				)

				return resolveFailedMethodInvocation()
			}

			// A covering Namespace declares the Method, so the Arguments are
			// what went wrong, reported against the Union as written.
			if (coveringNamespaces.size > 0) {
				reportNoMatchingOverload(
					node,
					coveringNamespaces,
					unionType,
					scope,
					typer,
				)

				return resolveFailedMethodInvocation()
			}

			// The near miss and the evidence come from the Namespaces over the
			// whole Union, the likeliest meaning: `firstItem()::hasValu()`.
			// Silent for a Method the Parser dropped, as in
			// `reportUnknownMethod`.
			if (memberDeclarationWasAbandoned(scope, node.member.content)) {
				return resolveFailedMethodInvocation()
			}

			let coveringLookup = resolveMethodLookupNamespacesForReceiverType(
				unionType,
				node.namespaceSpecifier,
				scope,
			)
			// What the reader holds is the whole Union, such as an Optional, so
			// the evidence is read off it.
			let held = heldValueEvidence(node, unionType, coveringLookup, scope)
			let suggestion =
				held === null ? closestMethodName(node, coveringLookup) : null

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
						...(held?.notes ?? []),
						`Every member of the Union must provide '${node.member.content}' — the receiver's Type is only known at runtime.`,
						...dividedUnionNotes(node, unionType, scope),
					],
					helps: [
						...(held?.helps ?? []),
						...(suggestion === null
							? []
							: [`Did you mean '${suggestion}'?`]),
					],
					...suggestionData(suggestion),
				},
			)

			return resolveFailedMethodInvocation()
		}

		let resolvedMethods = []
		// As in `resolveMethodInvocation`, each probe's recordings are held
		// until this member's branch picks its Namespace.
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
			// As in `resolveMethodInvocation`, an undecided member Type does
			// not let the order pick its Namespace.
			if (typeContainsUnknown(memberType)) {
				commitContextualFunctionTypes(lastRecording)

				reportUndecidedReceiverType(
					node,
					unionType,
					memberType,
					resolvedMethods.map((method) =>
						candidateNamespaceName(
							method.namespaceName,
							method.namespaceType,
						),
					),
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

			// A covering Namespace's refusal is the one reported, against the
			// receiver as written.
			reportNoMatchingOverload(
				node,
				coveringNamespaces.size > 0
					? coveringNamespaces
					: matchingNamespaces,
				unionType,
				scope,
				typer,
				coveringNamespaces.size > 0 ? null : memberType,
			)

			return resolveFailedMethodInvocation()
		}

		if (resolvedMethods.length > 1) {
			commitContextualFunctionTypes(lastRecording)

			reportAmbiguousNamespace(
				node,
				resolvedMethods.map((method) => ({
					key: method.namespaceName,
					namespaceType: method.namespaceType,
				})),
				scope,
				{ type: unionType, member: memberType, typer },
			)

			return resolveFailedMethodInvocation()
		}

		let resolvedMethod = resolvedMethods[0]

		// Each branch commits its recording as it settles, so the shared
		// Argument Nodes are typed by the last branch. Each branch keeps its
		// own copy of the Arguments that read their position.
		commitContextualFunctionTypes(resolvedMethod.recording)

		// The shared Arguments decide unbound Type Parameters, so the first
		// member reports them. A later one reports those its witnesses need.
		reportUnboundGenerics(
			unboundToReport(resolvedMethod, node, memberType === members[0]),
			resolvedMethod.returnType,
			node.position,
			typer,
			node.base,
			node.arguments,
		)

		// The branch's selection Diagnostics, replayed now that its Namespace
		// is settled. A failure every branch shares deduplicates.
		for (let diagnostic of resolvedMethod.selectionDiagnostics) {
			report(diagnostic)
		}

		dispatchCases.push({
			memberType,
			namespaceName: resolvedMethod.namespaceName,
			// Read off the resolved Namespace, as the single-receiver path
			// does. The name alone can not tell a Protocol's pseudo Namespace
			// from a real one of the same name.
			providedBy: resolvedMethod.namespaceType.providedBy,
			overloadedMethodIndex: resolvedMethod.overloadedMethodIndex,
			conformances: resolvedMethod.conformances,
			takesWitnesses: takesWitnesses(resolvedMethod, node),
			omittedParameterIndices: resolvedMethod.omittedParameterIndices,
			contextualArguments: contextualArgumentsForBranch(
				node,
				scope,
				resolvedMethod.recording,
			),
			// A branch resolving to a generic Choice's derived `is` or `isNot`
			// widens as a direct call does.
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
				helps: undispatchableHelps(
					catchAllCases.map(
						(dispatchCase) => dispatchCase.memberType,
					),
					node.base.nodeType === "Identifier"
						? node.base.content
						: null,
					(parameter) =>
						describeProtocol(parameter.constraint, scope),
				),
			},
		)

		return resolveFailedMethodInvocation()
	}

	return {
		namespace: placeholderNamespace(),
		type: buildUnion(mergeUnionMembers(caseReturnTypes)),
		overloadedMethodIndex: null,
		conformances: [],
		// Held per branch, since each resolves to a different Method.
		omittedParameterIndices: [],
		dispatch: orderDispatchCasesBySpecificity(dispatchCases),
	}
}

// The Arguments a dispatch branch needs its own copy of: those that read their
// position, enriched again under the branch's recording. See "Union receivers"
// in DEVELOPMENT.md.
function contextualArgumentsForBranch(
	node: parser.MethodInvocationNode,
	scope: enricher.Scope,
	recording: ContextualFunctionTypeRecording,
): common.DispatchCase["contextualArguments"] {
	let contextualArguments: common.DispatchCase["contextualArguments"] = []

	for (let [index, argument] of node.arguments.entries()) {
		// An unannotated Function literal and a member path read their
		// position, so each branch needs its own typed copy.
		let readsItsPosition =
			argument.value.nodeType === "MemberPath" ||
			(argument.value.nodeType === "FunctionValue" &&
				needsContext(argument.value.value))

		if (!readsItsPosition) {
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

// Whether `dispatchCase` must be tried before `other`. A runtime catch-all
// accepts every value, so anything else outranks it.
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

// Orders the branches so each stands after every branch strictly more specific
// than it, since `dispatchMethod` takes the first open match. See "Union
// receivers" in DEVELOPMENT.md.
function orderDispatchCasesBySpecificity(
	dispatchCases: Array<common.DispatchCase>,
): Array<common.DispatchCase> {
	let ordered: Array<common.DispatchCase> = []
	let placed = new Set<common.DispatchCase>()

	function place(dispatchCase: common.DispatchCase): void {
		if (placed.has(dispatchCase)) {
			return
		}

		// Marked before the recursion, so a cycle would terminate. None can
		// arise, since it takes two Types each strictly more specific than the
		// other.
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

// `isValueOfType` is true for every value on these, so such a member is the
// last branch, and two can not share one dispatched Union.
function isRuntimeCatchAllType(type: common.Type): boolean {
	return type.type === "GenericUse" || type.type === "Unknown"
}

// An Identifier callee names itself and a `Namespace.method` Lookup spells both
// halves. Any other callee is "This callee"; the Position says which call.
function describeInvocationCallee(name: parser.ExpressionNode): string {
	if (name.nodeType === "Identifier") {
		return `'${name.content}'`
	}

	if (name.nodeType === "Lookup" && name.base.nodeType === "Identifier") {
		return `'${name.base.content}.${name.member.content}'`
	}

	return "This callee"
}

// Whether this is a `Terminal.print` call, which the `Terminal.inspect` Help is
// an edit for. Read off the callee as written, so a renamed `Terminal` gets no
// Help.
function isPrintingCall(name: parser.ExpressionNode): boolean {
	return (
		name.nodeType === "Lookup" &&
		name.base.nodeType === "Identifier" &&
		name.base.content === "Terminal" &&
		name.member.content === "print"
	)
}

function resolveFunctionInvocation(
	node: parser.FunctionInvocationNode,
	nameType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
): {
	type: common.Type
	conformances: Array<common.Conformance>
	// Which Overload the Arguments picked, or null. The simplifier mangles the
	// callee to `__overload$N` with it.
	overloadedMethodIndex: number | null
	omittedParameterIndices: Array<number>
	// Whether a candidate was selected. A lone signature that did not match
	// still answers its return Type, so the validator reports the Argument. The
	// dead-fallback re-probe must not read that as an answer.
	selected: boolean
	// Set by a lone signature, whose Arguments are read as a refused call's
	// only where their count does not pair. Its mismatch is the validator's to
	// report, even where a bound makes the call answer an Error.
	refused?: boolean
} {
	const type = nameType

	if (
		type.type === "Function" ||
		type.type === "SimpleMethod" ||
		type.type === "StaticMethod"
	) {
		let matchableArguments = argumentMatchables(node.arguments, typer)

		// A callee without an `overload` block is a set of one candidate, so
		// both callee shapes take the same path, as a SimpleMethod does.
		let selected = selectOverload(
			[type],
			matchableArguments,
			scope,
			node.position,
			typer,
			0,
			isPrintingCall(node.name),
		)

		if (selected !== undefined) {
			reportUnboundGenerics(
				selected.inferred.unboundGenerics,
				selected.inferred.returnType,
				node.position,
				typer,
				null,
				node.arguments,
			)

			// Held until the candidate was selected, and the call's to report
			// now.
			for (let diagnostic of selected.diagnostics) {
				report(diagnostic)
			}

			return {
				type: selected.inferred.returnType,
				conformances: selected.conformances,
				overloadedMethodIndex: null,
				omittedParameterIndices:
					selected.inferred.omittedParameterIndices,
				selected: true,
			}
		}

		// With one candidate a mismatch is a plain Argument mismatch, which the
		// validator reports. Every Argument is still matched, so a Function
		// literal reads the Parameter at its place rather than reporting as
		// uninferable. A count that does not pair refuses the call.
		// See "Matching Arguments" in packages/compiler/src/helpers/DEVELOPMENT.md.
		let { parameterTypes, context, freshToOriginal } =
			createFreshenedInference(type)
		let paired = pairArguments(parameterTypes, matchableArguments) !== null

		underRefusedCall(!paired, () =>
			matchArguments(
				...pairedByPlace(parameterTypes, matchableArguments),
				{
					collectAllMismatches: true,
					inference: context,
				},
			),
		)

		// A bounded Type Parameter needs a witness, and a call that selected
		// nothing has none. An Error Type says the call never resolved, so the
		// validator reports the Argument mismatch rather than a missing
		// witness.
		let unresolvedBound = type.generics.some(
			(generic) => generic.constraint != null,
		)

		return {
			type: unresolvedBound
				? { type: "Error" }
				: substituteInferredReturnType(
						type,
						unfreshenBindings(context.bindings, freshToOriginal),
					).returnType,
			conformances: [],
			overloadedMethodIndex: null,
			omittedParameterIndices: [],
			selected: false,
			refused: !paired,
		}
	} else if (
		type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod"
	) {
		const matchableArguments = argumentMatchables(node.arguments, typer)

		let selected = selectOverload(
			type.overloads,
			matchableArguments,
			scope,
			node.position,
			typer,
			0,
			isPrintingCall(node.name),
		)

		if (selected !== undefined) {
			reportUnboundGenerics(
				selected.inferred.unboundGenerics,
				selected.inferred.returnType,
				node.position,
				typer,
				null,
				node.arguments,
			)

			// Held until the candidate was selected, and the call's to report
			// now.
			for (let diagnostic of selected.diagnostics) {
				report(diagnostic)
			}

			return {
				type: selected.inferred.returnType,
				conformances: selected.conformances,
				overloadedMethodIndex: selected.index,
				omittedParameterIndices:
					selected.inferred.omittedParameterIndices,
				selected: true,
			}
		}

		let failed = {
			type: { type: "Error" } as const,
			conformances: [],
			overloadedMethodIndex: null,
			omittedParameterIndices: [],
			selected: false,
		}

		// Candidates are listed as this call writes them. A Method reached
		// through its Namespace passes its receiver as an ordinary Argument, so
		// nothing is dropped.
		let callee = describeInvocationCallee(node.name)
		let candidates = type.overloads.map((overload) => ({
			name: callee,
			qualifier: "",
			signature: overload,
			receiverParameters: 0,
		}))
		let measured = typerAroundRefusedFunctions(node.arguments, typer)
		let measuredArguments =
			measured === null
				? matchableArguments
				: argumentMatchables(node.arguments, measured)

		// Refused only for a Function the validator reports where it stands.
		if (
			measured !== null &&
			candidates.some((candidate) =>
				candidateAccepts(candidate, measuredArguments),
			)
		) {
			return failed
		}

		let { labels, notes, helps, data } = overloadRefusalReport(
			refusedCandidates(candidates, measuredArguments),
			measuredArguments,
			node.arguments.map((argument) => argument.value.position),
			{
				position: node.position,
				callee: node.name.position,
				name: callee,
				passed: () =>
					writtenArgumentTypes(node.arguments, measured ?? typer),
				canWait: bodyCanWait(scope),
				barrier: completionBarrierIn(scope),
				holesOnly: (index) =>
					holdsOnlyHoles(node.arguments[index], typer),
			},
		)

		reportError("No overload accepts these Arguments", node.position, {
			code: "no-matching-overload",
			labels,
			notes,
			helps,
			...(data === undefined ? {} : { data }),
		})

		return failed
	} else {
		if (!isReportedValue(type)) {
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
					// The parentheses made this a call, so they are what goes.
					// A Method is the other reading, reached with `::`.
					helps:
						type.type === "Namespace"
							? namespaceCallHelps(
									node,
									type,
									writtenArgumentTypes(node.arguments, typer),
									(receiver) =>
										namespacesTargeting(
											getAllNamespacesInScope(
												scope,
												null,
											),
											receiver,
										).values(),
									typer.expectedType,
								)
							: [
									"Remove the '()' — the name already reads the value.",
									"Or call a Method on it with '::', which is how a Method is reached.",
								],
				},
			)
		}

		return {
			type: { type: "Error" },
			conformances: [],
			overloadedMethodIndex: null,
			omittedParameterIndices: [],
			selected: false,
		}
	}
}

// The label the standard library gives a fallback Argument, as in
// `firstItem(defaultingTo 0)`. Matched by name alone, so a Program's own
// Namespace following the convention counts too.
const fallbackArgumentLabel = "defaultingTo"

// The Argument a dead fallback would be reported on.
function writtenFallbackArgument(
	args: Array<parser.ArgumentNode>,
): parser.ArgumentNode | undefined {
	return args.find(
		(argument) => argument.name?.content === fallbackArgumentLabel,
	)
}

// Whether the bare call could still come back empty: any Case of the builtin
// `Optional` in the answer. A Module's own `choice Optional` is another Choice.
function answersOptional(type: common.Type): boolean {
	if (type.type === "Case") {
		return type.choice === "Optional"
	}

	if (type.type === "UnionType") {
		return flattenUnionMembers(type).some(
			(member) => member.type === "Case" && member.choice === "Optional",
		)
	}

	return false
}

// A Type without its outermost refinement. A nested one promises something
// about the items, not that the answer is there.
function withoutRefinement(type: common.Type): common.Type {
	return type.type === "Refinement" ? type.base : type
}

// Which entry a resolution selected, as one line: Namespace and Overload
// position, one per branch for a dispatched receiver. Two entries can answer
// the same Type and still be different code.
function selectedEntry(
	entries: Array<{
		namespaceName: string
		overloadedMethodIndex: number | null
	}>,
): string {
	return entries
		.map((entry) => `${entry.namespaceName}#${entry.overloadedMethodIndex}`)
		.join("|")
}

// Set while a fallback is re-probed, so a nested call's `defaultingTo` is not
// re-probed from inside; its own enrichment reports on it.
let probingDeadFallback = false

// Set during the second re-probe, which asks what the call answers with no
// proof held. The Argument typer reads it.
let erasingRefinementProof = false

// What one re-probe answered, and which entry answered it.
type ProbedBareAnswer = {
	type: common.Type
	selected: boolean
	entry: string
}

// What the Invocation answers with the `defaultingTo` Argument struck out, or
// null where that says nothing. See "Dead fallbacks" in DEVELOPMENT.md.
function bareAnswerWithoutFallback(
	writtenEntry: string,
	probe: (erasingProof: boolean) => ProbedBareAnswer,
): common.Type | null {
	if (probingDeadFallback) {
		return null
	}

	function ask(erasingProof: boolean): {
		result: ProbedBareAnswer
		diagnostics: Array<common.Diagnostic>
	} {
		probingDeadFallback = true
		erasingRefinementProof = erasingProof

		try {
			return probeContextualFunctionTypes(() =>
				collectDiagnostics(() => probe(erasingProof)),
			).result
		} finally {
			probingDeadFallback = false
			erasingRefinementProof = false
		}
	}

	function answersBare(probed: {
		result: ProbedBareAnswer
		diagnostics: Array<common.Diagnostic>
	}): boolean {
		return (
			probed.result.selected &&
			!containsErrors(probed.diagnostics) &&
			!typeContainsError(probed.result.type) &&
			!answersOptional(probed.result.type)
		)
	}

	let bare = ask(false)

	if (!answersBare(bare) || bare.result.entry === writtenEntry) {
		return null
	}

	if (answersBare(ask(true))) {
		return null
	}

	return bare.result.type
}

// Warns about a `defaultingTo` Argument that can never be read. See "Dead
// fallbacks" in DEVELOPMENT.md.
function reportDeadFallback(
	fallback: parser.ArgumentNode,
	bareType: common.Type,
): void {
	// The label is part of the span, since the Help drops it too.
	let position = {
		start: (fallback.name ?? fallback.value).position.start,
		end: fallback.value.position.end,
	}
	let answer = withArticle(describeType(bareType))

	reportWarning(
		`This '${fallbackArgumentLabel}' Argument can never be read`,
		position,
		{
			code: "fallback-never-used",
			labels: [primary(position, "this fallback can never be read")],
			notes: [
				`Without it the call answers ${answer}, which is never empty.`,
			],
			helps: [
				`Drop the '${fallbackArgumentLabel}' Argument; the call already answers ${answer}.`,
			],
			tags: ["unnecessary"],
		},
	)
}

// A `::` call, including a dispatched Union receiver, and a call with its
// Arguments in parentheses ask the same helper.
function reportDeadFallbackOnMethodInvocation(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
	written: ResolvedMethodInvocation,
): void {
	let fallback = writtenFallbackArgument(node.arguments)

	if (fallback === undefined || typeContainsError(written.type)) {
		return
	}

	let bareType = bareAnswerWithoutFallback(
		methodInvocationEntry(written),
		(erasingProof) => {
			let resolved = resolveMethodInvocation(
				{
					...node,
					arguments: node.arguments.filter(
						(argument) => argument !== fallback,
					),
				},
				// The receiver is the caller's other proof, so the erasing
				// probe widens it to its base.
				erasingProof ? withoutRefinement(baseType) : baseType,
				scope,
				typer,
			)

			// A Method Invocation that resolved to nothing answers an Error
			// Type.
			return {
				type: resolved.type,
				selected: resolved.type.type !== "Error",
				entry: methodInvocationEntry(resolved),
			}
		},
	)

	if (bareType !== null) {
		reportDeadFallback(fallback, bareType)
	}
}

// A dispatched Invocation is named by its branches, any other by its one
// Namespace.
function methodInvocationEntry(resolved: ResolvedMethodInvocation): string {
	return selectedEntry(
		resolved.dispatch ?? [
			{
				namespaceName: resolved.namespace.name,
				overloadedMethodIndex: resolved.overloadedMethodIndex,
			},
		],
	)
}

function reportDeadFallbackOnFunctionInvocation(
	node: parser.FunctionInvocationNode,
	nameType: common.Type,
	scope: enricher.Scope,
	typer: ArgumentTyper,
	resolved: {
		type: common.Type
		selected: boolean
		overloadedMethodIndex: number | null
	},
): void {
	let fallback = writtenFallbackArgument(node.arguments)

	// The written call must have selected something. A lone signature that did
	// not match still answers its return Type, and the validator reports its
	// Arguments.
	if (
		fallback === undefined ||
		!resolved.selected ||
		typeContainsError(resolved.type)
	) {
		return
	}

	// One callee, so the Overload position names the entry. The Arguments are
	// the only proof to erase.
	let bareType = bareAnswerWithoutFallback(
		functionInvocationEntry(resolved.overloadedMethodIndex),
		() => {
			let probed = resolveFunctionInvocation(
				{
					...node,
					arguments: node.arguments.filter(
						(argument) => argument !== fallback,
					),
				},
				nameType,
				scope,
				typer,
			)

			return {
				type: probed.type,
				selected: probed.selected,
				entry: functionInvocationEntry(probed.overloadedMethodIndex),
			}
		},
	)

	if (bareType !== null) {
		reportDeadFallback(fallback, bareType)
	}
}

function functionInvocationEntry(overloadedMethodIndex: number | null): string {
	return selectedEntry([{ namespaceName: "", overloadedMethodIndex }])
}

// Warns where one written Argument fits both the receiver and what it holds, as
// `nested::is(#Empty)` does on an `Optional<Optional<Integer>>`. See "Two
// nesting levels" in DEVELOPMENT.md.
function reportAmbiguousNestingLevel(
	node: parser.MethodInvocationNode,
	receiverType: common.Type,
	overloads: Array<common.BaseFunction>,
	selected: SelectedOverload,
	matchableArguments: Array<MatchableArgument>,
	scope: enricher.Scope,
	typer: ArgumentTyper,
): void {
	let argument = node.arguments[0]
	let selectedOverload = overloads[selected.index]

	// One unlabelled Argument against an Overload with another entry: the two
	// levels are two readings of one written value.
	if (
		overloads.length < 2 ||
		node.arguments.length !== 1 ||
		argument === undefined ||
		argument.name !== null ||
		selectedOverload === undefined
	) {
		return
	}

	let wholeType = soleArgumentType(selectedOverload, selected.inferred)

	if (wholeType === null) {
		return
	}

	// Asked before any probe. It also keeps this off numeric comparisons, since
	// an Integer holds nothing.
	let held = payloadsByCase(wholeType)

	if (held.length === 0) {
		return
	}

	// The entry must take the receiver's own Type, compared both ways.
	if (
		!matchesType(wholeType, receiverType) ||
		!matchesType(receiverType, wholeType)
	) {
		return
	}

	// The written value must read as some Case's payload. What the Program
	// built is compared, since an Error inside an Argument matches anything.
	// Asked before the loop, whose probes are the cost.
	let writtenType = probedArgumentType(matchableArguments, wholeType)

	if (
		writtenType === null ||
		typeContainsError(writtenType) ||
		!held.some(([, payloadType]) => matchesType(payloadType, writtenType))
	) {
		return
	}

	for (let [index, other] of overloads.entries()) {
		if (index === selected.index) {
			continue
		}

		let heldType = probeAcceptedOverload(
			other,
			matchableArguments,
			scope,
			node.position,
			typer,
		)

		if (heldType === null) {
			continue
		}

		// The other entry must take a Case's payload, a second level of the
		// value. Every matching Case is named, since each asks a different
		// question.
		let holding = held.filter(
			([, payloadType]) =>
				matchesType(payloadType, heldType) &&
				matchesType(heldType, payloadType),
		)

		if (holding.length === 0) {
			continue
		}

		// And this entry must take exactly the written value.
		if (!matchesType(heldType, writtenType)) {
			continue
		}

		let position = argument.value.position

		reportWarning(
			"This Argument fits the receiver and what it holds",
			position,
			{
				code: "ambiguous-nesting-level",
				labels: [
					primary(
						position,
						`read as ${withArticle(describeType(wholeType))} here`,
					),
					secondary(
						node.member.position,
						`this takes ${withArticle(describeType(heldType))} as well`,
					),
				],
				notes: [
					"A call reaches the first entry its Arguments fit, and the entry taking the receiver's own Type is written first — so this asks whether the receiver IS the Argument, not whether it holds it.",
					...(holding.length > 1
						? [
								`${holding.length} Cases of the receiver hold ${withArticle(describeType(heldType))}, and each of them is a different question.`,
							]
						: []),
				],
				helps: [
					...holding.map(
						([caseName]) =>
							`Write '#${caseName}(…)' around the Argument to ask whether the receiver holds it.`,
					),
					`Name it in a Constant annotated '${describeType(wholeType)}' to go on asking about the receiver.`,
				],
				data: {
					kind: "holding-case",
					caseNames: holding.map(([caseName]) => caseName),
				},
			},
		)

		return
	}
}

// The Type of an entry's single non-receiver Parameter, as this call bound it,
// or null. An unsolved Type Parameter is no Type to compare.
function soleArgumentType(
	overload: common.BaseFunction,
	inferred: InferredInvocation,
): common.Type | null {
	let parameter = overload.parameterTypes[1]

	if (
		overload.parameterTypes.length !== 2 ||
		parameter === undefined ||
		inferred.unboundGenerics.length > 0
	) {
		return null
	}

	return applyGenericBindings(parameter.type, inferred.bindings)
}

// What each single-member Case of a Choice holds. A payload-free Case holds
// nothing, and a multi-member one holds a Record rather than a level.
function payloadsByCase(type: common.Type): Array<[string, common.Type]> {
	let members = type.type === "UnionType" ? flattenUnionMembers(type) : [type]

	return members.flatMap((member) => {
		if (member.type !== "Case") {
			return []
		}

		let entries = Object.entries(member.members)
		let only = entries[0]

		return entries.length === 1 && only !== undefined
			? [[member.name, only[1]] as [string, common.Type]]
			: []
	})
}

// How many Overload entries the two-level Warning has probed. A spec reads the
// count to hold the check's cost without a clock.
export const nestingLevelProbes = { count: 0 }

// The Parameter Type another entry would read this call's Argument at, where it
// accepts the call as `selectOverload` would, or null. Probed silently, its
// recordings never committed.
function probeAcceptedOverload(
	overload: common.BaseFunction,
	matchableArguments: Array<MatchableArgument>,
	scope: enricher.Scope,
	position: common.Position,
	typer: ArgumentTyper,
): common.Type | null {
	nestingLevelProbes.count += 1

	let { result } = probeContextualFunctionTypes(() =>
		collectDiagnostics(() =>
			probeOverload(overload, matchableArguments, scope, position, typer),
		),
	)
	let probed = result.result

	// None of these rejections can arise from the shapes that reach here: a
	// payload-free Case's Type never matches a sibling Case's payload. They
	// restate `selectOverload`'s contract, so an entry whose bounds refuse the
	// call is never a second reading.
	if (
		probed === undefined ||
		probed.sawErrorArgument ||
		containsErrors(result.diagnostics) ||
		containsErrors(probed.diagnostics)
	) {
		return null
	}

	return soleArgumentType(overload, probed.inferred)
}

// What the one written Argument comes to under the Parameter Type the call
// settled on. Held aside, so the Invocation's own recording and reports are not
// repeated.
function probedArgumentType(
	matchableArguments: Array<MatchableArgument>,
	expectedType: common.Type,
): common.Type | null {
	let argument = matchableArguments[1]

	if (argument === undefined) {
		return null
	}

	return probeContextualFunctionTypes(() =>
		collectDiagnostics(() => argument.getType(expectedType, null)),
	).result.result
}

// Resolves `ChoiceName#CaseName` to the Case's Type. The Choice's name resolves
// through the Type scope, so `type Op = CalculatorOperation` admits `Op#Add`.
function resolveCaseReference(
	choice: parser.IdentifierNode,
	caseName: parser.IdentifierNode,
	scope: enricher.Scope,
): common.CaseType | common.ErrorType {
	let choiceType = findTypeInScope(choice.content, scope)

	if (choiceType === null) {
		// Silent for a Choice whose Declaration the Parser dropped; see
		// `declarationWasAbandoned`.
		if (declarationWasAbandoned(scope, choice.content, choice.position)) {
			return { type: "Error" }
		}

		reportError(
			`Type '${choice.content}' is not declared`,
			choice.position,
			{
				code: "unknown-type",
				labels: [primary(choice.position, "no such Type")],
				...unknownTypeRemedy(choice.content, scope),
			},
		)

		return { type: "Error" }
	}

	if (choiceType.type === "Error") {
		return { type: "Error" }
	}

	// A generic Choice is a Generic Alias over the Union of its Cases, and the
	// declared Case comes from that Union.
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

// Every Type a bare Case was measured against before it failed to resolve, read
// only by the report. Probes leave no recording on failure, so this keeps the
// positions. Keyed on the name Node, and each Type is recorded once, since the
// language server reuses one parse tree on every keystroke.
const expectedChoicesForCase = new WeakMap<
	parser.IdentifierNode,
	Array<common.Type>
>()

function noteExpectedChoice(
	caseName: parser.IdentifierNode,
	expectedType: common.Type,
): void {
	let expectations = expectedChoicesForCase.get(caseName)

	if (expectations === undefined) {
		expectedChoicesForCase.set(caseName, [expectedType])
	} else if (
		!expectations.some((recorded) =>
			isDeepStrictEqual(recorded, expectedType),
		)
	) {
		expectations.push(expectedType)
	}
}

// The Choices a position accepts, grouped by Choice, each with the Cases the
// position accepts rather than the Choice's whole declaration.
function expectedChoicesOf(
	caseName: parser.IdentifierNode,
): Map<string, Array<common.CaseType>> {
	let choices = new Map<string, Array<common.CaseType>>()

	for (let expectation of expectedChoicesForCase.get(caseName) ?? []) {
		for (let member of unionArmsOf(expectation)) {
			if (member.type !== "Case") {
				continue
			}

			let choiceName = displayChoiceName(member.choice)
			let declared = choices.get(choiceName)

			if (declared === undefined) {
				choices.set(choiceName, [member])
			} else if (
				!declared.some((candidate) => candidate.name === member.name)
			) {
				declared.push(member)
			}
		}
	}

	return choices
}

// A Case as a reader would write it at a construction, payload included.
// Several payload members are a Record, `'#Rect({ width, height })'`, since the
// pattern form `'#Rect(width, height)'` is refused there.
const CASE_LIST_CAP = 8

function spelledCases(cases: Array<common.CaseType>): string {
	let spelled = cases.slice(0, CASE_LIST_CAP).map((candidate) => {
		let members = Object.keys(candidate.members)

		return members.length === 0
			? `'#${candidate.name}'`
			: members.length === 1
				? `'#${candidate.name}(${members[0]})'`
				: `'#${candidate.name}({ ${members.join(", ")} })'`
	})

	return cases.length > CASE_LIST_CAP
		? `${spelled.join(", ")} and ${cases.length - CASE_LIST_CAP} more`
		: spelled.join(", ")
}

// A `match` written one level out, whose subject holds the Choice, as a Future
// answering one does. Answered through `heldValuesOf`, as a Method call is, and
// only where the held Type declares the written Case.
function heldCaseSubject(
	valueType: common.Type,
	caseName: string,
	scope: enricher.Scope,
): { notes: Array<string>; helps: Array<string> } {
	for (let held of heldValuesOf(valueType)) {
		let declares = unionArmsOf(held.type).some(
			(member) => member.type === "Case" && member.name === caseName,
		)

		if (!declares) {
			continue
		}

		// Only a body that may wait can write the `complete` the Help asks for;
		// otherwise the Help first declares a `Future` return Type.
		let waits = held.kind !== "future" && held.kind !== "started"

		return {
			notes: [
				`'#${caseName}' is a Case of ${describeType(held.type)}, which is what ${withArticle(describeType(valueType))} holds.`,
			],
			helps: waits
				? [
						`Match what it holds rather than the ${describeType(valueType)} around it.`,
					]
				: bodyCanWait(scope)
					? [
							`Wait for it first — 'constant answered = complete …' — and match 'answered'.`,
						]
					: [
							`Declare the enclosing Function '-> Future<…>', which is what lets its body wait, then wait for it first — 'constant answered = complete …' — and match 'answered'.`,
						],
		}
	}

	return { notes: [], helps: [] }
}

// Whether the subject holds a Union declaring this Case, the rule that decides
// which arm reports and which stay silent.
function holdsCaseNamed(valueType: common.Type, caseName: string): boolean {
	return heldValuesOf(valueType).some((held) =>
		unionArmsOf(held.type).some(
			(member) => member.type === "Case" && member.name === caseName,
		),
	)
}

function resolveBareCaseReference(
	caseName: parser.IdentifierNode,
	scope: enricher.Scope,
	// See `positionWasRefused`. A refused position reports no ambiguity, but a
	// name no Choice declares still reports.
	refusedPosition: boolean = false,
): common.CaseType | common.ErrorType {
	let casesInScope = findCaseTypesInScope(scope)
	let candidates = casesInScope.filter(
		(candidate) => candidate.name === caseName.content,
	)

	if (candidates.length === 1) {
		return declaredCaseOf(candidates[0], scope)
	}

	// A Case dropped with its `choice` block is declared, so writing it is no
	// mistake; see `declarationWasAbandoned`.
	if (declarationWasAbandoned(scope, caseName.content, caseName.position)) {
		return { type: "Error" }
	}

	if (candidates.length === 0) {
		reportUnknownBareCase(caseName, casesInScope)
	} else if (!refusedPosition) {
		reportAmbiguousCase(caseName, candidates, "in scope", scope)
	}

	return { type: "Error" }
}

// Where the position names the Choice, the report is about that Choice: its
// Cases as a note, and the near miss among them. Otherwise it names the Choices
// that declare the near miss.
function reportUnknownBareCase(
	caseName: parser.IdentifierNode,
	casesInScope: Array<common.CaseType>,
): void {
	let expected = expectedChoicesOf(caseName)

	if (expected.size > 0) {
		let choiceNames = [...expected.keys()]
		let accepted = [...expected.values()].flat()

		reportError(
			// One Choice is named outright. Several come from Overload
			// candidates that disagree, so each is a note.
			choiceNames.length === 1
				? `'${choiceNames[0]}' declares no Case '#${caseName.content}'`
				: `No Choice this position accepts declares a Case '#${caseName.content}'`,
			caseName.position,
			{
				code: "unknown-case",
				labels: [primary(caseName.position, "no such Case")],
				notes: [...expected].map(
					([choiceName, cases]) =>
						`This position takes ${withArticle(choiceName)}: ${spelledCases(cases)}.`,
				),
				...caseSuggestion(
					caseName.content,
					accepted.map((candidate) => candidate.name),
				),
			},
		)

		return
	}

	let suggestion = caseSuggestion(
		caseName.content,
		casesInScope.map((candidate) => candidate.name),
	)
	// Which Choices declare the near miss. The Cases themselves are not listed,
	// since the scan covers the whole prelude.
	let declaring =
		suggestion.data?.kind === "suggestion"
			? [
					...new Set(
						casesInScope
							.filter(
								(candidate) =>
									candidate.name ===
									(suggestion.data as { suggestion: string })
										.suggestion,
							)
							.map((candidate) =>
								displayChoiceName(candidate.choice),
							),
					),
				]
			: []

	reportError(
		`No Choice in scope declares a Case '#${caseName.content}'`,
		caseName.position,
		{
			code: "unknown-case",
			labels: [primary(caseName.position, "no such Case")],
			notes: declaring.map(
				(choiceName) =>
					`'${choiceName}' declares '#${(suggestion.data as { suggestion: string }).suggestion}'.`,
			),
			...suggestion,
			helps: [
				...suggestion.helps,
				"Annotate the value, or pass it where a Choice is expected, so the Case resolves against that Choice's own Cases.",
			],
		},
	)
}

// A bare Case resolved against the expected Type of its position, before the
// scope scan. `null` where the position does not decide it.
function resolveCaseInExpectedType(
	caseName: parser.IdentifierNode,
	expectedType: common.Type,
	scope: enricher.Scope,
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
		reportAmbiguousCase(caseName, candidates, "in the expected Type", scope)

		return { type: "Error" }
	}

	return candidates[0]
}

// The payload is read per candidate Case rather than handed over. It is kept
// per candidate, so the winner is committed without a second reading.
type PayloadReader = (under: common.Type) => common.typed.ExpressionNode | null

function resolveCaseValueType(
	node: parser.CaseValueNode,
	scope: enricher.Scope,
	expectedType: common.Type | null = null,
	payloadUnder: PayloadReader = () => null,
): common.CaseType | common.ErrorType {
	if (node.choice === null) {
		let refused = positionWasRefused(expectedType)

		if (expectedType !== null && !refused) {
			let contextual = resolveCaseInExpectedType(
				node.caseName,
				expectedType,
				scope,
			)

			if (contextual !== null) {
				return contextual
			}

			// Kept for the refusal, written where the position is gone; see
			// `expectedChoicesForCase`.
			noteExpectedChoice(node.caseName, expectedType)
		}

		let bareCase = resolveBareCaseReference(node.caseName, scope, refused)

		// A unit Case of a generic Choice has no payload to decide its Type
		// Arguments, so an undecided bare `#Bare` reports as `Holder#Bare`
		// does. A bare form with a payload still decides through it, as in `<-
		// #Done(item)`.
		if (
			bareCase.type === "Case" &&
			bareCase.choiceGenerics !== undefined &&
			Object.keys(bareCase.members).length === 0
		) {
			if (refused) {
				return { type: "Error" }
			}

			return reportUndecidedBareCase(
				`#${node.caseName.content}`,
				bareCase,
				bareCase.choiceGenerics,
				node,
				false,
				scope,
			)
		}

		return bareCase
	}

	return resolvePrefixedCaseValueType(
		node,
		node.choice,
		scope,
		expectedType,
		payloadUnder,
	)
}

// A prefixed construction is decided by its written Type Arguments, then by its
// position. See "Resolving a Case" in DEVELOPMENT.md.
function resolvePrefixedCaseValueType(
	node: parser.CaseValueNode,
	choice: parser.IdentifierNode,
	scope: enricher.Scope,
	expectedType: common.Type | null,
	payloadUnder: PayloadReader,
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

	let aliasGenerics = aliasTypeParameters(choice.content, declaredCase, scope)
	let generics = aliasGenerics ?? declaredCase.choiceGenerics

	if (generics === undefined) {
		return declaredCase
	}

	if (expectedType !== null) {
		let decided = decideCaseFromExpectedType(
			declaredCase,
			expectedType,
			payloadUnder,
			aliasGenerics,
		)

		if (decided !== null) {
			return decided
		}
	}

	if (positionWasRefused(expectedType)) {
		return caseWithBlanks(declaredCase, generics)
	}

	return reportUndecidedTypeArguments(
		`${choice.content}#${node.caseName.content}`,
		choice.content,
		node.caseName.content,
		generics,
		node,
		Object.keys(declaredCase.members).length > 0,
	)
}

// `Holder<Integer>#Full(…)`: Type Arguments written at the value, applied as an
// annotation's are, then the Case picked out. `null` from the lookup means the
// application failed and reported.
function resolveAppliedCase(
	typeArguments: Array<parser.TypeDeclarationNode>,
	declaredCase: common.CaseType,
	choice: parser.IdentifierNode,
	scope: enricher.Scope,
): common.CaseType | common.ErrorType {
	// Looked up raw, so a Generic Alias does not apply its defaults before
	// these Arguments, as in `resolveGenericTypeDeclarationType`.
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

// The instantiation the position decides for a prefixed construction, or `null`
// where it says nothing about this Choice. Several instantiations are chosen
// between by the payload, and the first stands where none fits. Through an
// Alias that writes none of them, it is the Case the payload writes.
function decideCaseFromExpectedType(
	declaredCase: common.CaseType,
	expectedType: common.Type,
	payloadUnder: PayloadReader,
	// Set where the Case is written through a generic Alias of an application.
	aliasGenerics: Array<common.GenericDeclaration> | null,
): common.CaseType | null {
	let candidates = offeredCases(declaredCase, expectedType, aliasGenerics)

	if (candidates.length <= 1) {
		return (
			candidates[0] ??
			payloadCase(declaredCase, expectedType, payloadUnder, aliasGenerics)
		)
	}

	return (
		candidates.find((candidate) => {
			let payload = payloadUnder(candidate)

			if (payload === null) {
				return true
			}

			// A payload that could not be read under a candidate does not fit
			// it, although an Error matches everything elsewhere.
			return (
				!typeContainsError(payload.type) &&
				payloadFitsCase(candidate, payload.type, payload)
			)
		}) ?? candidates[0]
	)
}

// Whether a payload stands for an instantiated Case's Record, as written or
// through the one-member shorthand, so `Box#Full("hello")` picks `Box<String>`.
function payloadFitsCase(
	caseType: common.CaseType,
	payloadType: common.Type,
	// The payload as written, so path keys are measured by the merge and a
	// written member answers a refinement.
	payloadValue: common.typed.ExpressionNode | null,
): boolean {
	let recordShape: common.RecordType = {
		type: "Record",
		members: caseType.members,
	}
	// Each written member is typed as it is admitted, a partial's included.
	let written = admittedMergeValue(recordShape, payloadValue, false)
	let effectiveType =
		mergedRecordType(
			recordShape,
			caseType.payloadDefault?.nesting,
			written,
		) ??
		written?.type ??
		payloadType

	if (matchesType(recordShape, effectiveType)) {
		return true
	}

	// A Case that defaults its payload is fitted as a partial, judged on the
	// payload's Type. Whether the spelling may be partial is
	// `casePayloadIsPartial`'s question.
	if (
		caseType.payloadDefault !== undefined &&
		effectiveType.type === "Record" &&
		isPartialOf(recordShape, effectiveType)
	) {
		return true
	}

	let memberNames = Object.keys(caseType.members)

	if (memberNames.length !== 1) {
		return false
	}

	return (
		matchesType(recordShape, {
			type: "Record",
			members: { [memberNames[0]]: payloadType },
		}) ||
		(payloadValue !== null &&
			admittedTypeOf(
				caseType.members[memberNames[0]]!,
				payloadValue,
				false,
			) !== null)
	)
}

// What a Type offers as its arms, nested Unions spelled out. A Type that is no
// Union is its own only arm.
function unionArmsOf(type: common.Type): Array<common.Type> {
	return type.type === "UnionType" ? flattenUnionMembers(type) : [type]
}

// The subject's own member for a declared Case, with the applied Type Arguments
// substituted, or `null`. The declared Case can not stand in, since its members
// are still the Choice's bounded Type Parameters.
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

// One Matcher for several instantiations of the same Case: each member is
// joined across them, so `@.value` in `Box<Integer> | Box<String>` is
// `Integer | String`. The join keeps no `typeArguments`.
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
		// `unitChoice` is a fact about the declaration, so it survives the
		// join.
		...(instantiations[0].unitChoice === true
			? { unitChoice: true as const }
			: {}),
	}
}

// The Type a value has for one member, asked silently, since a Pattern on a
// Union names members only some arms carry. No arm carrying it answers
// `Unknown`, which `resolvePatternMatcherType` reports as `unknown-member`.
function memberTypeOf(type: common.Type, name: string): common.Type {
	let found: Array<common.Type> = []

	for (let arm of unionArmsOf(type)) {
		// `Object.hasOwn`, so a member named like a prototype property is not
		// read off the prototype.
		if (
			(arm.type === "Record" || arm.type === "Case") &&
			Object.hasOwn(arm.members, name)
		) {
			found.push(arm.members[name]!)
		}
	}

	return found.length === 0 ? { type: "Unknown" } : buildUnion(found)
}

// The Type at the end of a Pattern binding's path, such as
// `["state", "total"]`, walked from the value the Pattern took apart. A bare
// member no arm carries is reported at the member, so it binds the Error Type.
function typeAtPath(type: common.Type, path: Array<string>): common.Type {
	let reached = path.reduce(memberTypeOf, type)

	return reached.type === "Unknown" ? { type: "Error" } : reached
}

// What a value proves by passing a Pattern: each arm that could pass, with the
// required members merged over its own. The emitted test and the bindings both
// read it, so an `as` binder keeps every member the arm proved.
function provenPatternType(
	valueType: common.Type,
	required: common.Type,
): common.Type {
	if (required.type !== "Record") {
		return required
	}

	// A narrowed Record is one the Pattern built, so it drops the Alias
	// spelling the arm had: a shape with extra members is no `Standing`. A Case
	// is nominal and keeps its name.
	let narrowed = unionArmsOf(valueType).flatMap<common.Type>((arm) => {
		if (arm.type === "Record") {
			return [
				{
					type: "Record",
					members: { ...arm.members, ...required.members },
				},
			]
		}

		if (arm.type === "Case") {
			return [
				{ ...arm, members: { ...arm.members, ...required.members } },
			]
		}

		return []
	})

	return narrowed.length === 0 ? required : buildUnion(narrowed)
}

// What a Pattern in Matcher position establishes: every member contributes a
// Type, so `@.name` works in the Handler. `literals` collects the
// value-constrained members keyed by their dotted path, which the rewriter
// walks to build its test. A member no arm declares is refused only when bare.
// See "Matcher Patterns" in DEVELOPMENT.md.
function resolvePatternMatcherType(
	pattern: parser.PatternNode,
	valueType: common.Type,
	scope: enricher.Scope,
	literals: Record<string, common.typed.ExpressionNode>,
	path: Array<string> = [],
	oneShape = false,
): common.Type {
	let members: Record<string, common.Type> = {}

	for (let [name, member] of Object.entries(pattern.members)) {
		let memberPath = [...path, name]
		let carried = memberTypeOf(valueType, name)
		// Decided before a nested Pattern is walked, which would otherwise report
		// its own members against `Unknown`.
		let unknown = isUnknownMember(
			member,
			carried,
			valueType,
			oneShape,
			path,
		)

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
		let memberType: common.Type = unknown
			? { type: "Error" }
			: (declaredType ?? carried)

		if (member.binder?.nodeType === "Pattern") {
			// A written annotation is what the arm narrows to. The nested
			// Pattern's requirements are merged over it, so the arm never runs
			// for a value without the members it reads.
			let nested = resolvePatternMatcherType(
				member.binder,
				memberType,
				scope,
				literals,
				memberPath,
				oneShape,
			)

			members[name] = provenPatternType(memberType, nested)

			continue
		}

		members[name] = memberType
	}

	return { type: "Record", members }
}

// A Pattern member constrained by value can decline, and only a Matcher has a
// next arm to fall through to. A member constrained by Type is an annotation
// and fails as `assignment-type-mismatch`.
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

// What a Pattern binds in a Declaration or Parameter, refused members included,
// so a body reading them is not told again that they are undeclared.
function irrefutablePatternBindings(
	pattern: parser.PatternNode,
): Array<PatternBinding> {
	return [
		...patternBindings(pattern),
		...refutablePatternMembers(pattern).map(({ member, path }) => ({
			name: member.name,
			path,
			// Recovered as if written bare: the path ends at its own name, with
			// no Type.
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

// A binding's value in a Declaration or Parameter: the base Constant read down
// the binding's path. The last step carries the member's span, so renaming the
// member rewrites the member, not the binder.
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
				// The span each step was written at, so the language server
				// indexes each step as its own member.
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

// One name a Matcher brings into scope, with the path from `@` and the Type at
// its end. An empty path is `@` itself, which only a payload's `as` binder is.
type MatcherBinding = {
	name: parser.IdentifierNode
	member: parser.IdentifierNode | null
	path: Array<string>
	// Where each step of the path was written; see `selfPathLookup`.
	stepPositions: Array<common.Position>
	type: common.Type
}

// Every name a Handler's Matcher binds: a Pattern's member names, or a Case
// Matcher's payload binder.
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

	// An unresolved Case was already reported, so what it binds is a hole.
	if (matcher.type !== "Case") {
		return unresolvedCaseBindings(node.binding)
	}

	if (node.binding.nodeType === "Pattern") {
		// Read at what the arm proved, so `case #Some({ value: Integer })`
		// binds an Integer as the equivalent Record Matcher does.
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

	// A binder that is one name names a one-member Case's value. A Case with no
	// members or several has no single value; the Help offers the Pattern form.
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
			// The shorthand's step is not written, so it stands at the binder.
			stepPositions: [binding.position],
			type: matcher.members[memberName]!,
		},
	]
}

// What a Case Matcher's payload Pattern requires, keyed by dotted path, beside
// the Matcher rather than inside it. See "Matcher Patterns" in DEVELOPMENT.md.
type PayloadRequirements = {
	// What the Handler tests, keyed by dotted path.
	memberTypes: Record<string, common.Type> | null
	// What the Handler proved: where the payload Pattern's bindings are read,
	// and at which Type, so a tested `value: Integer` binds an Integer.
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
	)

	if (required.type !== "Record") {
		return {
			...fallback,
			subjectPath: subject.path,
			subjectType: subject.type,
		}
	}

	// The shorthand reading requires its one member to be the Pattern's Record;
	// the Record reading requires each named member. A requirement the declared
	// Type already guarantees is dropped, so naming declared members stays
	// unconditional.
	let requirements: Record<string, common.Type> = {}
	// A member the Case does not declare is always required, since nothing
	// guarantees a payload carries it.
	let require = (path: string, requiredType: common.Type) => {
		let declared = path.split(".").reduce(memberTypeOf, caseType)

		if (
			declared.type === "Unknown" ||
			!matchesType(requiredType, declared)
		) {
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
		// What the arm proved about the payload. The bindings read the narrowed
		// Types, and an `as` binder keeps the members the Pattern did not name.
		subjectType: provenPatternType(subject.type, required),
	}
}

// Which reading a payload Pattern is: the payload Record where the Case carries
// every member the Pattern names, else the one-member shorthand. A misspelt
// payload member keeps the Record. See "Matcher Patterns" in DEVELOPMENT.md.
function payloadPatternSubject(
	pattern: parser.PatternNode,
	matcher: common.CaseType,
): { path: Array<string>; type: common.Type } {
	let [memberName, ...others] = Object.keys(matcher.members)
	let fitsPayloadRecord = Object.keys(pattern.members).every((name) =>
		Object.hasOwn(matcher.members, name),
	)
	let value = memberName === undefined ? null : matcher.members[memberName]!

	if (
		fitsPayloadRecord ||
		value === null ||
		others.length > 0 ||
		misspellsPayloadMember(pattern, matcher, value)
	) {
		return { path: [], type: matcher }
	}

	return { path: [memberName!], type: value }
}

// The Type of each name `patternBindings` brings in. `subjectType` is the Type
// at the end of `prefix`, the unwritten shorthand step, which stands at the
// Matcher's Position.
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

// The Scope a Guard is enriched in when its Handler binds anything. Each name
// is declared, but resolves through `selfMemberAliases` to its path off `@`,
// since the body's Constants do not exist where a Guard runs.
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

// Desugared into the Constants an author could write, such as
// `constant item = @.item` at the head of the arm. The Scope holds the Guard's
// narrowings, while the Statement keeps the Matcher's Type, since refinements
// never reach the emitted Program.
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

// A `Self` Node at the bottom, not an Identifier spelled `@`: inside a lifted
// Handler the subject is the `_self` Parameter.
function selfPathLookup(
	path: Array<string>,
	type: common.Type,
	selfType: common.Type,
	position: common.Position,
	// Where each step was written, where the caller knows. A Guard's lent alias
	// stands for a Lookup nobody wrote, so it has none.
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

// A bare Case Matcher, `case #Add`, resolves against the matched value's own
// Union, so the Case need not be in scope. Two Choices sharing the name ask for
// the prefixed form.
function resolveCaseMatcherType(
	node: parser.CaseMatcherNode,
	valueType: common.Type,
	scope: enricher.Scope,
	heldSubject: { reported: boolean },
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

		// The prefix names the Choice, never its Type Arguments. `@` binds to
		// the matching member of the subject's Union, as the bare form does, so
		// `case Walk#Done` types `@.value` like `case #Done`.
		let instantiated = instantiatedCaseOf(declaredCase, valueType)

		if (instantiated !== null) {
			return instantiated
		}

		// The prefix names a Case the value can not be. Only the name is
		// underlined, so the Quick Fix replaces just the name, and the near
		// miss comes from this Choice's Cases in the Union. A value holding an
		// Error elsewhere may carry no report, so only the Error itself is
		// silent.
		if (valueType.type !== "Error") {
			reportError(
				`The matched value has no Case '${node.choice.content}#${node.caseName.content}'`,
				node.caseName.position,
				{
					code: "unknown-case",
					labels: [
						primary(
							node.caseName.position,
							"no such Case in this Union",
						),
					],
					notes: [`The matched value is ${describeType(valueType)}.`],
					...caseSuggestion(
						node.caseName.content,
						unionArmsOf(valueType).flatMap((member) =>
							member.type === "Case" &&
							member.choice === declaredCase.choice
								? [member.name]
								: [],
						),
					),
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

	// Several candidates of one Choice are instantiations of one Case, which no
	// Matcher tells apart at runtime, so they are joined. Only different
	// Choices are ambiguous.
	if (
		candidates.length > 0 &&
		new Set(candidates.map((candidate) => candidate.choice)).size === 1
	) {
		return joinCaseInstantiations(candidates) ?? { type: "Error" }
	}

	if (candidates.length === 0) {
		// De-duplicated by name, since `A | B` may both declare one Case.
		let memberCaseNames = [
			...new Set(
				members.flatMap((member) =>
					member.type === "Case" ? [member.name] : [],
				),
			),
		]

		// A subject that holds the Choice, as a Future answering one does, is
		// one mistake about the whole Match. The first Case Matcher naming such
		// a Case reports it.
		let held = heldSubject.reported
			? null
			: heldCaseSubject(valueType, node.caseName.content, scope)

		if (held === null && holdsCaseNamed(valueType, node.caseName.content)) {
			return { type: "Error" }
		}

		heldSubject.reported ||= (held?.notes.length ?? 0) > 0

		let suggestion = caseSuggestion(node.caseName.content, memberCaseNames)

		// Only the name is underlined, so a Quick Fix replaces just the name.
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
				notes: [
					...(held?.notes ?? []),
					...(memberCaseNames.length === 0
						? []
						: [
								`The matched value declares ${memberCaseNames
									.map((name) => `'#${name}'`)
									.join(", ")}.`,
							]),
				],
				...suggestion,
				helps: [...(held?.helps ?? []), ...suggestion.helps],
			},
		)
	} else {
		reportAmbiguousCase(
			node.caseName,
			candidates,
			"in the matched Union",
			scope,
		)
	}

	return { type: "Error" }
}

function resolveFunctionValueType(
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

// A Function literal's typed Nodes are built after the match, so the Types its
// omitted annotations resolved to are read back. A literal no call matched is
// resolved here from its own body.
function contextualFunctionTypeOf(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.FunctionType | undefined {
	let recorded = recordedContextualFunctionType(node)

	if (recorded !== undefined && recorded.expectedType !== null) {
		return decidedContextualFunctionType(node, scope, recorded)
	}

	if (!needsContext(node)) {
		return undefined
	}

	return resolveFunctionDefinitionType(node, scope)
}

// The literal resolved again under the finished call's bindings, where they
// close a position the match left open. Silent, since the match already
// reported. See "Probe recordings" in DEVELOPMENT.md.
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

	let expectedFunction = recorded.expectedType
	let decided = applyGenericBindings(expectedFunction, recorded.bindings)

	// Still open, so only the body can decide it, as `map`'s `Result` is
	// decided by the literal.
	if (mentionsUnsolvedTypeParameter(decided)) {
		return recorded.resolved
	}

	let { result } = collectDiagnostics(() =>
		resolveFunctionDefinitionType(
			node,
			scope,
			decided,
			recorded.bindings,
			recorded.declaredReturn === null
				? null
				: { ...expectedFunction, returnType: recorded.declaredReturn },
		),
	)

	return result
}

// What a contextually typed Function literal resolved to, and the position and
// bindings it was resolved against. See "Probe recordings" in DEVELOPMENT.md.
// `expectedType` is null for a literal no call matched.
type RecordedContextualFunctionType = {
	resolved: common.FunctionType
	expectedType: common.FunctionType | null
	bindings: GenericBindings | null
	// The return Type the Parameter declared, its Type Parameters left open.
	declaredReturn: common.Type | null
}

const contextualFunctionTypes = new WeakMap<
	parser.FunctionDefinitionNode,
	RecordedContextualFunctionType
>()

// The Parameter Type an Argument was matched against, for a prefixed Case
// construction that reads its Type Arguments off it, as in `take(Holder#Bare)`.
// It is kept with the call's bindings. See "Probe recordings" in
// DEVELOPMENT.md.
type RecordedCaseValueContext = {
	expectedType: common.Type
	bindings: GenericBindings | null
}

const contextualCaseValueTypes = new WeakMap<
	parser.CaseValueNode,
	RecordedCaseValueContext
>()

// The position a member path was matched against, kept as a Case construction's
// is.
const contextualMemberPathTypes = new WeakMap<
	parser.MemberPathNode,
	RecordedCaseValueContext
>()

// What one probe of a candidate resolved for the Nodes that read their
// position. Each is right only for the winner, so all are held and committed
// together.
type ContextualFunctionTypeRecording = {
	functions: Map<
		parser.FunctionDefinitionNode,
		RecordedContextualFunctionType
	>
	cases: Map<parser.CaseValueNode, RecordedCaseValueContext>
	paths: Map<parser.MemberPathNode, RecordedCaseValueContext>
	// A candidate's decisions for its Argument Nodes, held as the work, since
	// the Node belongs to the typer of the Invocation being probed. See
	// `decideWrittenArguments`.
	decided: Array<() => void>
}

// The recordings of the probes running, innermost last. See "Probe recordings"
// in DEVELOPMENT.md.
let probeRecordings: Array<ContextualFunctionTypeRecording> = []

// A nested probe records into the enclosing probe's recording, so a losing
// outer candidate discards it.
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

// Innermost first, then the committed record.
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

// The same rail for a decision written onto an Argument Node.
export function recordDecidedArgument(decide: () => void): void {
	let innermost = probeRecordings[probeRecordings.length - 1]

	if (innermost === undefined) {
		decide()
	} else {
		innermost.decided.push(decide)
	}
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

function recordContextualMemberPathType(
	node: parser.MemberPathNode,
	recorded: RecordedCaseValueContext,
): void {
	let innermost = probeRecordings[probeRecordings.length - 1]

	if (innermost === undefined) {
		contextualMemberPathTypes.set(node, recorded)
	} else {
		innermost.paths.set(node, recorded)
	}
}

// The recorded position with the call's bindings substituted: the Function the
// finished call decided the path stands for. An unbound Type Parameter stays,
// and the call reports it.
function recordedMemberPathType(
	node: parser.MemberPathNode,
): common.Type | null {
	for (let index = probeRecordings.length - 1; index >= 0; index--) {
		let recorded = probeRecordings[index].paths.get(node)

		if (recorded !== undefined) {
			return decidedContext(recorded)
		}
	}

	let recorded = contextualMemberPathTypes.get(node)

	return recorded === undefined ? null : decidedContext(recorded)
}

function decidedContext(recorded: RecordedCaseValueContext): common.Type {
	return recorded.bindings === null
		? recorded.expectedType
		: applyGenericBindings(recorded.expectedType, recorded.bindings)
}

// The recorded Parameter Type with the call's bindings substituted. An unbound
// Type Parameter stays, which `mentionsUnsolvedTypeParameter` detects and the
// call reports.
function recordedContextualCaseValueType(
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

export function probeContextualFunctionTypes<Result>(probe: () => Result): {
	result: Result
	recording: ContextualFunctionTypeRecording
} {
	let recording: ContextualFunctionTypeRecording = {
		functions: new Map(),
		cases: new Map(),
		paths: new Map(),
		decided: [],
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

	for (let [node, recorded] of recording.paths) {
		recordContextualMemberPathType(node, recorded)
	}

	for (let decide of recording.decided) {
		recordDecidedArgument(decide)
	}
}

// Enriches under a recording that is not the committed one, as a dispatch
// branch does for its copy of a literal. A copy is pushed, so what the copy's
// body records is dropped with it.
function withContextualFunctionTypes<Result>(
	recording: ContextualFunctionTypeRecording,
	work: () => Result,
): Result {
	probeRecordings.push({
		functions: new Map(recording.functions),
		cases: new Map(recording.cases),
		paths: new Map(recording.paths),
		decided: [...recording.decided],
	})

	try {
		return work()
	} finally {
		probeRecordings.pop()
	}
}

// The Function literals whose return Type could not be read off their body. The
// call around one stays silent about the consequences, such as an unbound
// `Other` of `Result::andThen`. Kept per parser Node in a WeakSet.
let literalsAnsweringNothing = new WeakSet<parser.FunctionDefinitionNode>()

// Whether the body's last line is a value rather than a `<-`, the usual cause.
// Everything that is no Statement form is an Expression.
function endsInAnUnreturnedValue(
	body: Array<parser.ImplementationNode>,
): boolean {
	let last = body.at(-1)

	if (last === undefined) {
		return false
	}

	switch (last.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
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
		case "ExpectStatement":
		case "RequireStatement":
			return false
		default:
			return true
	}
}

// The annotation a literal outside Argument position has to write, spelled from
// its body where it can be. A nested Function, an Unknown or a value already
// reported can not be typed back in, so a schematic stands there. Inside
// another literal's inference the report is dropped, so the body is not read.
function returnTypeHelp(
	node: parser.FunctionDefinitionNode,
	parameterTypes: Array<common.Parameter>,
	scope: enricher.Scope,
): string {
	let inferred =
		inferReturnTypeFromBodyDepth > 0
			? null
			: inferReturnTypeFromBody(node, parameterTypes, scope)
	let spelling =
		inferred === null || isReportedValue(inferred)
			? null
			: describeType(inferred)

	return spelling === null ||
		spelling.includes("…") ||
		spelling.includes("Unknown")
		? "Write the return Type after the Parameter list — '-> <Type>', naming what this body's '<-' answers with."
		: `Write the return Type after the Parameter list — '-> ${spelling}', which is what this body answers with.`
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

	// A Parameter that could not be inferred was already reported.
	if (parameterTypes.some((parameter) => parameter.type.type === "Error")) {
		return { type: "Error" }
	}

	// Without an expected signature only the body could say what this returns,
	// which is hard to follow across a Program. Only a literal in Argument
	// position may omit `-> Type`. One passed to a refused call is silent; see
	// `callRefused`.
	if (expectedFunction === null) {
		if (!insideRefusedCall()) {
			reportError(
				"This Function must write its return Type",
				node.parameterListPosition,
				{
					code: "missing-return-type",
					labels: [
						primary(
							node.parameterListPosition,
							"no '-> Type' here",
						),
					],
					notes: [
						"Only a Function passed as an Argument takes its Types from the surrounding context.",
					],
					// Read once in the Scope the literal stands in.
					helps: [
						returnTypeHelpIn(node, scope.parent ?? scope, () =>
							returnTypeHelp(node, parameterTypes, scope),
						),
					],
				},
			)
		}

		return { type: "Error" }
	}

	// An expected return Type the call has not solved is read off the body, as
	// for `map`'s `Result`. A Type Parameter of an enclosing Namespace or
	// Function is a decision. See "Return Type inference from a body" in
	// DEVELOPMENT.md.
	if (mentionsUnsolvedTypeParameter(expectedFunction.returnType)) {
		let refused = { body: false }
		let inferred = inferReturnTypeFromBody(
			node,
			parameterTypes,
			scope,
			refused,
		)

		if (inferred !== null) {
			return inferred
		}

		// A body refused in its own right is answered where it was refused.
		if (refused.body) {
			return { type: "Error" }
		}

		// The first Parameter, or the empty list of a literal with none.
		let position =
			node.parameters[0]?.position ?? node.parameterListPosition
		let message = "The return Type could not be inferred from the body"
		// A missing `<-` is the usual cause, so the Help names it first. Only
		// `-> {}` fits a body that returns nothing, and any other annotation
		// would move the report to `missing-return`.
		let helps = endsInAnUnreturnedValue(node.body)
			? [
					"Return the value with '<-' — a body whose last line is a value answers with nothing.",
					"Or, where the body is meant to answer nothing, write '-> {}' after its Parameter list.",
				]
			: ["Give the Function an explicit '-> Type'."]

		literalsAnsweringNothing.add(node)

		reportError(message, position, {
			code: "uninferable-return-type",
			labels: [
				primary(position, "the body's Type is not determined here"),
			],
			helps,
		})

		return { type: "Error" }
	}

	return expectedFunction.returnType
}

// What a Type Alias means, `where` clause included. The predicate is enriched
// on every call and never kept, since an early hoisting round may read it
// before the Namespace answering it exists.
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

	// A refused clause leaves the Alias meaning what it would without one. A
	// generic Alias keeps its wrapper, so `NonEmptyList<String>` still takes
	// Arguments.
	if (conjuncts === null) {
		return type.type === "GenericAlias"
			? { ...type, aliasedType: refinement.base }
			: refinement.base
	}

	refinement.conjuncts = conjuncts

	return type
}

// The Refinement a skeleton hoisted with its predicate unread, or null. A
// generic refined Alias wraps it, so this looks inside the wrapper.
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

// The Scope a refined Alias' predicate resolves in, with a generic one's Type
// Parameters as opaque uses. See "Reading a refined Alias" in DEVELOPMENT.md.
export function refinementPredicateScope(
	node: parser.TypeAliasStatementNode,
	scope: enricher.Scope,
): enricher.Scope {
	return node.generics.length === 0
		? scope
		: scopeWithGenerics(node.generics, scope)
}

// The Alias' Type without its predicate, the half hoisting can always resolve.
// See "Reading a refined Alias" in DEVELOPMENT.md.
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

// The Scope a predicate is read in: `@` bound to the base as a Constant, in a
// child Scope.
function scopeWithRefinedSelf(
	base: common.Type,
	scope: enricher.Scope,
): enricher.Scope {
	return declareVariableInScope(
		"@",
		base,
		childScope(scope, { isRefinementPredicate: true }),
		true,
	)
}

// The refusals that need no predicate. Each reports before it answers false.
function refinementSkeletonAdmissible(
	node: parser.TypeAliasStatementNode,
	aliasedType: common.Type,
): boolean {
	// A poisoned base was already reported, so it is refused silently.
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
					"A checked refinement is written on an Integer, a Rational, a String, an applied List or an applied Dictionary — 'List<String>', never a bare 'List'.",
				],
				// Dropping the clause answers a different Declaration, so the
				// Help says what it costs. The other Help names the bases that
				// can carry the clause.
				helps: [
					`Drop the 'where' clause from '${node.name.content}', which leaves the Alias naming ${described} and nothing more.`,
					"Or write the refinement on a base one can be checked against — an Integer, a Rational, a String, an applied List or an applied Dictionary.",
				],
			},
		)

		return false
	}

	return true
}

// The predicate read at last, once the answering Namespace is in Scope. Null
// when the clause is refused, and every refusal is reported.
export function resolveRefinementConjuncts(
	predicateNode: parser.ExpressionNode,
	base: common.Type,
	scope: enricher.Scope,
): Array<common.PredicateConjunct> | null {
	let predicate = enrichExpression(
		predicateNode,
		scopeWithRefinedSelf(base, scope),
	)

	// As `validateCondition` asks of an `if`. An Error was already reported.
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
					// A predicate is one call on `@`, so the Help names a
					// Boolean Method the base has.
					helps: [
						`Call a Method on '@' that answers a Boolean — '@::${booleanQuestionFor(base)}', for instance.`,
					],
				},
			)
		}

		return null
	}

	let conjuncts = extractPredicateConjuncts(predicate, scope)

	if (conjuncts === null) {
		return null
	}

	return canonicalPredicateConjuncts(conjuncts)
}

// The bases a `where` clause may refine. See "Reading a refined Alias" in
// DEVELOPMENT.md.
function isRefinableBase(type: common.Type): boolean {
	return (
		type.type === "Integer" ||
		type.type === "Rational" ||
		type.type === "String" ||
		type.type === "List" ||
		type.type === "Dictionary"
	)
}

// An anonymous Union takes the Alias' own name, so the borrowed name is dropped
// and the members are spelled out.
function describeRefinementBase(type: common.Type): string {
	return type.type === "UnionType" && type.name !== undefined
		? describeType({ ...type, name: undefined })
		: describeType(type)
}

// The conjunct set a typed predicate spells, or null after a report. See
// "Reading a refined Alias" in DEVELOPMENT.md.
function extractPredicateConjuncts(
	predicate: common.typed.ExpressionNode,
	scope: enricher.Scope,
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
		let left = extractPredicateConjuncts(predicate.base, scope)
		let right = extractPredicateConjuncts(
			predicate.arguments[0].value,
			scope,
		)

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

	return [resolvedConjunct(predicate, args, scope)]
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

// #region Predicate Aliases

// One predicate leaf as the question it asks, with the call's Arguments
// substituted into an alias template. See "Predicate aliases" in
// DEVELOPMENT.md.
function resolvedConjunct(
	invocation: common.typed.MethodInvocationNode,
	args: Array<string | boolean>,
	scope: enricher.Scope,
): common.PredicateConjunct {
	let spelling: common.PredicateSpelling = {
		methodName: invocation.member.name,
		// The label rides with its scalar for printing only, since a guard is
		// written as the text reads; the conjunct's `args` are the key.
		args: args.map((value, index) => {
			let label = invocation.arguments[index]?.name

			return label == null ? value : { label, value }
		}),
	}
	let alias = predicateAliasOf(invocation)
	// The receiver's base Type, unwrapped, decides how a bound is spelled, so a
	// `where` clause and an `if` key alike.
	let tag = refinableBaseTag(invocation.base.type)
	// A Method whose body says nothing is its own leaf.
	let written: common.PredicateConjunct = {
		namespaceName: invocation.namespace.name,
		methodName: spelling.methodName,
		args,
		negated: false,
	}
	let resolved =
		alias === undefined
			? null
			: aliasLeafOf(alias, invocation.namespace.name, args)

	// The leaf is followed further here: a Protocol requirement may have a
	// conformer's body, and a body read before its target recorded only the
	// name.
	if (resolved !== null) {
		resolved = collapsedLeaf(resolved, scope)
	}

	return { ...forNumericBase(resolved ?? written, tag), spelling }
}

// A leaf followed to the end of what it names. A leaf coming back round is
// returned as it arrived, since two Methods written as each other's contraries
// say nothing.
function collapsedLeaf(
	leaf: common.PredicateConjunct,
	scope: enricher.Scope,
): common.PredicateConjunct {
	let current = leaf
	let seen = new Set<string>([`${leaf.namespaceName}::${leaf.methodName}`])

	for (;;) {
		let next = throughWitness(current, scope)

		if (next === null) {
			return current
		}

		let key = `${next.namespaceName}::${next.methodName}`

		if (seen.has(key)) {
			return leaf
		}

		seen.add(key)
		current = next
	}
}

// The leaf one Method's own reading names, or null: `Ranked::isAtMost` is
// written on `Self::isAbove`, which a conformer writes. An Overloaded Method
// ends the walk, since a leaf's scalars can not choose an entry.
function throughWitness(
	leaf: common.PredicateConjunct,
	scope: enricher.Scope,
): common.PredicateConjunct | null {
	let namespaceType = namespaceNamedInScope(leaf.namespaceName, scope)
	let method = namespaceType?.methods[leaf.methodName]

	if (
		method?.type !== "SimpleMethod" ||
		method.predicateAlias === undefined
	) {
		return null
	}

	let resolved = aliasLeafOf(
		method.predicateAlias,
		leaf.namespaceName,
		leaf.args,
	)

	return resolved === null
		? null
		: { ...resolved, negated: resolved.negated !== leaf.negated }
}

// The Namespace a name stands for, or null. A Namespace is declared as a
// member.
function namespaceNamedInScope(
	name: string,
	scope: enricher.Scope,
): common.NamespaceType | null {
	let declaring = findDeclaringScope(name, scope)
	let member = declaring?.members[name]

	return member?.type === "Namespace" ? member : null
}

// The leaf an alias stands for at this call: the template with the caller's
// Arguments in its slots. `null` where a slot has no Argument, which can not
// happen, since defaulted Methods are never read.
function aliasLeafOf(
	alias: common.PredicateAlias,
	witnessName: string,
	args: Array<string | boolean>,
): common.PredicateConjunct | null {
	let resolved: Array<string | boolean> = []

	for (let slot of alias.args) {
		if (slot.kind === "Literal") {
			resolved.push(slot.value)

			continue
		}

		let given = args[slot.index]

		if (given === undefined) {
			return null
		}

		resolved.push(given)
	}

	return {
		namespaceName: alias.namespaceName ?? witnessName,
		methodName: alias.methodName,
		args: resolved,
		negated: alias.negated,
	}
}

// The leaf a Rational receiver asks, spelled one way. A Program's own
// Namespace, such as a `Frac::isHalf`, keeps its spelling. See "Predicate
// aliases" in DEVELOPMENT.md.
function forNumericBase(
	leaf: common.PredicateConjunct,
	tag: string,
): common.PredicateConjunct {
	if (tag !== "Rational" || !answersForBase(leaf, tag)) {
		return leaf
	}

	return {
		...leaf,
		namespaceName: "Rational",
		args: leaf.args.map(rationalBound),
	}
}

// A bare run of digits as its Rational; anything else as written.
function rationalBound(scalar: string | boolean): string | boolean {
	return typeof scalar === "string" && /^-?\d+$/.test(scalar)
		? reducedRationalSpelling(scalar, "1")
		: scalar
}

// The alias recorded on the entry this call resolved to. The Namespace Type on
// the Invocation is the object hoisting registered, so it carries the
// annotation.
function predicateAliasOf(
	invocation: common.typed.MethodInvocationNode,
): common.PredicateAlias | undefined {
	return resolvedEntryOf(invocation)?.predicateAlias
}

// The one signature a Method call settled on.
function resolvedEntryOf(
	invocation: common.typed.MethodInvocationNode,
): common.BaseFunction | undefined {
	let method = invocation.namespace.type.methods[invocation.member.name]

	if (method === undefined) {
		return undefined
	}

	if (method.type === "SimpleMethod") {
		return method
	}

	if (method.type !== "OverloadedMethod") {
		return undefined
	}

	return invocation.overloadedMethodIndex === null
		? undefined
		: method.overloads[invocation.overloadedMethodIndex]
}

// The converse of each ordering, so `<- other::isGreaterThanOrEqualTo(@)` reads
// as `@::isLessThanOrEqualTo(other)`. Believed only under the guard
// `impliedConjunctKeys` uses.
const CONVERSE_COMPARISONS: ReadonlyMap<string, string> = new Map([
	["is", "is"],
	["isNot", "isNot"],
	["isLessThan", "isGreaterThan"],
	["isGreaterThan", "isLessThan"],
	["isLessThanOrEqualTo", "isGreaterThanOrEqualTo"],
	["isGreaterThanOrEqualTo", "isLessThanOrEqualTo"],
])

// An Argument slot while a body is read. `Self` is `@` handed on, which only a
// converse can turn back into a slot.
type DerivedArgument = common.PredicateAliasArgument | { kind: "Self" }

// One step of the reading: the call a body makes, before its target is folded
// in.
type AliasStep = {
	namespaceName: string | null
	methodName: string
	args: Array<DerivedArgument>
	negated: boolean
}

// One Method read as an alias. `target` is the entry the body's call resolved
// to, and `converse` the Parameter a flipped call was made on.
type AliasCandidate = {
	methodName: string
	entry: common.BaseFunction
	step: AliasStep
	target: common.BaseFunction | null
	converse: number | null
	converseTrusted: boolean
}

// What the reading needs of the declaring Namespace or Protocol.
// `selfNamespaceName` is null for a Protocol, whose witness fills it in.
type AliasContainer = {
	selfNamespaceName: string | null
	trustsOrdering: boolean
	// `Self` while a Protocol's provided body is read: the Type Parameter
	// bounded by the Protocol.
	selfType?: common.Type
	canonicalTarget?: (methodName: string) => common.BaseFunction | null
}

// What one body came to. `Unresolved` is offered again in a later round; `None`
// is settled.
type AliasReading =
	| { kind: "Alias"; candidate: AliasCandidate }
	| { kind: "None" }
	| { kind: "Unresolved" }

const NO_ALIAS: AliasReading = { kind: "None" }
const UNRESOLVED_ALIAS: AliasReading = { kind: "Unresolved" }

// Reads a Namespace's predicate aliases as it reaches Scope. See "Predicate
// aliases" in DEVELOPMENT.md.
export function derivePredicateAliases(
	node: parser.NamespaceDefinitionStatementNode,
	namespaceType: common.NamespaceType,
	scope: enricher.Scope,
): boolean {
	let targetType = namespaceType.targetType

	if (targetType === null) {
		return true
	}

	let container: AliasContainer = {
		selfNamespaceName: namespaceType.name,
		// The ordering is the base's promise, believed only where the Namespace
		// is the base's own or `Number`.
		trustsOrdering: namespaceAnswersForBase(
			namespaceType.name,
			refinableBaseTag(targetType),
		),
	}
	let candidates: Array<AliasCandidate> = []
	let complete = true

	for (let [methodName, method] of Object.entries(node.methods)) {
		for (let [index, value] of methodEntries(method).entries()) {
			// A body-less entry of a mixed `overload` block keeps its position.
			if (value === null) {
				continue
			}

			let entry = booleanEntryOf(namespaceType, methodName, index)
			let body = aliasBodyOf(value.value)

			if (entry === null || body === null) {
				continue
			}

			let reading = aliasCandidateOf(
				body,
				value.value,
				entry,
				methodName,
				scope,
				container,
			)

			if (reading.kind === "Alias") {
				candidates.push(reading.candidate)
			} else if (reading.kind === "Unresolved") {
				complete = false
			}
		}
	}

	writePredicateAliases(candidates, container)

	return complete
}

// Reads a Protocol's provided predicate aliases as it reaches Scope. See
// "Predicate aliases" in DEVELOPMENT.md.
export function deriveProvidedPredicateAliases(
	node: parser.ProtocolDeclarationStatementNode,
	protocolType: common.ProtocolType,
	scope: enricher.Scope,
): boolean {
	let selfType: common.GenericUse = {
		type: "GenericUse",
		name: "Self",
		constraint: protocolType.identity,
	}
	let container: AliasContainer = {
		selfNamespaceName: null,
		selfType,
		// A Protocol's `Self` is no base, so no ordering is trusted.
		trustsOrdering: false,
		canonicalTarget: (methodName) => {
			let target = protocolType.methods[methodName]

			return target?.type === "SimpleMethod" ? target : null
		},
	}
	let bodyScope: enricher.Scope | null = null
	let candidates: Array<AliasCandidate> = []
	let complete = true

	for (let [methodName, method] of Object.entries(node.methods)) {
		let body = protocolMethodBody(method)
		let entry = protocolType.methods[methodName]

		if (
			body === null ||
			entry?.type !== "SimpleMethod" ||
			entry.returnType.type !== "Boolean" ||
			providedMethodProtocol(protocolType, methodName) !==
				protocolType.identity
		) {
			continue
		}

		let shape = aliasBodyOf(body.value)

		if (shape === null) {
			continue
		}

		bodyScope ??= childScope(scope, {
			types: { Self: selfType },
			providedMethodOf: protocolType.identity,
		})

		let reading = aliasCandidateOf(
			shape,
			body.value,
			entry,
			methodName,
			bodyScope,
			container,
		)

		if (reading.kind === "Alias") {
			candidates.push(reading.candidate)
		} else if (reading.kind === "Unresolved") {
			complete = false
		}
	}

	writePredicateAliases(candidates, container)

	return complete
}

// A Method's bodied entries in Overload order, null for an entry without a
// body. In a `declarations { … }` Program an `overload` block parses as
// signatures, so its bodied entries are read here. Static Methods are skipped.
function methodEntries(
	method: parser.NamespaceMethods[string],
): Array<parser.FunctionValueNode | null> {
	switch (method.nodeType) {
		case "SimpleMethod":
			return [method.method]
		case "OverloadedMethod":
			return method.methods
		case "OverloadedMethodSignatures":
			return method.methods.map((entry) =>
				entry.nodeType === "FunctionValue" ? entry : null,
			)
		default:
			return []
	}
}

// The resolved entry at this position, where it answers a Boolean.
function booleanEntryOf(
	namespaceType: common.NamespaceType,
	methodName: string,
	index: number,
): common.BaseFunction | null {
	let method = namespaceType.methods[methodName]
	let entry =
		method === undefined
			? undefined
			: method.type === "SimpleMethod"
				? method
				: method.type === "OverloadedMethod"
					? method.overloads[index]
					: undefined

	return entry !== undefined && entry.returnType.type === "Boolean"
		? entry
		: null
}

// The call an alias body makes and whether it is negated: a `<-` of a Method
// call, or the `if` spelling one. A chain is a leaf of its own. The receiver
// may be a name where the ordering is written backwards.
function aliasBodyOf(
	definition: parser.FunctionDefinitionNode,
): AliasBody | null {
	if (definition.body.length !== 1) {
		return null
	}

	let statement = definition.body[0]!

	if (statement.nodeType === "ReturnStatement") {
		return aliasCallOf(statement.expression)
	}

	return statement.nodeType === "IfElseStatement"
		? aliasIfShapeOf(statement)
		: null
}

// A body as the reading enriches it, `::negate()` included. `peeled` records
// that a trailing `negate` was found by shape; whose it is is settled later.
type AliasBody = {
	expression: parser.ExpressionNode
	peeled: boolean
	negated: boolean
}

// A Method call with an outermost `::negate()` found by shape. The Expression
// is kept whole, so a Program's own `negate` is not taken for Boolean's.
function aliasCallOf(expression: parser.ExpressionNode): AliasBody | null {
	let call = expression
	let peeled = false

	if (
		call.nodeType === "MethodInvocation" &&
		call.member.content === "negate" &&
		call.arguments.length === 0
	) {
		peeled = true
		call = call.base
	}

	return call.nodeType === "MethodInvocation" &&
		(call.base.nodeType === "Self" || call.base.nodeType === "Identifier")
		? { expression, peeled, negated: peeled }
		: null
}

// `if @::is(other) { <- false } else { <- true }`, a call spelled as its two
// answers, which is how `Equatable::isNot` is written. See "The shape of the
// graph is frozen" in packages/standard-library/DEVELOPMENT.md.
function aliasIfShapeOf(
	statement: parser.IfElseStatementNode,
): AliasBody | null {
	let answered = returnedBooleanOf(statement.trueBody)
	let otherwise = returnedBooleanOf(statement.falseBody)

	if (answered === null || otherwise === null || answered === otherwise) {
		return null
	}

	let call = aliasCallOf(statement.condition)

	return call === null
		? null
		: { ...call, negated: call.negated !== !answered }
}

// The one written Boolean a branch answers, or null.
function returnedBooleanOf(
	body: Array<parser.ImplementationNode>,
): boolean | null {
	let statement = body.length === 1 ? body[0]! : null

	if (statement === null || statement.nodeType !== "ReturnStatement") {
		return null
	}

	return statement.expression.nodeType === "BooleanValue"
		? statement.expression.value
		: null
}

// One Method read as an alias of another, or a reason it can not be. Enriched
// silently, since the real enrichment reports later. The Parameters come from
// the resolved signature.
function aliasCandidateOf(
	body: AliasBody,
	definition: parser.FunctionDefinitionNode,
	entry: common.BaseFunction,
	methodName: string,
	scope: enricher.Scope,
	container: AliasContainer,
): AliasReading {
	// A Parameter list the signature disagrees with was never resolved.
	if (entry.parameterTypes.length !== definition.parameters.length + 1) {
		return NO_ALIAS
	}

	// A Method with a defaulted Parameter is not read: slots are declared
	// positions, while a call counts written Arguments.
	if (
		definition.parameters.some(
			(parameter) => parameter.defaultValue !== null,
		)
	) {
		return NO_ALIAS
	}

	let reading: {
		result: common.typed.ExpressionNode
		diagnostics: Array<common.Diagnostic>
	}

	// A body checking against a pending refinement is offered again later.
	try {
		reading = collectDiagnostics(() =>
			enrichExpression(
				body.expression,
				aliasBodyScope(definition, entry, scope, container),
			),
		)
	} catch (error) {
		if (error instanceof NotHoistedYet) {
			return UNRESOLVED_ALIAS
		}

		throw error
	}

	let { result, diagnostics } = reading

	// An unresolved call names a Namespace not hoisted yet, so the reading is
	// offered again.
	if (containsErrors(diagnostics)) {
		return UNRESOLVED_ALIAS
	}

	// The trailing `::negate()` comes off only if it resolved to `Boolean`'s
	// own.
	let call = body.peeled ? peeledNegationOf(result, scope) : result

	if (
		call === null ||
		call.nodeType !== "MethodInvocation" ||
		call.type.type !== "Boolean"
	) {
		return NO_ALIAS
	}

	let slots = parameterSlotsOf(definition)
	let args: Array<DerivedArgument> = []

	for (let argument of call.arguments) {
		let slot = argumentSlotOf(argument.value, slots)

		if (slot === null) {
			return NO_ALIAS
		}

		args.push(slot)
	}

	let converse = converseReceiverOf(call, args, slots)

	if (call.base.nodeType !== "Self" && converse === null) {
		return NO_ALIAS
	}

	return {
		kind: "Alias",
		candidate: {
			methodName,
			entry,
			step: {
				namespaceName:
					container.selfNamespaceName === null
						? null
						: call.namespace.name,
				methodName: call.member.name,
				args,
				negated: body.negated,
			},
			target:
				container.canonicalTarget?.(call.member.name) ??
				resolvedEntryOf(call) ??
				null,
			converse,
			converseTrusted:
				container.trustsOrdering &&
				namespaceAnswersForBase(
					call.namespace.name,
					refinableBaseTag(call.base.type),
				),
		},
	}
}

// What a trailing `::negate()` was written on, or null where it is not
// `Boolean`'s `negate`.
function peeledNegationOf(
	result: common.typed.ExpressionNode,
	scope: enricher.Scope,
): common.typed.ExpressionNode | null {
	if (
		result.nodeType !== "MethodInvocation" ||
		result.arguments.length !== 0
	) {
		return null
	}

	let negate = namespaceNamedInScope("Boolean", scope)?.methods["negate"]

	return negate?.type === "SimpleMethod" && resolvedEntryOf(result) === negate
		? result.base
		: null
}

// The Scope an alias body is read in, built from the resolved signature, where
// an enclosing Namespace's Type Parameters are merged with the Method's.
function aliasBodyScope(
	definition: parser.FunctionDefinitionNode,
	entry: common.BaseFunction,
	scope: enricher.Scope,
	container: AliasContainer,
): enricher.Scope {
	let types: Record<string, common.Type> = {}
	let bindings: GenericBindings = new Map()

	// The Method's own bound is put on the receiver's item Type too, so a call
	// binding the items off `@` gets the bounded Parameter.
	for (let generic of entry.generics) {
		let use: common.GenericUse = {
			type: "GenericUse",
			name: generic.name,
			...(generic.constraint == null
				? {}
				: { constraint: generic.constraint }),
		}

		types[generic.name] = use
		bindings.set(generic.name, use)
	}

	if (container.selfType !== undefined) {
		bindings.set("Self", container.selfType)
	}

	let bodyScope = childScope(scope, { types })

	declareVariableInScope(
		"@",
		aliasBodyType(entry.parameterTypes[0]?.type, bindings),
		bodyScope,
		true,
	)

	for (let [index, parameter] of definition.parameters.entries()) {
		let name = parameterInternalName(parameter)
		let type = entry.parameterTypes[index + 1]?.type

		// A Parameter taken apart by a Pattern binds no one name, so the
		// reading refuses.
		if (name !== null && type !== undefined) {
			declareVariableInScope(
				name,
				aliasBodyType(type, bindings),
				bodyScope,
				true,
			)
		}
	}

	return bodyScope
}

// A signature's Type with the bindings applied, untouched when there are none.
function aliasBodyType(
	type: common.Type | undefined,
	bindings: GenericBindings,
): common.Type {
	if (type === undefined) {
		return { type: "Unknown" }
	}

	return bindings.size === 0 ? type : applyGenericBindings(type, bindings)
}

// Each Parameter's declared position under the name the body reads it by.
function parameterSlotsOf(
	definition: parser.FunctionDefinitionNode,
): Map<string, number> {
	let slots = new Map<string, number>()

	for (let [index, parameter] of definition.parameters.entries()) {
		let name = parameterInternalName(parameter)

		if (name !== null) {
			slots.set(name.content, index)
		}
	}

	return slots
}

// One Argument of an alias body as the slot it fills: a literal, a forwarded
// Parameter, or `@`. Anything computed answers null.
function argumentSlotOf(
	value: common.typed.ExpressionNode,
	slots: ReadonlyMap<string, number>,
): DerivedArgument | null {
	let literal = literalPredicateArgument(value)

	if (literal !== null) {
		return { kind: "Literal", value: literal }
	}

	if (value.nodeType === "Self") {
		return { kind: "Self" }
	}

	if (value.nodeType !== "Identifier") {
		return null
	}

	let index = slots.get(value.content)

	return index === undefined ? null : { kind: "Parameter", index }
}

// The Parameter a body made the call on where it wrote the ordering backwards,
// or null.
function converseReceiverOf(
	result: common.typed.MethodInvocationNode,
	args: Array<DerivedArgument>,
	slots: ReadonlyMap<string, number>,
): number | null {
	if (result.base.nodeType !== "Identifier" || args.length !== 1) {
		return null
	}

	return args[0]!.kind === "Self"
		? (slots.get(result.base.content) ?? null)
		: null
}

// Every candidate collapsed to the leaf it names and written onto its entry,
// the object every use site holds.
function writePredicateAliases(
	candidates: Array<AliasCandidate>,
	container: AliasContainer,
): void {
	if (candidates.length === 0) {
		return
	}

	let byEntry = new Map<common.BaseFunction, AliasCandidate>()

	for (let candidate of candidates) {
		byEntry.set(candidate.entry, candidate)
	}

	let context = {
		byEntry,
		container,
		cyclic: cyclicCandidates(candidates, byEntry),
		done: new Map<common.BaseFunction, common.PredicateAlias | null>(),
	}

	for (let candidate of candidates) {
		let alias = collapsedAlias(candidate, context)

		if (alias !== null) {
			candidate.entry.predicateAlias = alias
		}
	}
}

// The entries that form a ring, such as two Methods written as each other's
// contraries. They stay primitive.
function cyclicCandidates(
	candidates: Array<AliasCandidate>,
	byEntry: ReadonlyMap<common.BaseFunction, AliasCandidate>,
): Set<common.BaseFunction> {
	let cyclic = new Set<common.BaseFunction>()

	for (let candidate of candidates) {
		let path: Array<common.BaseFunction> = []
		let visited = new Map<common.BaseFunction, number>()
		let current: AliasCandidate | undefined = candidate

		while (current !== undefined) {
			let seen = visited.get(current.entry)

			if (seen !== undefined) {
				for (let entry of path.slice(seen)) {
					cyclic.add(entry)
				}

				break
			}

			visited.set(current.entry, path.length)
			path.push(current.entry)
			current =
				current.target === null
					? undefined
					: byEntry.get(current.target)
		}
	}

	return cyclic
}

type CollapseContext = {
	byEntry: ReadonlyMap<common.BaseFunction, AliasCandidate>
	container: AliasContainer
	cyclic: ReadonlySet<common.BaseFunction>
	done: Map<common.BaseFunction, common.PredicateAlias | null>
}

// One candidate as the primitive it names. A target in the same declaration is
// collapsed first; one elsewhere is folded in from what it recorded. Remembered
// per entry.
function collapsedAlias(
	candidate: AliasCandidate,
	context: CollapseContext,
): common.PredicateAlias | null {
	let remembered = context.done.get(candidate.entry)

	if (remembered !== undefined) {
		return remembered
	}

	let alias =
		context.cyclic.has(candidate.entry) === true
			? null
			: finishedAlias(candidate, context)

	context.done.set(candidate.entry, alias)

	return alias
}

function finishedAlias(
	candidate: AliasCandidate,
	context: CollapseContext,
): common.PredicateAlias | null {
	let target = candidate.target
	let ahead = target === null ? undefined : context.byEntry.get(target)
	let inner =
		ahead !== undefined
			? collapsedAlias(ahead, context)
			: (target?.predicateAlias ?? null)
	let step =
		inner === null ? candidate.step : composedStep(candidate.step, inner)

	if (step === null) {
		return null
	}

	if (candidate.converse !== null) {
		step = conversedStep(step, candidate, context.container)

		if (step === null) {
			return null
		}
	}

	let args: Array<common.PredicateAliasArgument> = []

	for (let slot of step.args) {
		// `@` reached a leaf as an Argument, which a leaf can not spell.
		if (slot.kind === "Self") {
			return null
		}

		args.push(slot)
	}

	// A leaf naming the Method it was read off says nothing, so it stays
	// primitive.
	if (
		step.namespaceName === context.container.selfNamespaceName &&
		step.methodName === candidate.methodName
	) {
		return null
	}

	return {
		namespaceName: step.namespaceName,
		methodName: step.methodName,
		args,
		negated: step.negated,
	}
}

// A body's call folded together with what its target asks: each of the target's
// Parameter slots takes what the body handed it. The polarities combine.
function composedStep(
	outer: AliasStep,
	inner: common.PredicateAlias,
): AliasStep | null {
	let args: Array<DerivedArgument> = []

	for (let slot of inner.args) {
		if (slot.kind !== "Parameter") {
			args.push(slot)

			continue
		}

		let forwarded = outer.args[slot.index]

		if (forwarded === undefined) {
			return null
		}

		args.push(forwarded)
	}

	return {
		namespaceName: inner.namespaceName ?? outer.namespaceName,
		methodName: inner.methodName,
		args,
		negated: outer.negated !== inner.negated,
	}
}

// A flipped call read back onto `@` as the converse over the Parameter it was
// made on.
function conversedStep(
	step: AliasStep,
	candidate: AliasCandidate,
	container: AliasContainer,
): AliasStep | null {
	let flipped = CONVERSE_COMPARISONS.get(step.methodName)

	if (
		!candidate.converseTrusted ||
		flipped === undefined ||
		step.args.length !== 1 ||
		step.args[0]!.kind !== "Self"
	) {
		return null
	}

	return {
		namespaceName: container.selfNamespaceName,
		methodName: flipped,
		args: [{ kind: "Parameter", index: candidate.converse! }],
		negated: step.negated,
	}
}

// #endregion

// A literal Argument as the stable scalar a conjunct key is built from. An
// Integer keeps its digits, and a Rational its lowest terms, so `0/1` and `0/2`
// are one key. A String keeps its JSON quotes, so `@::check(1)` and
// `@::check("1")` differ.
function literalPredicateArgument(
	value: common.typed.ExpressionNode,
): string | boolean | null {
	switch (value.nodeType) {
		case "IntegerValue":
			return value.value
		case "StringValue":
			return JSON.stringify(value.value)
		case "BooleanValue":
			return value.value
		case "RationalValue":
			return reducedRationalSpelling(value.numerator, value.denominator)
		default:
			return null
	}
}

// A Namespace's own name bound to the Namespace, so `Reader.readsBase` reads
// the same inside `namespace Reader` as outside. It is a member only, so a
// same-named Type Alias is not shadowed.
function scopeWithNamespaceSelf(
	node: parser.NamespaceDefinitionStatementNode,
	type: common.NamespaceType,
	scope: enricher.Scope,
): enricher.Scope {
	return childScope(scope, {
		members: { [node.name.content]: type },
		declarations: { [node.name.content]: node.name.position },
		constants: new Set([node.name.content]),
		// Read only by `unknown-name`; see `Scope.namespace`.
		namespace: { name: node.name.content, type },
	})
}

export function resolveNamespaceDefinitionStatementType(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
	// Set only by hoisting, to the Protocols not hoisted yet. It turns on the
	// silent bound weave, so earlier use sites see the bounds. A clause naming
	// a pending Protocol throws, for a later round.
	options: { deferOnPendingConformance?: ReadonlySet<string> } = {},
): common.NamespaceType {
	// Namespace Type Parameters are visible in the target Type and every
	// signature, with any bound the target Type implies; see
	// `impliedTargetBounds`.
	let impliedBounds = impliedTargetBounds(node, scope)
	let genericScope = scopeWithGenerics(node.generics, scope, impliedBounds)

	let clauses = resolveConformanceClauses(node, scope)

	// The maps the Type carries are filled in place, so the Namespace seen
	// inside its own body has every member resolved so far.
	let properties: Record<string, common.Type> = {}
	let methods: Record<string, common.MethodType> = {}

	let resultType: common.NamespaceType = {
		type: "Namespace",
		targetType:
			node.targetType === null
				? null
				: resolveType(node.targetType, genericScope),
		name: node.name.content,
		generics: boundNamespaceGenerics(
			resolveGenericDeclarations(node.generics, scope),
			impliedBounds,
		),
		properties,
		methods,
		conformsTo: clauses.conformsTo,
		conformanceConditions: clauses.conformanceConditions,
	}

	if (clauses.unsettled && options.deferOnPendingConformance !== undefined) {
		unsettledNamespaces.add(resultType)
	}

	// Native Properties first: the runtime answers them, so any Property may
	// read one.
	for (let [memberKey, memberValue] of Object.entries(node.properties)) {
		if (memberValue.value !== null) {
			// A bodied Property is seeded as Error until its value is enriched.
			// The validator, which knows the initialiser order, refuses a read
			// that comes too early.
			properties[memberKey] = { type: "Error" }

			continue
		}

		// A native static Property's annotation is its Type, as in
		// `static Pi: Transcendental`. One with neither a value nor an
		// annotation is reported, rather than shipping a Property of no Type.
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

	// Methods resolve before the Property values, since a Method is installed
	// ahead of every static initialiser and a value may call one.
	for (let [methodName, methodValue] of Object.entries(node.methods)) {
		methods[methodName] = resolveMethodType(
			methodValue,
			scopeWithNamespaceSelf(node, resultType, genericScope),
			resultType.targetType,
			resultType.generics,
		)
	}

	// A Property's Type is its value's.
	typeBodiedProperties(
		node,
		properties,
		scopeWithNamespaceSelf(node, resultType, scope),
		scope,
		options.deferOnPendingConformance !== undefined,
	)

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

// The Namespace Types hoisted while a clause or a `where` condition named
// nothing yet. `settleConformanceClauses` reads them again.
let unsettledNamespaces = new WeakSet<common.NamespaceType>()

// A Namespace's `is` clauses as identities, each expanded through every
// Protocol it extends. A name that resolves to nothing is left out and makes
// the answer `unsettled`; `checkProtocolConformance` is what reports it.
function resolveConformanceClauses(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
): {
	conformsTo: Array<string>
	conformanceConditions: Record<
		string,
		Array<{ generic: string; protocol: string }>
	>
	unsettled: boolean
} {
	let conformanceConditions: Record<
		string,
		Array<{ generic: string; protocol: string }>
	> = {}
	// Every Protocol a clause names and each one it extends, kept flat. A
	// clause's conditions apply to each Protocol it grants.
	let conformsTo: Array<string> = []
	// The Protocols some clause grants outright, which a later conditional
	// clause can not put conditions back on.
	let unconditional = new Set<string>()
	let unsettled = false

	for (let clause of node.conformsTo) {
		let conditions =
			clause.conditions.length === 0
				? null
				: clause.conditions.flatMap((condition) => {
						let protocol = resolveWrittenProtocol(
							condition.protocol,
							scope,
						)

						if (protocol === null) {
							unsettled = true

							return []
						}

						return [
							{
								generic: condition.generic.content,
								protocol: protocol.identity,
							},
						]
					})

		let protocol = resolveWrittenProtocol(clause.protocol, scope)

		if (protocol === null) {
			unsettled = true

			continue
		}

		for (let identity of [
			protocol.identity,
			...(protocol.conformsTo ?? []),
		]) {
			if (!conformsTo.includes(identity)) {
				conformsTo.push(identity)
			}

			// The weakest grant wins: in
			// `is Ordered where Item is Ordered, is Ranked`, both extending
			// `Named`, the second grants `Named` outright.
			if (conditions === null) {
				unconditional.add(identity)
				delete conformanceConditions[identity]
			} else if (
				!unconditional.has(identity) &&
				conformanceConditions[identity] === undefined
			) {
				conformanceConditions[identity] = conditions
			}
		}
	}

	return { conformsTo, conformanceConditions, unsettled }
}

// Reads a hoisted Namespace's clauses again once every import is bound, writing
// into the list and record every copy of the Type shares. False where nothing
// is unsettled.
export function settleConformanceClauses(
	type: common.NamespaceType,
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
): boolean {
	if (!unsettledNamespaces.has(type)) {
		return false
	}

	unsettledNamespaces.delete(type)

	let settled = resolveConformanceClauses(node, scope)
	let conformsTo = type.conformsTo ?? []
	let conditions = type.conformanceConditions ?? {}

	conformsTo.splice(0, conformsTo.length, ...settled.conformsTo)

	for (let identity of Object.keys(conditions)) {
		delete conditions[identity]
	}

	Object.assign(conditions, settled.conformanceConditions)

	return true
}

// The near miss for an unknown Case, computed once for every reporting site, so
// the Help and the Quick Fix title agree.
function caseSuggestion(
	name: string,
	candidateNames: Array<string>,
): { helps: Array<string>; data?: common.DiagnosticData } {
	let suggestion = closestMatch(name, candidateNames)

	return {
		helps: suggestion === null ? [] : [`Did you mean '#${suggestion}'?`],
		// The bare name, since the Quick Fix replaces only the underlined name.
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
