import type { common } from "@essence-lang/interfaces"

import { primary, reportWarning, secondary } from "../diagnostics/index"
import { describeType, withArticle } from "../helpers/describe"
import type { emptyCrossover } from "./runtimeOverlap"

type MatchHandler = common.typed.MatchNode["handlers"][number]

type Crossover = NonNullable<ReturnType<typeof emptyCrossover>>

// A Case whose empty container values an earlier Case takes. The Guard asks
// the container where it crosses, through the name the Case binds it to.
// See "Runtime overlap" in DEVELOPMENT.md.
export function reportEmptyContainerOverlap(
	handler: MatchHandler,
	earlierHandler: MatchHandler,
	memberType: common.Type,
	{ kind, path }: Crossover,
): void {
	let list = kind === "List"
	let question = list ? "hasItems()" : "hasEntries()"

	reportWarning(
		`This Case never sees an empty ${kind}`,
		handler.matcherPosition,
		{
			code: list ? "empty-list-overlap" : "empty-dictionary-overlap",
			labels: [
				primary(
					handler.matcherPosition,
					path.length === 0
						? `an empty ${describeType(memberType)} fits the Case above too`
						: `${withArticle(describeType(memberType))} with an empty ${kind} in '${path.join(".")}' fits the Case above too`,
				),
				secondary(
					earlierHandler.matcherPosition,
					"this Case runs first",
				),
			],
			notes: [
				"Cases are tried in order, and the first one that fits wins.",
				list
					? "Item Types erase before a Match runs, so a List Matcher asks about the items the value holds — and an empty List holds none, which makes it a value of every List Type there is."
					: "Key and value Types erase before a Match runs, so a Dictionary Matcher asks about the entries the value holds — and an empty Dictionary holds none, which makes it a value of every Dictionary Type there is.",
			],
			helps: [
				`Guard the Cases with 'where ${guardSubject([earlierHandler, handler], path)}::${question}' and answer for the empty ${kind} in a Case of its own.`,
			],
		},
	)
}

// The same overlap between two branches of a dispatched Method. A Match alone
// meets it too, and a Guard decides an empty container, so the Help spells
// guarded Cases. Each Matcher narrows `@`, so the Guard reads the container
// off it.
export function reportDispatchEmptyContainerOverlap(
	node: common.typed.MethodInvocationNode,
	earlierType: common.Type,
	laterType: common.Type,
	{ kind, path }: Crossover,
): void {
	let list = kind === "List"
	let subject = ["@", ...path].join(".")

	reportWarning(
		`The branch for ${describeType(laterType)} never sees an empty ${kind}`,
		node.member.position,
		{
			code: list ? "empty-list-overlap" : "empty-dictionary-overlap",
			labels: [
				primary(
					node.member.position,
					path.length === 0
						? `an empty ${kind} fits ${describeType(earlierType)} too, and that branch is tried first`
						: `${withArticle(describeType(laterType))} with an empty ${kind} in '${path.join(".")}' fits ${describeType(earlierType)} too, and that branch is tried first`,
				),
				secondary(
					node.base.position,
					`this is ${withArticle(describeType(node.base.type))}`,
				),
			],
			notes: [
				list
					? "Item Types erase before a branch is picked, so a List is placed by the items it holds — and an empty List holds none, which makes it a value of every List Type there is."
					: "Key and value Types erase before a branch is picked, so a Dictionary is placed by the entries it holds — and an empty Dictionary holds none, which makes it a value of every Dictionary Type there is.",
			],
			helps: [
				`Guard the Cases of a Match with 'where ${subject}::${list ? "hasItems()" : "hasEntries()"}', answer for the empty ${kind} in a Case of its own, and call the Method inside each arm.`,
			],
		},
	)
}

// What a Guard asks about the container at `path`: the matched value, or the
// name a Case binds the container to. Failing both, it reads the member off
// `@`, which a Matcher with no Pattern narrows. The Case that runs first is the
// one whose Guard must decline the empty container.
function guardSubject(
	handlers: Array<MatchHandler>,
	path: Array<string>,
): string {
	if (path.length === 0) {
		return "@"
	}

	for (let handler of handlers) {
		let binding = bindingAt(handler, path)

		if (binding !== null) {
			return binding
		}
	}

	return `@.${path.join(".")}`
}

// The name a Matcher's Pattern binds the member at `path` to. Bindings are the
// Constants at the head of the body, each reading its member off `@`.
function bindingAt(handler: MatchHandler, path: Array<string>): string | null {
	for (let statement of handler.body) {
		if (
			statement.nodeType !== "ConstantDeclarationStatement" ||
			statement.synthesized !== "binding"
		) {
			break
		}

		if (readsPath(statement.value, path)) {
			return statement.name.content
		}
	}

	return null
}

function readsPath(
	expression: common.typed.ExpressionNode,
	path: Array<string>,
): boolean {
	if (path.length === 0) {
		return expression.nodeType === "Self"
	}

	return (
		expression.nodeType === "Lookup" &&
		expression.member.content === path[path.length - 1] &&
		readsPath(expression.base, path.slice(0, -1))
	)
}
