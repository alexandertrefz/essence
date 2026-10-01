import type { common } from "@essence-lang/interfaces"

// The machinery behind the child tables of `parser.ts` and `typed.ts`. See
// "The child tables" in DEVELOPMENT.md.

export type NodeLike = { nodeType: string }

type Primitive = string | number | boolean | bigint | symbol | null | undefined

// Values no data form reaches into. A field holding one must be skipped or
// reached by hand.
type Opaque =
	| ReadonlyMap<unknown, unknown>
	| ReadonlySet<unknown>
	| WeakMap<object, unknown>
	| WeakSet<object>
	| PromiseLike<unknown>
	| ((...parameters: Array<never>) => unknown)

// Counts the containers passed on the way to a node, so a recursive container
// type ends the search instead of the type checker.
type Depth = ReadonlyArray<unknown>

type DepthLimit = 6

// What a value holds that the search goes on into.
type Inner<Value> =
	Value extends ReadonlyMap<infer Key, infer Item>
		? Key | Item
		: Value extends ReadonlySet<infer Item>
			? Item
			: Value extends WeakMap<infer Key, infer Item>
				? Key | Item
				: Value extends WeakSet<infer Item>
					? Item
					: Value extends PromiseLike<infer Item>
						? Item
						: Value extends (
									...parameters: Array<never>
							  ) => infer Item
							? Item
							: Value extends ReadonlyArray<infer Item>
								? Item
								: Value[keyof Value]

// Whether a value reaches a node, through collections, functions and plain
// containers. A Type is never searched, so a Case payload default it carries is
// no child.
type HoldsNode<Value, Seen extends Depth = []> = Value extends NodeLike
	? true
	: Value extends Primitive | common.Type
		? false
		: Seen["length"] extends DepthLimit
			? false
			: Value extends object
				? HoldsNode<Inner<Value>, [...Seen, unknown]>
				: false

// The nodes a value reaches, stopping at each.
type HeldNodes<Value, Seen extends Depth = []> = Value extends NodeLike
	? Value
	: Value extends Primitive | common.Type
		? never
		: Seen["length"] extends DepthLimit
			? never
			: Value extends object
				? HeldNodes<Inner<Value>, [...Seen, unknown]>
				: never

type NodeKeys<Container> = {
	[Key in keyof Container]-?: true extends HoldsNode<Container[Key]>
		? Key
		: never
}[keyof Container]

// A union of containers, such as a String's segments, is read per member.
type ContainerKeys<Container> = Container extends unknown
	? NodeKeys<Container>
	: never

type FieldValue<Container, Key> = Container extends unknown
	? Key extends keyof Container
		? Container[Key]
		: never
	: never

type HeldBy<Node> = Node extends unknown ? HeldNodes<Node[keyof Node]> : never

// The kinds a listed node holds that the node union leaves out.
type Unlisted<Node extends NodeLike> =
	HeldBy<Node> extends infer Held
		? Held extends NodeLike
			? [Extract<Node, { nodeType: Held["nodeType"] }>] extends [never]
				? Held
				: never
			: never
		: never

// The listed type a held node is checked against. That is the member of its
// `kind` where one is listed, else every member of its `nodeType`.
type ListedAs<Node, Held extends NodeLike> = Held extends { kind: infer Kind }
	? [Extract<Node, { nodeType: Held["nodeType"]; kind: Kind }>] extends [
			never,
		]
		? Extract<Node, { nodeType: Held["nodeType"] }>
		: Extract<Node, { nodeType: Held["nodeType"]; kind: Kind }>
	: Extract<Node, { nodeType: Held["nodeType"] }>

// The kinds a listed node holds as a subtype with node fields that the listed
// type, and so its entry, lacks. A node told apart by `kind` is checked against
// its own `kind`'s entry.
type Widened<Node extends NodeLike> =
	HeldBy<Node> extends infer Held
		? Held extends NodeLike
			? [
					Exclude<
						NodeKeys<Held>,
						ContainerKeys<ListedAs<Node, Held>>
					>,
				] extends [never]
				? never
				: Held
			: never
		: never

export type Key = number | string | undefined

// Where a child stands. `container` is the node's own field holding the
// container the child sits in, and undefined for a field of the node itself.
export type Place = { field: string; container: string | undefined }

// Calls `visit` on one child, with where it stands and its index or key.
export type Visit = (
	node: NodeLike,
	state: unknown,
	field: string,
	key: Key,
	container: string | undefined,
) => unknown

// A hand-written reach, for a field the data forms can not describe. It
// receives the node or container holding the field, and must honour `stops`
// by calling `visitChild`. The type checker does not see inside it.
export type Custom<Value, Owner> = {
	custom: (
		value: Value,
		owner: Owner,
		visit: Visit,
		state: unknown,
		stops: boolean,
		key: Key,
		place: Place,
	) => unknown
}

// How a field reaches its children. `"skip"` declares a field that holds
// nodes but is no child, and the table says why beside it.
export type Reach<Value, Owner> =
	| "skip"
	| Custom<Value, Owner>
	| Shape<NonNullable<Value>>

type Indexed<Item> = [Item] extends [NodeLike]
	? "values"
	: { values: Entry<Item> }

type Shape<Value> = [Value] extends [NodeLike]
	? "node"
	: [Value] extends [Opaque]
		? never
		: [Value] extends [ReadonlyArray<infer Item>]
			? [Item] extends [NodeLike]
				? "nodes"
				: { each: Entry<Item> }
			: string extends keyof Value
				? Indexed<Value[keyof Value]>
				: number extends keyof Value
					? Indexed<Value[keyof Value]>
					: { fields: Entry<Value> }

// Every field of a node or container that holds a node, each with its reach.
// The key order is the visiting order: source order, or the order the
// simplified tree runs in. A field named `kinds` would read as `KindEntries`.
export type Entry<Container> =
	"kinds" extends ContainerKeys<Container>
		? "rename the field, since `kinds` marks an entry per kind"
		: {
				[Key in ContainerKeys<Container>]: Reach<
					FieldValue<Container, Key>,
					Container
				>
			}

// The entries of a kind whose nodes share a `nodeType` and differ by `kind`,
// one per `kind`.
export type KindEntries<Node> = [Node] extends [{ kind: string }]
	? {
			kinds: {
				[Kind in Node["kind"]]: Entry<Extract<Node, { kind: Kind }>>
			}
		}
	: "this kind has no `kind` to tell its nodes apart by"

// One entry per kind of `Node`, and per `kind` of each kind `ByKind` names. A
// kind the union leaves out is a required key whose value is a sentence, so
// the error names it. So is a kind held with node fields its entry does not
// reach.
export type Table<Node extends NodeLike, ByKind extends string = never> = {
	[Kind in Exclude<Node["nodeType"], ByKind>]: Entry<
		Extract<Node, { nodeType: Kind }>
	>
} & {
	[Kind in Extract<Node["nodeType"], ByKind>]: KindEntries<
		Extract<Node, { nodeType: Kind }>
	>
} & {
	[Kind in Unlisted<Node>["nodeType"]]: "list this kind in the node union"
} & {
	[Kind in Widened<Node>["nodeType"] as `${Kind}, held with more fields`]: "a field holds this kind with node fields its entry lacks"
}

export function isAtOrBefore(a: common.Cursor, b: common.Cursor): boolean {
	return a.line < b.line || (a.line === b.line && a.column <= b.column)
}

export function visitChild(
	node: NodeLike,
	visit: Visit,
	state: unknown,
	stops: boolean,
	key: Key,
	place: Place,
): unknown {
	let result = visit(node, state, place.field, key, place.container)

	return stops ? result : undefined
}

// A reach compiled with its Place, so a visit passes only what changes.
type Reacher = (
	value: unknown,
	owner: unknown,
	visit: Visit,
	state: unknown,
	stops: boolean,
	key: Key,
) => unknown

export type CompiledEntry = {
	keys: Array<string>
	reachers: Array<Reacher>
}

// `key` is the index or key in the outermost collection between the node and
// the container. So every field of a Handler carries the Handler's index.
export function applyEntry(
	entry: CompiledEntry,
	container: unknown,
	visit: Visit,
	state: unknown,
	stops: boolean,
	key: Key,
): unknown {
	let fields = container as Record<string, unknown>

	for (let index = 0; index < entry.keys.length; index++) {
		let result = entry.reachers[index](
			fields[entry.keys[index]],
			container,
			visit,
			state,
			stops,
			key,
		)

		if (result !== undefined) {
			return result
		}
	}

	return undefined
}

type Section = NodeLike & { position: common.Position }

const exportsPlace: Place = { field: "exports", container: undefined }

const testsPlace: Place = { field: "tests", container: undefined }

// The export and tests blocks may stand in either order below the
// implementation, so the two are visited in the order they were written in.
export function visitSectionsBelow(
	exports: Section | null,
	tests: Section | null,
	visit: Visit,
	state: unknown,
	stops: boolean,
): unknown {
	let testsFirst =
		exports !== null &&
		tests !== null &&
		isAtOrBefore(tests.position.start, exports.position.start)
	let first = testsFirst ? tests : exports
	let second = testsFirst ? exports : tests
	let result =
		first === null
			? undefined
			: visitChild(
					first,
					visit,
					state,
					stops,
					undefined,
					testsFirst ? testsPlace : exportsPlace,
				)

	if (result !== undefined || second === null) {
		return result
	}

	return visitChild(
		second,
		visit,
		state,
		stops,
		undefined,
		testsFirst ? exportsPlace : testsPlace,
	)
}

type Named = { name: { position: common.Position } }

type Members = {
	properties: Record<string, Named>
	methods: Record<string, Named & NodeLike>
}

const methodsPlace: Place = { field: "methods", container: undefined }

// A Namespace's properties and Methods are two Records, visited as one list in
// the order they were written in. Each is placed by its name. `property` is
// compiled with `properties` as its container.
export function visitInterleaved(
	namespace: Members,
	property: CompiledEntry,
	visit: Visit,
	state: unknown,
	stops: boolean,
): unknown {
	let previous: common.Cursor | null = null

	for (let name in namespace.methods) {
		let method = namespace.methods[name]
		let start = method.name.position.start
		let result =
			visitProperties(
				namespace,
				previous,
				start,
				property,
				visit,
				state,
				stops,
			) ?? visitChild(method, visit, state, stops, name, methodsPlace)

		if (result !== undefined) {
			return result
		}

		// The bound only moves forward, so a Method out of written order, as a
		// duplicate is, never reopens a property already visited.
		if (previous === null || !isAtOrBefore(start, previous)) {
			previous = start
		}
	}

	return visitProperties(
		namespace,
		previous,
		null,
		property,
		visit,
		state,
		stops,
	)
}

// The properties written after `after` and up to `until`. A scan rather than
// a merge of two lists, which would build both lists per Namespace visited.
function visitProperties(
	namespace: Members,
	after: common.Cursor | null,
	until: common.Cursor | null,
	property: CompiledEntry,
	visit: Visit,
	state: unknown,
	stops: boolean,
): unknown {
	for (let name in namespace.properties) {
		let written = namespace.properties[name]
		let start = written.name.position.start

		if (
			(after !== null && isAtOrBefore(start, after)) ||
			(until !== null && !isAtOrBefore(start, until))
		) {
			continue
		}

		let result = applyEntry(property, written, visit, state, stops, name)

		if (result !== undefined) {
			return result
		}
	}

	return undefined
}

function reachNode(place: Place): Reacher {
	return (value, _owner, visit, state, stops, key) =>
		value === null || value === undefined
			? undefined
			: visitChild(value as NodeLike, visit, state, stops, key, place)
}

function reachNodes(place: Place): Reacher {
	return (value, _owner, visit, state, stops, key) => {
		if (value === null || value === undefined) {
			return undefined
		}

		let nodes = value as ReadonlyArray<NodeLike>

		for (let index = 0; index < nodes.length; index++) {
			let result = visitChild(
				nodes[index],
				visit,
				state,
				stops,
				key ?? index,
				place,
			)

			if (result !== undefined) {
				return result
			}
		}

		return undefined
	}
}

// A `for … in` rather than `Object.values`, which would build an Array per
// visited node.
function reachValues(place: Place): Reacher {
	return (value, _owner, visit, state, stops, key) => {
		if (value === null || value === undefined) {
			return undefined
		}

		let record = value as Record<string, NodeLike>

		for (let name in record) {
			let result = visitChild(
				record[name],
				visit,
				state,
				stops,
				key ?? name,
				place,
			)

			if (result !== undefined) {
				return result
			}
		}

		return undefined
	}
}

function reachEach(entry: CompiledEntry): Reacher {
	return (value, _owner, visit, state, stops, key) => {
		if (value === null || value === undefined) {
			return undefined
		}

		let items = value as ReadonlyArray<unknown>

		for (let index = 0; index < items.length; index++) {
			let result = applyEntry(
				entry,
				items[index],
				visit,
				state,
				stops,
				key ?? index,
			)

			if (result !== undefined) {
				return result
			}
		}

		return undefined
	}
}

function reachEachValue(entry: CompiledEntry): Reacher {
	return (value, _owner, visit, state, stops, key) => {
		if (value === null || value === undefined) {
			return undefined
		}

		let record = value as Record<string, unknown>

		for (let name in record) {
			let result = applyEntry(
				entry,
				record[name],
				visit,
				state,
				stops,
				key ?? name,
			)

			if (result !== undefined) {
				return result
			}
		}

		return undefined
	}
}

type AnyReach =
	| "skip"
	| "node"
	| "nodes"
	| "values"
	| Custom<unknown, unknown>
	| { each: AnyEntry }
	| { values: AnyEntry }
	| { fields: AnyEntry }

type AnyEntry = Record<string, AnyReach>

// A container's entry is compiled with the node's field holding it, which
// every child inside it reports as its container.
function compileReach(reach: AnyReach, place: Place): Reacher {
	if (reach === "node") {
		return reachNode(place)
	}

	if (reach === "nodes") {
		return reachNodes(place)
	}

	if (reach === "values") {
		return reachValues(place)
	}

	if (reach === "skip") {
		throw new Error("A skipped field has no reacher.")
	}

	if ("custom" in reach) {
		let custom = reach.custom

		return (value, owner, visit, state, stops, key) =>
			custom(value, owner, visit, state, stops, key, place)
	}

	let container = place.container ?? place.field

	if ("each" in reach) {
		return reachEach(compileEntry(reach.each, container))
	}

	if ("values" in reach) {
		return reachEachValue(compileEntry(reach.values, container))
	}

	let entry = compileEntry(reach.fields, container)

	return (value, _owner, visit, state, stops, key) =>
		value === null || value === undefined
			? undefined
			: applyEntry(entry, value, visit, state, stops, key)
}

// `container` is the node's field holding the container this entry describes,
// and undefined for a node's own entry.
export function compileEntry(
	entry: object,
	container: string | undefined,
): CompiledEntry {
	let keys: Array<string> = []
	let reachers: Array<Reacher> = []

	for (let [key, reach] of Object.entries(entry as AnyEntry)) {
		if (reach === "skip") {
			continue
		}

		keys.push(key)
		reachers.push(compileReach(reach, { field: key, container }))
	}

	return { keys, reachers }
}

// What a walker's visit receives. Beside the child and the walker's state, it
// says where the child stands. See "Walking with the tables" in
// DEVELOPMENT.md.
export type ChildVisit<Node, State, Result> = (
	child: Node,
	state: State,
	field: string,
	key: Key,
	container: string | undefined,
) => Result

// The two walks one table serves. `forEachChild` visits every child and
// ignores what `visit` answers. `findChild` stops at the first child whose
// visit answers anything but `undefined`, and answers that.
export type ChildWalks<Node extends NodeLike> = {
	forEachChild<State>(
		node: Node,
		visit: ChildVisit<Node, State, unknown>,
		state: State,
	): void
	findChild<State, Result>(
		node: Node,
		visit: ChildVisit<Node, State, Result | undefined>,
		state: State,
	): Result | undefined
}

export function childWalks<Node extends NodeLike, ByKind extends string>(
	table: Table<Node, ByKind>,
): ChildWalks<Node> {
	let entries: Record<string, CompiledEntry | undefined> = Object.create(null)
	let kindEntries: Record<
		string,
		Record<string, CompiledEntry | undefined> | undefined
	> = Object.create(null)

	for (let [nodeType, entry] of Object.entries(
		table as Record<string, object>,
	)) {
		if (!("kinds" in entry)) {
			entries[nodeType] = compileEntry(entry, undefined)

			continue
		}

		let compiled: Record<string, CompiledEntry> = Object.create(null)

		for (let [kind, kindEntry] of Object.entries(
			entry.kinds as Record<string, object>,
		)) {
			compiled[kind] = compileEntry(kindEntry, undefined)
		}

		kindEntries[nodeType] = compiled
	}

	function entryOf(node: Node): CompiledEntry {
		let entry =
			entries[node.nodeType] ??
			kindEntries[node.nodeType]?.[(node as { kind?: string }).kind ?? ""]

		if (entry === undefined) {
			throw new Error(`No child table entry for '${node.nodeType}'.`)
		}

		return entry
	}

	return {
		forEachChild(node, visit, state) {
			applyEntry(
				entryOf(node),
				node,
				visit as Visit,
				state,
				false,
				undefined,
			)
		},
		findChild<State, Result>(
			node: Node,
			visit: ChildVisit<Node, State, Result | undefined>,
			state: State,
		) {
			return applyEntry(
				entryOf(node),
				node,
				visit as Visit,
				state,
				true,
				undefined,
			) as Result | undefined
		},
	}
}
