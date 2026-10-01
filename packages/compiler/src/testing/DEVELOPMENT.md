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
