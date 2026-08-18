import { describe, expect, it } from "bun:test"
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import {
	describeModule,
	describeTypes,
	generateDeclarations,
	loadModule,
} from "@essence-lang/client"
import { build } from "vite"

import type * as Rules from "./src/Game.es"

const EXAMPLE = import.meta.dirname
const REPOSITORY = path.join(EXAMPLE, "..", "..")

// NOTE: The rules, checked through the same boundary the page calls them
// through — `loadModule` hands over the marshalled exports, typed here by the
// declarations the plugin generates for the page.
async function rules(): Promise<typeof Rules> {
	let module = await loadModule(path.join(EXAMPLE, "src", "Game.es"))

	return module.exports as unknown as typeof Rules
}

describe("examples/client-2048", () => {
	it("slides and merges a row once, left to right", async () => {
		let { Board } = await rules()
		let row = (cells: Array<bigint>) => Board.slideRows([cells, [], [], []])

		expect(row([2n, 2n, 4n, 0n]).board[0]).toEqual([4n, 4n, 0n, 0n])
		expect(row([2n, 2n, 4n, 0n]).gained).toBe(4n)
		expect(row([4n, 4n, 4n, 0n]).board[0]).toEqual([8n, 4n, 0n, 0n])
		expect(row([2n, 2n, 2n, 2n]).board[0]).toEqual([4n, 4n, 0n, 0n])
		expect(row([2n, 2n, 2n, 2n]).gained).toBe(8n)
		expect(row([0n, 2n, 0n, 2n]).board[0]).toEqual([4n, 0n, 0n, 0n])
	})

	it("pushes in every direction, and answers nothing for a push that moves nothing", async () => {
		let game = await rules()
		let start = game.place(
			game.place(game.empty, { row: 0n, column: 0n }, 2n),
			{ row: 0n, column: 1n },
			2n,
		)

		let left = game.move(start, "Left")!
		let right = game.move(start, "Right")!
		let down = game.move(start, "Down")!

		expect(left.board[0]).toEqual([4n, 0n, 0n, 0n])
		expect(right.board[0]).toEqual([0n, 0n, 0n, 4n])
		expect(down.board[3]).toEqual([2n, 2n, 0n, 0n])
		expect(left.score).toBe(4n)
		expect(game.move(start, "Up")).toBeUndefined()
		expect(game.move(left, "Left")).toBeUndefined()
	})

	it("tells where every tile travelled, in every direction", async () => {
		let game = await rules()
		let board = [
			[2n, 0n, 2n, 4n],
			[0n, 0n, 0n, 0n],
			[4n, 0n, 0n, 4n],
			[0n, 2n, 0n, 0n],
		]
		let start = { ...game.empty, board }
		let cell = (row: number, column: number) => ({
			row: BigInt(row),
			column: BigInt(column),
		})

		expect(game.movements(start, "Left")).toEqual([
			{ from: cell(0, 2), to: cell(0, 0) },
			{ from: cell(0, 3), to: cell(0, 1) },
			{ from: cell(2, 3), to: cell(2, 0) },
			{ from: cell(3, 1), to: cell(3, 0) },
		])
		expect(game.movements(start, "Down")).toEqual([
			{ from: cell(2, 0), to: cell(3, 0) },
			{ from: cell(0, 0), to: cell(2, 0) },
			{ from: cell(0, 2), to: cell(3, 2) },
			{ from: cell(2, 3), to: cell(3, 3) },
			{ from: cell(0, 3), to: cell(3, 3) },
		])
		expect(game.movements(game.empty, "Up")).toEqual([])
	})

	it("keeps every board it ever had, so undo is a value", async () => {
		let game = await rules()
		let start = game.place(
			game.place(game.empty, { row: 0n, column: 0n }, 2n),
			{ row: 0n, column: 1n },
			2n,
		)
		let moved = game.move(start, "Left")!

		expect(game.moves(moved)).toBe(1n)
		expect(game.undo(moved)).toEqual(start)
		expect(game.undo(start)).toBeUndefined()
		expect(start.board[0]).toEqual([2n, 2n, 0n, 0n])
	})

	it("reads the status as a bare Case name", async () => {
		let game = await rules()

		expect(game.status(game.empty)).toBe("Over")
		expect(
			game.status(game.place(game.empty, { row: 1n, column: 1n }, 2n)),
		).toBe("Playing")

		let won = game.place(
			game.place(game.empty, { row: 0n, column: 0n }, 1024n),
			{ row: 0n, column: 1n },
			1024n,
		)

		expect(game.status(game.move(won, "Left")!)).toBe("Won")
		expect(game.Direction).toEqual({
			Up: "Up",
			Down: "Down",
			Left: "Left",
			Right: "Right",
		})
	})

	it("builds with Vite, and typechecks against the generated declarations", async () => {
		let directory = mkdtempSync(path.join(tmpdir(), "essence-2048-"))

		try {
			await build({
				root: EXAMPLE,
				configFile: path.join(EXAMPLE, "vite.config.ts"),
				logLevel: "silent",
				build: { outDir: directory, emptyOutDir: true },
			})

			expect(existsSync(path.join(directory, "index.html"))).toBe(true)
			expect(
				readdirSync(path.join(directory, "assets")).some((file) =>
					file.endsWith(".js"),
				),
			).toBe(true)
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}

		// NOTE: The dev server writes `Game.d.es.ts` beside the source as it
		// serves; a build does not, so the same declarations are generated here
		// from the same Descriptor, and `tsc` reads the page against them.
		let module = await loadModule(path.join(EXAMPLE, "src", "Game.es"))

		writeFileSync(
			path.join(EXAMPLE, "src", "Game.d.es.ts"),
			generateDeclarations(
				describeModule(module.surface, module.entryPath),
				{
					moduleName: "Game.es",
					types: describeTypes(module.surface, module.entryPath),
				},
			),
		)

		let tsc = Bun.spawnSync(
			[
				process.execPath,
				path.join(REPOSITORY, "node_modules", ".bin", "tsc"),
				"--noEmit",
			],
			{ cwd: EXAMPLE, stdout: "pipe", stderr: "pipe" },
		)

		expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("")
		expect(tsc.exitCode).toBe(0)
	}, 60_000)
})
