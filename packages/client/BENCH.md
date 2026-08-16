# The marshalling boundary, measured

`exports` is not free. Every value that crosses it is walked against the
Descriptor its position declared — checked, canonicalised, and given a path to
be named by if it turns out to be wrong — while a host that binds `raw` and the
bridge builds its values by hand and takes the answers apart by hand, checking
nothing. This file is the difference between the two, as a number.

## What is measured

`src/tests/files/Bench.es` holds one embedding's own two calls:

```
layout(_ rows: List<List<Integer>>, _ labels: List<String>)
    -> List<{ index: Integer, status: String }>
resize(_ panel: Panel, _ amount: Integer) -> Panel
```

Both doors are timed over the same work — build the Arguments from JavaScript
values, call, read the answer back as JavaScript values:

- **raw** — `module.raw` and `module.bridge`, the boundary a host wrote itself
  before there was one to import. It is written out inside `tools/bench.ts`, so
  what it costs is visible beside what it does not do: it takes every shape on
  trust, normalises no String, and has no path to spell when something is wrong.
- **marshalled** — `module.exports`, the same call through the interpreter.

The **body** column is the Module's own call with its Arguments already built
and its answer unread. It is the same work under both doors, and subtracting it
is what leaves the door on its own — which is what `ns/node` reports.

One **node** is one value the boundary visits in a call, counting both
directions: every List box, every Record, every Case and every leaf. `layout`
over `rows × columns` visits `3 + rows × (columns + 5)` of them, which is what
puts a call over 21 values and a call over 8191 on one scale.

## How to run it

```sh
bun packages/client/src/tools/bench.ts
```

About four seconds, and it prints the tables below. `tools/` is excluded from
the publish program, so nothing here ships.

Two things the harness does that are worth keeping if it is ever rewritten. It
settles every path before timing any of them — all four cases share the same
Functions, so a door timed first is timed against an engine that has seen
nothing else. And it runs **one kind of Integer per process**: `createIntegerFrom`
is one Function, and a caller that hands it both a bigint and a number in the
same run leaves the engine no monomorphic path to compile, which made the number
half of an earlier table measure 206 µs where it truly costs 74 µs — and say,
wrongly, that numbers cross more slowly than bigints.

## The baseline

Median of three runs of `bun packages/client/src/tools/bench.ts`, each run
itself the median of 15 samples. Measured at **f72dbb85** — the commit this
bench was written against, and the boundary exactly as the commit that adds
this file leaves it — on an Apple Silicon Mac (darwin arm64), Bun 1.3.14.

```
layout(_ rows: List<List<Integer>>, _ labels: List<String>) -> List<{ index: Integer, status: String }>

shape  nodes      in  body µs  raw µs  marshalled µs      ×  raw ns/node  marshalled ns/node
-----  -----  ------  -------  ------  -------------  -----  -----------  ------------------
  2×4     21  bigint     0.07    0.26           0.69  2.65×          9.0                29.5
30×29   1023  bigint     2.98   13.88          34.91  2.52×         10.7                31.2
89×87   8191  bigint    24.55  119.66         297.23  2.48×         11.6                33.3
  2×4     21  number     0.08    0.23           0.62  2.70×          7.1                25.7
30×29   1023  number     2.97    8.66          24.56  2.84×          5.6                21.1
89×87   8191  number    25.30   72.30         210.43  2.91×          5.7                22.6

resize(_ panel: Panel, _ amount: Integer) -> Panel

shape  nodes      in  body µs  raw µs  marshalled µs      ×  raw ns/node  marshalled ns/node
-----  -----  ------  -------  ------  -------------  -----  -----------  ------------------
panel     25  bigint     0.07    0.24           1.33  5.54×          6.8                50.4
panel     25  number     0.07    0.22           1.30  5.91×          6.0                49.2
```

## Reading it

The marshalled door costs **2.5× to 2.9×** the hand-built one on the nested
call, at every size — the same order as the ~2× the field measured on its own
data, and it does not improve with scale. The edit is worse: a Record of
thirteen values costs **5.5× to 5.9×**, because a call small enough for the
per-call work to matter pays for that work in full.

The number the work is aimed at is `marshalled ns/node`. It is flat — **about
30 ns a value with bigints, 21–26 ns with numbers** — and flat is the point: it
does not fall as a call gets bigger, because the interpreter re-decides what
every value is on every call. The raw door's 6–12 ns is what the same values
cost when the shape is already known. The gap between the two columns is the
per-value walk: the kind dispatch, the option checks on every leaf, and the path
spelled whether or not anything is ever wrong.

Passing numbers instead of bigints is worth **10–30%** of a marshalled `layout`
and rather more of a raw one, which is the runtime's hybrid Integer rather than
the boundary: `bridge.integer` canonicalises a bigint that fits a double into
one, and neither door can skip it.

Two smaller readings. The `body` column says the Module's own call is 8–12% of a
marshalled `layout` and 5% of a marshalled `resize` — so nearly all of what the
marshalled door costs IS the door. And the per-value columns hold across three
orders of magnitude, drifting up by about a fifth at the largest size when the
values are bigints, which is the one place either door's cost is not purely
per-value.
