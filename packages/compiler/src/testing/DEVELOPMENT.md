# Developing the test-run modules

These modules read a test run back out of its events and keep the files a run reads and writes. The compiler's
own map is [packages/compiler/DEVELOPMENT.md](../../DEVELOPMENT.md).

## The failing-example corpus

A property test keeps every value it has failed on, so the next run asks about them before it draws anything. A
random search rarely finds the same value twice. A seed replays the case the search started from, not the one it
shrank to, and a printed counterexample does not read back. So the shrunk value is written down as data, as the
runtime's `encode` in `Generators.ts` answers it. As with snapshots, the runtime never touches a file. Whoever
starts a run reads the entries, hands them over, and writes back what the run reported.

The corpus lives in `__counterexamples__` beside the source, a sibling of `__snapshots__`, so the values travel
with their file. It is JSON keyed by the test's identity without its Module step, each entry holding its
counterexamples newest first. It is JSON rather than the `.snap` format because it holds nested, typed data that
nobody reads by eye. `printCorpusFile` indents with tabs and sorts keys, so writing the same corpus twice writes
the same bytes.

A file with another `schema` reads as no corpus at all. A corpus only speeds up a search that works without it.
`parseCorpusFile` answers null for a file that is not a corpus, never an empty store. An empty store may be
written over, and a mangled one must be left alone, or a merge conflict loses every stored regression.
`readCorpus` reports such a file as unreadable, and `writeCorpus` skips it until someone fixes or deletes it. A
missing file is an empty store, since most Modules have never failed.

`collectCorpusChanges` reads the additions and removals off the `property` events, which carry the Module and
the key. `writeCorpus` lays them over what was read:

- Removals go first, by their index in the list as read, from the back so no index moves.
- A new counterexample goes to the front, since the newest failure is the one most worth asking first. One the
  file already holds, compared by its data, is not written again.
- Each test keeps at most `CORPUS_LIMIT` values, enough for a property with several distinct bugs. The oldest go.
- A key no test of this run claimed is kept, since a run narrowed by `--filter` or a tag has not visited every
  test. Only an entry the run read and could not decode is dropped.

A file left empty is removed, and its directory is kept, since it may hold another Module's companion.

## Coverage

`coverage.ts` reads what a coverage run means out of the `coverage` events alone, which carry the compiler's point
table and each point's count. The CLI's table, the report files and the language server's per-file payload all
read this one answer, so they agree on what a percentage means.

`collectCoverage` folds the stream into one record per Module. A run may report a Module twice, when two entries'
graphs both hold it. The Module really was loaded twice, so the counts are added, and every ratio only asks
whether a point was reached. Two reports whose tables differ are two compiles of the Module, as in a watch session
mid-edit, and the later replaces the earlier whole. `sameTable` compares each point's kind and start position,
since adding across two tables would credit one compile's counts to another's points.

`mergeCoverage` lays one cycle's answer over the last, for a watch session and the language server, which re-run
only the tests a change reached. A Module in the new answer replaces the old one whole, and any other keeps what
it had. Which Cases were constructed is worked out again over the merged whole, since a Choice is declared in one
Module and constructed in any.

`fileCoverageOf` counts lines as lines, so two Statements on one line are one line. Branches and arms count
towards their line, since control arrives there as at a Statement. A Case construction does not: it is an
Expression inside a Statement already counted. So a `Foo.tests.es` file, instrumented only for the Cases its tests
build, has no line coverage. `isReported` leaves it out of the table, and its constructions still count.

`percentageOf` answers null where there is nothing to measure, which a report draws as a dash. It rounds down, so
100% means every point: 199 of 200 is 99, and a gate reading it does not pass a missed branch.
