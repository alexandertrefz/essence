# Developing the command line

`essence` parses its arguments, loads the project file, and runs one command. [README.md](README.md) covers using
it. This file explains how its parts fit together.

## What the result cache remembers

`essence test` can answer an entry from a record of an earlier run instead of running it. A replayed record claims
that its tests passed, were skipped or were deselected. Each rule here keeps that claim true.

`remembersResults` decides whether a run reads or writes the cache at all. It refuses a run made for the file it
leaves behind (`--update`, `--coverage`) and one that measures the machine (`--bench`). It refuses a run that chooses
which values property tests draw: `--seed`, or a `--cases` that differs from the project's setting. It also refuses
`--mutate`: a mutant is compiled from changed sources, and a record keyed by the real bundle would claim the real
code passed. `--json` is allowed, since a replay writes the same events. The filters are part of the key, so a
narrowed run is an answer of its own. A watch session and the Language Server never use the cache: they rerun only
what a change reached, from bundles they already hold.

`isRemembered` decides whether one entry's events may be recorded:

- A failure always reruns. Its reader wants this run's output, and the failing entry is the one being edited.
- A `not-focused` deselection is never recorded. What a focus silences is decided across a whole run.
- A property test is never recorded. Fresh values on every run are the point of the search. The values it failed on
  before live in the corpus, which is part of the key.
- A snapshot or baseline that was written changed a file the key reads. The entry is recorded on the next run, once
  it matches what it wrote.
- Deselections by tag, filter or `bench`, and skips, follow from the manifest and the filters in the key, so they are
  recorded like a pass.

`runTest` adds the rules that need the loaded bundle. A focused run records nothing, because every entry of it
reports what the focus decided. An entry is not recorded when a Module's own statements read host input or any code
drew entropy, since the key holds neither. An entry whose bundle links the effectful runtime is not recorded either.
That check runs before writing, so a warm run never reads the bundles it replays.

Records are written after the snapshot, baseline and corpus stores, so every key reads a settled disk.

### The result key

`src/resultCache.ts` keeps one record per entry, the unit the bundle cache names and a watch session reruns. Essence
is pure, so an entry's outcome follows from its code, the stores it compares against and the tests the run selected.
`resultKey` hashes all of them:

- `RESULTS_FORMAT`, so a change in what a record means retires every older name at once.
- `hostKey`, since a bundle inlines its runtime but not its host, and the host decides things events show.
- The bundle cache's key, read off the bundle's file name by `bundleHashOf`. It covers everything about the code.
- The filters, so a narrowed run is remembered as an answer of its own.
- The text of every snapshot, baseline and corpus file of every Module the entry reaches, labelled by base name. A
  missing file is the empty string, so deleting one changes the key.

The key holds no network traffic, no host input and no entropy, which is why an entry that touched any of them is
never recorded. A replay writes the entry's events verbatim, so a reader and a `--json` consumer see what the live
run wrote. Records are written atomically and never replaced, since a file under the same key answers the same
question. The store follows the bundle cache's rules for its area variable, `ESSENCE_RESULTS_CACHE`, and its
age-ordered pruning.

## The bundle cache

`src/cache.ts` keeps the bundles `esc` emitted, each named by `bundleKey`. The key hashes every source of the linked
graph, the Optimiser options, the toolchain, the Compiler's own fingerprint and `emitterKey`. Simplifying, optimising,
generating and bundling are a pure function of those, and they are most of what a build costs. Two compiles that agree
on the key emit the same bytes.

`emitterKey` names everything that changes the bytes without changing the graph. That is `EMITTER`, minifying, the
emit target, the runtime bridge, the compile mode and the source map's shape. A linked map adds the output's base
name, since the bundle's last line spells it. The same sources built into two directories share one entry. The
Compiler's fingerprint is in the key because `esc` is what a Compiler developer runs, so an edited Rewriter must never
reuse a bundle. `EMITTER` stands in for `esc`'s own code.

`compileFile` takes the key from the linked graph and reads the cache before emitting. So the front half always runs:
every Diagnostic about the source is reported, and `esc watch` still learns which files a build reads. A hit skips the
emitter. Some compiles bypass the cache:

- A mutated compile neither reads nor writes it. A mutant stored under the real sources' key would be served as the
  Program, and reading would hand the mutant run the unmutated bundle.
- A compile that enumerates mutation sites writes the cache but never reads it, because the sites are collected while
  simplifying.
- An emit that reported Diagnostics is not stored, since a hit would skip the stages that report them.

The JavaScript client keeps a cache of its own in another area. `ESSENCE_CLI_CACHE=off` turns this one off, which is
how two runs are compared, while the client has no off switch. A run that may not keep an entry spawns a scratch
bundle, written under a name no entry has.

A watch session writes an entry per save, so `prune` keeps the newest `KEPT_BUNDLES` by modification time. A
content-addressed file is never rewritten, so its time is when it was emitted. Pruning runs only after a write, and a
wrongly evicted entry costs one rebuild.

## Mutation runs

`essence test --mutate` asks whether the tests would catch a bug, where coverage only says a line ran. `runMutation`
works in three steps:

1. A baseline compile with the coverage counters in, which also asks every Module for its mutation sites. It runs
   once, and each test records which points it reached.
2. An attribution join turns "this line ran" into "these tests reach this site", by position.
3. For each site, one mutant is compiled through the same warm Session and run against only the tests that reach it.

The baseline must compile and pass, since every verdict rests on it. A focused baseline is refused under any filter:
the silenced tests would leave their sites looking unreached.

The run makes one seed and hands it to the baseline and every mutant. A property test that reaches a site draws the
same values from a mutant that it drew from the code, so a kill is reproducible. The corpus is read once and replayed
first, so a mutant that brings back a remembered bug meets the case that caught it.

A mutant ends in one of five verdicts. It is `invalid` when it does not compile, since the tests never saw it. It is
`hung` when it runs out of time, which counts as caught: a run that never ends is noticed. It is `killed` when a
covering test fails, or when its bundle will not load, its runner throws or its Worker dies. It is `survived` when every
covering test passes, and `uncovered` when no test reaches its site.

`--mutation-limit` caps how many mutants are compiled. Uncovered sites cost nothing, so they are all recorded whatever
the limit. Sites past the limit are neither judged nor dropped. `mutation-end` counts every site, so the unjudged ones
are the remainder, which the human report states. The run exits 0 unless `--strict` is given and a mutant survived.

Under `--json`, each verdict is streamed as it is reached. The baseline's events are written only on an early exit,
before a `mutation-end` of zeros. They are not streamed live, because a passing test's event carries its duration, so
two runs at one seed would write different streams.

### The mutant Worker

`import()` never unloads a bundle, so mutants are loaded into a Worker, `src/mutantWorker.ts`, rather than into the
command line's own process. The Worker reports itself exhausted after `BUNDLE_LIMIT` bundles, and the driver replaces
it. The Language Server recycles its test Worker the same way. The Worker never compiles: the compile pool does,
through the Session that already holds the graph. Only paths cross in and only events cross out, because a value's
hidden Type key is a Symbol of the runtime instance that built it.

Each mutant is emitted into a fresh directory, for the reason test bundles are staged. The snapshot and corpus stores
belong to the run, so they cross once per Worker in an `init` message.

The driver waits on each mutant for `mutantTimeout`. It listens for `exit` as well as `error`, since a Worker can
vanish without an error. Only terminating stops a hung mutant, so a timeout, a dead Worker or an answer
that could not cross the port all replace the Worker.

## When compiles go to workers

Booting a worker and importing the Compiler into it takes a fixed time, so `src/pool.ts` only uses workers when a batch
holds enough divisible work. `shouldUseWorkers` decides:

- An explicit `--jobs` decides alone, so either choice can be measured against the other.
- A single entry stays in process. One entry is one graph, which one worker would compile anyway.
- Emitting costs a fixed amount per entry: one esbuild run, and the shared standard library prelude rewritten into
  each bundle. So the entry count predicts the gain, and `PARALLEL_ENTRIES` is the threshold.
- Checking costs in proportion to the source to enrich. The standard library comes from a snapshot rather than being
  enriched in each process, so little is left to divide, and `PARALLEL_BYTES` is high.

A build whose bundles are all cached costs what a check costs and would be faster in process. That is only known after
linking, which is the work itself. The pool assumes the build is cold, because a cold build loses more in process than
a cached build loses in workers. A watch rebuild needs no rule of its own: it nearly always wakes a single entry.

`MAX_WORKERS` is small and does not follow the core count, because esbuild runs threads of its own in every worker.
Workers share nothing, so `groupEntries` groups the entries whose graphs overlap, judged one import deep, and each
group goes to one worker.

## Watching files

`src/watcher.ts` is the file watching that `esc watch` and `essence test --watch` share. They differ in what they do
with a change, not in how they notice one. The rules match `watchModule` in the client package:

- One watcher per directory rather than per file. Many editors write a temporary file and rename it over the original,
  which ends a watch on the file itself. A directory watch survives that, and also sees a file deleted and recreated.
- A directory event only says that something happened there. On macOS a rename is reported under the temporary file's
  name, so the event's file name is never trusted. The event is a prompt to reread the signatures.
- A signature is `mtimeMs:size`, captured only for a file not seen before. A save can land while a rebuild runs, and
  adopting it as the baseline would wait for a change that already happened.
- A directory watcher is not armed when `fs.watch` returns, and a busy machine can lose an event outright. So the
  signatures are also read on a timer, every `DEFAULT_POLL` milliseconds, and the events stay because they are faster.
