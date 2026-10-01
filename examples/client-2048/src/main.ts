// The page. Every rule of the game lives in `Game.es`, the dice included:
// `withNewTile` draws from `Randomness.entropy()`, the host's randomness. The
// page only draws a Game and turns keys into pushes.
import * as rules from "./Game.es"
import type * as Rules from "./Game.es"
import type { Direction, Game, Movement } from "./Game.es"

const boardElement = document.querySelector<HTMLDivElement>("#board")!
const scoreElement = document.querySelector<HTMLElement>("#score")!
const movesElement = document.querySelector<HTMLElement>("#moves")!
const statusElement = document.querySelector<HTMLElement>("#status")!
const undoButton = document.querySelector<HTMLButtonElement>("#undo")!
const newButton = document.querySelector<HTMLButtonElement>("#new")!

// The page's whole state is one Game, a plain object from the Module. It is
// never changed: every event replaces it with the Module's answer, and `undo`
// hands the old one back.
let game: Game = rules.empty

function distance(movement: Movement, row: number, column: number): number {
	return (
		Math.abs(Number(movement.from.row) - row) +
		Math.abs(Number(movement.from.column) - column)
	)
}

// `start` deals a new game its opening tiles, since that is a rule of the
// game and so of the Module.
function newGame(): void {
	game = rules.start()
	render()
}

// An arrow key names a Direction already: `"ArrowUp"` without its prefix is
// `"Up"`, which is how a payload-less Case crosses the boundary.
function directionOf(key: string): Direction | null {
	let name = key.replace(/^Arrow/, "")

	return Object.hasOwn(rules.Direction, name) ? (name as Direction) : null
}

function push(direction: Direction): void {
	// `move` answers an `Optional<Game>`: the Game after the push, or
	// `undefined` when the push would move nothing, and then nothing changes.
	let moved = rules.move(game, direction)

	if (moved === undefined) {
		restart(boardElement, "shaken")

		return
	}

	// `movements` tells the same push as journeys: where each tile came from.
	// The page slides each tile in from there.
	let movements = rules.movements(game, direction)

	game = rules.withNewTile(moved)
	render(movements)
}

// An animation is a class taken off and put back on, so a tile can replay it
// on the next move.
function restart(element: HTMLElement, name: string): void {
	element.classList.remove(name)
	void element.offsetWidth
	element.classList.add(name)
}

// The board as last drawn, so a render can tell what each square did. A tile
// that slid in travels from where it was, a merge swells when it lands, and a
// new tile pops in.
let drawn: Rules.Board = rules.empty.board
let drawnScore = 0n

const SLIDE_MS = 90

function render(movements: Array<Movement> = []): void {
	let travelled = movements.length > 0

	// Integers cross as bigints, so no tile or score outgrows its type.
	// `String(2048n)` is "2048".
	boardElement.replaceChildren(
		...game.board.flatMap((row, rowIndex) =>
			row.map((value, columnIndex) => {
				let tile = document.createElement("div")
				let before = drawn[rowIndex]?.[columnIndex] ?? 0n

				tile.className = "tile"
				tile.dataset.value = String(value)
				tile.textContent = value === 0n ? "" : String(value)

				// Every journey ending on this square. The tile starts where
				// the farthest one began, so a merge slides in from the farther
				// tile.
				let arrivals = movements.filter(
					({ to }) =>
						to.row === BigInt(rowIndex) &&
						to.column === BigInt(columnIndex),
				)

				if (arrivals.length > 0) {
					let farthest = arrivals.reduce((far, next) =>
						distance(next, rowIndex, columnIndex) >
						distance(far, rowIndex, columnIndex)
							? next
							: far,
					)

					tile.style.setProperty(
						"--dy",
						String(Number(farthest.from.row) - rowIndex),
					)
					tile.style.setProperty(
						"--dx",
						String(Number(farthest.from.column) - columnIndex),
					)
					tile.classList.add("slid")

					let joined = arrivals.some(
						({ from }) =>
							(drawn[Number(from.row)]?.[Number(from.column)] ??
								0n) !== value,
					)

					if (joined) {
						tile.classList.add("merged")
					}
				} else if (value !== 0n && before === 0n) {
					tile.classList.add("appeared")
				}

				if (travelled) {
					tile.style.setProperty("--after-slide", `${SLIDE_MS}ms`)
				}

				return tile
			}),
		),
	)

	if (game.score !== drawnScore) {
		restart(scoreElement, "bumped")
	}

	drawn = game.board
	drawnScore = game.score

	scoreElement.textContent = String(game.score)
	movesElement.textContent = String(rules.moves(game))
	undoButton.disabled = rules.moves(game) === 0n

	// `status` answers a payload-less Choice, which crosses as a string.
	switch (rules.status(game)) {
		case "Won":
			statusElement.textContent = `You made ${String(rules.highest(game))} — keep going, or start over.`
			break
		case "Over":
			statusElement.textContent = "No moves left."
			break
		case "Playing":
			statusElement.textContent = ""
			break
	}
}

document.addEventListener("keydown", (event) => {
	let direction = directionOf(event.key)

	if (direction === null) {
		return
	}

	event.preventDefault()
	push(direction)
})

undoButton.addEventListener("click", () => {
	// The page implements no undo. The Module kept the previous Game, since
	// nothing overwrote it, and `undo` hands it back, or nothing at the start.
	game = rules.undo(game) ?? game
	render()
})

newButton.addEventListener("click", newGame)

// Following the editor. When `Game.es` or `Board.es` is saved, Vite hands
// over the fresh Module, and the game in play continues under the new rules.
if (import.meta.hot) {
	import.meta.hot.accept("./Game.es", (fresh) => {
		if (fresh) {
			game = (fresh as unknown as typeof rules).resume(game)
			render()
		}
	})
}

newGame()
