# Diagnostics

Every Diagnostic the Essence Compiler reports carries a code — the stable
identifier printed above a terminal report and attached to the Diagnostic a
Language Server client receives:

```
[assignment-type-mismatch]
Error: This value does not fit Variable 'count'
```

A message may be reworded at any time; a code may not. Editor Quick Fixes and
anything else that reacts to a specific Diagnostic keys off the code, and this
document is the index of every one of them.

Codes are added to `DiagnosticCode` in
[`src/interfaces/common/index.ts`](https://github.com/alexandertrefz/essence/blob/master/src/interfaces/common/index.ts),
which is a required field on every Diagnostic — a new Diagnostic can not be
reported without one, and a code with no entry here is a code nobody can look
up.

Some codes carry a Quick Fix, offered by the Language Server on the underlined
span and noted below the code it belongs to. There is deliberately no "fix
all": none of these rewrites is both semantics-preserving and unambiguous, so
each one is applied by hand and read before it is accepted.

## Syntax

The Lexer and the Parser report these. They are the only Diagnostics that can
appear before a Program has a shape at all.

### `syntax-error`

The Parser expected one thing and found another — `Expected '=' but found
'1'.` The message names both.

### `unexpected-token`

A Token was left over where the Program was supposed to have ended. Usually a
stray `}` or a statement outside `implementation { … }`.

### `unclosed-string`

A String Literal runs to the end of the file without its closing quote. The
end of the input is where that is noticed; the opening quote is where the
String began, and the report points at both.

### `unclosed-block`

A `{` was never closed. Only the innermost torn-open block reports — a missing
`}` necessarily tears open every enclosing block as well.

### `invalid-number`

A Number Literal holds something that is not a digit — `0xFF`, `0b101`, `1e5`.
Essence has no hexadecimal, binary or exponent form; a Number is written in
decimal digits, grouped with `_` where that helps.

### `invalid-escape`

A backslash in a String Literal is followed by something that is not a known
escape. A String understands `\"`, `\\`, `\n`, `\t`, `\{` and `\}`; every other
backslash is an error. The character after it is read as itself so the rest of
the String still lexes — write `\\` for a literal backslash.

### `comment-in-hole`

A `§` Comment was written inside a String's interpolation hole. A Comment runs
to the end of its line, which inside a hole would swallow the hole's `}` and
the String's closing `"`. The Comment is read as ending at the first `}` (or
the end of its line) so the String and everything after it still lex — move
the Comment out of the String.

### `nesting-too-deep`

Expressions, Types and blocks nest more than 256 levels deep at one point in
the Program. The parser reads nesting by recursion, so there is a depth at
which it would run out of call stack mid-read and crash without a report — it
refuses at 256 levels instead, with one. Break the nesting up: name
intermediate values as Constants, or intermediate Types as Type Aliases.

### `redundant-parameter-label`

A Parameter of a Function that takes its Types from the surrounding context
was given both an external and an internal name. Such a Parameter takes its
label from the expected Function Type; write only its name.

**Quick Fix — "Remove the label":** drops the external name and keeps the
internal one.

### `shorthand-in-combination`

A bare member name was written in the key list of an update —
`{ base with port, host }`. Shorthand belongs to a Record Literal's member
list, where `{ port, host }` is `{ port = port, host = host }`; an update's key
list is not one, because a bare name after `with` is already the whole value
being merged in. `{ base with other }` means "merge `other`'s members", and it
has always meant that.

Two spellings say what the bare name was after. `{ base with port = port }`
sets the one member. `{ base with { port, host } }` merges a Record Literal
that uses the shorthand — the same nesting a computed right-hand side is
written in, and the only form of the shorthand merge there is.

The rule holds wherever the braces do: a plain Literal, a typed Literal
(`Point ~> { x, y }`), a Case payload (`#Rectangle({ width, height })`), a
Literal standing as a member's value, and a Literal standing as an update's
whole right-hand side all take shorthand. Only the key list after `with` does
not. An update takes either a key list or one Expression and never both, so a
list that also carries a computed key — `{ game with board = board, history =
game.history::removeLast() }` — has no shorthand spelling at all.

### `shorthand-on-path-key`

A dotted key in an update was written with no value — `{ config with
server.port }`, or `{ config with server.{ tls.enabled } }`. A bare NAME is a
member and its own value, which is what the shorthand is; a path is neither,
because the value it would set is not the name it reaches through.
`server.port` names a member of `config.server` and a local called `port`, and
nothing says the two are the same thing.

Write the value: `{ config with server.port = port }`.

The refusal is reported even where the list is a Record Literal's or a braced
descend's, both of which do take shorthand, and it is reported instead of
`shorthand-in-combination` and `path-key-outside-combination` — no reading
rescues a bare path, so the message that says why is the one to give.

`{ config with server.port }` alone is NOT this Diagnostic. An update takes
either a key list or one Expression, and one path is an Expression: it merges
the members of the value `config.server.port` into `config`, exactly as
`{ config with other }` merges `other`'s.

### `empty-path-group`

A braced descend was written with no members in it — `{ config with
server.{ } }`. An update writes the members it names, so a descend with none in
it says to leave `server` exactly as it was, which is a half-written key rather
than an intent.

Write the members to update inside it, or drop the key.

### `path-is-members-only`

A `::` or a `(` was written after a member path — `.price::rounded()`,
`.total()`. A path stands for the Function that READS those members off its
Argument, so there is nothing there for a call to be made on.

The refusal is the Parser's rather than a later stage's on purpose: letting the
postfix loop attach the call and refusing afterwards gives a message about the
call, when what is wrong is that the path can not carry one. Write the Function
literal wherever more than a read is wanted — `(_ line: Line) { <-
line.total::rounded() }`.

### `default-on-function-literal`

A Parameter of a Function literal in expression position was given a
`= expression` default. Such a literal is called through the Function Type it
was written for, which fixes how many Arguments every call passes, so the
default could never be reached. Write the default on the named Function or
Method the value is passed to.

A default may be written on a named `function` declaration, on a Namespace
Method — instance or `static`, bodied or a body-less native signature — and on
an entry of an `overload` block. It may not be written on a Function literal
(this code), on a `protocol` requirement
(`default-on-protocol-requirement`), or in a Function TYPE such as `(_ n:
Integer) -> Boolean`, which has no expression slot and no frame to evaluate one
in and so does not parse.

A Case payload's individual members are not Parameters and take no defaults:
`choice Shape { Circle { radius: Integer = 1 } }` does not parse. What a Case
may carry is one default for the payload as a WHOLE, written after the shape —
`Circle { radius: Integer } = { radius = 1 }` — which is a Record-literal
default rather than a Parameter one, because Record construction is not a call.
See `case-default-without-payload` and `default-type-mismatch`.

### `case-default-without-payload`

A Case with no payload shape was given a `= { … }` default. A default fills
members in for a construction that left them out, and a Case that carries
nothing has no members to fill:

```essence
choice Direction {
	Up = { degrees = 0 },
	Down,
}
```

Give the Case a payload shape — `Up { degrees: Integer } = { degrees = 0 }` —
or write it on its own.

### `declarations-outside-stdlib`

A file opened with `declarations { … }`, the standard library's private
Program form for body-less native Method signatures. Only the standard library
may open one — write `implementation { … }` instead.

### `overload-function-outside-stdlib`

An `overload function … { … }` block was written outside a `declarations { … }`
Program. Free-Function Overloads are a standard-library form; a free Function
in a Program carries one signature. Write the Overloads as an `overload` Method
block inside a Namespace instead.

### `misplaced-module-section`

A Module section was written where it does not belong. A Program reads top to
bottom — `import { … }`, then `implementation { … }`, then `export { … }` — so
an `import` block below the implementation or an `export` block above it is
reported here, with the implementation block labelled as well.

The same code covers a section in a standard library file. The standard library
is one shared declaration space rather than a graph of Modules: every one of its
files sees every other, and none of them is importable, so none of them may
carry either section.

## Tests

The `tests { … }` section, the `test` and `suite` items written in it, and the
assertions written in a test's body.

### `misplaced-tests-section`

The `tests { … }` block was written above the `export { … }` block, or above
the implementation block. A Module reads top to bottom: what it imports, what
it does, what it exports, what it proves. Move the block to the end, below
`export { … }` — a Module that exports nothing has nothing for it to stand
after, and a section directly below the implementation block is where it
belongs.

### `test-outside-tests`

A `test "…" { … }` or `suite "…" { … }` was written somewhere other than a
`tests { … }` section — in the implementation block, or inside another test's
body. Both are items of the tests section and of the suites nested in it:

```essence
implementation {
	test "records a win as three points" {}
}
```

Move it into the file's `tests { … }` block, or open one below the
implementation.

### `expect-outside-test`

An `expect` or a `require` was written where no test is running. An assertion
records its result against the test it belongs to, so it is a Statement of a
test's own block and of the blocks nested in it — an `if`, a `match` arm — and
never of a Function literal written there, whose body runs wherever it is
handed to:

```essence
tests {
	test "every standing is ranked" {
		expect standings::every((standing) {
			§ this assertion belongs to no test
			expect standing.points::isGreaterThan(0)

			<- true
		})
	}
}
```

Return the value from the Function and assert on it in the test's own block.

### `expect-not-boolean`

An `expect` or a `require` was written over a value that is not a Boolean.
Essence has no truthiness, so there is nothing an assertion over a Standing
could mean. An assertion is an ordinary Boolean Expression, and the standard
library's own Methods are the vocabulary it is written in — there is no
`toEqual`, no `toBeGreaterThan`, no `toContain`:

```essence
tests {
	test "the leader is two points clear" {
		§ this asserts a Standing
		expect Standings.leader(of table)
	}
}
```

Ask a question of the value — `::is(…)`, `::isGreaterThan(…)`, `::hasItems()`
— or take it apart with `require MATCHER = EXPR` and the Matchers `match` uses.

### `matcher-on-expect`

A Matcher was written left of `=` on an `expect`. Taking a value apart is
`require`'s alone:

```essence
tests {
	test "reads the first row" {
		expect #Value(first) = table::firstItem()
	}
}
```

An `expect` records its result and the test carries on, so a name it introduced
would stand below a line that may never have run. A `require` ends the test
where it stands, which is what makes the names it introduces safe to read.

Write `require #Value(first) = table::firstItem()` to take the value apart, or
compare instead with `expect value::is(…)`.

### `matcher-after-value`

A Matcher was written after the value, behind an `is`:

```essence
tests {
	test "reads the first row" {
		require table::firstItem() is #Value(first)
	}
}
```

A name is introduced left of `=`, in a Parameter, or in a Handler head — never
on the right of anything. `is` is the Equatable Method every value already has,
so a Matcher written behind it read as a comparison that USED the name it was
declaring.

Write `require #Value(first) = table::firstItem()`, or compare with
`::is(value)` where a comparison was what was meant.

### `wildcard-in-require`

A `require` names `_` as what the value has to be:

```essence
tests {
	test "reads the first row" {
		require _ = table::firstItem()
	}
}
```

A Matcher left of `=` both asks what the value has to be and names its parts,
and `_` does neither: every value answers it, and it binds nothing. Name the
shape the value has to have — a Case, a Type, a Pattern — or drop the line.

Every other Matcher may stand there whether it binds or not: `require #Empty =
undo(board)` and `require Integer = value` name a shape and bind nothing, which
is what a test asks when the shape is the whole of what it is proving.

### `literal-in-require`

A `require` names a written value as what the value has to be:

```essence
tests {
	test "scores a win" {
		require 3 = points
	}
}
```

`require MATCHER = EXPR` takes a value apart by its shape — a Case, a Type, a
Pattern. A written value is not a shape: what it asks is whether the two are
equal, and that is what `Equatable::is` answers. Write `require points::is(3)`.

A Pattern MEMBER constrained by a written value is a different thing and is
allowed — `require { points = 3 } = standing` asks the question of one member
of a shape the Pattern is naming.

### `snapshot-after-matcher`

A `matches snapshot` was written on the line that takes a value apart:

```essence
tests {
	test "reads the first row" {
		require #Value(first) = table::firstItem() matches snapshot
	}
}
```

A snapshot is of the value an assertion is written over, printed as text.
`require MATCHER = EXPR` is written over a shape instead: it asks what the value
has to be and names its parts, so what there is to record is one of those names.

Record the name on a line of its own — `require #Value(first) =
table::firstItem()` and below it `expect first matches snapshot`. Snapshotting
the value whole is the other way, where it is one that prints: an `Optional` is
not (see `snapshot-not-printable`), which is usually why the line took it apart
in the first place.

### `unknown-modifier`

A `test` or a `suite` carries a Modifier that is not one. The Modifiers are
`focused`, `skipped` and `tagged`:

```essence
tests {
	test "ranks the table" slowly {}
}
```

A Modifier is what the runner reads, never what the test does — so anything the
runner does not know goes in the body, or goes away.

### `duplicate-modifier`

One `test` or `suite` carries the same Modifier twice. A Modifier says something
about the whole item, so saying it twice can only repeat it or contradict it:

```essence
tests {
	test "ranks the table" tagged slow tagged network {}
}
```

Write every tag on one `tagged`, separated by commas.

### `malformed-modifier`

A Modifier carries the wrong arguments — `focused` takes none, `skipped` takes
one String, and `tagged` takes at least one bare lower-case name:

```essence
tests {
	test "ranks the table" focused "why" tagged "slow" {}
}
```

A tag is matched exactly by `--tag` and `--skip-tag`, which is why it is a bare
name and why it is lower case: two spellings of one tag are two tags, and the
one nobody selects is the one that quietly stops running.

### `skipped-without-reason`

A `test` or a `suite` is `skipped` with no reason given:

```essence
tests {
	test "renders a forfeit as 3–0" skipped {}
}
```

The reason is mandatory. A skip with no reason rots silently; a skip with one is
a note the report repeats on every run, until somebody acts on it. Write it as a
String: `skipped "waiting on the Table redesign"`.

### `contradictory-modifiers`

One `test` or `suite` is both `skipped` and `focused`:

```essence
tests {
	test "ranks the table" focused skipped "flaky" {}
}
```

`focused` asks for this one to run and for the rest not to; `skipped` asks for
it never to run. Which was meant is not something the source says, so neither
wins — say what you mean.

### `duplicate-test-name`

Two tests, or two suites, of one scope are called the same thing:

```essence
tests {
	test "ranks the table" {}
	test "ranks the table" {}
}
```

What a test is called, together with the suites around it, is what identifies it
— to a stored snapshot, to a stored counterexample, and to the editor. Say what
each of them proves, so that a report names the one that failed.

### `test-failed`

An `expect` or a `require` did not hold while the test was running. Unlike every
other code on this page it is not reported by a compile: `essence test` reports
it, and so does the editor's live session, so that a failing assertion is a
squiggle in the Problems list rather than something only a terminal knows about.

```
[test-failed]
Error: 'Standing › the leader is two points clear' failed
    ╭─┤ Season.tests.es:14:9 │
    │
 14 │        expect leader.points::subtract(second.points)::is(2)
    │               ──────┬────── ──────────┬──────────── ──┬──
    │                     ╰─────────────────│───────────────│─── 19
    │                                       ╰───────────────│─── 3
    │                                                       ╰─── this expect failed
    │
    │ Note: `is` compared 3 with 2
────╯
```

The Labels are the values the assertion evaluated on its way to `false` — every
sub-expression the compile recorded, at the span it was written at. There is
nothing to fix in the assertion itself: either the Program is wrong, or the test
is, and the values are what says which.

### `focused-tests-remain`

A run nobody narrowed — no `--filter`, no `--tag`, no `--skip-tag`, which is
what CI runs — still holds a `focused` test. Focusing silences every other test,
so such a run did not answer the question it was asked, and `essence test` exits
non-zero and names every test the focus was left on. Reported by the runner
rather than by a compile; while iterating, a filter makes the same run say
nothing about focus.

An editor can refuse nothing, so it says the same thing where the word is
written: a warning on each `focused` — on the `suite` as well as on the test —
with a Quick Fix that removes it. A `focused` that is also `skipped` narrows
nothing and is not reported either way.

```
[focused-tests-remain]
Error: This test is still focused
    ╭─┤ Season.tests.es:14:2 │
    │
 14 │        test "the leader is two points clear" focused {
    │        ──┬─
    │          ╰── only focused tests ran
    │
    │ Help: Remove `focused` before this lands, or narrow the run with
    │       --filter or --tag while you are iterating.
    │ Note: A focused test silences every other test of the run, so a run
    │       nobody narrowed has not answered the question it was asked.
────╯
```

### `similar-tags`

Two tags in the workspace are within two edits of each other — `slwo` beside
`slow`. A run is narrowed by a tag spelled exactly, so two spellings of one idea
are two sets and `--tag` answers with half of what was meant. Reported on the
rarer of the two, which is the one that is probably the mistake, with a Quick Fix
that renames it to the common one. A workspace-wide question, so only the
Language Server asks it: a compile sees one Module, and `tagged slwo` is
perfectly well-formed inside it.

```
[similar-tags]
Warning: The tags 'netwrok' and 'network' are nearly the same
   ╭─┤ Season.tests.es:21:16 │
   │
21 │        test "reaches the server" tagged netwrok {
   │                                         ───┬───
   │                                            ╰───── 'network' is written elsewhere
   │
   │ Help: Write 'network' here, or rename the other one.
   │ Note: A run is narrowed by a tag spelled exactly, so two spellings of
   │       one idea are two sets, and --tag answers with half of what was
   │       meant.
───╯
```

### `lonely-tag`

Exactly one test in the workspace carries this tag. That is not wrong — a tag
names a set of tests, and a set of one is a set — but it is what a tag that was
meant to catch on and did not looks like, and what a typo nothing else is close
enough to looks like. An `information`, so it never fails anything; the Language
Server reports it and no compile does.

```
[lonely-tag]
Advice: Only one test carries the tag 'flaky'
   ╭─┤ Season.tests.es:33:9 │
   │
33 │        test "settles" tagged flaky {
   │                              ──┬──
   │                                ╰──── no other test carries it
   │
   │ Note: A tag names a set of tests to run or to leave out. A set of one
   │       is a test that can be named by its own name.
───╯
```

### `table-not-written`

The value after `across` is not a written List. A table test is N tests before
anything runs — each row carries its row number as the last step of the identity
a stored snapshot, the Editor's own results and a timing baseline are keyed by —
so the rows have to be countable while the file is being compiled:

```essence
tests {
	§ `scorelines` is a value, and a value has no length until it is evaluated
	test "{scored}–{conceded}" across scorelines (row: Scoreline) {}
}
```

Write the rows where the test is: `across [ … ] (row: Row)`. A row itself is any
Expression, so a List of names is fine — it is the brackets that have to be
there.

### `table-without-rows`

The List after `across` is written and empty. Every row is a test of its own, so
a table test with no rows is nothing at all: no line in the report, no count in
the summary, and nothing that would ever say it had stopped running.

```essence
tests {
	§ nothing runs, and nothing says so
	test "no rows at all" across [] (n: Integer) {
		expect n::isGreaterThan(0)
	}
}
```

Write the rows the test is for. A test that has none for now says why the way
every other one does, with `skipped "…"`.

### `table-parameters`

A table test names its row with exactly one Parameter. Each item of the List is
one row, and one row is one value — a test wanting several values per row says
so by writing a Record and taking it apart where it is bound:

```essence
tests {
	test "adds" across [{ a = 1, b = 2 }] (a: Integer, b: Integer) {}
}
```

Write `({ a, b }: Row)` instead, or `(row: Row)` and read `row.a`.

### `snapshot-not-printable`

`matches snapshot` records what a value LOOKS like, which is what
`Printable::toString` answers — so a value with no such answer has nothing to
record. An `Optional`, a bare structural Union and a `choice` that declares no
`toString` are the three that reach this:

```essence
tests {
	test "renders" {
		expect table::item(at 0) matches snapshot
	}
}
```

Take it apart first — `require #Value(standing) = row` — and snapshot what is
inside, or render it yourself and snapshot the String.

### `inline-snapshot-in-table`

An inline `matches snapshot` was written in a table test. Every row of a table
test runs the same body, and an inline snapshot is one slot of one source line —
so N rows would have N values and one place to write them:

```essence
tests {
	test "{n} doubled" across [1, 2, 3] (n: Integer) {
		expect double(n) matches snapshot
	}
}
```

Name it — `matches snapshot from "doubled"` — and each row records an entry of
its own in the file's `__snapshots__` companion, numbered by the row it ran for.

### `property-parameters`

A `for any (…)` Parameter is not the shape a generated value can be bound to.
Every Parameter writes a name and a Type, and nothing else:

```essence
tests {
	test "add commutes" for any (a, b: Integer) {
		expect a::add(b)::is(b::add(a))
	}
}
```

The Type is the whole of what says what to generate, so it can not be left out.
A Pattern is refused for the same reason a label and a default are: a
counterexample is reported beside the name it was generated for, nothing calls a
test, and every case generates a value of its own.

### `ungeneratable-type`

A `for any (…)` Parameter writes a Type nothing can build a value of — a
Function, a Namespace, a Choice that names itself in a payload, or a checked
refinement whose predicate the generator can not hold:

```essence
tests {
	test "every reader reads" for any (read: (_: String) -> Integer) {
		expect read("x")::isGreaterThan(0)
	}
}
```

Write a Type a value can be built of, or declare a `Generatable` conformance for
the one in hand:

```essence
namespace Team for Team is Generatable {
	static generate(from source: Randomness) -> Team {
		<- { name = source::pick(from ["Lions", "Tigers", "Bears"]) }
	}
}
```

### `ungeneratable-contract`

A remark rather than a mistake. `essence test --contracts` reads every Method a
Namespace declares as the property its return Type states, and runs it: the
receiver and every Argument are generated from the declared Types, the Method is
called, and the answer is expected to hold each conjunct the return Type
promises. A Method it could not build a goal for is named here, once per
Namespace:

```essence
implementation {
	namespace Reading for String {
		§ Nothing knows how to build a Function, so nothing can call this.
		with(each read: (_ text: String) -> Integer) -> Integer {
			<- read(@)
		}
	}
}
```

The usual reason is a Parameter of a Type nothing can generate — see
`ungeneratable-type`. A Method whose signature still mentions a Type Parameter
is left alone without a remark: that is the rule rather than a gap, because a
value drawn for one instantiation proves nothing about the rest, and no
conformance an author could declare would change it.

Write the property as a test of its own, or declare a `Generatable` conformance
for the Type its Parameters could not be drawn from. Nothing is wrong with a
Namespace that reports this: it says which of its promises a run is keeping and
which it is not.

### `reserved-suite-name`

A written `suite` uses a name the Enricher fills itself — `examples`, where the
file holds `@example` blocks, or `contracts`, where the run synthesizes goals
from the file's declarations:

```essence
implementation {}

tests {
	suite "contracts" {
		test "totality" {
			expect true
		}
	}
}
```

Two suites of one name share one identity, and with it everything durable that
identity anchors — stored counterexamples, seeds, and the Editor's focus — so a
collision with a suite no source holds is refused where the synthesis happens.
Call the written suite something else.

### `contradictory-test-forms`

One test wrote both `across` and `for any`. A table test runs its body once per
row a reader wrote; a property test runs it once per value the runner made up.
One body can not do both:

```essence
tests {
	test "doubling" across [1, 2] (n: Integer) for any (m: Integer) {
		expect double(n)::is(n::add(n))
	}
}
```

Keep one of them, or write two tests.

### `benchmark-for-any`

A benchmark wrote `for any`. A measurement is comparable only where every run
does the same work, and a generated value is a different value every case — so
the body would be timed doing something else each time, and the baseline it is
held to would be a number about nothing:

```essence
tests {
	benchmark "sorting" for any (rows: List<Integer>) {
		expect rows::sort()::length()::is(rows::length())
	}
}
```

Write the inputs the measurement runs over — a constant above the benchmark, or
the rows to measure:

```essence
tests {
	benchmark "sorts {size} rows" across [100, 10000] (size: Integer) {
		expect List.of(integersFrom 1, through size)::sort()::length()::is(size)
	}
}
```

### `snapshot-in-property`

A `matches snapshot` was written in a property test. A property runs its body
once per generated value, so a snapshot written there records a different value
every case and only the last of them could ever match:

```essence
tests {
	test "rendering" for any (n: Integer) {
		expect render(n) matches snapshot from "rendered"
	}
}
```

Assert what holds for every value instead, and snapshot a value a test WROTE, in
a test of its own.

### `value-comment-outside-tests`

A `§?` value comment was written outside the `tests { … }` block. It asks for
the value of the Statement it ends, and the points that record one are handed
out while the tests section is compiled — everywhere else it is an ordinary
comment, and nothing ever answers it:

```essence
implementation {
	constant rate = leader::pointsPerGame() §?
}
```

Ask it of a Statement inside the tests section, or write `§` for a comment that
asks nothing.

## Names

### `duplicate-variable`

A name is declared twice in the same Scope.

### `duplicate-type`

A Type or Choice name is declared twice.

### `duplicate-protocol`

A Protocol name is declared twice.

### `duplicate-case`

A Choice declares the same Case twice.

### `duplicate-method`

A Namespace defines the same Method name twice. Methods are stored by name, so
the second definition would replace the first — write an `overload` block when
both are meant to exist.

### `duplicate-property`

A Namespace defines the same static Property twice.

### `duplicate-member`

A Record names the same member twice — in a Literal (`{ a = 1, a = 2 }`), in a
Type (`{ a: Integer, a: String }`) or in a Matcher. A Record holds one value
per name, so the earlier member — and anything its Expression does — would be
dropped.

### `reserved-type-name`

`Self` is reserved — it is what a Protocol calls its conforming Type, and no
declaration may take that name.

### `use-before-declaration`

A Namespace is named by something that runs above the Declaration of it — a
Method call whose Namespace is written further down, a static Property read, a
bare reference, or a conformance witness: a call like `things::sort()` reaches
for the Namespace that makes its items `Comparable`, even though that Namespace
is not written on the line. A Namespace comes into being where it is written,
so a use that runs first has nothing to reach.

Only what RUNS at the top level counts. A Function's or a Method's body runs when
it is called, so it may name a Namespace declared below it; a static Property's
initialiser runs with its own Namespace's Declaration, so it may not. The body of
a top-level `if` runs at the top level like everything around it.

The same rule holds one level in, among the static Properties of one Namespace: a
Namespace names itself from its own body, and its Properties are given their
values in the order they are written, so an initialiser may read a Property
written above it but not one written below it, nor itself. A Method is not
subject to it — it exists before any initialiser runs, so a Property's value may
call one whichever order the two are written in — and neither is a Function
literal written in an initialiser, whose body runs when it is called.

### `unknown-name`

A Variable or Constant that was never declared. The Diagnostic suggests the
closest name in Scope when there is a plausible one.

A bare member name in a Record Literal — `{ port }`, which is
`{ port = port }` — is reported here as well, with a note saying the name is
read as the member's value. There is no way to write a member and leave its
value out.

**Quick Fix — "Change to 'X'":** replaces the name with the suggestion, when
there is one.

### `default-references-later-parameter`

A Parameter's `= expression` default read a Parameter declared after it. A
default may read `@`, the Parameters to its left, and anything the Declaration
is written inside — that is the order the Parameters are declared in, and the
order the values are worked out in at every call. Move the Parameter it reads
in front of the one whose default reads it, or write the value out.

The Parameters of a Declaration are barred from its defaults by NAME, so this is
reported even where something outside the Declaration happens to spell the same
name. It has to be: the value that would be read at run time is the Parameter,
which has nothing in it yet, and not the Constant that shares its name.

### `default-references-own-parameter`

A Parameter's `= expression` default read the Parameter it is written on. The
default is what that Parameter is bound to when a call leaves the Argument out,
so it can not read the Parameter it is deciding. Write the value out, or rename
the Parameter so it does not spell what the default reads.

### `default-references-pattern-binding`

A Parameter's `= expression` default read a name a Pattern in the same Parameter
list binds. A Pattern desugars into Constants at the head of the BODY, and every
default is worked out before the body's first Statement runs, so the name has
nothing behind it there. Read the member off the Parameter itself, or write the
value out.

### `unknown-type`

A Type that was never declared, used in a Type position.

**Quick Fix — "Change to 'X'":** replaces the name with the suggestion, when
there is one.

### `unknown-protocol`

A Protocol that was never declared, used as a Generic bound or in a
conformance clause.

**Quick Fix — "Change to 'X'":** replaces the name with the suggestion, when
there is one.

### `unknown-member`

A Record, Case or Namespace does not have the member that was looked up.

**Quick Fix — "Change to 'X'":** replaces the member name with the suggestion,
when there is one.

### `type-without-members`

A `.` lookup on something that can not have members — only Records, Cases and
Namespaces can.

## Types

### `assignment-type-mismatch`

The assigned value does not fit the declared Type of the Constant, Variable or
static Property. The report points at the value and, when the declaration is in
the same file, at the declaration it is measured against:

```
[assignment-type-mismatch]
Error: This value does not fit Variable 'count'
   ╭─┤ Main.es:3:9 │
   │
 1 │ variable count = 0
   │                  ▲
   │                  ╰── declared as Integer here
 3 │ count = "ten"
   │         ──┬──
   │           ╰──── this is a String
───╯
```

### `argument-type-mismatch`

An Argument does not match its Parameter's declared Type. The message names
the Parameter, the Type it wants, and the Type it got.

### `incomplete-record-argument`

A Record Argument leaves out a member its Parameter's default does not fill in.
A partial default (`using options: Options = { retries = 3 }`) says which
members a call may leave out of the Record it writes; every OTHER member of the
Parameter's Type still has to be written, because the value the callee builds is
the default merged with the Argument and nothing else would fill those members
in. The label names the missing members and the notes name the ones the default
supplies.

Only a missing member is reported this way. A member with the wrong Type, or one
the Parameter's Type does not declare at all, is `argument-type-mismatch` — the
Argument is then not a partial of the Parameter at all, and naming the whole
Type says more than naming a member would. Extra members are not refused as
such: Record assignability is width subtyping, so a value that carries more than
it was asked for is admitted wherever a whole Argument would be, and only a name
the Parameter never declares makes the Argument stop being a partial.

Only an Argument WRITTEN as a Record literal may be a partial. Every other
expression passes a whole Record, and is measured against the Parameter's whole
Type as it always was. That is not a style rule: Record assignability is width
subtyping, so a value typed `{ host: String }` may carry a `retries` of any Type
at all, and the callee filling in the members a caller left out would take that
foreign value for the member it is missing. A literal has nothing to hide — its
Type is its text. The refusal is `argument-type-mismatch`, and it names the rule
in a note.

Where the Parameter has no default, a Record Argument is measured whole and a
missing member reports `argument-type-mismatch`.

### `argument-label-mismatch`

An Argument carries a label its Parameter does not — a different one, none
where the Parameter declares one, or one where the Parameter takes none. A
label is part of how an Argument is matched, at a free Function's call as much
as at a Method's: `loop(startingWith 1, …)` reads its labels the way
`things::sort(by …)` does. The note lists the whole signature, so the labels
the call was supposed to write are all in one place; an overloaded callee is
told the same thing by `no-matching-overload`, once per candidate.

### `argument-count-mismatch`

More or fewer Arguments were passed than the signature declares.

### `default-type-mismatch`

A Parameter's `= expression` default is not a value of the Parameter's Type. A
default stands in for an Argument nobody wrote, so it is held to the Type every
written Argument is held to.

A Parameter carrying a default must write its Type. The Type can not be read
back off the default: `(_ count = 1)` and `(_ count: Number = 1)` accept
different Arguments, and the Parameter's Type is what every caller is checked
against.

A Record Parameter is the one exception, and it is deliberate: its default may
fill in only SOME of the Type's members. `using options: Options = { retries =
3 }` is admitted, and every call then writes an Argument that spells the members
the default left out — `connect(url, using { host = "example.com" })`. Which
members those are is `incomplete-record-argument`'s business.

The partial reading is offered to a Record LITERAL alone. `= someOptions` and
`= { base with pool = 8 }` are held to the Parameter's Type exactly as any other
default is, because what a partial default supplies is read off what it writes —
the same rule an Argument lives by, for its own reason (see
`incomplete-record-argument`).
A complete default keeps its whole meaning as well — the Argument may be left
out entirely, and an Argument that IS written may still be partial.

A Case payload's `= { … }` is held to the same rule, and this code reports it
too: the default may fill in some of the payload's members, and may not name a
member the payload does not declare or give one a value of another Type. What it
may SAY is narrower than what a Parameter's default may say — see
`case-default-not-a-literal`.

### `return-type-mismatch`

A `<-` yields a value that does not match the declared return Type.

### `condition-not-boolean`

An `if` Condition, or a `match` Case's `where` Guard, is not a Boolean. Essence
has no truthiness; a Condition must be a Boolean and nothing else.

### `constant-reassignment`

A Constant, Function, Namespace, Parameter or `@` was assigned to. Declare it
with `variable` if it needs to change.

**Quick Fix — "Declare 'x' as a Variable":** rewrites the `constant` keyword of
the Declaration the Diagnostic points back at. Offered only for a `constant`
Declaration — a Function, Namespace or Parameter has no keyword to swap.

### `missing-return`

A Function that declares a return Type has a path through it that returns
nothing.

**Quick Fix — "Add an empty else branch":** offered only when the body ends in
an `if` with no `else`, which is the one shape that has a mechanical answer.
The branch it adds is empty, so the Diagnostic stays until it is filled in —
what the fix buys is a visible hole instead of a path that falls off the end
invisibly.

### `infinite-recursion`

A Method whose every returning path hands back a direct call to itself, so it
has no base case and can never return. Reported only when the recursion is
unconditional — a call reached through a `match` that narrows the receiver, or
guarded by a branch that returns a base value, is left alone.

### `recursive-type-declaration`

A Type Alias or a Choice names itself — directly (`type Node = { next: Node }`),
or around a cycle of declarations (`type A = { b: B }` with `type B = { a: A }`).
A Type declaration is substituted wherever it is named, so resolving one that
reaches itself would never finish. Recursive Type declarations are not part of
the language yet; the cycle has to be broken.

Every declaration in the cycle reports, each pointing at the name that carries
it onwards, and a note spells the whole way round. A Generic's default Type
counts as naming — `type A<Item = A<Integer>>` is a cycle of one.

Each name in the cycle is still declared, as a Type nothing else can be checked
against, so the rest of the Program is reported on its own terms rather than as
a pile of Types that "are not declared". The one recursive shape reported
differently is a GENERIC Choice naming itself in a payload, which has its own
code, `recursive-generic-choice`.

### `top-level-return`

A `<-` outside of any Function.

### `not-a-function`

A call on an Expression that is not a Function.

### `record-annotation-not-record`

A Record Literal was annotated with a Type that is not a Record Type.

### `path-step-not-a-record`

A step of a member path is read off something that has no members to read —
`.tags.length`, where `tags` is a List, or `.nickname.length`, where `nickname`
is an `Optional`. Only a Record or a Case, which is a Record with a nominal
identity, has members a path can step through.

The label sits on the step that could not be read, and the note names what its
base actually is. An Optional, a Union, a Choice and a List are all values that
are DECIDED before they are read, and deciding one is a Match rather than a
dot — so there is no path spelling for them at all. Write the Function literal
the path would have stood for and decide the value inside it.

### `path-key-outside-combination`

A dotted key was written in a Record Literal standing on its own —
`constant blank: Config = { server.port = 8080 }`. A path reaches into a value
that is already there, and a Literal writes its members from nothing, so there
is no `server` under the key to reach into.

Either write the whole member — `{ server = { port = 8080, host = "db" } }` —
or reach into a value that already has one.

There are three places a Record Literal has a value under it, and a path key is
legal in all three and nowhere else:

- an update's key list, `{ config with server.port = 8080 }`;
- an Argument written for a Record Parameter that carries a default,
  `connect("x", using { server.port = 1 })`;
- the payload of a Case whose payload carries a default,
  `#Get({ limits.calls = 2 })`.

The last two merge into the DEFAULT rather than into a value the call named, and
what a default fills in is what a path may reach into. See
`path-key-without-default`.

### `path-key-without-default`

A path key was written in an Argument or a Case payload — the two Literals that
are merged into a default — but reaches into a member that default does not fill
in.

```essence
function connect(using options: Options = { retries = 3 }) -> String { … }

connect(using { server.port = 1 })
```

`retries` is what this default fills in, so `server` is a member every call
writes for itself, and there is nothing under `server.port` to merge with. Write
the whole member: `{ server = { port = 1, host = "db" } }`.

The other reading is a default that DOES fill the member in, but names a value
for it rather than writing its members out:

```essence
constant fallback: Server = { port = 8080, host = "db" } 

function connect(using options: Options = { server = fallback }) -> String { … }
```

The callee takes `server` from the default or from the Argument whole — a value
can not be taken apart without being worked out, which is the same rule a
default that is not a Literal is hoisted by — so there is no level under
`server` for a path to reach into. Write the member whole at the call, or write
the default's `server` out as a Record Literal, member by member.

A Case payload default that names a Constant reads the same way. Its value IS in
hand there — it is baked into the Case Type — but what a path key may reach into
is read off what the default WRITES, so a member filled from a name is filled in
whole.

A Function taken as a VALUE drops its defaults, so a path key in an Argument
passed through one is refused for the first reason: nothing is filled in any
more.

### `path-on-computed-value`

An update with a dotted key was written on a value that is worked out on the
spot — `{ load() with server.port = 8080 }`. A path reaches into the value one
level at a time, and the compiled form reads the value once for each level it
reaches through, so the value has to be one that reads the same every time: a
name, `@`, or a chain of member reads over one of those.

Bind it to a Constant and update the Constant, or write the nesting out by hand
so the value is worked out once.

The restriction is on path keys alone. `{ load() with port = 8080 }` needs no
level below it and is unaffected.

### `uncombinable-types`

The `<>` combination operator was given something it can not combine — both
sides must be Records or Namespaces.

### `partial-type-mismatch`

The right hand side of a combination is not a Partial of the left hand side. An
update may only set members the original already has, with the Types it declared
for them.

A member whose Type is itself a Record is set as a WHOLE by a plain key:
`{ config with server = { … } }` replaces `server`, and every member of the new
`server` has to be written. That is deliberate, and it is why a nested literal
is never quietly merged into the one beneath it. Under such a merge, adding a
member to a Type would silently turn an old full replacement into a merge that
keeps the old value, with no Diagnostic anywhere — the Program would change
meaning because a Type it does not name grew a member.

Reaching INTO a member is spelled instead, and says so: `{ config with
server.port = 8080 }` merges, and `{ config with server.{ port = 8080 } }`
merges. So `server = { … }` always replaces, `server.port = …` always merges,
and a Type may grow a member without either of them changing meaning. See
`path-key-outside-combination`, `path-key-without-default`,
`path-step-not-a-record`, `path-on-computed-value` and `empty-path-group`.

### `wrong-type-argument-count`

A generic Type was given the wrong number of Type Arguments.

### `type-not-generic`

Type Arguments were given to a Type that takes none.

### `infer-on-applied-parameter`

A Choice or a Type Alias marked one of its Type Parameters `infer`. That
marker belongs to a Function, a Method or a Namespace, where a use site hands
over Arguments a Type Parameter can be worked out FROM. A Choice and a Type
Alias have no such use: every one of theirs applies the Arguments outright,
either in a Type position (`Holder<Integer>`) or at a construction
(`Holder<Integer>#Bare`). Drop the `infer`; the bound and the default, if the
Parameter carries them, stay exactly as written.

### `uninferred-namespace-parameter`

A Namespace declared a Type Parameter without `infer`. A Namespace is the
mirror of the case above: it has nothing BUT a use to work its Parameters out
from, because every receiver it answers for hands the Arguments over
(`namespace Boxes<infer Item> for { value: Item }` reads `Item` off each value
it is called on). Written without the marker the Parameter is opaque and can
never bind, so the target Type matches no receiver at all and the Namespace is
never found — a `namespace Maybe<T> for Maybe<T> is Equatable` was passed over
in silence, and the derived equality of `choice Maybe<T>` answered `is` instead
of the Method written right beside it. Write `infer Item`.

### `zero-denominator`

A Rational Literal with a denominator of zero.

### `invalid-refinement-predicate`

The `where` clause of a checked refinement says something a refinement can not
be compared by. A refinement is a base Type plus a predicate every value of it
has been proven to satisfy — `type NonZeroInteger = Integer where @::isNot(0)`
— and two refinements are the same Type when they prove the same things, which
is why the predicate is stored as a set of resolved Method calls rather than as
the text that was written. Four shapes are refused:

- a base outside Integer, Rational, String and an applied List (`List<String>`
  or `List<Item>`, never a bare `List`);
- a receiver that is not `@` — the clause is a question about the value being
  refined and about nothing else;
- a chained receiver (`@::trim()::hasCharacters()`) — the evidence would be
  about the intermediate value, which nothing proved anything about;
- an Argument that is not written out as a literal.

Several predicates joined with `::and(…)` are one predicate: the chain is
flattened, so `@::isPositive()::and(@::isNot(1))` proves two things and the
mirror image of it proves the same two.

A GENERIC Alias may be refined — `type NonEmptyList<Item> = List<Item> where
@::hasItems()` — and needs no rule of its own: the predicate is read with the
Type Parameters opaque, so a clause that asks about the items (`@::contains(0)`)
is refused by ordinary typechecking, for the Argument it passes rather than for
being generic. What survives asks nothing a Type Argument could answer
differently, which is why `NonEmptyList<String>` and `NonEmptyList<Integer>` are told
apart by their bases alone.

The Alias still means its base afterwards, so everything naming it stays about
itself rather than cascading.

### `predicate-not-boolean`

A refinement's `where` clause does not answer `true` or `false`. A predicate is
a question about the value being refined, so `type Small = Integer where @` and
`type Small = Integer where @::absolute()` are both refused — the first asks
nothing and the second answers with a number. Call a Method that answers a
Boolean, the way an `if` condition does.

## Dispatch

### `no-matching-overload`

The passed Arguments match none of the overloads of the called Method or
Function. Each candidate signature is listed as a note. A candidate a Protocol
PROVIDED is named by the Namespace whose conformance put it in reach, with the
Protocol said beside it — `'Number::isLessThan' (provided by Orderable)`. Where a
DERIVED Method was in reach and a Namespace declaring the name replaced it, a
note says so, because nothing in the listed candidates would show it.

### `ambiguous-namespace`

The passed Arguments match a Method in more than one Namespace, and no candidate
covers the receiver more closely than the others: a Namespace whose target Type
is strictly narrower wins outright — a concrete `for List<Integer>` beats
`List<ItemType>`, and `for List<List<ItemType>>` beats `for List<ItemType>` — so
what is left is a tie, two targets of which neither is the narrower one. The
same target twice is one such tie; so is a pair that does not compare at all.
`for List<Integer> | String` and `for List<ItemType>` are both matched by a
List of Integers, yet the Union is no case of the generic List and the generic
List is no case of the Union, which leaves that receiver with nothing to pick
by. Each candidate is listed by what DECLARES it: a Namespace for a Method it
wrote, and a Protocol beside the Namespace it was reached through for a provided
one — `'Orderable' provides 'isBetween' for 'Integer'.` Qualify the call to pick
one — `value::<Name>method(…)`, where `Name` is either a Namespace or a Protocol
whose provided Method is one of the candidates.

### `undecided-receiver-type`

The receiver's Type still holds a slot nothing has decided — the `List<Unknown>`
an empty List Literal has — and more than one Namespace declares the Method for
it. An undecided slot is matched by every candidate in both directions, so the
narrower-target order of `ambiguous-namespace` would hand `[]::tag()` to
whichever Namespace is nested deepest, decided by a Type the program never
wrote. The candidates are listed; annotate what the receiver comes from —
`constant items: List<Integer> = []` — so the call has a Type to dispatch on. A
receiver like this matched by a single Namespace is fine: nothing was decided by
the Unknown when there was nothing to decide.

### `unknown-method`

No Namespace in scope declares a Method of that name for the value's Type.

**Quick Fix — "Change to 'X'":** replaces the Method name with the suggestion,
when there is one.

### `no-namespace-for-value`

The value's Type has no Namespace at all, so no Method can be found on it.

### `not-a-namespace`

The name in a Namespace specifier — the `Name` of `value::<Name>method()` —
means something other than a Namespace where the call is written. A Namespace
of that name further out is shadowed, and shadowed is what the emitted code
sees.

A Protocol's name is accepted there too, and reaches that Protocol's provided
Methods — which is what tells two Protocols providing one name apart. A
requirement is not reachable that way: it is written by a Namespace, and that
Namespace is what the specifier names.

### `undispatchable-method`

Two or more member Types of the value's Union Type are indistinguishable at
runtime, so the correct Method can not be chosen. Narrow the value with a
`match` first.

### `untyped-namespace-method`

A Namespace declared without a target Type (`for …`) can only hold static
Methods.

### `static-method-on-value`

A static Method was called with instance-call syntax — `value::make(…)`. A
static Method takes no receiver, so there is nowhere for the value to go; call
it on the Namespace instead, as `Namespace.make(…)`.

### `native-property-without-type`

A static Property in a `declarations { … }` Program declared neither a value
nor a Type. A native Property is exactly its annotation — `static Pi:
Transcendental` — so without one there is nothing to declare.

### `indistinguishable-default-parameter`

A Parameter carrying a `= expression` default is followed by another Parameter
with the same label — and every unlabelled Parameter carries the same label,
none, so an unlabelled default may not be followed by any other unlabelled
Parameter.

An Argument is matched to a Parameter by its label before its Type is read,
which is what lets a call's shape be worked out for every Overload candidate
before any Argument is typed, and what lets Completion offer labels for a call
that is still half written. A default lets a Parameter be skipped, and a call
writing one Argument where two Parameters answer to the same label could mean
either of them. Give one of them a label, or make the defaulted one the last of
them.

This is not a rule about defaults having to come last: `(_ a: Integer, _ b:
Integer = 2, to x: Integer)` is legal, because `f(1, to 3)` skips `b` by the
label the next Argument carries.

### `ambiguous-overload-default`

Two entries of one `overload` block accept the same call, because a default on
one of them lets it be called with exactly the Arguments the other one takes.
An Overload is selected by the Arguments a call writes, so two entries that
accept the same ones can not both be reached.

Only a shape reachable by LEAVING A DEFAULT OUT is refused. Entries of the same
written shape that resolve by the Types of their Arguments — `Integer.add`'s
four entries, all of shape `(_)` — are what an `overload` block is for and stay
exactly as they are. The hazard is only ever a shape that did not exist before
the default was written.

A PARTIAL Record default is refused on the same terms one level down. It adds
no accepted shape — its Argument is still written — but it widens the Records an
entry accepts, because a Record written without the members the default fills in
now fits a Parameter it did not fit before. Two entries that told their Record
Parameters apart by Type can therefore both come to accept one call. Only a
Record reachable ONLY by leaving a member out is weighed; entries that already
overlapped by Type stay exactly as they were.

Where a default was written to replace a shorter entry, delete the shorter
entry: the default already means it.

### `fallback-never-used`

A Warning, tagged `unnecessary`: a call writes a `defaultingTo` Argument that
can never be read, because the same call answers a bare value without it. Given
a `constant scores: NonEmptyList<Integer>`, `scores::firstItem()` answers an
`Integer`, so `scores::firstItem(defaultingTo 0)` answers that same `Integer`
and the `0` is dead text.

The proof is what makes it dead. A `NonEmptyList` receiver, an Integer divisor
written as a literal, a separator that visibly has characters — each one reaches
an entry that answers bare, and the entry beside it that answers an `Optional`
is the one the fallback was written for. A checked refinement ADDS Methods and
takes none away, so `namespace NonEmptyList` can answer `firstItem()` bare and
still not hide `List::firstItem(defaultingTo:)`. This Warning is the only thing
that can say so.

The call is refused nothing and compiles as it stands. Drop the Argument.

**Quick Fix — "Remove the 'defaultingTo' Argument":** deletes it together with
the comma beside it, leaving the call as it would have been written — the comma
in front where the fallback stands last, and the one after it where another
Argument follows.

The rule is the label, not a list of Methods: an Invocation that writes an
Argument labelled `defaultingTo` is resolved a second time without it, and the
Warning is reported when that second resolution answers a Type that is not an
`Optional`. A Namespace of your own following the same convention is read the
same way.

Four things have to hold before anything is said, because the Warning claims the
PROOF is what made the fallback dead:

- The bare call answers something that is not an `Optional`.
  `list::firstItem(where check, defaultingTo 0)` can still find nothing, so its
  fallback is live.
- The bare call resolves to something at all. `Optional::value(defaultingTo:)`
  declares no bare `value()`, so its fallback is always live.
- The bare call reaches a DIFFERENT entry. A `defaultingTo` Parameter carrying
  a default value is filled in by the callee, so striking the Argument lands on
  the very entry the call already selected — one entry asked twice, proving
  nothing, while the Argument that was written is still read at run time.
- That entry is one the proof unlocked. The call is resolved a third time with
  the proof erased — the receiver widened to the Type it is refined from, and
  no written value admitted to a refinement — and an entry still reachable then
  was never the proof's doing. An Overload whose other entry answers bare for
  reasons of its own is left alone.

A written value proves what it can wherever it stands, as an Argument and as a
RECEIVER both — so `[1, 2, 3]::firstItem(defaultingTo 0)` is warned about too:
the brackets say the List holds an item, `firstItem()` answers one, and the `0`
is as dead as it is beside the `scores` above.

## Choices

### `empty-choice`

A `choice` that declares no Cases.

### `unknown-case`

No Case of that name was found where one was looked for: a named Choice does
not declare it (`Operation#Ad`), the matched value's Union has none (`case
#Ad`), or no Choice in scope declares it (a bare `#Ad`). The first two forms
list the Cases they did find as notes; the scope-wide scan does not, since it
reaches every Choice in the language.

A prefixed Matcher says which Choice's Case is meant, never which value it
matches, so it has to name one the matched Union has — `case Signal#Red` on a
`Command` is refused.

**Quick Fix — "Change to '#X'":** replaces the Case name with the suggestion,
when there is one — offered on all three forms. The `#` is already written, so
only the name is rewritten, and the underlined span stops short of the sigil.

### `ambiguous-case`

A bare `#Case` is declared by more than one Choice in scope. Prefix it with
its Choice's name — `Colour#Red`.

### `missing-payload`

A Case that carries a payload was written without one. A bare `#Case` is a UNIT
Case's spelling and nothing else — a Case whose payload is defaulted in full is
still constructed `#Case({})`, so that a Case name standing on its own goes on
meaning exactly one thing, on both sides of the JavaScript boundary.

### `unexpected-payload`

A Case that carries no payload was given one.

### `payload-type-mismatch`

The payload does not match the Type the Case declares.

A payload written as a Record Literal for a Case that DEFAULTS its payload may
leave the defaulted members out — `#Get({ url = "/x" })` against
`Get { url: String, headers: List<Header> } = { headers = [] }`. Which members
were left out and should not have been is `incomplete-record-argument`'s
business; anything else about the payload is still this code.

### `case-default-not-a-literal`

A Case payload's `= { … }` default is not a Record Literal, or a value in it is
neither written down nor a Constant of this Module holding one:

```essence
choice Fetch {
	Get { headers: List<Header> } = standardHeaders,
	Head { headers: List<Header> } = { headers = defaults() },
}
```

Where a Parameter's default is evaluated in the callee — one place, the Module
that declares it — a payload default is spliced into every construction of its
Case, and a construction may stand in a Module that never named the Choice at
all. So nothing that had to be worked out THERE can travel with the Type: what
the Case Type carries is DATA, and the default is turned into some at the
declaration.

A value is written down — a Number, a String without holes, a Boolean, and the
Lists, Records and Case values built out of those — or it NAMES a Constant of
the Module the Choice is declared in, which is read there, at the declaration,
and baked into the Case Type as its value:

```essence
constant standardHeaders: List<Header> = []

choice Fetch {
	Get { url: String, headers: List<Header> } = { headers = standardHeaders },
}
```

Following one Constant to the next follows one written value to another and is
fine as far as it goes; what has to be written down is every LEAF. So a Constant
whose value is worked out — `constant biggest = sizes::length()` — is refused,
and its Diagnostic points at the value it stops at.

A name that is no Constant of this Module is refused as well. A Variable holds
whatever it was last assigned, and a payload default is read once; an imported
Constant's value stays in the Module that wrote it, since a Type crosses an
import edge and an Expression does not.

The DEFAULT itself is spelled out even where every value in it is a name: which
members it fills in is read off the ones it writes, so `= standardHeaders` for
the payload as a whole is this code too.

A Constant does not hoist, so one declared BELOW the Choice is not in reach
where the default is read, and reports as `unknown-name` — the answer any
Statement gets for a name written above its declaration.

### `case-default-on-generic-choice`

A Case of a generic Choice was given a payload default. A generic Choice's
payload members are written in terms of Type Parameters every use site decides,
and a value written at the declaration can bind none of them — each use would
want a default of its own. Write the member at each construction instead.

### `unbindable-case-payload`

A Case Matcher binds a name — `case #Value(item)` — for a Case that has no
single value to bind.

The binding names what the CONSTRUCTOR takes, so it works on a Case carrying
exactly one value, the same shorthand that lets `#Value(5)` stand for
`#Value({ item = 5 })`. A Case carrying none has nothing to name, and one
carrying several has nothing single to name; both keep their values reachable
through the Matcher itself, as `@.member`.

### `recursive-generic-choice`

A generic Choice names itself in one of its payloads. A generic Choice's
payloads are substituted eagerly at each use, so a self-reference would never
finish substituting. Recursive Type declarations are not part of the language
yet; the cycle has to be broken.

A Type Parameter that spells the Choice's own name shadows it, so a payload
naming it names the Parameter and is no recursion — `choice Bad<Bad> { … }` is
reported as little as `type Bad<Bad> = { next: Bad }` is.

### `indistinguishable-union-arms`

A generic Choice's payload names a Union with two or more arms mentioning a Type
Parameter — `Val { v: T | List<T> }` — and the comparison is written where the
Type Arguments are Parameters themselves. Equality for a Choice is derived, and
which arm a value belongs to is decided at runtime by what the receiver's Type
Arguments made of the arms; where they made nothing of them, the two arms are
one Type and no descriptor can be right about the payload. Compare the value
where its Type Arguments are known, or write the arms so that something other
than a Type Parameter tells them apart.

### `undecided-type-arguments`

A Case of a generic Choice was constructed where nothing says which `Holder` it
is: through its Choice's name — `Holder#Bare`, `Holder#Full({ value = 1 })` — or
as the bare sigil of a unit Case, `#Bare`, which carries no payload to be read
under either. A Choice's Type Parameters are APPLIED, never inferred: the
payload is checked against the instantiation, it does not pick one. So either
the surrounding position decides — an annotation, a declared return Type, or the
Parameter the construction is passed to, `constant left: Holder<Integer> =
Holder#Bare` — or the construction applies them itself, `Holder<Integer>#Bare`.
A Choice with no Type Parameters at all is never asked: `Ordering#Equal` is
legal anywhere, and so is the bare `#Equal`.

The bare form CARRYING a payload decides what its payload MENTIONS, and only
that: `#Full({ value = 1 })` is a `Holder<Integer>` because its payload is one,
and a `#Stopped({ value = "x" })` of a `Progress<State, Result>` says what the
Result is while leaving `State` to whatever is around it. Where nothing answers
for the rest, this is what reports — the label names both halves, "its payload
decides 'Result', and nothing decides 'State'" — and a payload that mentions no
Type Parameter at all decides none of them. The position is asked first and the
payload answers where it says nothing; a callback's position is asked AGAIN once
the call around it has committed its own bindings, so the spelling a Function
literal with no written return Type answers with — `<- #Done(item)` in a `loop`
or `reduce` callback, which the standard library's folds are written on — is
decided by that position and never reaches this.

Only a payload that STOOD is asked what it decided. A Case that carries one and
was written without reports `missing-payload` — the bare `#Full` of a `Full {
value: Value }` — and one whose payload is not the Case's Record reports
`payload-type-mismatch` — `#Both({ a = 1 })` of a `Both { a: A, b: B }`. Either
says what the reader left out, whichever Type Parameters are standing behind it.

An Argument position decides a bare construction exactly as it decides the
prefixed one: `steps::contains(#Done(2))` against a `List<Step<Integer,
Integer>>` reads both of `Step`'s Arguments off the Parameter Type, the same as
`steps::contains(Step<Integer, Integer>#Done(2))` does — and whichever Overload
of `contains` happens to be declared first, since a candidate that decides
nothing leaves the construction to its payload and nothing else.

A Parameter Type that mentions the CALL's own Type Parameters decides nothing
either, because nothing has decided them: `take(Holder#Full(1))` against
`take<infer Item is Equatable>(_ h: Holder<Item>)` is undecided, and the three
spellings that do decide it are `take(Holder<Integer>#Full(1))`, the bare
`take(#Full(1))` — which falls back on its payload where the Parameter Type has
nothing to say — and a Constant annotated on the way in.

Written Type Arguments that disagree with what the position decided are the
ordinary mismatch of a value that does not fit where it is put, and are reported
as one — `assignment-type-mismatch` in a Declaration, `argument-type-mismatch` at
an Argument — including where the Case carries nothing that could differ, as
`Box<String>#Tag("x")` under a `Box<Integer>` does.

## Patterns

A Pattern names the parts of a value — `{ width, height }` — and is written in
the four positions that take one apart: a Matcher, a Case payload binder, a
Parameter and a Declaration. The grammar is one and the same in all four; what
differs is what each position can do with what a Pattern says, and these three
are reported where it can do nothing with it.

### `refutable-pattern`

A Pattern in a position that can not decline a value holds a member constrained
by a written value — `{ width = 0 }` — at any depth.

A Matcher may hold one, because a member constrained by value asks a question,
and an arm whose question is answered `no` falls through to the next arm. A
`constant` or `variable` Declaration and a Parameter have nowhere to fall
through to: a Declaration is the only thing that answers for the name it binds,
and a Parameter is bound after the call has already been made. A Pattern that
declined in either position would leave the Program with no value and nothing to
do about it.

A member constrained by TYPE is not refutable. `{ width: Integer }` is an
annotation rather than a test, so in an irrefutable position it is checked and
not asked — a value that does not fit it fails as `assignment-type-mismatch`,
the way every annotation fails. Only the written VALUE of `=` makes a Pattern
able to decline, which is also why the bare `{ width }` never can.

Where the question was the point, write a `match`. Its arms are the somewhere
else that a Declaration and a Parameter do not have, and a Pattern that can
decline belongs in one of them — with the Declaration below it, or the call
around it, reading what the arm produced.

### `redundant-pattern-binder`

A Matcher's Pattern names the whole value — `case { x, y } as point`.

Inside an arm, `@` is the scrutinee narrowed to what the Matcher established,
which is exactly what the binder would name a second time. Write `@` where the
name was meant; the names the Pattern's members bind are untouched either way.

A Case PAYLOAD Pattern may carry one — `case #Rect({ width, height } as box)` —
because what the constructor took is not `@`. There `@` is the Case narrowed to
`#Rect` and `box` is the payload inside it, so the two name different values and
an arm has reason to want both.

### `pattern-without-body`

A Pattern stands where a Parameter's name would on a native Method signature or
on a Protocol Method signature.

Neither has a body — a native Method ends at its return Type, and a Protocol
Method never had a block — so a Pattern there would name parts for nobody to
read. A signature says what a call looks like and nothing about how it is
carried out, and how a value is taken apart is the second question. Write one
name here, and take it apart in the implementation that binds it.

## Match Expressions

### `missing-case`

A `match` does not handle every member of the matched Union. The unhandled
Types are listed.

**Quick Fix:** writes one `case` per unhandled member before the Match's
closing brace, indented one level in from the line the `match` keyword sits
on. The bodies are left empty on purpose — a Workspace Edit can not carry the
cursor stops a snippet would, and the `missing-return` Diagnostics that follow
point at exactly the holes.

A member whose spelling is not something a Matcher can be written with — every
Function collapses to `Function` in a Diagnostic — is covered by a trailing
`case _` instead. Only those members share it: the ones that can be written
still get an arm of their own, since one unwritable member is no reason to
make the reader write out the named Cases the Compiler already knows. The
catch-all goes last, because a `case _` above a named arm would make that arm
unreachable. The title names which of the three situations applied — "Add
missing Cases", "Add the missing Cases and a 'case _' for the rest", or "Add a
'case _' for the missing Cases".

### `unreachable-case`

A Warning: a `case` that can never run. Either it matches a Type that is not a
member of the matched Union, or an earlier Case already answers for every Type
it matches — a duplicated `case Integer`, or a Case written below the `case _`
that swallows it. A Case that can decline the values it accepts by Type (one
with a literal Matcher, a value-constrained Record member, or a Guard) takes
nothing away from the Cases below it.

Such a Case is dead code — the Diagnostic is tagged `unnecessary`, so clients
grey it out instead of underlining it. A Case an earlier one covers through
ERASURE rather than through its Type is `erased-case-conflict` below, and an
Error.

### `erased-case-conflict`

An earlier `case` answers for every value of this one through something that
does not survive to runtime. The Program takes the earlier branch and answers
with a value of a Type nothing in the source connects to it, which is why this
is an Error where plain dead code is a Warning.

A Generic Case (`case Value`, inside `<infer Value>`) swallows the rest the same
way `case _` does, even though it names a Type of its own: Types erase before a
Match runs, so it narrows nothing and accepts every value that reaches it. It
can therefore only ever be written last — written above `case String`, it
answered the String where the Signature promised a `Value`.

**Quick Fix — "Remove unreachable Case":** deletes the whole Handler, taking
the line break and the indentation before it along.

A Function-typed member erases the same way: a Signature is not a runtime
question, so `case { fn: (_ n: Integer) -> Integer }` accepts every Record
carrying a callable `fn`, whatever that callback was declared as. Two Cases
telling themselves apart by nothing but a callback's Signature can not be told
apart at all — reordering does not help, and one of them has to name a member
that survives to runtime, or carry a Guard. The payload spelling is the same
test — `case #Apply({ fn: (_ n: Integer) -> Integer })` erases exactly as the
Record Matcher does. A refinement nested in a Matcher's Type erases too — its
predicate is never checked, so two Cases told apart only by a refinement's
evidence ask one question — and the Diagnostic names which erasure it was.

Both erasures reach a Method Invocation on a Union-typed receiver too, whose
branches are the Cases nobody wrote. They are ordered most specific first, so a
branch still covering the one below it covers it through erasure, and the
Diagnostic names the branch that can never run.

### `empty-list-overlap`

A Warning: an earlier `case` — or an earlier dispatch branch — answers for this
one's EMPTY Lists. Item Types erase before a Match runs, so a List Matcher asks
about the items the value holds, and an empty List holds none, which makes it a
value of every List Type there is. `case List<String>` above `case
List<Integer>` therefore runs for an empty `List<Integer>` — and a List-typed
payload requirement (`case #Items({ items: List<String> })`) asks the same
question, so it crosses over the same way.

Only the empty List crosses over; every List with items still reaches the Case
its items belong to. Guard the Cases with `where @::hasItems()` and answer for
the empty List in a Case of its own, or, for a Method Invocation, narrow the
receiver with a Match before calling the Method.

### `refinement-as-matcher`

A checked refinement written where a Matcher narrows by Type — `case
NonZeroInteger`, or the annotation on a Pattern's member (`case #Full({ value:
NonZeroInteger })`). A refinement's predicate erases before the Program runs,
so the emitted check could only ask about the base Type, and the arm would run
for values the predicate refuses — typed as evidence nothing proved.

Match on the base Type instead, and prove the predicate inside the arm the way
every refinement is proven: an `if` condition, a Case naming a written value,
or a written value.

### `match-on-non-union`

`match` requires a Union Type — matching anything else has exactly one
outcome. An Integer or a String is the one exception: a `match` on either that
names at least one VALUE takes the value apart rather than the Type, and is held
to `literal-match-shape` below instead. A `match` on one of them that names no
value asks nothing, so it reports here as everything else does — and a Boolean
does too, since `case true` and `case false` are an `if` written the long way.

### `literal-match-shape`

A `match` on an Integer or a String takes the VALUE apart:

```essence
match n {
	case 0 { … }
	case 1 { … }
	case _ { … }
}
```

Every Case names a written value, and the last one answers for every value the
Cases above it did not name. There are more Integers than a Match can write
down, so that last Case is what makes the Match answer for all of them — write
it as `case _`, or as a Case naming the matched Type itself, which asks the same
thing.

The shape is a rule rather than a style, because the last Case is EVIDENCE:
reaching it proves the value is none of the values named above, which is exactly
what a refinement like `type NonZeroInteger = Integer where @::isNot(0)` is
declared by. So `@` inside `case _` below a `case 0` has Type `NonZeroInteger`
wherever one is declared, and inside `case 0` it has the Type declared by
`@::is(0)`. Four things are refused, each because it would make that untrue or
leave the Match with no answer:

- a Case above the end that names no value (`case Integer` written second) —
  move it to the end, where it belongs;
- a Case that names a value and carries a Guard — a Guard decides after the
  value already matched, so it would let a value the Cases below claim not to
  see through to them. Ask its question inside the Handler with an `if`;
- a Case naming a value of another Type (`case "zero"` on an Integer) — the Case
  is compared to the matched value, and a comparison across Types can never be
  true;
- a Match that ends in a Case answering for only some of the values — one naming
  a value, one carrying a Guard, or one whose Type does not accept everything
  that reaches it.

## Protocols

### `protocol-as-value`

A Protocol name was used as a value. Protocols are only usable as Generic
bounds (`<infer T is Comparable>`) and in conformance clauses (`is
Comparable`).

### `protocol-as-type`

A Protocol name was used in a Type position, with the same reasoning.

### `unsatisfied-bound`

A Type Argument does not conform to the Protocol its Type Parameter is bound
to — either it carries no such bound, or no conforming Namespace is in scope.

### `interpolation-not-printable`

A `{ … }` hole in a String Literal holds a value that does not conform to
`Printable`, so it has no `toString` to turn it into text. Every builtin is
Printable, but a bare structural Union belongs to no Namespace and is not, and
an `Optional` is Printable only when its payload is — match it apart first and
interpolate each Case, exactly as a `case #Empty { … } case #Value(item) { … }`
would.

### `redundant-interpolation-to-string`

A `{ … }` hole calls `toString` on a value that is already `Printable`. The
hole renders its value through that same conformance, so `"{ count }"` and
`"{ count::toString() }"` are the same String — write the shorter one.

Only the bare, String-answering call is redundant. A `toString` given an
Argument picks a form the hole would not — `"{ ratio::toString(as
#Decimal) }"` — and a receiver that is not Printable on its own, a bare
structural Union or an `Optional` whose payload is not Printable, has no
conformance for the hole to reach at all.

**Quick Fix — "Remove the redundant 'toString' call":** deletes the
`::toString()` and leaves the receiver.

### `ambiguous-conformance`

More than one Namespace in scope makes the Type conform to the Protocol, and
none of them targets it more closely than the rest. The same specificity order
Method dispatch uses applies here: a concrete `for List<Integer> is Equatable`
wins over the blanket `List<ItemType> is Equatable`, while a target that only
COVERS the Type without spelling it out — a Union the Type is a member of —
ties with the blanket one rather than beating it.

### `nonconforming-namespace`

A Namespace declares conformance to a Protocol but does not satisfy it — a
Method is missing, its signature does not match the Protocol's, or a fulfilling
Method carries a Protocol bound of its own that the conformance can not assume.

A Choice is the exception, and writing nothing is right there. `is Equatable`
on a Namespace over any Choice is derived from the Cases' tags, and
`is Printable` on one over a Choice whose Cases all carry no payload is derived
too — its `toString` answers the Case's own name, so `#Less` prints `Less`.
Neither derive is offered where the Namespace writes the Method itself. A Case
that carries a payload has no name to print on its own, so `is Printable` there
still needs a written `toString` and reports this without one.

### `conformance-needs-target-type`

Only a Namespace with a target Type (`for …`) can conform to a Protocol.

### `default-on-protocol-requirement`

A Parameter of a `protocol` requirement was given a `= expression` default. A
requirement says which calls a conforming Type must answer; a default is part
of how one of them answers, which is each Namespace's own. Declare the
requirement without the default and write the default on the fulfilling Method.

Note that in this version a fulfilling Method's signature must match its
requirement exactly, defaulted Parameters included — a Method carrying a
default can not fulfil a requirement that does not.

### `protocol-bound-function-value`

A Function with Protocol-bound Type Parameters can not be passed around as a
value yet — call it directly.

### `overloaded-function-value`

An overloaded Function (an `overload` block, or an overloaded free Function like
`loop`) names a set of signatures, not one Function value — a bare reference
would leave every later invocation unable to tell which overload was meant.
Invoke it, or wrap the overload you mean in a Function literal.

### `protocol-bound-namespace-generic`

A Namespace's Type Parameters can not carry Protocol bounds directly — a
conditional conformance (`is Comparable where Item is Comparable`) carries the
bound instead.

### `unknown-where-generic`

A `where` condition's left-hand side does not name one of the Namespace's own
Type Parameters — only a declared Generic can be bound by a condition.

### `conflicting-where-condition`

A `where` clause binds the same Type Parameter twice, or a single Method would
have to satisfy two conformance clauses whose conditions disagree.

### `unwitnessable-where-condition`

A `where` condition binds a Type Parameter that never appears in the
Namespace's target Type — unification can never bind it at a use site, so no
caller could ever supply the conformance it demands.

### `unsatisfied-conformance-condition`

A conditional conformance was selected at a use site, but one of its `where`
conditions is not met — the Type binding a bounded Type Parameter does not
itself conform to the Protocol the condition requires.

A condition is also unmet when nothing has determined the Type it speaks about
yet: `[[], []]::sort()` asks for `List<Unknown> is Comparable`, whose condition
is about the empty Lists' item Type, and an empty List Literal leaves that
unknown. Annotate the List (`constant items: List<Integer> = []`) to say what
its items are.

### `where-on-protocol-extension`

A Protocol extension (`protocol Orderable is Comparable`) carries a `where`
clause. A condition bounds one of the declaring Namespace's Type Parameters,
and a Protocol declares none — there is nothing for the condition to speak
about, and nothing at a use site to prove it with. Write `is Comparable` on its
own, and bound the Type Parameter where the conforming Namespace is declared.

### `unwritable-provided-method`

A `static` or `overload` Protocol Method was given a body. A provided Method is
written on `@`, the conforming value, and is emitted once for every conformer —
a static Method has no receiver for `@` to stand for, and an entry of an
`overload` block is named for its slot in a Method Type the Protocol has no
conformer to resolve against. Write the Method as a requirement, and give each
conforming Namespace a body of its own.

### `recursive-protocol`

A Protocol extends itself, directly or through a chain of other Protocols. A
Protocol's surface is its own Methods together with every ancestor's, so one
that extends itself would never finish resolving. The Diagnostic names the way
back round; break the cycle by dropping one of the extensions.

The Protocol still resolves to its own Methods, so everything conforming to it
keeps reporting about itself rather than about a Protocol that "is not
declared".

### `method-not-on-protocol`

A Method was called on a value whose Type is a Protocol-bounded Type Parameter,
and the Protocol does not declare it. Such a value is known by its bound and by
nothing else — whatever the Type Argument turns out to be at a call site, only
the Protocol's surface is there to be relied on.

This is what a provided Method's body meets when it reaches past its own
Protocol: the body of `Orderable.isLessThan` may call `compare`, every other
Method `Orderable` declares, and everything the Protocols it extends declare,
and nothing else at all. Declare the Method on the Protocol, or bound the Type
Parameter by a Protocol that has it.

### `provided-method-out-of-reach`

A provided Method's body named something the Program declares — a Constant, a
Variable, a Function or a Namespace.

A provided Method is emitted once, as a single const in the band above every
Program that reaches the Protocol, so what the body can name is what that band
holds: the builtins and the standard library. A name written beside the Protocol
is in scope where the body is written and gone where the body lands, so the
Program would compile and then fail at run time.

Give the Protocol a requirement the body calls on `@`, and let each conforming
Namespace reach the name instead.

### `clashing-provided-method`

Two Modules of one compilation each declare a Protocol of the same name, and
both provide a Method of the same name.

A provided Method is emitted once, as a const named for the Protocol and the
Method, shared by every conformer in the graph — so the second declaration would
name the same const and its body would answer for the first. Two same-named
Protocols providing *different* Methods are fine; only a shared Method name
clashes.

Declare the Protocol once and import it where it is needed, or rename one of the
two.

## Inference

### `uninferable-type-parameter`

A Type Parameter could not be inferred from the Arguments.

### `uninferable-parameter-type`

A Parameter of a Function Literal has no Type and nothing to infer one from —
only a Function passed as an Argument takes its Types from the surrounding
context.

### `path-without-context`

A member path — `.price`, `.address.city` — was written where no Function of
one Parameter is expected. A path is a Function the Compiler writes for you, so
it needs a Parameter Type to read the members off, and only the position it
stands in can name one. This is the rule a bare `#Case` lives by, for the same
reason: a structural language can not invent a Root Type out of a member name.

A path is read wherever a Function Type of exactly one Parameter is expected —
an Argument matched against such a Parameter (`products::sort(on .price)`), a
Constant or Variable with such an annotation, an Assignment, a `<-` under such a
return Type, an item of an annotated List, and a member of an annotated Record.
Everywhere else, write the Function literal the path would have stood for:
`(_ item: Product) { <- item.price }`.

A Function of two Parameters is refused here too, and the note says so: a path
reads its members off one Argument, and a comparison — `sort(by:)` — is handed
two. `sort(on .price)` is the keyed spelling for that.

### `uninferable-item-type`

A Function Literal captures a Variable whose Type still has a slot nothing has
decided — `variable items = []` leaves the item Type unknown until an
assignment decides it.

The assignment narrows the Variable, but a Function written above it was
already checked against the undecided Type, and `List<Unknown>` fits every
List: the captured `items` could be returned as a `List<String>` and hold
Integers when it runs. Annotate the declaration (`variable items: List<Integer>
= []`) so the body is checked against the Type the Variable will hold.

### `uninferable-return-type`

The return Type could not be inferred from the body; give the Function an
explicit `-> Type`.

### `missing-return-type`

A Function that is not passed as an Argument must write its return Type.

## Documentation

A `§§` block above a Declaration documents it. These are always Warnings — the
Program compiles either way, and what is wrong is the description rather than
the code it describes.

### `missing-documentation-separator`

A `@param` or `@returns` tag carrying its text on its own line ran the two
together. The two are separated by an em-dash — `@param other — the String to
add` — so that the name and its description stay legible in the source. A tag
that leaves its text to the lines below it needs no separator. The text is
lifted into the Documentation either way.

A `@param` line documents the Parameter at its own position. The first line
documents the first Parameter, the second the second, and each names its
Parameter the way the signature names it: the label, or `_` where the Parameter
carries none. The internal name a body reads a labelled Parameter under is not
a second spelling for it — a line naming that is
`misnamed-documentation-parameter`, and a Parameter no line reached is
`undocumented-parameter`.

### `unknown-documentation-parameter`

A `@param` line stands where the signature has no Parameter — past the last
one, or above a Declaration that takes none at all. Such a line attaches to
nothing, and is rendered into every Hover regardless: a description of a
Parameter that the reader cannot find.

A `§§` block above an `overload` keyword documents the set as a whole, where a
position means nothing, so a line there may name a Parameter of any of the
Overloads, under either of the names that Parameter is written with.

A Declaration whose value is not written as a Function Literal is left
unchecked: `constant alias = greet` is function-valued, but its Parameters
survive only in a resolved Type, which keeps no internal names, so a `@param`
there cannot be told from a typo.

### `misnamed-documentation-parameter`

A `@param` line names a Parameter other than the one at its position. The
common cause is a line left out rather than a name misspelled: the lines then
describe the second Parameter first, and the Diagnostic says which Parameter
the written name belongs to.

### `undocumented-parameter`

A Parameter that no `@param` line reached. A block that writes no `@param` at
all documents the Declaration as a whole and is left alone; once a block starts
documenting Parameters, it documents every one of them.

## Modules

One file is one Module, and a Module names the ones it depends on by their
specifiers — the paths in the `from` clauses of `import { … }` and
`export { … }`. These are reported while the graph of those files is being
loaded, before any of them is enriched.

### `invalid-module-specifier`

A specifier is not a path this Compiler will read. It has to be relative,
beginning with `./` or `../`, and to include the `.es` extension: nothing is
appended to it, no directory is searched, and no package is looked up, so what
it names is exactly what is read. `Geometry.es`, `/src/Geometry.es` and
`./Geometry` are each reported here.

The same code covers a specifier that names a standard library source. The
standard library is one shared declaration space rather than a graph of
Modules — everything it declares is already in scope in every Program, so
there is nothing to import and no way to import it.

### `module-not-found`

The specifier resolved to a path nothing could be read at. The Diagnostic names
the resolved path, since a specifier several directories deep rarely reads as
the file it lands on. The entry file being unreadable is reported under this
code as well, without a source location — there is no Program to point into.

### `self-import`

A specifier resolves to the file it is written in. Everything a Module declares
is in scope inside it already, exported or not, so such an entry can only be a
path that was meant to point elsewhere.

### `not-exported`

The Module the specifier names does declare that name — and keeps it private. A
name is private unless the `export { … }` block lists it, so the fix belongs to
the file being imported from rather than to the entry: add the name to its
export block, under an `as` if it should be published differently.

### `unknown-export`

The Module the specifier names declares nothing under that name. Names are
matched against what a Module exports, under the names it exports them *as* — an
`as` on its export entry renames it for every importer, so an entry may have to
ask for a name that appears nowhere in that file's implementation.

### `duplicate-import`

An import binds a name in this Module exactly as a declaration does, so two of
them cannot share one. Reported whether the name is taken by a builtin, by
something this file declares, or by another entry of the same block. `as` is the
fix: it renames the entry locally, and leaves the exporting Module untouched.

The entry is refused rather than allowed to shadow, so whatever already held the
name still means what it did.

### `export-of-unknown-name`

An `export { … }` entry with no `from` clause exports something this Module's
implementation declares, and nothing here declares that name. Adding a `from`
clause turns it into a re-export, which forwards a dependency's name without
binding it locally.

### `export-of-variable`

Functions, Constants, Type Aliases, Choices, Protocols and Namespaces can be
exported. A Variable cannot: a Variable another Module can read is state two
files share and neither owns, and which of them wrote it last is not something
either one states. Declare it as a Constant, or export a Function that answers
with its value.

### `cyclic-constant-import`

A Constant imported from a Module that (directly or through further Modules)
imports this one back. Cycles are allowed for everything that hoists — a
Function, a Type Alias, a Choice, a Protocol, a Namespace — because those are in
place before any Module body runs. A Constant is not: its value exists only once
its Module's body has run, and inside a cycle which body runs first is decided
by the entry point rather than by any of the files in it. The name would be read
in its temporal dead zone.

Move the Constant into a Module outside the cycle, or expose it as a Function.

### `cyclic-side-effects`

A Warning. A Module inside a cycle whose top level does something beyond
declaring names — a call, an assignment, any Statement that runs. Module bodies
run once, on first import, dependency-first; inside a cycle there is no first,
so the order these Statements happen in is not something the source states. The
Program is well-formed, and it is well-formed in more than one way.

### `unused-import`

A Warning, tagged `unnecessary` so an Editor renders the entry faded. Nothing in
this Module reads the name.

A Namespace counts as used when a Method dispatches through it, even where the
call never spells its name: `rect::area()` is what an imported
`RectangleMeasurable` is for, and the import is what makes that call resolve at
all. The check deliberately over-counts elsewhere — a name that only appears as
a Method name is treated as a use — because a Warning that fires on a name the
Module does need is worse than one that stays silent.

### `dependency-has-errors`

A Module this one names reported errors of its own. What a Module exports is
read off a Module that compiled, so until that one does, a name an entry here
asks for may resolve to an Error or not resolve at all — and the mistake is in a
file that is very likely not open.

Reported by the Language Server, on the specifier of the first entry naming the
Module: six names imported from one file are one thing to go and fix. A terminal
report has every file's Diagnostics side by side already and does not repeat
itself this way.

## The Compiler as a program

These are not about a Program at all — they are about the run. They carry no
source location, because there is none to carry.

### `file-not-found`

The named source file does not exist.

### `not-a-file`

A directory was passed where a source file was expected. Pass the files inside
it, for example `src/*.es`.

### `unreadable-file`

The file exists but could not be read — most often a permissions problem.

### `bundle-failed`

The generated JavaScript could not be bundled. Always a Compiler bug — the
Rewriter only ever emits JavaScript it built itself.

### `bundler-warning`

A warning from the JavaScript bundler, passed through unchanged.

## Everything else

### `at-outside-method`

`@` was used outside a Method or a Match Handler, where there is nothing for
it to refer to.

### `at-in-static-method`

`@` was used inside a static Method. A static Method is called on its
Namespace rather than on a value, so it has no receiver — take the value as a
Parameter, or drop `static` to make the Method an instance Method.

### `internal-error`

The Compiler threw where it should have reported. Always a Compiler bug —
please report it, with the Program that triggered it.
