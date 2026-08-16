import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteNodes } from "../walk"

// NOTE: A walk that BUILDS a List rebuilds it every turn. `inline-loops` writes
// the driver out, but what it writes into the body is still the call the Program
// wrote — `$loop_0_state = append__overload$1(list, index)` — and that call
// copies everything the turns before it added. Tail sharing took the copy away;
// what is left is a box and a native call per turn, and both of them are there
// only because the emission does not know the List is the walk's own.
//
// NOTE: It already knows for its OWN walks. `map` and `keepEvery` declare an
// empty Array, push each answer onto it and box it once at the end — the
// `pushed` and `createdList` helpers in the Rewriter — because the Array they
// build is the Compiler's, and nothing else can reach it. This pass extends
// exactly that emission to an accumulator the PROGRAM wrote, in the four walks
// that thread a State: the counted walk, the two condition walks, the general
// `Step` walk and both folds.
//
// NOTE: What it costs is a proof, and the proof is what this file is. Pushing
// onto an Array is invisible only while no one else can see the Array, so the
// previous State has to be dead the moment it is rebuilt — and the
// counter-example is easy to write:
//
//   <- #Continue({ state with
//       current = current::append(next),
//       snapshots = snapshots::append(current),
//   })
//
// The old `current` survives inside `snapshots`, and pushing onto its Array
// would rewrite history the Program already recorded. What declines it is
// visible in the body: `current` is mentioned twice, once as the receiver being
// replaced and once as a value handed somewhere else.
//
// NOTE: So the fence is drawn tight, in the spirit of `residual.ts`, and
// deliberately narrower than a fuller analysis could admit. The State's name may
// stand as the receiver at the ROOT of the rebuilding chain, and nowhere else —
// a branch that changes nothing answers it bare, which is the chain with no
// appends on it. Any other mention declines: an Argument, a member of something
// built, a name a closure captured, a read as innocent as `length`. Declining is
// always correct, which is what makes a tight fence safe to widen later.
//
// NOTE: The two widenings are named in `optimisations.md` under "not done yet":
// retention summaries for the prelude's own Functions, which would admit
// `removeDuplicates`' `contains` read, and accumulators one Record member deep.

export const buildListsInPlace: OptimiserPass = {
	name: "build-lists-in-place",
	run: (program, namespaces) => {
		// NOTE: `List` is a name a Program may take for itself, nested, and a
		// `namespace List for List` writing its own `append` answers under
		// exactly the name and shape the chain below is read for. So is
		// `NonEmptyList`, which the chain reads for its own `append`. The same
		// set answers it for `inline-loops`, which is the pass that made the
		// walks this one reads.
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

// NOTE: Both forms of the intrinsic carry the same `InlineLoop`, so both are
// offered here and the answer rebuilds whichever one it was given. A walk the
// fence declines is handed back AS ITSELF, which is what the shared walk's
// structural sharing rests on.
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

// NOTE: WHICH Parameter the State arrives under, per driver, and the answer for
// the two walks that thread none. The counted walk hands the counter first and
// the State second, exactly as its Essence body does; every other walk hands the
// State first.
//
// NOTE: `map` and `keep` build an Array already — that emission is what this
// pass extends, and there is nothing of theirs to extend it to.
function rebuiltDriver(
	driver: common.typedSimple.InlineLoopDriver,
): RebuiltDriver | null {
	switch (driver.kind) {
		case "condition": {
			// NOTE: ONE State handed to TWO bodies. The predicate answers a
			// Boolean rather than the State, so it has no rebuilding chain to
			// stand in — every mention it makes of the State is a read, and a
			// read is what the fence declines. A `while` walk whose predicate
			// asks anything of its accumulator keeps today's emission whole.
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

// NOTE: The State has to be EXACTLY a List — not a Union it is a member of, not
// a Type Parameter that could be one — because the whole rewrite is that the
// slot holds what a List holds, and only a List is known to hold that. It is the
// same exactness `unboxed-loop-state` rests on for an Integer, and it is what
// leaves a Record, a String or an Optional State untouched.
//
// NOTE: A refinement over List IS accumulated, and there is nothing here that
// says so because there is nothing here that could see one: `eraseRefinements`
// runs at the head of the stage, before any pass, so a `NonEmptyList` State
// reaches this as the List it is.
function accumulates(
	callback: common.typedSimple.InlineLoopCallback,
	parameter: number,
): boolean {
	return callback.parameters[parameter]?.type.type === "List"
}

// NOTE: The step body with every answer that writes the State rewritten into the
// build it performs, and null where any of them is a shape the emission could
// not write. The fence is the LAST line: once the chains are gone, a mention of
// the State that survives is a use this pass does not understand, and one is
// enough to decline the whole walk.
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

// NOTE: The descent is the Rewriter's own — the three Statement kinds that can
// hold a walk's answer, which is what `redirectedStatements` writes and
// therefore the whole of what an answer can be written in. Everything else is
// handed back untouched and answers to the mention count instead.
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
			// NOTE: A lowered Statement answering with a Return of its own is
			// answering the WALK. One that answers a name of its own is
			// answering that name, and holds no answer of the walk's at all.
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
		// NOTE: A walk nested inside this one, answering it. What the outer walk
		// is handed is the name the inner one settled in rather than a Node, so
		// there is nothing to read a chain out of — and a State written from a
		// name is a State written whole, which this pass has no slot for.
		case "inline-loop":
			return null
	}
}

// NOTE: One answer. A walk that threads its State plainly writes the State at
// every answer, so every answer has to BE a build; a walk whose body answers
// with a `Step` writes it only through `#Continue`, and a `#Done` carrying
// anything else is the walk leaving with a value of its own.
//
// NOTE: The `Step` is read as the Case it is written as, and not also as the
// `direct-case` `collapse-construction` makes of one — that pass runs AFTER this
// one, in the fixed order, so no Program can reach here with a collapsed
// construction. The Rewriter, which runs after both, reads both.
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
		// NOTE: `#Done(<anything else>)` is admitted and left exactly as it is:
		// the walk leaves with a value that is not the State, and the Array it
		// built is simply dropped. `#Continue(<anything else>)` is not — it
		// would put a List the walk does not own where the accumulator was.
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

// NOTE: A `Step` this pass can read: the Case as it is written, its Record
// payload, and which member of it carries the value. A payload holding anything
// MORE than that one member is refused rather than read, for the reason the
// Rewriter refuses one — `Step` declares exactly one member per Case today, and
// this is what keeps a second one from silently going somewhere it was not
// weighed.
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

// NOTE: The rebuilding chain, read from the outside in — `state::append(a)
// ::append(contentsOf b)` unwinds to `b`, then `a`, then the name, and the
// additions come back in the order the turn performs them. Null the moment
// anything else stands in the chain, which includes the whole of what the fence
// excludes: the root has to be the State's own name and every link an `append`.
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
		// NOTE: The Type and the Position of the chain it replaces, as every
		// intrinsic carries the ones of the Node it stands in for.
		type: node.type,
		position: node.position,
	}
}

// NOTE: One link. Both `append` Overloads bind by position — `$1` adds an item
// under no label, `$2` adds a List under `contentsOf` — and a call labelled any
// other way is not one of them. `prepend` is not one of them either, deliberately
// and for a reason the emission states: what a build pushes onto is the BACK of
// the Array it owns.
//
// NOTE: THREE spellings, not two, because the second `append` in a chain has a
// receiver the first one PROVED something about. `append(_:)` answers a
// `NonEmptyList` whatever it was handed, and `NonEmptyList` re-declares
// `append(contentsOf:)` so that it may promise the same — one entry, so no
// mangled number — and that declaration is List's own second Overload
// re-exported. Its single-item sibling is not re-declared, so an item added to a
// proven List reaches List's own entry by forgetting the proof and arrives under
// List's own name.
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

// NOTE: Whether a name is mentioned anywhere at all in what it is given. Every
// position is read — a Parameter's own binding, a Namespace's name, a Method's
// member name, a Function declared inside the body and everything it closes over
// — so the answer is conservative in the one direction that matters: a name this
// says nothing about is a name nothing may be assumed of. A body that SHADOWS
// the State's name declines for the same reason, because the declaration is a
// mention like any other.
//
// NOTE: A Type is walked like everything else and the `seen` set is why that is
// safe: a Choice whose payload names the Choice builds a Type graph that leads
// back into itself, and every structural walker in this stage carries a guard
// for it. Nothing in a Type is an Identifier Node, so walking one only ever
// costs time.
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
