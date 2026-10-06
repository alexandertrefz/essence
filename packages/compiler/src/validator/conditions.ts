import type { common, enricher } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import {
	asynchronyHelps,
	barredCompletion,
	describeType,
	displayChoiceName,
	displayProtocolName,
	type Spelling,
	spellMatcher,
	spellShape,
	spellType,
	withArticle,
} from "../helpers/describe"

type Waiting = {
	// Whether the body around the Condition may write `complete`.
	canWait: boolean
	barrier: enricher.CompletionBarrier | null
	spell: Spelling
}

// Every Condition must be a Boolean, since Essence has no truthiness. A Help
// is offered only where it spells a question that compiles, and every answer
// a value gives is asked through `questionFor`.
export function reportConditionNotBoolean(
	condition: common.typed.ExpressionNode,
	description: string,
	waiting: Waiting,
): void {
	reportError(`${description} has to be a Boolean`, condition.position, {
		code: "condition-not-boolean",
		labels: [
			primary(
				condition.position,
				`this is ${withArticle(describeType(condition.type))}`,
			),
		],
		notes: [
			"Essence has no truthiness — only a Boolean can be a Condition.",
		],
		helps: conditionHelps(condition, waiting),
	})
}

function conditionHelps(
	condition: common.typed.ExpressionNode,
	waiting: Waiting,
): Array<string> {
	let type = condition.type

	if (type.type === "Future" || type.type === "Started") {
		return waitingHelps(type, type.valueType, waiting)
	}

	if (type.type === "Function" || type.type === "StaticMethod") {
		return callHelps(condition, type, waiting.spell)
	}

	let members = unionMembers(type, waiting.spell)

	if (members !== null) {
		return matchHelps(condition, members, waiting.spell)
	}

	let question = questionFor(type, waiting.spell)

	return question === null
		? []
		: [
				`Ask a question that answers a Boolean — '::${question}' reads ${withArticle(describeType(type))}.`,
			]
}

// A Function is a value with nothing to ask, so it is called, and what it
// answers is asked.
function callHelps(
	condition: common.typed.ExpressionNode,
	type: common.FunctionType | common.StaticMethodType,
	spell: Spelling,
): Array<string> {
	let call = `${calleeSpelling(condition)}(${type.parameterTypes.length === 0 ? "" : "…"})`
	let answer = type.returnType

	if (answer.type === "Boolean") {
		return [`Call it — '${call}' answers a Boolean.`]
	}

	let question =
		answer.type === "GenericUse" ? null : questionFor(answer, spell)

	return question === null
		? []
		: [
				`Call it, and ask a question of what it answers — '${call}::${question}' reads ${withArticle(describeType(answer))}.`,
			]
}

// The callee as written, such as `checks.ready`, or nothing where it is no
// name or chain of member reads.
function calleeSpelling(node: common.typed.ExpressionNode): string {
	if (node.nodeType === "Identifier") {
		return node.content
	}

	if (node.nodeType === "Lookup") {
		let base = calleeSpelling(node.base)

		return base === "" ? "" : `${base}.${node.member.content}`
	}

	return ""
}

// A Future or a Started answers once waited for. Reaching through it would
// answer another Future, which no Condition takes. `complete` takes the whole
// chain behind it, so the answer is waited for on a line of its own.
function waitingHelps(
	type: common.Type,
	answer: common.Type,
	waiting: Waiting,
): Array<string> {
	if (!waiting.canWait && waiting.barrier !== null) {
		return barredCompletion(waiting.barrier).helps
	}

	let declare =
		"Declare the enclosing Function '-> Future<…>', which is what lets its body wait, then"

	if (answer.type === "Boolean") {
		return waiting.canWait
			? asynchronyHelps(answer, type)
			: [`${declare} add 'complete'.`]
	}

	let question = questionFor(answer, waiting.spell)
	let wait = `on a line of its own — 'constant answered = complete …' — and ask 'answered::${question}'.`

	if (question === null) {
		return []
	}

	return [
		waiting.canWait
			? `Wait for it ${wait}`
			: `${declare} wait for it ${wait}`,
	]
}

// One Match arm per member of a Union no one question fits, each asking the
// member its own. Withheld where an arm can not be written, where a member
// has no question, or where two members can not be told apart at runtime.
function matchHelps(
	condition: common.typed.ExpressionNode,
	members: Array<common.Type>,
	spell: Spelling,
): Array<string> {
	let arms = members.map((member) => {
		let matcher = writableMatcher(member, members, spell)
		let answer =
			member.type === "Boolean"
				? "@"
				: questionFor(member, spell) === null
					? null
					: `@::${questionFor(member, spell)}`

		return matcher === null || answer === null
			? null
			: `case ${matcher} { <- ${answer} }`
	})

	if (arms.includes(null) || indistinct(members)) {
		return []
	}

	let subject = condition.nodeType === "Identifier" ? condition.content : "…"

	return [
		`Ask each member its own question in a Match that answers a Boolean — 'match ${subject} -> Boolean { ${arms.join(" ")} }'.`,
	]
}

// The members of a Union that no one question fits, a Choice's own Cases kept
// together, or null for any other Type.
function unionMembers(
	type: common.Type,
	spell: Spelling,
): Array<common.Type> | null {
	if (type.type !== "UnionType" || questionFor(type, spell) !== null) {
		return null
	}

	let members: Array<common.Type> = []
	let collect = (member: common.Type) => {
		if (
			member.type === "UnionType" &&
			member.name === undefined &&
			member.alias === undefined
		) {
			member.types.forEach(collect)
		} else {
			members.push(member)
		}
	}

	type.types.forEach(collect)

	return members
}

// Whether a runtime test can not tell some members apart. Two of a kind
// differ only in Type Arguments, which erase, and a Record that has every
// member of another is matched by its Matcher.
function indistinct(members: Array<common.Type>): boolean {
	return members.some((member, index) =>
		members.slice(index + 1).some((other) => {
			if (member.type === "Record" && other.type === "Record") {
				let names = Object.keys(member.members)
				let others = Object.keys(other.members)

				return (
					names.every((name) => others.includes(name)) ||
					others.every((name) => names.includes(name))
				)
			}

			return kindOf(member) === kindOf(other) && member.type !== "Case"
		}),
	)
}

// What a runtime test sees of a Type, which a refinement does not change.
function kindOf(type: common.Type): string {
	return type.type === "Refinement" ? kindOf(type.base) : type.type
}

// A member's Matcher as the reader can write it, or null. A Record is written
// by its name where one binds it here, else by its shape. A Choice is written
// by its name, which must be bound, as its `::is` needs.
function writableMatcher(
	member: common.Type,
	members: Array<common.Type>,
	spell: Spelling,
): string | null {
	if (member.type === "UnionType") {
		let name = member.name ?? member.alias?.name
		let choice = choiceIn(member)

		return name === undefined ||
			spell(
				choice === null ? name : displayChoiceName(choice),
				member,
			) === null
			? null
			: spellType(member, spell)
	}

	if (member.type === "Case") {
		return spell(displayChoiceName(member.choice), member) === null
			? null
			: spellMatcher(member, spell, members)
	}

	let named = member.type === "Record" ? member.name : undefined

	return (
		(named === undefined ? null : spell(named, member)) ??
		spellShape(member)
	)
}

function choiceIn(union: common.UnionType): string | null {
	let first = union.types[0]

	return first?.type === "Case" ? first.choice : null
}

// The question a value of this Type answers with a Boolean, written after
// '::', or null where no one question fits. A Union of different kinds, a
// Function, a Future and a Type Parameter not bounded by `Equatable` have
// none. Neither has anything holding a value `::is` can not compare.
function questionFor(type: common.Type, spell: Spelling): string | null {
	switch (type.type) {
		case "Refinement":
			return questionFor(type.base, spell)
		case "Integer":
		case "Rational":
			return "isGreaterThan(0)"
		case "String":
			return "hasCharacters()"
		case "List":
			return "hasItems()"
		case "Dictionary":
			return "hasEntries()"
		case "UnionType":
			if (type.name === "Optional" || type.alias?.name === "Optional") {
				return "hasValue()"
			}

			return choiceIn(type) !== null && isEquatable(type, spell)
				? "is(…)"
				: null
		default:
			return isEquatable(type, spell) ? "is(…)" : null
	}
}

// Whether `::is` compares two values of this Type in the reading file.
function isEquatable(type: common.Type, spell: Spelling): boolean {
	switch (type.type) {
		case "Integer":
		case "Rational":
		case "String":
		case "Boolean":
			return true
		case "Refinement":
			return isEquatable(type.base, spell)
		case "List":
			return isEquatable(type.itemType, spell)
		case "Dictionary":
			return (
				isEquatable(type.keyType, spell) &&
				isEquatable(type.valueType, spell)
			)
		case "Record":
			return Object.values(type.members).every((member) =>
				isEquatable(member, spell),
			)
		// A Choice's `::is` is derived where the Choice is in scope, so one
		// bound nowhere in the reading file has none.
		case "Case":
			return (
				spell(displayChoiceName(type.choice), type) !== null &&
				Object.values(type.members).every((member) =>
					isEquatable(member, spell),
				)
			)
		case "UnionType":
			return type.types.every((member) => isEquatable(member, spell))
		case "GenericUse":
			return (
				type.constraint !== undefined &&
				displayProtocolName(type.constraint) === "Equatable"
			)
		default:
			return false
	}
}
