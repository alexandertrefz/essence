import type { common } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../diagnostics/index"
import {
	collectUnits,
	defaultsOf,
	type Dependency,
	type Unit,
	type Units,
} from "./reachUnits"

// Each top-level Namespace's index in the Statement list and its name's
// Position. See "Use before declaration" in DEVELOPMENT.md.
export type TopLevelNamespaces = Map<
	string,
	{ index: number; position: common.Position }
>

// Where each top-level Constant and static Property is declared. A static
// Property's `step` is its place in its Namespace's written order, from 1.
type Declarations = Map<
	string,
	{ index: number; step: number; position: common.Position }
>

// What one validation knows about the order of a Program's top-level
// Statements. `reported` holds `index name` for each Namespace a Statement's
// own use was reported for, so a call reaching it is not reported again.
export type DeclarationOrder = {
	nodes: Array<common.typed.ImplementationNode>
	namespaces: TopLevelNamespaces
	constants: Declarations
	properties: Declarations
	// The last Statement that declares anything code can reach too early.
	last: number
	reported: Set<string>
	run: Simulation | null
}

// How much the walk over what runs did, for a spec that holds it linear.
export const reachWork = { visits: 0 }

// What a unit and all it runs need. `latest` is the latest moment something
// they use comes into being. The flags say whether any of them calls a value
// nothing names, lets a value escape, or starts work that goes on later.
type Closure = {
	latest: number
	unknownCall: boolean
	escapes: boolean
	tails: boolean
}

// What has happened by the Statement being validated. It holds the Function
// values that escaped, and the started work that goes on later, keyed by the
// Statement it may go on at.
type Simulation = {
	units: Units
	order: DeclarationOrder
	closures: Map<Unit, Closure>
	escaped: Set<string>
	escapedClosure: Closure
	fired: Set<Unit>
	tails: Map<number, Array<Started>>
	scheduled: Set<Unit>
}

// The part of a body after its first suspension, and where it was started.
type Started = { unit: Unit; via: Via }

type Via = { position: common.Position; label: string }

// Moments are numbered in Statement order. A Statement's Properties get the
// moments in between, so a Namespace's class exists from the end of its own.
const STEPS = 1 << 20

export function collectDeclarationOrder(
	nodes: Array<common.typed.ImplementationNode>,
): DeclarationOrder {
	let namespaces: TopLevelNamespaces = new Map()
	let constants: Declarations = new Map()
	let properties: Declarations = new Map()
	let last = -1

	for (let [index, node] of nodes.entries()) {
		// The first Declaration of a name is recorded. The enricher reports
		// the second.
		if (
			node.nodeType === "NamespaceDefinitionStatement" &&
			!namespaces.has(node.name.content)
		) {
			namespaces.set(node.name.content, {
				index,
				position: node.name.position,
			})
			last = index

			for (let [step, property] of Object.values(
				node.properties,
			).entries()) {
				properties.set(
					`${node.name.content}.${property.name.content}`,
					{
						index,
						step: step + 1,
						position: property.name.position,
					},
				)
			}
		} else if (
			(node.nodeType === "ConstantDeclarationStatement" ||
				node.nodeType === "VariableDeclarationStatement") &&
			!constants.has(node.name.content)
		) {
			constants.set(node.name.content, {
				index,
				step: 1,
				position: node.name.position,
			})
			last = index
		}
	}

	reachWork.visits = 0

	return {
		nodes,
		namespaces,
		constants,
		properties,
		last,
		reported: new Set(),
		run: null,
	}
}

// Reports each top-level Namespace the Statement at `index` reaches before it
// exists, through the bodies it runs. A use the Statement makes itself was
// reported where `validate` met it. Statements are asked in order.
export function reportReachedNamespaces(
	order: DeclarationOrder,
	index: number,
): void {
	if (index > order.last) {
		return
	}

	let simulation = (order.run ??= {
		units: collectUnits(order.nodes, new Set(order.namespaces.keys())),
		order,
		closures: new Map(),
		escaped: new Set(),
		escapedClosure: emptyClosure(),
		fired: new Set(),
		tails: new Map(),
		scheduled: new Set(),
	})
	let node = order.nodes[index]
	let home =
		node.nodeType === "NamespaceDefinitionStatement"
			? node.name.content
			: null
	let reported = new Set<string>()
	let roots: Array<{ unit: Unit; moment: number; via: Via | null }> =
		simulation.units.roots[index].map((unit) => ({
			unit,
			moment: index * STEPS + unit.step,
			via: null,
		}))

	for (let cursor = 0; ; cursor++) {
		// Work this Statement starts may go on while it suspends.
		if (cursor === roots.length) {
			let released = (simulation.tails.get(index) ?? []).map(
				(started: Started) => ({
					...started,
					moment: index * STEPS + 1,
				}),
			)

			simulation.tails.delete(index)

			if (released.length === 0) {
				break
			}

			roots.push(...released)
		}

		let { unit, moment, via } = roots[cursor]
		let closure = closureOf(simulation, unit)

		fire(simulation, unit, index)

		if (closure.unknownCall) {
			fireEscaped(simulation, index, order.nodes[index].position)
			closure = merged(closure, simulation.escapedClosure)
		}

		if (closure.latest >= moment) {
			reportFrom(order, simulation, { unit, via }, moment, home, reported)
		}
	}
}

function emptyClosure(): Closure {
	return { latest: -1, unknownCall: false, escapes: false, tails: false }
}

function merged(left: Closure, right: Closure): Closure {
	return {
		latest: Math.max(left.latest, right.latest),
		unknownCall: left.unknownCall || right.unknownCall,
		escapes: left.escapes || right.escapes,
		tails: left.tails || right.tails,
	}
}

// The last moment a Dependency is not met yet. A Constant or a static
// Property holds its value once its own moment is over.
function availableFrom(
	dependency: Dependency,
	order: DeclarationOrder,
): number {
	if (dependency.kind !== "namespace") {
		let declaration = (
			dependency.kind === "constant" ? order.constants : order.properties
		).get(dependency.name)

		return declaration === undefined
			? -1
			: declaration.index * STEPS + declaration.step
	}

	let declaration = order.namespaces.get(dependency.name)

	if (declaration === undefined) {
		return -1
	}

	// The class's own binding exists while its Properties are given values.
	return dependency.home === dependency.name
		? declaration.index * STEPS
		: declaration.index * STEPS + STEPS - 1
}

function ownClosure(unit: Unit, order: DeclarationOrder): Closure {
	return {
		latest: Math.max(
			-1,
			...unit.dependencies.map((dependency) =>
				availableFrom(dependency, order),
			),
		),
		unknownCall: unit.unknownCall !== null,
		escapes: unit.escapes.length > 0,
		tails: unit.tails.length > 0,
	}
}

// Each unit's closure over the bodies it runs, worked out once per strongly
// connected group of bodies.
function closureOf(simulation: Simulation, root: Unit): Closure {
	let known = simulation.closures.get(root)

	if (known !== undefined) {
		return known
	}

	let index = new Map<Unit, number>()
	let low = new Map<Unit, number>()
	let stack: Array<Unit> = []
	let onStack = new Set<Unit>()
	let counter = 0
	let frames: Array<{ unit: Unit; next: number }> = [{ unit: root, next: 0 }]

	index.set(root, counter)
	low.set(root, counter++)
	stack.push(root)
	onStack.add(root)

	while (frames.length > 0) {
		let frame = frames[frames.length - 1]
		let successors = successorsOf(simulation, frame.unit)

		reachWork.visits++

		if (frame.next < successors.length) {
			let successor = successors[frame.next++]

			if (simulation.closures.has(successor)) {
				continue
			}

			if (!index.has(successor)) {
				index.set(successor, counter)
				low.set(successor, counter++)
				stack.push(successor)
				onStack.add(successor)
				frames.push({ unit: successor, next: 0 })
			} else if (onStack.has(successor)) {
				low.set(
					frame.unit,
					Math.min(low.get(frame.unit)!, index.get(successor)!),
				)
			}

			continue
		}

		frames.pop()

		let parent = frames[frames.length - 1]

		if (parent !== undefined) {
			low.set(
				parent.unit,
				Math.min(low.get(parent.unit)!, low.get(frame.unit)!),
			)
		}

		if (low.get(frame.unit) !== index.get(frame.unit)) {
			continue
		}

		// The group's closure: its own units and every group they run.
		let group: Array<Unit> = []
		let member: Unit | undefined

		do {
			member = stack.pop()!
			onStack.delete(member)
			group.push(member)
		} while (member !== frame.unit)

		let closure = emptyClosure()

		for (let unit of group) {
			closure = merged(closure, ownClosure(unit, simulation.order))

			for (let successor of successorsOf(simulation, unit)) {
				let outside = simulation.closures.get(successor)

				if (outside !== undefined) {
					closure = merged(closure, outside)
				}
			}
		}

		for (let unit of group) {
			simulation.closures.set(unit, closure)
		}
	}

	return simulation.closures.get(root)!
}

function successorsOf(simulation: Simulation, unit: Unit): Array<Unit> {
	return unit.runs.flatMap((run) => {
		let body = simulation.units.bodies.get(run.target)

		return body === undefined ? [] : [body.head]
	})
}

// Takes what a unit, and all it runs, escapes and starts, once.
function fire(simulation: Simulation, root: Unit, index: number): void {
	let pending = [root]

	while (pending.length > 0) {
		let unit = pending.pop()!

		if (simulation.fired.has(unit)) {
			continue
		}

		simulation.fired.add(unit)
		reachWork.visits++

		// A completing body's value escapes with the defaults its call runs.
		for (let id of unit.escapes.flatMap((id) => [id, defaultsOf(id)])) {
			let body = simulation.units.bodies.get(id)

			if (body !== undefined && !simulation.escaped.has(id)) {
				simulation.escaped.add(id)
				simulation.escapedClosure = merged(
					simulation.escapedClosure,
					closureOf(simulation, body.head),
				)
			}
		}

		for (let { id, position } of unit.tails) {
			schedule(simulation, id, index, {
				position,
				label: "this starts work that later reaches it",
			})
		}

		pending.push(...successorsOf(simulation, unit))
	}
}

// The part of a started body after its first suspension, which runs once the
// top level next suspends.
function schedule(
	simulation: Simulation,
	id: string,
	index: number,
	via: Via,
): void {
	let tail = simulation.units.bodies.get(id)?.tail

	if (tail === null || tail === undefined || simulation.scheduled.has(tail)) {
		return
	}

	let at = simulation.units.suspensions[index]

	simulation.scheduled.add(tail)

	if (Number.isFinite(at)) {
		simulation.tails.set(at, [
			...(simulation.tails.get(at) ?? []),
			{ unit: tail, via },
		])
	}
}

// Every escaped Function value may run, and what those run escapes too. An
// escaped Future may be started, so its later part is scheduled as well.
function fireEscaped(
	simulation: Simulation,
	index: number,
	statement: common.Position,
): void {
	let done = 0

	while (done < simulation.escaped.size) {
		let ids = [...simulation.escaped]

		done = ids.length

		for (let id of ids) {
			let body = simulation.units.bodies.get(id)

			if (body !== undefined) {
				fire(simulation, body.head, index)
				schedule(simulation, id, index, {
					position: statement,
					label: "this may start work that later reaches it",
				})
			}
		}
	}
}

// Walks from a Statement to every Dependency it meets too early, with the
// path it took, and reports each once.
function reportFrom(
	order: DeclarationOrder,
	simulation: Simulation,
	root: { unit: Unit; via: Via | null },
	moment: number,
	home: string | null,
	reported: Set<string>,
): void {
	type Step = {
		unit: Unit
		parent: Step | null
		via: { position: common.Position; label: string } | null
	}

	let index = Math.floor(moment / STEPS)
	let seen = new Set<Unit>([root.unit])
	// Started work is walked from where it was started.
	let queue: Array<Step> = [
		root.via === null
			? { unit: root.unit, parent: null, via: null }
			: {
					unit: root.unit,
					parent: { unit: root.unit, parent: null, via: null },
					via: root.via,
				},
	]

	for (let cursor = 0; cursor < queue.length; cursor++) {
		let step = queue[cursor]

		reachWork.visits++

		for (let dependency of step.unit.dependencies) {
			let declaration = declarationOf(order, dependency)
			let key = `${dependency.kind} ${dependency.name}`

			// A Constant or a Property the Statement reads itself is the
			// enricher's and `checkPropertyIsBound`'s to report.
			if (
				declaration === undefined ||
				availableFrom(dependency, order) < moment ||
				(step.parent === null && dependency.kind !== "namespace") ||
				order.reported.has(`${index} ${dependency.name}`) ||
				reported.has(key)
			) {
				continue
			}

			reported.add(key)

			if (step.parent === null) {
				reportUse(dependency, declaration)
			} else {
				reportReach(step, dependency, declaration, home)
			}
		}

		let next: Array<{
			unit: Unit
			via: { position: common.Position; label: string }
		}> = step.unit.runs.flatMap((run) => {
			let body = simulation.units.bodies.get(run.target)

			return body === undefined ? [] : [{ unit: body.head, via: run }]
		})

		if (step.unit.unknownCall !== null) {
			for (let id of simulation.escaped) {
				let body = simulation.units.bodies.get(id)

				if (body !== undefined) {
					next.push({
						unit: body.head,
						via: {
							position: step.unit.unknownCall,
							label: "this call may run a Function that reaches it",
						},
					})
				}
			}
		}

		for (let { unit, via } of next) {
			if (!seen.has(unit)) {
				seen.add(unit)
				queue.push({ unit, parent: step, via })
			}
		}
	}

	function reportReach(
		step: Step,
		dependency: Dependency,
		declaration: { position: common.Position },
		home: string | null,
	): void {
		let path: Array<string> = []
		let first = step

		for (
			let current: Step | null = step;
			current?.parent != null;
			current = current.parent
		) {
			path.unshift(current.unit.name)
			first = current
		}

		if (dependency.kind === "namespace") {
			reportReachedDependency(
				first.via!,
				path,
				dependency,
				declaration,
				home,
			)
		} else {
			reportReadTooEarly(first.via!, path, dependency, declaration)
		}
	}
}

const ARRIVES =
	"A Namespace comes into being where it is written, so nothing that runs above it can reach it."

function moveHelp(namespace: string): string {
	return `Move the Declaration of '${namespace}' above this Statement, or this Statement below it.`
}

// A use the Statement makes itself that `validate` does not read, such as a
// String hole's witness.
function reportUse(
	dependency: Dependency,
	declaration: { position: common.Position },
): void {
	reportError(
		`Namespace '${dependency.name}' is used before it is declared`,
		dependency.position,
		{
			code: "use-before-declaration",
			labels: [
				primary(dependency.position, dependency.label),
				secondary(declaration.position, "declared here, below the use"),
			],
			notes: [ARRIVES],
			helps: [moveHelp(dependency.name)],
		},
	)
}

// A use in a body the Statement runs. `path` names the bodies it runs
// through, the first one at `via`.
function reportReachedDependency(
	via: { position: common.Position; label: string },
	path: Array<string>,
	dependency: Dependency,
	declaration: { position: common.Position },
	home: string | null,
): void {
	let own = dependency.name === home
	let declared = own
		? secondary(declaration.position, "still being declared when this runs")
		: secondary(declaration.position, "declared here, below the use")
	let used = secondary(dependency.position, dependency.label)

	reportError(
		`Namespace '${dependency.name}' is used before it is declared`,
		via.position,
		{
			code: "use-before-declaration",
			// The quick fix moves the Statement below the first secondary
			// Label's Namespace, which can not help a Namespace reaching itself.
			labels: [
				primary(via.position, via.label),
				...(own ? [used, declared] : [declared, used]),
			],
			notes: [
				own
					? "A Namespace's Properties are given their values while it is declared, and code written outside it can not reach it until that is done."
					: ARRIVES,
				`This reaches '${dependency.name}' through ${path.join(", then ")}.`,
			],
			helps: [
				own
					? `Work the value out in a Method of '${dependency.name}' instead.`
					: moveHelp(dependency.name),
			],
		},
	)
}

function declarationOf(
	order: DeclarationOrder,
	dependency: Dependency,
): { position: common.Position } | undefined {
	switch (dependency.kind) {
		case "namespace":
			return order.namespaces.get(dependency.name)
		case "constant":
			return order.constants.get(dependency.name)
		case "property":
			return order.properties.get(dependency.name)
	}
}

// A Constant or a static Property a body the Statement runs reads before it
// holds its value.
function reportReadTooEarly(
	via: { position: common.Position; label: string },
	path: Array<string>,
	dependency: Dependency,
	declaration: { position: common.Position },
): void {
	let constant = dependency.kind === "constant"

	reportError(
		`${constant ? "Constant" : "Property"} '${dependency.name}' is read before it has a value`,
		via.position,
		{
			code: "use-before-declaration",
			labels: [
				primary(via.position, via.label),
				secondary(declaration.position, "it is given its value here"),
				secondary(dependency.position, dependency.label),
			],
			notes: [
				constant
					? "A Constant is given its value where it is written, so nothing that runs above it can read it."
					: "A static Property is given its value where it is written, in order, so one written above it has nothing to read yet.",
				`This reads '${dependency.name}' through ${path.join(", then ")}.`,
			],
			helps: [
				constant
					? `Move the Declaration of '${dependency.name}' above this Statement, or this Statement below it.`
					: "Move this Declaration below the one it reads.",
			],
		},
	)
}
