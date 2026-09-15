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

	§§ Every square a new tile could go on. `withNewTile` draws one of these;
	§§ a page that puts down a tile of its own — replaying a recorded game,
	§§ say — asks for them and calls `place`.
	function emptyCells(_ game: Game) -> List<Cell> {
		<- game.board::emptyCells()
	}

	§§ The game with a tile set on the given square.
	function place(_ game: Game, at cell: Cell, value: Integer) -> Game {
		<- { game with board = game.board::place(value, at cell) }
	}

	§ The dice, and they are this side's. `Randomness.entropy()` is the HOST's
	§ own source: it carries nothing and reads the machine at each draw, so
	§ nothing about it is held anywhere and a Game stays exactly the plain
	§ value the page hands back through `resume` after an edit. The other
	§ source, `Randomness.seeded(_)`, is the one a run can replay — but a
	§ seeded source has to be threaded from draw to draw, which means keeping
	§ it in the Game, and a source is not a value the boundary can carry out
	§ to the page and back. A game that had to deal itself the same way twice
	§ would keep the seed and the moves instead, and play them again.

	§§ The game with one more tile on it — a 4 one time in ten, as the
	§§ original — or the game as it was, where there is no square to put one
	§§ on.
	function withNewTile(_ game: Game) -> Game {
		constant source = Randomness.entropy()
		constant cells  = game.board::emptyCells()

		§ Inside the `if` the squares are proven to be a List with something
		§ in it, which is what `pick(from:)` asks for — so it answers a square
		§ rather than an Optional, and there is no empty case to handle twice.
		if cells::hasItems() {
			constant cell = source::pick(from cells)
			constant tile = define {
				as 4 if source::drawBoolean(withProbability 1/10)
				as 2 otherwise
			}

			<- place(game, at cell, value tile)
		}

		<- game
	}

	§§ A new game: an empty board with the two tiles it opens with.
	function start() -> Game {
		<- withNewTile(withNewTile(empty))
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
	start
	status
	undo
	withNewTile
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
		test "puts a tile on the square it was given" {
			constant placed = place(empty, at { row = 1, column = 2 }, value 4)

			expect highest(placed)::is(4)
			expect emptyCells(placed)::length()::is(15)
		}

		§ Every Function here answers a new Game; this is what makes undo
		§ free, and it is worth a test of its own rather than a comment.
		test "leaves the game it was handed alone" {
			expect place(empty, at { row = 0, column = 0 }, value 2)
				::isNot(empty)
			expect highest(empty)::is(0)
		}
	}

	§ A draw answers a different tile on a different square every time, so
	§ most of what is tested is what does NOT depend on which draw came out:
	§ that one square was filled, that the tile is one of the two the game
	§ deals, and that a full board is handed back untouched.
	§
	§ That the square is drawn at all is testable too, over enough deals:
	§ thirty deals landing on one square of sixteen is one chance in sixteen
	§ to the twenty-ninth. The tile is not — one in ten over thirty deals is
	§ an ordinary run, so a test of it would fail on ordinary luck.
	suite "a new tile" {
		test "fills one square, with a 2 or a 4" {
			constant dealt = withNewTile(empty)

			expect emptyCells(dealt)::length()::is(15)
			expect [2, 4]::contains(highest(dealt))
		}

		§ The squares LEFT stand for the square filled, and say nothing about
		§ which tile was dealt onto it — so this reads the draw of the square
		§ alone.
		test "deals to more than one square over thirty games" {
			constant remaining = List.of(integersFrom 1, through 30)::map((_) {
				<- emptyCells(withNewTile(empty))
			})

			expect remaining::removeDuplicates()::length()::isGreaterThan(1)
		}

		test "has nowhere to put one on a full board" {
			expect withNewTile(finished)::is(finished)
		}

		test "opens a new game with two tiles and no moves behind it" {
			constant game = start()

			expect emptyCells(game)::length()::is(14)
			expect moves(game)::is(0)
			expect status(game)::is(#Playing)
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
			expect movements(started, toward #Right)
				::is([
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
