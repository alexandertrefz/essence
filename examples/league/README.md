# League table

A season of a six-team league, as a pure Essence program: the fixtures are
written down, the program works the table out and answers questions about the
season — who leads, by how much, the biggest win, the longest unbeaten run,
what would change if the postponed match went one way — and prints it all.

```sh
bun packages/cli/bin/essence run examples/league/Main.es
```

```
After round 7
----------------------------------------------------------
 #  Team                P  W  D  L     F:A   GD  Pts  Form
 1  Riverside           7  4  3  0    11:5   +6   15  WDWWW
 2  Harbour Rovers      7  4  2  1    15:7   +8   14  WDLDW
 3  Ashgrove Athletic   7  2  3  2     8:6   +2    9  LWWDL
 4  Northfield United   6  2  2  2    12:7   +5    8  DWWLD
 5  Kestrel Town        6  2  1  3    9:12   -3    7  DLLWL
 6  Old Quarry          7  0  1  6    3:21  -18    1  LLLDL

Riverside lead Harbour Rovers by 1 point.
They average 15/7 points a game — 2.14 to two places — and have won 57% of their matches.
…
```

## What it shows

- **Data is a value.** [`Season.es`](Season.es) is the season: a `Team`
  Record, a `Fixture` Choice with a Case for each thing that can happen to a
  match (`Played`, `Forfeited`, `Postponed` — a postponement is its own Case,
  not a missing score), and the fixtures as a List. Nothing in the program
  changes it; the "what if" in `Main.es` maps it to a *second* season and
  computes a second table beside the first.
- **A Namespace is where a Type's rules live.** [`Standings.es`](Standings.es)
  declares `Standing` and a `namespace Standing for Standing is Comparable`
  whose `compare(to:)` *is* the ranking rule — points, goal difference, goals
  scored, name — so `Standings.ranked` is one `sort()` with no comparison
  passed. `is Printable` on `Fixture` and `Outcome` lets a fixture print itself
  and a form guide join into `WDLDW`.
- **Every count is a fold.** The table is `teams::map` over
  `fixtures::reduce`, and each Case of a fixture is taken apart by a Pattern
  into exactly the names the arm needs. Recording a result is one Record
  update, `{ @ with … }`.
- **Refinements instead of Optionals.** `teams` is a `NonEmptyList<Team>` —
  writing the items down is the proof — so `Standings.leader(of:)` answers a
  `Standing` rather than an `Optional`, and `pointsPerGame` divides by `played`
  inside the `if` that proved it non-zero, where the quotient is bare.
- **Exact until the last step.** A rate is a `Rational` — `15/7`, not
  `2.142857…` — and the whole league's mean is `average` over a List of exact
  rates. [`Table.es`](Table.es) holds the one place a number is rounded:
  `Decimal.formatted`, when a value becomes text.
- **Modules.** Four files, private by default, `import { … }` / `export { … }`
  naming exactly what crosses.

- **Tests are part of the language.** [`Standings.es`](Standings.es) ends in a
  `tests { … }` section — the rules tested where they are written, private
  Functions and all — and [`Season.tests.es`](Season.tests.es) is a file of
  nothing but imports and tests, for the questions that cross Modules. Run them
  with `essence test`; a build drops the sections before anything is enriched,
  so they cost the program nothing.

```
$ essence test
```

[`league.spec.ts`](league.spec.ts) runs `essence test` over the example and
checks that the program still compiles and runs, so the showcase cannot quietly
stop working.
