import type { common, parser } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../diagnostics/index"
import {
	describeType,
	recordMismatchEvidence,
	withArticle,
} from "../helpers/describe"
import { closestMatch } from "../helpers/suggest"
import { flattenUnionMembers } from "../helpers/types"

// The Modifiers of a `test` and a `suite`, and what each means. The parser
// reads any Modifier as a name and its arguments; this file is the vocabulary.

// #region Modifiers

// The Modifiers, in the order a Diagnostic lists them. `across` and
// `for any` shape a body rather than annotate it, so they are not Modifiers.
const MODIFIERS = ["focused", "skipped", "tagged"] as const

// The Modifiers that take bare names, which is what `regrouped` is about.
const NAME_TAKING_MODIFIERS = new Set<string>(["tagged"])

// What the Modifiers of one item established. `mergedModifiers` folds in an
// enclosing suite's, so a test inside a skipped suite is skipped too.
export type TestModifiers = {
	tags: Array<string>
	skipped: common.typed.TestSkip | null
	focused: common.Position | null
}

export const noModifiers: TestModifiers = {
	tags: [],
	skipped: null,
	focused: null,
}

// Settles the Modifiers into three fields, reporting here, so later stages
// need not interpret a list of names.
export function resolveTestModifiers(
	modifiers: Array<parser.TestModifierNode>,
	item: "test" | "suite",
): TestModifiers {
	let tags: Array<string> = []
	let skipped: common.typed.TestSkip | null = null
	let focused: common.Position | null = null
	let seen = new Map<string, common.Position>()

	for (let modifier of regrouped(modifiers)) {
		let name = modifier.name.content
		let first = seen.get(name)

		if (first !== undefined) {
			reportError(`This ${item} is '${name}' twice`, modifier.position, {
				code: "duplicate-modifier",
				labels: [
					primary(modifier.position, "written again here"),
					secondary(first, "already written here"),
				],
				notes: [
					`A Modifier says something about the whole ${item}, so saying it twice can only ever repeat it or contradict it.`,
				],
				helps: [
					name === "tagged"
						? "Write every tag on one 'tagged', separated by commas."
						: "Remove one of them.",
				],
			})

			continue
		}

		seen.set(name, modifier.position)

		switch (name) {
			case "focused":
				refuseArguments(modifier, item)
				focused = modifier.position

				break
			case "skipped":
				skipped = resolveSkipReason(modifier, item)

				break
			case "tagged":
				tags = resolveTags(modifier)

				break
			default:
				refuseUnknownModifier(modifier, item)
		}
	}

	if (skipped !== null && focused !== null) {
		reportError(`This ${item} is skipped and focused`, focused, {
			code: "contradictory-modifiers",
			labels: [
				primary(focused, "this asks for it to run, and alone"),
				secondary(skipped.position, "this asks for it never to run"),
			],
			notes: [
				"Which of the two was meant is not something the source says, and guessing at it is how a test nobody watches stops running.",
			],
			helps: ["Remove whichever one you did not mean."],
		})
	}

	return { tags, skipped, focused }
}

// An item's own Modifiers over those of the suites covering it. An item's own
// wins where it wrote one, so a test can not un-skip itself.
export function mergedModifiers(
	own: TestModifiers,
	covering: TestModifiers,
): TestModifiers {
	return {
		// Outermost first and without repeats, so the order is stable.
		tags: [...new Set([...covering.tags, ...own.tags])],
		skipped: own.skipped ?? covering.skipped,
		focused: own.focused ?? covering.focused,
	}
}

// The parser reads `tagged slow focused` as `tagged`, then `slow` taking
// `focused`: a bare argument opens only before a comma, the body, `for` or
// `across`. This regroups with the vocabulary in hand. A name that is or looks
// like a Modifier leaves the argument list; any other joins the `tagged`
// before it. So `tagged slow focussed` reports the typo.
function regrouped(
	modifiers: Array<parser.TestModifierNode>,
): Array<parser.TestModifierNode> {
	let grouped: Array<parser.TestModifierNode> = []

	for (let modifier of modifiers) {
		for (let part of split(modifier)) {
			let previous = grouped[grouped.length - 1]

			if (previous !== undefined && adopts(previous, part)) {
				grouped[grouped.length - 1] = {
					...previous,
					arguments: [part.name],
					position: {
						start: previous.position.start,
						end: part.position.end,
					},
				}

				continue
			}

			grouped.push(part)
		}
	}

	return grouped
}

// A Modifier read as taking one bare name that is a Modifier is two
// Modifiers. A near miss splits only under a head that is no Modifier, so
// `tagged focus` stays a test tagged `focus`. An argument list with a comma
// is never split.
function split(
	modifier: parser.TestModifierNode,
): Array<parser.TestModifierNode> {
	let [only] = modifier.arguments

	if (
		modifier.arguments.length !== 1 ||
		only === undefined ||
		only.nodeType !== "Identifier" ||
		!(
			isModifier(only.content) ||
			(!isModifier(modifier.name.content) && namesAModifier(only.content))
		)
	) {
		return [modifier]
	}

	return [
		{
			...modifier,
			arguments: [],
			position: {
				start: modifier.position.start,
				end: modifier.name.position.end,
			},
		},
		{
			nodeType: "TestModifier",
			name: only,
			arguments: [],
			position: only.position,
		},
	]
}

// A Modifier that takes bare names and was written with none takes the next
// bare name, unless that name is or looks like a Modifier.
function adopts(
	previous: parser.TestModifierNode,
	modifier: parser.TestModifierNode,
): boolean {
	return (
		NAME_TAKING_MODIFIERS.has(previous.name.content) &&
		previous.arguments.length === 0 &&
		modifier.arguments.length === 0 &&
		!namesAModifier(modifier.name.content)
	)
}

function isModifier(name: string): boolean {
	return MODIFIERS.includes(name as (typeof MODIFIERS)[number])
}

function namesAModifier(name: string): boolean {
	return isModifier(name) || closestMatch(name, [...MODIFIERS]) !== null
}

function resolveSkipReason(
	modifier: parser.TestModifierNode,
	item: "test" | "suite",
): common.typed.TestSkip | null {
	let [reason, ...rest] = modifier.arguments

	if (reason === undefined) {
		reportError(
			`This ${item} is skipped for no stated reason`,
			modifier.position,
			{
				code: "skipped-without-reason",
				labels: [primary(modifier.position, "this needs a reason")],
				notes: [
					"A skip with no reason rots silently. A skip with one is a note the report repeats on every run, until somebody acts on it.",
				],
				helps: [
					`Write it as a String: skipped "waiting on the Table redesign".`,
				],
			},
		)

		return null
	}

	if (reason.nodeType !== "StringValue") {
		refuseArgument(
			reason,
			"skipped",
			"a String saying why",
			"The reason is what the report repeats on every run, so it is written for whoever reads that report.",
		)

		return null
	}

	for (let extra of rest) {
		refuseArgument(
			extra,
			"skipped",
			"one reason and nothing else",
			"A test is skipped for one reason. Two of them is two skips.",
			"Remove the extra reason — 'skipped' carries one.",
		)
	}

	return { reason: reason.value, position: modifier.position }
}

function resolveTags(modifier: parser.TestModifierNode): Array<string> {
	if (modifier.arguments.length === 0) {
		reportError("This is tagged with nothing", modifier.position, {
			code: "malformed-modifier",
			labels: [primary(modifier.position, "this names no tag")],
			notes: [
				"A tag is what the command line selects on — 'essence test --tag slow' — so a 'tagged' naming none selects nothing.",
			],
			helps: ["Write the tags after it: tagged slow, network."],
		})

		return []
	}

	let tags: Array<string> = []

	for (let argument of modifier.arguments) {
		if (argument.nodeType !== "Identifier") {
			refuseArgument(
				argument,
				"tagged",
				"a bare name",
				"A tag is written the way it is typed on a command line — 'essence test --tag slow' — so it is a name rather than a value.",
			)

			continue
		}

		// A tag is matched exactly on the command line, so lower case
		// keeps one tag from having two spellings.
		if (argument.content !== argument.content.toLowerCase()) {
			reportError(
				`The tag '${argument.content}' is not lower case`,
				argument.position,
				{
					code: "malformed-modifier",
					labels: [
						primary(argument.position, "this has a capital in it"),
					],
					notes: [
						"A tag is matched exactly by '--tag' and '--skip-tag', so two spellings of one tag are two tags.",
					],
					helps: [`Write it as '${argument.content.toLowerCase()}'.`],
				},
			)

			continue
		}

		if (tags.includes(argument.content)) {
			continue
		}

		tags.push(argument.content)
	}

	return tags
}

function refuseArguments(
	modifier: parser.TestModifierNode,
	item: "test" | "suite",
): void {
	for (let argument of modifier.arguments) {
		reportError(
			`'${modifier.name.content}' takes nothing`,
			argument.position,
			{
				code: "malformed-modifier",
				labels: [primary(argument.position, "nothing reads this")],
				notes: [
					`'${modifier.name.content}' says one thing about the ${item}, and says all of it by being written.`,
				],
				helps: ["Remove it."],
			},
		)
	}
}

// `help` replaces the template where writing a value would be wrong, such as
// on a second reason, where the edit is a deletion.
function refuseArgument(
	argument: parser.TestModifierArgumentNode,
	modifier: string,
	wanted: string,
	note: string,
	help?: string,
): void {
	reportError(`'${modifier}' takes ${wanted}`, argument.position, {
		code: "malformed-modifier",
		labels: [primary(argument.position, `this is not ${wanted}`)],
		notes: [note],
		helps: [help ?? `Write ${wanted} here.`],
	})
}

function refuseUnknownModifier(
	modifier: parser.TestModifierNode,
	item: "test" | "suite",
): void {
	let name = modifier.name.content
	let suggestion = closestMatch(name, [...MODIFIERS])
	let notes = [
		`A ${item} takes ${MODIFIERS.map((entry) => `'${entry}'`).join(", ")}.`,
	]

	if (suggestion === null) {
		reportError(`There is no Modifier '${name}'`, modifier.name.position, {
			code: "unknown-modifier",
			labels: [primary(modifier.name.position, "no such Modifier")],
			notes,
			helps: [
				"Remove it, or move what it was meant to say into the body — a Modifier is what the runner reads, never what the test does.",
			],
		})

		return
	}

	reportError(`There is no Modifier '${name}'`, modifier.name.position, {
		code: "unknown-modifier",
		labels: [primary(modifier.name.position, "no such Modifier")],
		notes,
		helps: [`Did you mean '${suggestion}'?`],
		data: { kind: "suggestion", suggestion },
	})
}

// #endregion

// #region Identity

// A test's name as written, which its identity is keyed on. The rendered
// name differs per run, as a table row's does. An interpolated Identifier
// keeps its name, and any other interpolation reduces to `{}`.
export function nameTemplate(
	node: parser.StringValueNode | parser.InterpolatedStringValueNode,
): string {
	if (node.nodeType === "StringValue") {
		return node.value
	}

	return node.segments
		.map((segment) =>
			segment.kind === "text"
				? segment.value
				: segment.expression.nodeType === "Identifier"
					? `{${segment.expression.content}}`
					: "{}",
		)
		.join("")
}

// One string standing for a whole identity. `/` separates the steps and is
// escaped inside them, so two identities never spell the same key.
export function testIdentityKey(
	identity: common.typed.TestIdentity,
	row: number | null = null,
): string {
	return identityKey([
		identity.modulePath ?? "",
		...identitySteps(identity, row),
	])
}

// The same key without the Module step, for stores kept beside the source,
// such as a benchmark baseline. A moved Module then keeps its keys. A table
// row's key ends with its row, so the rows do not overwrite one entry.
export function relativeIdentityKey(
	identity: common.typed.TestIdentity,
	row: number | null = null,
): string {
	return identityKey(identitySteps(identity, row))
}

function identitySteps(
	identity: common.typed.TestIdentity,
	row: number | null,
): Array<string> {
	return [
		...identity.suitePath,
		identity.name,
		...(row === null ? [] : [String(row)]),
	]
}

function identityKey(steps: Array<string>): string {
	return steps
		.map((step) => step.replaceAll("\\", "\\\\").replaceAll("/", "\\/"))
		.join("/")
}

// The enricher fills the suites `examples` and `contracts` itself. A written
// suite of either name would share their identity and what it anchors, so it
// is refused where the synthesis happens.
export function refuseReservedSuite(
	nodes: Array<parser.TestsNode>,
	name: string,
	fills: string,
): boolean {
	let taken = false

	for (let node of nodes) {
		if (node.nodeType !== "Suite" || nameTemplate(node.name) !== name) {
			continue
		}

		taken = true
		reportError(
			`The suite name '${name}' is taken by ${fills}`,
			node.name.position,
			{
				code: "reserved-suite-name",
				labels: [
					primary(
						node.name.position,
						"this names the synthesized suite",
					),
				],
				notes: [
					`Under this compile the Enricher fills a suite called '${name}' with ${fills}, and two suites of one name share everything their identity anchors — stored counterexamples, seeds, and the Editor's focus.`,
				],
				helps: ["Call this suite something else."],
			},
		)
	}

	return taken
}

// Every row is written whole in the table, so a default on the row Parameter
// would never be read.
export function refuseTableDefaults(node: parser.TestTableNode): void {
	for (let parameter of node.parameters) {
		if (parameter.defaultValue === null) {
			continue
		}

		reportError(
			"A table Parameter takes no default",
			parameter.defaultValue.position,
			{
				code: "table-parameters",
				labels: [
					primary(
						parameter.defaultValue.position,
						"this value is never used",
					),
					secondary(
						node.keywordPosition,
						"every row is written here",
					),
				],
				notes: [
					"Each item of the List is one whole row, so no row leaves its value out for a default to fill in.",
				],
				helps: [
					"Remove the default, and write every value a row needs in the row itself.",
				],
			},
		)
	}
}

export function reportPropertyParameters(
	position: common.Position,
	message: string,
	label: string,
	help: string,
	note?: string,
): void {
	reportError(message, position, {
		code: "property-parameters",
		labels: [primary(position, label)],
		notes: note === undefined ? [] : [note],
		helps: [help],
	})
}

// Two tests of one name in one suite share an identity, and with it every
// stored snapshot and baseline. A test and a suite of one name never collide,
// because a suite is a step of the path rather than its end.
export function refuseDuplicateNames(nodes: Array<parser.TestsNode>): void {
	let seen = new Map<string, common.Position>()

	for (let node of nodes) {
		if (node.nodeType !== "Test" && node.nodeType !== "Suite") {
			continue
		}

		let name = nameTemplate(node.name)
		let key = `${node.nodeType} ${name}`
		let first = seen.get(key)
		let item = node.nodeType === "Test" ? "test" : "suite"

		if (first === undefined) {
			seen.set(key, node.name.position)

			continue
		}

		reportError(
			`There is already a ${item} called '${name}' here`,
			node.name.position,
			{
				code: "duplicate-test-name",
				labels: [
					primary(node.name.position, "this name is taken"),
					secondary(first, `the other ${item} is here`),
				],
				notes: [
					`What a ${item} is called, together with the suites around it, is what identifies it — to a snapshot, to a stored counterexample, and to the Editor.`,
				],
				helps: [
					"Say what each of them proves, so that a report names the one that failed.",
				],
			},
		)
	}
}

// #endregion

// #region Assertions

// The questions `expect-not-boolean` offers, each a Method an assertion asks
// of a value, with whether it takes a second value of the same Type. Only the
// enricher can tell which ones the value's Type answers, so it notes them here
// for the validator, which reports the refusal.
export const ASSERTION_QUESTIONS = [
	{ method: "is", comparing: true, spelling: "'::is(…)'" },
	{
		method: "isGreaterThan",
		comparing: true,
		spelling: "'::isGreaterThan(…)'",
	},
	{ method: "hasItems", comparing: false, spelling: "'::hasItems()'" },
]

let answeredQuestions = new WeakMap<
	common.typed.ExpressionNode,
	Array<string>
>()

export function noteAssertionQuestions(
	value: common.typed.ExpressionNode,
	answered: Array<string>,
): void {
	answeredQuestions.set(value, answered)
}

// The questions the value answers, and the `require` line that takes it apart
// by its first Case where it holds one. A value the enricher never asked is
// offered every question.
export function expectNotBooleanHelps(
	value: common.typed.ExpressionNode,
): Array<string> {
	let questions =
		answeredQuestions.get(value) ??
		ASSERTION_QUESTIONS.map((question) => question.spelling)
	let taking = takingItApart(value)

	return [
		questions.length === 0
			? `Write a Boolean Expression in its place — what it holds answers none of ${ASSERTION_QUESTIONS.slice(
					0,
					-1,
				)
					.map((question) => question.spelling)
					.join(", ")} and ${ASSERTION_QUESTIONS.at(-1)?.spelling}.`
			: `Ask a question of it: ${questions.join(", ")}.`,
		...(taking === null ? [] : [taking]),
	]
}

// A name is spelled back, anything else as `…`.
function takingItApart(value: common.typed.ExpressionNode): string | null {
	let members =
		value.type.type === "UnionType"
			? flattenUnionMembers(value.type)
			: [value.type]
	let first = members.find((member) => member.type === "Case")

	if (first === undefined || first.type !== "Case") {
		return null
	}

	let matcher =
		Object.keys(first.members).length === 0
			? `#${first.name}`
			: `#${first.name}(…)`
	let named = value.nodeType === "Identifier" ? value.content : "…"

	return `Or take it apart instead: 'require ${matcher} = ${named}'.`
}

// #endregion

// Reported once per row, since every row is a test of its own.
export function reportRowTypeMismatch(
	row: common.typed.ExpressionNode,
	declaredType: common.Type,
	nameReadsTheRow: boolean,
): void {
	let record = recordMismatchEvidence(declaredType, row.type, row, {
		subject: "the row Parameter's Type",
	})

	reportError(
		"This row does not fit the row Parameter",
		record.lead?.position ?? row.position,
		{
			code: "table-row-type-mismatch",
			labels: [
				record.lead ??
					primary(
						row.position,
						`this is ${withArticle(describeType(row.type))}`,
					),
				...record.labels,
			],
			notes: [
				`The row Parameter is declared as ${describeType(
					declaredType,
				)}, and that is the Type the body — and an interpolated name — reads every row under.`,
				...record.notes,
			],
			helps: [
				...record.helps,
				`Write a row of Type ${describeType(
					declaredType,
				)}, or widen the row Parameter's Type to one this row is a value of${
					nameReadsTheRow
						? " — a widened Type has to stay Printable, since this test's name interpolates the row"
						: ""
				}.`,
			],
			data: record.data,
		},
	)
}
