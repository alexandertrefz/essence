import type { common, parser } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../diagnostics/index"
import { closestMatch } from "../helpers/index"

// NOTE: What a `test` and a `suite` may be Modified BY, and what each of those
// Modifiers means. The Parser reads a Modifier generically — a name and the
// arguments that follow it — so that `within 2s` and `retries 3` are
// vocabulary rather than parser work; this file is the vocabulary.

// #region Modifiers

// NOTE: The three Modifiers phase 1 knows, in the order a Diagnostic lists
// them. `across` and `for any` are not Modifiers: they take a body's shape
// apart rather than annotating it, and they come after the Modifiers.
const MODIFIERS = ["focused", "skipped", "tagged"] as const

// NOTE: The Modifiers that take bare names, which is what `regrouped` is about.
const NAME_TAKING_MODIFIERS = new Set<string>(["tagged"])

// NOTE: What the Modifiers of one item established, once. Every field is what
// the ITEM answers for: `mergedModifiers` folds an enclosing suite's in, so a
// test inside a skipped suite is skipped and carries the suite's tags.
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

// NOTE: Read off the Parser's Nodes and reported about here, so that everything
// downstream — the Enricher's own walk, code generation, the Language Server —
// reads three settled fields rather than a list of names it has to interpret.
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

// NOTE: An item's own Modifiers over the ones covering it. A suite's cover
// every test inside it, and the covering ones lose to the item's own only where
// the item wrote its own — `skipped` on a suite skips a test that says nothing,
// and a test can not un-skip itself, which is why `skipped` falls back rather
// than being overridden.
export function mergedModifiers(
	own: TestModifiers,
	covering: TestModifiers,
): TestModifiers {
	return {
		// NOTE: Outermost first and without repeats, so that two Programs that
		// carry the same tags carry them in the same order.
		tags: [...new Set([...covering.tags, ...own.tags])],
		skipped: own.skipped ?? covering.skipped,
		focused: own.focused ?? covering.focused,
	}
}

// NOTE: `tagged slow focused` is read by the Parser as `tagged` taking nothing
// and `slow` taking `focused`, and it has to be: a Modifier's argument list
// opens on a bare name only where a comma or the body follows it, because
// `A B C {` is otherwise two readings with nothing to settle them. The Parser
// fails OPEN, which is what leaves this regrouping possible — the vocabulary is
// here, and every Position is in hand.
//
// Two moves, and neither touches a Modifier the Parser got right. A bare name
// that IS a Modifier, or looks like one, is taken back out of the argument list
// it was read into; a bare name that is neither is handed to the `tagged` in
// front of it. `tagged slow focussed` therefore reports the typo instead of
// quietly making it a tag — which is the whole reason the near-miss test is in
// here, and the reason a comma settles everything: `tagged focused, network` is
// two tags and is left exactly as it was read.
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

// NOTE: A Modifier read as taking ONE bare name that names a Modifier is two
// Modifiers, because no Modifier takes another one as an argument. Anything
// with a comma in it was read unambiguously and is left alone.
function split(
	modifier: parser.TestModifierNode,
): Array<parser.TestModifierNode> {
	let [only] = modifier.arguments

	if (
		modifier.arguments.length !== 1 ||
		only === undefined ||
		only.nodeType !== "Identifier" ||
		!namesAModifier(only.content)
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

// NOTE: A Modifier that takes bare names and was written with none takes the
// next bare name — as long as that name is not a Modifier, and does not look
// enough like one to be a typo of it.
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

function namesAModifier(name: string): boolean {
	return (
		MODIFIERS.includes(name as (typeof MODIFIERS)[number]) ||
		closestMatch(name, [...MODIFIERS]) !== null
	)
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

		// NOTE: Lower case because a tag is typed on a command line and matched
		// exactly there. Two spellings of one tag are two tags, and the one
		// nobody selects is the one that quietly stops running.
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

function refuseArgument(
	argument: parser.TestModifierArgumentNode,
	modifier: string,
	wanted: string,
	note: string,
): void {
	reportError(`'${modifier}' takes ${wanted}`, argument.position, {
		code: "malformed-modifier",
		labels: [primary(argument.position, `this is not ${wanted}`)],
		notes: [note],
		helps: [`Write ${wanted} here.`],
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

// NOTE: A test's name as it was WRITTEN, which is what its identity is keyed
// on. The rendered name is worked out per run — a table test's says which row
// it ran for — so nothing durable can be keyed on it: a stored snapshot, a
// counterexample, a timing baseline and the Editor's own focus all have to
// survive a name that renders differently every time.
//
// An interpolation that names something keeps the name, because that is what a
// reader recognises the test by; anything worked out reduces to `{}`, because
// there is no spelling of an Expression here that is stable and short.
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

// NOTE: One string standing for a whole identity, for the places that need a
// key rather than the parts — a Map, an event's `id`, a snapshot file's
// heading. `/` separates the steps and is escaped inside them, so that two
// different identities can never spell the same key.
export function testIdentityKey(identity: common.typed.TestIdentity): string {
	return [identity.modulePath ?? "", ...identity.suitePath, identity.name]
		.map((step) => step.replaceAll("\\", "\\\\").replaceAll("/", "\\/"))
		.join("/")
}

// NOTE: Two tests of one suite that are called the same thing are one test
// twice as far as everything durable is concerned — they share an identity, so
// they share a snapshot, a baseline and a stored counterexample. Reported per
// scope, and per KIND: a test and a suite of one name never collide, because
// what a suite contributes to an identity is a step of the path rather than
// its end.
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
