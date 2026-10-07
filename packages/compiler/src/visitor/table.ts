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

// Where a visit can report a child of `Container`: the field it names, the
// container it names, and the nodes held there. `Outer` is the node's own
// field holding the container being searched, or undefined for the node.
type Places<Container, Outer, Seen extends Depth> = Container extends unknown
	? {
			[Key in NodeKeys<Container>]-?: PlacesOf<
				Key,
				Outer,
				NonNullable<Container[Key]>,
				Seen
			>
		}[NodeKeys<Container>]
	: never

type PlacesOf<Field, Outer, Value, Seen extends Depth> = Value extends
	| NodeLike
	| Opaque
	? { field: Field; container: Outer; child: HeldNodes<Value> }
	: Value extends ReadonlyArray<infer Item>
		? ItemPlaces<Field, Outer, Item, Seen>
		: string extends keyof Value
			? ItemPlaces<Field, Outer, Value[keyof Value], Seen>
			: number extends keyof Value
				? ItemPlaces<Field, Outer, Value[keyof Value], Seen>
				: Deeper<Value, Field, Outer, Seen>

type ItemPlaces<Field, Outer, Item, Seen extends Depth> = Item extends NodeLike
	? { field: Field; container: Outer; child: Item }
	: Deeper<Item, Field, Outer, Seen>

// A container's fields are reported with the outermost field holding it.
type Deeper<Container, Field, Outer, Seen extends Depth> = Container extends
	| Primitive
	| common.Type
	? never
	: Seen["length"] extends DepthLimit
		? never
		: Places<
				Container,
				[Outer] extends [undefined] ? Field : Outer,
				[...Seen, unknown]
			>

// The names a visit of a child of `Node` can receive as `field`. A field the
// table skips is among them. See "Walking with the tables" in DEVELOPMENT.md.
export type FieldOf<Node> = Places<Node, undefined, []>["field"]

// The names a visit of a child of `Node` can receive as `container`. It is
// undefined for a child in a field of `Node` itself.
export type ContainerOf<Node> = Places<Node, undefined, []>["container"]

// Each field of each kind of `Node` whose visit can hand on a `Child`, as
// `{ kind, field }`, for a table keyed by kind and field.
export type FieldsHolding<Node, Child> = Node extends NodeLike
	? KindFieldsHolding<Places<Node, undefined, []>, Node["nodeType"], Child>
	: never

type KindFieldsHolding<Place, Kind, Child> = Place extends {
	field: infer Field
	child: infer Held
}
	? Child extends Held
		? { kind: Kind; field: Field }
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

// An entry compiled to a function of the node or container it describes.
// `key` is the index or key in the outermost collection between the node and
// the container. So every field of a Handler carries the Handler's index.
export type CompiledEntry = (
	owner: unknown,
	visit: Visit,
	state: unknown,
	stops: boolean,
	key: Key,
) => unknown

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

		let result = property(written, visit, state, stops, name)

		if (result !== undefined) {
			return result
		}
	}

	return undefined
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

// The values a compiled function's source reads, such as a custom reach and
// its Place. Each is passed in as a parameter of the function that builds it.
type Bindings = { names: Array<string>; values: Array<unknown> }

function bind(bindings: Bindings, value: unknown): string {
	let name = `bound${bindings.names.length}`

	bindings.names.push(name)
	bindings.values.push(value)

	return name
}

// `label` names the built function in a stack trace, as the script
// `essence-visitor/<label>.js`, and its last part names the function itself.
function build<Built>(
	bindings: Bindings,
	label: string,
	parameters: string,
	body: Array<string>,
): Built {
	let name = label
		.slice(label.lastIndexOf("/") + 1)
		.replaceAll(/[^\w$]/g, "_")
	let source = [
		`return function ${name}(${parameters}) {`,
		...body,
		"}",
		`//# sourceURL=essence-visitor/${label}.js`,
	]
	let builder = new Function(...bindings.names, source.join("\n")) as (
		...values: Array<unknown>
	) => Built

	return builder(...bindings.values)
}

const stopAtVisit = "if (stops && result !== undefined) return result"

const stopAtEntry = "if (result !== undefined) return result"

// Runs `body` on each item of the Array or Record in `value`, whose index or
// key is `at`.
function eachSource(record: boolean, body: string): string {
	let loop = record
		? "for (let at in value)"
		: "for (let at = 0; at < value.length; at++)"

	return `if (value != null) ${loop} { ${body} }`
}

// The statements that visit what one field holds, read into `value` from
// `owner`, the node or container holding it. `label` is the owner's.
function reachSource(
	reach: Exclude<AnyReach, "skip">,
	place: Place,
	label: string,
	bindings: Bindings,
): string {
	let visit = (child: string, key: string) =>
		`result = visit(${child}, state, ${JSON.stringify(place.field)}, ${key}, ${JSON.stringify(place.container) ?? "undefined"}); ${stopAtVisit}`

	if (reach === "node") {
		return `if (value != null) { ${visit("value", "key")} }`
	}

	if (reach === "nodes" || reach === "values") {
		return eachSource(reach === "values", visit("value[at]", "key ?? at"))
	}

	if ("custom" in reach) {
		return `result = ${bind(bindings, reach.custom)}(value, owner, visit, state, stops, key, ${bind(bindings, place)}); ${stopAtEntry}`
	}

	let container = place.container ?? place.field
	let compiled = (entry: AnyEntry) =>
		bind(
			bindings,
			compileEntry(entry, container, `${label}.${place.field}`),
		)
	let apply = (entry: AnyEntry, item: string, key: string) =>
		`result = ${compiled(entry)}(${item}, visit, state, stops, ${key}); ${stopAtEntry}`

	if ("each" in reach) {
		return eachSource(false, apply(reach.each, "value[at]", "key ?? at"))
	}

	if ("values" in reach) {
		return eachSource(true, apply(reach.values, "value[at]", "key ?? at"))
	}

	return `if (value != null) { ${apply(reach.fields, "value", "key")} }`
}

// `container` is the node's field holding the container this entry describes,
// and undefined for a node's own entry. `label` names the tree and the kind,
// as `parser/Match`, and a container's field after them, as
// `parser/Match.handlers`. See "Compiled entries" in DEVELOPMENT.md.
export function compileEntry(
	entry: object,
	container: string | undefined,
	label: string,
): CompiledEntry {
	let bindings: Bindings = { names: [], values: [] }
	let statements: Array<string> = []

	for (let [field, reach] of Object.entries(entry as AnyEntry)) {
		if (reach !== "skip") {
			statements.push(
				`value = owner[${JSON.stringify(field)}]`,
				reachSource(reach, { field, container }, label, bindings),
			)
		}
	}

	return build(bindings, label, "owner, visit, state, stops, key", [
		"let value, result",
		...statements,
		"return undefined",
	])
}

// What a walker's visit receives. Beside the child and the walker's state, it
// says where the child stands among the fields of `Parent`, the node walked.
// See "Walking with the tables" in DEVELOPMENT.md.
export type ChildVisit<Node, State, Result, Parent = Node> = (
	child: Node,
	state: State,
	field: FieldOf<Parent>,
	key: Key,
	container: ContainerOf<Parent>,
) => Result

// The two walks one table serves. `forEachChild` visits every child and
// ignores what `visit` answers. `findChild` stops at the first child whose
// visit answers anything but `undefined`, and answers that.
export type ChildWalks<Node extends NodeLike> = {
	forEachChild<Parent extends Node, State>(
		node: Parent,
		visit: ChildVisit<Node, State, unknown, Parent>,
		state: State,
	): void
	findChild<Parent extends Node, State, Result>(
		node: Parent,
		visit: ChildVisit<Node, State, Result | undefined, Parent>,
		state: State,
	): Result | undefined
}

type Dispatch = (
	node: NodeLike,
	visit: Visit,
	state: unknown,
	stops: boolean,
) => unknown

// One `switch` over the table's kinds, and over the `kind`s of a kind told
// apart by them, which calls the kind's compiled entry. `tree` names the
// tree in each function's label.
function compileDispatch(
	table: Record<string, object>,
	tree: string,
): Dispatch {
	let bindings: Bindings = { names: [], values: [] }
	let call = (entry: object, label: string) =>
		`return ${bind(bindings, compileEntry(entry, undefined, label))}(node, visit, state, stops, undefined)`
	let cases = Object.entries(table).map(([nodeType, entry]) => {
		let label = `${tree}/${nodeType}`

		if (!("kinds" in entry)) {
			return `case ${JSON.stringify(nodeType)}: ${call(entry, label)}`
		}

		let kinds = Object.entries(entry.kinds as Record<string, object>).map(
			([kind, kindEntry]) =>
				`case ${JSON.stringify(kind)}: ${call(kindEntry, `${label}.${kind}`)}`,
		)

		return `case ${JSON.stringify(nodeType)}: switch (node.kind) { ${kinds.join("\n")} } break`
	})

	return build(bindings, `${tree}/dispatch`, "node, visit, state, stops", [
		"switch (node.nodeType) {",
		...cases,
		"}",
		"throw new Error(`No child table entry for '${node.nodeType}'.`)",
	])
}

// `tree` names the tree, as `parser`, in the stack traces of its walks.
export function childWalks<Node extends NodeLike, ByKind extends string>(
	table: Table<Node, ByKind>,
	tree: string,
): ChildWalks<Node> {
	let dispatch = compileDispatch(table as Record<string, object>, tree)

	return {
		forEachChild(node, visit, state) {
			dispatch(node, visit as Visit, state, false)
		},
		findChild<Parent extends Node, State, Result>(
			node: Parent,
			visit: ChildVisit<Node, State, Result | undefined, Parent>,
			state: State,
		) {
			return dispatch(node, visit as Visit, state, true) as
				| Result
				| undefined
		},
	}
}
