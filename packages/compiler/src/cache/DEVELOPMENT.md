# Developing the caches

`cache/index.ts` holds what every on-disk cache of the toolchain shares: where a cache lives, how a file is
written into one, and the compiler's fingerprint. The compiler's snapshots, the CLI's bundle and result caches
and the client's bundles all ask it, so a user's `ESSENCE_*_CACHE` variable has one meaning everywhere. It lives
in the compiler, which every package with a cache already depends on.

## Where caches live

A cache belongs to an area, such as `compiler` or `client`. The area is both the leaf directory and the name
of the variable that moves it: `cacheVariable("compiler")` is `ESSENCE_COMPILER_CACHE`. Deriving one from the
other keeps the name a user types tied to the directory it moves.

`cacheDirectory` takes the first of these that is set:

1. The area's variable, unless it holds a disabling word.
2. `XDG_CACHE_HOME`, under `essence/<area>`.
3. On macOS, `~/Library/Caches/essence/<area>`.
4. On Windows, `LOCALAPPDATA`, under `essence/<area>/Cache`.
5. `~/.cache/essence/<area>`.

The platform's own location is used because its backups and cleaners already treat it as regenerable.

The disabling words are `0`, `off`, `false` and `no`, written into the same variable. They are one escape hatch
per area, so that comparing a run with and without a cache needs no flag. `isCacheDisabled` reads them, and
`cacheDirectory` never reads one as a path. The client's cache can not be turned off: a compiled bundle has to
be a file before `import()` can reach it.

## Atomic writes

Several processes may fill the same entry at once. Both writers write to a temporary name and rename it into
place, so a reader sees either no file or the whole of one. `temporaryPath` puts the process ID and a random
suffix beside the target, so two racing processes write two temporary files. It stands beside the target
because `rename` is atomic only within one file system.

`writeAtomicSync` swallows every failure. What it writes can be rebuilt from source, so a read-only directory
or a full disk means no cache rather than no compile.

`writeAtomic` is for callers that need to know. Its files are usually named by a hash of everything that
decides their contents. A file already there holds the same bytes, so it is left alone. `replace: true` is for
a scratch file that has to hold this run's bytes, such as the bundle `esc run` writes when it caches none.
The result says whether this call wrote the file, which a caller that prunes after a write needs.

Windows refuses to rename onto an existing file. Without `replace`, a failed rename onto a file that now exists
is no error, since the writer that won the race wrote the same bytes.

## The compiler fingerprint

`toolchainKey` in `embed/hash.ts` names the compiler's version, the standard library's sources and the
runtime's sources. It leaves out the compiler's own code, which is right for a host's cache: only someone
editing the compiler would see a stale entry. The snapshots and the CLI's bundles add `compilerFingerprint`,
because the compiler's code shapes them. An edit to the enricher changes the enriched standard library with no
version bump and no `.es` file touched. A stale snapshot would make such an edit seem to do nothing, so there is
no switch to leave the fingerprint out.

`digestCompiler` hashes every `.ts` and `.js` file of the compiler's tree, which is `src/` in a checkout and
`dist/` in an installed package. It hashes contents rather than sizes and modification times, so the key is
exact, and a reverted edit finds its old entry again. Each file is named relative to the tree, so one compiler
installed under two prefixes fingerprints the same. The files are sorted, so the digest does not depend on
the order a directory lists in. A `tests` directory is left out, since a spec can not change what the
compiler produces.

The sources of `@essence-lang/interfaces` join the digest under an `interfaces/` prefix. They define the shape
of every value a cache stores, so an edit confined to them has to change the key as well.

A compiler bundled into one file, as the language server in the VS Code extension is, has no tree. The
module's directory is then wherever the bundle was written, so `compilerSources` walks the tree only when the
`STAGE_DIRECTORIES`, `enricher` and `rewriter`, stand in it. Without them, the bundle's size and modification time
name it, since a bundle is replaced rather than edited. A compiler that can neither walk a tree nor stat its
own file returns an empty fingerprint. The snapshots then turn off, since that key can not tell two compilers
apart.

The fingerprint is computed once per process.

## Snapshots

A snapshot is a whole value written to disk with `v8.serialize`, so that a process reads it instead of building
it. `throughSnapshot` in `cache/snapshot.ts` serves two: the enriched standard library from
`enricher/stdlib.ts`, and the prelude that `rewriter/stdlibPrelude.ts` simplifies and optimises from it.
Neither depends on the user's Program, and building them is most of what a small compile costs.
`v8.serialize` keeps the Sets, Maps and shared objects these values hold, which JSON would not.

The key mixes `FORMAT`, the kind, `toolchainKey`, `compilerFingerprint` and a variant, which is the optimiser
options for the prelude. `FORMAT` keeps a changed file format from being read as the old one, even where the
fingerprint is coarse, as it is for a bundle. A file is named `<kind>-<key>.v8` in the `compiler`
area.

A snapshot can neither make an answer wrong nor stop a compile:

- Any failure to read, or a value that fails the kind's `isValid`, means the value is built from source.
  `isValid` is required because `v8.deserialize` can answer a truncated file with an object of the wrong
  shape rather than throwing.
- A built value is offered back to disk. A value `v8.serialize` refuses, such as one holding a Function, is
  simply not stored.

`prune` runs only after a write, so a process that finds its snapshot touches nothing else. It keeps the newest
`KEPT_PER_KIND` files of a kind, since the key changes on every edit to the compiler. More than one is kept
because a test suite that toggles optimiser passes uses several prelude variants at once. Every pruning failure is ignored, since Windows
refuses to delete a file another process has open.
