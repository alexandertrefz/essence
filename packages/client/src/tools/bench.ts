import * as path from "node:path"

import type { EssenceValue, RuntimeBridge } from "../bridge"
import { type EssenceModule, loadModule } from "../index"

// Times `exports` against a door built by hand from `raw` and the bridge, over
// the calls in `tests/files/Bench.es`. Run it with
// `bun packages/client/src/tools/bench.ts`. BENCH.md explains the columns and
// keeps the results. Nothing in `tools/` is published.

const FIXTURE = path.join(
	import.meta.dirname,
	"..",
	"tests",
	"files",
	"Bench.es",
)

// The values `layout` visits in both directions: three Lists, and per row its
// List, its Integers, its label, and a Record with two members.
function layoutNodes(rows: number, columns: number): number {
	return 3 + rows * (columns + 5)
}

// About 20, 1000 and 8000 values, as the squarest tables that reach them.
const LAYOUT_SHAPES: Array<{ rows: number; columns: number }> = [
	{ rows: 2, columns: 4 },
	{ rows: 30, columns: 29 },
	{ rows: 89, columns: 87 },
]

// A Panel is twelve values: the Record, five plain members, the `note` Case
// and its String, and the `tags` List of three Strings. The Integer beside it
// goes in only.
const PANEL_NODES = 13 + 12

const SAMPLES = 15
const SAMPLE_NANOSECONDS = 8_000_000
const WARMUP_NANOSECONDS = 20_000_000
const WARMUP_TURNS = 20
const SETTLE_NANOSECONDS = 20_000_000
const SETTLE_TURNS = 50

// The kind of Integer passed in. Out is always a bigint.
const KINDS: Array<Kind> = ["bigint", "number"]

// Every turn adds its answer here, and the total is printed, so the engine can
// not drop work whose result nothing reads.
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

// A List as the runtime lays one out. See "List boxes" in DEVELOPMENT.md.
type ListBox = {
	value: Array<unknown>
	length?: number
	front?: Array<unknown>
	frontLen?: number
	writes?: {
		log: {
			version: number
			positions: Array<number>
			items: Array<unknown>
		}
		seen: number
	}
}

// The back run as this box sees it. See "List boxes" in DEVELOPMENT.md.
// Exported for `undoReplay.spec.ts`, which holds it against the runtime's own.
export function backRunSeenBy(box: ListBox): Array<unknown> {
	let writes = box.writes

	if (writes === undefined || writes.seen === writes.log.version) {
		return box.value
	}

	let count = box.length ?? box.value.length
	let own = box.value.slice(0, count)
	let positions = writes.log.positions
	let items = writes.log.items

	for (
		let version = writes.log.version - 1;
		version >= writes.seen;
		version--
	) {
		let position = positions[version]

		if (position < count) {
			own[position] = items[version]
		}
	}

	return own
}

type Kind = "bigint" | "number"

// One line of the table before it is timed.
type Case = {
	shape: string
	nodes: number
	kind: Kind
	body: () => number
	raw: () => number
	marshalled: () => number
}

// What a child process writes back, with its sink, so the parent prints it.
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

// Deterministic, so two runs measure the same work. The cells are small, so the
// runtime keeps them as numbers rather than measuring bigint arithmetic.
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

// The door a host writes itself: the bridge's constructors in, the runtime's
// layout read off the values out, and nothing checked.
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
	let back = backRunSeenBy(box)
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
			// A bigint, as the marshalled door answers.
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

// Warmed, then timed in batches of milliseconds so the clock is not what is
// measured. The median sample is reported, which ignores a slow outlier.
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

// Every path runs before any is timed. All of them share Functions, so a door
// timed first would meet an engine that had seen nothing else.
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

// The two doors must agree before either is timed, which also checks the
// hand-built reading of a List.
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

// Nanoseconds per value crossed, with the Module's own call taken out.
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

// The commit measured, and whether the tree had changes, or "unknown" without
// git.
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

// One kind of Integer per process. Both kinds through `createIntegerFrom` in
// one run leave the engine no monomorphic path, which no host's single kind
// would. BENCH.md has the measurement.
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

// A child writes its rows, and the parent prints both kinds' tables.
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

// Runs only as a tool, since `undoReplay.spec.ts` imports this file.
if (import.meta.main) {
	await main()
}
