import {
	from "./Board.es" {
		Board
		Cell
		Direction
		Movement
	}
}

implementation {

	§ A game is a value: the board, the score, and every board and score
	§ before this one. A move answers a new Game and the old one is left
	§ exactly as it was — so `undo` is nothing more than reading the last
	§ entry of `history`, and there is no state anywhere to restore.
	type Snapshot = { board: Board, score: Integer }

	type Game = {
		board: Board,
		score: Integer,
		history: List<Snapshot>,
		won: Boolean,
	}

	§ Where the game stands. No payloads, so JavaScript sees `"Playing"`,
	§ `"Won"` or `"Over"`.
	choice Status {
		Playing,
		Won,
		Over,
	}

	constant winningTile = 2048

	constant empty: Game = {
		board = Board.empty,
		score = 0,
		history = [],
		won = false,
	}

	§§ Every square a new tile could go on. The host chooses one — Essence has
	§§ no randomness, and this side does not need any: it says what is
	§§ possible and is told what happened.
	function emptyCells(_ game: Game) -> List<Cell> {
		<- game.board::emptyCells()
	}

	§§ The game with a tile set — how the host puts down the tile it chose.
	function place(_ game: Game, at cell: Cell, value: Integer) -> Game {
		<- { game with board = game.board::place(value, at cell) }
	}

	§§ The game after a push, or nothing when the push moves nothing — which
	§§ is `undefined` on the JavaScript side, and the host simply does not
	§§ place a tile. The board before the push goes onto the history.
	function move(_ game: Game, toward direction: Direction) -> Optional<Game> {
		constant slid = game.board::slide(toward direction)

		if slid.board::is(game.board) {
			<- #Empty
		}

		<- #Value({
			board = slid.board,
			score = game.score::add(slid.gained),
			history = game.history::append({
				board = game.board,
				score = game.score,
			}),
			won = game.won::or(
				slid.board::highest()::isGreaterThanOrEqualTo(winningTile),
			),
		})
	}

	§§ Where every tile would travel under a push — the page animates these,
	§§ and then draws the Game `move` answers. A tile that stays put is not
	§§ listed; a merge lists the tile that came to it.
	function movements(
		_ game: Game,
		toward direction: Direction,
	) -> List<Movement> {
		<- game.board::slide(toward direction).movements
	}

	§§ The game one move back, or nothing at the very start.
	function undo(_ game: Game) -> Optional<Game> {
		<- game.history
			::lastItem()
			::map(({ board, score }) {
				<- {
					game with
						board = board,
						score = score,
						history = game.history::removeLast(),
				}
			})
	}

	§§ Won once a 2048 tile has been made — and a won game may go on — over
	§§ once no push would change the board, playing otherwise.
	function status(_ game: Game) -> Status {
		<- define {
			as #Won     if game.won
			as #Playing if game.board::hasMoves()
			as #Over    otherwise
		}
	}

	§§ The highest tile on the board.
	function highest(_ game: Game) -> Integer {
		<- game.board::highest()
	}

	§§ How many moves have been made — the length of the history.
	function moves(_ game: Game) -> Integer {
		<- game.history::length()
	}

	§§ The hand-over on a hot reload: the host holds a Game as plain
	§§ JavaScript, and passing it through the NEW Module's boundary is what
	§§ makes it that Module's value. It is the identity Function; the crossing
	§§ is the point.
	function resume(_ game: Game) -> Game {
		<- game
	}
}

export {
	Game
	Status
	empty
	emptyCells
	highest
	move
	movements
	moves
	place
	resume
	status
	undo
	from "./Board.es" {
		Board
		Cell
		Direction
		Movement
	}
}

tests {

	constant twoTiles: Board = [
		[2, 0, 0, 2],
		[0, 0, 0, 0],
		[0, 0, 0, 0],
		[0, 0, 0, 0],
	]

	§ Full, and no two neighbours equal: the board a game ends on.
	constant locked: Board = [
		[2, 4, 2, 4],
		[4, 2, 4, 2],
		[2, 4, 2, 4],
		[4, 2, 4, 2],
	]

	constant started: Game  = { empty with board = twoTiles }
	constant finished: Game = { empty with board = locked }

	suite "a game that has not started" {
		test "has nothing on it and nothing behind it" {
			expect empty.score::is(0)
			expect moves(empty)::is(0)
			expect highest(empty)::is(0)
			expect emptyCells(empty)::length()::is(16)
		}

		test "has nothing to undo" {
			require #Empty = undo(empty)
		}
	}

	suite "place" {
		test "puts a tile on the square the host chose" {
			constant placed = place(empty, at { row = 1, column = 2 }, value 4)

			expect highest(placed)::is(4)
			expect emptyCells(placed)::length()::is(15)
		}

		§ Every Function here answers a new Game; this is what makes undo
		§ free, and it is worth a test of its own rather than a comment.
		test "leaves the game it was handed alone" {
			expect place(empty, at { row = 0, column = 0 }, value 2)::isNot(
				empty,
			)
			expect highest(empty)::is(0)
		}
	}

	suite "move" {
		test "answers a game the push has changed" {
			require #Value(next) = move(started, toward #Left)

			expect next.board::firstItem()::is([4, 0, 0, 0])
			expect next.board::isNot(started.board)
		}

		test "adds what the merge was worth to the score" {
			require #Value(next) = move(started, toward #Left)

			expect next.score::is(4)
		}

		test "puts the board it left behind onto the history" {
			require #Value(next) = move(started, toward #Left)

			expect moves(next)::is(1)
			expect next.history::is([{ board = twoTiles, score = 0 }])
		}

		§ Nothing is `undefined` on this side: a push that moves nothing
		§ answers the empty case, and the host simply places no tile.
		test "answers nothing at all when the push moves nothing" {
			require #Empty = move(finished, toward #Left)
		}

		test "leaves the game it was handed alone" {
			require #Value(next) = move(started, toward #Left)

			expect next.board::isNot(started.board)
			expect started.score::is(0)
			expect moves(started)::is(0)
		}

		test "is won the moment a 2048 tile is made" {
			constant nearly: Game = {
				empty with
					board = [
						[1_024, 1_024, 0, 0],
						[0, 0, 0, 0],
						[0, 0, 0, 0],
						[0, 0, 0, 0],
					],
			}

			require #Value(won) = move(nearly, toward #Left)

			expect highest(won)::is(2_048)
			expect status(won)::is(#Won)
		}
	}

	suite "undo" {
		test "goes back to the board and the score the move began with" {
			require #Value(next) = move(started, toward #Left)
			require #Value(back) = undo(next)

			expect back.board::is(twoTiles)
			expect back.score::is(0)
			expect moves(back)::is(0)
		}

		§ A move and its undo compose into nothing, which is only true because
		§ the game before the move is still a value.
		test "answers the very game the move was made from" {
			require #Value(next) = move(started, toward #Left)
			require #Value(back) = undo(next)

			expect back::is(started)
		}
	}

	suite "status" {
		test "is playing while a push would change something" {
			expect status(started)::is(#Playing)
		}

		test "is over once no push would change anything" {
			expect status(finished)::is(#Over)
		}

		§ A won game may go on being played, and goes on saying it was won.
		test "stays won on a board with moves left in it" {
			expect status({ started with won = true })::is(#Won)
		}
	}

	suite "the page's two questions" {
		test "answers where every tile would travel under a push" {
			expect movements(started, toward #Right)::is([
				{
					from = { row = 0, column = 0 },
					to = { row = 0, column = 3 },
				},
			])
		}

		§ The hot-reload hand-over: the identity Function, whose whole point is
		§ that the value crossed a Module boundary to get here.
		test "hands a game back exactly as it was given" {
			expect resume(started)::is(started)
		}
	}
}
