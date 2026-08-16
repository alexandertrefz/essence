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

## The Descriptor compiled

Measured at **bb5bfb7d**, where every Descriptor node is compiled once into the
closure that is its rule and a call runs closures rather than walking a shape.
Three runs of the same command, on the same machine, Bun 1.3.14 — and each row
below is the ONE run whose marshalled figure was the median of the three, rather
than three medians laid side by side: the columns of a row are then a single
real call, and its `×` is a ratio that was actually measured.

```
layout(_ rows: List<List<Integer>>, _ labels: List<String>) -> List<{ index: Integer, status: String }>

shape  nodes      in  body µs  raw µs  marshalled µs      ×  raw ns/node  marshalled ns/node
-----  -----  ------  -------  ------  -------------  -----  -----------  ------------------
  2×4     21  bigint     0.09    0.31           0.35  1.13×         10.5                12.4
30×29   1023  bigint     3.30   15.77          15.25  0.97×         12.2                11.7
89×87   8191  bigint    27.68  128.96         128.81  1.00×         12.4                12.3
  2×4     21  number     0.07    0.22           0.30  1.34×          7.1                10.8
30×29   1023  number     3.61    9.39           9.55  1.02×          5.7                 5.8
89×87   8191  number    29.90   77.54          67.12  0.87×          5.8                 4.5

resize(_ panel: Panel, _ amount: Integer) -> Panel

shape  nodes      in  body µs  raw µs  marshalled µs      ×  raw ns/node  marshalled ns/node
-----  -----  ------  -------  ------  -------------  -----  -----------  ------------------
panel     25  bigint     0.08    0.27           0.56  2.10×          7.6                19.3
panel     25  number     0.08    0.24           0.50  2.13×          6.4                17.1
```

Run-to-run spread (marshalled µs, three runs):

```
  2×4   bigint: 0.35, 0.36, 0.34      2×4   number: 0.31, 0.27, 0.30
  30×29 bigint: 15.82, 15.25, 14.46   30×29 number: 9.67, 8.12, 9.55
  89×87 bigint: 129.75, 128.81, 117.91  89×87 number: 77.20, 65.99, 67.12
  panel bigint: 0.56, 0.57, 0.53      panel number: 0.50, 0.47, 0.50
```

Run-to-run spread (raw µs, three runs):

```
  2×4   bigint: 0.31, 0.31, 0.29      2×4   number: 0.27, 0.22, 0.22
  30×29 bigint: 15.82, 15.77, 14.57   30×29 number: 10.24, 8.82, 9.39
  89×87 bigint: 125.55, 128.96, 125.42  89×87 number: 82.76, 74.19, 77.54
  panel bigint: 0.27, 0.28, 0.25      panel number: 0.24, 0.23, 0.26
```

### The control

The raw door has not changed a line, and it does not measure the same as it did
on the baseline day: 125–129 µs at 8191 bigint values against the baseline's
119–121. That is the machine, and a before/after read across it would be reading
the machine as well as the work.

So the boundary AS IT WAS at f72dbb85 was measured again in the same session,
minutes before the table above — the two files the compile step touches put back
and nothing else changed:

```
89×87  8191  bigint   307.82 µs  2.53×      89×87  8191  number   252.37 µs  3.37×
89×87  8191  bigint   333.92 µs  2.63×      89×87  8191  number   249.94 µs  3.25×
panel    25  bigint     1.35 µs  5.26×      panel    25  number     1.36 µs  5.93×
panel    25  bigint     1.42 µs  5.40×      panel    25  number     1.35 µs  5.92×
```

Which is the baseline reproduced — for the bigint rows. The number rows are not
the baseline reproduced, and saying so is the point of a control: 250 and 252 µs
here against the baseline table's 210 for the same configuration is **19%
apart**, where the raw door's own drift is 5%. One of those two is the wrong
number to divide by, and the file cannot say which.

So the number row was measured again, properly: five rounds of old door and new
alternating in ONE session, a fresh process for each, so that nothing between
them is the machine.

```
old  243.03  273.61  250.69  262.11  228.33 µs
new   66.74   71.65   67.95   67.09   67.80 µs
```

The old door's number row swings **228 to 274 µs**, which is why the baseline
table caught it at 210 and the control at 250. Its bigint row does not do this —
three runs in the same session gave 312.57, 311.13 and 307.71 µs against the
baseline table's 297, the same 5% the raw door drifted. So the bigint win below
is a figure and the number win is a range, and the range is the honest form of
it rather than a hedge.

Every comparison below is between two doors that were measured against the same
machine within the hour.

## Reading the second table

The nested call is now AT the hand-built door rather than 2.5× behind it —
**1.00× at 8191 bigint values and 0.87× with numbers**, 0.97× and 1.02× at a
thousand, and 1.1–1.3× at 21, where a call is small enough that what a door does
once weighs as much as what it does per value. Against the same door measured
in the same session, the marshalled `layout` went from 308 and 334 µs to 129
with bigints, and from 228–274 µs to 67–72 with numbers: **2.4–2.6×** and
**3.1–3.9×** faster, and it is the same marshaller, checking the same things and
saying the same sentences when they are wrong. The number figure is a range
because the door it is divided by is one — see the control above; 3.1× is the
baseline table's 210 µs and 3.9× the slowest old run measured beside a new one.

Below 1.00× wants a word, since a door that checks nothing ought to win. The
hand-built door is a plausible one rather than a floor: it grows its Arrays with
`push` where a compiled walk knows the length before it starts, and it reaches
`bridge.integer` through the bridge object where the compiled walk holds the
Function itself. Those are exactly the kind of thing a boundary compiled ONCE
gets to do and a boundary written by hand at every call site does not.

`marshalled ns/node` is the number the work was aimed at, and it fell from
**30–34 ns to 11.7–12.4 ns** with bigints and from **21–28 ns to 4.5–10.8 ns**
with numbers. Flat is no longer the point — what is left per value is the same
order as the raw door's 5.7–12.4 ns, which is to say it is the values rather
than the walk.

The edit is the row still above the hand-built door: **2.1×**, down from
5.3–5.9×. Half a microsecond for 25 values is not much room, and what is in it
is worth naming precisely, so the two directions were timed apart:

```
exports.resize (whole)   0.507 µs
  in:   fromJS(panel)    0.296 µs      the same Record built by hand: 0.111 µs
  body: the Module       0.069 µs
  out:  toJS(answer)     0.113 µs
```

The way IN carries the gap, and more than half of what it carries is the two
promises the hand-built door does not make. Normalising the five Strings to NFC
costs **66 ns** — String equality in Essence is normalised, so a door that
skipped it would put two values into the Module that the Module insists are
one. Reading the Record as CLOSED — the value's keys against the members the
Type names — costs **40 ns**, and it is what turns a misspelled member into a
refusal instead of a silently dropped one. The remaining ~80 ns is the per-leaf
admission itself: a `typeof` per value, the `Optional`'s arm, and the Array a
List is copied into. The 29 ns the three lines do not add up to is the call
around them — the Integer beside the Panel, and the arity a call is read
under.

So the door is now the price of what the door PROMISES, at every size worth
measuring. What is left to take is the promises, and they are not for sale.

## The node the tables do not reach

`layout` and `resize` take and answer plain data, which is what an embedding's
hot call usually is — so neither table above crosses a Function value, and a
Function was the one node still interpreting after everything else was compiled.
`wrapFunction` re-ran `labelsOf`, three `parameters.map` allocations and every
`argument N` string on each crossing, though a signature settles all of it and a
signature is fixed when the Module is declared.

Measured at **46b3eaf1** against the commit before it, on the same machine, one
process per figure: 20 000 warm-up turns, then the fastest of fifteen batches of
20 000, over `Bun.nanoseconds()`.

```
                                        before     after
a Record holding a Function, per read   57–65 ns   24–26 ns
a Function answered by a call           75–77 ns   34–37 ns
a call that crosses no Function         35–38 ns   35–38 ns
```

It is not in `tools/bench.ts` because there is nothing there to compare it
against: the raw door hands a Module's Function over as the emitted one, which
takes tagged values no host holds, so the two doors are not doing the same work.
The comparison that means something is before against after.

Paid per VALUE rather than per binding, which is what makes it worth a WeakMap:
a constant is marshalled where it is READ, so a host reading `handler.callback`
in a loop wraps a fresh callable every time round it, and a Module Function that
answers with a closure wraps one on every call. The third row is the control — a
call whose Arguments and answer are all plain data touches none of this, and
does not move. The two tables above were re-run at the same commit for the same
reason, and did not move either.
