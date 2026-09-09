# 2048

The game in the browser. [`src/Game.es`](src/Game.es) and
[`src/Board.es`](src/Board.es) are the game — the board, sliding and merging,
scoring, win and game over, undo, and the tile every move deals.
[`src/main.ts`](src/main.ts) draws it and turns arrow keys into pushes. Vite
serves both, through one plugin line in
[`vite.config.ts`](vite.config.ts).

```sh
cd examples/client-2048
bun run dev          # then open the printed address
bun run build        # dist/
```

(Inside this repository the packages are TypeScript sources, so the scripts
run Vite under Bun — `bun --bun vite`. A project installing the published
`@essence-lang/client` runs plain `vite`.)

## What it shows

- **A game is a value.** `Game` is a Record — the board, the score, and every
  board and score before this one. `move` answers a new Game; the one it was
  given is left as it was. So **undo is not a feature the page implements**:
  `undo(game)` reads the last entry of `history`, and nothing ever had to be
  restored, because nothing was ever overwritten.
- **The four directions are four strings.** `choice Direction { Up, Down,
  Left, Right }` has no payloads, so JavaScript sees `"Up" | "Down" | "Left" |
  "Right"` — and `"ArrowUp"` without its prefix *is* one. `main.ts` translates
  nothing.
- **A push that moves nothing is `undefined`.** `move` answers
  `Optional<Game>`; the page reads it as `Game | undefined` and simply does
  not place a tile. Not an exception, not a flag.
- **The rules roll the dice.** `withNewTile` asks
  [`Randomness.entropy()`](../../packages/standard-library/sources/Randomness.es)
  for the host's own source and draws twice from it: the square, out of the
  empty ones with `pick(from:)`, and the tile, a 4 one time in ten. The page
  draws nothing and knows nothing about it — `Math.random` appears nowhere.
  The entropy source carries no state, so nothing about it has to cross the
  boundary and a Game stays the plain object the page hands back after an
  edit; `Randomness.seeded(_)` is the replayable source, and it has to be
  threaded from draw to draw, which is why a game that wanted to deal itself
  the same way twice would keep the seed and the moves instead.
- **The push is told as journeys.** `movements(game, direction)` answers
  where every tile that ended up somewhere came from — a merge from two
  places — so the page slides each tile in from where it was instead of
  guessing from two boards. The rules know; the page asks.
- **Three directions are one.** [`Board.es`](src/Board.es) slides rows left;
  Right, Up and Down are the same slide seen through a `mirror` or a
  `transpose`, each its own inverse. `transpose()` is the standard library's,
  over any List of Lists; `mirror` is the board's own.
- **Typed imports.** While the dev server runs the plugin writes
  `src/Game.d.es.ts` beside the source, and `tsc` reads
  `import … from "./Game.es"` against it:

  ```ts
  export type Direction = "Up" | "Down" | "Left" | "Right"
  export type Game = { board: Board; score: bigint; history: Array<…>; won: boolean }
  export declare function move(p0: Input<Game>, toward: Direction): Game | undefined
  export declare function undo(p0: Input<Game>): Game | undefined
  ```

- **Following the editor.** Save `Game.es` or `Board.es` with the dev server
  running: Vite hands `main.ts` the fresh Module, and the game in play — a
  plain object all along — is passed through the new Module's `resume` and
  carries on under the new rules. Try changing what a merge is worth.
- **Integers are bigints.** A tile is `2048n`, a score is a `bigint`; the page
  prints them with `String(…)`.

[`client-2048.spec.ts`](client-2048.spec.ts) checks the rules through the same
boundary (`loadModule`), builds the page with Vite, and typechecks it against
declarations generated from the same Descriptor.
