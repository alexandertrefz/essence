// NOTE: The page. Everything that is a rule of the game lives in `Game.es` —
// the dice included: `withNewTile` there draws its square and its tile from
// `Randomness.entropy()`, the host's own source of randomness. What is left
// here is drawing a Game and turning keys into pushes, which is the whole of
// what a page is for.
import * as rules from "./Game.es"
import type * as Rules from "./Game.es"
import type { Direction, Game, Movement } from "./Game.es"

const boardElement = document.querySelector<HTMLDivElement>("#board")!
const scoreElement = document.querySelector<HTMLElement>("#score")!
const movesElement = document.querySelector<HTMLElement>("#moves")!
const statusElement = document.querySelector<HTMLElement>("#status")!
const undoButton = document.querySelector<HTMLButtonElement>("#undo")!
const newButton = document.querySelector<HTMLButtonElement>("#new")!

// NOTE: The whole state of the page is one Game — a plain object the Module
// handed over. It is never changed; every event REPLACES it with the Game the
// Module answers, and the old one is what `undo` will hand back.
let game: Game = rules.empty

function distance(movement: Movement, row: number, column: number): number {
	return (
		Math.abs(Number(movement.from.row) - row) +
		Math.abs(Number(movement.from.column) - column)
	)
}

// NOTE: `start` deals a new game its two tiles. That a game opens with two is
// a rule of the game, so it is a rule of the Module, and the page asks for one
// rather than dealing it.
function newGame(): void {
	game = rules.start()
	render()
}

// NOTE: An arrow key names a Direction already: `"ArrowUp"` without its
// prefix is `"Up"`, which is exactly how a payload-less Case crosses the
// boundary. Nothing is translated — the string IS the value.
function directionOf(key: string): Direction | null {
	let name = key.replace(/^Arrow/, "")

	return Object.hasOwn(rules.Direction, name) ? (name as Direction) : null
}

function push(direction: Direction): void {
	// NOTE: `move` answers an Optional<Game>: the Game after the push, or
	// nothing when the push would move nothing — `undefined` here — in which
	// case no tile is placed and nothing changes, exactly as the game rules
	// say. Not an exception, not a flag: the absence of an answer.
	let moved = rules.move(game, direction)

	if (moved === undefined) {
		restart(boardElement, "shaken")

		return
	}

	// NOTE: `movements` is the same push, told as journeys — where each tile
	// that ended up somewhere came from. The Module already knows; the page
	// only asks, and slides each tile in from where it was.
	let movements = rules.movements(game, direction)

	game = rules.withNewTile(moved)
	render(movements)
}

// NOTE: An animation is a class that is taken off and put back on, so that
// the same tile can play it again on the very next move.
function restart(element: HTMLElement, name: string): void {
	element.classList.remove(name)
	void element.offsetWidth
	element.classList.add(name)
}

// NOTE: The board as it was drawn last, so that a fresh render can say what
// each square did: a tile that slid in starts where it was and travels; one
// that changed value under a slide — a merge — swells when it lands; one that
// simply appeared pops in. Two values of the game side by side, nothing else.
let drawn: Rules.Board = rules.empty.board
let drawnScore = 0n

const SLIDE_MS = 90

function render(movements: Array<Movement> = []): void {
	let travelled = movements.length > 0

	// NOTE: Integers cross as bigints — the value of a tile or a score does
	// not depend on how big it got. `String(2048n)` is "2048".
	boardElement.replaceChildren(
		...game.board.flatMap((row, rowIndex) =>
			row.map((value, columnIndex) => {
				let tile = document.createElement("div")
				let before = drawn[rowIndex]?.[columnIndex] ?? 0n

				tile.className = "tile"
				tile.dataset.value = String(value)
				tile.textContent = value === 0n ? "" : String(value)

				// NOTE: Every journey ending on this square; the tile starts
				// out where the farthest one began, so a merge slides in from
				// the tile that had the farther way to come.
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

	// NOTE: `status` answers a payload-less Choice — one of three strings.
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
	// NOTE: Undo is not a feature the page implements. The Game before the last
	// move is a value the Module kept, because nothing ever overwrote it, and
	// `undo` hands it back — or nothing, at the very start.
	game = rules.undo(game) ?? game
	render()
})

newButton.addEventListener("click", newGame)

// NOTE: Following the editor. When `Game.es` (or `Board.es` behind it) is
// saved, Vite hands this module the fresh one, and the game in play — plain
// JavaScript all along — is passed through the new Module's boundary and
// carried on under the new rules. The board survives the edit.
if (import.meta.hot) {
	import.meta.hot.accept("./Game.es", (fresh) => {
		if (fresh) {
			game = (fresh as unknown as typeof rules).resume(game)
			render()
		}
	})
}

newGame()
