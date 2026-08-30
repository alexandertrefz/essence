import {
	caseDefaults,
	filterMostSpecificByTarget,
	flattenUnionMembers,
	isMergedLevel,
	parameterDefaults,
} from "@essence-lang/compiler/helpers"
import {
	printCaseWithPayload,
	printSignatureSummary,
	printType,
	signaturesOf,
} from "@essence-lang/compiler/printType"
import type { common, parser } from "@essence-lang/interfaces"

import type { DocumentAnalysis } from "./analyse"
import {
	type ArgumentContext,
	findArgumentContext,
	pairedParameters,
} from "./argumentContext"
import { typedAssertionExpressions } from "./assertionChildren"
import { type ImportEdit, insertImportEdit } from "./autoImport"
import {
	type CallSnippet,
	callSnippetsFor,
	qualifiedCallSnippetsFor,
} from "./callSnippets"
import { enrichDocument, parseDocument } from "./compilation"
import {
	defineConditions,
	defineExpressions,
	defineValues,
} from "./defineArmChildren"
import { describe, documentationOf } from "./documentation"
import { typedHandlerExpressions } from "./matchHandlerChildren"
import { matchingNamespaces } from "./namespaces"
import { contains, isAtOrBefore, isSmaller } from "./positions"
import { probeSourcesFor, stripNoise } from "./probe"
import {
	type Declaration,
	type DeclarationKind,
	indexProgram,
	type Scope,
	type ScopeRange,
	type SymbolSpace,
} from "./rename"
import { typedProgramBodies, typedProgramNodes } from "./sections"
import type { WorkspaceOffer } from "./workspace"

// NOTE: Completion has three modes, told apart by the text immediately
// before the cursor:
//
// - After `::` (optionally with a `<Namespace>` specifier): Methods of every
//   Namespace whose target Type matches the receiver.
// - After `.`: Members of a Record, or the properties and Methods of a
//   Namespace accessed statically.
// - Otherwise: every name visible in lexical Scope at the cursor (from the
//   same Scope model `rename.ts` builds), split into the value or the Type
//   space by what precedes the identifier being typed.
//
// Member and Method completion resolve the receiver's Type with a "probe":
// the document text up to the trigger is re-parsed with `.lspProbeMember`
// appended (and enough closing brackets to balance it back into a valid
// Program) — the enriched Program's Lookup node for that synthetic member
// carries the receiver's Type in `base.type`, at the Scope the cursor is
// actually in (its enclosing Function's Parameters, `@`, and so on).

// NOTE: Every rename Declaration kind plus `case` and `keyword` — neither is a
// lexical Declaration (a Case resolves through its Choice, never a Scope; a
// Keyword is not a name at all), so neither ever appears in the rename index,
// but both are offered and need a kind of their own.
export type CompletionKind = DeclarationKind | "case" | "keyword"

// NOTE: An Editor sorts a Completion list on `sortText` rather than on the
// order it was handed, so the ranking is carried by every entry: what is
// nearest the cursor's own Scope first, what is merely part of the language
// last.
export const completionTiers = {
	local: 1,
	member: 2,
	document: 3,
	builtin: 4,
	keyword: 5,
	// NOTE: Last, and by a rule rather than by taste: everything above is
	// already reachable where the cursor is, while accepting one of these edits
	// the file's import block as well. An offer that changes two places belongs
	// below every offer that changes one.
	workspace: 6,
} as const

export type CompletionEntry = {
	label: string
	kind: CompletionKind
	detail: string | null
	// NOTE: The description alone — a Completion list has no room for the
	// tagged sections, and Signature Help shows them the moment the call is
	// actually being written.
	documentation?: string | null
	// NOTE: The call as it must be written, in LSP snippet syntax, labels and
	// all. Null wherever no signature resolved — the normal state halfway
	// through a keystroke — and the Editor falls back to the bare name.
	snippet?: string | null
	// NOTE: Only set where a label alone would be ambiguous: the Overloads of
	// one Method share a label on purpose, so their signature tails are what
	// tell them apart.
	labelDetail?: string | null
	tier: number
	preselect?: boolean
	// NOTE: What accepting the entry changes ELSEWHERE — the `import { … }`
	// entry that makes the name resolve at all. The Editor applies these
	// together with the insertion at the cursor, in one undo step.
	additionalEdits?: Array<ImportEdit>
}

// NOTE: What a Module the document has not imported offers, and the Namespace
// Types behind the ones that are Namespaces — the second is what a Method
// Completion matches against a receiver, and it costs an enrichment per
// exporting Module, so the two are asked for separately.
export type WorkspaceCompletions = {
	offers: Array<WorkspaceOffer>
	namespaces: Array<{
		offer: WorkspaceOffer
		namespace: common.NamespaceType
	}>
}

// NOTE: Must be a valid Identifier on its own — `_` and `-` are Symbols the
// Lexer never puts inside a name, so a plain camelCase name is used.
const probeMemberName = "lspProbeMember"

// NOTE: The name the dotted-KEY reading writes, kept apart from the member
// probe's on purpose: `{ config with server.<cursor> }` has to be read as the
// key it is, and the SAME text read as an ordinary member access — a Lookup on
// whatever `server` happens to name in Scope — would answer a Record that has
// nothing to do with the update. Two names means a key reading can only ever be
// answered by a key.
const probeKeyName = "lspProbeKey"

// NOTE: Mirrors `forbiddenIdentifierCharacters` in rename.ts — anything the
// Lexer would not produce as part of a single Identifier Token.
const identifierTail = /[^\s"§(){}[\]<>|/@,.:=~_-]*$/
const identifierCharacter = /[^\s"§(){}[\]<>|/@,.:=~_-]/
// NOTE: A whole `is` Token rather than the tail of an Identifier — `axis`
// ends in the same two characters and means nothing of the sort.
const trailingIsPattern = /(?:^|[\s"§(){}[\]<>|/@,.:=~_-])is$/
const methodTriggerPattern = /::(?:<([^>]*)>)?[^\s"§(){}[\]<>|/@,.:=~_-]*$/
const memberTriggerPattern = /\.[^\s"§(){}[\]<>|/@,.:=~_-]*$/
// NOTE: A Namespace specifier that is still being typed — the closing `>` is
// missing, so `methodTriggerPattern` cannot match it yet.
const specifierTriggerPattern = /::<[^\s"§(){}[\]<>|/@,.:=~_-]*$/
// NOTE: A Case reference being typed — the `#` sigil, optionally preceded by a
// Choice name specifier (`Colour#`), and the Case name so far. The character
// class also excludes `#` itself, so the specifier is a clean Identifier and
// the trigger locks onto the final `#`.
const caseTriggerPattern =
	/([^\s"§(){}[\]<>|/@,.:=~_#-]*)#[^\s"§(){}[\]<>|/@,.:=~_#-]*$/
// NOTE: A valid Case name that no real Choice is expected to declare — the
// stand-in a probe writes where the in-progress `#name` was, so the document
// parses and its expected Type and Choices in scope can be read back.
const probeCaseName = "LspProbeCase"

// NOTE: The Keywords `parseImplementationNode` dispatches a Statement on,
// plus the two that open a block of their own — `static` inside a Namespace
// body and `implementation` around the whole Program.
const statementKeywords = [
	"constant",
	"variable",
	"function",
	"if",
	"match",
	"namespace",
	"protocol",
	"type",
	"choice",
	"overload",
	"static",
	"implementation",
]

// NOTE: What `parsePrimaryExpression` accepts as the start of an Expression —
// every other Keyword it reads there is an Identifier in disguise.
//
// NOTE: `as` and `otherwise` are absent, and not for the reason the Keywords
// below are offered where they will not parse. Those all START something; these
// two are the middle and the end of an arm, and no cursor this list is asked at
// is ever waiting for one. Offering them would need a reading of what block the
// cursor stands in and how much of its arm is already written — which is the
// analysis the NOTE on `keywordCompletions` declines to do.
const expressionKeywords = ["match", "define", "true", "false", "nothing"]

export function findCompletions(
	documentText: string,
	cursor: common.Cursor,
	documentPath?: string,
	workspace: WorkspaceCompletions = { offers: [], namespaces: [] },
	document: DocumentAnalysis | null = null,
): Array<CompletionEntry> {
	let lines = documentText.split("\n")
	let currentLine = lines[cursor.line - 1] ?? ""
	let beforeCursor = currentLine.slice(0, cursor.column - 1)

	let specifierMatch = specifierTriggerPattern.exec(beforeCursor)
	let methodMatch =
		specifierMatch === null ? methodTriggerPattern.exec(beforeCursor) : null
	let memberMatch =
		specifierMatch === null && methodMatch === null
			? memberTriggerPattern.exec(beforeCursor)
			: null
	let match = specifierMatch ?? methodMatch ?? memberMatch

	if (match !== null) {
		let headText = [
			...lines.slice(0, cursor.line - 1),
			beforeCursor.slice(0, match.index),
		].join("\n")

		// NOTE: The dotted-KEY reading is tried first, and only where a `.`
		// triggered this: `{ config with server.<cursor> }` names a member of
		// the value being UPDATED, and reading `server` as a name in Scope
		// would answer whatever else happens to be called that. It answers only
		// where the Enricher really wrote a nested update out, so every other
		// cursor falls through to the reading it always had.
		// NOTE: A `::` cursor is probed as a METHOD call and a `.` cursor as a
		// member Lookup, because a receiver answers a different Type in the two
		// positions: a written value proves what it can about itself where a
		// Method is looked up on it, and `4::` offers `namespace
		// NonNegativeInteger`'s Methods for that reason. A Lookup probe would
		// ask the same `4` with nothing in front of it and offer Integer's
		// alone.
		let base =
			(memberMatch === null
				? null
				: resolveProbedBase(
						headText,
						documentPath,
						`.${probeKeyName} = 0`,
					)) ??
			resolveProbedBase(
				headText,
				documentPath,
				memberMatch === null
					? `::${probeMemberName}()`
					: `.${probeMemberName}`,
			)

		if (base === null) {
			return []
		}

		if (specifierMatch !== null) {
			return specifierCompletions(
				documentText,
				base.type,
				documentPath,
				document,
			)
		}

		return methodMatch !== null
			? methodCompletions(
					documentText,
					base.type,
					methodMatch[1] ?? null,
					documentPath,
					workspace.namespaces,
					document,
				)
			: memberCompletions(base.type, base.program)
	}

	// NOTE: A `#` offers Cases rather than Scope names — the two never share a
	// position, so this is checked before the Scope fallback and only when no
	// `::` or `.` trigger claimed the cursor first.
	let caseMatch = caseTriggerPattern.exec(beforeCursor)

	if (caseMatch !== null) {
		return caseCompletions(
			lines,
			cursor,
			beforeCursor,
			currentLine,
			caseMatch.index,
			caseMatch[1] ?? "",
			documentPath,
		)
	}

	let headText = [...lines.slice(0, cursor.line - 1), beforeCursor].join("\n")
	let space = detectSymbolSpace(headText)

	// NOTE: Built before the contextual list rather than beside it, because a
	// Record member that a binding of the same name is in reach of is a whole
	// member on its own — `{ port }` is `{ port = port }` — and this list is
	// already exactly the names in reach. Deriving it twice would be the same
	// walk done twice.
	let scopeEntries = scopeCompletions(
		documentText,
		cursor,
		space,
		documentPath,
		workspace.offers,
		document,
	)

	// NOTE: Record member names and Argument labels are offered *alongside*
	// the names in Scope — both are valid at those positions, since a member
	// is written `name = value` and a labelled Argument `label value`.
	//
	// NOTE: Keywords are offered here and nowhere else — after a `.`, a `::`
	// or a `#` the language allows nothing but a name — and only in the value
	// space, since no Keyword names a Type.
	return [
		...contextualCompletions(
			lines,
			cursor,
			documentPath,
			space === "values" ? bindingsInReach(scopeEntries) : new Set(),
		),
		...scopeEntries,
		...(space === "values" ? keywordCompletions(headText) : []),
	]
}

// NOTE: The names a bare Identifier resolves to where the cursor is. Only the
// kinds that name a VALUE, since that is what a shorthand member reads, and
// only the ones already in reach — a workspace offer is not, and accepting one
// writes an `import` entry the shorthand would not.
function bindingsInReach(entries: Array<CompletionEntry>): Set<string> {
	let bindingKinds = new Set<CompletionKind>([
		"constant",
		"variable",
		"parameter",
		"function",
		"import",
	])

	return new Set(
		entries
			.filter(
				(entry) =>
					bindingKinds.has(entry.kind) &&
					entry.tier !== completionTiers.workspace,
			)
			.map((entry) => entry.label),
	)
}

/*******************************/
/* Record members and labels   */
/*******************************/

function contextualCompletions(
	lines: Array<string>,
	cursor: common.Cursor,
	documentPath?: string,
	// NOTE: See `bindingsInReach`. Empty is not "nothing is in reach" but "do
	// not say anything about the shorthand" — the offers themselves are the
	// same either way.
	bindings: Set<string> = new Set(),
): Array<CompletionEntry> {
	let headText = [
		...lines.slice(0, cursor.line - 1),
		(lines[cursor.line - 1] ?? "").slice(0, cursor.column - 1),
	].join("\n")

	let context: ArgumentContext | null = null

	for (let probeSource of probeSourcesFor(headText)) {
		try {
			let { program } = parseDocument(probeSource, documentPath)
			let { program: enrichedProgram } = enrichDocument(
				program,
				documentPath,
				// NOTE: The probe types the `tests { … }` block too — an
				// Argument being written inside a test body is an Argument, and
				// a Program enriched without the tests holds no Node for it.
				{ tests: true },
			)

			context = findArgumentContext(enrichedProgram, cursor, lines)
		} catch {
			continue
		}

		if (context !== null) {
			break
		}
	}

	if (context === null) {
		return []
	}

	if (context.kind === "record") {
		// NOTE: A member a binding of the same name is in reach of says so,
		// rather than being offered a second time: the two would insert the
		// very same characters, since a bare name IS the whole member. What is
		// new is the sentence, which is the only place the reader learns that
		// stopping after the name finishes the member.
		//
		// `context.shorthand` is false inside an update's key list, where a
		// bare name is refused outright — see `shorthand-in-combination`.
		//
		// NOTE: A member the callee's own default fills in says so instead, and
		// ranks below the ones the call still HAS to write — the writer is being
		// shown what is missing, and a member somebody else supplies is not
		// missing in the same sense. The same wording and the same demotion a
		// label a call may leave out already gets, one level down.
		return Object.entries(context.memberTypes)
			.filter(([name]) => !context.presentMembers.includes(name))
			.map(([name, type]) => {
				let omittable = context.omittableMembers.includes(name)

				return {
					label: name,
					kind: "member" as const,
					detail: omittable
						? `${printType(type)} (may be left out)`
						: context.shorthand && bindings.has(name)
							? `${printType(type)} (or '${name}' alone)`
							: printType(type),
					tier: omittable
						? completionTiers.member + 1
						: completionTiers.member,
				}
			})
	}

	// NOTE: A label a call may leave out is offered like any other, marked as
	// what it is and ranked below the ones the call still HAS to write — the
	// writer is being shown what is missing, and a Parameter with a default is
	// not missing in the same sense.
	return context.parameters
		.filter(
			(
				parameter,
			): parameter is {
				name: string
				type: common.Type
				hasDefault?: true
			} =>
				parameter.name !== null &&
				!context.usedLabels.includes(parameter.name),
		)
		.map((parameter) => ({
			label: parameter.name,
			kind: "label" as const,
			detail: parameter.hasDefault
				? `${printType(parameter.type)} (may be left out)`
				: printType(parameter.type),
			tier: parameter.hasDefault
				? completionTiers.member + 1
				: completionTiers.member,
		}))
}

/*********************************/
/* Probing for the receiver Type */
/*********************************/

// NOTE: The enriched probe Program is handed back alongside the Type it
// resolved — a Namespace Type carries no `§§` documentation for its
// Properties, only the declaration Node does, and the probe already holds
// every declaration above the cursor.
type ProbedBase = {
	type: common.Type
	program: common.typed.Program
}

function resolveProbedBase(
	headText: string,
	documentPath?: string,
	suffix: string = `.${probeMemberName}`,
): ProbedBase | null {
	for (let probeSource of probeSourcesFor(headText, suffix)) {
		try {
			let { program } = parseDocument(probeSource, documentPath)
			let { program: enrichedProgram } = enrichDocument(
				program,
				documentPath,
				{ tests: true },
			)
			let baseType = findProbeReceiver(typedProgramNodes(enrichedProgram))

			if (baseType !== null) {
				return { type: baseType, program: enrichedProgram }
			}
		} catch {
			// NOTE: A reading that does not parse is simply not the reading —
			// the next one is tried, and a cursor no reading explains answers
			// with nothing, exactly as it did.
		}
	}

	return null
}

function findProbeReceiver(
	nodes: Array<common.typed.ImplementationNode>,
): common.Type | null {
	for (let node of nodes) {
		let found = findProbeReceiverInNode(node)

		if (found !== null) {
			return found
		}
	}

	return null
}

// NOTE: A `= expression` default is an Expression position a writer types in, so
// the probe has to be findable there — `= person.|` inside a Parameter list
// asked for a member and got nothing at all, because this walk reached bodies
// and a default is not one.
function findProbeReceiverInDefaults(
	parameters: Array<common.typed.ParameterNode>,
): common.Type | null {
	for (let defaultValue of parameterDefaults(parameters)) {
		let found = findProbeReceiverInNode(defaultValue)

		if (found !== null) {
			return found
		}
	}

	return null
}

function findProbeReceiverInNode(
	node: common.typed.ImplementationNode,
): common.Type | null {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			return findProbeReceiverInNode(node.value)
		case "FunctionStatement":
			return (
				findProbeReceiverInDefaults(node.value.parameters) ??
				findProbeReceiver(node.value.body)
			)
		case "NamespaceDefinitionStatement": {
			for (let property of Object.values(node.properties)) {
				let found = findProbeReceiverInNode(property.value)

				if (found !== null) {
					return found
				}
			}

			for (let member of Object.values(node.methods)) {
				let methods =
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
						? member.methods
						: [member.method]

				for (let method of methods) {
					let found =
						findProbeReceiverInDefaults(method.value.parameters) ??
						findProbeReceiver(method.value.body)

					if (found !== null) {
						return found
					}
				}
			}

			// NOTE: A native Method has no body, and the frame the Compiler
			// synthesizes for its defaults is where its Expressions live — the
			// standard library's own sources are edited through this Server.
			for (let shim of node.nativeShims) {
				let found = findProbeReceiverInDefaults(shim.parameters)

				if (found !== null) {
					return found
				}
			}

			return null
		}
		case "IfStatement": {
			let found = findProbeReceiverInNode(node.condition)

			return found ?? findProbeReceiver(node.body)
		}
		case "IfElseStatement": {
			let found = findProbeReceiverInNode(node.condition)

			return (
				found ??
				findProbeReceiver(node.trueBody) ??
				findProbeReceiver(node.falseBody)
			)
		}
		case "ReturnStatement":
			return findProbeReceiverInNode(node.expression)
		case "ProtocolDeclarationStatement":
			return null
		// NOTE: No path-key reading for a Method's Arguments, for the reason
		// `argumentContext` reads none of their Record members either: the
		// probe truncates the call at the cursor, and a Method resolved off
		// half its Arguments has no signature to name a Parameter's Type with.
		// A free Function's callee is an Expression whose Type stands whatever
		// follows it, which is why the one below can be asked at all.
		// NOTE: The probe a `::` cursor writes, and the Type it is asked for is
		// the RECEIVER's — the one Method resolution reads, refinements and all.
		case "MethodInvocation":
			if (node.member.name === probeMemberName) {
				return node.base.type
			}

			return (
				findProbeReceiverInNode(node.base) ??
				findProbeReceiverInArguments(node.arguments)
			)
		case "FunctionInvocation":
			return (
				findProbeKeyInArguments(
					node.arguments,
					node.name.type.type === "Function"
						? node.name.type.parameterTypes
						: null,
				) ??
				findProbeReceiverInNode(node.name) ??
				findProbeReceiverInArguments(node.arguments)
			)
		case "Lookup":
			if (node.member.content === probeMemberName) {
				return node.base.type
			}

			return findProbeReceiverInNode(node.base)
		case "Combination":
			// NOTE: A dotted KEY carries no Lookup of its own to find — the
			// probe stands as a KEY of the level the Enricher wrote out, and
			// the value that level updates is what its members belong to. Read
			// before the operands, and under a name of its own so that a
			// reading which happened to land as an ordinary member access can
			// not answer in its place.
			if (
				node.rhs.nodeType === "RecordValue" &&
				node.rhs.memberPositions?.[probeKeyName] !== undefined
			) {
				return node.lhs.type
			}

			return (
				findProbeReceiverInNode(node.lhs) ??
				findProbeReceiverInNode(node.rhs)
			)
		case "Match": {
			let found = findProbeReceiverInNode(node.value)

			if (found !== null) {
				return found
			}

			for (let handler of node.handlers) {
				// NOTE: The Matcher and its Guard come before the body in the
				// source, so they are searched first — the probe is looked for
				// where it was typed.
				for (let expression of typedHandlerExpressions(handler)) {
					let expressionFound = findProbeReceiverInNode(expression)

					if (expressionFound !== null) {
						return expressionFound
					}
				}

				let handlerFound = findProbeReceiver(handler.body)

				if (handlerFound !== null) {
					return handlerFound
				}
			}

			return null
		}
		case "Define": {
			// NOTE: Searched in the order the arms were WRITTEN — `as VALUE if
			// CONDITION` — because the probe is looked for where it was typed,
			// not where it is evaluated.
			for (let expression of defineExpressions(node)) {
				let found = findProbeReceiverInNode(expression)

				if (found !== null) {
					return found
				}
			}

			return null
		}
		case "RecordValue": {
			for (let member of Object.values(node.members)) {
				let found = findProbeReceiverInNode(member)

				if (found !== null) {
					return found
				}
			}

			return null
		}
		case "ListValue": {
			for (let value of node.values) {
				let found = findProbeReceiverInNode(value)

				if (found !== null) {
					return found
				}
			}

			return null
		}
		case "DictionaryValue": {
			for (let entry of node.entries) {
				let found =
					findProbeReceiverInNode(entry.key) ??
					findProbeReceiverInNode(entry.value)

				if (found !== null) {
					return found
				}
			}

			return null
		}
		case "InterpolatedStringValue": {
			for (let segment of node.segments) {
				if (segment.kind !== "expression") {
					continue
				}

				let found = findProbeReceiverInNode(segment.expression)

				if (found !== null) {
					return found
				}
			}

			return null
		}
		// NOTE: And this is what a leading dot completes through. `.|` probes as
		// `.lspProbeMember`, which the Enricher desugars into the Function that
		// path stands for — a Lookup chain whose base is the Parameter Type the
		// position named. So the probe finds an ordinary member Lookup off an
		// ordinary Record, and `.maker.|` finds the one a step further in, with
		// no branch of its own anywhere. Reaching a literal's body is what makes
		// that true, so the two are pinned together.
		case "FunctionValue":
			return (
				findProbeReceiverInDefaults(node.value.parameters) ??
				findProbeReceiver(node.value.body)
			)
		case "CaseValue":
			if (node.value === null) {
				return null
			}

			// NOTE: A payload is merged into the Case's own default, so a path
			// key inside one reaches into the Case's Record exactly as an
			// Argument's reaches into the Parameter's it was written for.
			return (
				(node.type.type === "Case"
					? findProbeKeyInMerged(node.value, {
							type: "Record",
							members: node.type.members,
						})
					: null) ?? findProbeReceiverInNode(node.value)
			)
		case "ChoiceDeclarationStatement": {
			// NOTE: A `.` inside a Case payload's default probes the same way
			// one inside a Parameter's does — the member list of whatever the
			// dot follows, wherever the dot was typed.
			for (let defaultValue of caseDefaults(node.cases)) {
				let found = findProbeReceiverInNode(defaultValue)

				if (found !== null) {
					return found
				}
			}

			return null
		}
		// NOTE: What an assertion asserts, and the values its Matcher compares
		// against — `require { points = total.|  } = standing`. Where a Matcher
		// was written the asserted Expression is a synthesized name and the
		// Expression itself is the Statement in front of this one, which this
		// walk reaches on its own.
		case "ExpectStatement":
		case "RequireStatement": {
			let found = findProbeReceiverInNode(node.value)

			if (found !== null || node.matcher === null) {
				return found
			}

			if (node.matcher.literal !== null) {
				found = findProbeReceiverInNode(node.matcher.literal)
			}

			for (let literal of Object.values(
				node.matcher.memberLiterals ?? {},
			)) {
				found ??= findProbeReceiverInNode(literal)
			}

			return found
		}
		case "TypeAliasStatement":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			return null
	}
}

// NOTE: The Record a path key inside a merged Literal reaches into — the answer
// `{ config with server.<cursor> }` reads straight off the value being updated,
// asked of an Argument or a payload, which have no such value written beside
// them. What they merge into is the Parameter's Type, or the Case's, and each
// level of the path reaches one member further into it.
//
// Only levels a path key BUILT are descended: a member written whole is a
// replacement, and the Literal under it writes its members from nothing.
function findProbeKeyInMerged(
	value: common.typed.ExpressionNode,
	into: common.Type,
): common.Type | null {
	if (value.nodeType !== "RecordValue" || into.type !== "Record") {
		return null
	}

	for (let [name, member] of Object.entries(value.members)) {
		// NOTE: `Object.hasOwn` before the read — a member named after one of
		// `Object.prototype`'s would otherwise find a JavaScript function.
		if (!isMergedLevel(member) || !Object.hasOwn(into.members, name)) {
			continue
		}

		let declaredType = into.members[name]!

		if (member.memberPositions?.[probeKeyName] !== undefined) {
			return declaredType
		}

		let found = findProbeKeyInMerged(member, declaredType)

		if (found !== null) {
			return found
		}
	}

	return null
}

// NOTE: The same, for the Arguments of one call — each Argument against the
// Parameter it was written for, which is a question about LABELS once anything
// may be left out. `pairedParameters` is the walk Completion already reads a
// Record Literal's expected members through, so a path key inside one is held
// to the very Parameter its siblings are.
function findProbeKeyInArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
	parameterTypes: common.BaseFunction["parameterTypes"] | null,
): common.Type | null {
	if (parameterTypes === null) {
		return null
	}

	let parameterForArgument = pairedParameters(nodeArguments, parameterTypes)

	for (let [argumentIndex, argument] of nodeArguments.entries()) {
		let parameter =
			parameterTypes[parameterForArgument[argumentIndex] ?? argumentIndex]

		if (parameter === undefined || parameter.type.type === "GenericUse") {
			continue
		}

		let found = findProbeKeyInMerged(argument.value, parameter.type)

		if (found !== null) {
			return found
		}
	}

	return null
}

function findProbeReceiverInArguments(
	nodeArguments: Array<common.typed.ArgumentNode>,
): common.Type | null {
	for (let argument of nodeArguments) {
		let found = findProbeReceiverInNode(argument.value)

		if (found !== null) {
			return found
		}
	}

	return null
}

/*********************/
/* Member completion */
/*********************/

function memberCompletions(
	baseType: common.Type,
	program: common.typed.Program,
): Array<CompletionEntry> {
	if (baseType.type === "Record") {
		return Object.entries(baseType.members).map(([name, type]) => ({
			label: name,
			kind: "member" as const,
			detail: printType(type),
			tier: completionTiers.member,
		}))
	}

	if (baseType.type === "Namespace") {
		let documented = namespacePropertyDocumentation(program, baseType.name)
		let entries: Array<CompletionEntry> = []

		for (let [name, type] of Object.entries(baseType.properties)) {
			entries.push({
				label: name,
				kind: "property",
				detail: printType(type),
				documentation: documented.get(name) ?? null,
				tier: completionTiers.member,
			})
		}

		for (let [name, method] of Object.entries(baseType.methods)) {
			entries.push(
				...callableEntries({
					name,
					kind: methodDeclarationKind(method),
					snippets: qualifiedCallSnippetsFor(name, method),
					detail: printType(method),
					documentation: describe(documentationOf(method)) || null,
					tier: completionTiers.member,
				}),
			)
		}

		return entries
	}

	return []
}

// NOTE: The `§§` block above each Property, keyed by name. A Namespace Type
// keeps only the Property's Type, so this reads the declaration Node instead —
// the probe stops at the cursor, and a Namespace whose members are being
// looked up is necessarily declared above it.
function namespacePropertyDocumentation(
	program: common.typed.Program,
	name: string,
): Map<string, string> {
	let documented = new Map<string, string>()

	function visitBody(nodes: Array<common.typed.ImplementationNode>) {
		for (let node of nodes) {
			if (node.nodeType === "NamespaceDefinitionStatement") {
				if (node.name.content !== name) {
					continue
				}

				for (let [propertyName, property] of Object.entries(
					node.properties,
				)) {
					let description = describe(property.documentation)

					if (description !== "") {
						documented.set(propertyName, description)
					}
				}
			} else if (node.nodeType === "IfStatement") {
				visitBody(node.body)
			} else if (node.nodeType === "IfElseStatement") {
				visitBody(node.trueBody)
				visitBody(node.falseBody)
			} else if (node.nodeType === "FunctionStatement") {
				visitBody(node.value.body)
			}
		}
	}

	for (let body of typedProgramBodies(program)) {
		visitBody(body)
	}

	return documented
}

// NOTE: One entry PER OVERLOAD, all sharing a label — the Overloads of a
// Method differ in exactly the Argument labels the snippet inserts, so a
// single "primary" entry would write the wrong call half the time. The
// signature tail in `labelDetail` is what tells them apart in the list. With
// no signature at all — a half-enriched document, which is the normal state
// while typing — the bare entry is kept and the Editor completes the name.
function callableEntries({
	name,
	kind,
	snippets,
	detail,
	documentation,
	tier,
}: {
	name: string
	kind: CompletionKind
	snippets: Array<CallSnippet> | null
	detail: string | null
	documentation: string | null
	tier: number
}): Array<CompletionEntry> {
	if (snippets === null) {
		return [
			{
				label: name,
				kind,
				detail,
				documentation,
				snippet: null,
				labelDetail: null,
				tier,
			},
		]
	}

	return snippets.map((entry) => ({
		label: name,
		kind,
		detail: entry.signature,
		documentation,
		snippet: entry.snippet,
		labelDetail: snippets.length > 1 ? entry.signature : null,
		tier,
	}))
}

function methodDeclarationKind(method: common.MethodType): DeclarationKind {
	return isStaticMethod(method) ? "staticMethod" : "method"
}

// NOTE: Static Methods take no receiver — they are not invocable through `::`,
// only through `.` on the Namespace itself.
function isStaticMethod(method: common.MethodType): boolean {
	return (
		method.type === "StaticMethod" ||
		method.type === "OverloadedStaticMethod"
	)
}

/*********************/
/* Method completion */
/*********************/

// NOTE: Overlapping Namespaces declare the same Method name — a user
// `for List<Integer>` beside the builtin `for List<ItemType>` — and the one
// listed first is not the one the call resolves to: the Enricher dispatches to
// the most specific target. Completion runs the same shared order per Method
// name so the signature it shows is the signature that will be invoked. A tie
// is left as it is found, the way the Enricher leaves it to be reported.
function mostSpecificMethod(
	namespaces: Array<common.NamespaceType>,
	name: string,
): common.MethodType | undefined {
	let declaring = namespaces.filter((namespace) => {
		let method = namespace.methods[name]

		return method !== undefined && !isStaticMethod(method)
	})

	return filterMostSpecificByTarget(declaring, (namespace) => namespace)[0]
		?.methods[name]
}

function methodCompletions(
	documentText: string,
	baseType: common.Type,
	specifierName: string | null,
	documentPath?: string,
	workspaceNamespaces: Array<{
		offer: WorkspaceOffer
		namespace: common.NamespaceType
	}> = [],
	document: DocumentAnalysis | null = null,
): Array<CompletionEntry> {
	// NOTE: The Namespaces in scope are offered first and the unimported ones
	// after them, so a Method that resolves today wins the name over one that
	// would need an entry added — the same first-wins dedupe, ordered by what
	// costs the reader least.
	let offers = new Map(
		workspaceNamespaces.map(({ offer, namespace }) => [
			namespace.name,
			offer,
		]),
	)
	let inScope = matchingNamespaces(
		documentText,
		baseType,
		specifierName,
		documentPath,
		[],
		document,
	)
	let namespaces = [
		...inScope,
		...matchingNamespaces(
			documentText,
			baseType,
			specifierName,
			documentPath,
			workspaceNamespaces.map((candidate) => candidate.namespace),
			document,
		).filter((namespace) => offers.has(namespace.name)),
	]
	let seen = new Set<string>()
	let entries: Array<CompletionEntry> = []
	// NOTE: One parse for the whole loop. Every offering Namespace wants an
	// import edit built against the document as it is now, which is the same
	// document for all of them — asking for it per offer re-parsed the whole
	// file once per Namespace, on a request the editor fires per keystroke.
	// Lazy, so a completion with no offers at all still parses nothing.
	let importProgram: parser.Program | null = null

	for (let namespace of namespaces) {
		let offer = offers.get(namespace.name)

		if (offer !== undefined && importProgram === null) {
			importProgram = parseDocument(documentText).program
		}

		let importEdit =
			offer === undefined
				? null
				: importEditFor(documentText, importProgram!, offer)

		for (let [name, method] of Object.entries(namespace.methods)) {
			if (isStaticMethod(method)) {
				continue
			}

			if (seen.has(name)) {
				continue
			}

			seen.add(name)

			let resolved = mostSpecificMethod(namespaces, name) ?? method

			entries.push(
				...callableEntries({
					name,
					kind: "method",
					snippets: callSnippetsFor(name, resolved),
					detail:
						offer === undefined
							? printInvokedSignature(resolved)
							: `${printInvokedSignature(resolved)} — ${offer.specifier}`,
					documentation: describe(documentationOf(resolved)) || null,
					tier:
						offer === undefined
							? completionTiers.member
							: completionTiers.workspace,
				}).map((entry) =>
					importEdit === null
						? entry
						: { ...entry, additionalEdits: [importEdit] },
				),
			)
		}
	}

	return entries
}

// NOTE: Built against the document as it is now, like every other edit this
// Server hands out. Null where the block already holds the entry, which is what
// an offer whose name is somehow already bound would produce — the offer is not
// dropped for it, since the Method IS reachable once the entry is there.
function importEditFor(
	documentText: string,
	program: parser.Program,
	offer: WorkspaceOffer,
): ImportEdit | null {
	return insertImportEdit(documentText, program, {
		name: offer.name,
		alias: null,
		specifier: offer.specifier,
	})
}

// NOTE: Inside `::<…>` only Namespaces that could actually disambiguate the
// call are useful — the same set `::` itself draws its Methods from.
function specifierCompletions(
	documentText: string,
	baseType: common.Type,
	documentPath?: string,
	document: DocumentAnalysis | null = null,
): Array<CompletionEntry> {
	let seen = new Set<string>()
	let entries: Array<CompletionEntry> = []

	for (let namespace of matchingNamespaces(
		documentText,
		baseType,
		null,
		documentPath,
		[],
		document,
	)) {
		if (namespace.name === "" || seen.has(namespace.name)) {
			continue
		}

		seen.add(namespace.name)

		entries.push({
			label: namespace.name,
			kind: "namespace",
			detail:
				namespace.targetType === null
					? null
					: printType(namespace.targetType),
			tier: completionTiers.member,
		})
	}

	return entries
}

// NOTE: A Completion's detail is a single line next to its label, so an
// Overload set shows its first signature and counts the rest — Signature Help
// and the Hover are where every Overload is spelled out.
function printInvokedSignature(method: common.MethodType): string {
	return printSignatureSummary(signaturesOf(method) ?? [])
}

/*******************/
/* Case completion */
/*******************/

// NOTE: `#` completion offers the Cases a Case reference could name at the
// cursor. An annotated position (`constant step: Step<Integer, String> = #…`, a
// labelled Argument, a Function's return at `<-`) pins the Choice down to one
// applied Union — its Cases come back instantiated, so the payload detail shows
// the concrete Types. With no such expectation the scan mirrors the Enricher's
// `findCaseTypesInScope`: every Choice in scope offers its declared Cases,
// generic ones (Generic Aliases) included. A written prefix (`Colour#`) narrows
// that scan to the one Choice.
function caseCompletions(
	lines: Array<string>,
	cursor: common.Cursor,
	beforeCursor: string,
	currentLine: string,
	matchIndex: number,
	choicePrefix: string,
	documentPath?: string,
): Array<CompletionEntry> {
	// NOTE: The in-progress `#name` is swapped for a synthetic Case reference so
	// the whole document parses — later Choice declarations stay in view, and
	// the expected Type at the `#` and the Choices in scope both read off one
	// enriched Program.
	let probeLine =
		beforeCursor.slice(0, matchIndex) +
		choicePrefix +
		`#${probeCaseName}` +
		currentLine.slice(cursor.column - 1)
	let probeText = [
		...lines.slice(0, cursor.line - 1),
		probeLine,
		...lines.slice(cursor.line),
	].join("\n")

	let enrichedProgram: common.typed.Program | null = null

	try {
		let { program } = parseDocument(probeText, documentPath)
		enrichedProgram = enrichDocument(program, documentPath, {
			tests: true,
		}).program
	} catch {
		return []
	}

	let { expected, choices } = analyseCaseProbe(enrichedProgram)

	let expectedCases =
		expected !== null && expected.type === "UnionType"
			? flattenUnionMembers(expected).filter(
					(member): member is common.CaseType =>
						member.type === "Case",
				)
			: []

	// NOTE: An expectation names ONE Choice, so the list is complete and
	// ordered as the Choice declared it — the first Case is preselected, which
	// the prefix-less scan over every Choice in scope has no basis for.
	if (expectedCases.length > 0) {
		return caseEntries(expectedCases, true)
	}

	if (choicePrefix !== "") {
		return caseEntries(choices.get(choicePrefix) ?? [])
	}

	return caseEntries([...choices.values()].flat())
}

function caseEntries(
	caseTypes: Array<common.CaseType>,
	preselectFirst = false,
): Array<CompletionEntry> {
	let seen = new Set<string>()
	let entries: Array<CompletionEntry> = []

	for (let caseType of caseTypes) {
		let key = `${caseType.choice}#${caseType.name}`

		if (seen.has(key)) {
			continue
		}

		seen.add(key)

		// NOTE: The `#` is already typed, so the label is the bare Case name —
		// selecting it completes `#name`. The detail spells the payload out, and
		// its `Choice#Case` head tells apart two Choices that share a Case name
		// in the prefix-less scan.
		entries.push({
			label: caseType.name,
			kind: "case",
			detail: printCaseWithPayload(caseType),
			tier: completionTiers.member,
			preselect: preselectFirst && entries.length === 0,
		})
	}

	return entries
}

// NOTE: One pass over the probe's enriched Program: it threads the expected
// Type down to the synthetic Case reference (mirroring `argumentContext`, plus
// a Function's return Type at a `<-`) and, along the way, records every Choice
// declaration's Cases. The expected Type is only meaningful once it reaches the
// probe, so `expected` stays `undefined` until then.
function analyseCaseProbe(program: common.typed.Program): {
	expected: common.Type | null
	choices: Map<string, Array<common.CaseType>>
} {
	let expected: common.Type | null | undefined = undefined
	let choices = new Map<string, Array<common.CaseType>>()

	function visitBody(
		nodes: Array<common.typed.ImplementationNode>,
		expectedType: common.Type | null,
	) {
		for (let node of nodes) {
			visitNode(node, expectedType)
		}
	}

	// NOTE: A default is read against its own Parameter's Type, which is what
	// makes `= #|` inside a Parameter list offer that Parameter's Choice. Walked
	// per Parameter rather than through `parameterDefaults`, because the
	// expected Type is the half of the pair the flat enumeration drops.
	function visitFunction(definition: common.typed.FunctionDefinitionNode) {
		visitDefaults(definition.parameters)
		visitBody(definition.body, definition.returnType)
	}

	function visitDefaults(parameters: Array<common.typed.ParameterNode>) {
		for (let parameter of parameters) {
			if (parameter.defaultValue !== null) {
				visitNode(
					parameter.defaultValue,
					parameter.internalName?.type ??
						parameter.externalName?.type ??
						null,
				)
			}
		}
	}

	function visitArguments(
		nodeArguments: Array<common.typed.ArgumentNode>,
		parameterTypes: common.BaseFunction["parameterTypes"] | null,
	) {
		nodeArguments.forEach((argument, index) => {
			let parameterType = parameterTypes?.[index]?.type ?? null

			visitNode(
				argument.value,
				parameterType !== null && parameterType.type !== "GenericUse"
					? parameterType
					: null,
			)
		})
	}

	function visitNode(
		node: common.typed.ImplementationNode,
		expectedType: common.Type | null,
	) {
		switch (node.nodeType) {
			case "ChoiceDeclarationStatement":
				if (!choices.has(node.name.content)) {
					choices.set(
						node.name.content,
						node.cases.map((choiceCase) => choiceCase.type),
					)
				}

				// NOTE: Read against the payload it fills, which is what makes
				// `= { item = #| }` inside a Case offer that member's Choice.
				// Walked per Case rather than through `caseDefaults`, because
				// the expected Type is the half the flat enumeration drops.
				for (let choiceCase of node.cases) {
					if (choiceCase.defaultValue !== null) {
						visitNode(choiceCase.defaultValue, {
							type: "Record",
							members: choiceCase.type.members,
						})
					}
				}

				return
			case "CaseValue":
				if (node.caseName.content === probeCaseName) {
					expected = expectedType
				}

				if (node.value !== null) {
					visitNode(
						node.value,
						node.type.type === "Case"
							? { type: "Record", members: node.type.members }
							: null,
					)
				}

				return
			case "ConstantDeclarationStatement":
			case "VariableDeclarationStatement":
				visitNode(node.value, node.declaredType ?? node.type)
				return
			case "VariableAssignmentStatement":
				visitNode(node.value, null)
				return
			case "FunctionStatement":
				visitFunction(node.value)
				return
			case "FunctionValue":
				visitFunction(node.value)
				return
			case "NamespaceDefinitionStatement":
				for (let property of Object.values(node.properties)) {
					visitNode(property.value, null)
				}

				for (let member of Object.values(node.methods)) {
					let methods =
						member.nodeType === "OverloadedMethod" ||
						member.nodeType === "OverloadedStaticMethod"
							? member.methods
							: [member.method]

					for (let method of methods) {
						visitFunction(method.value)
					}
				}

				for (let shim of node.nativeShims) {
					visitDefaults(shim.parameters)
				}

				return
			case "IfStatement":
				visitNode(node.condition, null)
				visitBody(node.body, null)
				return
			case "IfElseStatement":
				visitNode(node.condition, null)
				visitBody(node.trueBody, null)
				visitBody(node.falseBody, null)
				return
			case "ReturnStatement":
				visitNode(node.expression, expectedType)
				return
			// NOTE: `expect outcome::is(#|)` offers the Cases of what the
			// Method expects, exactly as a call written anywhere else does.
			case "ExpectStatement":
			case "RequireStatement":
				for (let expression of typedAssertionExpressions(node)) {
					visitNode(expression, null)
				}

				return
			case "FunctionInvocation": {
				let calleeType = node.name.type

				visitNode(node.name, null)
				visitArguments(
					node.arguments,
					calleeType.type === "Function"
						? calleeType.parameterTypes
						: null,
				)
				return
			}
			case "MethodInvocation":
				visitNode(node.base, null)
				visitArguments(node.arguments, null)
				return
			case "Lookup":
				visitNode(node.base, null)
				return
			case "Combination":
				visitNode(node.lhs, expectedType)
				visitNode(node.rhs, expectedType)
				return
			case "Match":
				visitNode(node.value, null)

				for (let handler of node.handlers) {
					for (let expression of typedHandlerExpressions(handler)) {
						visitNode(expression, null)
					}

					visitBody(handler.body, expectedType)
				}

				return
			// NOTE: Every arm's value answers the whole `define`, so each is
			// read against the Type the position expects of it — which is what
			// puts a Choice in reach of a bare `#` in an arm. A Condition is a
			// Boolean and expects nothing of its own, exactly as a Guard does.
			case "Define":
				for (let value of defineValues(node)) {
					visitNode(value, expectedType)
				}

				for (let condition of defineConditions(node)) {
					visitNode(condition, null)
				}

				return
			case "RecordValue":
				// NOTE: Each member is read against the Type the position
				// EXPECTS of it, exactly as a List's items are just above —
				// the literal's own Type says what was written, which for a
				// half-typed `#Sta` is an Error and no Choice at all. It is
				// what gives a `#` standing as a member's value a Choice to
				// offer, in a Case payload's default and in a body alike.
				for (let [name, member] of Object.entries(node.members)) {
					visitNode(
						member,
						expectedType?.type === "Record"
							? (expectedType.members[name] ?? null)
							: null,
					)
				}

				return
			case "ListValue": {
				let itemType =
					expectedType?.type === "List" ? expectedType.itemType : null

				for (let value of node.values) {
					visitNode(value, itemType)
				}

				return
			}
			// NOTE: Each half against the SLOT it stands in, which is what puts
			// a Choice in reach of a bare `#` in either — the Cases of
			// `Dictionary<Suit, Integer>`'s key Type in a key, and of its value
			// Type in a value. The same decision a List's item position makes,
			// twice.
			case "DictionaryValue": {
				let dictionary =
					expectedType?.type === "Dictionary" ? expectedType : null

				for (let entry of node.entries) {
					visitNode(entry.key, dictionary?.keyType ?? null)
					visitNode(entry.value, dictionary?.valueType ?? null)
				}

				return
			}
			case "InterpolatedStringValue":
				for (let segment of node.segments) {
					if (segment.kind === "expression") {
						visitNode(segment.expression, null)
					}
				}

				return
			case "TypeAliasStatement":
			case "ProtocolDeclarationStatement":
			case "Identifier":
			case "Self":
			case "StringValue":
			case "IntegerValue":
			case "RationalValue":
			case "BooleanValue":
				return
		}
	}

	for (let body of typedProgramBodies(program)) {
		visitBody(body, null)
	}

	return { expected: expected ?? null, choices }
}

/********************/
/* Scope completion */
/********************/

// NOTE: Which symbol space an offer belongs in, by what the other Module
// declared it as. A Type Alias, a Choice and a Protocol are only nameable where
// a Type is; everything else is a value. A name bound in both tables at home —
// a `type Foo` beside a `namespace Foo` — is one entry either way, so offering
// it in one space is enough to bring the other along.
const offerSpaces: Record<DeclarationKind, SymbolSpace> = {
	constant: "values",
	variable: "values",
	function: "values",
	parameter: "values",
	namespace: "values",
	protocol: "types",
	type: "types",
	generic: "types",
	method: "values",
	staticMethod: "values",
	property: "values",
	member: "values",
	label: "values",
	import: "values",
}

function scopeCompletions(
	documentText: string,
	cursor: common.Cursor,
	space: SymbolSpace,
	documentPath?: string,
	offers: Array<WorkspaceOffer> = [],
	document: DocumentAnalysis | null = null,
): Array<CompletionEntry> {
	// NOTE: The unmodified document, which is what the Workspace holds parsed,
	// enriched and indexed. Derived here only for a caller that has no Workspace
	// behind it — the same list, at the price this one used to cost every time.
	let program =
		document?.program ?? parseDocument(documentText, documentPath).program
	let enrichedProgram: common.typed.Program | null =
		document?.enrichedProgram ?? null

	if (document === null) {
		try {
			enrichedProgram = enrichDocument(program, documentPath, {
				tests: true,
			}).program
		} catch {}
	}

	let { scopes } = document?.index ?? indexProgram(program, enrichedProgram)
	let scope = scopeAt(scopes, cursor)
	let described =
		enrichedProgram === null
			? new Map<string, DeclarationInfo>()
			: describeDeclarations(enrichedProgram)
	let entries = new Map<string, Array<CompletionEntry>>()

	let searchScope: Scope | null = scope

	while (searchScope !== null) {
		for (let [name, declaration] of searchScope[space]) {
			// NOTE: Constants and Variables do not hoist, so they must not be
			// offered before their declaring Statement — accepting them would
			// produce a Program the Enricher rejects. Skipping an invisible
			// inner Declaration also lets an outer one of the same name
			// through, which is exactly what resolves at that point.
			if (
				declaration.visibleFrom !== null &&
				!isAtOrBefore(declaration.visibleFrom, cursor)
			) {
				continue
			}

			if (entries.has(name)) {
				continue
			}

			// NOTE: The rename index is lexical and knows no Types; the
			// enriched Program has the Types but no Scopes. A Declaration's
			// name Position is what joins the two, and both sides read the
			// same Parser Positions, so the key is exact rather than a range
			// search.
			let info =
				declaration.definition === null
					? null
					: (described.get(positionKey(declaration.definition)) ??
						null)

			// NOTE: Only the top level Scope has no parent, and it holds the
			// builtins beside the document's own top level Declarations — so
			// the depth tells a local apart from a document-wide name, and
			// `builtin` tells the two halves of the top level apart.
			let tier = declaration.builtin
				? completionTiers.builtin
				: searchScope.parent === null
					? completionTiers.document
					: completionTiers.local

			entries.set(name, scopeEntries(name, declaration, info, tier))
		}

		searchScope = searchScope.parent
	}

	// NOTE: After the whole Scope chain, and only for names nothing in it
	// already answers with — an offer that shadows something reachable would
	// insert an entry the Compiler refuses as a duplicate.
	for (let offer of offers) {
		if (entries.has(offer.name) || offerSpaces[offer.kind] !== space) {
			continue
		}

		let edit = insertImportEdit(documentText, program, {
			name: offer.name,
			alias: null,
			specifier: offer.specifier,
		})

		entries.set(offer.name, [
			{
				label: offer.name,
				kind: offer.kind,
				detail: `from ${offer.specifier}`,
				tier: completionTiers.workspace,
				...(edit === null ? {} : { additionalEdits: [edit] }),
			},
		])
	}

	return [...entries.values()].flat()
}

function scopeEntries(
	label: string,
	declaration: Declaration,
	info: DeclarationInfo | null,
	tier: number,
): Array<CompletionEntry> {
	// NOTE: Only a `function` Declaration is invoked by writing its name — a
	// Constant or a Parameter may hold a Function Value just as well, but
	// there the name is as often passed on as it is called, so nothing is
	// inserted for it.
	let snippets =
		declaration.kind === "function" && info?.type != null
			? callSnippetsFor(label, info.type)
			: null

	return callableEntries({
		name: label,
		kind: declaration.kind,
		snippets,
		detail: declarationDetail(label, info?.type ?? null),
		documentation: info?.documentation ?? null,
		tier,
	})
}

// NOTE: A Namespace and a Choice both print as their own name, which the label
// beside the detail already says. A Namespace's target Type is what a single
// line can add instead; a Choice has nothing to add, so it stays bare.
function declarationDetail(
	label: string,
	type: common.Type | null,
): string | null {
	if (type === null) {
		return null
	}

	if (type.type === "Namespace") {
		return type.targetType === null
			? null
			: `for ${printType(type.targetType)}`
	}

	let printed = printType(type)

	return printed === label ? null : printed
}

type DeclarationInfo = {
	type: common.Type | null
	documentation: string | null
}

// NOTE: Every Declaration the enriched Program can say something about, keyed
// by where its name was written. Kept deliberately close to the rename index's
// own idea of a Declaration: the same Statements, plus the Parameters that
// only a Function's inner Scope offers.
function describeDeclarations(
	program: common.typed.Program,
): Map<string, DeclarationInfo> {
	let described = new Map<string, DeclarationInfo>()

	function describeAt(position: common.Position, info: DeclarationInfo) {
		described.set(positionKey(position), info)
	}

	function visitFunction(
		definition: common.typed.FunctionDefinitionNode,
		documentation: common.Documentation | null,
	) {
		for (let [index, parameter] of definition.parameters.entries()) {
			let info: DeclarationInfo = {
				type:
					parameter.internalName?.type ??
					parameter.externalName?.type ??
					null,
				// NOTE: A Parameter's `@param` text lives on the enclosing
				// callable's `§§` block, on the line standing at the
				// Parameter's own position.
				documentation: documentation?.parameters[index]?.text ?? null,
			}

			if (parameter.externalName !== null) {
				describeAt(parameter.externalName.position, info)
			}

			if (parameter.internalName !== null) {
				describeAt(parameter.internalName.position, info)
			}
		}

		visitBody(definition.body)
	}

	function visitBody(nodes: Array<common.typed.ImplementationNode>) {
		for (let node of nodes) {
			visitNode(node)
		}
	}

	function visitArguments(nodeArguments: Array<common.typed.ArgumentNode>) {
		for (let argument of nodeArguments) {
			visitNode(argument.value)
		}
	}

	function visitNode(node: common.typed.ImplementationNode) {
		switch (node.nodeType) {
			case "ConstantDeclarationStatement":
			case "VariableDeclarationStatement":
				describeAt(node.name.position, {
					type: node.declaredType ?? node.type,
					documentation: describe(node.documentation) || null,
				})
				visitNode(node.value)
				return
			case "FunctionStatement": {
				let documentation = documentationOf(node.type)

				describeAt(node.name.position, {
					type: node.type,
					documentation: describe(documentation) || null,
				})
				visitFunction(node.value, documentation)
				return
			}
			case "NamespaceDefinitionStatement":
				describeAt(node.name.position, {
					type: node.type,
					documentation: describe(node.documentation) || null,
				})

				for (let property of Object.values(node.properties)) {
					visitNode(property.value)
				}

				for (let member of Object.values(node.methods)) {
					let methods =
						member.nodeType === "OverloadedMethod" ||
						member.nodeType === "OverloadedStaticMethod"
							? member.methods
							: [member.method]

					for (let method of methods) {
						visitFunction(
							method.value,
							documentationOf(method.type),
						)
					}
				}

				return
			case "ChoiceDeclarationStatement":
			case "TypeAliasStatement":
				describeAt(node.name.position, {
					type: node.type,
					documentation: describe(node.documentation) || null,
				})
				return
			case "ProtocolDeclarationStatement":
				describeAt(node.name.position, {
					type: null,
					documentation:
						describe(node.protocolType.documentation ?? null) ||
						null,
				})
				return
			case "FunctionValue":
				visitFunction(node.value, null)
				return
			case "VariableAssignmentStatement":
				visitNode(node.value)
				return
			case "ReturnStatement":
				visitNode(node.expression)
				return
			case "ExpectStatement":
			case "RequireStatement":
				for (let expression of typedAssertionExpressions(node)) {
					visitNode(expression)
				}

				return
			case "IfStatement":
				visitNode(node.condition)
				visitBody(node.body)
				return
			case "IfElseStatement":
				visitNode(node.condition)
				visitBody(node.trueBody)
				visitBody(node.falseBody)
				return
			case "FunctionInvocation":
				visitNode(node.name)
				visitArguments(node.arguments)
				return
			case "MethodInvocation":
				visitNode(node.base)
				visitArguments(node.arguments)
				return
			case "Lookup":
				visitNode(node.base)
				return
			case "Combination":
				visitNode(node.lhs)
				visitNode(node.rhs)
				return
			case "Match":
				visitNode(node.value)

				for (let handler of node.handlers) {
					for (let expression of typedHandlerExpressions(handler)) {
						visitNode(expression)
					}

					visitBody(handler.body)
				}

				return
			case "Define":
				for (let expression of defineExpressions(node)) {
					visitNode(expression)
				}

				return
			case "RecordValue":
				for (let member of Object.values(node.members)) {
					visitNode(member)
				}

				return
			case "ListValue":
				for (let value of node.values) {
					visitNode(value)
				}

				return
			case "DictionaryValue":
				for (let entry of node.entries) {
					visitNode(entry.key)
					visitNode(entry.value)
				}

				return
			case "InterpolatedStringValue":
				for (let segment of node.segments) {
					if (segment.kind === "expression") {
						visitNode(segment.expression)
					}
				}

				return
			case "CaseValue":
				if (node.value !== null) {
					visitNode(node.value)
				}

				return
			case "Identifier":
			case "Self":
			case "StringValue":
			case "IntegerValue":
			case "RationalValue":
			case "BooleanValue":
				return
		}
	}

	for (let body of typedProgramBodies(program)) {
		visitBody(body)
	}

	return described
}

function positionKey(position: common.Position): string {
	return `${position.start.line}:${position.start.column}`
}

/**********************/
/* Reading the cursor  */
/**********************/

// NOTE: The Parser only ever reads a Type after one of these: a `:`
// annotation, a `->` return, a `<` Generic application, an `is` bound or
// conformance clause, or a `|` — `parseType` is the only place a Pipe is
// consumed at all, so one can never be anything else.
//
// A trailing `,` says nothing on its own, since it separates Arguments as
// readily as Type Arguments; the bracket it sits inside decides. A Generic
// DECLARATION list (`<infer Value is Comparable>`) is read as one too, so a
// comma there offers Types where the Parser wants a Type Parameter — the same
// approximation a bare `<` has always made.
function detectSymbolSpace(headText: string): SymbolSpace {
	let stripped = stripNoise(headText)
	let trimmed = lastLineOf(stripped).replace(identifierTail, "").trimEnd()

	if (
		trimmed.endsWith(":") ||
		trimmed.endsWith("->") ||
		trimmed.endsWith("<") ||
		trimmed.endsWith("|") ||
		trailingIsPattern.test(trimmed)
	) {
		return "types"
	}

	if (trimmed.endsWith(",") && innermostOpener(stripped) === "<") {
		return "types"
	}

	return "values"
}

// NOTE: The bracket the cursor is innermost inside. A `<` counts as one only
// where the Parser reads it as a bracket — a Generic application or a Generic
// list opens directly against the name it belongs to, so a `<` with anything
// else before it is the `<-` of a return or the `::<` of a Namespace
// specifier. For the same reason a `>` closes only a `<` that was counted,
// leaving the `>` of a `->` alone.
function innermostOpener(text: string): string | null {
	let stack: Array<string> = []
	let previous = ""

	for (let character of text) {
		if (character === "(" || character === "[" || character === "{") {
			stack.push(character)
		} else if (
			character === ")" ||
			character === "]" ||
			character === "}"
		) {
			stack.pop()
		} else if (character === "<" && identifierCharacter.test(previous)) {
			stack.push(character)
		} else if (character === ">" && stack[stack.length - 1] === "<") {
			stack.pop()
		}

		previous = character
	}

	return stack[stack.length - 1] ?? null
}

// NOTE: Statement start is read off the text alone — nothing but a block
// boundary before the cursor on its line. Everything else is inside an
// Expression: the value half of a declaration, an Argument, a `<-`.
//
// NOTE: No legality analysis happens here. `static` is only meaningful in a
// Namespace body, `overload` only in a `declarations` Program, `implementation`
// only at the very top, and none of that is checked. A Keyword offered where it
// will not parse costs one Parser Diagnostic on the next keystroke; the
// alternative is a second, approximate model of where each Keyword may stand,
// which would be wrong in subtler ways.
function keywordCompletions(headText: string): Array<CompletionEntry> {
	let trimmed = lastLineOf(stripNoise(headText))
		.replace(identifierTail, "")
		.trimEnd()
	let atStatementStart =
		trimmed === "" || trimmed.endsWith("{") || trimmed.endsWith("}")

	return (atStatementStart ? statementKeywords : expressionKeywords).map(
		(keyword) => ({
			label: keyword,
			kind: "keyword" as const,
			detail: null,
			tier: completionTiers.keyword,
		}),
	)
}

function lastLineOf(text: string): string {
	return text.slice(text.lastIndexOf("\n") + 1)
}

function scopeAt(scopes: Array<ScopeRange>, cursor: common.Cursor): Scope {
	let best: ScopeRange | null = null

	for (let candidate of scopes) {
		if (candidate.range !== null && !contains(candidate.range, cursor)) {
			continue
		}

		if (
			best === null ||
			best.range === null ||
			(candidate.range !== null && isSmaller(candidate.range, best.range))
		) {
			best = candidate
		}
	}

	return (best ?? scopes[0]).scope
}
