import * as path from "node:path"

import type { EssenceValue, RuntimeBridge } from "../bridge"
import { type EssenceModule, loadModule } from "../index"

// NOTE: What the marshalled door COSTS, measured against the door it was built
// beside. A host that binds `raw` and the bridge itself builds every value by
// hand and reads every answer apart by hand; `exports` does the same walk out
// of a Descriptor, and checks, normalises and spells a path while it goes. The
// difference between the two is the whole of what marshalling charges, and this
// file is the only place it is a number rather than an impression.
//
// Run it with `bun packages/client/src/tools/bench.ts`, and keep the answer in
// `BENCH.md`. `tools/` is excluded from the publish program, so nothing here
// ships.
//
// NOTE: The two calls are an embedding's own rather than a microbenchmark's: a
// nested List and its labels in and a flat List of Records out — a table being
// laid out — and a mid-size Record edited and handed back.
// `tests/files/Bench.es` holds them.
//
// NOTE: Both doors are timed over the SAME work — build the Arguments from
// JavaScript values, call, read the answer back as JavaScript values. Timing
// the call alone would time the Module rather than the boundary, so the call is
// ALSO timed alone, with its Arguments already built and its answer unread:
// that is the `body` column, it is the same in both doors, and subtracting it
// is what leaves the door on its own.
//
// NOTE: What the hand-built door does not do is the point of the comparison. It
// takes every shape on trust, normalises no String, and has no path to spell
// when something is wrong — so it is the floor the marshalled door is measured
// against, not a second implementation of it.

const FIXTURE = path.join(
	import.meta.dirname,
	"..",
	"tests",
	"files",
	"Bench.es",
)

// NOTE: One node is one value the boundary VISITS in a call, counting both
// directions — every List box, every Record, every Case and every leaf. It is
// what the per-value columns divide by, and the only honest way to compare a
// call over 21 values with one over 8191.
//
// `layout` visits, going in, the rows List, each row's own List and each
// Integer in it, the labels List and each String; coming out, the answer List
// and, per row, the Record and its two members. That is `3 + rows × (columns +
// 5)`.
function layoutNodes(rows: number, columns: number): number {
	return 3 + rows * (columns + 5)
}

// NOTE: The three magnitudes the field measured this at — a handful of values,
// a thousand, eight thousand — as the squarest shapes that land on them. 21 is
// the nearest a `rows × columns` table gets to the field's 22: `3 + rows ×
// (columns + 5) = 22` has only the one-row solution, and one row is not a table.
const LAYOUT_SHAPES: Array<{ rows: number; columns: number }> = [
	{ rows: 2, columns: 4 },
	{ rows: 30, columns: 29 },
	{ rows: 89, columns: 87 },
]

// NOTE: What a Panel costs to cross: the Record itself, its five plain members,
// the Case its `note` is and the String that Case carries, its `tags` List and
// the three Strings in it — twelve values. Going in there is the Integer beside
// it, and coming out there is not.
const PANEL_NODES = 13 + 12

const SAMPLES = 15
const SAMPLE_NANOSECONDS = 8_000_000
const WARMUP_NANOSECONDS = 20_000_000
const WARMUP_TURNS = 20
const SETTLE_NANOSECONDS = 20_000_000
const SETTLE_TURNS = 50

// NOTE: Both Integers a host may pass. Out is always a bigint — that is the
// contract — so the kind names what goes IN.
const KINDS: Array<Kind> = ["bigint", "number"]

// NOTE: Every measured turn adds its answer here, and the total is printed at
// the end. A door whose result nothing reads is a door an optimiser is entitled
// to stop opening — this is what keeps all of them open.
let sink = 0

type Cell = { index: bigint; status: string }

type Panel = {
	id: bigint | number
	title: string
	width: bigint | number
	height: bigint | number
	visible: boolean
	note: string | undefined
	tags: Array<string>
}

// NOTE: A List as the runtime lays one out — two runs and a view into each, the
// front run stored reversed. A host reading `value` alone reads neither the
// right items nor the right number of them, so a hand-built door has to know
// this much; `marshal-runtime.ts` says why at length.
type ListBox = {
	value: Array<unknown>
	length?: number
	front?: Array<unknown>
	frontLen?: number
}

type Kind = "bigint" | "number"

// NOTE: One line of the table before it has been timed — what is being crossed,
// and the three pieces of work that cross it.
type Case = {
	shape: string
	nodes: number
	kind: Kind
	body: () => number
	raw: () => number
	marshalled: () => number
}

// NOTE: What one run answers with, and what the parent process reads back. The
// sink travels with it so that the answers are read by a process that prints
// them, rather than only by one that is about to exit.
type Measured = { layouts: Array<Row>; edits: Array<Row>; sink: number }

type Row = {
	shape: string
	nodes: number
	kind: Kind
	body: number
	raw: number
	marshalled: number
}

// #region The data

// NOTE: Deterministic, so that two runs measure the same work. The cells are
// small on purpose — an Integer whose value fits a double is the one the hybrid
// representation keeps as a number, and a bench built out of huge values would
// be measuring bigint arithmetic instead of the door.
function rowsOf(
	rows: number,
	columns: number,
	kind: Kind,
): Array<Array<bigint | number>> {
	let built: Array<Array<bigint | number>> = []

	for (let row = 0; row < rows; row++) {
		let cells: Array<bigint | number> = []

		for (let column = 0; column < columns; column++) {
			let value = ((row * columns + column) % 97) + 1

			cells.push(kind === "bigint" ? BigInt(value) : value)
		}

		built.push(cells)
	}

	return built
}

function labelsOf(rows: number): Array<string> {
	let labels: Array<string> = []

	for (let row = 0; row < rows; row++) {
		labels.push(`row ${row}`)
	}

	return labels
}

function panelOf(kind: Kind): Panel {
	let held = (value: number): bigint | number =>
		kind === "bigint" ? BigInt(value) : value

	return {
		id: held(1),
		title: "the panel",
		width: held(320),
		height: held(240),
		visible: true,
		note: "resized by the bench",
		tags: ["chrome", "resizable", "measured"],
	}
}

// #endregion

// #region The hand-built door

// NOTE: The boundary a host wrote itself, before there was one to import: the
// bridge's constructors on the way in, the runtime's own layout read straight
// off the values on the way out. Nothing is checked, because a host writing this
// knows what it is passing — which is exactly the assumption the marshalled door
// is not allowed to make.
function rowsValue(
	bridge: RuntimeBridge,
	rows: Array<Array<bigint | number>>,
): EssenceValue {
	let built: Array<EssenceValue> = []

	for (let row of rows) {
		let cells: Array<EssenceValue> = []

		for (let cell of row) {
			cells.push(bridge.integer(cell))
		}

		built.push(bridge.list(cells))
	}

	return bridge.list(built)
}

function labelsValue(
	bridge: RuntimeBridge,
	labels: Array<string>,
): EssenceValue {
	let built: Array<EssenceValue> = []

	for (let label of labels) {
		built.push(bridge.string(label))
	}

	return bridge.list(built)
}

function cellsOf(answer: unknown): Array<Cell> {
	let box = answer as ListBox
	let back = box.value
	let backCount = box.length ?? back.length
	let front = box.front
	let frontCount = front === undefined ? 0 : (box.frontLen ?? front.length)
	let total = frontCount + backCount
	let cells: Array<Cell> = []

	for (let position = 0; position < total; position++) {
		let item = (
			position < frontCount
				? front![frontCount - 1 - position]
				: back[position - frontCount]
		) as { index: { value: number | bigint }; status: { value: string } }

		cells.push({
			// NOTE: A bigint whichever of its two representations the Integer
			// arrived in, which is the contract the marshalled door states — a
			// host comparing the two has to be handed the same kind by both.
			index: BigInt(item.index.value),
			status: item.status.value,
		})
	}

	return cells
}

function panelValue(bridge: RuntimeBridge, panel: Panel): EssenceValue {
	let tags: Array<EssenceValue> = []

	for (let tag of panel.tags) {
		tags.push(bridge.string(tag))
	}

	return bridge.record({
		id: bridge.integer(panel.id),
		title: bridge.string(panel.title),
		width: bridge.integer(panel.width),
		height: bridge.integer(panel.height),
		visible: bridge.boolean(panel.visible),
		note:
			panel.note === undefined
				? bridge.case("Optional#Empty")
				: bridge.case("Optional#Value", {
						item: bridge.string(panel.note),
					}),
		tags: bridge.list(tags),
	})
}

function panelFrom(bridge: RuntimeBridge, answer: unknown): Panel {
	let record = answer as {
		id: { value: bigint | number }
		title: { value: string }
		width: { value: bigint | number }
		height: { value: bigint | number }
		visible: { value: boolean }
		note: Record<symbol, unknown> & { item?: { value: string } }
		tags: ListBox
	}
	let note = record.note
	let box = record.tags
	let count = box.length ?? box.value.length
	let tags: Array<string> = []

	for (let position = 0; position < count; position++) {
		tags.push((box.value[position] as { value: string }).value)
	}

	return {
		id: BigInt(record.id.value),
		title: record.title.value,
		width: BigInt(record.width.value),
		height: BigInt(record.height.value),
		visible: record.visible.value,
		note:
			note[bridge.typeKey] === "Optional#Value"
				? note.item!.value
				: undefined,
		tags,
	}
}

// #endregion

// #region The measurement

// NOTE: Warmed until the code under it has settled, then timed in batches sized
// so that one sample is milliseconds rather than microseconds — a clock read per
// call would be measuring the clock at the sizes that matter most. The MEDIAN of
// the samples is reported: a mean carries whatever else the machine was doing
// during the slowest of them.
function measure(work: () => number): number {
	Bun.gc(true)

	let started = Bun.nanoseconds()
	let turns = 0

	while (
		turns < WARMUP_TURNS ||
		Bun.nanoseconds() - started < WARMUP_NANOSECONDS
	) {
		sink += work()
		turns++
	}

	let each = (Bun.nanoseconds() - started) / turns
	let batch = Math.max(1, Math.round(SAMPLE_NANOSECONDS / each))
	let samples: Array<number> = []

	for (let sample = 0; sample < SAMPLES; sample++) {
		let from = Bun.nanoseconds()

		for (let turn = 0; turn < batch; turn++) {
			sink += work()
		}

		samples.push((Bun.nanoseconds() - from) / batch)
	}

	samples.sort((left, right) => left - right)

	return samples[(SAMPLES - 1) / 2]! / 1000
}

// NOTE: Every path is run before ANY of them is timed, and that is not the same
// as the warm-up inside `measure`. All three doors of all four cases share the
// same Functions — the same builder, the same reader, the same `fromJS` — so a
// door timed before the others have ever run is timed against an engine that has
// seen nothing else, and one timed last against an engine that has seen
// everything. Settling them all first is what makes the table's first row as
// trustworthy as its last.
function settle(work: () => number): void {
	let started = Bun.nanoseconds()
	let turns = 0

	while (
		turns < SETTLE_TURNS ||
		Bun.nanoseconds() - started < SETTLE_NANOSECONDS
	) {
		sink += work()
		turns++
	}
}

// NOTE: The two doors are made to agree BEFORE either is timed. A comparison
// between a door that answers and a door that answers something else is not a
// comparison — and since the hand-built one is written out here rather than
// imported, this is also what says the two readings of a runtime List are the
// same reading.
function agree(marshalled: unknown, raw: unknown, what: string): void {
	let shown = (value: unknown) =>
		JSON.stringify(value, (_, held) =>
			typeof held === "bigint" ? `${held}n` : held,
		)

	if (shown(marshalled) !== shown(raw)) {
		throw new Error(
			`The two doors disagree about ${what}:\n` +
				`  raw:        ${shown(raw)}\n` +
				`  marshalled: ${shown(marshalled)}`,
		)
	}
}

// #endregion

// #region The report

// NOTE: What the door alone costs per value crossed, in nanoseconds — the
// Module's own call taken back out of the total, and what is left divided by the
// values that crossed. The one number two shapes can be compared by.
function perNode(total: number, body: number, nodes: number): string {
	return (((total - body) * 1000) / nodes).toFixed(1)
}

function table(rows: Array<Row>): string {
	let header = [
		"shape",
		"nodes",
		"in",
		"body µs",
		"raw µs",
		"marshalled µs",
		"×",
		"raw ns/node",
		"marshalled ns/node",
	]
	let body = rows.map((row) => [
		row.shape,
		`${row.nodes}`,
		row.kind,
		row.body.toFixed(2),
		row.raw.toFixed(2),
		row.marshalled.toFixed(2),
		`${(row.marshalled / row.raw).toFixed(2)}×`,
		perNode(row.raw, row.body, row.nodes),
		perNode(row.marshalled, row.body, row.nodes),
	])
	let widths = header.map((name, column) =>
		Math.max(name.length, ...body.map((cells) => cells[column]!.length)),
	)
	let line = (cells: Array<string>) =>
		cells
			.map((cell, column) => cell.padStart(widths[column]!))
			.join("  ")
			.trimEnd()

	return [
		line(header),
		line(widths.map((width) => "-".repeat(width))),
		...body.map(line),
	].join("\n")
}

// NOTE: Which commit the table below was measured at, so that a pasted one says
// so on its own — and whether the tree it was measured on was that commit. A
// checkout without git — a published tarball — simply does not say.
function revision(): string {
	try {
		let named = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])

		if (!named.success) {
			return "unknown"
		}

		let changes = Bun.spawnSync(["git", "status", "--porcelain"])
		let dirty = changes.success && changes.stdout.toString().trim() !== ""

		return `${named.stdout.toString().trim()}${dirty ? " + uncommitted changes" : ""}`
	} catch {
		return "unknown"
	}
}

// #endregion

// #region The runs

function layoutCase(
	module: EssenceModule,
	shape: { rows: number; columns: number },
	kind: Kind,
): Case {
	let bridge = module.bridge
	let call = module.raw.layout as (
		...args: Array<EssenceValue>
	) => EssenceValue
	let layout = module.exports.layout as (
		rows: Array<Array<bigint | number>>,
		labels: Array<string>,
	) => Array<Cell>
	let cells = rowsOf(shape.rows, shape.columns, kind)
	let labels = labelsOf(shape.rows)
	let builtRows = rowsValue(bridge, cells)
	let builtLabels = labelsValue(bridge, labels)

	agree(
		layout(cells, labels),
		cellsOf(call(builtRows, builtLabels)),
		`layout at ${shape.rows}×${shape.columns}`,
	)

	return {
		shape: `${shape.rows}×${shape.columns}`,
		nodes: layoutNodes(shape.rows, shape.columns),
		kind,
		body: () => (call(builtRows, builtLabels) as ListBox).value.length,
		raw: () =>
			cellsOf(call(rowsValue(bridge, cells), labelsValue(bridge, labels)))
				.length,
		marshalled: () => layout(cells, labels).length,
	}
}

function resizeCase(module: EssenceModule, kind: Kind): Case {
	let bridge = module.bridge
	let call = module.raw.resize as (
		...args: Array<EssenceValue>
	) => EssenceValue
	let resize = module.exports.resize as (
		panel: Panel,
		amount: bigint | number,
	) => Panel
	let panel = panelOf(kind)
	let amount = kind === "bigint" ? 8n : 8
	let built = panelValue(bridge, panel)
	let builtAmount = bridge.integer(amount)

	agree(
		resize(panel, amount),
		panelFrom(bridge, call(built, builtAmount)),
		"resize",
	)

	return {
		shape: "panel",
		nodes: PANEL_NODES,
		kind,
		body: () =>
			(call(built, builtAmount) as { tags: ListBox }).tags.value.length,
		raw: () =>
			panelFrom(
				bridge,
				call(panelValue(bridge, panel), bridge.integer(amount)),
			).tags.length,
		marshalled: () => resize(panel, amount).tags.length,
	}
}

function timed(entry: Case): Row {
	return {
		shape: entry.shape,
		nodes: entry.nodes,
		kind: entry.kind,
		body: measure(entry.body),
		raw: measure(entry.raw),
		marshalled: measure(entry.marshalled),
	}
}

// NOTE: ONE kind of Integer per process, and the two runs are two processes.
// `createIntegerFrom` is one Function, and a caller that hands it both a bigint
// and a number in the same run leaves the engine no monomorphic path to compile:
// the number half then measures nearly THREE TIMES its own cost — 206 µs against
// 74 µs for the same 7743 values — and the table said, wrongly, that numbers
// cross more slowly than bigints. Neither door is at fault and neither is the
// runtime; a host passes one kind, and a measurement that passes two is
// measuring something no host does.
async function measured(kind: Kind): Promise<Measured> {
	let module: EssenceModule = await loadModule(FIXTURE)
	let layouts = LAYOUT_SHAPES.map((shape) => layoutCase(module, shape, kind))
	let edits = [resizeCase(module, kind)]

	for (let entry of [...layouts, ...edits]) {
		settle(entry.body)
		settle(entry.raw)
		settle(entry.marshalled)
	}

	let laidOut = layouts.map(timed)
	let resized = edits.map(timed)

	return { layouts: laidOut, edits: resized, sink }
}

function isKind(value: string | undefined): value is Kind {
	return value === "bigint" || value === "number"
}

// NOTE: The child writes its rows and nothing else — the tables are the
// parent's, so that both kinds are laid out under one heading whichever order
// the runs finished in.
async function main(): Promise<void> {
	let asked = process.argv[2]

	if (isKind(asked)) {
		process.stdout.write(JSON.stringify(await measured(asked)))

		return
	}

	let layouts: Array<Row> = []
	let edits: Array<Row> = []
	let answers = 0

	for (let kind of KINDS) {
		let run = Bun.spawnSync([process.execPath, import.meta.path, kind], {
			stderr: "inherit",
		})

		if (!run.success) {
			throw new Error(`The ${kind} run failed.`)
		}

		let answered = JSON.parse(run.stdout.toString()) as Measured

		layouts.push(...answered.layouts)
		edits.push(...answered.edits)
		answers += answered.sink
	}

	console.log(
		`\nThe marshalling boundary against the raw bridge — ${revision()}` +
			`\nBun ${Bun.version} · ${process.platform} ${process.arch} · ` +
			`median of ${SAMPLES} samples, one process per kind\n`,
	)
	console.log(
		"layout(_ rows: List<List<Integer>>, _ labels: List<String>) " +
			"-> List<{ index: Integer, status: String }>\n",
	)
	console.log(table(layouts))
	console.log("\nresize(_ panel: Panel, _ amount: Integer) -> Panel\n")
	console.log(table(edits))
	console.log(
		"\nbody: the Module's own call, its Arguments already built and its " +
			"answer unread — the same\n" +
			"      work under both doors. ns/node: what the door ALONE costs " +
			"per value crossed,\n" +
			"      (µs − body) ÷ nodes.\n",
	)
	console.log(`(${answers} answers read, so that no door was elided.)`)
}

// #endregion

await main()
