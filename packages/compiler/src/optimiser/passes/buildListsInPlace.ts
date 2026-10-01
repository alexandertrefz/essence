import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteNodes } from "../walk"

// Builds a List accumulator in place: an inlined walk pushes onto an Array of
// its own and boxes it once. It applies only where the State's name stands
// nowhere but at the root of its `append` chains, so the old State is dead. See
// "build-lists-in-place" in DEVELOPMENT.md.

export const buildListsInPlace: OptimiserPass = {
	name: "build-lists-in-place",
	run: (program, namespaces) => {
		// A nested `List` or `NonEmptyList` Namespace may declare its own
		// `append`.
		if (
			namespaces.nested.has("List") ||
			namespaces.nested.has("NonEmptyList")
		) {
			return program
		}

		return rewriteNodes(program, {
			expression: (node) =>
				node.nodeType === "Intrinsic" && node.kind === "inline-loop"
					? built(node)
					: node,
			statement: (node) =>
				node.nodeType === "IntrinsicStatement" &&
				node.kind === "inline-loop"
					? built(node)
					: node,
		})
	},
}

// Either form of the intrinsic. A declined walk is handed back as itself.
function built<Node extends common.typedSimple.InlineLoop>(node: Node): Node {
	let driver = rebuiltDriver(node.driver)

	if (driver === null) {
		return node
	}

	return { ...node, driver: driver.driver, build: driver.build }
}

type RebuiltDriver = {
	driver: common.typedSimple.InlineLoopDriver
	build: common.typedSimple.ListBuild
}

// Which Parameter carries the State: the second for a counted walk, else the
// first. `map` and `keep` build an Array already.
function rebuiltDriver(
	driver: common.typedSimple.InlineLoopDriver,
): RebuiltDriver | null {
	switch (driver.kind) {
		case "condition": {
			// The predicate may not mention the State, since any read declines.
			if (
				!accumulates(driver.predicate, 0) ||
				!accumulates(driver.step, 0) ||
				mentions(
					driver.predicate.body,
					driver.predicate.parameters[0]!.name,
				)
			) {
				return null
			}

			let step = rebuiltCallback(driver.step, 0, false)

			return step === null
				? null
				: { driver: { ...driver, step }, build: { parameter: 0 } }
		}
		case "counted": {
			if (!accumulates(driver.step, 1)) {
				return null
			}

			let step = rebuiltCallback(driver.step, 1, false)

			return step === null
				? null
				: { driver: { ...driver, step }, build: { parameter: 1 } }
		}
		case "general": {
			if (!accumulates(driver.step, 0)) {
				return null
			}

			let step = rebuiltCallback(driver.step, 0, true)

			return step === null
				? null
				: { driver: { ...driver, step }, build: { parameter: 0 } }
		}
		case "fold": {
			if (!accumulates(driver.step, 0)) {
				return null
			}

			let step = rebuiltCallback(driver.step, 0, driver.stepped)

			return step === null
				? null
				: { driver: { ...driver, step }, build: { parameter: 0 } }
		}
		case "map":
		case "keep":
			return null
	}
}

// The State has to be exactly a List, not a Union or a Type Parameter. A
// refinement over List was erased before any pass.
function accumulates(
	callback: common.typedSimple.InlineLoopCallback,
	parameter: number,
): boolean {
	return callback.parameters[parameter]?.type.type === "List"
}

// Every answer that writes the State, rewritten into a build. Any mention of
// the State left afterwards declines the walk.
function rebuiltCallback(
	callback: common.typedSimple.InlineLoopCallback,
	parameter: number,
	stepped: boolean,
): common.typedSimple.InlineLoopCallback | null {
	let name = callback.parameters[parameter]!.name
	let body = rebuiltBody(callback.body, name, stepped)

	if (body === null || mentions(body, name)) {
		return null
	}

	return { ...callback, body }
}

// The Statement kinds that can hold the walk's answer, as
// `redirectedStatements` writes them. Everything else is left to the mention
// check.
function rebuiltBody(
	nodes: Array<common.typedSimple.ImplementationNode>,
	name: string,
	stepped: boolean,
): Array<common.typedSimple.ImplementationNode> | null {
	let rebuilt: Array<common.typedSimple.ImplementationNode> = []

	for (let node of nodes) {
		let one = rebuiltStatement(node, name, stepped)

		if (one === null) {
			return null
		}

		rebuilt.push(one)
	}

	return rebuilt
}

function rebuiltStatement(
	node: common.typedSimple.ImplementationNode,
	name: string,
	stepped: boolean,
): common.typedSimple.ImplementationNode | null {
	switch (node.nodeType) {
		case "ReturnStatement": {
			let expression = rebuiltAnswer(node.expression, name, stepped)

			return expression === null ? null : { ...node, expression }
		}
		case "ConditionalStatement": {
			let trueBody = rebuiltBody(node.trueBody, name, stepped)
			let falseBody = rebuiltBody(node.falseBody, name, stepped)

			return trueBody === null || falseBody === null
				? null
				: { ...node, trueBody, falseBody }
		}
		case "IntrinsicStatement":
			// A lowered Statement that returns is answering the walk. One that
			// answers a name of its own holds no answer of the walk's.
			return node.result.kind === "return"
				? rebuiltIntrinsic(node, name, stepped)
				: node
		default:
			return node
	}
}

function rebuiltIntrinsic(
	node: common.typedSimple.IntrinsicStatementNode,
	name: string,
	stepped: boolean,
): common.typedSimple.ImplementationNode | null {
	switch (node.kind) {
		case "statement-match": {
			let handlers: Array<common.typedSimple.MatchHandler> = []

			for (let handler of node.handlers) {
				let body = rebuiltBody(handler.body, name, stepped)

				if (body === null) {
					return null
				}

				handlers.push({ ...handler, body })
			}

			return { ...node, handlers }
		}
		case "held-expression": {
			let expression = rebuiltAnswer(node.expression, name, stepped)

			return expression === null ? null : { ...node, expression }
		}
		// A nested walk answers through a name, a State written whole, which
		// has no slot here.
		case "inline-loop":
			return null
	}
}

// One answer. A plain walk writes the State at every answer. A `Step` walk
// writes it only through `#Continue`. `collapse-construction` runs later, so a
// `Step` is still a `CaseValue` here.
function rebuiltAnswer(
	node: common.typedSimple.ExpressionNode,
	name: string,
	stepped: boolean,
): common.typedSimple.ExpressionNode | null {
	if (!stepped) {
		return listBuild(node, name)
	}

	let step = stepPayload(node)

	if (step === null) {
		return null
	}

	let build = listBuild(step.value, name)

	if (build === null) {
		// `#Done` with another value leaves the walk and drops the Array.
		// `#Continue` with another List would replace the accumulator.
		return step.done ? node : null
	}

	return {
		...step.node,
		value: {
			...step.payload,
			members: { ...step.payload.members, [step.member]: build },
		},
	}
}

const doneTag = "Step#Done"
const continueTag = "Step#Continue"

// A `Step` as written, with a one-member Record payload, which is what `Step`
// declares. A payload with more is refused.
function stepPayload(node: common.typedSimple.ExpressionNode): {
	done: boolean
	member: string
	node: common.typedSimple.CaseValueNode
	payload: common.typedSimple.RecordValueNode
	value: common.typedSimple.ExpressionNode
} | null {
	if (
		node.nodeType !== "CaseValue" ||
		node.value === null ||
		node.value.nodeType !== "RecordValue"
	) {
		return null
	}

	let payload = node.value

	if (Object.keys(payload.members).length !== 1) {
		return null
	}

	let done = payload.members["value"]
	let carried = payload.members["state"]

	if (node.tag === doneTag && done !== undefined) {
		return { done: true, member: "value", node, payload, value: done }
	}

	if (node.tag === continueTag && carried !== undefined) {
		return { done: false, member: "state", node, payload, value: carried }
	}

	return null
}

// The rebuilding chain read from the outside in, so the additions come back in
// the order the turn makes them. The root must be the State's name, and every
// link an `append`.
function listBuild(
	node: common.typedSimple.ExpressionNode,
	name: string,
): common.typedSimple.ListBuildNode | null {
	let additions: Array<common.typedSimple.ListBuildAddition> = []
	let cursor = node

	while (cursor.nodeType !== "Identifier") {
		let link = appendCall(cursor)

		if (link === null) {
			return null
		}

		additions.unshift(link.addition)
		cursor = link.receiver
	}

	if (cursor.name !== name) {
		return null
	}

	return {
		nodeType: "Intrinsic",
		kind: "list-build",
		additions,
		// The Type and Position of the chain it replaces.
		type: node.type,
		position: node.position,
	}
}

// One `append`: an item unlabelled, or a List under `contentsOf`.
// `NonEmptyList` re-declares the second without a mangled number. `prepend` is
// never read, since a build pushes onto the back.
function appendCall(node: common.typedSimple.ExpressionNode): {
	receiver: common.typedSimple.ExpressionNode
	addition: common.typedSimple.ListBuildAddition
} | null {
	if (node.nodeType !== "MethodInvocation" || node.arguments.length !== 2) {
		return null
	}

	let member = node.member.name
	let contentsOf =
		(node.base.name === "List" && member === "append__overload$2") ||
		(node.base.name === "NonEmptyList" && member === "append")

	if (
		!contentsOf &&
		!(node.base.name === "List" && member === "append__overload$1")
	) {
		return null
	}

	let [receiver, added] = node.arguments

	if (
		receiver!.name !== "@" ||
		added!.name !== (contentsOf ? "contentsOf" : null)
	) {
		return null
	}

	return {
		receiver: receiver!.value,
		addition: { contentsOf, value: added!.value },
	}
}

// Whether the name appears anywhere, in every position, a shadowing
// declaration included. Shared Types are walked once.
function mentions(root: unknown, name: string): boolean {
	let seen = new Set<object>()
	let found = false

	function visit(node: unknown): void {
		if (found || node === null || typeof node !== "object") {
			return
		}

		if (seen.has(node)) {
			return
		}

		seen.add(node)

		let record = node as Record<string, unknown>

		if (record["nodeType"] === "Identifier" && record["name"] === name) {
			found = true

			return
		}

		for (let value of Object.values(record)) {
			visit(value)
		}
	}

	visit(root)

	return found
}
