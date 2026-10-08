import { isDeepStrictEqual } from "node:util"

import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	primary,
	report,
	reportedOnLine,
	reportError,
	reportWarning,
	secondary,
} from "../diagnostics/index"
import { oneBoundOnly } from "../helpers/bounds"
import {
	type ConformanceCheckResult,
	type ConformanceMethodMap,
	computeConformanceMethodMap,
	conformanceIsStructural,
	conformanceKey,
	derivedEnumerableNamespaceName,
	derivedEquatableNamespaceName,
	derivedPrintableNamespaceName,
	equatableProtocolName,
	missingRequirements,
	providedBodyFulfils,
	providedMethodProtocol,
	restatementAccepts,
	writtenRequirementFulfils,
} from "../helpers/conformance"
import { recordDefaultMembers, recordDefaultNesting } from "../helpers/defaults"
import {
	choiceIdentity,
	countOf,
	describeParameter,
	describeType,
	displayChoiceName,
	namespaceHead,
	namespaceWhere,
	unnameableTargetNote,
	displayGenericName,
	displayProtocolName,
	protocolIdentity,
	specifierTo,
	undecidedSlotEvidence,
	unwaitedWorkReport,
	withArticle,
} from "../helpers/describe"
import { eraseRefinements } from "../helpers/eraseRefinements"
import {
	type ForeignWord,
	compoundAssignmentHelps,
	foreignOperatorAccount,
	foreignOperatorIn,
	foreignWord,
	semicolonAccount,
} from "../helpers/foreign"
import {
	conformanceParameterName,
	parameterInternalName,
} from "../helpers/names"
import { admittedPartialType } from "../helpers/predicateEval"
import { type NamespaceReach } from "../helpers/providedReach"
import { methodsRead, providedBodyReads } from "../helpers/providedReads"
import { closestMatch } from "../helpers/suggest"
import {
	applyGenericBindings,
	borrowedGenericName,
	buildUnion,
	buildWrittenUnion,
	bindNamespaceTarget,
	choiceArgumentBounds,
	disagreeingTypeArguments,
	filterMostSpecificByTarget,
	flattenUnionMembers,
	isReportedValue,
	matchesType,
	NotHoistedYet,
	refinementWithTypeArguments,
	resolveUnknownSlots,
	type GenericBindings,
	type NamespaceTarget,
	typeContainsError,
	typeMentionsGeneric,
	withoutHoles,
} from "../helpers/types"
import { updateRefusal } from "../helpers/writtenPartials"
import { recordAnnotation } from "./annotations"
import { derivesWithImports } from "./derivedImports"
import { reportTypeWithoutMembers } from "./memberHelps"
import { narrowedBodyReport, narrowedMethodReport } from "./narrowedMethods"
import {
	conformingBindings,
	namespacesCovering,
	otherConformerNotes,
} from "./otherApplications"
import { providedMethodNamespacesNamed } from "./protocolPicks"
import { conformanceProvidersIn } from "./providedBodies"
import {
	bodyCanWait,
	childScope,
	completionBarrierIn,
	declarationWasAbandoned,
	memberDeclarationWasAbandoned,
	moduleBindsName,
	modulePathOf,
	protocolDeclarationsOf,
	protocolRegistryOf,
	unimportedNamespacesOf,
} from "./scope"
import {
	reportSpecifierIsNotANamespace,
	reportSpecifierNamesNoValue,
} from "./specifiers"
import {
	annotateAtChoiceHelp,
	annotateAtChoiceRemedy,
	choiceBindingIn,
	foreignChoiceDeclaration,
	type ForeignChoice,
	choiceNameIn,
	foreignChoiceRemedy,
	foreignChoicesOf,
	foreignChoicesSpelled,
	spellingAfterImport,
	suggestionData,
	suggestionHelps,
	suggestionInScope,
	unboundForeignChoice,
	unknownTypeRemedy,
	withImportOf,
} from "./spelling"
import { namespaceMemberType } from "./staticProperties"
import {
	assumeRefusedBounds,
	conditionsOf,
	conformanceConditionsOf,
	inferringRefused,
	orderConditions,
} from "./typeParameters"
import { reportUnknownWhereGeneric } from "./whereGenerics"

// Type resolution: written Types, declarations, the Types of Combinations,
// Lookups and Literals from their enriched children, conformance solving, and
// the Namespaces a Scope can see. No Expression is walked here, save the value
// of a static Property `namespaceMemberType` types where it is read.

// Where every written annotation meets its Type, so the annotation index is
// recorded here alone. Nested annotations recurse through this function, so
// `Item` inside `List<Item>` is recorded too.
export function resolveType(
	node: parser.TypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	let type = resolveTypeDeclaration(node, scope)

	recordAnnotation(node, type, scope)

	return type
}

function resolveTypeDeclaration(
	node: parser.TypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	switch (node.nodeType) {
		case "IdentifierTypeDeclaration":
			return resolveIdentifierTypeDeclarationType(node, scope)
		case "UnionTypeDeclaration":
			return resolveUnionTypeDeclarationType(node, scope)
		case "RecordTypeDeclaration":
			return resolveRecordTypeDeclarationType(node, scope)
		case "GenericTypeDeclaration":
			return resolveGenericTypeDeclarationType(node, scope)
		case "FunctionTypeDeclaration":
			return resolveFunctionTypeDeclarationType(node, scope)
	}
}

function resolveFunctionTypeDeclarationType(
	node: parser.FunctionTypeDeclarationNode,
	scope: enricher.Scope,
): common.FunctionType {
	return {
		type: "Function",
		generics: [],
		parameterTypes: node.parameterTypes.map((parameter) => ({
			name: parameter.externalName?.content ?? null,
			type: resolveDeclaredType(parameter.type, scope),
		})),
		returnType: resolveType(node.returnType, scope),
	}
}

function describeTypesForCombination(type: common.Type): string {
	switch (type.type) {
		case "Error":
			return "Error Types"
		case "GenericList":
		case "GenericDictionary":
		case "GenericAlias":
		case "GenericUse":
			return "Generic Types"
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return "Functions"
		case "Namespace":
			return "Namespaces"
		case "List":
			return "Lists"
		case "Dictionary":
			return "Dictionaries"
		case "Boolean":
			return "Booleans"
		case "Integer":
			return "Integers"
		case "Rational":
			return "Rationals"
		case "Algebraic":
			return "Algebraics"
		case "Transcendental":
			return "Transcendentals"
		case "Randomness":
			return "Randomness sources"
		case "Future":
			return "Futures"
		case "Started":
			return "started work"
		case "String":
			return "Strings"
		case "Unknown":
			return "Unknowns"
		case "UnionType":
			return "Unions"
		case "Record":
			return "Records"
		case "Case":
			return "Cases"
		// This `with` combines only Records, and no Record can be refined, so a
		// refinement is described under its own name.
		case "Refinement":
			return `'${type.name}' values`
	}
}

// The Help for updating a container without Type Arguments, such as the
// `Dictionary` of `constant d: Dictionary = ["a" = 1]`: the Arguments are what
// would make it updatable.
function unappliedGenericHelps(type: common.Type): Array<string> {
	if (type.type === "GenericDictionary") {
		return ["Write the Types it holds: 'Dictionary<String, Integer>'."]
	}

	if (type.type === "GenericList") {
		return ["Write the Type it holds: 'List<Integer>'."]
	}

	return []
}

// The result Type of a Combination, from its operands' enriched Types. The
// right operand's Node, where there is one, lets a refusal point at the member
// that caused it.
export function combinationTypeOf(
	lhsType: common.Type,
	rhsType: common.Type,
	lhsPosition: common.Position,
	rhsPosition: common.Position,
	rhs?: common.typed.ExpressionNode,
): common.Type {
	if (lhsType.type === "Error" || rhsType.type === "Error") {
		return { type: "Error" }
	}

	if (lhsType.type !== "Record") {
		reportError(
			`${describeTypesForCombination(lhsType)} can not be combined`,
			lhsPosition,
			{
				code: "uncombinable-types",
				labels: [
					primary(
						lhsPosition,
						`this is ${withArticle(describeType(lhsType))}`,
					),
				],
				notes: [
					"Only Records, Namespaces and Dictionaries can be combined.",
				],
				helps: unappliedGenericHelps(lhsType),
			},
		)

		return { type: "Error" }
	}

	if (rhsType.type !== "Record") {
		reportError(
			`${describeTypesForCombination(rhsType)} can not be combined`,
			rhsPosition,
			{
				code: "uncombinable-types",
				labels: [
					primary(
						rhsPosition,
						`this is ${withArticle(describeType(rhsType))}`,
					),
				],
				notes: [
					"Only Records, Namespaces and Dictionaries can be combined.",
				],
				helps: unappliedGenericHelps(rhsType),
			},
		)

		return { type: "Error" }
	}

	// TODO: Resolve applied Types and check whether they are Records.
	//
	// An update decides the undecided members it writes:
	// `{ box with items = ["a"] }` over an `items` from `[]` answers
	// `{ items: List<String> }`. It is decided before the Partial check, which
	// then reads the settled member.
	let resolved = resolveUnknownSlots(lhsType, rhsType)
	let combined = resolved.type === "Record" ? resolved : lhsType

	// A Function refused as a value is reported by the validator, so it is a
	// hole here. A written member carries its own evidence for a refinement.
	let written = admittedPartialType(combined, rhsType, rhs)

	// A Partial, so only what the update writes can be wrong.
	let record = updateRefusal(combined, written, rhs)

	if (record === null) {
		return combined
	}

	// A member written but left undecided, such as `items = 1` over an
	// `items` from `[]`, is explained as a Variable's assignment would be.
	let undecided = undecidedSlotEvidence(combined, written, null)

	reportError(
		"This is not a Partial of the value it updates",
		record.lead?.position ?? rhsPosition,
		{
			code: "partial-type-mismatch",
			labels: [
				record.lead ??
					primary(
						rhsPosition,
						`this is ${withArticle(describeType(written))}`,
					),
				...record.labels,
				secondary(
					lhsPosition,
					`this is ${withArticle(describeType(lhsType))}`,
				),
			],
			notes: [
				"An update may only set members the original already has, with the Types it declared for them.",
				...record.notes,
				...undecided.notes,
			],
			helps: [...record.helps, ...undecided.helps],
			data: record.data,
		},
	)

	return lhsType
}

// Every Type name a Type declaration Node mentions, as the Identifiers that
// spell them, in written order. The scan is syntactic, since the recursion
// checks run before anything resolves.
export function referencedTypeNames(
	node: parser.TypeDeclarationNode,
): Array<parser.IdentifierNode> {
	switch (node.nodeType) {
		case "IdentifierTypeDeclaration":
			return [node.type]
		case "GenericTypeDeclaration":
			return [
				...referencedTypeNames(node.baseType),
				...node.generics.flatMap((argument) =>
					referencedTypeNames(argument),
				),
			]
		case "UnionTypeDeclaration":
			return node.types.flatMap((member) => referencedTypeNames(member))
		case "RecordTypeDeclaration":
			return Object.values(node.members).flatMap((member) =>
				referencedTypeNames(member.type),
			)
		case "FunctionTypeDeclaration":
			return [
				...node.parameterTypes.flatMap((parameter) =>
					referencedTypeNames(parameter.type),
				),
				...referencedTypeNames(node.returnType),
			]
	}
}

// The first mention of `choiceName` in a payload's Type declaration, or null.
// By name, since the Choice is not in scope yet while it hoists.
function typeDeclarationNamesChoice(
	node: parser.TypeDeclarationNode,
	choiceName: string,
): parser.IdentifierNode | null {
	return (
		referencedTypeNames(node).find(
			(reference) => reference.content === choiceName,
		) ?? null
	)
}

// A generic Choice's Case payload, resolved with the Choice's Type Parameters
// in scope. A member naming the Choice itself would never finish substituting,
// so it is reported and resolved to Error. See "Recursive declarations" in
// DEVELOPMENT.md.
function resolveGenericCaseMembers(
	payload: parser.RecordTypeDeclarationNode | null,
	choice: parser.ChoiceDeclarationStatementNode,
	genericScope: enricher.Scope,
): Record<string, common.Type> {
	if (payload === null) {
		return {}
	}

	// In `choice Bad<Bad> { A { next: Bad } }` the payload names the Type
	// Parameter, so there is no recursion.
	let shadowsOwnName = choice.generics.some(
		(generic) => generic.name.content === choice.name.content,
	)

	let members: Record<string, common.Type> = {}

	for (let [name, member] of Object.entries(payload.members)) {
		let selfReference = shadowsOwnName
			? null
			: typeDeclarationNamesChoice(member.type, choice.name.content)

		if (selfReference !== null) {
			reportError(
				"A generic Choice can not name itself in a payload",
				selfReference.position,
				{
					code: "recursive-generic-choice",
					labels: [
						primary(
							selfReference.position,
							"this names the Choice being declared",
						),
					],
					notes: [
						"A generic Choice's payloads are substituted eagerly at each use, so a self-reference would never finish substituting.",
					],
					helps: [
						"Recursive Type declarations are not part of the language yet — break the cycle.",
					],
				},
			)

			members[name] = { type: "Error" }
		} else {
			members[name] = resolveType(member.type, genericScope)
		}
	}

	return members
}

// Each Case becomes a nominal Record Type, and a Choice is the named Union of
// them, so every Union mechanism applies. A generic Choice is a Generic Alias
// over the anonymous Union, so an application spells as `Step<Integer, String>`.
// Each Case records the Choice's Type Parameters for that substitution.
export function resolveChoiceDeclarationStatementType(
	node: parser.ChoiceDeclarationStatementNode,
	scope: enricher.Scope,
): common.UnionType | common.GenericAliasType {
	// Checked here as well as in `declareTypeInScope`, which the hoist never
	// reaches.
	if (node.name.content === "Self") {
		reportReservedTypeName(node.name.position)
	}

	if (node.cases.length === 0) {
		reportError("A Choice must declare at least one Case", node.position, {
			code: "empty-choice",
			labels: [primary(node.position, "this Choice declares none")],
			helps: [
				`Write a Case — 'choice ${node.name.content} { First }' — or drop the declaration.`,
			],
		})
	}

	let isGeneric = node.generics.length > 0
	let genericScope = isGeneric
		? scopeWithGenerics(node.generics, scope)
		: scope
	let generics = isGeneric
		? resolveGenericDeclarations(node.generics, scope)
		: []
	// The Cases are identified by their Module. The Union and the Generic
	// Alias keep the written name, which is a Scope key and not an identity.
	let identity = choiceIdentity(modulePathOf(scope), node.name.content)

	let caseTypes: Array<common.CaseType> = []

	for (let choiceCase of node.cases) {
		if (
			caseTypes.some(
				(existing) => existing.name === choiceCase.name.content,
			)
		) {
			reportError(
				`Case '#${choiceCase.name.content}' is declared more than once`,
				choiceCase.name.position,
				{
					code: "duplicate-case",
					labels: [
						primary(
							choiceCase.name.position,
							"declared a second time here",
						),
					],
					// The first Case of the name is the one kept.
					helps: [
						`Remove this '${choiceCase.name.content}', or give it a name of its own.`,
					],
				},
			)

			continue
		}

		if (isGeneric) {
			if (choiceCase.defaultValue !== null) {
				reportError(
					"A generic Choice can not default a payload",
					choiceCase.defaultValue.position,
					{
						code: "case-default-on-generic-choice",
						labels: [
							primary(
								choiceCase.defaultValue.position,
								"this default",
							),
						],
						notes: [
							`'${node.name.content}' abstracts over ${countOf(node.generics.length, "Type Parameter")}, and a value written here can bind none of them — every use site decides them, and each would want a default of its own.`,
						],
						// A default needs payload Types written out to be checked
						// against, which only a Choice without Type Parameters has.
						helps: [
							`Write the member at each construction, or declare a Choice that takes no Type Parameters — one whose payload Types are written out, where a default has something to be checked against.`,
						],
					},
				)
			}

			caseTypes.push({
				type: "Case",
				choice: identity,
				name: choiceCase.name.content,
				members: resolveGenericCaseMembers(
					choiceCase.type,
					node,
					genericScope,
				),
				choiceGenerics: generics,
			})
		} else {
			let members =
				choiceCase.type === null
					? {}
					: resolveRecordTypeDeclarationType(choiceCase.type, scope)
							.members

			caseTypes.push({
				type: "Case",
				choice: identity,
				name: choiceCase.name.content,
				members,
				...casePayloadDefaultOf(choiceCase, members),
			})
		}
	}

	// Which members a Case's `= { … }` fills in, read as a Record Parameter's
	// `defaultMembers` is. The enricher writes the values in later and reports
	// any other spelling; nothing here reports, since a Choice resolves in
	// whichever Module first needs it.
	function casePayloadDefaultOf(
		choiceCase: parser.ChoiceCaseNode,
		members: Record<string, common.Type>,
	): { payloadDefault?: common.CasePayloadDefault } {
		if (
			choiceCase.defaultValue === null ||
			choiceCase.defaultValue.nodeType !== "RecordValue"
		) {
			return {}
		}

		return {
			payloadDefault: {
				members:
					recordDefaultMembers(
						{ type: "Record", members },
						choiceCase.defaultValue,
					) ?? [],
				nesting:
					recordDefaultNesting(
						{ type: "Record", members },
						choiceCase.defaultValue,
					) ?? {},
				values: null,
			},
		}
	}

	// Whether the Case's siblings carry payloads, stamped on each Case for the
	// embedding boundary, which meets a Case alone. A generic Choice whose Cases
	// carry no payload is a unit Choice too.
	if (
		caseTypes.length > 0 &&
		caseTypes.every(
			(caseType) => Object.keys(caseType.members).length === 0,
		)
	) {
		for (let caseType of caseTypes) {
			caseType.unitChoice = true
		}
	}

	if (isGeneric) {
		return {
			type: "GenericAlias",
			name: node.name.content,
			generics,
			aliasedType: { type: "UnionType", types: caseTypes },
		}
	}

	return { type: "UnionType", name: node.name.content, types: caseTypes }
}

// The Type of a Record Literal, from its members' enriched Types. A valid
// Record annotation wins; anything else reports and falls back to the
// members' structural Type.
export function recordValueTypeOf(
	resolvedAnnotation: common.Type | null,
	memberTypes: Record<string, common.Type>,
	annotationPosition: common.Position | null,
): common.RecordType {
	if (resolvedAnnotation !== null) {
		if (resolvedAnnotation.type === "Record") {
			return resolvedAnnotation
		}

		if (
			resolvedAnnotation.type !== "Error" &&
			annotationPosition !== null
		) {
			reportError(
				"A Record Literal must be annotated with a Record Type",
				annotationPosition,
				{
					code: "record-annotation-not-record",
					labels: [
						primary(
							annotationPosition,
							"this is not a Record Type",
						),
					],
				},
			)
		}
	}

	return {
		type: "Record",
		members: memberTypes,
	}
}

// The item Type of a List Literal: Unknown for an empty List, otherwise the
// Union of the distinct item Types in first-seen order.
export function listItemTypeOf(valueTypes: Array<common.Type>): common.Type {
	if (valueTypes.length === 0) {
		return { type: "Unknown" }
	}

	let itemTypes = [valueTypes[0]]

	for (let valueType of valueTypes.slice(1)) {
		if (
			!itemTypes.some((existing) =>
				isDeepStrictEqual(existing, valueType),
			)
		) {
			itemTypes.push(valueType)
		}
	}

	return buildUnion(itemTypes)
}

// What the Lookup enricher hands a Lookup, so one that finds no member can
// ask whether a Method of the name answers, as in `names.length()`. The
// question is a function, asked only where the Lookup is refused already.
export type MemberAccessContext = {
	// The span between the base and the member, the `.` a fix replaces.
	separator: common.Position
	// Whether the Lookup is a call's callee: `names.length()` rather than
	// `names.length`. A fix for the second adds the parentheses.
	isCalled: boolean
	// How many Arguments the call writes, 0 for a member that is only read.
	writtenArguments: number
	// The base as written, such as `box.inner`, or null where a Help could
	// not print it back.
	spelledBase: string | null
	methodNamed: (name: string) => common.MethodType | null
}

// The result Type of a Lookup, from its base's enriched Type. `scope` is
// handed in only where the base can be a Namespace: the Lookup enricher and a
// Pattern's member path.
export function lookupTypeOf(
	baseType: common.Type,
	memberName: string,
	positions: { member: common.Position; base: common.Position },
	access: MemberAccessContext | null = null,
	scope: enricher.Scope | null = null,
): common.Type {
	if (baseType.type === "Error") {
		return baseType
	}

	if (baseType.type === "Namespace") {
		let member = namespaceMemberType(baseType, memberName, positions, scope)

		if (member !== null) {
			return member
		} else if (
			scope !== null &&
			memberDeclarationWasAbandoned(scope, memberName)
		) {
			// A member the parser dropped from a Namespace body is the syntax
			// error again, so its reads stay silent. That holds file-wide,
			// since a Namespace's Type carries no span.
			return { type: "Error" }
		} else {
			reportUnknownMember(
				memberName,
				positions.member,
				`Namespace '${baseType.name}'`,
				[
					...Object.keys(baseType.properties),
					...Object.keys(baseType.methods),
				],
			)

			return { type: "Error" }
		}
	} else if (baseType.type === "Record") {
		if (Object.hasOwn(baseType.members, memberName)) {
			return baseType.members[memberName]
		} else {
			if (
				reportMethodCalledWithDot(
					baseType,
					memberName,
					positions,
					access,
				)
			) {
				return { type: "Error" }
			}

			reportUnknownMember(
				memberName,
				positions.member,
				describeType(baseType),
				Object.keys(baseType.members),
				access,
			)

			return { type: "Error" }
		}
	} else if (baseType.type === "Case") {
		// A Case's payload members are read as a Record's are.
		if (Object.hasOwn(baseType.members, memberName)) {
			return baseType.members[memberName]
		} else {
			if (
				reportMethodCalledWithDot(
					baseType,
					memberName,
					positions,
					access,
				)
			) {
				return { type: "Error" }
			}

			reportUnknownMember(
				memberName,
				positions.member,
				`Case '${displayChoiceName(baseType.choice)}#${baseType.name}'`,
				Object.keys(baseType.members),
				access,
			)

			return { type: "Error" }
		}
	} else {
		if (
			reportMethodCalledWithDot(baseType, memberName, positions, access)
		) {
			return { type: "Error" }
		}

		reportTypeWithoutMembers(baseType, memberName, positions.base, {
			access,
			scope,
			lookup: resolveMethodLookupNamespacesForReceiverType,
		})

		return { type: "Error" }
	}
}

// The Help for a member that was called with `.` where no Method answers
// either: `::` would reach `unknown-method`, which lists what the value
// answers. No Quick Fix, since the rewrite would not compile. Silent for a read.
function methodSeparatorHelps(
	memberName: string,
	access: MemberAccessContext | null,
): Array<string> {
	if (access === null || !access.isCalled) {
		return []
	}

	return [
		`A Method is called with '::' rather than '.' — write '::${memberName}(…)' if '${memberName}' is one.`,
	]
}

// Reports `names.length()`, a Method reached with `.`, and answers whether it
// reported. A Namespace's members are reached with `.`, so `Terminal.prnt(…)`
// is never asked about.
function reportMethodCalledWithDot(
	baseType: common.Type,
	memberName: string,
	positions: { member: common.Position; base: common.Position },
	access: MemberAccessContext | null,
): boolean {
	let method = access?.methodNamed(memberName) ?? null

	if (access === null || method === null) {
		return false
	}

	let answersAlone = answersWithoutArguments(method)
	// The zero-width span after the member where a read's `()` belongs, or
	// null where the call is written.
	let call = access.isCalled
		? null
		: { start: positions.member.end, end: positions.member.end }
	// No fix for a read whose Method needs an Argument; the Help shows `…`.
	let fixable = access.isCalled || answersAlone
	let spelling = access.isCalled
		? `'::${memberName}'`
		: `'::${memberName}${answersAlone ? "()" : "(…)"}'`

	reportError(`'${memberName}' is a Method, not a member`, positions.member, {
		code: "method-called-with-dot",
		labels: [
			primary(positions.member, "a Method is reached with '::'"),
			secondary(
				positions.base,
				`this is ${withArticle(describeType(baseType))}`,
			),
		],
		notes: [
			"Methods live in Namespaces rather than in the values they work on, so '::' reaches one and '.' reads a member a Record or a Case declares.",
		],
		helps: [
			access.isCalled
				? `Write ${spelling} in place of '.${memberName}'.`
				: `Write ${spelling} in place of '.${memberName}' — a Method is called, never read.`,
		],
		...(fixable
			? {
					data: {
						kind: "method-with-dot" as const,
						separator: access.separator,
						call,
					},
				}
			: {}),
	})

	return true
}

// Whether a call may write no Arguments, because every Parameter of the
// Method or of one of its Overloads is defaulted.
function answersWithoutArguments(method: common.MethodType): boolean {
	let overloads =
		method.type === "OverloadedMethod" ||
		method.type === "OverloadedStaticMethod"
			? method.overloads
			: [method]

	return overloads.some((overload) =>
		overload.parameterTypes
			// The receiver is the first Parameter of an instance signature.
			.slice(
				method.type === "SimpleMethod" ||
					method.type === "OverloadedMethod"
					? 1
					: 0,
			)
			.every((parameter) => parameter.hasDefault === true),
	)
}

type BarredName = enricher.BarredParameterName & {
	reads: "own" | "later" | "pattern"
}

// Reports a default reading a name the Parameter list binds but bars. Each
// kind gets its own fix: move the Parameter, write the value out, or read
// what the Pattern reads.
function reportBarredDefaultName(
	node: parser.IdentifierNode,
	barred: BarredName,
	// Whether the name is also bound outside the Parameter list, without
	// which renaming the Parameter would leave the default reading nothing.
	boundOutside: boolean,
): void {
	let name = node.content

	if (barred.reads === "later") {
		reportError(
			`'${name}' is declared after the Parameter whose default reads it`,
			node.position,
			{
				code: "default-references-later-parameter",
				labels: [
					primary(node.position, "read here"),
					secondary(barred.position, "declared here"),
				],
				notes: [
					"A default may read `@`, the Parameters to its left, and anything the Declaration is written inside.",
				],
				helps: [
					`Move '${name}' before the Parameter whose default reads it, or write the value out.`,
				],
			},
		)

		return
	}

	if (barred.reads === "own") {
		reportError(
			`'${name}' is the Parameter its own default is written on`,
			node.position,
			{
				code: "default-references-own-parameter",
				labels: [
					primary(node.position, "read here"),
					secondary(barred.position, "this is the Parameter"),
				],
				notes: [
					"A Parameter is bound to the value its default works out, so the default can not read it.",
				],
				helps: boundOutside
					? [
							`Write the value out, or rename the Parameter so it does not spell what the default reads — '${name}' is declared outside the list too.`,
						]
					: ["Write the value out."],
			},
		)

		return
	}

	reportError(
		`'${name}' is bound by a Pattern and can not be read by a default`,
		node.position,
		{
			code: "default-references-pattern-binding",
			labels: [
				primary(node.position, "read here"),
				secondary(barred.position, "bound by this Pattern"),
			],
			notes: [
				"A Pattern's bindings are Constants at the head of the body, and every default is worked out before the body runs.",
			],
			helps: [
				"Read the member off the Parameter itself, or write the value out.",
			],
		},
	)
}

// Whether a barred name is also bound outside the Parameter list, such as a
// `constant times` above the Function. The walk ignores the barrier: it asks
// what the default would read if the Parameter were renamed.
function boundOutsideTheParameterList(
	name: string,
	scope: enricher.Scope,
): boolean {
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		if (Object.hasOwn(searchScope.members, name)) {
			return true
		}

		searchScope = searchScope.parent
	}

	return false
}

// The lookup a Parameter's default makes: the outward walk, consulting a
// Parameter list's barrier ahead of its own Scope's members. A Function
// literal inside a default declares Parameters in a Scope of its own, so
// they shadow the barrier.
function findVariableOrBarredName(
	name: string,
	scope: enricher.Scope,
):
	| { found: "variable"; type: common.Type }
	| { found: "barred"; barred: BarredName }
	| null {
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		let barrier = searchScope.parameterDefaultBarrier
		let barred = barrier?.names.get(name)

		// `names` holds the whole list, so the index tells a Parameter to the
		// left, which is bound, from a barred one. A Pattern binding is barred
		// wherever it was written.
		if (barred !== undefined && barrier !== undefined) {
			if (barred.kind === "pattern") {
				return {
					found: "barred",
					barred: { ...barred, reads: "pattern" },
				}
			}

			if (barred.index === barrier.index) {
				return { found: "barred", barred: { ...barred, reads: "own" } }
			}

			if (barred.index > barrier.index) {
				return {
					found: "barred",
					barred: { ...barred, reads: "later" },
				}
			}
		}

		if (Object.hasOwn(searchScope.members, name)) {
			return { found: "variable", type: searchScope.members[name]! }
		}

		searchScope = searchScope.parent
	}

	return null
}

// A provided Method is emitted once, above every Program that reaches it, so
// its body may name only the builtins, never a Program's declaration. The top
// level's `preludeNames` tells the two apart. A chain without it is the
// standard library's own load, where everything is in reach.
function reportProvidedMethodOutOfReach(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
): void {
	let name = node.content
	let protocolName: string | null = null
	let declaringScope: enricher.Scope | null = null
	let preludeNames: ReadonlySet<string> | null = null

	for (
		let searchScope: enricher.Scope | null = scope;
		searchScope !== null;
		searchScope = searchScope.parent
	) {
		if (
			declaringScope === null &&
			Object.hasOwn(searchScope.members, name)
		) {
			// Bound at or inside the body, so emitted with it.
			if (protocolName === null) {
				return
			}

			declaringScope = searchScope
		}

		if (
			declaringScope === null &&
			searchScope.providedMethodOf !== undefined
		) {
			protocolName = searchScope.providedMethodOf
		}

		if (searchScope.preludeNames !== undefined) {
			preludeNames = searchScope.preludeNames
		}
	}

	if (
		declaringScope === null ||
		protocolName === null ||
		preludeNames === null ||
		declaringScope.preludeNames?.has(name) === true
	) {
		return
	}

	let declaration = declaringScope.declarations[name]
	let protocol = describeProtocol(protocolName, scope)

	reportError(
		`'${name}' can not be read from a provided Method`,
		node.position,
		{
			code: "provided-method-out-of-reach",
			labels: [
				primary(node.position, "this is declared outside the Protocol"),
				...(declaration === undefined
					? []
					: [secondary(declaration, `'${name}' is declared here`)]),
			],
			notes: [
				`A provided Method is emitted once, above every Program that reaches '${protocol}' — so its body can name the standard library and nothing the Program declares.`,
			],
			helps: [
				`Give '${protocol}' a requirement the body calls on '@' instead, and let each conforming Namespace reach '${name}'.`,
			],
		},
	)
}

// `provided-method-out-of-reach` for what the emitted body names but never
// writes. That is a Method of a Namespace the Program declares, called on a
// value or built into a witness.
export function reportProvidedBodyReaches(
	reaches: Array<NamespaceReach>,
	protocolIdentity: string,
	scope: enricher.Scope,
): void {
	// One report for each call, naming every Namespace a Union receiver
	// may run it off.
	let groups = new Map<
		string,
		{
			reach: NamespaceReach
			namespaces: Array<string>
			declared: Array<common.DiagnosticLabel>
		}
	>()

	for (let reach of reaches) {
		let declaringScope = programNamespaceScope(reach.namespace, scope)

		if (declaringScope === null) {
			continue
		}

		let { line, column } = reach.position.start
		let key = `${reach.kind === "call" ? reach.member : reach.namespace} ${line}:${column}`
		let group = groups.get(key) ?? { reach, namespaces: [], declared: [] }
		let declaration = declaringScope.declarations[reach.namespace]

		groups.set(key, group)

		if (!group.namespaces.includes(reach.namespace)) {
			group.namespaces.push(reach.namespace)
			group.declared.push(
				...(declaration === undefined
					? []
					: [
							secondary(
								declaration,
								`'${reach.namespace}' is declared here`,
							),
						]),
			)
		}
	}

	let protocol = describeProtocol(protocolIdentity, scope)
	let note = `A provided Method is emitted once, above every Program that reaches '${protocol}', so its body can reach the standard library and nothing the Program declares.`

	for (let { reach, namespaces, declared } of groups.values()) {
		if (reach.kind === "call") {
			let names = namespaces.map((name) => `'${name}'`)
			let declaring =
				names.length === 1
					? `${names[0]} declares`
					: `${names.slice(0, -1).join(", ")} and ${names.at(-1)} declare`

			reportError(
				`'${reach.member}' can not be called from a provided Method`,
				reach.position,
				{
					code: "provided-method-out-of-reach",
					labels: [
						primary(
							reach.position,
							`this calls the '${reach.member}' that ${declaring}`,
						),
						...declared,
					],
					notes: [note],
					helps: [
						`Give '${protocol}' a requirement the body calls on '@' in place of this call, and let each conforming Namespace call '${reach.member}'.`,
					],
				},
			)
		} else {
			reportError(
				`'${reach.namespace}' can not be reached from a provided Method`,
				reach.position,
				{
					code: "provided-method-out-of-reach",
					labels: [
						primary(
							reach.position,
							`this needs the '${describeProtocol(reach.protocol, scope)}' conformance that '${reach.namespace}' declares`,
						),
						...declared,
					],
					notes: [note],
					helps: [
						`Give '${protocol}' a requirement the body calls on '@' in place of this, and let each conforming Namespace write it.`,
					],
				},
			)
		}
	}
}

// The Scope binding a Namespace name to a Namespace the Program declares or
// imports. Null where the name is the prelude's, or no Namespace.
// The standard library's own load has no prelude snapshot, and reaches nothing.
function programNamespaceScope(
	name: string,
	scope: enricher.Scope,
): enricher.Scope | null {
	let declaringScope: enricher.Scope | null = null
	let hasPrelude = false

	for (
		let searchScope: enricher.Scope | null = scope;
		searchScope !== null;
		searchScope = searchScope.parent
	) {
		if (
			declaringScope === null &&
			Object.hasOwn(searchScope.members, name)
		) {
			declaringScope = searchScope
		}

		hasPrelude ||= searchScope.preludeNames !== undefined
	}

	return declaringScope === null ||
		!hasPrelude ||
		declaringScope.members[name]?.type !== "Namespace" ||
		declaringScope.preludeNames?.has(name) === true
		? null
		: declaringScope
}

// Every Case of every Choice in Type scope, for a bare `#Add({ … })` to look
// itself up in. Shadowed Type names are skipped, as `getAllNamespacesInScope`
// skips them. A near miss is drawn from the same scan. An Alias of an
// application holds the Choice's Cases applied, so a Case the Choice declares
// stands over them. See "Resolving a Case" in DEVELOPMENT.md.
export function findCaseTypesInScope(
	scope: enricher.Scope,
): Array<common.CaseType> {
	let seenTypeNames = new Set<string>()
	let cases = new Map<string, common.CaseType>()
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		for (let [typeName, type] of Object.entries(searchScope.types)) {
			if (seenTypeNames.has(typeName)) {
				continue
			}

			seenTypeNames.add(typeName)

			// A generic Choice's Cases are in the Union inside its Generic
			// Alias.
			let members =
				type.type === "UnionType"
					? flattenUnionMembers(type)
					: type.type === "GenericAlias" &&
						  type.aliasedType.type === "UnionType"
						? flattenUnionMembers(type.aliasedType)
						: [type]

			for (let member of members) {
				if (member.type !== "Case") {
					continue
				}

				let key = `${member.choice}#${member.name}`

				if (!givesWay(cases.get(key), member)) {
					cases.set(key, member)
				}
			}
		}

		searchScope = searchScope.parent
	}

	return [...cases.values()]
}

// Whether an applied Case, as `Box<Integer>` holds, gives way to the declared
// one already found.
function givesWay(
	held: common.CaseType | undefined,
	member: common.CaseType,
): boolean {
	return (
		held !== undefined &&
		held.typeArguments === undefined &&
		member.typeArguments !== undefined
	)
}

// Reports an undeclared name as another language's habit, or as a Case
// without its `#`, before `unknown-name`, and answers whether it reported.
// Asked only of a name nothing declares, so a Program may declare `print`.
function reportForeignName(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
	context: NameContext,
): boolean {
	let name = node.content

	// The word table goes first, for `println!`, which the postfix rule would
	// otherwise take apart.
	if (reportForeignWord(node, foreignWord(name))) {
		return true
	}

	// The rest of a String in the other quotes, already reported on this
	// line. See `reportForeignString`.
	if (
		reportedOnLine(
			"foreign-syntax",
			node.position.start.line,
			foreignStringMessage,
		)
	) {
		return true
	}

	if (name.startsWith("'") || name.startsWith("`")) {
		reportForeignString(node, name)

		return true
	}

	// A `;` ends no name, so it arrives inside the name before it. Only the
	// `;` is reported; the name is the reader's own.
	if (name.endsWith(";")) {
		let semicolon = {
			start: {
				line: node.position.end.line,
				column: node.position.end.column - 1,
			},
			end: node.position.end,
		}

		reportError(semicolonAccount.message, semicolon, {
			code: semicolonAccount.code,
			labels: [primary(semicolon, semicolonAccount.label)],
			notes: [...semicolonAccount.notes],
			helps: [...semicolonAccount.helps],
			data: {
				kind: "essence-spelling",
				position: semicolon,
				spelling: "",
			},
		})

		return true
	}

	// `user!` and `user?` arrive as one name each. They are answered before
	// the operator table, which would read the `!` as a negation.
	if (name.length > 1 && (name.endsWith("!") || name.endsWith("?"))) {
		let value = name.slice(0, -1)
		// The `map` clause is offered only where a member is read, as in
		// `user?.name`, whose Help writes `map(.name)`.
		let reached = context.readMember ?? null

		reportError(
			`Essence has no '${name.slice(-1)}' after a value`,
			node.position,
			{
				code: "foreign-syntax",
				labels: [primary(node.position, "this is read as one name")],
				notes: [
					"A value that may be missing is an Optional, which is taken apart rather than reached into or asserted away.",
				],
				helps: [
					reached === null
						? `Write '${value}::value(defaultingTo d)' for the value or a fallback.`
						: `Write '${value}::map(.${reached})' to reach through one, and '${value}::value(defaultingTo d)' for the value or a fallback.`,
					"Or take it apart with a 'match', which is the only way to the value itself.",
				],
			},
		)

		return true
	}

	let operator = foreignOperatorIn(name)

	if (operator !== null) {
		// `count++` is one Identifier, so the Help can write the reassignment
		// out. The parser answers `count += 1`, which the `=` splits.
		let counted =
			name.endsWith(operator) && name.length > operator.length
				? compoundAssignmentHelps(
						operator,
						name.slice(0, -operator.length),
						null,
					)
				: null

		// `!ready` is one Identifier, so the Help can name the operand. The
		// parser refuses an infix operator.
		reportOperatorNotSupported(
			operator,
			node.position,
			counted !== null
				? [...counted]
				: operator === "!" && name.startsWith("!") && name.length > 1
					? [`Write '${name.slice(1)}::negate()'.`]
					: [],
		)

		return true
	}

	return reportBareCaseName(node, scope, context)
}

// Shared by the report and the rule that silences the rest of its line.
const foreignStringMessage = "A String is written in double quotes"

// `'hi'` and `` `hi` `` are one Identifier each, so the Help can respell the
// String. A `{` ends a name, so `` `Hello ${name}` `` arrives in pieces. It is
// reported once, at its opening quote, and only a whole String gets a fix.
function reportForeignString(node: parser.IdentifierNode, name: string): void {
	let quote = name[0] as string
	let closed = name.length >= 2 && name.endsWith(quote)

	reportError(foreignStringMessage, node.position, {
		code: "foreign-syntax",
		labels: [
			primary(node.position, "this is read as a name, not a String"),
		],
		notes: [
			"Double quotes are the only String Literal, and every one of them interpolates: '\"Hello, {name}\"'.",
			...(closed
				? []
				: [
						"A hole carries no '$' — a '$' written in a String is a '$' the String prints.",
					]),
		],
		helps: closed
			? [`Write '"${name.slice(1, -1)}"'.`]
			: [
					`Write the whole String in double quotes, each hole in braces: '"Hello, {name}"'.`,
				],
		...(closed
			? {
					data: {
						kind: "essence-spelling" as const,
						position: node.position,
						spelling: `"${name.slice(1, -1)}"`,
					},
				}
			: {}),
	})
}

// One word of another language, answered where it stands. Answers whether
// it reported.
function reportForeignWord(
	node: parser.IdentifierNode,
	word: ForeignWord | null,
): boolean {
	if (word === null) {
		return false
	}

	reportError(`'${node.content}' names nothing in Essence`, node.position, {
		code: "foreign-syntax",
		labels: [primary(node.position, "no such Variable or Constant")],
		notes: [word.note],
		helps: [...word.helps],
		...(word.spelling === null
			? {}
			: {
					data: {
						kind: "essence-spelling" as const,
						position: node.position,
						spelling: word.spelling,
					},
				}),
	})

	return true
}

// `constant light: Light = Red`: a Case without its `#`, reported as an
// undeclared name whose Notes name every Choice declaring the Case. Nothing
// is said for an applied name whose Cases take no payload, or where a
// `foreign-syntax` report stands on the line. The fix is withheld for an
// unapplied name whose Cases all need a payload.
function reportBareCaseName(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
	context: NameContext,
): boolean {
	let applied = context.applied === true

	let declaring = findCaseTypesInScope(scope).filter(
		(candidate) => candidate.name === node.content,
	)

	if (
		declaring.length === 0 ||
		reportedOnLine("foreign-syntax", node.position.start.line)
	) {
		return false
	}

	let carriesPayload = declaring.map(
		(candidate) => Object.keys(candidate.members).length > 0,
	)

	if (applied && carriesPayload.every((carries) => !carries)) {
		return false
	}

	let payloadWanted = !applied && carriesPayload.every((carries) => carries)

	let choiceNames = [
		...new Set(
			declaring.map((candidate) => displayChoiceName(candidate.choice)),
		),
	]

	// A Record Literal's shorthand member is spelled out, since `{ #Red }` is
	// no Record Literal.
	let written = memberSpelling(
		node.content,
		`#${node.content}${payloadWanted ? "(…)" : ""}`,
		context,
	)

	reportError(`'${node.content}' is not declared`, node.position, {
		code: "unknown-name",
		labels: [primary(node.position, "no such Variable or Constant")],
		notes: [
			...choiceNames.map(
				(choiceName) =>
					`'${choiceName}' declares a Case '#${node.content}'.`,
			),
			"A Case is written with a '#' in front of it, which is what tells one from a name.",
		],
		helps: [
			payloadWanted
				? `Write '${written}' — the Case carries a payload.`
				: `Write '${written}'.`,
		],
		...(payloadWanted
			? {}
			: {
					data: {
						kind: "essence-spelling" as const,
						position: node.position,
						spelling: written,
					},
				}),
	})

	return true
}

// Reported here or thrown by the parser, depending on how the operator lexes.
// Both read their words from `foreignOperatorAccount`.
export function reportOperatorNotSupported(
	operator: string,
	position: common.Position,
	// Helps naming a prefix operator's operand, which replace the table's
	// Help with its placeholder.
	leadingHelps: Array<string> = [],
): void {
	let account = foreignOperatorAccount(operator, leadingHelps)

	if (account === null) {
		return
	}

	reportError(account.message, position, {
		code: account.code,
		labels: [primary(position, account.label)],
		notes: account.notes,
		helps: account.helps,
	})
}

// What the position a name stands in knows about it. None of it changes a
// lookup; it informs what an undeclared name is told.
export type NameContext = {
	// Written as a Record Literal's shorthand member, `{ x }`.
	shorthandMember?: boolean
	// Written with Arguments, as `Error("x")` is. See `reportBareCaseName`.
	applied?: boolean
	// The member read off it, the `name` of `user?.name`.
	readMember?: string | null
	// The whole of a String's hole, as in `"use { and } carefully"`, where the
	// reader likely meant to print the braces.
	inStringHole?: boolean
}

export function resolveIdentifierType(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
	context: NameContext = {},
): common.Type {
	let name = node.content
	let resolved = findVariableOrBarredName(name, scope)

	if (resolved?.found === "barred") {
		reportBarredDefaultName(
			node,
			resolved.barred,
			boundOutsideTheParameterList(name, scope),
		)

		return { type: "Error" }
	}

	let result = resolved?.type ?? null

	if (result === null) {
		// A name whose Declaration the parser dropped is not reported again.
		if (declarationWasAbandoned(scope, name, node.position)) {
			return { type: "Error" }
		}

		if (resolveWrittenProtocol(node, scope) !== null) {
			reportError(
				`Protocol '${name}' can not be used as a value`,
				node.position,
				{
					code: "protocol-as-value",
					labels: [primary(node.position, "this names a Protocol")],
					notes: [
						`A Protocol is only usable as a Generic bound ('<infer T is ${name}>') or in a conformance clause ('is ${name}').`,
					],
					// A value conforming to the Protocol is what a bounded Type
					// Parameter carries.
					helps: [
						`Name a value instead, and bound the Type Parameter that takes it: '<infer T is ${name}>'.`,
					],
				},
			)
		} else if (!reportForeignName(node, scope, context)) {
			// A member of the enclosing Namespace, or of one in scope, written
			// without its Namespace. For a Namespace merely in scope, a near miss
			// leads, since `head` under `constant heads` is likelier a misspelling
			// than `Http.head`.
			let reached = namespaceReach(node, scope, context)
			let suggestion =
				reached === null || reached.inScope === true
					? suggestionInScope(name, scope, "members")
					: null
			let nearMiss =
				suggestion === null ? [] : [`Did you mean '${suggestion}'?`]
			let leads = suggestion !== null && reached !== null

			reportError(`'${name}' is not declared`, node.position, {
				code: "unknown-name",
				labels: [
					primary(node.position, "no such Variable or Constant"),
				],
				notes: [
					...(context.shorthandMember
						? [
								`A bare member name in a Record Literal is the member AND its value, so '${name}' is read here as well as written.`,
							]
						: []),
					// See `inStringHole`.
					...(context.inStringHole === true
						? [
								`A '{' inside a String opens a hole, which holds an Expression — so '${name}' is read as a name rather than printed.`,
							]
						: []),
					...(reached?.notes ?? []),
				],
				// The braces' Help comes last: a name near a declared one is
				// likelier a mistyped hole than prose.
				helps: [
					...(leads
						? [
								...nearMiss,
								...(reached?.helps ?? []).map(following),
							]
						: [...(reached?.helps ?? []), ...nearMiss]),
					...(context.inStringHole === true
						? [
								"Write '\\{' and '\\}' where the braces stand for themselves.",
							]
						: []),
				],
				...(reached?.spelling === undefined || leads
					? suggestionData(suggestion)
					: {
							data: {
								kind: "essence-spelling" as const,
								position: node.position,
								spelling: reached.spelling,
							},
						}),
			})
		}

		return { type: "Error" }
	} else {
		reportProvidedMethodOutOfReach(node, scope)

		return result
	}
}

// How an undeclared name could still be reached. A static is `Namespace.name`
// even inside its Namespace, so a bare `noon` under `static noon = 43_200`
// is undeclared. The enclosing Namespace is asked first, then the Namespaces
// in scope (`inScope`). `spelling` is the fix, absent where the reader must
// choose between several Namespaces.
function namespaceReach(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
	context: NameContext,
): {
	notes: Array<string>
	helps: Array<string>
	spelling?: string
	inScope?: boolean
} | null {
	let name = node.content
	let enclosing = enclosingNamespaceOf(scope)
	let enclosingMethod = enclosing?.type.methods[name]

	if (
		enclosing !== null &&
		(Object.hasOwn(enclosing.type.properties, name) ||
			isStaticMethod(enclosingMethod))
	) {
		let written = memberSpelling(name, `${enclosing.name}.${name}`, context)

		return {
			notes: [
				`A static is reached through its Namespace, inside the Namespace too.`,
			],
			helps: [`Write '${written}'.`],
			spelling: written,
		}
	}

	// An instance Method is reached through `@`, which a static Method's
	// body does not have.
	let self = findSelfBinding(scope)

	if (self !== null && self !== "static") {
		// Which Methods `@` answers is asked of the lookup a `::` call uses,
		// since a Match Handler rebinds `@`. It also finds provided Methods and
		// other Namespaces over the same Type.
		let answering = methodReachedThroughSelf(
			name,
			self.type,
			scope,
			node.position,
		)

		if (answering !== null) {
			let reach = spelledMethodReach("@", name, answering, context)
			let written = memberSpelling(name, reach.spelled, context)

			return {
				notes: [
					`A Method is reached through the value it works on, which is '@' here.`,
				],
				helps: [`Write '${written}'.`],
				...(reach.fixable ? { spelling: written } : {}),
			}
		}

		if (
			self.type.type === "Record" &&
			Object.hasOwn(self.type.members, name)
		) {
			let written = memberSpelling(name, `@.${name}`, context)

			return {
				notes: [
					`'${name}' is a member of ${describeType(self.type)}, and a member is read off the value rather than named on its own.`,
				],
				helps: [`Write '${written}'.`],
				spelling: written,
			}
		}

		// Inside a Match Handler, `@` is the matched value and the receiver
		// has no name. The Help names it above the `match`; that takes two
		// edits, so there is no fix.
		if (
			enclosing !== null &&
			enclosingMethod !== undefined &&
			self.matched
		) {
			let reach = spelledMethodReach(
				"receiver",
				name,
				enclosingMethod,
				context,
			)

			return {
				notes: [
					`'${name}' is a Method of '${enclosing.name}', and the '@' here is the value this Handler matched — ${withArticle(describeType(self.type))} rather than the value the Method works on.`,
				],
				helps: [
					`Name the receiver above the 'match' — 'constant receiver = @' — and write '${memberSpelling(name, reach.spelled, context)}'.`,
				],
			}
		}
	}

	// A static value or Method named outside its Namespace, as `Pi` for
	// `Number.Pi`. Several declaring Namespaces are listed without a fix.
	let declaring = [...getAllNamespacesInScope(scope, null).entries()].flatMap(
		([namespaceName, namespaceType]) =>
			Object.hasOwn(namespaceType.properties, name) ||
			isStaticMethod(namespaceType.methods[name])
				? [namespaceName]
				: [],
	)

	if (declaring.length === 1) {
		let written = memberSpelling(name, `${declaring[0]}.${name}`, context)

		return {
			notes: [
				`'${declaring[0]}' declares a static '${name}', and a static is reached through its Namespace.`,
			],
			helps: [`Write '${written}'.`],
			spelling: written,
			inScope: true,
		}
	}

	if (declaring.length > 1) {
		return {
			notes: declaring.map(
				(namespaceName) =>
					`'${namespaceName}' declares a static '${name}'.`,
			),
			helps: [
				`Write the Namespace in front of it — '${memberSpelling(name, `${declaring[0]}.${name}`, context)}'.`,
			],
			inScope: true,
		}
	}

	return null
}

// A Help offered as an alternative to the one before it, opening on "Or".
function following(help: string): string {
	return `Or ${(help[0] as string).toLowerCase()}${help.slice(1)}`
}

// A reach as written where it stands. In a shorthand member `{ head }` it is
// `{ head = Http.head }`, since `{ Http.head }` is refused.
function memberSpelling(
	name: string,
	reach: string,
	context: NameContext,
): string {
	return context.shorthandMember === true ? `${name} = ${reach}` : reach
}

// Which Method of this name a `::` call on the value would reach, through
// the lookup an Invocation uses, as `methodAnswersFor` asks. Null where none
// answers. Only the first declaring Namespace is read, to decide parentheses.
function methodReachedThroughSelf(
	name: string,
	selfType: common.Type,
	scope: enricher.Scope,
	position: common.Position,
): common.MethodType | null {
	let { instanceNamespaces } = partitionInstanceMethodNamespaces(
		name,
		namespacesDeclaringMethod(
			name,
			resolveMethodLookupNamespacesForReceiverType(selfType, null, scope),
			selfType,
			scope,
			position,
		),
	)

	for (let namespace of instanceNamespaces.values()) {
		let method = namespace.methods[name]

		if (method !== undefined) {
			return method
		}
	}

	return null
}

// Parentheses as `reportMethodCalledWithDot` writes them: a bare name gets
// them, with `…` where the Method takes Arguments, which is no fix.
function spelledMethodReach(
	receiver: string,
	name: string,
	method: common.MethodType,
	context: NameContext,
): { spelled: string; fixable: boolean } {
	let applied = context.applied === true
	let answersAlone = answersWithoutArguments(method)

	return {
		spelled: applied
			? `${receiver}::${name}`
			: `${receiver}::${name}${answersAlone ? "()" : "(…)"}`,
		fixable: applied || answersAlone,
	}
}

// Whether a member is reached on the Namespace (`Namespace.method(…)`) rather
// than on a value. `undefined`, an undeclared name, is not.
export function isStaticMethod(method: common.Type | undefined): boolean {
	return (
		method !== undefined &&
		(method.type === "StaticMethod" ||
			method.type === "OverloadedStaticMethod")
	)
}

// The Namespace a Scope stands inside. See `Scope.namespace`.
export function enclosingNamespaceOf(
	scope: enricher.Scope,
): { name: string; type: common.NamespaceType } | null {
	for (
		let searchScope: enricher.Scope | null = scope;
		searchScope !== null;
		searchScope = searchScope.parent
	) {
		if (searchScope.namespace !== undefined) {
			return searchScope.namespace
		}
	}

	return null
}

// What `@` refers to here: the nearest binding, with a static Method's body
// stopping the walk, since it is emitted without a receiver.
function findSelfBinding(
	scope: enricher.Scope,
): { type: common.Type; matched: boolean } | "static" | null {
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		if (Object.hasOwn(searchScope.members, "@")) {
			// `matched` tells a Match Handler's `@` from a receiver, for
			// `namespaceReach`.
			return {
				type: searchScope.members["@"],
				matched: searchScope.isMatchHandlerBody === true,
			}
		}

		if (searchScope.isStaticMethodBody) {
			return "static"
		}

		searchScope = searchScope.parent
	}

	return null
}

export function resolveSelfType(
	node: parser.SelfNode,
	scope: enricher.Scope,
): common.Type {
	let binding = findSelfBinding(scope)

	if (binding === "static") {
		reportError("There is no '@' in a static Method", node.position, {
			code: "at-in-static-method",
			labels: [
				primary(
					node.position,
					"this Method is called on the Namespace",
				),
			],
			notes: [
				"'@' is the receiver of an instance Method, and a static Method is called without one.",
			],
			// Dropping 'static' changes every call site, so taking the value
			// as a Parameter comes first.
			helps: [
				"Take the value as a Parameter, or drop 'static' to make this an instance Method — then every call writes its receiver, 'value::name(…)' rather than 'Namespace.name(…)'.",
			],
		})

		return { type: "Error" }
	}

	let result = binding === null ? null : binding.type

	if (result === null) {
		reportError("There is no '@' here to refer to", node.position, {
			code: "at-outside-method",
			labels: [
				primary(node.position, "this is outside any Method or Handler"),
			],
			notes: [
				"'@' is the receiver of a Method or the value a Match Handler matched.",
			],
		})

		return { type: "Error" }
	} else {
		return result
	}
}

export function resolveGenericDeclarations(
	generics: Array<parser.GenericDeclarationNode>,
	scope: enricher.Scope,
): Array<common.GenericDeclaration> {
	return generics.map((generic) => {
		let defaultType = null

		if (generic.name.content === "Self") {
			reportReservedTypeName(generic.name.position)
		}

		if (generic.defaultType) {
			defaultType = resolveType(generic.defaultType, scope)
		}

		let protocol =
			generic.constraint === null
				? null
				: resolveWrittenProtocol(generic.constraint, scope)

		// Not carried, so that no call is refused over it a second time.
		if (generic.constraint !== null && protocol === null) {
			reportUnknownProtocol(generic.constraint, scope)
		}

		return {
			name: generic.name.content,
			infer: generic.inferred,
			defaultType,
			constraint: protocol?.identity ?? null,
		}
	})
}

// Declared Type Parameters, registered as opaque GenericUses for the
// signature to name. Each use site binds them.
export function scopeWithGenerics(
	generics: Array<parser.GenericDeclarationNode>,
	scope: enricher.Scope,
	// Bounds that hold without being written, from a bounded generic Choice a
	// Namespace targets. A written bound wins.
	implied: Map<string, string> = new Map(),
): enricher.Scope {
	let types: Record<string, common.Type> = {}

	for (let generic of generics) {
		let name = generic.name.content

		// `resolveGenericDeclarations` reports a bound naming no Protocol;
		// marking it keeps it from being asked again.
		if (generic.constraint === null) {
			let constraint = implied.get(name)

			types[name] = {
				type: "GenericUse",
				name,
				...(constraint === undefined ? {} : { constraint }),
			}
		} else {
			let protocol = resolveWrittenProtocol(generic.constraint, scope)

			types[name] = {
				type: "GenericUse",
				name,
				...(protocol === null
					? { refusedBound: true as const }
					: { constraint: protocol.identity }),
			}
		}
	}

	return childScope(scope, { types })
}

// The Type Parameters a Choice declares, with their bounds, looked up by its
// identity. Empty for a Choice that is not generic.
function declaredChoiceGenerics(
	identity: string,
	scope: enricher.Scope,
): Array<common.GenericDeclaration> {
	let declared = choiceBindingIn(identity, scope)?.type

	return declared?.type === "GenericAlias" ? declared.generics : []
}

// The bounds a Namespace's Type Parameters carry because its target demands
// them: every `SortedBox<X>` of a `choice SortedBox<Item is Comparable>`
// proves `X` Comparable. They bound every Method, and the target is resolved
// silently with unbounded Parameters to find them.
export function impliedTargetBounds(
	node: parser.NamespaceDefinitionStatementNode,
	scope: enricher.Scope,
): Map<string, string> {
	let bounds = new Map<string, string>()

	// Only a named Type can be a Choice, so a written Record or Function
	// target skips the second resolution.
	if (
		node.targetType === null ||
		node.generics.length === 0 ||
		node.targetType.nodeType === "RecordTypeDeclaration" ||
		node.targetType.nodeType === "FunctionTypeDeclaration"
	) {
		return bounds
	}

	let declared = new Set(node.generics.map((generic) => generic.name.content))
	let target = collectDiagnostics(() =>
		resolveType(node.targetType!, scopeWithGenerics(node.generics, scope)),
	).result

	return choiceArgumentBounds(target, declared, (choice) =>
		declaredChoiceGenerics(choice, scope),
	)
}

// A Declaration always has its annotation; only a Function literal Argument
// omits one, and it resolves contextually.
export function resolveDeclaredType(
	node: parser.TypeDeclarationNode | null,
	scope: enricher.Scope,
): common.Type {
	if (node === null) {
		return { type: "Error" }
	}

	return resolveType(node, scope)
}

// A fully annotated Function signature. A literal that omits an annotation
// is resolved by the enricher, which can read its body.
export function resolveFunctionSignatureType(
	node: parser.FunctionDefinitionNode,
	scope: enricher.Scope,
): common.FunctionType {
	let functionScope = scopeWithGenerics(node.generics, scope)

	return {
		type: "Function",
		generics: inferringRefused(
			resolveGenericDeclarations(node.generics, scope),
			node.generics,
			new Set(),
		),
		parameterTypes: resolveParameterTypes(node, functionScope),
		returnType: resolveDeclaredType(node.returnType, functionScope),
		documentation: resolvedDocumentation(
			node.documentation,
			node.parameters,
		),
	}
}

// One free-Function entry, bodied or native, read through the
// `methodSignatureEntry` a Namespace Method uses, without a receiver.
function resolveFreeFunctionEntry(
	entry: parser.FunctionValueNode | parser.NativeMethodSignatureNode,
	scope: enricher.Scope,
): common.BaseFunction {
	let signature = methodSignatureEntry(entry)
	let functionScope = scopeWithGenerics(signature.generics, scope)

	return {
		generics: inferringRefused(
			resolveGenericDeclarations(signature.generics, scope),
			signature.generics,
			new Set(),
		),
		parameterTypes: resolveParameterTypes(signature, functionScope),
		returnType: resolveDeclaredType(signature.returnType, functionScope),
		documentation: resolvedDocumentation(
			signature.documentation,
			signature.parameters,
		),
	}
}

// An overloaded free Function is an `OverloadedStaticMethod`, having no
// receiver. Its entries keep their written order, the `__overload$N` index.
export function resolveOverloadedFunctionStatementType(
	node: parser.OverloadedFunctionStatementNode,
	scope: enricher.Scope,
): common.OverloadedStaticMethodType {
	let entries = node.methods.map((entry) => methodSignatureEntry(entry))

	reportDocumentationParameters(
		node.documentation,
		entries.map((entry) => entry.parameters),
	)
	refuseAmbiguousOverloadDefaults(entries)

	let overloads = node.methods.map((entry) =>
		resolveFreeFunctionEntry(entry, scope),
	)

	refuseAmbiguousPartialDefaults(entries, overloads)

	return {
		type: "OverloadedStaticMethod",
		overloads,
		documentation: node.documentation ?? undefined,
	}
}

export function resolveProtocolDeclarationStatementType(
	node: parser.ProtocolDeclarationStatementNode,
	scope: enricher.Scope,
	options: {
		// The Protocols still to hoist. Extending one throws `NotHoistedYet`,
		// since its Methods are part of this surface.
		deferOnPendingProtocols?: ReadonlySet<string>
		// Set for a Protocol in an extension cycle, which resolves to its own
		// surface.
		ignoreExtensions?: boolean
	} = {},
): common.ProtocolType {
	// `Self` names the conforming Type inside a Protocol. Checked here because
	// the hoist skips the declaration check.
	if (node.name.content === "Self") {
		reportReservedTypeName(node.name.position)
	}

	// `Self` is a GenericUse in the signatures, substituted per conformer.
	let selfType: common.GenericUse = { type: "GenericUse", name: "Self" }
	let signatureScope = childScope(scope, { types: { Self: selfType } })

	let methods: Record<string, common.MethodType> = {}
	let identity = protocolIdentity(
		modulePathOf(scope),
		node.name.content,
		scope.programTop === true ? null : node.name.position,
	)
	// Which Methods carry a body, and which Protocol wrote it, so a provided
	// Method is emitted once, under its writer.
	let providedMethods: Record<string, string> = {}
	let conformsTo: Array<string> = []
	let ancestors: Array<DeclaredAncestor> = []
	let inherited = new Map<string, Array<common.MethodType>>()

	// The ancestors first, so the Protocol's own entries replace inherited
	// ones of the same name.
	if (options.ignoreExtensions !== true) {
		for (let clause of node.conformsTo) {
			let ancestor = resolveExtendedProtocol(clause, scope, options)

			if (ancestor === null) {
				continue
			}

			ancestors.push({ clause, ancestor })

			for (let ancestorIdentity of [
				ancestor.identity,
				...(ancestor.conformsTo ?? []),
			]) {
				if (!conformsTo.includes(ancestorIdentity)) {
					conformsTo.push(ancestorIdentity)
				}
			}

			for (let [methodName, method] of Object.entries(ancestor.methods)) {
				inherited.set(methodName, [
					...(inherited.get(methodName) ?? []),
					method,
				])
			}

			Object.assign(providedMethods, ancestor.providedMethods ?? {})
		}
	}

	for (let [methodName, entries] of inherited) {
		let entry = inheritedEntry(methodName, entries)
		let writer = inheritedBodyWriter(methodName, entry, ancestors)

		methods[methodName] = entry

		if (writer !== null) {
			providedMethods[methodName] = writer
		}
	}

	for (let [methodName, methodValue] of Object.entries(node.methods)) {
		methods[methodName] = resolveProtocolMethodType(
			methodValue,
			signatureScope,
			selfType,
		)

		if (protocolMethodBody(methodValue) === null) {
			// A requirement of this Protocol's own replaces an ancestor's
			// body, so conformers owe the Method again.
			delete providedMethods[methodName]
		} else {
			providedMethods[methodName] = identity
		}
	}

	let providedReads: Record<string, Array<string>> = {}

	for (let [methodName, methodValue] of Object.entries(node.methods)) {
		let body = protocolMethodBody(methodValue)

		if (body !== null) {
			providedReads[methodName] = providedBodyReads(
				body.value,
				methods[methodName]!,
				methods,
			)
		}
	}

	let protocol: common.ProtocolType = {
		type: "Protocol",
		name: node.name.content,
		identity,
		methods,
		...(Object.keys(providedMethods).length === 0
			? {}
			: { providedMethods }),
		...(Object.keys(providedReads).length === 0 ? {} : { providedReads }),
		...(conformsTo.length === 0 ? {} : { conformsTo }),
		documentation: node.documentation ?? undefined,
	}

	declaredAncestors.set(protocol, ancestors)

	return protocol
}

type DeclaredAncestor = {
	clause: parser.ConformanceClauseNode
	ancestor: common.ProtocolType
}

// The Protocol each clause of a declaration extends, read where the clause
// is written. Later, the name may bind the declaration itself.
let declaredAncestors = new WeakMap<
	common.ProtocolType,
	Array<DeclaredAncestor>
>()

export type IncompatibleRestatement = {
	methodName: string
	// The clause whose Protocol declares the Method in a way the entry
	// does not accept.
	refused: DeclaredAncestor
	// The clause the entry came from, or null where the Protocol writes it.
	source: DeclaredAncestor | null
}

// Of the extensions' entries under one name, the last that every other one
// accepts in its place. Where none does, the last entry, which is refused.
function inheritedEntry(
	methodName: string,
	entries: Array<common.MethodType>,
): common.MethodType {
	return (
		entries.findLast((entry) =>
			entries.every(
				(other) =>
					other === entry ||
					typeContainsError(other) ||
					typeContainsError(entry) ||
					restatementAccepts(methodName, other, entry),
			),
		) ?? entries.at(-1)!
	)
}

// The Protocol whose body goes with an inherited entry: the extension it came
// from, else the last whose body fulfils it. Null where none does.
function inheritedBodyWriter(
	methodName: string,
	entry: common.MethodType,
	ancestors: Array<DeclaredAncestor>,
): string | null {
	let writing = ancestors.filter(
		({ ancestor }) => providedMethodProtocol(ancestor, methodName) !== null,
	)
	let carrying =
		writing.findLast(
			({ ancestor }) => ancestor.methods[methodName] === entry,
		) ??
		writing.findLast(({ ancestor }) => {
			let inherited = ancestor.methods[methodName]

			return (
				inherited !== undefined &&
				restatementAccepts(methodName, entry, inherited)
			)
		})

	return carrying === undefined
		? null
		: providedMethodProtocol(carrying.ancestor, methodName)
}

let restatementsOf = new WeakMap<
	common.ProtocolType,
	Array<IncompatibleRestatement>
>()

// The entries a Protocol holds under an inherited name that do not take every
// call the ancestor's entry takes. Each is refused where it is declared, unless
// the extension refuses it itself.
export function incompatibleRestatements(
	protocol: common.ProtocolType,
): Array<IncompatibleRestatement> {
	let known = restatementsOf.get(protocol)

	if (known !== undefined) {
		return known
	}

	let ancestors = declaredAncestors.get(protocol) ?? []
	let found: Array<IncompatibleRestatement> = []
	let refusesItself = (ancestor: common.ProtocolType, methodName: string) =>
		incompatibleRestatements(ancestor).some(
			(restatement) => restatement.methodName === methodName,
		)

	for (let [methodName, entry] of Object.entries(protocol.methods)) {
		let refused = ancestors.find(({ ancestor }) => {
			if (!Object.hasOwn(ancestor.methods, methodName)) {
				return false
			}

			let inherited = ancestor.methods[methodName]

			return (
				inherited !== entry &&
				!typeContainsError(inherited) &&
				!typeContainsError(entry) &&
				!restatementAccepts(methodName, inherited, entry)
			)
		})
		let source =
			ancestors.findLast(
				({ ancestor }) => ancestor.methods[methodName] === entry,
			) ?? null

		if (
			refused !== undefined &&
			(source === null ||
				(!refusesItself(source.ancestor, methodName) &&
					!refusesItself(refused.ancestor, methodName)))
		) {
			found.push({ methodName, refused, source })
		}
	}

	restatementsOf.set(protocol, found)

	return found
}

// A Namespace's mismatch of a Method that a Protocol it conforms to is
// refused for restating repeats that refusal. It is silent where this Module
// reports it, and names it in a Note where another Module does.
function restatementEcho(
	namespace: common.NamespaceType,
	methodNames: ReadonlyArray<string>,
	scope: enricher.Scope,
): { silent: boolean; notes: Array<string> } {
	for (let identity of namespace.conformsTo ?? []) {
		let protocol = protocolOf(identity, scope)
		let restatement = incompatibleRestatements(protocol).find(
			({ methodName }) => methodNames.includes(methodName),
		)

		if (restatement === undefined) {
			continue
		}

		let modulePath = identityModulePath(protocol.identity)
		let reader = modulePathOf(scope)

		if (modulePath === reader) {
			return { silent: true, notes: [] }
		}

		let restates = restatement.source === null ? "restates" : "inherits"
		let declared =
			modulePath === null || reader === null
				? "where it is declared"
				: `where ${modulePath.slice(modulePath.lastIndexOf("/") + 1)} declares it`

		return {
			silent: false,
			notes: [
				`'${describeProtocol(protocol.identity, scope)}' ${restates} '${restatement.methodName}' with a signature '${describeProtocol(restatement.refused.ancestor.identity, scope)}' does not accept, and is refused ${declared}.`,
			],
		}
	}

	return { silent: false, notes: [] }
}

function identityModulePath(identity: string): string | null {
	let separator = identity.lastIndexOf("#")

	return separator === -1 ? null : identity.slice(0, separator)
}

// One `is X` of a Protocol's extension list, or null where it names nothing.
// A `where` clause is refused, since a Protocol has no Type Parameters for it
// to bound.
function resolveExtendedProtocol(
	clause: parser.ConformanceClauseNode,
	scope: enricher.Scope,
	options: { deferOnPendingProtocols?: ReadonlySet<string> },
): common.ProtocolType | null {
	let identifier = clause.protocol
	let ancestor = resolveWrittenProtocol(identifier, scope)

	if (ancestor === null) {
		if (options.deferOnPendingProtocols?.has(identifier.content) === true) {
			throw new NotHoistedYet(
				`Protocol '${identifier.content}' has not been hoisted yet`,
			)
		}

		reportUnknownProtocol(identifier, scope)

		return null
	}

	for (let condition of clause.conditions) {
		reportError(
			"A Protocol extension can not carry a 'where' clause",
			condition.position,
			{
				code: "where-on-protocol-extension",
				labels: [
					primary(
						condition.position,
						"this condition has nothing to bound",
					),
				],
				notes: [
					"A 'where' condition bounds one of the declaring Namespace's Type Parameters, and a Protocol declares none.",
				],
				helps: [
					`Write 'is ${identifier.content}' on its own, and bound the Type Parameter where the conforming Namespace is declared.`,
				],
			},
		)
	}

	return ancestor
}

// The body a Protocol Method carries, or null for a requirement. A static or
// overloaded entry is refused at the declaration and read as a requirement.
export function protocolMethodBody(
	method: parser.ProtocolMethods[string],
): parser.FunctionValueNode | null {
	return method.nodeType === "SimpleProtocolMethod"
		? method.signature.body
		: null
}

function resolveProtocolSignature(
	signature: parser.ProtocolMethodSignatureNode,
	scope: enricher.Scope,
	selfType: common.GenericUse | null,
): common.BaseFunction {
	let parameterTypes = resolveParameterTypes(signature, scope)

	if (selfType !== null) {
		parameterTypes = [{ name: null, type: selfType }, ...parameterTypes]
	}

	return {
		generics: [],
		parameterTypes,
		returnType: resolveType(signature.returnType, scope),
		documentation: resolvedDocumentation(
			signature.documentation,
			signature.parameters,
		),
	}
}

function resolveProtocolMethodType(
	node: parser.ProtocolMethods[string],
	scope: enricher.Scope,
	selfType: common.GenericUse,
): common.MethodType {
	if (node.nodeType === "SimpleProtocolMethod") {
		return {
			type: "SimpleMethod",
			...resolveProtocolSignature(node.signature, scope, selfType),
		}
	} else if (node.nodeType === "StaticProtocolMethod") {
		return {
			type: "StaticMethod",
			...resolveProtocolSignature(node.signature, scope, null),
		}
	} else if (node.nodeType === "OverloadedProtocolMethod") {
		reportDocumentationParameters(
			node.documentation,
			node.signatures.map((signature) => signature.parameters),
		)

		return {
			type: "OverloadedMethod",
			overloads: node.signatures.map((signature) =>
				resolveProtocolSignature(signature, scope, selfType),
			),
			documentation: node.documentation ?? undefined,
		}
	} else {
		reportDocumentationParameters(
			node.documentation,
			node.signatures.map((signature) => signature.parameters),
		)

		return {
			type: "OverloadedStaticMethod",
			overloads: node.signatures.map((signature) =>
				resolveProtocolSignature(signature, scope, null),
			),
			documentation: node.documentation ?? undefined,
		}
	}
}

// A generic Namespace with its target and signatures rewritten through the
// bindings that unified its target with a receiver. Fresh objects throughout,
// so the builtin tables are never mutated.
function specializeNamespace(
	namespace: common.NamespaceType,
	bindings: GenericBindings,
): common.NamespaceType {
	let methods: Record<string, common.MethodType> = {}

	for (let [name, method] of Object.entries(namespace.methods)) {
		methods[name] = applyGenericBindings(
			method,
			bindings,
		) as common.MethodType
	}

	return {
		...namespace,
		targetType:
			namespace.targetType === null
				? null
				: applyGenericBindings(namespace.targetType, bindings),
		methods,
		generics: [],
	}
}

// The Namespaces that target a receiver, specialized against it, so a
// Diagnostic about a `List<Integer>` spells `Integer` rather than `ItemType`.
// A Namespace whose target does not unify passes through unchanged.
export function specializedNamespacesFor(
	namespaces: Map<string, common.NamespaceType>,
	baseType: common.Type,
): Map<string, common.NamespaceType> {
	let specialized: Map<string, common.NamespaceType> = new Map()

	for (let [name, namespace] of namespaces) {
		if (namespace.generics.length === 0 || namespace.targetType === null) {
			specialized.set(name, namespace)
			continue
		}

		let bindings = bindNamespaceTarget(namespace, baseType)

		specialized.set(
			name,
			bindings === null
				? namespace
				: specializeNamespace(namespace, bindings),
		)
	}

	return specialized
}

// The outcome of solving one conformance. A success carries the witness
// source; a failure carries the because-chain, outermost first, empty where
// it was already reported. `culprit` is the Type that has no conforming
// Namespace, such as `Problem` in `Result<String, Problem>`. The Help names it,
// since a Namespace `for Result<String, Problem>` leaves other Results unprintable.
type ConformanceSolveResult =
	| { ok: true; source: common.ConformanceSource }
	| {
			ok: false
			chain: Array<string>
			culprit?: { type: common.Type; protocolName: string }
			// The dotted path to the Record member the refusal is about.
			memberPath?: string
			// Set where the cycle guard refused because the question is open
			// further up. A recursive Type keeps its conformance.
			cycle?: true
			// Helps replacing "declare a Namespace", where none would answer.
			helps?: Array<string>
	  }

type ScopeConformanceState = {
	memo: Map<string, ConformanceSolveResult>
	inProgress: Set<string>
	// The Scope versions the memo was filled under, as
	// `getAllNamespacesInScope` keeps them.
	versions: Array<{ scope: enricher.Scope; version: number }>
}

// Memoised per Scope, since a local Namespace is visible only in its own
// subtree. The `inProgress` set guards cycles within one solve.
let conformanceStates = new WeakMap<enricher.Scope, ScopeConformanceState>()

// A Scope's visible Namespaces grow as its Statements declare them. So the
// memo is dropped when a version on the chain moves, as the Namespace cache is.
function conformanceStateFor(scope: enricher.Scope): ScopeConformanceState {
	let state = conformanceStates.get(scope)

	if (state === undefined) {
		state = {
			memo: new Map(),
			inProgress: new Set(),
			versions: scopeVersionSnapshot(scope),
		}

		conformanceStates.set(scope, state)
	} else if (!namespaceCacheIsCurrent(state, scope)) {
		state.memo.clear()
		state.versions = scopeVersionSnapshot(scope)
	}

	return state
}

// The derived Namespace names, shared with the rewriter through
// `helpers/conformance.ts`.
export {
	derivedEnumerableNamespaceName,
	derivedEquatableNamespaceName,
	derivedPrintableNamespaceName,
}

// The Protocol printing is derived for.
export const printableProtocolName = "Printable"

// The Protocol a Choice's Cases are listed through, and its Method.
export const enumerableProtocolName = "Enumerable"

export const enumerableMethodName = "cases"

// The names an enrichment reached a conformance or a refused call through
// without writing them, for the linker's unused-import check. A library load
// nested in a compile records into its collection, which can only quiet the
// check.
let reachedNames: Set<string> | null = null

export function collectReachedNames<Result>(run: () => Result): {
	result: Result
	names: Set<string>
} {
	let outer = reachedNames
	let names = new Set<string>()

	reachedNames = names

	try {
		return { result: run(), names }
	} finally {
		reachedNames = outer
	}
}

export function noteReachedName(name: string): void {
	reachedNames?.add(name)
}

// The identity of the Choice a receiver belongs to: a Case's own, or a
// Union's where every member is a Case of one Choice. Two Modules' Choices
// of one name have two identities.
function choiceIdentityOf(baseType: common.Type): string | null {
	if (baseType.type === "Case") {
		return baseType.choice
	}

	if (baseType.type === "UnionType") {
		let members = flattenUnionMembers(baseType)
		let first = members[0]

		if (first === undefined || first.type !== "Case") {
			return null
		}

		if (
			!members.every(
				(member) =>
					member.type === "Case" && member.choice === first.choice,
			)
		) {
			return null
		}

		return first.choice
	}

	return null
}

// The Type Arguments a generic Choice's receiver was instantiated with, in
// declaration order, read off a Case or a Union's first member. Empty
// rebuilds the Choice with its defaults.
function choiceTypeArgumentsOf(baseType: common.Type): Array<common.Type> {
	if (baseType.type === "Case") {
		return baseType.typeArguments ?? []
	}

	if (baseType.type === "UnionType") {
		let first = flattenUnionMembers(baseType)[0]

		if (first !== undefined && first.type === "Case") {
			return first.typeArguments ?? []
		}
	}

	return []
}

// The applied Union of a generic Choice, rebuilt from its Generic Alias and a
// receiver's Type Arguments as `applyGenericAlias` builds it. It never
// reports, since the receiver was accepted already.
function instantiateChoiceAlias(
	alias: common.GenericAliasType,
	typeArguments: Array<common.Type>,
): common.Type {
	let bindings: GenericBindings = new Map()

	for (let index = 0; index < alias.generics.length; index++) {
		let generic = alias.generics[index]

		bindings.set(
			generic.name,
			typeArguments[index] ??
				generic.defaultType ??
				({ type: "Error" } as const),
		)
	}

	let applied = applyGenericBindings(alias.aliasedType, bindings)

	if (
		applied.type === "UnionType" &&
		applied.name === undefined &&
		applied.alias === undefined
	) {
		return {
			...applied,
			alias: {
				name: alias.name,
				typeArguments: alias.generics.map(
					(generic) =>
						bindings.get(generic.name) ?? { type: "Error" },
				),
			},
		}
	}

	return applied
}

// The Choice of a bare Case no name here binds, read off its own Module. It is
// applied to the Case's Type Arguments, as `choiceTypeOf` applies a bound one.
function foreignChoiceTypeOf(
	caseType: common.CaseType,
	foreign: ForeignChoice | null,
	scope: enricher.Scope,
): common.Type | null {
	let declared =
		foreign === null ? null : foreignChoiceDeclaration(foreign, scope)

	return declared?.type === "GenericAlias"
		? instantiateChoiceAlias(declared, choiceTypeArgumentsOf(caseType))
		: declared
}

// The Generic Alias a generic Choice's name resolves to, confirmed to hold
// that Choice's Cases. Null where the name is shadowed or the Choice is not
// generic.
function declaredChoiceAliasOf(
	baseType: common.Type,
	scope: enricher.Scope,
): common.GenericAliasType | null {
	let identity = choiceIdentityOf(baseType)

	if (identity === null) {
		return null
	}

	// Looked up by the identity, under the declared name or an import alias,
	// so another Module's Choice of the name does not count.
	let binding = choiceBindingIn(identity, scope)
	let declared = binding?.type ?? null

	noteReachedName(binding?.name ?? displayChoiceName(identity))

	if (declared === null || declared.type !== "GenericAlias") {
		return null
	}

	let body = declared.aliasedType

	if (body.type !== "UnionType") {
		return null
	}

	let bodyMembers = flattenUnionMembers(body)

	if (
		bodyMembers.length === 0 ||
		!bodyMembers.every(
			(member) => member.type === "Case" && member.choice === identity,
		)
	) {
		return null
	}

	return declared
}

// The Choice a receiver belongs to, or null. A receiver narrowed to one Case
// answers its whole Choice, so `is` reads the same inside a `case #Red`. For
// a generic Choice it is the receiver's applied Union.
function choiceTypeOf(
	baseType: common.Type,
	scope: enricher.Scope,
): common.Type | null {
	let identity = choiceIdentityOf(baseType)

	if (identity === null) {
		return null
	}

	// The declared Choice, so `case #Red { @::is(c) }` takes any Colour. A
	// shadowed Choice answers null, as in `declaredChoiceAliasOf`.
	let binding = choiceBindingIn(identity, scope)
	let declared = binding?.type ?? null

	// Recorded whatever the lookup answers, for the unused-import check.
	noteReachedName(binding?.name ?? displayChoiceName(identity))

	if (declared === null) {
		return null
	}

	// A generic Choice's Alias, applied to the receiver's Type Arguments.
	if (declared.type === "GenericAlias") {
		let alias = declaredChoiceAliasOf(baseType, scope)

		if (alias === null) {
			return null
		}

		return instantiateChoiceAlias(alias, choiceTypeArgumentsOf(baseType))
	}

	if (declared.type !== "UnionType") {
		return null
	}

	let declaredMembers = flattenUnionMembers(declared)

	if (
		declaredMembers.length === 0 ||
		!declaredMembers.every(
			(member) => member.type === "Case" && member.choice === identity,
		)
	) {
		return null
	}

	return declared
}

// Whether a Type mentions any of the named Type Parameters, anywhere inside
// it. A payload member that does is compared through a witness.
function typeMentionsGenerics(
	type: common.Type,
	generics: Set<string>,
): boolean {
	switch (type.type) {
		case "GenericUse":
			return generics.has(type.name)
		case "List":
			return typeMentionsGenerics(type.itemType, generics)
		// One slot each, asked as a List's item Type is.
		case "Future":
		case "Started":
			return typeMentionsGenerics(type.valueType, generics)
		// Either slot is enough.
		case "Dictionary":
			return (
				typeMentionsGenerics(type.keyType, generics) ||
				typeMentionsGenerics(type.valueType, generics)
			)
		case "Record":
		case "Case":
			return Object.values(type.members).some((member) =>
				typeMentionsGenerics(member, generics),
			)
		case "UnionType":
			return type.types.some((member) =>
				typeMentionsGenerics(member, generics),
			)
		// Only the base can name a Type Parameter; conjuncts are literals.
		case "Refinement":
			return typeMentionsGenerics(type.base, generics)
		default:
			return false
	}
}

// The Cases of a Choice's Generic Alias, the members of its body Union.
function choiceAliasCases(alias: common.GenericAliasType): Array<common.Type> {
	return alias.aliasedType.type === "UnionType"
		? flattenUnionMembers(alias.aliasedType)
		: []
}

// The Type Parameters some Case payload mentions. Any other needs neither a
// bound nor a witness.
function mentionedGenerics(alias: common.GenericAliasType): Set<string> {
	let genericNames = new Set(alias.generics.map((generic) => generic.name))
	let mentioned = new Set<string>()

	for (let caseType of choiceAliasCases(alias)) {
		if (caseType.type !== "Case") {
			continue
		}

		for (let member of Object.values(caseType.members)) {
			for (let name of genericNames) {
				if (typeMentionsGenerics(member, new Set([name]))) {
					mentioned.add(name)
				}
			}
		}
	}

	return mentioned
}

// The Type Parameters some payload mentions, in declaration order, which is
// the order of their witness slots. See "Equality descriptors" in
// DEVELOPMENT.md.
function constrainedGenericOrder(
	alias: common.GenericAliasType,
): Array<string> {
	let mentioned = mentionedGenerics(alias)

	return alias.generics
		.map((generic) => generic.name)
		.filter((name) => mentioned.has(name))
}

// The runtime `typeKeySymbol` tag a concrete Type's values carry, or null
// where there is no single tag, as for a Union.
function runtimeTagOf(type: common.Type): string | null {
	switch (type.type) {
		case "Boolean":
			return "Boolean"
		case "String":
			return "String"
		case "Integer":
			return "Integer"
		case "Rational":
			return "Rational"
		case "Algebraic":
			return "Algebraic"
		case "Transcendental":
			return "Transcendental"
		case "Randomness":
			return "Randomness"
		case "Record":
			return "Record"
		case "List":
		case "GenericList":
			return "List"
		// The tag is the value's, so both spellings share it.
		case "Dictionary":
		case "GenericDictionary":
			return "Dictionary"
		case "Case":
			return `${type.choice}#${type.name}`
		// A refinement's values carry their base's tag.
		case "Refinement":
			return runtimeTagOf(type.base)
		default:
			return null
	}
}

// The witness slot a payload member routes through, or null where it is
// compared structurally.
type MemberRouter = (type: common.Type) => number | null

// How one payload member is compared. `bindings` are the receiver's Type
// Arguments, which decide the arms of a Union payload. See "Equality
// descriptors" in DEVELOPMENT.md.
function describeMember(
	type: common.Type,
	constrainedOrder: Array<string>,
	generics: Set<string>,
	bindings: GenericBindings,
	position: common.Position | null,
	// The slot a member naming no Type Parameter routes through, such as
	// `tag: Tag` with a written `is`, or null for a structural member.
	route: MemberRouter = () => null,
): common.DescriptorNode {
	if (!typeMentionsGenerics(type, generics)) {
		let slot = route(type)

		return slot === null ? { k: "eq" } : { k: "w", i: slot }
	}

	switch (type.type) {
		case "GenericUse":
			return { k: "w", i: constrainedOrder.indexOf(type.name) }
		case "List":
			return {
				k: "list",
				of: describeMember(
					type.itemType,
					constrainedOrder,
					generics,
					bindings,
					position,
					route,
				),
			}
		// Keys and values are described apart: a `Dictionary<T, Integer>`
		// routes its keys through `T` and compares its values structurally.
		case "Dictionary":
			return {
				k: "dictionary",
				key: describeMember(
					type.keyType,
					constrainedOrder,
					generics,
					bindings,
					position,
					route,
				),
				value: describeMember(
					type.valueType,
					constrainedOrder,
					generics,
					bindings,
					position,
					route,
				),
			}
		case "Record":
			return {
				k: "record",
				m: describeMembers(
					type.members,
					constrainedOrder,
					generics,
					bindings,
					position,
					route,
				),
			}
		case "Case":
			return {
				k: "case",
				m: describeMembers(
					type.members,
					constrainedOrder,
					generics,
					bindings,
					position,
					route,
				),
			}
		case "UnionType":
			return describeUnion(
				type,
				constrainedOrder,
				generics,
				bindings,
				position,
				route,
			)
		// A refinement compares as its base does, here one naming a Type
		// Parameter, as in `Full { value: NonEmptyList<Item> }`.
		case "Refinement":
			return describeMember(
				type.base,
				constrainedOrder,
				generics,
				bindings,
				position,
				route,
			)
		default:
			return { k: "eq" }
	}
}

// One arm of a `union` descriptor node while it is built: the Type and the
// claim it makes at run time.
type UnionArm = {
	// The arm as written, still naming its Type Parameters.
	type: common.Type
	// See `appliedArmType`.
	applied: common.Type | null
	claim: {
		tag: string | null
		shape?: common.Type
		node: common.DescriptorNode
	} | null
}

// A Union-typed payload member, whose arms claim values by tag and by shape.
// See "Union payloads" in DEVELOPMENT.md.
function describeUnion(
	type: common.UnionType,
	constrainedOrder: Array<string>,
	generics: Set<string>,
	bindings: GenericBindings,
	position: common.Position | null,
	route: MemberRouter = () => null,
): common.DescriptorNode {
	let arms: Array<UnionArm> = flattenUnionMembers(type).map((armType) => ({
		type: armType,
		applied: appliedArmType(armType, generics, bindings),
		claim: null,
	}))

	// The arms standing for a Type Parameter's values. Several would be
	// several fallbacks, so each takes the shape of its Type Argument.
	let parameterArms = arms.filter((arm) =>
		typeMentionsGenerics(arm.type, generics),
	)

	// Without Type Arguments to shape them, no descriptor tells such arms
	// apart, so the comparison is refused.
	if (
		position !== null &&
		parameterArms.length > 1 &&
		parameterArms.some((arm) => arm.applied === null)
	) {
		reportError(
			"This Choice's payload can not be compared here",
			position,
			{
				code: "indistinguishable-union-arms",
				labels: [
					primary(
						position,
						"two arms of a payload Union are one Type at runtime",
					),
				],
				notes: [
					`'${describeType(type)}' names ${countOf(parameterArms.length, "arm")} standing for a Type Parameter's values: ${parameterArms
						.map((arm) => `'${describeType(arm.type)}'`)
						.join(", ")}.`,
					"Type Parameters erase, so which arm a value belongs to is decided by the Type Arguments the receiver was applied to — and here they are Parameters themselves.",
				],
				helps: [
					"Compare the value where its Type Arguments are known, or write the arms so that something other than a Type Parameter tells them apart.",
				],
			},
		)
	}

	// The Types of the Type Parameter arms' values at this receiver, which a
	// concrete arm must not claim. A Union Argument is flattened.
	let witnessTypes = arms.flatMap((arm) =>
		arm.applied === null
			? []
			: arm.applied.type === "UnionType"
				? flattenUnionMembers(arm.applied)
				: [arm.applied],
	)

	for (let arm of arms) {
		let node = describeMember(
			arm.type,
			constrainedOrder,
			generics,
			bindings,
			position,
			route,
		)

		// A Type Parameter arm claims no tag. Where there are several, each
		// one the receiver applies claims its Argument's shape.
		if (typeMentionsGenerics(arm.type, generics)) {
			arm.claim =
				parameterArms.length === 1 || arm.applied === null
					? { tag: null, node }
					: {
							tag: null,
							shape: runtimeShapeOf(arm.applied),
							node,
						}

			continue
		}

		let tag = runtimeTagOf(arm.type)
		let collisions =
			tag === null
				? []
				: witnessTypes.filter(
						(witnessType) => runtimeTagOf(witnessType) === tag,
					)

		if (collisions.length === 0) {
			arm.claim = { tag, node }
			continue
		}

		// An arm accepting exactly the Argument's values stops claiming, and
		// the witness answers for both.
		if (
			collisions.some(
				(witnessType) =>
					matchesType(arm.type, witnessType) &&
					matchesType(witnessType, arm.type),
			)
		) {
			continue
		}

		arm.claim = { tag, shape: runtimeShapeOf(arm.type), node }
	}

	// An Argument that strictly refines a concrete arm gives its Type
	// Parameter arm a shape, which `orderClaims` puts first.
	for (let arm of arms) {
		let applied = arm.applied

		if (applied === null || arm.claim === null) {
			continue
		}

		let refinesAnArm = arms.some(
			(other) =>
				other.applied === null &&
				other.claim?.shape !== undefined &&
				matchesType(other.type, applied),
		)

		if (refinesAnArm) {
			arm.claim.shape = runtimeShapeOf(applied)
		}
	}

	return {
		k: "union",
		arms: orderClaims(
			arms.flatMap((arm) => (arm.claim === null ? [] : [arm.claim])),
		),
	}
}

// The Type a Type Parameter arm stands for at this receiver. Null for a
// concrete arm, without a receiver, or where the receiver leaves its Type
// Parameters unbound.
function appliedArmType(
	arm: common.Type,
	generics: Set<string>,
	bindings: GenericBindings,
): common.Type | null {
	if (bindings.size === 0 || !typeMentionsGenerics(arm, generics)) {
		return null
	}

	let applied = applyGenericBindings(arm, bindings)

	return typeMentionsGenerics(applied, generics) ? null : applied
}

// The shaped claims, most specific first, since Record shapes are open. A tie
// goes to the Type Parameter's arm. Claims without a shape keep their places.
function orderClaims<Claim extends { tag: string | null; shape?: common.Type }>(
	claims: Array<Claim>,
): Array<Claim> {
	let shaped = claims.flatMap((claim, position) =>
		claim.shape === undefined
			? []
			: [{ claim, shape: claim.shape, position }],
	)

	if (shaped.length < 2) {
		return claims
	}

	let ordered = [...shaped].sort((left, right) => {
		let leftFitsRight = matchesType(right.shape, left.shape)
		let rightFitsLeft = matchesType(left.shape, right.shape)

		if (leftFitsRight !== rightFitsLeft) {
			return leftFitsRight ? -1 : 1
		}

		// Two shapes accepting exactly each other's values.
		if (leftFitsRight) {
			return left.claim.tag === null
				? -1
				: right.claim.tag === null
					? 1
					: 0
		}

		return 0
	})

	let claimed = [...claims]

	for (let [index, entry] of ordered.entries()) {
		claimed[shaped[index]!.position] = entry.claim
	}

	return claimed
}

// The part of a Type that `isValueOfType` checks, which is all a descriptor
// needs. Aliases, Type Arguments and a Case's `unitChoice` go. A Case keeps
// its payload, since its instantiations share one tag, and a member still a
// Type Parameter matches anything.
function runtimeShapeOf(type: common.Type): common.Type {
	switch (type.type) {
		case "Record":
			return {
				type: "Record",
				members: Object.fromEntries(
					Object.entries(type.members).map(([name, memberType]) => [
						name,
						runtimeShapeOf(memberType),
					]),
				),
			}
		case "List":
			return { type: "List", itemType: runtimeShapeOf(type.itemType) }
		case "Dictionary":
			return {
				type: "Dictionary",
				keyType: runtimeShapeOf(type.keyType),
				valueType: runtimeShapeOf(type.valueType),
			}
		case "Case":
			return {
				type: "Case",
				choice: type.choice,
				name: type.name,
				members: Object.fromEntries(
					Object.entries(type.members).map(([name, memberType]) => [
						name,
						runtimeShapeOf(memberType),
					]),
				),
			}
		case "UnionType":
			return { type: "UnionType", types: type.types.map(runtimeShapeOf) }
		// The predicate never reaches run time.
		case "Refinement":
			return runtimeShapeOf(type.base)
		default:
			return type
	}
}

function describeMembers(
	members: Record<string, common.Type>,
	constrainedOrder: Array<string>,
	generics: Set<string>,
	bindings: GenericBindings,
	position: common.Position | null,
	route: MemberRouter = () => null,
): Record<string, common.DescriptorNode> {
	let described: Record<string, common.DescriptorNode> = {}

	for (let [name, memberType] of Object.entries(members)) {
		described[name] = describeMember(
			memberType,
			constrainedOrder,
			generics,
			bindings,
			position,
			route,
		)
	}

	return described
}

// The router for a Choice's payload members, as a Record routes its own.
// `types` is the Type of each slot after the Type Parameters, in the order the
// walk met them. See "Equality descriptors" in DEVELOPMENT.md.
type ChoiceMemberRouting = {
	route: MemberRouter
	types: Array<common.Type>
}

function choiceMemberRouting(
	base: number,
	scope: enricher.Scope,
	position: common.Position,
): ChoiceMemberRouting {
	let types: Array<common.Type> = []

	return {
		types,
		route: (type) => {
			let asked = memberConformance(
				type,
				equatableProtocolName,
				scope,
				position,
			)
			let solved = asked.result

			// An ambiguity is forwarded, as `recordMemberRouting` forwards it,
			// but without the member's name, which the router does not have.
			for (let ambiguity of asked.ambiguities) {
				report(ambiguity)
			}

			// A member with no conformance takes a slot, and the call reports
			// `unsatisfied-bound` for it. A refusal already reported, or the
			// cycle guard's, takes none: a recursive Type is a fine Program.
			if (
				!solved.ok &&
				(solved.cycle === true || solved.chain.length === 0)
			) {
				return null
			}

			if (
				solved.ok &&
				conformanceIsStructural(solved.source, equatableProtocolName)
			) {
				return null
			}

			types.push(type)

			return base + types.length - 1
		},
	}
}

// A generic Choice's descriptor, read off the declared Alias, whose Cases
// still name the Type Parameters. `typeArguments` only shape Union payload
// arms. `position` is null for a silent build, as a speculative solve needs.
function derivedEquatableDescriptor(
	alias: common.GenericAliasType,
	typeArguments: Array<common.Type>,
	position: common.Position | null,
	route: MemberRouter = () => null,
): common.DerivedEquatableDescriptor {
	let generics = new Set(alias.generics.map((generic) => generic.name))
	let constrainedOrder = constrainedGenericOrder(alias)
	let bindings: GenericBindings = new Map()
	let descriptor: common.DerivedEquatableDescriptor = {}

	for (let [index, generic] of alias.generics.entries()) {
		let typeArgument = typeArguments[index]

		if (typeArgument !== undefined) {
			bindings.set(generic.name, typeArgument)
		}
	}

	for (let caseType of choiceAliasCases(alias)) {
		if (caseType.type !== "Case") {
			continue
		}

		descriptor[`${caseType.choice}#${caseType.name}`] = describeMembers(
			caseType.members,
			constrainedOrder,
			generics,
			bindings,
			position,
			route,
		)
	}

	return descriptor
}

// The descriptor for a receiver's Choice, or null where it has no plan.
export function derivedEquatableDescriptorFor(
	baseType: common.Type,
	scope: enricher.Scope,
	position: common.Position,
): common.DerivedEquatableDescriptor | null {
	return choiceRouting(baseType, scope, position)?.descriptor ?? null
}

// A Choice's whole plan: the descriptor and the Types whose witnesses fill
// the routed slots. Null where nothing routes and no payload mentions a Type
// Parameter. See "Equality descriptors" in DEVELOPMENT.md.
function choiceRouting(
	baseType: common.Type,
	scope: enricher.Scope,
	position: common.Position,
	// Null builds the descriptor silently, for a speculative solve.
	descriptorPosition: common.Position | null = position,
): {
	// Null for a Choice that is not generic.
	alias: common.GenericAliasType | null
	descriptor: common.DerivedEquatableDescriptor
	routedTypes: Array<common.Type>
} | null {
	let alias = declaredChoiceAliasOf(baseType, scope)
	let parameterSlots =
		alias === null ? 0 : constrainedGenericOrder(alias).length
	let routing = choiceMemberRouting(parameterSlots, scope, position)

	let descriptor =
		alias === null
			? derivedEquatableDescriptorForCases(
					choiceCasesOf(baseType, scope),
					routing.route,
				)
			: derivedEquatableDescriptor(
					alias,
					choiceTypeArgumentsOf(baseType),
					descriptorPosition,
					routing.route,
				)

	if (parameterSlots === 0 && routing.types.length === 0) {
		return null
	}

	return { alias, descriptor, routedTypes: routing.types }
}

// The Cases of a Choice that is not generic, the whole Choice even for a
// receiver narrowed to one Case.
function choiceCasesOf(
	baseType: common.Type,
	scope: enricher.Scope,
): Array<common.Type> {
	let choiceType = choiceTypeOf(baseType, scope)

	if (choiceType === null) {
		return []
	}

	return choiceType.type === "UnionType"
		? flattenUnionMembers(choiceType)
		: [choiceType]
}

// The same plan for a Choice without Type Parameters, so every member is `eq`
// or a routed `w`.
function derivedEquatableDescriptorForCases(
	cases: Array<common.Type>,
	route: MemberRouter,
): common.DerivedEquatableDescriptor {
	let descriptor: common.DerivedEquatableDescriptor = {}

	for (let caseType of cases) {
		if (caseType.type !== "Case") {
			continue
		}

		descriptor[`${caseType.choice}#${caseType.name}`] = describeMembers(
			caseType.members,
			[],
			new Set(),
			new Map(),
			null,
			route,
		)
	}

	return descriptor
}

// The derived equality of a Choice receiver, a fallback for when no written
// Namespace answers. See "Derived conformances" in DEVELOPMENT.md.
export function derivedEquatableNamespace(
	baseType: common.Type,
	scope: enricher.Scope,
	// Where routing is asked, silently. Completion and Hover come through
	// the same funnel, `namespacesDeclaringMethod`. Null routes nothing.
	position: common.Position | null = null,
): common.NamespaceType | null {
	let choiceType = choiceTypeOf(baseType, scope)

	if (choiceType === null) {
		return null
	}

	return derivedEquatableNamespaceForChoice(
		choiceType,
		declaredChoiceAliasOf(baseType, scope),
		choiceTypeArgumentsOf(baseType),
		position === null
			? []
			: (choiceRouting(baseType, scope, position, null)?.routedTypes ??
					[]),
	)
}

// The same Namespace built from a Choice in hand, as the language server has
// one. For a generic Choice the Methods are conditional, and `typeArguments`
// pin the receiver's Type Arguments. See "Derived equality for a generic
// Choice" in DEVELOPMENT.md.
export function derivedEquatableNamespaceForChoice(
	choiceType: common.Type,
	declaredAlias: common.GenericAliasType | null = null,
	typeArguments: Array<common.Type> = [],
	// The routed payload members, each a bounded Type Parameter pinned to the
	// member's Type, whose witness `resolveConformances` solves.
	routedTypes: Array<common.Type> = [],
): common.NamespaceType {
	let isGeneric = declaredAlias !== null && declaredAlias.generics.length > 0

	// The bounded Type Parameters, borrowed under names no source can spell,
	// so a caller's own `T` does not capture them.
	let borrowed: GenericBindings = new Map()

	if (isGeneric && declaredAlias !== null) {
		for (let name of constrainedGenericOrder(declaredAlias)) {
			borrowed.set(name, {
				type: "GenericUse",
				name: borrowedGenericName(name),
			})
		}
	}

	// A fresh list per Method, never the Alias' own Declarations.
	let boundGenerics: Array<common.GenericDeclaration> =
		isGeneric && declaredAlias !== null
			? constrainedGenericOrder(declaredAlias).map((name) => {
					// A receiver's Type Argument is a default, not `infer`, so
					// inference seeds it and checks the Arguments against it.
					let pinned =
						typeArguments[
							declaredAlias.generics.findIndex(
								(generic) => generic.name === name,
							)
						]

					return {
						name: borrowedGenericName(name),
						infer: pinned === undefined,
						defaultType: pinned ?? null,
						constraint: "Equatable",
					}
				})
			: []

	// One per routed member after them, pinned, since nothing at the call
	// could infer it.
	boundGenerics = [
		...boundGenerics,
		...routedTypes.map((memberType, index) => ({
			name: routedMemberGenericName(index),
			infer: false,
			defaultType: memberType,
			constraint: "Equatable",
		})),
	]

	// The unapplied body Union, under the borrowed names, for inference to
	// bind the bounds from.
	let parameterType =
		isGeneric && declaredAlias !== null
			? applyGenericBindings(declaredAlias.aliasedType, borrowed)
			: choiceType

	let method = (
		description: string,
		returns: string,
	): common.SimpleMethodType => ({
		type: "SimpleMethod",
		generics: boundGenerics.map((generic) => ({ ...generic })),
		parameterTypes: [
			{ name: null, type: parameterType },
			{
				name: null,
				type: parameterType,
				documentation: "the Choice to compare with",
			},
		],
		returnType: { type: "Boolean" },
		documentation: {
			description,
			parameters: [{ name: "other", text: "the Choice to compare with" }],
			returns,
			examples: [],
			position: null,
		},
	})

	return {
		type: "Namespace",
		name: derivedEquatableNamespaceName,
		targetType: choiceType,
		generics: [],
		properties: {},
		methods: {
			is: method(
				"Answers whether both are the same Case, carrying equal payloads.",
				"`true` when both are the same Case and their payloads are equal.",
			),
			isNot: method(
				"Answers whether the two are different Cases, or carry differing payloads.",
				"`true` when the Cases differ, or their payloads do.",
			),
		},
		conformsTo: ["Equatable"],
	}
}

// Whether no Case of a Choice carries a payload, so its Case names say
// everything there is to print.
function choiceCasesArePayloadFree(choiceType: common.Type): boolean {
	let cases =
		choiceType.type === "UnionType"
			? flattenUnionMembers(choiceType)
			: [choiceType]

	return (
		cases.length > 0 &&
		cases.every(
			(caseType) =>
				caseType.type === "Case" &&
				Object.keys(caseType.members).length === 0,
		)
	)
}

// The derived printing of a Choice without payloads, or null. It needs no
// Type Parameters, since no payload can mention one.
export function derivedPrintableNamespaceForChoice(
	choiceType: common.Type,
): common.NamespaceType | null {
	if (!choiceCasesArePayloadFree(choiceType)) {
		return null
	}

	let toString: common.SimpleMethodType = {
		type: "SimpleMethod",
		generics: [],
		parameterTypes: [{ name: null, type: choiceType }],
		returnType: { type: "String" },
		documentation: {
			description: "Answers the Case's name as a String.",
			parameters: [],
			returns: "the name of the Case, without its `#`.",
			examples: [],
			position: null,
		},
	}

	return {
		type: "Namespace",
		name: derivedPrintableNamespaceName,
		targetType: choiceType,
		generics: [],
		properties: {},
		methods: { toString },
		conformsTo: [printableProtocolName],
	}
}

// The runtime tags of a Choice's Cases in declaration order, which is what a
// derived `cases()` answers. Null where a Case carries a payload.
export function derivedCaseTags(choiceType: common.Type): Array<string> | null {
	if (!choiceCasesArePayloadFree(choiceType)) {
		return null
	}

	let cases =
		choiceType.type === "UnionType"
			? flattenUnionMembers(choiceType)
			: [choiceType]

	return cases.map((caseType) =>
		caseType.type === "Case" ? `${caseType.choice}#${caseType.name}` : "",
	)
}

// The derived Case listing of a Choice without payloads, or null. Its
// signature is the Protocol's requirement with `Self` bound to the Choice, so
// the two can not drift.
export function derivedEnumerableNamespaceForChoice(
	choiceType: common.Type,
	protocol: common.ProtocolType,
): common.NamespaceType | null {
	let requirement = protocol.methods[enumerableMethodName]

	if (requirement === undefined || !choiceCasesArePayloadFree(choiceType)) {
		return null
	}

	return {
		type: "Namespace",
		name: derivedEnumerableNamespaceName,
		targetType: choiceType,
		generics: [],
		properties: {},
		methods: {
			[enumerableMethodName]: applyGenericBindings(
				requirement,
				new Map([["Self", choiceType]]),
			) as common.MethodType,
		},
		conformsTo: [enumerableProtocolName],
	}
}

// The derived Case listing a Namespace over a Choice reaches, or null. A
// written `cases` replaces it, and a generic Namespace derives none. See
// "Derived conformances" in DEVELOPMENT.md.
export function derivedEnumerableNamespaceFor(
	namespace: common.NamespaceType,
	scope: enricher.Scope,
): common.NamespaceType | null {
	if (
		namespace.generics.length > 0 ||
		namespace.targetType === null ||
		Object.hasOwn(namespace.methods, enumerableMethodName)
	) {
		return null
	}

	let protocol = knownProtocol(enumerableProtocolName, scope)

	return protocol === null
		? null
		: derivedEnumerableNamespaceForChoice(namespace.targetType, protocol)
}

// The derived printing a receiver reaches, or null. It answers only where a
// Namespace found for the receiver states `is Printable`.
export function derivedPrintableNamespace(
	baseType: common.Type,
	namespaces: Iterable<common.NamespaceType>,
	scope: enricher.Scope,
): common.NamespaceType | null {
	let choiceType = choiceTypeOf(baseType, scope)

	if (choiceType === null) {
		return null
	}

	let protocol = knownProtocol(printableProtocolName, scope)
	let declared = false

	for (let namespace of namespaces) {
		if (!namespace.conformsTo?.includes(printableProtocolName)) {
			continue
		}

		// A `toString` another of its Protocols provides fulfils the
		// requirement, so no derive stands in.
		let provider =
			protocol === null
				? null
				: conformanceProvidersIn(
						namespace.conformsTo,
						protocol,
						namespace.targetType ?? baseType,
						scope,
					)("toString")
		let bindings =
			namespace.generics.length === 0
				? new Map()
				: bindNamespaceTarget(namespace, baseType)

		if (
			provider !== null &&
			bindings !== null &&
			providerConformanceHolds(
				namespace,
				bindings,
				provider,
				baseType,
				scope,
			)
		) {
			return null
		}

		declared = true
		break
	}

	return declared ? derivedPrintableNamespaceForChoice(choiceType) : null
}

function derivesPrinting(binding: common.Type, scope: enricher.Scope): boolean {
	let choiceType = choiceTypeOf(binding, scope)

	return (
		choiceType !== null &&
		derivedPrintableNamespaceForChoice(choiceType) !== null
	)
}

// Where a silent solve stands. Nothing it reports is kept.
const unplacedPosition: common.Position = {
	start: { line: 1, column: 1 },
	end: { line: 1, column: 1 },
}

// Whether the conformance bringing in `provider`'s body holds for this
// receiver, `where` included. Where none does, the derive stands in. Asked
// silently.
function providerConformanceHolds(
	namespace: common.NamespaceType,
	bindings: GenericBindings,
	provider: string,
	receiver: common.Type,
	scope: enricher.Scope,
): boolean {
	return (namespace.conformsTo ?? []).some((declared) => {
		if (!protocolGrants(declared, provider, scope)) {
			return false
		}

		let conditions = orderConditions(
			namespace.conformanceConditions?.[declared] ?? [],
			namespace.generics,
		)

		return (
			conditions.length === 0 ||
			collectDiagnostics(() =>
				solveCandidateConditions(
					conditions,
					bindings,
					receiver,
					declared,
					scope,
					unplacedPosition,
				),
			).result.ok
		)
	})
}

// The witness a derive provides for a Choice, or null. Where `written`
// claimed the conformance, the derive fills in only if it writes none of the
// Protocol's Methods. The derived Methods are checked like any candidate's.
function derivedConformanceSource(
	binding: common.Type,
	protocolName: string,
	written: common.NamespaceType | null,
	scope: enricher.Scope,
	position: common.Position,
): common.ConformanceSource | null {
	let choiceType = choiceTypeOf(binding, scope)

	if (choiceType === null) {
		return null
	}

	// Checked against the flat Methods, whose Parameters are the applied
	// Choice. A generic Choice's witnesses are solved by hand.
	let protocol = knownProtocol(protocolName, scope)

	if (protocol === null) {
		return null
	}

	// Printing is derived only where `written` declared it.
	let derived =
		protocolName === printableProtocolName
			? written === null
				? null
				: derivedPrintableNamespaceForChoice(choiceType)
			: protocolName === enumerableProtocolName
				? derivedEnumerableNamespaceForChoice(choiceType, protocol)
				: derivedEquatableNamespaceForChoice(choiceType)

	if (derived === null || !derived.conformsTo?.includes(protocolName)) {
		return null
	}

	if (
		written !== null &&
		Object.keys(protocol.methods).some((methodName) =>
			Object.hasOwn(written.methods, methodName),
		)
	) {
		return null
	}

	let result = computeConformanceMethodMap(
		protocol,
		derived,
		binding,
		new Map(),
		conformanceGrantsIn(scope),
		conformanceProvidersIn(
			derived.conformsTo ?? [],
			protocol,
			derived.targetType ?? binding,
			scope,
		),
	)

	if (result.kind !== "conforms") {
		return null
	}

	// Printing needs no witness and no descriptor.
	if (derived.name === derivedPrintableNamespaceName) {
		return {
			kind: "namespace",
			name: derivedPrintableNamespaceName,
			methodMap: result.methodMap,
			...providedMethodsOf(result),
			conditions: [],
		}
	}

	// The Case listing needs no witness, but its static Method needs the
	// tags, having no receiver.
	if (derived.name === derivedEnumerableNamespaceName) {
		return {
			kind: "namespace",
			name: derivedEnumerableNamespaceName,
			methodMap: result.methodMap,
			...providedMethodsOf(result),
			conditions: [],
			derivedCases: derivedCaseTags(choiceType) ?? [],
		}
	}

	// Without a plan, the derive is unconditional.
	let routing = choiceRouting(binding, scope, position, null)

	if (routing === null) {
		return {
			kind: "namespace",
			name: derivedEquatableNamespaceName,
			methodMap: result.methodMap,
			...providedMethodsOf(result),
			conditions: [],
		}
	}

	// A generic Choice conforms where each mentioned Type Parameter's
	// Argument does, solved in slot order. A failure withholds the derive.
	let aliasGenerics = routing.alias
	let genericNames =
		aliasGenerics?.generics.map((generic) => generic.name) ?? []
	let typeArguments = choiceTypeArgumentsOf(binding)
	let conditions: Array<common.Conformance> = []

	for (let name of aliasGenerics === null
		? []
		: constrainedGenericOrder(aliasGenerics)) {
		let typeArgument = typeArguments[genericNames.indexOf(name)] ?? {
			type: "Error" as const,
		}

		let solved = solveConformance(
			typeArgument,
			protocolName,
			scope,
			position,
		)

		if (!solved.ok) {
			return null
		}

		conditions.push({
			genericName: name,
			protocolName,
			source: solved.source,
		})
	}

	// Then the routed payload members, in slot order.
	for (let [index, memberType] of routing.routedTypes.entries()) {
		let solved = solveConformance(memberType, protocolName, scope, position)

		if (!solved.ok) {
			return null
		}

		conditions.push({
			genericName: routedMemberGenericName(index),
			protocolName,
			source: solved.source,
		})
	}

	return {
		kind: "namespace",
		name: derivedEquatableNamespaceName,
		methodMap: result.methodMap,
		...providedMethodsOf(result),
		conditions,
		derivedDescriptor: routing.descriptor,
	}
}

// The name a routed member's witness is bound under. The slot is decided by
// position, so the name only labels the `Conformance`.
function routedMemberGenericName(index: number): string {
	return borrowedGenericName(`Member${index}`)
}

// What a Record's declared members say about its conformance: structural,
// routed through some member's witness, or refused by a member. See "Records
// that route their members" in DEVELOPMENT.md.
type RecordMemberRouting =
	| { kind: "structural" }
	| {
			kind: "routed"
			members: Array<string>
			conditions: Array<common.Conformance>
	  }
	| {
			kind: "refused"
			memberPath: string
			chain: Array<string>
			culprit?: { type: common.Type; protocolName: string }
	  }

// The members a Record Type declares, in declaration order, or null where it
// declares none. A refined Record is asked as its base is.
function declaredRecordMembers(
	type: common.Type,
): Array<[string, common.Type]> | null {
	let erased = eraseRefinements(type)

	if (erased.type !== "Record") {
		return null
	}

	let members = Object.entries(erased.members)

	return members.length === 0 ? null : members
}

// A member's conformance, solved silently. Only the `ambiguous-conformance`
// Diagnostics are handed back, for the caller to forward; anything else is
// reported where the mistake is made.
function memberConformance(
	memberType: common.Type,
	protocolName: string,
	scope: enricher.Scope,
	position: common.Position,
): {
	result: ConformanceSolveResult
	ambiguities: Array<common.Diagnostic>
} {
	let collected = collectDiagnostics(() =>
		solveConformance(memberType, protocolName, scope, position),
	)

	// An ambiguity about a Type holding an Error repeats that Error.
	return {
		result: collected.result,
		ambiguities: typeContainsError(memberType)
			? []
			: collected.diagnostics.filter(
					(diagnostic) => diagnostic.code === "ambiguous-conformance",
				),
	}
}

function recordMemberRouting(
	binding: common.Type,
	protocolName: string,
	scope: enricher.Scope,
	position: common.Position,
): RecordMemberRouting {
	let members = declaredRecordMembers(binding)

	if (members === null) {
		return { kind: "structural" }
	}

	let routed: Array<string> = []
	let conditions: Array<common.Conformance> = []

	for (let [name, memberType] of members) {
		let asked = memberConformance(memberType, protocolName, scope, position)
		let solved = asked.result

		// Forwarded whatever the member answered, with a Note naming the
		// member. A nested Record adds one Note per level, innermost first.
		for (let ambiguity of asked.ambiguities) {
			report({
				...ambiguity,
				notes: [
					...(ambiguity.notes ?? []),
					`Its member '${name}' is what asks ${describeType(binding)} to conform.`,
				],
			})
		}

		if (!solved.ok) {
			if (solved.chain.length === 0) {
				continue
			}

			// The dotted path, such as `inner.run`, built as the refusal
			// travels up. Of a nested chain only the last sentence is kept,
			// since the rest is folded into the path.
			let memberPath =
				solved.memberPath === undefined
					? name
					: `${name}.${solved.memberPath}`

			return {
				kind: "refused",
				memberPath,
				chain:
					solved.memberPath === undefined
						? solved.chain
						: solved.chain.slice(-1),
				...(solved.culprit === undefined
					? {}
					: { culprit: solved.culprit }),
			}
		}

		if (conformanceIsStructural(solved.source, protocolName)) {
			continue
		}

		routed.push(name)
		conditions.push({
			genericName: name,
			protocolName,
			source: solved.source,
		})
	}

	return routed.length === 0
		? { kind: "structural" }
		: { kind: "routed", members: routed, conditions }
}

// Whether a candidate is the standard library's Record Namespace, the one
// targeting the top Record. A Program's `namespace Record for { x: Integer }`
// shares the name.
function isBuiltinRecordNamespace(
	name: string,
	declaredTarget: NamespaceTarget,
): boolean {
	let target = declaredTarget.targetType

	return (
		name === "Record" &&
		target !== null &&
		target.type === "Record" &&
		Object.keys(target.members).length === 0
	)
}

// The witness a Record gets when its members decide its conformance, or null
// where nothing routes. The member names beside the conditions tell the
// rewriter to emit the routing helper.
function routedRecordSource(
	binding: common.Type,
	protocolName: string,
	methodMap: ConformanceMethodMap,
	provided: { providedMethods?: Record<string, string> },
	scope: enricher.Scope,
	position: common.Position,
): ConformanceSolveResult | null {
	let routing = recordMemberRouting(binding, protocolName, scope, position)

	if (routing.kind === "structural") {
		return null
	}

	if (routing.kind === "refused") {
		return {
			ok: false,
			memberPath: routing.memberPath,
			// Shaped as a failed `where` condition's chain, so the caller
			// reports `unsatisfied-conformance-condition`.
			chain: [
				`${describeType(binding)} does not conform to '${describeProtocol(protocolName, scope)}'.`,
				`Its member '${routing.memberPath}' does not conform to '${describeProtocol(protocolName, scope)}'.`,
				...routing.chain,
			],
			...(routing.culprit === undefined
				? {}
				: { culprit: routing.culprit }),
		}
	}

	return {
		ok: true,
		source: {
			kind: "namespace",
			name: "Record",
			methodMap,
			...provided,
			conditions: routing.conditions,
			derivedMembers: routing.members,
		},
	}
}

// The routing for a direct call such as `r::is(other)`, which the Record
// Namespace resolves without a `where` clause to solve. Null where nothing
// routes. See "Records that route their members" in DEVELOPMENT.md.
export function routedRecordCall(
	namespaceName: string,
	namespace: common.NamespaceType,
	methodName: string,
	baseType: common.Type,
	scope: enricher.Scope,
	position: common.Position,
): {
	members: Array<string>
	conformances: Array<common.Conformance>
} | null {
	// Neither Method is overloaded, so the written name is the name.
	let protocolName = recordRoutedMethods[methodName]

	if (
		protocolName === undefined ||
		// A provided Method such as `isNot` runs over the Record's whole
		// witness, which the bounded rail already routed. Routing it here would
		// put a witness in a value's slot, failing inside `String.compare`.
		namespace.providedBy !== undefined ||
		!isBuiltinRecordNamespace(namespaceName, {
			targetType: namespace.targetType,
			generics: namespace.generics,
		})
	) {
		return null
	}

	// Asked with reports, since this is the call the reader wrote. The
	// refusal is always `unsatisfied-conformance-condition`, as a direct call
	// binds no Type Parameter.
	let solved = solveConformance(baseType, protocolName, scope, position)

	if (!solved.ok) {
		if (solved.chain.length > 0) {
			let culprit = solved.culprit?.type ?? baseType
			let missing = missingConformance(
				culprit,
				solved.culprit?.protocolName ?? protocolName,
				scope,
				position,
				"condition",
			)

			let protocol = describeProtocol(protocolName, scope)
			let message = `${describeType(baseType)} does not conform to '${protocol}'`

			reportError(message, position, {
				code: "unsatisfied-conformance-condition",
				labels: [
					primary(
						position,
						`this asks each declared member for its own '${protocol}'`,
					),
				],
				notes: [
					...withoutRepeatedHead(solved.chain, message),
					...missing.notes,
				],
				// No `inspect` Help for `value::toString()`. See
				// `printingEscapeHelps`.
				helps: missing.helps,
				...(missing.data === undefined ? {} : { data: missing.data }),
			})
		}

		return null
	}

	if (
		solved.source.kind !== "namespace" ||
		solved.source.derivedMembers === undefined
	) {
		return null
	}

	return {
		members: solved.source.derivedMembers,
		conformances: solved.source.conditions,
	}
}

// A chain without its first sentence where that repeats the message. Only
// when rendering, since the chain's length chooses the Diagnostic.
function withoutRepeatedHead(
	chain: Array<string>,
	message: string,
): Array<string> {
	return chain[0] === `${message}.` ? chain.slice(1) : chain
}

// The Protocol of each Method the Record Namespace writes. `keys` belongs to
// none, and `isNot` is provided by `Equatable`.
const recordRoutedMethods: Record<string, string> = {
	is: equatableProtocolName,
	toString: printableProtocolName,
}

// The first Help when a value can not be printed: `Terminal.inspect` takes
// any value. It follows the call, so `value::toString()`, which wants a
// String, gets none. Equality has no such escape.
function printingEscapeHelps(
	protocolName: string,
	atPrintingCall: boolean,
): Array<string> {
	return protocolName === printableProtocolName && atPrintingCall
		? [
				"Write 'Terminal.inspect(…)' instead — it renders any value structurally and asks for no conformance.",
			]
		: []
}

// The provided half of a conformance, left out where nothing is provided or
// the conformer writes everything.
function providedMethodsOf(result: {
	providedMethods: Record<string, string>
}): { providedMethods?: Record<string, string> } {
	return Object.keys(result.providedMethods).length === 0
		? {}
		: { providedMethods: result.providedMethods }
}

// Whether conforming to `declared` also conforms to `wanted`, as
// `is Orderable` answers an `is Comparable` bound.
export function protocolGrants(
	declared: string,
	wanted: string,
	scope: enricher.Scope,
): boolean {
	if (declared === wanted) {
		return true
	}

	return protocolOf(declared, scope).conformsTo?.includes(wanted) === true
}

// The `grants` question `computeConformanceMethodMap` asks, bound to a Scope,
// since that helper takes none.
function conformanceGrantsIn(
	scope: enricher.Scope,
): (declared: string, wanted: string) => boolean {
	return (declared, wanted) => protocolGrants(declared, wanted, scope)
}

// What a call says of a requirement the Namespace does not answer. It writes
// none, and a body of the name fails to fulfil it.
function missingRequirementNotes(
	namespaceName: string,
	namespace: common.NamespaceType,
	methodName: string,
	protocolName: string,
	scope: enricher.Scope,
): Array<string> {
	let spelled = describeProtocol(protocolName, scope)
	let writer = (namespace.conformsTo ?? [])
		.map((identity) =>
			providedMethodProtocol(protocolOf(identity, scope), methodName),
		)
		.find((provider) => provider !== null)

	return [
		`'${namespaceName}' does not write '${methodName}', which '${spelled}' requires.`,
		...(writer === undefined
			? []
			: [
					`'${describeProtocol(writer, scope)}' provides a '${methodName}' whose signature does not fulfil the one '${spelled}' declares.`,
				]),
	]
}

// A body chosen at the declared target runs with `Self` bound to the
// binding, so it has to fulfil its requirement there as well.
function fulfilledAt(
	result: ConformanceCheckResult,
	protocol: common.ProtocolType,
	binding: common.Type,
	scope: enricher.Scope,
): ConformanceCheckResult {
	if (result.kind !== "conforms") {
		return result
	}

	for (let [methodName, provider] of Object.entries(result.providedMethods)) {
		let requirement = protocol.methods[methodName]
		let body = protocolOf(provider, scope).methods[methodName]

		if (
			body !== requirement &&
			!providedBodyFulfils(methodName, requirement, body, binding)
		) {
			return { kind: "mismatched", methodName, provider }
		}
	}

	return result
}

// One source of a receiver's conformance: a Namespace declaring it, or a
// derive. See "Provided Methods at a call" in DEVELOPMENT.md.
export type ConformanceSourceNamespace = {
	// The Namespace's name, or the Protocol's for a derive.
	name: string
	// The target specialized against the receiver, which `Self` binds to.
	selfType: common.Type
	// What the witness is solved for where that differs from `selfType`, as
	// for the standard library's `Record` Namespace.
	witnessType?: common.Type
	// The unspecialized target and Type Parameters, for the specificity order.
	targetType: common.Type
	generics: Array<common.GenericDeclaration>
	// The names the Namespace writes, which replace this source's provided
	// Methods.
	writes: ReadonlySet<string>
	// The Type Parameters `selfType` still mentions, which the call binds.
	// Unbounded, since `Self`'s witness proves the conditions.
	openGenerics: Array<common.GenericDeclaration>
}

// The Protocols in scope that wrote a body for this name. It runs for every
// Method Invocation, so it asks by name alone.
export function protocolsProviding(
	methodName: string,
	scope: enricher.Scope,
): Array<common.ProtocolType> {
	let providers: Array<common.ProtocolType> = []

	for (let protocol of allProtocolsInScope(scope)) {
		// An inherited name is offered by the Protocol that wrote it.
		if (
			providedMethodProtocol(protocol, methodName) === protocol.identity
		) {
			providers.push(protocol)
		}
	}

	return providers
}

// The Namespace's target as it covers this receiver. A covering Union stays
// the Union, so `3::isLessThan(π)` takes either kind, and a generic target
// binds against the receiver.
function specializedTargetFor(
	namespace: common.NamespaceType,
	baseType: common.Type,
): common.Type {
	if (namespace.targetType === null) {
		return baseType
	}

	if (namespace.generics.length === 0) {
		return namespace.targetType
	}

	let bindings = bindNamespaceTarget(namespace, baseType)
	let targetType = namespace.targetType

	// Where the receiver leaves a Type Parameter open, the receiver stands
	// in, since a later solve would read the name as one in scope.
	return bindings === null ||
		namespace.generics.some(
			(generic) =>
				!bindings.has(generic.name) &&
				typeMentionsGeneric(targetType, generic.name),
		)
		? baseType
		: applyGenericBindings(targetType, bindings)
}

// The sources of a receiver's conformance to one Protocol: each Namespace
// declaring it, or else a derive. The derive is asked silently; the call site
// solves the witness again and reports.
export function conformanceSourcesFor(
	protocol: common.ProtocolType,
	baseType: common.Type,
	namespaces: ReadonlyArray<common.NamespaceType>,
	scope: enricher.Scope,
	position: common.Position,
): Array<ConformanceSourceNamespace> {
	let sources: Array<ConformanceSourceNamespace> = []

	for (let namespace of namespaces) {
		if (namespace.conformsTo?.includes(protocol.identity) !== true) {
			continue
		}

		sources.push({
			name: namespace.name,
			selfType: specializedTargetFor(namespace, baseType),
			...(isBuiltinRecordNamespace(namespace.name, {
				targetType: namespace.targetType,
				generics: namespace.generics,
			})
				? { witnessType: baseType }
				: {}),
			targetType: namespace.targetType ?? baseType,
			generics: namespace.generics,
			writes: new Set(Object.keys(namespace.methods)),
			// Bound by `specializedTargetFor` already.
			openGenerics: [],
		})
	}

	if (sources.length > 0) {
		return sources
	}

	if (
		collectDiagnostics(() =>
			derivedConformanceSource(
				baseType,
				protocol.identity,
				null,
				scope,
				position,
			),
		).result === null
	) {
		return []
	}

	// A derive's `Self` is the whole Choice, so a sibling Case fits.
	let derivedSelf = choiceTypeOf(baseType, scope) ?? baseType

	return [
		{
			name: protocol.name,
			selfType: derivedSelf,
			targetType: derivedSelf,
			generics: [],
			writes: new Set(),
			openGenerics: [],
		},
	]
}

// The pseudo Namespace one provided Method is reached through for one
// source, with `Self` pinned to the source's target. A pick solves the witness
// through the Protocol it names. See "Provided Methods at a call" in
// DEVELOPMENT.md.
export function providedMethodNamespaceFor(
	protocol: common.ProtocolType,
	methodName: string,
	source: ConformanceSourceNamespace,
	witnessed: common.ProtocolType = protocol,
): common.NamespaceType | null {
	let method = protocol.methods[methodName]

	if (method?.type !== "SimpleMethod") {
		return null
	}

	let bindings: GenericBindings = new Map([["Self", source.selfType]])

	return {
		type: "Namespace",
		name: source.name,
		targetType: source.targetType,
		generics: source.generics,
		properties: {},
		methods: {
			[methodName]: {
				...(applyGenericBindings(
					method,
					bindings,
				) as common.SimpleMethodType),
				// Fresh Declarations per Method. The open Type Parameters
				// stand before the pin, so a pin such as `List<ItemType>` can
				// still be settled by the Arguments.
				generics: [
					...source.openGenerics,
					{
						name: "Self",
						infer: false,
						defaultType: source.witnessType ?? source.selfType,
						constraint: witnessed.identity,
					},
				],
			},
		},
		conformsTo: [protocol.identity],
		providedBy: protocol.identity,
	}
}

// The candidates the provided Methods of this name offer the receiver, one
// per source, each ranked by its source's target. A Namespace writing the name
// is left out for its own source alone.
export function providedMethodNamespaces(
	methodName: string,
	baseType: common.Type,
	namespaces: Iterable<common.NamespaceType>,
	scope: enricher.Scope,
	position: common.Position,
): Map<string, common.NamespaceType> {
	let providers = protocolsProviding(methodName, scope)

	if (providers.length === 0) {
		return new Map()
	}

	let listed = [...namespaces]
	// Every Protocol a source reaches is gathered first, since a
	// descendant that provides the name again answers alone.
	let reached = new Map<
		string,
		{
			source: ConformanceSourceNamespace
			protocols: Array<common.ProtocolType>
		}
	>()

	for (let protocol of providers) {
		for (let source of conformanceSourcesFor(
			protocol,
			baseType,
			listed,
			scope,
			position,
		)) {
			if (source.writes.has(methodName)) {
				continue
			}

			let entry = reached.get(source.name)

			if (entry === undefined) {
				entry = { source, protocols: [] }
				reached.set(source.name, entry)
			}

			entry.protocols.push(protocol)
		}
	}

	let found = new Map<string, common.NamespaceType>()

	for (let { source, protocols } of reached.values()) {
		for (let protocol of protocols) {
			// `other` extends `protocol`, so its body stands, as at the
			// declaration.
			if (
				protocols.some(
					(other) =>
						other !== protocol &&
						other.conformsTo?.includes(protocol.identity) === true,
				)
			) {
				continue
			}

			let namespace = providedMethodNamespaceFor(
				protocol,
				methodName,
				source,
			)

			if (namespace === null) {
				continue
			}

			// Keyed by the source's name, as a `::<Name>` specifier writes it.
			// Two Protocols through one source need two keys, to be reported
			// as `ambiguous-namespace`.
			found.set(
				found.has(source.name)
					? `${source.name} (${describeProtocol(protocol.identity, scope)})`
					: source.name,
				namespace,
			)
		}
	}

	return found
}

// Solves whether `binding` conforms to `protocolName`, producing the witness.
// A GenericUse forwards the enclosing Function's conformance Parameter; a
// concrete Type selects its conforming Namespace and solves its conditions.
export function solveConformance(
	binding: common.Type,
	protocolName: string,
	scope: enricher.Scope,
	position: common.Position,
	// The one Namespace to ask, which the memo does not key.
	only?: string,
): ConformanceSolveResult {
	if (binding.type === "GenericUse") {
		// A bound answers for every Protocol it extends too, since a
		// descendant's witness holds its ancestors' requirements.
		if (
			binding.constraint !== undefined &&
			protocolGrants(binding.constraint, protocolName, scope)
		) {
			return {
				ok: true,
				source: {
					kind: "parameter",
					name: conformanceParameterName(binding.name),
				},
			}
		}

		return {
			ok: false,
			chain:
				binding.refusedBound === true
					? []
					: [
							`Type Parameter '${displayGenericName(binding.name)}' does not conform to '${describeProtocol(protocolName, scope)}'.`,
						],
		}
	}

	// An Error binding, or a Function refused as a value, was already reported.
	if (isReportedValue(binding)) {
		return { ok: false, chain: [] }
	}

	let protocol = protocolOf(protocolName, scope)

	if (only !== undefined) {
		return solveNamespaceConformance(
			binding,
			protocol,
			protocolName,
			scope,
			position,
			only,
		)
	}

	let key = conformanceKey(protocolName, binding)
	let state = conformanceStateFor(scope)

	let cached = state.memo.get(key)
	if (cached !== undefined) {
		return cached
	}

	if (state.inProgress.has(key)) {
		return {
			ok: false,
			cycle: true,
			chain: [
				`${describeType(binding)} conforming to '${describeProtocol(protocolName, scope)}' depends on itself.`,
			],
		}
	}

	state.inProgress.add(key)

	try {
		let result = solveNamespaceConformance(
			binding,
			protocol,
			protocolName,
			scope,
			position,
		)

		// Only successes are memoised, since a failure reached through a
		// cycle depends on what else was in progress.
		if (result.ok) {
			state.memo.set(key, result)
		}

		return result
	} finally {
		state.inProgress.delete(key)
	}
}

type ConformanceCandidate = {
	name: string
	type: common.NamespaceType
	// The target and Type Parameters as declared, for the specificity order;
	// specializing erases the difference between `for List<Integer>` and
	// `List<ItemType>`.
	declaredTarget: NamespaceTarget & { targetType: common.Type }
	// The Namespace's `where` conditions for this Protocol, in its Type
	// Parameters' declaration order, and the bindings each is solved under.
	conditions: Array<{ generic: string; protocol: string }>
	conditionBindings: GenericBindings
}

function solveNamespaceConformance(
	binding: common.Type,
	protocol: common.ProtocolType,
	protocolName: string,
	scope: enricher.Scope,
	position: common.Position,
	only?: string,
): ConformanceSolveResult {
	let candidates: Array<ConformanceCandidate> = []

	for (let [name, namespace] of getAllNamespacesInScope(scope, null)) {
		if (
			(only !== undefined && name !== only) ||
			namespace.conformsTo === undefined ||
			!namespace.conformsTo.includes(protocolName) ||
			namespace.targetType === null
		) {
			continue
		}

		let orderedConditions = conformanceConditionsOf(namespace, protocolName)

		let declaredTarget = {
			targetType: namespace.targetType,
			generics: namespace.generics,
		}

		// A Namespace conforms where its target covers the binding, as a `::`
		// call's lookup reads it. A generic one is then specialized against it.
		let targetBindings = conformingBindings(namespace, binding, scope)

		if (targetBindings !== null) {
			candidates.push({
				name,
				type:
					namespace.generics.length === 0
						? namespace
						: specializeNamespace(namespace, targetBindings),
				declaredTarget,
				conditions: orderedConditions,
				conditionBindings: targetBindings,
			})
		}
	}

	// The specificity order Method dispatch uses, on the declared targets:
	// `for List<Integer>` beats `List<ItemType>`, and an exact target beats a
	// covering Union.
	candidates = filterMostSpecificByTarget(
		candidates,
		(candidate) => candidate.declaredTarget,
	)

	for (let candidate of candidates) {
		noteReachedName(candidate.name)
	}

	if (candidates.length === 0) {
		// Without a written Namespace, a Choice may still derive.
		let derived = derivedConformanceSource(
			binding,
			protocolName,
			null,
			scope,
			position,
		)

		if (derived !== null) {
			return { ok: true, source: derived }
		}

		return {
			ok: false,
			chain: [
				`${describeType(binding)} does not conform to '${describeProtocol(protocolName, scope)}'.`,
			],
			culprit: { type: binding, protocolName },
		}
	}

	if (candidates.length > 1) {
		reportError(
			`More than one Namespace makes ${describeType(binding)} conform to '${describeProtocol(protocolName, scope)}'`,
			position,
			{
				code: "ambiguous-conformance",
				labels: [
					primary(position, "the conformance can not be chosen here"),
				],
				notes: candidates.map(
					(candidate) =>
						`'${candidate.name}' conforms to '${describeProtocol(protocolName, scope)}'.`,
				),
				// Specificity chooses, so the edit is at a declaration.
				helps: [
					`Drop the conformance from one of them, or narrow one target Type so it is the more specific for ${describeType(binding)}.`,
				],
			},
		)

		return { ok: false, chain: [] }
	}

	let candidate = candidates[0]

	// The `where` conditions are assumed, so a Method carrying the same bound
	// fulfils its requirement, then solved.
	let assumptions = new Map(
		candidate.conditions.map((condition) => [
			condition.generic,
			condition.protocol,
		]),
	)

	let providers = conformanceProvidersIn(
		candidate.type.conformsTo ?? [],
		protocol,
		candidate.declaredTarget.targetType,
		scope,
	)

	// A provided body whose conformance does not hold here fulfils nothing,
	// and a Choice's derived printing answers instead, where there is one.
	let providerOf =
		protocolName === printableProtocolName &&
		derivesPrinting(binding, scope)
			? (methodName: string): string | null => {
					let provider = providers(methodName)

					return provider !== null &&
						!providerConformanceHolds(
							candidate.type,
							candidate.conditionBindings,
							provider,
							binding,
							scope,
						)
						? null
						: provider
				}
			: providers

	let result = fulfilledAt(
		computeConformanceMethodMap(
			protocol,
			candidate.type,
			binding,
			assumptions,
			conformanceGrantsIn(scope),
			providerOf,
		),
		protocol,
		binding,
		scope,
	)

	if (result.kind !== "conforms") {
		// A Choice's Namespace that declares the conformance and writes none
		// of it is fulfilled by the derive, as at the declaration.
		let derived = derivedConformanceSource(
			binding,
			protocolName,
			candidate.type,
			scope,
			position,
		)

		if (derived !== null) {
			return { ok: true, source: derived }
		}

		let echo =
			result.kind === "needs-condition"
				? { silent: false, notes: [] }
				: restatementEcho(candidate.type, [result.methodName], scope)

		if (echo.silent) {
			return { ok: false, chain: [] }
		}

		// Reached where a covering target's `Self` does not fit this narrower
		// binding, or a Method carries a bound not assumed. Reported here.
		let label =
			result.kind === "needs-condition"
				? `Method '${result.methodName}' needs '${result.genericName} is ${describeProtocol(result.protocolName, scope)}'`
				: `this needs ${describeType(binding)} to conform`
		let narrowed =
			result.kind !== "mismatched"
				? { notes: [], helps: [] }
				: result.provider === undefined
					? narrowedMethodReport(
							protocol,
							result.methodName,
							candidate,
							binding,
							scope,
						)
					: narrowedBodyReport(
							protocol,
							result.methodName,
							result.provider,
							binding,
							scope,
						)

		reportError(
			`Namespace '${candidate.name}' does not conform to '${describeProtocol(protocolName, scope)}'`,
			position,
			{
				code: "nonconforming-namespace",
				labels: [primary(position, label)],
				notes: [
					...(result.kind === "missing"
						? missingRequirementNotes(
								candidate.name,
								candidate.type,
								result.methodName,
								protocolName,
								scope,
							)
						: []),
					...narrowed.notes,
					...echo.notes,
				],
				helps: narrowed.helps,
			},
		)

		return { ok: false, chain: [] }
	}

	// The chosen Namespace's `where` conditions. A failure adds this level
	// to the chain.
	let solvedConditions = solveCandidateConditions(
		candidate.conditions,
		candidate.conditionBindings,
		binding,
		protocolName,
		scope,
		position,
		candidate.declaredTarget.targetType,
	)

	if (!solvedConditions.ok) {
		return solvedConditions
	}

	let conditions = solvedConditions.conditions

	// The standard library's `Record` Namespace is conditional on the
	// receiver's members. See "Records that route their members" in
	// DEVELOPMENT.md.
	if (isBuiltinRecordNamespace(candidate.name, candidate.declaredTarget)) {
		let routed = routedRecordSource(
			binding,
			protocolName,
			result.methodMap,
			providedMethodsOf(result),
			scope,
			position,
		)

		if (routed !== null) {
			return routed
		}
	}

	let group = providedWitnessGroup(
		{
			protocol,
			name: candidate.name,
			methodMap: result.methodMap,
			providedMethods: result.providedMethods,
			declared: candidate.conditions,
			conditions,
		},
		candidate,
		binding,
		scope,
		position,
	)

	if (!group.ok) {
		return group
	}

	return {
		ok: true,
		source: {
			kind: "namespace",
			name: candidate.name,
			methodMap: result.methodMap,
			...providedMethodsOf(result),
			...group.fields,
			conditions,
		},
	}
}

type SolvedConditions =
	| { ok: true; conditions: Array<common.Conformance> }
	| Extract<ConformanceSolveResult, { ok: false }>

// A candidate's `where` conditions for one of its Protocols, each solved
// against the binding the unification gave its Generic.
function solveCandidateConditions(
	declared: Array<{ generic: string; protocol: string }>,
	conditionBindings: GenericBindings,
	binding: common.Type,
	protocolName: string,
	scope: enricher.Scope,
	position: common.Position,
	// The declared target, whose Cases may carry the Type Arguments.
	target: common.Type | null = null,
): SolvedConditions {
	let conditions: Array<common.Conformance> = []

	for (let condition of declared) {
		let conditionBinding = conditionBindings.get(condition.generic)
		let differing =
			conditionBinding === undefined && target !== null
				? disagreeingTypeArguments(target, binding, condition.generic)
				: null

		// Cases with differing Type Arguments, as in a List of
		// `Tag<Integer>#A` and `Tag<String>#B`, leave the Type Parameter open.
		if (differing !== null) {
			let names = differing.typeArguments.map(describeType)
			let application = `${choiceNameIn(differing.choice, scope)}<${Array.from({ length: differing.arity }, () => "…").join(", ")}>`

			return {
				ok: false,
				chain: [
					`${describeType(binding)} does not conform to '${describeProtocol(protocolName, scope)}'.`,
					`Its Cases carry different Type Arguments for '${condition.generic}', ${names.slice(0, -1).join(", ")} and ${names.at(-1)}, so the condition on '${condition.generic}' has no one Type to be solved against.`,
				],
				helps: [
					`Give every Case of the value the same Type Argument for '${condition.generic}', so that it is one '${application}'.`,
				],
			}
		}

		// An empty List Literal pins no Type Parameter, so the condition is
		// refused rather than solved without a witness.
		if (conditionBinding === undefined) {
			return {
				ok: false,
				// An Error in the binding was reported already.
				chain: typeContainsError(binding)
					? []
					: [
							`${describeType(binding)} does not conform to '${describeProtocol(protocolName, scope)}'.`,
							`Its '${condition.generic}' is not determined here — an empty List Literal leaves the item Type unknown until something pins it down.`,
						],
			}
		}

		let solved = solveConformance(
			conditionBinding,
			condition.protocol,
			scope,
			position,
		)

		if (!solved.ok) {
			return {
				ok: false,
				chain:
					solved.chain.length === 0
						? []
						: [
								`${describeType(binding)} does not conform to '${describeProtocol(protocolName, scope)}'.`,
								...solved.chain,
							],
				// The culprit is the deeper level's.
				...(solved.culprit === undefined
					? {}
					: { culprit: solved.culprit }),
				...(solved.helps === undefined ? {} : { helps: solved.helps }),
			}
		}

		conditions.push({
			genericName: condition.generic,
			protocolName: condition.protocol,
			source: solved.source,
		})
	}

	return { ok: true, conditions }
}

// One witness of a conformer's group, and the member each of its provided
// bodies is curried with where that is another. Its conditions are solved as it
// joins, except the root's and those of a witness a Choice derives.
type GroupWitness = {
	protocol: common.ProtocolType
	name: string
	methodMap: Record<string, string>
	providedMethods: Record<string, string>
	declared: Array<{ generic: string; protocol: string }>
	conditions: Array<common.Conformance> | null
	conditionIndices?: Array<number>
	derivedDescriptor?: common.DerivedEquatableDescriptor
	curriedWith?: Record<string, number>
}

// A provided body of another Protocol runs with the witness being solved
// where that answers each entry it reads as the body's own Protocol does.
// Otherwise it is curried with that Protocol's witness, which joins the group.
// Where that witness does not hold either, the conformance is refused as
// `nonconforming-namespace`.
function providedWitnessGroup(
	root: GroupWitness & { conditions: Array<common.Conformance> },
	candidate: ConformanceCandidate,
	binding: common.Type,
	scope: enricher.Scope,
	position: common.Position,
):
	| {
			ok: true
			fields: {
				curriedWith?: Record<string, number>
				providedWitnesses?: Array<common.ProvidedWitness>
				groupConditions?: Array<common.Conformance>
				sharedConditions?: Array<common.SharedCondition>
			}
	  }
	| Extract<ConformanceSolveResult, { ok: false }> {
	let group: Array<GroupWitness> = [root]
	let solved = new Map<string, GroupWitness | null>([
		[root.protocol.identity, root],
	])
	// Every condition of the group once, the root's first. Members share
	// their Namespace's condition bindings, so a condition two of them take is
	// one witness. A slot keeps its Generic where the Namespace declares it.
	let slots: Array<
		| { conformance: common.Conformance; generic: string | null }
		| { shared: common.SharedCondition }
	> = root.conditions.map((conformance) => ({
		conformance,
		generic: conformance.genericName,
	}))
	let conditionAt = new Map(
		root.declared.map((condition, index) => [
			JSON.stringify([condition.generic, condition.protocol]),
			index,
		]),
	)

	let witnessFor = (identity: string): GroupWitness | null => {
		let known = solved.get(identity)

		if (known !== undefined) {
			return known
		}

		let witness = bodyProtocolWitness(
			protocolOf(identity, scope),
			candidate,
			binding,
			scope,
			position,
		)

		solved.set(identity, witness)

		return witness
	}

	// The witness of only the Methods a body reads of its Protocol.
	let readWitness = (
		identity: string,
		reads: Array<string>,
	): GroupWitness | null => {
		let protocol = protocolOf(identity, scope)

		return bodyProtocolWitness(
			{ ...protocol, methods: methodsRead(reads, protocol.methods) },
			candidate,
			binding,
			scope,
			position,
		)
	}

	// The witness a condition asks for, where the group of a condition of
	// the same Generic already builds it from the same Namespace. Taking it
	// from there builds each witness once however deep the Type nests.
	let sharedFor = (
		condition: common.Conformance,
	): common.SharedCondition | null => {
		let source = condition.source

		if (
			source.kind !== "namespace" ||
			source.derivedMembers !== undefined ||
			source.derivedCases !== undefined
		) {
			return null
		}

		for (let [index, slot] of slots.entries()) {
			if (
				!("conformance" in slot) ||
				slot.generic !== condition.genericName ||
				slot.conformance.source.kind !== "namespace"
			) {
				continue
			}

			let witness = (
				slot.conformance.source.providedWitnesses ?? []
			).findIndex(
				(member) =>
					member.protocolName === condition.protocolName &&
					member.name === source.name &&
					isDeepStrictEqual(
						member.derivedDescriptor,
						source.derivedDescriptor,
					) &&
					isDeepStrictEqual(member.methodMap, source.methodMap) &&
					isDeepStrictEqual(
						member.providedMethods ?? {},
						source.providedMethods ?? {},
					),
			)

			if (witness !== -1) {
				return { condition: index, witness: witness + 1 }
			}
		}

		return null
	}

	let joinConditions = (
		own: GroupWitness,
		methodName: string,
		provider: string,
	): Extract<ConformanceSolveResult, { ok: false }> | null => {
		if (own.conditions !== null) {
			own.conditionIndices = own.conditions.map(
				(conformance) => slots.push({ conformance, generic: null }) - 1,
			)

			return null
		}

		own.conditionIndices = []

		for (let condition of own.declared) {
			let key = JSON.stringify([condition.generic, condition.protocol])
			let slot = conditionAt.get(key)

			if (slot === undefined) {
				let joined = solveCandidateConditions(
					[condition],
					candidate.conditionBindings,
					binding,
					provider,
					scope,
					position,
				)

				if (!joined.ok) {
					return joined.chain.length === 0
						? joined
						: {
								...joined,
								chain: [
									`${describeType(binding)} does not conform to '${describeProtocol(root.protocol.identity, scope)}'.`,
									`'${methodName}' runs the body '${describeProtocol(provider, scope)}' provides, which needs the conformance to '${describeProtocol(provider, scope)}'.`,
									...joined.chain,
								],
							}
				}

				let conformance = joined.conditions[0]!
				let shared = sharedFor(conformance)

				slot =
					slots.push(
						shared === null
							? { conformance, generic: condition.generic }
							: { shared },
					) - 1
				conditionAt.set(key, slot)
			}

			own.conditionIndices.push(slot)
		}

		return null
	}

	for (let index = 0; index < group.length; index++) {
		let member = group[index]!

		for (let [methodName, provider] of Object.entries(
			member.providedMethods,
		)) {
			// A body of the member's own Protocol runs with the member. An
			// ancestor's is asked like any other, since a descendant may restate
			// what it reads.
			if (provider === member.protocol.identity) {
				continue
			}

			let reads = providedReadsOf(provider, methodName, scope)

			if (reads.length === 0) {
				continue
			}

			// The witness of the read entries alone is solved first, and the
			// whole one only where that answers some entry differently.
			let restricted = readWitness(provider, reads)
			let answersAlike = (answers: GroupWitness | null): boolean =>
				answers !== null &&
				reads.every((entry) => {
					let answer = witnessAnswer(member, entry)

					return (
						answer !== undefined &&
						answer === witnessAnswer(answers, entry)
					)
				})

			if (answersAlike(restricted)) {
				continue
			}

			let own = witnessFor(provider)

			if (answersAlike(own)) {
				continue
			}

			if (own === null) {
				let echo = restatementEcho(candidate.type, reads, scope)

				if (!echo.silent) {
					let unanswered = unansweredReadReport(
						{ methodName, provider },
						reads,
						candidate,
						binding,
						root.protocol.identity,
						scope,
					)

					reportError(
						`Namespace '${candidate.name}' does not conform to '${describeProtocol(root.protocol.identity, scope)}'`,
						position,
						{
							code: "nonconforming-namespace",
							labels: [
								primary(
									position,
									`this needs ${describeType(binding)} to conform`,
								),
							],
							notes: [...unanswered.notes, ...echo.notes],
							helps: unanswered.helps,
						},
					)
				}

				return { ok: false, chain: [] }
			}

			let at = group.indexOf(own)

			if (at === -1) {
				let refused = joinConditions(own, methodName, provider)

				if (refused !== null) {
					return refused
				}

				at = group.push(own) - 1
			}

			member.curriedWith = { ...member.curriedWith, [methodName]: at }
		}
	}

	// The shared slots are emitted after every built one, so each slot's
	// index is renumbered: the built ones in order, then the shared ones.
	let conditions: Array<common.Conformance> = []
	let shared: Array<common.SharedCondition> = []
	let renumbered: Array<number> = []

	for (let [index, slot] of slots.entries()) {
		if ("conformance" in slot) {
			renumbered[index] = conditions.push(slot.conformance) - 1
		}
	}

	for (let [index, slot] of slots.entries()) {
		if ("shared" in slot) {
			renumbered[index] =
				conditions.length +
				shared.push({
					condition: renumbered[slot.shared.condition]!,
					witness: slot.shared.witness,
				}) -
				1
		}
	}

	return {
		ok: true,
		fields: {
			...(root.curriedWith === undefined
				? {}
				: { curriedWith: root.curriedWith }),
			...(group.length === 1
				? {}
				: {
						providedWitnesses: group.slice(1).map((member) => ({
							protocolName: member.protocol.identity,
							name: member.name,
							...(member.derivedDescriptor === undefined
								? {}
								: {
										derivedDescriptor:
											member.derivedDescriptor,
									}),
							methodMap: member.methodMap,
							...providedMethodsOf(member),
							...(member.curriedWith === undefined
								? {}
								: { curriedWith: member.curriedWith }),
							conditionIndices: (
								member.conditionIndices ?? []
							).map((index) => renumbered[index]!),
						})),
					}),
			...(conditions.length === root.conditions.length
				? {}
				: {
						groupConditions: conditions.slice(
							root.conditions.length,
						),
					}),
			...(shared.length === 0 ? {} : { sharedConditions: shared }),
		},
	}
}

// The conformer's witness for the Protocol that wrote a body, as a bound of
// that Protocol solves it, or the one a Choice derives.
function bodyProtocolWitness(
	protocol: common.ProtocolType,
	candidate: ConformanceCandidate,
	binding: common.Type,
	scope: enricher.Scope,
	position: common.Position,
): GroupWitness | null {
	let { declared, result } = bodyProtocolCheck(
		protocol,
		candidate,
		binding,
		scope,
	)

	if (result.kind === "conforms") {
		return {
			protocol,
			name: candidate.name,
			methodMap: result.methodMap,
			providedMethods: result.providedMethods,
			declared,
			conditions: null,
		}
	}

	let derived = derivedConformanceSource(
		binding,
		protocol.identity,
		candidate.type,
		scope,
		position,
	)

	return derived === null || derived.kind !== "namespace"
		? null
		: {
				protocol,
				name: derived.name,
				methodMap: derived.methodMap,
				providedMethods: derived.providedMethods ?? {},
				declared: [],
				conditions: derived.conditions,
				...(derived.derivedDescriptor === undefined
					? {}
					: { derivedDescriptor: derived.derivedDescriptor }),
			}
}

// The conformer's conformance at the binding to the Protocol that wrote a
// body, as the Namespace declares it, before a Choice's derive is asked.
function bodyProtocolCheck(
	protocol: common.ProtocolType,
	candidate: ConformanceCandidate,
	binding: common.Type,
	scope: enricher.Scope,
): {
	declared: Array<{ generic: string; protocol: string }>
	result: ConformanceCheckResult
} {
	let declared = orderConditions(
		candidate.type.conformanceConditions?.[protocol.identity] ?? [],
		candidate.declaredTarget.generics,
	)
	let assumptions = new Map(
		declared.map((condition) => [condition.generic, condition.protocol]),
	)
	let providers = conformanceProvidersIn(
		candidate.type.conformsTo ?? [],
		protocol,
		candidate.declaredTarget.targetType,
		scope,
	)

	return {
		declared,
		result: fulfilledAt(
			computeConformanceMethodMap(
				protocol,
				candidate.type,
				binding,
				assumptions,
				conformanceGrantsIn(scope),
				providers,
			),
			protocol,
			binding,
			scope,
		),
	}
}

// What a report says of a body whose own Protocol's witness fails here. It
// names the first entry read that the conformer answers otherwise than that
// Protocol declares. Failing that, the body needs the whole conformance.
function unansweredReadReport(
	body: { methodName: string; provider: string },
	reads: Array<string>,
	candidate: ConformanceCandidate,
	binding: common.Type,
	asked: string,
	scope: enricher.Scope,
): { notes: Array<string>; helps: Array<string> } {
	let protocol = protocolOf(body.provider, scope)
	let { result } = bodyProtocolCheck(
		{ ...protocol, methods: methodsRead(reads, protocol.methods) },
		candidate,
		binding,
		scope,
	)
	let at = describeType(binding)
	let provides = `'${body.methodName}' runs the body '${describeProtocol(body.provider, scope)}' provides`
	let target = candidate.declaredTarget.targetType
	// Only a value narrower than the Namespace's target has another
	// Namespace to reach; at the target the conformance itself is at fault.
	let helps =
		!matchesType(target, binding) || matchesType(binding, target)
			? []
			: [
					binding.type === "Case"
						? annotateAtChoiceHelp(binding, scope, ", since")
						: `Declare a Namespace for ${at} that conforms to '${describeProtocol(asked, scope)}'.`,
				]

	if (result.kind === "conforms") {
		return {
			notes: [
				`${provides}, which needs '${candidate.name}' to conform to '${describeProtocol(body.provider, scope)}' at ${at}.`,
			],
			helps,
		}
	}

	let reading = `${provides}, which reads '${result.methodName}'`

	if (result.kind === "mismatched" && result.provider !== undefined) {
		let narrowed = narrowedBodyReport(
			protocol,
			result.methodName,
			result.provider,
			binding,
			scope,
			asked,
		)

		return {
			notes: [`${reading}.`, ...narrowed.notes],
			helps: narrowed.helps,
		}
	}

	if (result.kind === "missing") {
		return {
			notes: [`${reading}, and '${candidate.name}' does not write it.`],
			helps,
		}
	}

	if (result.kind === "needs-condition") {
		return {
			notes: [
				`${reading}, and '${candidate.name}' answers it only where '${result.genericName} is ${describeProtocol(result.protocolName, scope)}'.`,
			],
			helps,
		}
	}

	let mismatch = writtenMismatch(
		protocol.methods[result.methodName],
		candidate.type.methods[result.methodName],
		binding,
	)

	return {
		notes: [
			mismatch === null
				? `${reading}, and at ${at} '${candidate.name}' does not write it as '${describeProtocol(body.provider, scope)}' declares it.`
				: mismatch.parameter === null
					? `${reading}: at ${at} '${candidate.name}' answers it with ${withArticle(describeType(mismatch.written))}, where '${describeProtocol(body.provider, scope)}' answers ${withArticle(describeType(mismatch.required))}.`
					: `${reading}: at ${at} '${describeProtocol(body.provider, scope)}' passes it ${withArticle(describeType(mismatch.required))} as ${mismatch.parameter}, where '${candidate.name}' takes ${withArticle(describeType(mismatch.written))}.`,
		],
		helps,
	}
}

// The first Parameter a written Method takes narrower than its requirement
// passes here, or else its answer where that is wider. Null unless both are
// Simple.
function writtenMismatch(
	requirement: common.MethodType | undefined,
	written: common.MethodType | undefined,
	binding: common.Type,
): {
	parameter: string | null
	written: common.Type
	required: common.Type
} | null {
	if (
		requirement?.type !== "SimpleMethod" ||
		written?.type !== "SimpleMethod" ||
		requirement.parameterTypes.length !== written.parameterTypes.length
	) {
		return null
	}

	let required = applyGenericBindings(
		requirement,
		new Map([["Self", binding]]),
	) as common.SimpleMethodType

	// The first Parameter is `Self`, the receiver, which both take.
	for (let index = 1; index < required.parameterTypes.length; index++) {
		let passed = required.parameterTypes[index]!
		let taken = written.parameterTypes[index]!

		if (!matchesType(taken.type, passed.type)) {
			return {
				parameter: describeParameter(passed, index - 1),
				written: taken.type,
				required: passed.type,
			}
		}
	}

	return matchesType(required.returnType, written.returnType)
		? null
		: {
				parameter: null,
				written: written.returnType,
				required: required.returnType,
			}
}

// The entries a provided body reads. A Protocol with no record of them
// is taken to read every Method it has.
function providedReadsOf(
	identity: string,
	methodName: string,
	scope: enricher.Scope,
): Array<string> {
	let protocol = protocolOf(identity, scope)

	return protocol.providedReads?.[methodName] ?? Object.keys(protocol.methods)
}

// What a witness answers for one of its entries: the Method it reads off
// its Namespace, or the Protocol whose body it runs.
function witnessAnswer(
	witness: GroupWitness,
	entry: string,
): string | undefined {
	if (Object.hasOwn(witness.methodMap, entry)) {
		return `method ${witness.name}.${witness.methodMap[entry]}`
	}

	return Object.hasOwn(witness.providedMethods, entry)
		? `body ${witness.providedMethods[entry]}`
		: undefined
}

// What to say about a concrete Type with no conforming Namespace. A bare Case
// needs its annotation widened to the Choice, and a Future its `complete`.
// A Type from another Module, or a Namespace another Module exports, needs an
// import. Anything else needs a Namespace, which for a Choice without payloads
// may be empty.
type ConformanceRemedy = {
	notes: Array<string>
	helps: Array<string>
	data?: common.DiagnosticData
	// Set where the culprit is a Future or a Started standing for its answer,
	// which withholds the `Terminal.inspect` Help.
	describesWork?: true
}

// The remedy, led by what a reader is told where the name the report
// spells binds another Protocol here. A Namespace for another application of
// the culprit's Choice that conforms is named too.
function missingConformance(
	culprit: common.Type,
	protocolName: string,
	scope: enricher.Scope,
	// Read only by the bare-Case branch, for its own conformance question.
	position: common.Position,
	asker: "bound" | "condition",
): ConformanceRemedy {
	let remedy = conformanceRemedy(culprit, protocolName, scope, position)
	let leading = [
		...homonymNotes(protocolName, scope, asker),
		...homonymConformerNotes(protocolName, culprit, scope),
		...otherConformerNotes(protocolName, culprit, scope),
	]

	return leading.length === 0
		? remedy
		: { ...remedy, notes: [...leading, ...remedy.notes] }
}

function conformanceRemedy(
	culprit: common.Type,
	protocolName: string,
	scope: enricher.Scope,
	position: common.Position,
): ConformanceRemedy {
	let spelling = protocolSpelling(protocolName, scope)
	let protocol = describeProtocol(protocolName, scope)

	// A Choice no name here binds is imported first. Printing is derived only
	// where a Namespace states it, so that remedy declares one as well.
	let printing =
		protocolName === printableProtocolName && carriesNoPayload(culprit)
	let foreigns =
		printing || derivesOnceImported(culprit, protocolName)
			? foreignChoicesOf(culprit, scope)
			: null
	let foreign =
		foreigns !== null &&
		(printing ||
			derivesWithImports(
				culprit,
				protocolName,
				foreigns,
				scope,
				position,
			))
			? foreigns
			: null

	// No Namespace can target a Case, so the edit is about its Choice. Where
	// the Choice conforms, it is an annotation. Otherwise it is the Choice's own
	// remedy, since a Namespace `for Door` answers a `Door#Open` too.
	if (culprit.type === "Case" && foreign === null) {
		let unbound = unboundForeignChoice(culprit, scope)
		let choice =
			choiceTypeOf(culprit, scope) ??
			foreignChoiceTypeOf(culprit, unbound, scope)
		// A Choice no name binds derives nothing until the import binds it.
		let conforms =
			choice !== null &&
			((unbound !== null && derivesOnceImported(choice, protocolName)) ||
				collectDiagnostics(() =>
					solveConformance(choice, protocolName, scope, position),
				).result.ok)

		if (choice === null || conforms) {
			return { notes: [], ...annotateAtChoiceRemedy(culprit, scope) }
		}

		return conformanceRemedy(choice, protocolName, scope, position)
	}

	let unwaited = unwaitedWorkReport(
		eraseRefinements(culprit),
		bodyCanWait(scope),
		completionBarrierIn(scope),
	)

	if (unwaited !== null) {
		return { ...unwaited, describesWork: true }
	}

	if (foreign !== null) {
		return foreignChoiceRemedy(culprit, foreign, protocol, printing, scope)
	}

	let unimported = unimportedNamespacesOf(scope).filter((candidate) =>
		declaresConformanceFor(candidate.namespace, protocolName, culprit),
	)

	if (unimported.length > 0) {
		let only = unimported.length === 1 ? unimported[0] : undefined

		return {
			notes: [],
			helps: unimported.map(
				(candidate) =>
					`'${candidate.name}' in ${candidate.specifier} makes ${describeType(culprit)} conform to '${protocol}' — import it.`,
			),
			...(only === undefined
				? {}
				: {
						data: {
							kind: "import-declaration" as const,
							name: only.name,
							modulePath: only.modulePath,
						},
					}),
		}
	}

	// For a culprit no `for` clause can name the Help is withheld, and a Note
	// says why. Where no name here binds the Protocol, the Help names it
	// through an import.
	let importing =
		spelling === null ? protocolImport(protocolName, scope) : null
	let written =
		spelling ??
		(importing !== null && importing.taken === null
			? importing.exportedAs
			: null)
	let declaring = written ?? protocol
	let unnameable = unnameableTargetNote(culprit)
	let where = namespaceWhere(
		culprit,
		(choice) => declaredChoiceGenerics(choice, scope),
		(bound) => describeProtocol(bound, scope),
	)
	// Each Choice the head names and no name binds, a Type Argument's too, is
	// written as the Help's import will bind it.
	let imports = foreignChoicesSpelled(
		(spell) => namespaceHead(culprit, "", spell),
		scope,
	)
	let head = namespaceHead(culprit, "", spellingAfterImport(scope, imports))

	return {
		notes: unnameable === null ? [] : [unnameable],
		helps:
			unnameable !== null || (spelling ?? importing) === null
				? []
				: importing !== null && importing.taken !== null
					? [
							declaredInHelp(
								importing.name,
								importing,
								true,
								`write that name in a Namespace '${head} is …${where}'`,
							),
						]
					: [
							withImportOf(
								imports,
								protocolName === printableProtocolName &&
									choiceCasesArePayloadFree(culprit)
									? `Declare a Namespace '${head} is ${declaring}${where}' — its body may be empty, since a Choice whose Cases carry no payload prints as their names.`
									: `Declare a Namespace '${head} is ${declaring}${where}'.`,
							),
							...(importing === null
								? []
								: [declaredInHelp(importing.name, importing)]),
						],
		// No Parameter, since a concrete Type failed and a Namespace is no
		// edit to a span. The Protocol is carried all the same.
		...(written === null
			? {}
			: {
					data: {
						kind: "required-protocol" as const,
						protocol: written,
						parameter: null,
						...(importing === null
							? {}
							: {
									import: {
										name: written,
										modulePath: importing.modulePath,
									},
								}),
					},
				}),
	}
}

// Whether a Namespace declares this conformance for a Type, by the target
// test a solve puts each candidate to.
function declaresConformanceFor(
	namespace: common.NamespaceType,
	protocolName: string,
	type: common.Type,
): boolean {
	if (
		namespace.targetType === null ||
		namespace.conformsTo?.includes(protocolName) !== true
	) {
		return false
	}

	return namespace.generics.length === 0
		? matchesType(namespace.targetType, type)
		: bindNamespaceTarget(namespace, type) !== null
}

// Said where the name a report spells binds another Protocol in this Scope,
// or no Protocol. A reader would take the report to be about that.
function homonymNotes(
	identity: string,
	scope: enricher.Scope,
	asker: "bound" | "condition",
): Array<string> {
	let name = displayProtocolName(identity)
	let local = protocolNamed(name, scope)

	if (protocolSpelling(identity, scope) !== null) {
		return []
	}

	if (local === null) {
		let kind = bindingKindNamed(name, scope)

		return kind === null
			? []
			: [
					`'${name}' here is ${kind}; the ${asker} asks for the Protocol '${name}' that ${declarationOf(identity, identity, scope)}.`,
				]
	}

	if (local.identity === identity) {
		return []
	}

	return [
		`'${name}' here is the Protocol ${declarationOf(local.identity, identity, scope)}; the ${asker} asks for the '${name}' that ${declarationOf(identity, local.identity, scope)}.`,
	]
}

// What a name that is no Protocol's binds in this Scope, as a report
// names it, or null where it binds nothing.
function bindingKindNamed(name: string, scope: enricher.Scope): string | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		// A Type Parameter of the name can take the Protocol as its bound,
		// as the Help says, so it is no misreading.
		if (Object.hasOwn(current.types, name)) {
			return current.types[name]!.type === "GenericUse" ? null : "a Type"
		}

		if (Object.hasOwn(current.members, name)) {
			let member = current.members[name]!

			return member.type === "Namespace"
				? "a Namespace"
				: member.type === "Function"
					? "a Function"
					: "a value"
		}
	}

	return null
}

// The Namespaces in scope that make the Type conform to that other
// Protocol, which is the conformance the reader meant to be used.
function homonymConformerNotes(
	identity: string,
	type: common.Type,
	scope: enricher.Scope,
): Array<string> {
	let name = displayProtocolName(identity)
	let local = protocolNamed(name, scope)

	if (local === null || local.identity === identity) {
		return []
	}

	return [...getAllNamespacesInScope(scope, null)]
		.filter(([, namespace]) =>
			declaresConformanceFor(namespace, local.identity, type),
		)
		.map(
			([namespaceName]) =>
				`'${namespaceName}' conforms to the '${name}' ${declarationOf(local.identity, identity, scope)}, which is a different Protocol.`,
		)
}

// Who declares a Protocol, as this file's reader says it: this file, another
// Module or the standard library. A nested one adds its line, as does `beside`.
function declarationOf(
	identity: string,
	beside: string,
	scope: enricher.Scope,
): string {
	let declarer = declarerOf(identity, scope, beside)
	let nested = identity.slice(identity.lastIndexOf("#") + 1).split("@")[1]

	if (nested !== undefined) {
		return `${declarer} declares on line ${nested.split(":")[0]}`
	}

	return declarer === "this file" && declarerOf(beside, scope) === declarer
		? `${declarer} declares at its top level`
		: `${declarer} declares`
}

// Another Module, named by its file name, or by its specifier where the Module
// declaring `beside` has that file name too.
function declarerOf(
	identity: string,
	scope: enricher.Scope,
	beside: string = identity,
): string {
	let modulePath = identityModulePath(identity)
	let reader = modulePathOf(scope)

	if (modulePath === null) {
		return preludeProtocolsOf(scope)?.has(identity) === true
			? "the standard library"
			: "this file"
	}

	if (modulePath === reader) {
		return "this file"
	}

	let fileName = modulePath.slice(modulePath.lastIndexOf("/") + 1)
	let besidePath = identityModulePath(beside)

	return reader !== null &&
		besidePath !== null &&
		besidePath !== modulePath &&
		besidePath.slice(besidePath.lastIndexOf("/") + 1) === fileName
		? specifierTo(reader, modulePath)
		: fileName
}

function preludeProtocolsOf(scope: enricher.Scope): ReadonlySet<string> | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.preludeProtocols !== undefined) {
			return current.preludeProtocols
		}
	}

	return null
}

// Whether importing a Choice brings it a derived conformance: equality
// always, and listing where its Cases carry no payload. A bare Case lists no
// Cases of its own, so it needs its annotation widened as well.
function derivesOnceImported(
	culprit: common.Type,
	protocolName: string,
): boolean {
	return (
		protocolName === equatableProtocolName ||
		(protocolName === enumerableProtocolName &&
			culprit.type !== "Case" &&
			carriesNoPayload(culprit))
	)
}

// Whether the Choice a Case or a Union of Cases belongs to carries no
// payload, read off the flag every such Case carries.
function carriesNoPayload(culprit: common.Type): boolean {
	let first =
		culprit.type === "UnionType" ? flattenUnionMembers(culprit)[0] : culprit

	return first?.type === "Case" && first.unitChoice === true
}

// The Namespace whose own Type Parameters declare this name, or null where a
// Function or a Method does. The nearest Scope declaring the name answers. A
// Scope carrying a bounded Namespace Type Parameter carries `namespace` too
// (`withInjectedBounds`).
function namespaceDeclaringGeneric(
	name: string,
	scope: enricher.Scope,
): common.NamespaceType | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.types[name] === undefined) {
			continue
		}

		return current.namespace?.type ?? null
	}

	return null
}

// What to say about a Type Parameter that lacks a bound, depending on whose
// Parameter it is. `bounded` keys the Quick Fix: where a Function declares
// it, on the Method for a Namespace's, or `none` where neither edit works.
export function typeParameterBoundReport(
	parameter: string,
	protocolName: string,
	scope: enricher.Scope,
	// The bound the Parameter carries already. A Type Parameter takes one
	// bound; see `oneBoundOnly`.
	carriedBound: string | null = null,
	// The name a bound is written with where this Scope binds the
	// Protocol under none, which an import alongside it binds.
	importedAs: string | null = null,
): {
	notes: Array<string>
	helps: Array<string>
	bounded: "declaration" | "method" | "none"
} {
	let wanted = importedAs ?? describeProtocol(protocolName, scope)

	if (carriedBound !== null) {
		return {
			notes: oneBoundOnly(
				parameter,
				describeProtocol(carriedBound, scope),
				describeProtocol(protocolName, scope),
			),
			helps: [],
			bounded: "none",
		}
	}

	let namespaceType = namespaceDeclaringGeneric(parameter, scope)

	if (namespaceType === null) {
		return {
			notes: [],
			helps: [`Declare it as '<infer ${parameter} is ${wanted}>'.`],
			bounded: "declaration",
		}
	}

	return namespaceParameterBound(
		namespaceType,
		parameter,
		protocolName,
		scope,
		wanted,
	)
}

// What to say about a bound on a Namespace's Type Parameter. It goes on the
// Method's own `<…>`, or on a `where` of a conformance the Method fulfils.
// See "Method bounds on Namespace Type Parameters" in DEVELOPMENT.md.
function namespaceParameterBound(
	namespaceType: common.NamespaceType,
	parameter: string,
	protocolName: string,
	scope: enricher.Scope,
	wanted: string,
): {
	notes: Array<string>
	helps: Array<string>
	bounded: "method" | "none"
} {
	let declared = namespaceType.conformsTo ?? []
	let conditionsOf = (name: string) =>
		namespaceType.conformanceConditions?.[name] ?? []
	let carrying = declared.filter((name) =>
		conditionsOf(name).some(
			(condition) =>
				condition.generic === parameter &&
				protocolGrants(condition.protocol, protocolName, scope),
		),
	)
	let methodHelp = `Bound it for this Method: write '<${parameter} is ${wanted}>' after the Method's name.`
	let first =
		carrying[0] === undefined
			? undefined
			: describeProtocol(carrying[0], scope)
	// Whether the enclosing Method fulfils a conformance, asked of the
	// Protocol's flattened `methods`.
	let fulfils = (identity: string) => {
		let name = enclosingMethodName(scope)

		return (
			name !== null &&
			Object.hasOwn(protocolOf(identity, scope).methods, name)
		)
	}

	// The edits exclude each other. A Method that fulfils a requirement takes
	// the bound on the conformance's `where`, since its own bound is refused.
	// One that fulfils nothing takes its own. `bounded` carries this decision.
	let fulfilled = declared.filter(fulfils)

	if (fulfilled.length > 0) {
		// A conformance whose `where` bounds this Parameter otherwise can take
		// no second bound (`conflicting-where-condition`). Where every one is
		// closed, nothing is offered.
		let open = fulfilled.filter(
			(name) =>
				!conditionsOf(name).some(
					(condition) => condition.generic === parameter,
				),
		)

		return {
			notes: [
				`'${parameter}' is '${namespaceType.name}'s own Type Parameter, and this Method fulfils ${fulfilled
					.map((identity) => `'${describeProtocol(identity, scope)}'`)
					.join(
						" and ",
					)} — so the bound belongs on the conformance, which promises the Method under it.`,
				...(first === undefined
					? []
					: [
							`'is ${first} where ${parameter} is ${wanted}' is declared here already, so what is missing is the Method's own promise rather than the condition.`,
						]),
			],
			helps:
				open.length === 0
					? []
					: [
							`Add 'where ${parameter} is ${wanted}' to ${open
								.map(
									(identity) =>
										`'is ${describeProtocol(identity, scope)}'`,
								)
								.join(" or ")} on this Namespace.`,
						],
			bounded: "none",
		}
	}

	// Where the needed condition is written already, the Note says this
	// Method is not one the `where` reaches.
	if (first !== undefined) {
		return {
			notes: [
				`'is ${first} where ${parameter} is ${wanted}' is declared here already, and a 'where' reaches the Methods that fulfil '${first}' and no others.`,
			],
			helps: [methodHelp],
			bounded: "method",
		}
	}

	return {
		notes: [
			`'${parameter}' is '${namespaceType.name}'s own Type Parameter, so a bound on it belongs to the Method that needs it rather than to the Namespace.`,
		],
		helps: [methodHelp],
		bounded: "method",
	}
}

// The Namespace Method a Diagnostic is reported from inside. See
// `Scope.methodName`.
function enclosingMethodName(scope: enricher.Scope): string | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.methodName !== undefined) {
			return current.methodName
		}
	}

	return null
}

// How each bounded Type Parameter of an invocation is fulfilled, given its
// binding. A failure reports and yields no source, and the Diagnostic keeps
// the Program from reaching the rewriter.
export function resolveConformances(
	generics: Array<common.GenericDeclaration>,
	bindings: GenericBindings,
	scope: enricher.Scope,
	position: common.Position,
	// Whether the call is `Terminal.print`, which earns the
	// `Terminal.inspect` Help.
	atPrintingCall = false,
): Array<common.Conformance> {
	if (!generics.some((generic) => generic.constraint != null)) {
		return []
	}

	let conformances: Array<common.Conformance> = []
	let unbound = generics
		.filter((generic) => !bindings.has(generic.name))
		.map((generic) => generic.name)

	for (let generic of generics) {
		if (generic.constraint == null) {
			continue
		}

		let bound = bindings.get(generic.name)

		// An unbound Type Parameter, a binding naming one, or an Error was
		// reported already. The validator reports a Function refused as a value.
		if (
			bound === undefined ||
			isReportedValue(bound) ||
			unbound.some((name) => typeMentionsGeneric(bound, name))
		) {
			continue
		}

		// Read as it stands: a pin naming a sibling Type Parameter is settled
		// in `settlePins`, while the names are still fresh. Here every binding
		// is in the caller's names.
		let binding = bound

		// The callee's Module resolved the bound, so the caller needs no name
		// for it. A bound refused where written is not carried.
		let spelling = protocolSpelling(generic.constraint, scope)

		// A Type Parameter bound to an unbounded Type Parameter gets a report
		// of its own.
		if (binding.type === "GenericUse") {
			// As in `solveConformance`, a bound answers for the Protocols it
			// extends.
			if (
				binding.constraint !== undefined &&
				protocolGrants(binding.constraint, generic.constraint, scope)
			) {
				conformances.push({
					genericName: generic.name,
					protocolName: generic.constraint,
					source: {
						kind: "parameter",
						name: conformanceParameterName(binding.name),
					},
				})
			} else if (binding.refusedBound !== true) {
				// The name the source wrote, without the fresh suffix of one
				// invocation (`displayGenericName`). The Scope lookup and the
				// Quick Fix both need it.
				let shown = displayGenericName(binding.name)
				let carried = binding.constraint ?? null
				let wanted = describeProtocol(generic.constraint, scope)
				// Where no name here binds the Protocol, the fix writes an
				// import too.
				let importing =
					spelling === null
						? protocolImport(generic.constraint, scope)
						: null
				let imported =
					importing !== null && importing.taken === null
						? importing.exportedAs
						: null
				let written = spelling ?? imported
				let bound = typeParameterBoundReport(
					shown,
					generic.constraint,
					scope,
					carried,
					imported,
				)

				reportError(
					`Type Parameter '${shown}' does not conform to '${wanted}'`,
					position,
					{
						code: "unsatisfied-bound",
						labels: [
							primary(
								position,
								// A Parameter with another bound is not
								// unbounded.
								carried === null
									? "bound here to an unbounded Type Parameter"
									: `bound here to a Type Parameter bounded by '${describeProtocol(carried, scope)}'`,
							),
						],
						notes: [
							...(carried === null
								? [
										`'${shown}' carries no '${wanted}' bound of its own, so it can not satisfy one.`,
									]
								: []),
							...homonymNotes(generic.constraint, scope, "bound"),
							...bound.notes,
						],
						helps:
							spelling !== null
								? bound.helps
								: importing === null || bound.helps.length === 0
									? []
									: importing.taken !== null
										? [
												declaredInHelp(
													importing.name,
													importing,
													true,
													`bound '${shown}' by that name`,
												),
											]
										: [
												...bound.helps,
												declaredInHelp(
													importing.name,
													importing,
												),
											],
						// Where the Quick Fix writes the bound, decided by the
						// report's `bounded`. None where the text withholds the
						// edit, or the Protocol can not be named here.
						...(bound.bounded === "none" || written === null
							? {}
							: {
									data: {
										kind:
											bound.bounded === "declaration"
												? ("required-protocol" as const)
												: ("method-bound" as const),
										protocol: written,
										parameter: shown,
										...(importing === null
											? {}
											: {
													import: {
														name: written,
														modulePath:
															importing.modulePath,
													},
												}),
									},
								}),
					},
				)
			}

			continue
		}

		let result = solveConformance(
			binding,
			generic.constraint,
			scope,
			position,
			generic.witnessFrom,
		)

		if (result.ok) {
			conformances.push({
				genericName: generic.name,
				protocolName: generic.constraint,
				source: result.source,
			})

			continue
		}

		// An empty chain was reported already.
		if (result.chain.length === 0) {
			continue
		}

		// The culprit is the chain's last link, `Problem` in a
		// `Result<String, Problem>`, or else the binding itself.
		let culprit = result.culprit?.type ?? binding
		let culpritProtocol = result.culprit?.protocolName ?? generic.constraint
		let missing = missingConformance(
			culprit,
			culpritProtocol,
			scope,
			position,
			result.chain.length === 1 ? "bound" : "condition",
		)
		let wanted = describeProtocol(generic.constraint, scope)
		let message = `${describeType(binding)} does not conform to '${wanted}'`

		// One link is `unsatisfied-bound`. More are a failed `where`, reported
		// as `unsatisfied-conformance-condition` with the chain as Notes.
		if (result.chain.length === 1) {
			reportError(message, position, {
				code: "unsatisfied-bound",
				labels: [
					primary(
						position,
						`this binds a Type Parameter bound to '${wanted}'`,
					),
				],
				notes: [
					`No Namespace in scope makes ${describeType(binding)} conform to '${wanted}'.`,
					...missing.notes,
				],
				helps: [
					...printingEscapeHelps(
						generic.constraint,
						atPrintingCall && missing.describesWork !== true,
					),
					...missing.helps,
				],
				...(missing.data === undefined ? {} : { data: missing.data }),
			})
		} else {
			let own = result.helps

			reportError(message, position, {
				code: "unsatisfied-conformance-condition",
				labels: [
					primary(
						position,
						`this binds a Type Parameter bound to '${wanted}'`,
					),
				],
				notes: [
					...withoutRepeatedHead(result.chain, message),
					...(own === undefined ? missing.notes : []),
				],
				helps: [
					...printingEscapeHelps(
						generic.constraint,
						atPrintingCall &&
							(own !== undefined ||
								missing.describesWork !== true),
					),
					...(own ?? missing.helps),
				],
				...(own !== undefined || missing.data === undefined
					? {}
					: { data: missing.data }),
			})
		}
	}

	return conformances
}

// An unknown Protocol name. The Helps name the Modules declaring it, then the
// near miss; the language server offers the import.
export function reportUnknownProtocol(
	identifier: parser.IdentifierNode,
	scope: enricher.Scope,
): void {
	let name = identifier.content

	reportError(`Protocol '${name}' is not declared`, identifier.position, {
		code: "unknown-protocol",
		labels: [primary(identifier.position, "no such Protocol")],
		helps: [
			...protocolDeclarationsOf(scope, name).map((declaration) =>
				declaredInHelp(
					name,
					declaration,
					moduleBindsName(scope, declaration.exportedAs ?? name),
					"write that name here",
				),
			),
			...suggestionHelps(name, scope, "protocols"),
		],
		...suggestionData(suggestionInScope(name, scope, "protocols")),
	})
}

// The import that would name a Protocol this file binds no name for, with
// `taken` set where its published name is bound here. Null where none can.
export function protocolImport(
	identity: string,
	scope: enricher.Scope,
): {
	name: string
	modulePath: string
	declares: true
	exportedAs: string | null
	taken: "protocol" | "other" | null
} | null {
	let separator = identity.lastIndexOf("#")
	let name = displayProtocolName(identity)

	if (separator === -1 || identity.slice(separator + 1) !== name) {
		return null
	}

	let modulePath = identity.slice(0, separator)
	let declaration = protocolDeclarationsOf(scope, name).find(
		(candidate) =>
			candidate.declares && candidate.modulePath === modulePath,
	)

	return declaration === undefined
		? null
		: {
				name,
				modulePath,
				declares: true,
				exportedAs: declaration.exportedAs,
				taken: protocolNameTaken(
					identity,
					scope,
					declaration.exportedAs ?? name,
				),
			}
}

// The Help naming a Protocol's declaring Module. `writing` says where the
// imported name goes, where no other Help says so.
function declaredInHelp(
	protocolName: string,
	{ modulePath, declares, exportedAs }: enricher.ProtocolDeclaration,
	taken: boolean = false,
	writing: string | null = null,
): string {
	let fileName = modulePath.slice(modulePath.lastIndexOf("/") + 1)
	let imported = exportedAs ?? protocolName
	let importing = taken
		? `import it under a name of its own, '${imported} as …'${writing === null ? "" : `, and ${writing}`}, since this file binds '${imported}' already`
		: imported === protocolName
			? "import it here"
			: `import '${imported}' ${writing === null ? "here" : `and ${writing}`}`

	return !declares
		? `'${protocolName}' is exported by ${fileName} — ${importing}.`
		: exportedAs === null
			? `'${protocolName}' is declared in ${fileName}, which does not export it — export it there and ${importing}.`
			: imported === protocolName
				? `'${protocolName}' is declared in ${fileName} — ${importing}.`
				: `'${protocolName}' is declared in ${fileName}, which exports it as '${imported}' — ${importing}.`
}

// A conformance clause that holds: its Protocol, `where` conditions and the
// Method map, so the enricher can weave the bounds into the fulfilling
// Methods.
export type CheckedConformance = {
	// Identities, as the conditions' Protocols are.
	protocolName: string
	conditions: Array<{ generic: string; protocol: string }>
	methodMap: Record<string, string>
}

// Why a `where` condition can not be assumed, or null. Both conformance
// checks share it, so the bounds woven into the Methods agree between the
// hoist and the reporting pass.
type WhereConditionRejection =
	| { kind: "unknown-generic" }
	| { kind: "unwitnessable" }
	| { kind: "unknown-protocol" }
	| { kind: "already-bound"; protocol: string }

function whereConditionRejection(
	condition: parser.WhereConditionNode,
	targetType: common.Type,
	declaredGenerics: ReadonlySet<string>,
	assumptions: ReadonlyMap<string, string>,
	scope: enricher.Scope,
): WhereConditionRejection | null {
	if (!declaredGenerics.has(condition.generic.content)) {
		return { kind: "unknown-generic" }
	}

	// A condition is proven by unifying the target with the receiver, so a
	// Type Parameter the target never mentions has no witness.
	if (!typeMentionsGeneric(targetType, condition.generic.content)) {
		return { kind: "unwitnessable" }
	}

	if (resolveWrittenProtocol(condition.protocol, scope) === null) {
		return { kind: "unknown-protocol" }
	}

	let existing = assumptions.get(condition.generic.content)

	if (existing !== undefined) {
		return { kind: "already-bound", protocol: existing }
	}

	return null
}

// The Protocol that wrote a body of the name for one of a Namespace's
// clauses, where one did. Asked of a requirement no body answered.
function clauseBodyWriter(
	node: parser.NamespaceDefinitionStatementNode,
	methodName: string,
	scope: enricher.Scope,
): string | null {
	for (let clause of node.conformsTo) {
		let protocol = resolveWrittenProtocol(clause.protocol, scope)
		let writer =
			protocol === null
				? null
				: providedMethodProtocol(protocol, methodName)

		if (writer !== null) {
			return writer
		}
	}

	return null
}

// The first requirement whose Method, written as declared, would not answer
// for another clause's Protocol, whose body it replaces. Then the conformance
// moves to a Namespace of its own.
function clauseRefusingRequirement(
	node: parser.NamespaceDefinitionStatementNode,
	solving: common.ProtocolType,
	owed: ReadonlyArray<string>,
	target: common.Type,
	scope: enricher.Scope,
): { methodName: string; protocol: string } | null {
	for (let methodName of owed) {
		for (let clause of node.conformsTo) {
			let protocol = resolveWrittenProtocol(clause.protocol, scope)

			if (
				protocol !== null &&
				providedMethodProtocol(protocol, methodName) !== null &&
				!writtenRequirementFulfils(
					methodName,
					solving.methods[methodName],
					protocol.methods[methodName],
					target,
				)
			) {
				return { methodName, protocol: protocol.identity }
			}
		}
	}

	return null
}

// `conformanceProvidersIn` over the Protocols a Namespace's clauses name
// where they are written, leaving out any that names none.
function clauseProvidersIn(
	node: parser.NamespaceDefinitionStatementNode,
	solving: common.ProtocolType,
	target: common.Type,
	scope: enricher.Scope,
): (methodName: string) => string | null {
	return conformanceProvidersIn(
		node.conformsTo.flatMap((clause) => {
			let protocol = resolveWrittenProtocol(clause.protocol, scope)

			return protocol === null ? [] : [protocol.identity]
		}),
		solving,
		target,
		scope,
	)
}

// A value bounded by a Protocol can be handed to a bound on one it extends,
// which reads its witness. So a Namespace conforming to both answers each
// provided name of the extended one with one body.
function reportSplitProvidedBodies(
	node: parser.NamespaceDefinitionStatementNode,
	namespaceType: common.NamespaceType,
	scope: enricher.Scope,
): void {
	let target = namespaceType.targetType
	let identities = namespaceType.conformsTo ?? []

	if (target === null) {
		return
	}

	let candidate: ConformanceCandidate = {
		name: namespaceType.name,
		type: namespaceType,
		declaredTarget: {
			targetType: target,
			generics: namespaceType.generics,
		},
		conditions: [],
		conditionBindings: new Map(),
	}
	let answers = new Map<string, Record<string, string> | null>()
	let bodiesOf = (identity: string): Record<string, string> => {
		if (!answers.has(identity)) {
			let { result } = bodyProtocolCheck(
				protocolOf(identity, scope),
				candidate,
				target,
				scope,
			)

			answers.set(
				identity,
				result.kind === "conforms" ? result.providedMethods : null,
			)
		}

		return answers.get(identity) ?? {}
	}

	for (let extending of identities) {
		for (let extended of identities) {
			if (
				extending === extended ||
				!protocolGrants(extending, extended, scope)
			) {
				continue
			}

			for (let [methodName, ancestorBody] of Object.entries(
				bodiesOf(extended),
			)) {
				let body = bodiesOf(extending)[methodName]

				if (body === undefined || body === ancestorBody) {
					continue
				}

				let echo = restatementEcho(namespaceType, [methodName], scope)

				if (echo.silent || echo.notes.length > 0) {
					continue
				}

				let clauses = node.conformsTo.flatMap((written) => {
					let protocol = resolveWrittenProtocol(
						written.protocol,
						scope,
					)

					return protocol === null
						? []
						: [{ position: written.protocol.position, protocol }]
				})
				let clause = clauses.find(({ protocol }) =>
					protocolGrants(protocol.identity, extending, scope),
				)
				let position = clause?.position ?? node.name.position
				let spelled = describeProtocol(extending, scope)
				let ancestor = describeProtocol(extended, scope)
				let entry = protocolOf(extending, scope).methods[methodName]!
				// The clauses whose Protocols declare the name otherwise. They
				// move to a Namespace of their own.
				let refusing = clauses
					.filter(({ protocol }) =>
						[
							protocol.identity,
							...(protocol.conformsTo ?? []),
						].some((identity) => {
							let declared = protocolOf(identity, scope).methods[
								methodName
							]

							return (
								declared !== undefined &&
								!writtenRequirementFulfils(
									methodName,
									entry,
									declared,
									target,
								)
							)
						}),
					)
					.map(({ protocol }) =>
						describeProtocol(protocol.identity, scope),
					)

				reportError(
					`Namespace '${namespaceType.name}' does not conform to '${describeProtocol(clause?.protocol.identity ?? extending, scope)}'`,
					position,
					{
						code: "nonconforming-namespace",
						labels: [
							primary(
								position,
								`Method '${methodName}' runs one body for '${spelled}' and another for '${ancestor}'`,
							),
						],
						notes: [
							`'${methodName}' runs the body '${describeProtocol(body, scope)}' provides for '${spelled}', and the body '${describeProtocol(ancestorBody, scope)}' provides for '${ancestor}'.`,
							`A value bounded by '${spelled}' can be handed to a bound on '${ancestor}', and a bound runs one body.`,
							...refusing.map(
								(protocol) =>
									`'${spelled}' and '${protocol}' declare '${methodName}' apart, so a '${methodName}' written as '${spelled}' declares it refuses the 'is ${protocol}' here.`,
							),
						],
						helps: [
							refusing.length === 0
								? `Write '${methodName}' in '${namespaceType.name}' as '${spelled}' declares it, so one Method answers both.`
								: `Declare ${refusing.map((protocol) => `'is ${protocol}'`).join(" and ")} on ${refusing.length === 1 ? "a Namespace of its own" : "Namespaces of their own"}, and write '${methodName}' in '${namespaceType.name}' as '${spelled}' declares it.`,
						],
					},
				)

				return
			}
		}
	}
}

// What `checkProtocolConformance` would find, silently and without derives,
// for the hoist: a Diagnostic there keeps the Namespace out of Scope. A
// derived clause names no Method, so it carries no bound.
export function silentCheckedConformances(
	node: parser.NamespaceDefinitionStatementNode,
	namespaceType: common.NamespaceType,
	scope: enricher.Scope,
	// The Protocols still to hoist. A clause naming one throws
	// `NotHoistedYet` rather than drop its bounds.
	pendingProtocols: ReadonlySet<string>,
): Array<CheckedConformance> {
	let checked: Array<CheckedConformance> = []
	let declaredGenerics = new Set(
		node.generics.map((generic) => generic.name.content),
	)
	for (let clause of node.conformsTo) {
		for (let identifier of [
			clause.protocol,
			...clause.conditions.map((condition) => condition.protocol),
		]) {
			if (
				resolveWrittenProtocol(identifier, scope) === null &&
				pendingProtocols.has(identifier.content)
			) {
				throw new NotHoistedYet(
					`Protocol '${identifier.content}' has not been hoisted yet — deferring Namespace '${node.name.content}'`,
				)
			}
		}
	}

	for (let clause of node.conformsTo) {
		let protocol = resolveWrittenProtocol(clause.protocol, scope)

		if (protocol === null || namespaceType.targetType === null) {
			continue
		}

		let assumptions = new Map<string, string>()

		for (let condition of clause.conditions) {
			if (
				whereConditionRejection(
					condition,
					namespaceType.targetType,
					declaredGenerics,
					assumptions,
					scope,
				) !== null
			) {
				continue
			}

			let conditionProtocol = resolveWrittenProtocol(
				condition.protocol,
				scope,
			)!.identity

			assumptions.set(condition.generic.content, conditionProtocol)
		}

		assumeRefusedBounds(namespaceType.generics, assumptions)

		let conditions = conditionsOf(assumptions)
		let result = computeConformanceMethodMap(
			protocol,
			namespaceType,
			namespaceType.targetType,
			assumptions,
			conformanceGrantsIn(scope),
			// A Method this clause's Protocol requires may be provided by
			// another clause's, and then nothing is owed.
			clauseProvidersIn(node, protocol, namespaceType.targetType, scope),
		)

		if (result.kind === "conforms") {
			checked.push({
				protocolName: protocol.identity,
				conditions,
				methodMap: result.methodMap,
			})
		}
	}

	return checked
}

// The reporting check, never run by the hoist, which reads
// `silentCheckedConformances` so a Namespace with a broken clause still
// hoists. It checks the Namespace Type with its bounds already woven in.
export function checkProtocolConformance(
	node: parser.NamespaceDefinitionStatementNode,
	namespaceType: common.NamespaceType,
	scope: enricher.Scope,
): Array<CheckedConformance> {
	let checked: Array<CheckedConformance> = []
	let declaredGenerics = new Set(
		node.generics.map((generic) => generic.name.content),
	)
	for (let clause of node.conformsTo) {
		let identifier = clause.protocol
		let protocol = resolveWrittenProtocol(identifier, scope)

		if (protocol === null) {
			reportUnknownProtocol(identifier, scope)

			continue
		}

		if (namespaceType.targetType === null) {
			reportError(
				"Only a Namespace with a target Type can conform to a Protocol",
				identifier.position,
				{
					code: "conformance-needs-target-type",
					labels: [
						primary(
							identifier.position,
							"this Namespace has no 'for …'",
						),
					],
					notes: [
						"A conformance says what a Type can do, so there has to be a Type.",
					],
					// The edit is the head, with a Type only the reader knows.
					helps: [
						`Give this Namespace a target Type: 'namespace ${namespaceType.name} for … is ${identifier.content}'.`,
					],
				},
			)

			continue
		}

		// Each `where` condition must name one of this Namespace's Type
		// Parameters and a real Protocol, binding no Type Parameter twice.
		let assumptions = new Map<string, string>()

		for (let condition of clause.conditions) {
			let rejection = whereConditionRejection(
				condition,
				namespaceType.targetType,
				declaredGenerics,
				assumptions,
				scope,
			)

			if (rejection !== null) {
				if (rejection.kind === "unknown-generic") {
					reportUnknownWhereGeneric(condition, clause, node)
				} else if (rejection.kind === "unwitnessable") {
					reportError(
						`'${condition.generic.content}' does not appear in this Namespace's target Type`,
						condition.generic.position,
						{
							code: "unwitnessable-where-condition",
							labels: [
								primary(
									condition.generic.position,
									"not part of the target Type",
								),
							],
							notes: [
								"A condition is proven by the target Type at each use site — a Type Parameter the target never mentions has nothing to prove it with.",
							],
							helps: [
								`Mention '${condition.generic.content}' in the target Type, or drop the condition.`,
							],
						},
					)
				} else if (rejection.kind === "unknown-protocol") {
					reportUnknownProtocol(condition.protocol, scope)
				} else {
					// One witness per Type Parameter per conformance, so a second
					// bound belongs to a conformance, and a Namespace, of its own.
					reportError(
						`'${condition.generic.content}' is bound twice in this conformance`,
						condition.generic.position,
						{
							code: "conflicting-where-condition",
							labels: [
								primary(
									condition.generic.position,
									`already bound to '${describeProtocol(rejection.protocol, scope)}'`,
								),
							],
							notes: [
								`'${condition.generic.content}' is already required to conform to '${describeProtocol(rejection.protocol, scope)}'.`,
								"A conformance threads one witness per Type Parameter into the Methods that fulfil it, and one witness can not be two Protocols.",
							],
							helps: [
								`Drop this condition, or declare 'is ${identifier.content}' on a Namespace of its own where '${condition.generic.content} is ${condition.protocol.content}' is the one condition.`,
							],
						},
					)
				}

				continue
			}

			let conditionProtocol = resolveWrittenProtocol(
				condition.protocol,
				scope,
			)!.identity

			assumptions.set(condition.generic.content, conditionProtocol)
		}

		assumeRefusedBounds(namespaceType.generics, assumptions)

		let conditions = conditionsOf(assumptions)
		// As in `silentCheckedConformances`.
		let providers = clauseProvidersIn(
			node,
			protocol,
			namespaceType.targetType,
			scope,
		)
		let result = computeConformanceMethodMap(
			protocol,
			namespaceType,
			namespaceType.targetType,
			assumptions,
			conformanceGrantsIn(scope),
			providers,
		)

		// `namespace Colour for Colour is Equatable { }` writes no `is`, and
		// the Choice derives it, by the rule the use site applies.
		if (
			result.kind !== "conforms" &&
			derivedConformanceSource(
				namespaceType.targetType,
				protocol.identity,
				namespaceType,
				scope,
				identifier.position,
			) !== null
		) {
			checked.push({
				protocolName: protocol.identity,
				conditions,
				methodMap: {},
			})

			continue
		}

		let echo =
			result.kind === "missing" || result.kind === "mismatched"
				? restatementEcho(namespaceType, [result.methodName], scope)
				: { silent: false, notes: [] }

		if (echo.silent) {
			continue
		}

		let spelled = describeProtocol(protocol.identity, scope)

		if (result.kind === "needs-condition") {
			// A condition this clause has for the same Type Parameter already.
			// Then the conformance moves to a Namespace of its own rather than
			// take a second bound.
			let existing = assumptions.get(result.genericName)

			reportError(
				`Namespace '${namespaceType.name}' does not conform to '${spelled}'`,
				identifier.position,
				{
					code: "nonconforming-namespace",
					labels: [
						primary(
							identifier.position,
							`Method '${result.methodName}' needs '${result.genericName} is ${describeProtocol(result.protocolName, scope)}'`,
						),
					],
					helps: [
						existing === undefined ||
						existing === result.protocolName
							? `Add 'where ${result.genericName} is ${describeProtocol(result.protocolName, scope)}' to this conformance.`
							: `'${result.genericName}' already carries '${describeProtocol(existing, scope)}' here, and a Type Parameter takes one bound per conformance — declare 'is ${spelled} where ${result.genericName} is ${describeProtocol(result.protocolName, scope)}' on a Namespace of its own.`,
					],
				},
			)
		} else if (result.kind === "missing") {
			let unfulfilling = clauseBodyWriter(node, result.methodName, scope)
			let owed = missingRequirements(protocol, namespaceType, providers)
			let refusing = clauseRefusingRequirement(
				node,
				protocol,
				owed,
				namespaceType.targetType,
				scope,
			)
			let declared = (methodNames: Array<string>): string =>
				`${methodNames.map((methodName) => `'${methodName}'`).join(", ")} as '${spelled}' declares ${methodNames.length === 1 ? "it" : "them"}`

			reportError(
				`Namespace '${namespaceType.name}' does not conform to '${spelled}'`,
				identifier.position,
				{
					code: "nonconforming-namespace",
					labels: [
						primary(
							identifier.position,
							`Method '${result.methodName}' is missing`,
						),
					],
					notes: [
						...(unfulfilling === null
							? []
							: [
									`'${describeProtocol(unfulfilling, scope)}' provides a '${result.methodName}' whose signature does not fulfil the one '${spelled}' declares.`,
								]),
						...(refusing === null
							? []
							: [
									`'${spelled}' and '${describeProtocol(refusing.protocol, scope)}' declare '${refusing.methodName}' apart, so a '${refusing.methodName}' written as '${spelled}' declares it refuses the 'is ${describeProtocol(refusing.protocol, scope)}' here.`,
								]),
						...echo.notes,
					],
					// Every requirement owed, named for a reader without the fix.
					helps: [
						refusing === null
							? `Write ${declared(owed)}, or drop the 'is ${spelled}'.`
							: `Declare 'is ${spelled}' on a Namespace of its own that writes ${declared(
									Object.keys(protocol.methods).filter(
										(methodName) =>
											providedMethodProtocol(
												protocol,
												methodName,
											) === null,
									),
								)}, or drop the 'is ${spelled}'.`,
					],
					// The fix writes stubs for every requirement owed. A
					// mismatched signature or a missing `where` gets none.
					...(refusing === null
						? {
								data: {
									kind: "missing-requirements",
									protocol: spelled,
									methods: owed,
								},
							}
						: {}),
				},
			)
		} else if (result.kind === "mismatched") {
			reportError(
				`Namespace '${namespaceType.name}' does not conform to '${spelled}'`,
				identifier.position,
				{
					code: "nonconforming-namespace",
					labels: [
						primary(
							identifier.position,
							`Method '${result.methodName}' does not match the Protocol's signature`,
						),
					],
					notes: echo.notes,
					// A Method to correct, so no stub is offered.
					helps: [
						`Write '${result.methodName}' with the signature '${spelled}' declares for it.`,
					],
				},
			)
		} else {
			checked.push({
				protocolName: protocol.identity,
				conditions,
				methodMap: result.methodMap,
			})
		}
	}

	reportSplitProvidedBodies(node, namespaceType, scope)
	reportUndeclaredDerivedConformance(node, namespaceType, scope)

	return checked
}

// The Protocols a Choice answers without a declaration. `Printable` derives
// only where declared, so it is not one.
const undeclaredDerivedProtocolNames: ReadonlyArray<string> = [
	"Equatable",
	enumerableProtocolName,
]

// Refuses a Namespace over a Choice that writes a derived Protocol's Method
// without declaring it, since a bounded call would still reach the derive.
// It asks the derive itself, silently, so the two agree.
function reportUndeclaredDerivedConformance(
	node: parser.NamespaceDefinitionStatementNode,
	namespaceType: common.NamespaceType,
	scope: enricher.Scope,
): void {
	let targetType = namespaceType.targetType

	if (targetType === null) {
		return
	}

	let declared = new Set(
		node.conformsTo.map(
			(clause) =>
				resolveWrittenProtocol(clause.protocol, scope)?.identity,
		),
	)

	for (let protocolName of undeclaredDerivedProtocolNames) {
		if (declared.has(protocolName)) {
			continue
		}

		let protocol = knownProtocol(protocolName, scope)

		if (protocol === null) {
			continue
		}

		let spelling = protocolSpelling(protocolName, scope)
		let spelled = spelling ?? displayProtocolName(protocolName)

		// Only requirements count. A written `isNot` stands beside the
		// provided `Equatable::isNot` rather than replacing it.
		let written = Object.keys(protocol.methods).filter(
			(methodName) =>
				providedMethodProtocol(protocol, methodName) === null &&
				Object.hasOwn(node.methods, methodName),
		)

		if (written.length === 0) {
			continue
		}

		if (
			collectDiagnostics(() =>
				derivedConformanceSource(
					targetType,
					protocolName,
					null,
					scope,
					node.name.position,
				),
			).result === null
		) {
			continue
		}

		let first = node.methods[written[0]]!

		reportError(
			`Namespace '${namespaceType.name}' writes '${written[0]}' without declaring 'is ${spelled}'`,
			first.name.position,
			{
				code: "undeclared-conformance",
				labels: [
					primary(
						first.name.position,
						`${describeType(targetType)} derives '${spelled}' unless this Namespace declares it`,
					),
				],
				notes: [
					`A call naming this Namespace answers what is written here; a call through an '${spelled}' bound answers the derived one.`,
					...(written.length > 1
						? [
								`This Namespace writes ${written
									.map((name) => `'${name}'`)
									.join(" and ")}.`,
							]
						: []),
				],
				helps: [
					`Declare the conformance: 'is ${spelled}' on this Namespace.`,
				],
				// No Parameter: the fix writes into the Namespace's head.
				...(spelling === null
					? {}
					: {
							data: {
								kind: "required-protocol" as const,
								protocol: spelling,
								parameter: null,
							},
						}),
			},
		)
	}
}

// What a Type Alias means without its `where` clause, the base a refinement
// refines. `resolveTypeAliasStatementType` in `enrichers.ts` reads the
// clause, which needs Expressions enriched.
export function resolveAliasedType(
	node: parser.TypeAliasStatementNode,
	scope: enricher.Scope,
): common.Type {
	// Checked here as well as in `declareTypeInScope`, which the hoist never
	// reaches.
	if (node.name.content === "Self") {
		reportReservedTypeName(node.name.position)
	}

	if (node.generics.length === 0) {
		let resolvedType = resolveType(node.type, scope)

		// An anonymous Union or Record takes the Alias's name for display, on
		// a copy. A named one keeps its name, so `type Sure = Number` prints
		// `Number`.
		if (
			(resolvedType.type === "UnionType" ||
				resolvedType.type === "Record") &&
			resolvedType.name === undefined &&
			resolvedType.alias === undefined
		) {
			return { ...resolvedType, name: node.name.content }
		}

		return resolvedType
	}

	// A generic Alias keeps its body unapplied until a use site substitutes
	// its Type Arguments.
	let genericScope = scopeWithGenerics(node.generics, scope)

	return {
		type: "GenericAlias",
		name: node.name.content,
		generics: resolveGenericDeclarations(node.generics, scope),
		aliasedType: resolveType(node.type, genericScope),
	}
}

// Substitutes Type Arguments into a Generic Alias's body. A missing Argument
// takes its default, or is reported and becomes an Error.
function applyGenericAlias(
	aliasType: common.GenericAliasType,
	typeArguments: Array<common.Type>,
	scope: enricher.Scope,
	position: common.Position,
): common.Type {
	let generics = aliasType.generics
	let requiredCount = generics.filter(
		(generic) => generic.defaultType === null,
	).length

	if (
		typeArguments.length > generics.length ||
		typeArguments.length < requiredCount
	) {
		reportError(
			`Type '${aliasType.name}' was given the wrong number of Type Arguments`,
			position,
			{
				code: "wrong-type-argument-count",
				labels: [
					primary(
						position,
						`${countOf(typeArguments.length, "Type Argument")} given`,
					),
				],
				notes: [
					`'${aliasType.name}' takes ${countOf(aliasType.generics.length, "Type Parameter")}.`,
				],
				// The shape to write, with a blank per Type Parameter.
				helps: [typeApplicationHelp(aliasType.name, generics.length)],
			},
		)
	}

	let bindings: GenericBindings = new Map()

	for (let i = 0; i < generics.length; i++) {
		let generic = generics[i]
		let argument =
			i < typeArguments.length
				? typeArguments[i]
				: (generic.defaultType ?? { type: "Error" as const })

		bindings.set(generic.name, argument)
	}

	// The application must keep the bounds, so `Box<Function>` is refused
	// here. Solved for the Diagnostic alone; a call solves its own witnesses.
	resolveConformances(aliasType.generics, bindings, scope, position)

	let appliedType = applyGenericBindings(aliasType.aliasedType, bindings)

	// An applied anonymous Union or Record displays as written, such as
	// `Optional<Integer>`. Its Type Arguments stay Types, so a later
	// substitution keeps the spelling current.
	if (
		(appliedType.type === "UnionType" || appliedType.type === "Record") &&
		appliedType.name === undefined &&
		appliedType.alias === undefined
	) {
		return {
			...appliedType,
			alias: {
				name: aliasType.name,
				typeArguments: generics.map(
					(generic) =>
						bindings.get(generic.name) ?? { type: "Error" },
				),
			},
		}
	}

	// An applied refinement spells as written, as `NonEmptyList<String>`. One
	// the application left unchanged keeps the declared object, which a pending
	// predicate is written into. The stamp is a copy, so it goes through
	// `refinementWithTypeArguments`, which registers a pending copy.
	if (
		appliedType.type === "Refinement" &&
		appliedType !== aliasType.aliasedType
	) {
		return refinementWithTypeArguments(
			appliedType,
			generics.map(
				(generic) => bindings.get(generic.name) ?? { type: "Error" },
			),
		)
	}

	return appliedType
}

function resolveIdentifierTypeDeclarationType(
	node: parser.IdentifierTypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	let name = node.type.content
	let result = findTypeInScope(name, scope)

	if (result === null) {
		// Silent where the parser dropped the Declaration. See
		// `declarationWasAbandoned`.
		if (declarationWasAbandoned(scope, name, node.position)) {
			return { type: "Error" }
		}

		if (resolveWrittenProtocol(node.type, scope) !== null) {
			reportError(
				`Protocol '${name}' can not be used as a Type`,
				node.position,
				{
					code: "protocol-as-type",
					labels: [primary(node.position, "this names a Protocol")],
					notes: [
						`A Protocol is only usable as a Generic bound ('<infer T is ${name}>') or in a conformance clause ('is ${name}').`,
					],
					// A Protocol in a Type position usually meant a Type
					// Parameter bounded by it.
					helps: [
						`Write a Type Parameter bounded by it — '<infer T is ${name}>' — and name 'T' here.`,
					],
				},
			)
		} else {
			reportError(`Type '${name}' is not declared`, node.position, {
				code: "unknown-type",
				labels: [primary(node.position, "no such Type")],
				...unknownTypeRemedy(name, scope),
			})
		}

		return { type: "Error" }
	}

	// A bare Generic Alias applies its defaults; lacking some, it is missing
	// Type Arguments.
	if (result.type === "GenericAlias") {
		return applyGenericAlias(result, [], scope, node.position)
	}

	// A bare `Future` or `Started` is refused, as a bare `Optional` is, since
	// its Unknown slot would accept any value. It recovers as the container
	// holding an Error, so `complete` still reads it.
	if (
		(result.type === "Future" || result.type === "Started") &&
		result.valueType.type === "Unknown"
	) {
		reportError(
			`Type '${result.type}' was given the wrong number of Type Arguments`,
			node.position,
			{
				code: "wrong-type-argument-count",
				labels: [
					primary(
						node.position,
						`${countOf(0, "Type Argument")} given`,
					),
				],
				notes: [`'${result.type}' takes 1 Type Parameter.`],
				helps: [typeApplicationHelp(result.type, 1)],
			},
		)

		return result.type === "Future"
			? { type: "Future", valueType: { type: "Error" } }
			: { type: "Started", valueType: { type: "Error" } }
	}

	return result
}

// Members that subsume one another collapse and anonymous nested Unions
// flatten in; a named one keeps its name. See `buildWrittenUnion`.
function resolveUnionTypeDeclarationType(
	node: parser.UnionTypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	return buildWrittenUnion(node.types.map((type) => resolveType(type, scope)))
}

function resolveRecordTypeDeclarationType(
	node: parser.RecordTypeDeclarationNode,
	scope: enricher.Scope,
): common.RecordType {
	return {
		type: "Record",
		members: Object.fromEntries(
			Object.entries(node.members).map(([key, value]) => {
				return [key, resolveType(value.type, scope)]
			}),
		),
	}
}

export function resolveGenericTypeDeclarationType(
	node: parser.GenericTypeDeclarationNode,
	scope: enricher.Scope,
): common.Type {
	let baseType: common.Type

	// Looked up raw, since `resolveIdentifierTypeDeclarationType` would apply
	// a Generic Alias' defaults first.
	if (node.baseType.nodeType === "IdentifierTypeDeclaration") {
		let name = node.baseType.type.content
		let result = findTypeInScope(name, scope)

		if (result === null) {
			// Silent where the parser dropped the Declaration.
			if (!declarationWasAbandoned(scope, name, node.baseType.position)) {
				reportError(
					`Type '${name}' is not declared`,
					node.baseType.position,
					{
						code: "unknown-type",
						labels: [
							primary(node.baseType.position, "no such Type"),
						],
						...unknownTypeRemedy(name, scope),
					},
				)
			}

			return { type: "Error" }
		}

		baseType = result
	} else {
		baseType = resolveType(node.baseType, scope)
	}

	return applyTypeArguments(baseType, node.generics, scope, node.position)
}

// Applies Type Arguments to a base Type: the arity, the bounds, the builtin
// containers, and a Type that takes none. `Holder<Integer>` in an annotation
// and in `Holder<Integer>#Full` both come here.
export function applyTypeArguments(
	baseType: common.Type,
	typeArguments: Array<parser.TypeDeclarationNode>,
	scope: enricher.Scope,
	position: common.Position,
): common.Type {
	if (baseType.type === "Error") {
		return baseType
	}

	// An applied List becomes a plain List Type, as an inferred one is.
	if (baseType.type === "GenericList") {
		if (typeArguments.length !== 1) {
			reportError("List takes exactly 1 Type Argument", position, {
				code: "wrong-type-argument-count",
				labels: [
					primary(
						position,
						`${countOf(typeArguments.length, "Type Argument")} given`,
					),
				],
				helps: [typeApplicationHelp("List", 1)],
			})

			return {
				type: "List",
				itemType:
					typeArguments.length > 0
						? resolveType(typeArguments[0], scope)
						: { type: "Error" },
			}
		}

		return {
			type: "List",
			itemType: resolveType(typeArguments[0], scope),
		}
	}

	// The asynchronous containers fill the Unknown slot their name resolves
	// to.
	if (baseType.type === "Future" || baseType.type === "Started") {
		let name = baseType.type

		if (typeArguments.length !== 1) {
			reportError(`${name} takes exactly 1 Type Argument`, position, {
				code: "wrong-type-argument-count",
				labels: [
					primary(
						position,
						`${countOf(typeArguments.length, "Type Argument")} given`,
					),
				],
				helps: [typeApplicationHelp(name, 1)],
			})
		}

		let valueType =
			typeArguments.length === 1
				? resolveType(typeArguments[0], scope)
				: { type: "Error" as const }

		return name === "Future"
			? { type: "Future", valueType }
			: { type: "Started", valueType }
	}

	// The same for a Dictionary. A wrong count is reported, and each slot
	// recovers apart: `Dictionary<String>` keeps its key and an Error value.
	if (baseType.type === "GenericDictionary") {
		if (typeArguments.length !== 2) {
			reportError("Dictionary takes exactly 2 Type Arguments", position, {
				code: "wrong-type-argument-count",
				labels: [
					primary(
						position,
						`${countOf(typeArguments.length, "Type Argument")} given`,
					),
				],
				helps: [typeApplicationHelp("Dictionary", 2)],
			})

			return {
				type: "Dictionary",
				keyType:
					typeArguments.length > 0
						? resolveType(typeArguments[0], scope)
						: { type: "Error" },
				valueType:
					typeArguments.length > 1
						? resolveType(typeArguments[1], scope)
						: { type: "Error" },
			}
		}

		return {
			type: "Dictionary",
			keyType: resolveType(typeArguments[0], scope),
			valueType: resolveType(typeArguments[1], scope),
		}
	}

	if (baseType.type === "GenericAlias") {
		return applyGenericAlias(
			baseType,
			typeArguments.map((argument) => resolveType(argument, scope)),
			scope,
			position,
		)
	}

	reportError("This Type takes no Type Arguments", position, {
		code: "type-not-generic",
		labels: [primary(position, "the Type Arguments have nowhere to go")],
		// The edit removes the brackets.
		helps: [
			`Remove the Type Arguments — '${describeType(baseType)}' stands on its own.`,
		],
	})

	return { type: "Error" }
}

// The application a Type wants, with a blank per Type Parameter, such as
// `Dictionary<…, …>`.
function typeApplicationHelp(name: string, parameterCount: number): string {
	let blanks = Array.from({ length: parameterCount }, () => "…").join(", ")

	return `Write '${name}<${blanks}>', with the Type you mean in place of each '…'.`
}

/***********/
/* Helpers */
/***********/

// `Self` names a Protocol's conforming Type, so no Type may take the name.
export function reportReservedTypeName(position: common.Position | null): void {
	// Only a Type may not be named `Self`; a Constant or a Case may.
	let notes = [
		"'Self' is what a Protocol calls the Type conforming to it, so no Type may be declared under it.",
	]
	// The Help names no replacement, having none to suggest.
	let helps = ["Choose another name."]

	if (position === null) {
		reportError("'Self' is a reserved Type name", null, {
			code: "reserved-type-name",
			labels: [],
			notes,
			helps,
		})

		return
	}

	reportError("'Self' is a reserved Type name", position, {
		code: "reserved-type-name",
		labels: [primary(position, "this name is taken")],
		notes,
		helps,
	})
}

// Reports a missing member, listing the members the base has, since a
// misspelling is the likeliest cause.
function reportUnknownMember(
	memberName: string,
	memberPosition: common.Position,
	baseDescription: string,
	memberNames: Array<string>,
	access: MemberAccessContext | null = null,
): void {
	// `box.hits++` reads the member `hits++`, since a `+` ends no name. It
	// is answered as the operator, as a bare `hits++` is.
	if (reportMemberOperator(memberName, memberPosition, memberNames, access)) {
		return
	}

	let suggestion = closestMatch(memberName, memberNames)

	reportError(
		`${baseDescription} has no member '${memberName}'`,
		memberPosition,
		{
			code: "unknown-member",
			labels: [primary(memberPosition, "no such member")],
			notes:
				memberNames.length === 0
					? [`${baseDescription} has no members.`]
					: [
							`${baseDescription} has ${memberNames
								.map((memberName) => `'${memberName}'`)
								.join(", ")}.`,
						],
			helps: [
				...(suggestion === null
					? []
					: [`Did you mean '${suggestion}'?`]),
				...methodSeparatorHelps(memberName, access),
			],
			...suggestionData(suggestion),
		},
	)
}

// Reports an operator at the end of a member name as foreign syntax, and
// answers whether it did. Only where the name without it is a member.
function reportMemberOperator(
	memberName: string,
	memberPosition: common.Position,
	memberNames: Array<string>,
	access: MemberAccessContext | null,
): boolean {
	let operator = foreignOperatorIn(memberName)

	if (
		operator === null ||
		!memberName.endsWith(operator) ||
		memberName.length === operator.length
	) {
		return false
	}

	let read = memberName.slice(0, -operator.length)

	if (!memberNames.includes(read)) {
		return false
	}

	// A Record's member can not be assigned, so the edit rebuilds the
	// Record. It is spelled only where the base is one name.
	let base = access?.spelledBase ?? null

	if (base === null || base.includes(".")) {
		reportOperatorNotSupported(operator, memberPosition, [])

		return true
	}

	// The `x::add(1)` half of what `compoundAssignmentHelps` writes, so one
	// table says what `++` means.
	let assignment = compoundAssignmentHelps(operator, `${base}.${read}`, null)
	let written = assignment?.[0]?.match(/ = (.+)'\.$/)?.[1] ?? null

	reportOperatorNotSupported(
		operator,
		memberPosition,
		written === null
			? []
			: [
					`Write '${base} = { ${base} with ${read} = ${written} }' — a Record's member is not assigned, it is built anew.`,
				],
	)

	return true
}

export function findTypeInScope(
	name: string,
	scope: enricher.Scope,
): common.Type | null {
	let searchScope: enricher.Scope | null = scope

	while (true) {
		if (searchScope === null) {
			return null
		}

		if (Object.hasOwn(searchScope.types, name)) {
			return searchScope.types[name]
		} else {
			searchScope = searchScope.parent
		}
	}
}

function protocolNamed(
	name: string,
	scope: enricher.Scope,
): common.ProtocolType | null {
	let searchScope: enricher.Scope | null = scope

	while (true) {
		if (searchScope === null) {
			return null
		}

		if (Object.hasOwn(searchScope.protocols, name)) {
			return searchScope.protocols[name]
		} else {
			searchScope = searchScope.parent
		}
	}
}

// The Protocol a name written in this Scope refers to. Only a written
// name is read this way: whatever is stored is an identity, read through
// `protocolOf`.
export function resolveWrittenProtocol(
	identifier: parser.IdentifierNode,
	scope: enricher.Scope,
): common.ProtocolType | null {
	return protocolNamed(identifier.content, scope)
}

// The Protocol a stored identity names: the nearest Protocol of its name
// where that is the one, else the registry's. An unknown identity is a
// compiler bug.
export function protocolOf(
	identity: string,
	scope: enricher.Scope,
): common.ProtocolType {
	let protocol = knownProtocol(identity, scope)

	if (protocol === null) {
		throw new Error(`No Protocol is known by '${identity}'`)
	}

	return protocol
}

// The same, for a standard library Protocol asked for by its identity,
// which a load that has not declared it yet does not know.
export function knownProtocol(
	identity: string,
	scope: enricher.Scope,
): common.ProtocolType | null {
	let nearest = protocolNamed(displayProtocolName(identity), scope)

	if (nearest?.identity === identity) {
		return nearest
	}

	return protocolRegistryOf(scope)?.get(identity) ?? null
}

// The name this Scope reads a Protocol under. That is its declared name where
// that binds it, else the nearest that does, such as an import alias, or null.
export function protocolSpelling(
	identity: string,
	scope: enricher.Scope,
): string | null {
	let declared = displayProtocolName(identity)

	if (protocolNamed(declared, scope)?.identity === identity) {
		return declared
	}

	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		for (let name in current.protocols) {
			if (
				current.protocols[name].identity === identity &&
				protocolNamed(name, scope) === current.protocols[name]
			) {
				return name
			}
		}
	}

	return null
}

// What already holds the name an import of a Protocol would bind here, its
// declared name unless told another. Null where the name is free.
export function protocolNameTaken(
	identity: string,
	scope: enricher.Scope,
	name: string = displayProtocolName(identity),
): "protocol" | "other" | null {
	let bound = protocolNamed(name, scope)

	if (bound !== null) {
		return bound.identity === identity ? null : "protocol"
	}

	return moduleBindsName(scope, name) ? "other" : null
}

// How a message names a Protocol: as this Scope reads it, or by its
// declared name where nothing here binds it.
export function describeProtocol(
	identity: string,
	scope: enricher.Scope,
): string {
	return protocolSpelling(identity, scope) ?? displayProtocolName(identity)
}

// The Protocols in scope declaring a Method of this name, alphabetically: the
// bounds that would let an unbounded Type Parameter's call resolve.
export function protocolsDeclaringMethod(
	methodName: string,
	scope: enricher.Scope,
): Array<string> {
	return allProtocolsInScope(scope)
		.filter((protocol) => Object.hasOwn(protocol.methods, methodName))
		.map((protocol) => describeProtocol(protocol.identity, scope))
		.sort()
}

// Every Protocol a Scope can see, once however many names bind it, the
// nearest declaration of a name winning. Asked where a Method call found nothing
// written, so a Protocol's provided Methods can answer it.
function allProtocolsInScope(
	scope: enricher.Scope,
): Array<common.ProtocolType> {
	let found = new Map<string, common.ProtocolType>()
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		for (let name in searchScope.protocols) {
			if (!found.has(name)) {
				found.set(name, searchScope.protocols[name])
			}
		}

		searchScope = searchScope.parent
	}

	return [
		...new Map(
			[...found.values()].map((protocol) => [
				protocol.identity,
				protocol,
			]),
		).values(),
	]
}

// Each Scope's version, which a declaration bearing on Namespaces bumps. See
// "Finding the Namespaces for a receiver" in DEVELOPMENT.md.
let scopeVersions = new WeakMap<enricher.Scope, number>()
let namespacesInScopeCache = new WeakMap<
	enricher.Scope,
	{
		versions: Array<{ scope: enricher.Scope; version: number }>
		namespaces: Map<string, common.NamespaceType>
	}
>()

// Every name a remembered answer of `getAllNamespacesInScope` holds. Only
// declaring a Namespace, or a member under such a name, changes an answer. It
// is filled from the answers, since a restored library declares nothing.
let namespaceNames = new Set<string>()

export function invalidateNamespacesInScope(
	scope: enricher.Scope,
	name: string,
	type: common.Type,
): void {
	if (type.type !== "Namespace" && !namespaceNames.has(name)) {
		return
	}

	scopeVersions.set(scope, (scopeVersions.get(scope) ?? 0) + 1)
}

// Drops what this Scope and every Scope nested in it memoised about the
// Namespaces they see and the witnesses those build.
export function invalidateConformancesInScope(scope: enricher.Scope): void {
	scopeVersions.set(scope, (scopeVersions.get(scope) ?? 0) + 1)
}

// The version of every Scope on the chain, innermost first, which
// `namespaceCacheIsCurrent` compares.
function scopeVersionSnapshot(
	scope: enricher.Scope,
): Array<{ scope: enricher.Scope; version: number }> {
	let versions: Array<{ scope: enricher.Scope; version: number }> = []
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		versions.push({
			scope: searchScope,
			version: scopeVersions.get(searchScope) ?? 0,
		})

		searchScope = searchScope.parent
	}

	return versions
}

function namespaceCacheIsCurrent(
	cached: { versions: Array<{ scope: enricher.Scope; version: number }> },
	scope: enricher.Scope,
): boolean {
	let searchScope: enricher.Scope | null = scope
	let index = 0

	while (searchScope !== null) {
		let entry = cached.versions[index]

		if (
			entry === undefined ||
			entry.scope !== searchScope ||
			entry.version !== (scopeVersions.get(searchScope) ?? 0)
		) {
			return false
		}

		searchScope = searchScope.parent
		index++
	}

	return index === cached.versions.length
}

export function getAllNamespacesInScope(
	scope: enricher.Scope,
	identifier: parser.IdentifierNode | null,
): Map<string, common.NamespaceType> {
	// A named lookup walks to the nearest binding of the name, whatever it
	// is.
	if (identifier) {
		let namespaces: Map<string, common.NamespaceType> = new Map()
		let name = identifier.content
		let searchScope: enricher.Scope | null = scope

		while (searchScope !== null) {
			if (Object.hasOwn(searchScope.members, name)) {
				let value = searchScope.members[name]

				if (value.type === "Namespace") {
					namespaces.set(name, value)
				} else {
					reportSpecifierIsNotANamespace(
						identifier,
						value,
						Object.hasOwn(searchScope.declarations, name)
							? searchScope.declarations[name]
							: null,
					)
				}

				return namespaces
			}

			searchScope = searchScope.parent
		}

		reportSpecifierNamesNoValue(identifier, scope)

		return namespaces
	}

	let cached = namespacesInScopeCache.get(scope)

	if (cached !== undefined && namespaceCacheIsCurrent(cached, scope)) {
		return cached.namespaces
	}

	// The parent's answer, amended by this Scope's own members.
	let parentNamespaces =
		scope.parent === null
			? EMPTY_NAMESPACES
			: getAllNamespacesInScope(scope.parent, null)

	let amends = false

	for (let key in scope.members) {
		if (
			scope.members[key]!.type === "Namespace" ||
			parentNamespaces.has(key)
		) {
			amends = true

			break
		}
	}

	// A Scope that amends nothing shares its parent's answer by identity.
	let result = amends ? new Map(parentNamespaces) : parentNamespaces

	if (amends) {
		for (let key in scope.members) {
			let value = scope.members[key]!

			if (value.type === "Namespace") {
				result.set(key, value)
				namespaceNames.add(key)
			} else {
				result.delete(key)
			}
		}
	}

	namespacesInScopeCache.set(scope, {
		versions: scopeVersionSnapshot(scope),
		namespaces: result,
	})

	return result
}

// The shared answer for a Scope without a parent.
const EMPTY_NAMESPACES: Map<string, common.NamespaceType> = new Map()

// The visible Namespaces bucketed by the kind of Type they target. See
// "Finding the Namespaces for a receiver" in DEVELOPMENT.md.
type IndexedNamespace = {
	order: number
	name: string
	namespace: common.NamespaceType
}

type NamespaceIndex = {
	// Targets that can match any receiver.
	always: Array<IndexedNamespace>
	byKind: Map<common.Type["type"], Array<IndexedNamespace>>
	// Record targets, each filed under its rarest member name.
	recordsByMember: Map<string, Array<IndexedNamespace>>
	// `for {}` targets every Record, so no member name can file them.
	recordsWithoutMembers: Array<IndexedNamespace>
}

let namespaceIndexes = new WeakMap<
	Map<string, common.NamespaceType>,
	NamespaceIndex
>()

function pushInto<Key>(
	map: Map<Key, Array<IndexedNamespace>>,
	key: Key,
	entry: IndexedNamespace,
): void {
	let bucket = map.get(key)

	if (bucket === undefined) {
		map.set(key, [entry])
	} else {
		bucket.push(entry)
	}
}

function buildNamespaceIndex(
	namespaces: Map<string, common.NamespaceType>,
): NamespaceIndex {
	let index: NamespaceIndex = {
		always: [],
		byKind: new Map(),
		recordsByMember: new Map(),
		recordsWithoutMembers: [],
	}

	let entries: Array<IndexedNamespace> = []
	let memberCounts: Map<string, number> = new Map()
	let order = 0

	for (let [name, namespace] of namespaces) {
		let entry = { order: order++, name, namespace }

		entries.push(entry)

		if (namespace.targetType?.type === "Record") {
			for (let memberName in namespace.targetType.members) {
				memberCounts.set(
					memberName,
					(memberCounts.get(memberName) ?? 0) + 1,
				)
			}
		}
	}

	for (let entry of entries) {
		let targetType = entry.namespace.targetType

		// A Namespace without a target has no receiver.
		if (targetType === null || targetType === undefined) {
			continue
		}

		if (
			targetType.type === "UnionType" ||
			targetType.type === "Unknown" ||
			targetType.type === "GenericUse"
		) {
			index.always.push(entry)
		} else if (
			targetType.type === "List" ||
			targetType.type === "GenericList"
		) {
			// The two List spellings share a bucket.
			pushInto(index.byKind, "List", entry)
		} else if (
			targetType.type === "Dictionary" ||
			targetType.type === "GenericDictionary"
		) {
			// And the two Dictionary spellings, for the same reason.
			pushInto(index.byKind, "Dictionary", entry)
		} else if (targetType.type === "Record") {
			let rarest: string | null = null
			let rarestCount = Infinity

			for (let memberName in targetType.members) {
				let count = memberCounts.get(memberName) ?? 0

				if (count < rarestCount) {
					rarest = memberName
					rarestCount = count
				}
			}

			if (rarest === null) {
				index.recordsWithoutMembers.push(entry)
			} else {
				pushInto(index.recordsByMember, rarest, entry)
			}
		} else {
			pushInto(index.byKind, targetType.type, entry)
		}
	}

	return index
}

// The Namespaces worth matching against `baseType`, a superset of those that
// match, in visible order. The Array is read-only, since a single bucket is
// returned itself.
function namespaceCandidatesFor(
	namespaces: Map<string, common.NamespaceType>,
	baseType: common.Type,
): Array<IndexedNamespace> {
	let index = namespaceIndexes.get(namespaces)

	if (index === undefined) {
		index = buildNamespaceIndex(namespaces)
		namespaceIndexes.set(namespaces, index)
	}

	let buckets: Array<Array<IndexedNamespace>> = []

	if (index.always.length > 0) {
		buckets.push(index.always)
	}

	collectKindCandidates(index, baseType, buckets)

	if (buckets.length === 0) {
		return EMPTY_CANDIDATES
	}

	if (buckets.length === 1) {
		return buckets[0]!
	}

	return mergeCandidateBuckets(buckets)
}

const EMPTY_CANDIDATES: Array<IndexedNamespace> = []

// The non-empty buckets a receiver of this kind reads, besides the ones every
// lookup reads. A refined receiver reads its base's and the refinements',
// and `matchTypes` decides which refinement fits.
function collectKindCandidates(
	index: NamespaceIndex,
	baseType: common.Type,
	buckets: Array<Array<IndexedNamespace>>,
): void {
	if (baseType.type === "Refinement") {
		pushBucket(buckets, index.byKind.get("Refinement"))
		collectKindCandidates(index, baseType.base, buckets)

		return
	}

	if (baseType.type === "Record") {
		pushBucket(buckets, index.recordsWithoutMembers)

		for (let memberName in baseType.members) {
			pushBucket(buckets, index.recordsByMember.get(memberName))
		}

		return
	}

	if (baseType.type === "List" || baseType.type === "GenericList") {
		// The two List spellings share one bucket.
		pushBucket(buckets, index.byKind.get("List"))

		return
	}

	if (
		baseType.type === "Dictionary" ||
		baseType.type === "GenericDictionary"
	) {
		// And the two Dictionary spellings, for the same reason.
		pushBucket(buckets, index.byKind.get("Dictionary"))

		return
	}

	pushBucket(buckets, index.byKind.get(baseType.type))
}

function pushBucket(
	buckets: Array<Array<IndexedNamespace>>,
	bucket: Array<IndexedNamespace> | undefined,
): void {
	if (bucket !== undefined && bucket.length > 0) {
		buckets.push(bucket)
	}
}

// A merge of buckets each ascending by `order`, which is unique, so the
// result is the sorted concatenation. A linear scan for the smallest head
// suffices for so few buckets.
function mergeCandidateBuckets(
	buckets: Array<Array<IndexedNamespace>>,
): Array<IndexedNamespace> {
	let cursors: Array<number> = []
	let total = 0

	for (let bucket of buckets) {
		cursors.push(0)
		total += bucket.length
	}

	let merged: Array<IndexedNamespace> = []

	for (let written = 0; written < total; written++) {
		let smallestBucket = -1
		let smallestOrder = Infinity

		for (let index = 0; index < buckets.length; index++) {
			let cursor = cursors[index]!
			let bucket = buckets[index]!

			if (cursor >= bucket.length) {
				continue
			}

			let candidate = bucket[cursor]!

			if (candidate.order < smallestOrder) {
				smallestOrder = candidate.order
				smallestBucket = index
			}
		}

		merged.push(buckets[smallestBucket]![cursors[smallestBucket]!]!)
		cursors[smallestBucket]! += 1
	}

	return merged
}

// The remembered answers of `namespacesTargeting` for one Namespaces Map,
// which are pure: the inference each match makes is thrown away. See
// "Finding the Namespaces for a receiver" in DEVELOPMENT.md.
type TargetingAnswers = {
	// Receivers that are only their tag share one answer per tag.
	byTag: Map<string, Map<string, common.NamespaceType>>
	// Any other receiver, keyed by identity.
	byType: WeakMap<common.Type, Map<string, common.NamespaceType>>
}

// The Types with no field but `type`. The List and Dictionary Types are not
// among them, since their slots are fields.
const tagOnlyTypes: ReadonlySet<string> = new Set([
	"Unknown",
	"Error",
	"Boolean",
	"String",
	"Integer",
	"Rational",
	"Algebraic",
	"Transcendental",
])

let namespacesTargetingMemos = new WeakMap<
	Map<string, common.NamespaceType>,
	TargetingAnswers
>()

// Drops every candidate index and remembered answer, for a target rewritten
// in place.
export function forgetNamespaceTargets(): void {
	namespaceIndexes = new WeakMap()
	namespacesTargetingMemos = new WeakMap()
}

// Which of the given Namespaces target `baseType`, in the given order. It
// also answers for Namespaces not in scope, which "no such Method" asks about.
// The Map is shared, so a caller copies it before changing it.
export function namespacesTargeting(
	namespaces: Map<string, common.NamespaceType>,
	baseType: common.Type,
): Map<string, common.NamespaceType> {
	let memo = namespacesTargetingMemos.get(namespaces)

	if (memo === undefined) {
		memo = { byTag: new Map(), byType: new WeakMap() }
		namespacesTargetingMemos.set(namespaces, memo)
	}

	let byTag = tagOnlyTypes.has(baseType.type)
	let remembered = byTag
		? memo.byTag.get(baseType.type)
		: memo.byType.get(baseType)

	if (remembered !== undefined) {
		return remembered
	}

	let matchingNamespaces = computeNamespacesTargeting(namespaces, baseType)

	if (byTag) {
		memo.byTag.set(baseType.type, matchingNamespaces)
	} else {
		memo.byType.set(baseType, matchingNamespaces)
	}

	return matchingNamespaces
}

function computeNamespacesTargeting(
	namespaces: Map<string, common.NamespaceType>,
	baseType: common.Type,
): Map<string, common.NamespaceType> {
	let matchingNamespaces: Map<string, common.NamespaceType> = new Map()

	// A generic Namespace matches by binding its Type Parameters, renamed
	// first by `bindNamespaceTarget`, against the receiver. The bindings only
	// select.
	for (let { name, namespace } of namespaceCandidatesFor(
		namespaces,
		baseType,
	)) {
		if (namespace.targetType) {
			if (namespace.targetType.type === "UnionType") {
				// A Union receiver matches a Union target as a whole.
				if (bindNamespaceTarget(namespace, baseType) !== null) {
					matchingNamespaces.set(name, namespace)
					continue
				}

				for (let type of namespace.targetType.types) {
					if (
						bindNamespaceTarget(
							{
								targetType: type,
								generics: namespace.generics,
							},
							baseType,
						) !== null
					) {
						matchingNamespaces.set(name, namespace)
						break
					}
				}
			} else if (bindNamespaceTarget(namespace, baseType) !== null) {
				matchingNamespaces.set(name, namespace)
			}
		}
	}

	return matchingNamespaces
}

// The pseudo Namespace a bounded Type Parameter's Methods are reached
// through, named after its hidden conformance Parameter. It holds the whole
// Protocol surface, and answers both `value::method()` and `T.cases()`.
export function conformanceNamespaceFor(
	baseType: common.GenericUse,
	scope: enricher.Scope,
): common.NamespaceType | null {
	if (baseType.constraint === undefined) {
		return null
	}

	let protocol = protocolOf(baseType.constraint, scope)
	let selfBindings: GenericBindings = new Map([["Self", baseType]])
	let methods: Record<string, common.MethodType> = {}
	let providedMembers: Record<string, string> = {}

	for (let [methodName, method] of Object.entries(protocol.methods)) {
		methods[methodName] = applyGenericBindings(
			method,
			selfBindings,
		) as common.MethodType

		let providingProtocol = providedMethodProtocol(protocol, methodName)

		if (providingProtocol !== null) {
			providedMembers[methodName] = providingProtocol
		}
	}

	return {
		type: "Namespace",
		name: conformanceParameterName(baseType.name),
		targetType: baseType,
		generics: [],
		properties: {},
		methods,
		...(Object.keys(providedMembers).length === 0
			? {}
			: { providedMembers }),
	}
}

// The undeclared Namespace a Lookup on a Type name reads off, as in
// `Colour.cases()` or `T.cases()`. Only where no value has the name, and only
// for a member it offers, so `Colour.spelledWrong` stays `unknown-name`.
export function namespaceNamedByType(
	node: parser.LookupNode,
	scope: enricher.Scope,
): common.NamespaceType | null {
	if (
		node.base.nodeType !== "Identifier" ||
		findVariableOrBarredName(node.base.content, scope) !== null
	) {
		return null
	}

	let declared = findTypeInScope(node.base.content, scope)

	if (declared === null) {
		return null
	}

	let namespace =
		declared.type === "GenericUse"
			? conformanceNamespaceFor(declared, scope)
			: derivedEnumerableNamespaceForNamedChoice(declared, scope)

	return namespace !== null &&
		Object.hasOwn(namespace.methods, node.member.content)
		? namespace
		: null
}

// The Case listing for a Choice named in a Lookup's base: a Namespace's
// written `cases`, or else the derive. Null for a generic Choice, whose name
// carries no Type Arguments.
function derivedEnumerableNamespaceForNamedChoice(
	declared: common.Type,
	scope: enricher.Scope,
): common.NamespaceType | null {
	let protocol = knownProtocol(enumerableProtocolName, scope)

	if (protocol === null || choiceIdentityOf(declared) === null) {
		return null
	}

	return (
		namespaceWritingCasesFor(declared, scope) ??
		derivedEnumerableNamespaceForChoice(declared, protocol)
	)
}

// The Namespace over a Choice that writes `cases`, narrowed to that Method.
function namespaceWritingCasesFor(
	declared: common.Type,
	scope: enricher.Scope,
): common.NamespaceType | null {
	for (let namespace of namespacesTargeting(
		getAllNamespacesInScope(scope, null),
		declared,
	).values()) {
		let written = namespace.methods[enumerableMethodName]

		if (written !== undefined) {
			return { ...namespace, properties: {}, methods: { cases: written } }
		}
	}

	return null
}

export function resolveMethodLookupNamespacesForReceiverType(
	baseType: common.Type,
	namespaceSpecifier: parser.MethodInvocationNode["namespaceSpecifier"],
	scope: enricher.Scope,
): Map<string, common.NamespaceType> {
	let matchingNamespaces: Map<string, common.NamespaceType> = new Map()

	// A Union holding a hole is called by its known members.
	baseType = withoutHoles(baseType)

	// Read whatever the receiver, so a specifier naming no Namespace is
	// refused where it is written.
	let named =
		namespaceSpecifier === null
			? null
			: getAllNamespacesInScope(scope, namespaceSpecifier)

	// An Error receiver matches no Namespace, so it raises nothing further.
	if (baseType.type === "Error") {
		return matchingNamespaces
	}

	// A bounded Type Parameter resolves only through its Protocol, emitted
	// as `Item__conformance.method(item, …)`. A Namespace a specifier names is
	// no such Protocol.
	if (baseType.type === "GenericUse" && baseType.constraint !== undefined) {
		let conformance = conformanceNamespaceFor(baseType, scope)

		if (conformance !== null && (named === null || named.size === 0)) {
			matchingNamespaces.set(conformance.name, conformance)
		}

		return matchingNamespaces
	}

	// An unbounded Type Parameter has no Methods, even where a Namespace's
	// target Union has a bindable member that would bind it.
	if (baseType.type === "GenericUse") {
		return matchingNamespaces
	}

	return namespacesCovering(named, baseType, scope)
}

// The Namespaces declaring the Method as an instance Method, apart from
// those declaring it static, which no `::` call reaches. A Diagnostic can then
// say the Method is called differently.
export function partitionInstanceMethodNamespaces(
	methodName: string,
	namespaces: Map<string, common.NamespaceType>,
): {
	instanceNamespaces: Map<string, common.NamespaceType>
	staticNamespaces: Map<string, common.NamespaceType>
} {
	let instanceNamespaces = new Map<string, common.NamespaceType>()
	let staticNamespaces = new Map<string, common.NamespaceType>()

	for (let [name, namespace] of namespaces) {
		if (isStaticMethod(namespace.methods[methodName])) {
			staticNamespaces.set(name, namespace)
		} else {
			instanceNamespaces.set(name, namespace)
		}
	}

	return { instanceNamespaces, staticNamespaces }
}

// Which of the Namespaces found for a receiver declare the Method. These are
// the written ones and the provided Methods beside them. The derives answer
// only where nothing written does.
export function namespacesDeclaringMethod(
	methodName: string,
	namespaces: Map<string, common.NamespaceType>,
	baseType: common.Type,
	scope: enricher.Scope,
	position: common.Position,
	// The `<Name>` a call wrote, read only for a Protocol's provided Methods.
	specifier: parser.IdentifierNode | null = null,
): Map<string, common.NamespaceType> {
	if (specifier !== null && namespaces.size === 0) {
		return providedMethodNamespacesNamed(
			specifier,
			methodName,
			baseType,
			scope,
			position,
		)
	}

	let matchingNamespaces = new Map<string, common.NamespaceType>()

	for (let [name, namespace] of namespaces) {
		if (Object.hasOwn(namespace.methods, methodName)) {
			matchingNamespaces.set(name, namespace)
		}
	}

	// A derive that answers answers alone, ahead of the provided Methods: it
	// takes the whole Choice, so `Ordering#Less::isNot(#Equal)` resolves.
	if (matchingNamespaces.size === 0) {
		let derived = derivedEquatableNamespace(baseType, scope, position)

		if (derived !== null && Object.hasOwn(derived.methods, methodName)) {
			matchingNamespaces.set(derivedEquatableNamespaceName, derived)
		}

		// The printing derive needs a Namespace that declared `is Printable`.
		let printable = derivedPrintableNamespace(
			baseType,
			namespaces.values(),
			scope,
		)

		if (
			printable !== null &&
			Object.hasOwn(printable.methods, methodName)
		) {
			matchingNamespaces.set(derivedPrintableNamespaceName, printable)
		}

		if (matchingNamespaces.size > 0) {
			return matchingNamespaces
		}
	}

	// The provided Methods stand beside the written ones. See "Provided
	// Methods at a call" in DEVELOPMENT.md.
	for (let [name, namespace] of providedMethodNamespaces(
		methodName,
		baseType,
		namespaces.values(),
		scope,
		position,
	)) {
		matchingNamespaces.set(name, namespace)
	}

	return matchingNamespaces
}

// The Parameter Types of a signature, each with its documentation: a `§§`
// block of its own, or the `@param` line at its position.
function resolveParameterTypes(
	definition: {
		parameters: Array<parser.ParameterNode>
		documentation: common.Documentation | null
	},
	scope: enricher.Scope,
): Array<common.Parameter> {
	reportDocumentationParameters(definition.documentation, [
		definition.parameters,
	])
	refuseIndistinguishableDefaults(definition.parameters)

	// Every `common.Parameter` is built here, so `hasDefault` and
	// `defaultMembers` are set here alone. The default itself stays on the Node.
	return definition.parameters.map((parameter, index) => {
		let type = resolveDeclaredType(parameter.type, scope)
		let defaultMembers = recordDefaultMembers(type, parameter.defaultValue)
		// Absent where nothing nests.
		let defaultNesting = recordDefaultNesting(type, parameter.defaultValue)
		// A partial Record default leaves members to every caller, so the
		// Argument stays required and `hasDefault` stays unset.
		let isPartial =
			defaultMembers !== null &&
			type.type === "Record" &&
			defaultMembers.length < Object.keys(type.members).length

		return {
			name: parameter.externalName?.content ?? null,
			type,
			documentation: parameterDocumentation(
				parameter,
				definition.documentation,
				index,
			),
			...(parameter.defaultValue === null || isPartial
				? {}
				: { hasDefault: true as const }),
			...(defaultMembers === null ? {} : { defaultMembers }),
			...(defaultNesting === null ||
			Object.keys(defaultNesting).length === 0
				? {}
				: { defaultNesting }),
		}
	})
}

// Refuses a default that makes two entries of one `overload` block accept the
// same call. See "Defaults in an Overload" in DEVELOPMENT.md.
function refuseAmbiguousOverloadDefaults(
	entries: Array<{
		parameters: Array<parser.ParameterNode>
		position: common.Position
	}>,
): void {
	// A block without a default has no such clash.
	if (
		entries.length < 2 ||
		!entries.some((entry) =>
			entry.parameters.some(
				(parameter) => parameter.defaultValue !== null,
			),
		)
	) {
		return
	}

	let shapes = entries.map((entry) => acceptedShapes(entry.parameters))
	// Which entries accept each shape, built once for the search.
	let entriesByShape = new Map<string, Array<number>>()

	for (let [index, entryShapes] of shapes.entries()) {
		for (let shape of entryShapes) {
			let accepting = entriesByShape.get(shape.key)

			if (accepting === undefined) {
				entriesByShape.set(shape.key, [index])
			} else if (accepting[accepting.length - 1] !== index) {
				accepting.push(index)
			}
		}
	}

	for (let [index, entryShapes] of shapes.entries()) {
		let clash: {
			omitted: parser.ParameterNode
			other: number
			shape: string
		} | null = null

		for (let shape of entryShapes) {
			if (shape.omitted.length === 0) {
				continue
			}

			let other =
				entriesByShape
					.get(shape.key)
					?.find((accepting) => accepting !== index) ?? -1

			if (other !== -1) {
				clash = {
					omitted: shape.omitted[0]!,
					other,
					shape: shape.key,
				}

				break
			}
		}

		if (clash === null) {
			continue
		}

		let position = clash.omitted.defaultValue!.position

		reportError(
			"This default makes two Overloads accept the same call",
			position,
			{
				code: "ambiguous-overload-default",
				labels: [
					primary(
						position,
						`leaving this out ${describeAcceptedShape(clash.shape)}`,
					),
					secondary(
						entries[clash.other]!.position,
						`this entry ${describeAcceptedShape(clash.shape)}`,
					),
				],
				notes: [
					"An Overload is selected by the Arguments a call writes, so two entries that accept the same ones can not both be reached.",
				],
				helps: [
					"Delete the entry the default already stands for, or give the Parameters labels that tell the two apart.",
				],
			},
		)
	}
}

// Refuses a partial Record default that makes two entries of one shape
// accept one Argument list. See "Defaults in an Overload" in DEVELOPMENT.md.
function refuseAmbiguousPartialDefaults(
	entries: Array<{
		parameters: Array<parser.ParameterNode>
		position: common.Position
	}>,
	signatures: Array<{ parameterTypes: Array<common.Parameter> }>,
): void {
	if (
		entries.length < 2 ||
		!signatures.some((signature) =>
			signature.parameterTypes.some(
				(parameter) => parameter.defaultMembers !== undefined,
			),
		)
	) {
		return
	}

	for (let [index, signature] of signatures.entries()) {
		for (let [other, against] of signatures.entries()) {
			if (other === index) {
				continue
			}

			let clash = partialDefaultClash(
				signature.parameterTypes,
				against.parameterTypes,
			)

			if (clash === null) {
				continue
			}

			let entry = entries[index]!
			let offset =
				signature.parameterTypes.length - entry.parameters.length
			let written = entry.parameters[clash.index - offset]
			let position = written?.defaultValue?.position ?? entry.position
			let parameter = signature.parameterTypes[clash.index]!

			reportError(
				"This default makes two Overloads accept the same Record",
				position,
				{
					code: "ambiguous-overload-default",
					labels: [
						primary(
							position,
							`a Record written without ${quotedMemberNames(parameter.defaultMembers ?? [])} still fits ${describeType(parameter.type)}`,
						),
						secondary(
							entries[other]!.position,
							`and fits this entry's ${describeType(against.parameterTypes[clash.index]!.type)}`,
						),
					],
					notes: [
						"An Overload is selected by the Arguments a call writes, so two entries that accept the same ones can not both be reached.",
					],
					helps: [
						"Give the two Parameters labels that tell them apart, or delete the entry the default already stands for.",
					],
				},
			)

			break
		}
	}
}

// The Parameter position where `left` takes a Record only through its
// default and `right` takes it too. Null where no Argument list fits both.
function partialDefaultClash(
	left: Array<common.Parameter>,
	right: Array<common.Parameter>,
): { index: number } | null {
	if (left.length !== right.length) {
		return null
	}

	let needsDefault: number | null = null

	for (let index = 0; index < left.length; index++) {
		if (left[index]!.name !== right[index]!.name) {
			return null
		}

		let overlap = parameterOverlap(left[index]!, right[index]!)

		if (overlap === null) {
			return null
		}

		if (overlap.leftNeedsDefault && needsDefault === null) {
			needsDefault = index
		}
	}

	return needsDefault === null ? null : { index: needsDefault }
}

// Whether one Argument answers both Parameters, and whether `left` needs its
// default for it. The Argument tried holds the members each side requires,
// since a partial Record admits only members it declares.
function parameterOverlap(
	left: common.Parameter,
	right: common.Parameter,
): { leftNeedsDefault: boolean } | null {
	if (left.type.type !== "Record" || right.type.type !== "Record") {
		// Any other pair overlaps where some value fits both.
		return matchesType(left.type, right.type) ||
			matchesType(right.type, left.type)
			? { leftNeedsDefault: false }
			: null
	}

	let leftMembers = left.type.members
	let rightMembers = right.type.members
	let candidate = new Set([
		...requiredRecordMembers(left),
		...requiredRecordMembers(right),
	])

	for (let member of candidate) {
		let inLeft = Object.hasOwn(leftMembers, member)
		let inRight = Object.hasOwn(rightMembers, member)

		// A member one side lacks while reading partially can not be
		// written, so there is no clash.
		if (
			(!inLeft && left.defaultMembers !== undefined) ||
			(!inRight && right.defaultMembers !== undefined)
		) {
			return null
		}

		if (
			inLeft &&
			inRight &&
			!matchesType(leftMembers[member]!, rightMembers[member]!) &&
			!matchesType(rightMembers[member]!, leftMembers[member]!)
		) {
			return null
		}
	}

	return {
		leftNeedsDefault:
			left.defaultMembers !== undefined &&
			candidate.size < Object.keys(leftMembers).length,
	}
}

// The members a call must write into a Record Argument: those the default
// does not fill in, or all of them without one.
function requiredRecordMembers(parameter: common.Parameter): Array<string> {
	let members = Object.keys((parameter.type as common.RecordType).members)

	if (parameter.defaultMembers === undefined) {
		return members
	}

	let filled = new Set(parameter.defaultMembers)

	return members.filter((member) => !filled.has(member))
}

// Members spelled as Diagnostics list them: `'host', 'retries'`.
function quotedMemberNames(names: ReadonlyArray<string>): string {
	return names.map((name) => `'${name}'`).join(", ")
}

// A signature with more defaults than this is not enumerated, since its
// shapes number `2 ** defaults`.
const MAXIMUM_ENUMERATED_DEFAULTS = 10

function acceptedShapes(
	parameters: Array<parser.ParameterNode>,
): Array<{ key: string; omitted: Array<parser.ParameterNode> }> {
	let defaults = parameters.filter(
		(parameter) => parameter.defaultValue !== null,
	)

	if (
		defaults.length === 0 ||
		defaults.length > MAXIMUM_ENUMERATED_DEFAULTS
	) {
		return [{ key: shapeKey(parameters), omitted: [] }]
	}

	let shapes: Array<{ key: string; omitted: Array<parser.ParameterNode> }> =
		[]

	for (let subset = 0; subset < 2 ** defaults.length; subset++) {
		let omitted = defaults.filter(
			(_, index) => (subset & (1 << index)) !== 0,
		)
		// A Set, since it is asked once per Parameter.
		let dropped = new Set(omitted)
		let kept = parameters.filter((parameter) => !dropped.has(parameter))

		shapes.push({ key: shapeKey(kept), omitted })
	}

	return shapes
}

function shapeKey(parameters: Array<parser.ParameterNode>): string {
	return parameters
		.map((parameter) => parameter.externalName?.content ?? "_")
		.join(",")
}

function describeAcceptedShape(key: string): string {
	if (key === "") {
		return "takes no Arguments"
	}

	let labels = key.split(",")

	return `takes ${countOf(labels.length, "Argument")}, ${labels
		.map((label) => (label === "_" ? "one with no label" : `'${label}'`))
		.join(" then ")}`
}

// Refuses a default followed by a Parameter of the same label, so pairing
// Arguments by label never backtracks. See "Defaults and Argument pairing" in
// DEVELOPMENT.md.
function refuseIndistinguishableDefaults(
	parameters: Array<parser.ParameterNode>,
): void {
	for (let [index, parameter] of parameters.entries()) {
		if (parameter.defaultValue === null) {
			continue
		}

		let label = parameter.externalName?.content ?? null
		let clash = parameters
			.slice(index + 1)
			.find((later) => (later.externalName?.content ?? null) === label)

		if (clash === undefined) {
			continue
		}

		reportError(
			"This default could not be told apart from the Parameter after it",
			parameter.defaultValue.position,
			{
				code: "indistinguishable-default-parameter",
				labels: [
					primary(parameter.defaultValue.position, "this default"),
					secondary(
						clash.position,
						label === null
							? "and this Parameter carries no label either"
							: "and this Parameter carries the same label",
					),
				],
				notes: [
					"An Argument is matched to a Parameter by its label before its Type is read, so a call passing one of them could mean either.",
				],
				helps: [
					"Give one of them a label, or move the default to the last of them.",
				],
			},
		)
	}
}

// Warns where a `@param` line does not name the Parameter at its position by
// its label, or `_`. Position tells one `_` from another. A block above an
// `overload` keyword instead accepts any name one of its entries takes.
export function reportDocumentationParameters(
	documentation: common.Documentation | null | undefined,
	signatures: Array<Array<parser.ParameterNode>>,
): void {
	let tags = documentation?.parameters ?? []

	// No tag Position to point at, as in a block without `@param` or a
	// resolved signature's Documentation.
	if (!tags.some((tag) => tag.tag !== undefined)) {
		return
	}

	if (signatures.length === 1) {
		reportPositionalDocumentation(tags, signatures[0]!)

		return
	}

	reportUnknownDocumentationNames(tags, signatures)
}

// How closely `@param` lines are held to the signature. `"strict"` wants one
// line per Parameter, in order, named as the signature writes it.
// `"lenient"` also accepts a run that stops early, and an internal name where
// there is a label. A block without `@param` is left alone in both.
type DocumentationStrictness = "lenient" | "strict"

export const documentationStrictness: DocumentationStrictness = "strict"

// A Parameter's label and the name its body reads it under. A positional
// Parameter has no label, and a Pattern Parameter no single internal name.
export type DocumentedParameter = {
	label: string | null
	internalName: string | null
}

type DocumentationParameterProblem =
	// A line past the end of the Parameter list.
	| { kind: "unknown"; index: number }
	// A line naming something other than the Parameter at its position.
	| { kind: "misnamed"; index: number }
	// A Parameter no line reached. Strict only.
	| { kind: "undocumented"; index: number }

// The rule as a pure function, so both strictnesses can be tested alone.
export function documentationParameterProblems(
	tags: Array<string>,
	parameters: Array<DocumentedParameter>,
	strictness: DocumentationStrictness = documentationStrictness,
): Array<DocumentationParameterProblem> {
	let problems: Array<DocumentationParameterProblem> = []

	for (let [index, tag] of tags.entries()) {
		let parameter = parameters[index]

		if (parameter === undefined) {
			problems.push({ kind: "unknown", index })
		} else if (!namesParameter(tag, parameter, strictness)) {
			problems.push({ kind: "misnamed", index })
		}
	}

	if (strictness === "strict") {
		for (let index = tags.length; index < parameters.length; index += 1) {
			problems.push({ kind: "undocumented", index })
		}
	}

	return problems
}

function namesParameter(
	tag: string,
	parameter: DocumentedParameter,
	strictness: DocumentationStrictness,
): boolean {
	if (tag === writtenParameterName(parameter)) {
		return true
	}

	return (
		strictness === "lenient" &&
		parameter.internalName !== null &&
		tag === parameter.internalName
	)
}

// What the signature and its `@param` write for a Parameter: the label, or
// `_`.
function writtenParameterName(parameter: DocumentedParameter): string {
	return parameter.label ?? "_"
}

// What a reader is shown in place of `_`: the internal name.
function displayParameterName(parameter: DocumentedParameter): string {
	return parameter.label ?? parameter.internalName ?? "_"
}

function documentedParameter(
	parameter: parser.ParameterNode,
): DocumentedParameter {
	return {
		label: parameter.externalName?.content ?? null,
		internalName: parameterInternalName(parameter)?.content ?? null,
	}
}

const positionalRule =
	"A '@param' line documents the Parameter at its own position — the first line the first Parameter — and names it the way the signature does: its label, or '_' where it carries none."

// The line a Quick Fix would write, only for the first Parameter the run
// falls short of, since a later line would leave a gap. Spread as
// `suggestionData` is.
function documentationLineData(
	tags: Array<common.DocumentationParameter>,
	parameter: string,
	index: number,
): { data?: common.DiagnosticData } {
	let last = tags[tags.length - 1]?.tag

	if (index !== tags.length || last === undefined) {
		return {}
	}

	return {
		data: { kind: "documentation-line", parameter, after: last.position },
	}
}

function reportPositionalDocumentation(
	tags: Array<common.DocumentationParameter>,
	signature: Array<parser.ParameterNode>,
): void {
	let parameters = signature.map(documentedParameter)
	let written = parameters.map(writtenParameterName)
	let problems = documentationParameterProblems(
		tags.map((tag) => tag.name),
		parameters,
	)
	let order =
		parameters.length === 0
			? []
			: [`The Parameters are '${written.join("', '")}', in that order.`]

	for (let problem of problems) {
		if (problem.kind === "undocumented") {
			let parameter = signature[problem.index]!
			// Where the name is already on another Parameter's line, both
			// reports describe one missing line. The Note says which to fix first.
			let alreadyWritten = tags.findIndex(
				(tag) => tag.name === written[problem.index],
			)

			reportWarning(
				"This Parameter has no '@param' line",
				parameter.position,
				{
					code: "undocumented-parameter",
					...documentationLineData(
						tags,
						written[problem.index]!,
						problem.index,
					),
					labels: [
						primary(
							parameter.position,
							`Parameter ${problem.index + 1} is undocumented`,
						),
					],
					notes:
						alreadyWritten === -1
							? [positionalRule]
							: [
									positionalRule,
									`'${written[problem.index]}' is already written on line ${alreadyWritten + 1} of the run, where it documents Parameter ${alreadyWritten + 1} — put that line right first, and the run reads in Parameter order.`,
								],
					helps: [
						`Write '@param ${written[problem.index]} — …' as line ${problem.index + 1} of the run.`,
					],
				},
			)

			continue
		}

		let tag = tags[problem.index]

		// A tag without a Position is skipped.
		if (tag?.tag === undefined) {
			continue
		}

		if (problem.kind === "unknown") {
			reportWarning(
				"This '@param' names a Parameter that does not exist",
				tag.tag.position,
				{
					code: "unknown-documentation-parameter",
					labels: [
						primary(
							tag.tag.position,
							parameters.length === 0
								? "what this documents takes no Parameters"
								: `there is no Parameter ${problem.index + 1}`,
						),
					],
					notes:
						parameters.length === 0
							? [
									"A '§§' block documents whatever is declared below it. A '@param' belongs above something that takes Parameters — a Function, a Method, or a Declaration holding a Function literal.",
								]
							: [positionalRule, ...order],
					helps: [
						parameters.length === 0
							? "Remove the tag — there is no Parameter for it to describe."
							: `Remove the tag — this signature takes ${countOf(parameters.length, "Parameter")}.`,
					],
				},
			)

			continue
		}

		let parameter = parameters[problem.index]!
		let elsewhere = written.indexOf(tag.name)
		let notes = [positionalRule, ...order]

		// Usually a line was left out, so the lines run one Parameter late.
		if (elsewhere !== -1 && elsewhere !== problem.index) {
			notes.push(
				`'${tag.name}' is Parameter ${elsewhere + 1}, so a line for each Parameter before it belongs above this one.`,
			)
		}

		reportWarning(
			"This '@param' does not name the Parameter at its position",
			tag.tag.position,
			{
				code: "misnamed-documentation-parameter",
				// The fix writes the name a tag uses: the label, or `_`.
				...suggestionData(written[problem.index]!),
				labels: [
					primary(
						tag.tag.position,
						`Parameter ${problem.index + 1} is '${displayParameterName(parameter)}'`,
					),
				],
				notes,
				helps: [
					parameter.label === null
						? `Write '@param _' — Parameter ${problem.index + 1} carries no label.`
						: `Write '@param ${parameter.label}'.`,
				],
			},
		)
	}
}

// A `§§` block above an `overload` keyword, where position says nothing. A
// name some entry takes is accepted.
function reportUnknownDocumentationNames(
	tags: Array<common.DocumentationParameter>,
	signatures: Array<Array<parser.ParameterNode>>,
): void {
	let names: Array<string> = []

	for (let signature of signatures) {
		for (let parameter of signature) {
			let parameterNames = documentedParameter(parameter)

			for (let name of [
				parameterNames.label,
				parameterNames.internalName,
			]) {
				if (name !== null && !names.includes(name)) {
					names.push(name)
				}
			}
		}
	}

	for (let tag of tags) {
		if (tag.tag === undefined || names.includes(tag.name)) {
			continue
		}

		let suggestion = closestMatch(tag.name, names)

		reportWarning(
			"This '@param' names a Parameter that does not exist",
			tag.tag.position,
			{
				code: "unknown-documentation-parameter",
				...suggestionData(suggestion),
				labels: [
					primary(
						tag.tag.position,
						names.length === 0
							? "what this documents takes no Parameters"
							: `no Parameter is named '${tag.name}'`,
					),
				],
				notes: [
					names.length === 0
						? "A '§§' block documents whatever is declared below it. A '@param' belongs above something that takes Parameters — a Function, a Method, or a Declaration holding a Function literal."
						: "A '@param' above an 'overload' block may name a Parameter of any of its Overloads, under either of the names that Parameter is written with.",
				],
				helps: [
					suggestion !== null
						? `Did you mean '${suggestion}'?`
						: names.length === 0
							? "Remove the tag — there is no Parameter for it to describe."
							: `The Parameters are '${names.join("', '")}'.`,
				],
			},
		)
	}
}

// What documents one Parameter: its own `§§` block, else the `@param` line
// at its position.
export function parameterDocumentation(
	parameter: parser.ParameterNode,
	documentation: common.Documentation | null,
	index: number,
): string | undefined {
	if (parameter.documentation !== null) {
		return parameter.documentation.description
	}

	return documentation?.parameters[index]?.text
}

// The Documentation a resolved signature hands out, each `@param` renamed to
// the label or internal name, so Hover shows no bare `_`. A copy, since the
// formatter compares the parsed Documentation. The tag Positions are dropped.
export function resolvedDocumentation(
	documentation: common.Documentation | null | undefined,
	parameters: Array<parser.ParameterNode>,
): common.Documentation | undefined {
	if (documentation == null) {
		return undefined
	}

	return {
		...documentation,
		parameters: documentation.parameters.map((tag, index) => {
			let parameter = parameters[index]

			return {
				name:
					parameter === undefined
						? tag.name
						: displayParameterName(documentedParameter(parameter)),
				text: tag.text,
			}
		}),
	}
}

// One Method form's `<…>` read apart: its own Type Parameters, and the bounds
// it puts on the Namespace's. See "Method bounds on Namespace Type Parameters"
// in DEVELOPMENT.md.
export type MethodGenericSplit = {
	own: Array<parser.GenericDeclarationNode>
	bounds: Map<string, string>
}

export function splitMethodGenerics(
	generics: Array<parser.GenericDeclarationNode>,
	namespaceGenerics: Array<common.GenericDeclaration>,
	scope: enricher.Scope,
): MethodGenericSplit {
	if (namespaceGenerics.length === 0) {
		return { own: generics, bounds: new Map() }
	}

	let declared = new Set(namespaceGenerics.map((generic) => generic.name))
	let own: Array<parser.GenericDeclarationNode> = []
	let bounds = new Map<string, string>()

	for (let generic of generics) {
		if (!declared.has(generic.name.content)) {
			own.push(generic)

			continue
		}

		if (generic.constraint === null) {
			continue
		}

		let protocol = resolveWrittenProtocol(generic.constraint, scope)

		// Refused and not carried, as a Method's own bound is.
		if (protocol === null) {
			reportUnknownProtocol(generic.constraint, scope)
		} else {
			bounds.set(generic.name.content, protocol.identity)
		}
	}

	return { own, bounds }
}

// The Namespace Type Parameters one Method signature carries, ahead of its
// own and in declaration order: those the signature mentions, and every
// bounded one. See "Method bounds on Namespace Type Parameters" in
// DEVELOPMENT.md.
function mergeNamespaceGenerics(
	namespaceGenerics: Array<common.GenericDeclaration>,
	methodGenerics: Array<common.GenericDeclaration>,
	signature: {
		parameterTypes: Array<common.Parameter>
		returnType: common.Type
	},
	bounds: Map<string, string>,
): Array<common.GenericDeclaration> {
	if (namespaceGenerics.length === 0) {
		return methodGenerics
	}

	let shadowed = new Set(methodGenerics.map((generic) => generic.name))

	let signatureTypes = [
		...signature.parameterTypes.map((parameter) => parameter.type),
		signature.returnType,
	]

	let used = namespaceGenerics.flatMap((generic) => {
		if (shadowed.has(generic.name)) {
			return []
		}

		let constraint = bounds.get(generic.name)

		if (constraint !== undefined) {
			return [{ ...generic, constraint }]
		}

		return signatureTypes.some((type) =>
			typeMentionsGeneric(type, generic.name),
		)
			? [generic]
			: []
	})

	return [...used, ...methodGenerics]
}

// One signature of a Namespace Method, bodied or native, in the shape
// resolution reads.
type MethodSignatureEntry = {
	generics: Array<parser.GenericDeclarationNode>
	parameters: Array<parser.ParameterNode>
	returnType: parser.TypeDeclarationNode | null
	documentation: common.Documentation | null
	position: common.Position
	native: boolean
}

function methodSignatureEntry(
	node: parser.FunctionValueNode | parser.NativeMethodSignatureNode,
): MethodSignatureEntry {
	if (node.nodeType === "NativeMethodSignature") {
		return {
			generics: node.generics,
			parameters: node.parameters,
			returnType: node.returnType,
			documentation: node.documentation,
			position: node.position,
			native: true,
		}
	}

	return {
		generics: node.value.generics,
		parameters: node.value.parameters,
		returnType: node.value.returnType,
		documentation: node.value.documentation,
		// The FunctionValue's Position, where Diagnostics point.
		position: node.position,
		native: false,
	}
}

// A Namespace Method reduced to the shapes resolution distinguishes, its
// bodied and native entries in written order, which picks each
// `__overload$N` name.
type NormalizedMethod = {
	kind: common.MethodType["type"]
	// Exactly one entry for the two non-overloaded forms.
	entries: Array<MethodSignatureEntry>
	// The `overload` block's own documentation, which the entries'
	// individual ones sit under. Always null for a non-overloaded Method.
	documentation: common.Documentation | null
}

function normalizeMethod(
	node: parser.NamespaceMethods[string],
): NormalizedMethod {
	switch (node.nodeType) {
		case "SimpleMethod":
			return {
				kind: "SimpleMethod",
				entries: [methodSignatureEntry(node.method)],
				documentation: null,
			}
		case "StaticMethod":
			return {
				kind: "StaticMethod",
				entries: [methodSignatureEntry(node.method)],
				documentation: null,
			}
		case "SimpleMethodSignature":
			return {
				kind: "SimpleMethod",
				entries: [methodSignatureEntry(node.signature)],
				documentation: null,
			}
		case "StaticMethodSignature":
			return {
				kind: "StaticMethod",
				entries: [methodSignatureEntry(node.signature)],
				documentation: null,
			}
		case "OverloadedMethod":
		case "OverloadedMethodSignatures":
			return {
				kind: "OverloadedMethod",
				entries: node.methods.map(methodSignatureEntry),
				documentation: node.documentation,
			}
		default:
			return {
				kind: "OverloadedStaticMethod",
				entries: node.methods.map(methodSignatureEntry),
				documentation: node.documentation,
			}
	}
}

// Every form of one Namespace Method read apart, in written order. The index
// keeps the views of its Type Parameters in step.
export function methodGenericSplits(
	node: parser.NamespaceMethods[string],
	namespaceGenerics: Array<common.GenericDeclaration>,
	scope: enricher.Scope,
): Array<MethodGenericSplit> {
	return normalizeMethod(node).entries.map((entry) =>
		splitMethodGenerics(entry.generics, namespaceGenerics, scope),
	)
}

// Which entries of a Namespace Method are native, in written order, for the
// standard library loader.
export function nativeMethodEntries(
	node: parser.NamespaceMethods[string],
): Array<boolean> {
	return normalizeMethod(node).entries.map((entry) => entry.native)
}

export function resolveMethodType(
	node: parser.NamespaceMethods[string],
	scope: enricher.Scope,
	selfType: common.Type | null,
	namespaceGenerics: Array<common.GenericDeclaration> = [],
): common.MethodType {
	let normalized = normalizeMethod(node)
	let isStatic =
		normalized.kind === "StaticMethod" ||
		normalized.kind === "OverloadedStaticMethod"

	if (!isStatic && selfType === null) {
		let message =
			"A Namespace without a target Type can only hold static Methods"

		if (normalized.kind === "SimpleMethod") {
			let position = normalized.entries[0]!.position

			reportError(message, position, {
				code: "untyped-namespace-method",
				labels: [primary(position, "this Method is not static")],
				helps: [
					"Give the Namespace a target Type with 'for …', or make the Method static.",
				],
			})
		} else {
			let helps = [
				"Give the Namespace a target Type with 'for …', or make the Methods static.",
			]
			let firstEntry = normalized.entries[0]

			if (firstEntry === undefined) {
				reportError(message, null, {
					code: "untyped-namespace-method",
					labels: [],
					helps,
				})
			} else {
				reportError(message, firstEntry.position, {
					code: "untyped-namespace-method",
					labels: [
						primary(
							firstEntry.position,
							"these overloads are not static",
						),
					],
					helps,
				})
			}
		}

		selfType = { type: "Error" }
	}

	// The receiver Parameter, null for a static Method.
	const receiverType: common.Type | null = isStatic ? null : selfType

	// Per entry, since Overloads mention different Type Parameters. The Type
	// Parameters resolve before the signature, the order the Method reads.
	let resolveEntry = (entry: MethodSignatureEntry) => {
		// An entry bounding a Namespace Type Parameter is no Type Parameter
		// of the Method, or the receiver's `Item` would stop matching. The
		// bound arrives through `mergeNamespaceGenerics`.
		let split = splitMethodGenerics(
			entry.generics,
			namespaceGenerics,
			scope,
		)
		let methodScope = scopeWithGenerics(split.own, scope)
		let entryGenerics = inferringRefused(
			resolveGenericDeclarations(split.own, scope),
			split.own,
			new Set(namespaceGenerics.map((generic) => generic.name)),
		)

		let signature = {
			parameterTypes: [
				...(receiverType === null
					? []
					: [{ name: null, type: receiverType }]),
				...resolveParameterTypes(entry, methodScope),
			],
			returnType: resolveDeclaredType(entry.returnType, methodScope),
		}

		return {
			generics: mergeNamespaceGenerics(
				namespaceGenerics,
				entryGenerics,
				signature,
				split.bounds,
			),
			...signature,
			documentation: resolvedDocumentation(
				entry.documentation,
				entry.parameters,
			),
		}
	}

	if (normalized.kind === "SimpleMethod") {
		return { type: "SimpleMethod", ...resolveEntry(normalized.entries[0]!) }
	}

	if (normalized.kind === "StaticMethod") {
		return { type: "StaticMethod", ...resolveEntry(normalized.entries[0]!) }
	}

	reportDocumentationParameters(
		normalized.documentation,
		normalized.entries.map((entry) => entry.parameters),
	)
	refuseAmbiguousOverloadDefaults(normalized.entries)

	let overloads = normalized.entries.map(resolveEntry)

	refuseAmbiguousPartialDefaults(normalized.entries, overloads)

	return {
		type: normalized.kind,
		overloads,
		documentation: normalized.documentation ?? undefined,
	}
}
