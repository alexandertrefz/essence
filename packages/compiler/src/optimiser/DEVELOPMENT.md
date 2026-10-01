# Developing the optimiser

The optimiser rewrites a simplified Program into a faster one with the same behaviour. `optimise` in `index.ts`
is the entry point, the passes live in `passes/`, and `walk.ts`, `purity.ts`, `reads.ts`, `residual.ts` and
`namespaces.ts` hold what several passes share. The overview in `packages/compiler/DEVELOPMENT.md` shows where
the stage sits.

## The pass registry

Every transform the optimiser makes is a named pass in `optimiserPasses`, and they run in that fixed order. Each
name is kebab-case and is spelled the same in the registry, in the `--without-optimisation` flag and as a heading
on the website's optimisations reference. `packages/website/tests/optimisationPasses.spec.ts` keeps the reference
in step. A Program that behaves differently with a pass turned off is a bug in that pass, and the name says
which.

A pass may not assume that another pass ran. Any subset of the registry has to produce a correct Program, so turning a
pass off is a diagnosis rather than a gamble. Passes cooperate, one leaving a shape the next can do more with, but
none depends on another. A new pass is inserted where it belongs rather than appended. What a pass finds in front of
it is part of what it was written against.

Every pass is a pure function of its input. The prelude cache shares the standard library's simplified Programs across
a process. A pass that wrote into one would change what a later compilation reads.

A few places in the order matter:

- `instrument-coverage` runs first, so that each counter stands where the author wrote the code it counts.
- `unbox-conditions` runs after every pass that builds an `essence-boolean`, so the passes after it read each
  condition as the test it was built from.
- `loop-self-tail-calls` runs after every pass that shapes a Match, since a Match holds a Return of the
  Function only once `lower-matches-to-statements` has written it out. It runs before the constant pool and the
  collapses, so a loop turn's Arguments are improved as a call's would be.

### What a pass is handed

`run` receives the Program, the `DeclaredNamespaces` and the options. The Namespaces are computed once per phase by
`declaredNamespaces`, because answering walks every object the Program holds, Types included. One answer serves every
pass, since no pass declares a Namespace the simplifier did not. A pass that drops code can drop only a nested
declaration, and a nested name left in the set only makes a pass hold back. A pass that declares a Namespace computes
its own answer. A memo keyed on the Program would miss after every pass that changed something, which is why the
answer is handed in.

Only `instrument-coverage` reads the options. Every other pass is right whenever it applies.

### Options

`OptimiserOptions.enabled` set to false is `--no-optimise`. `essence dap` compiles a debug session with
`unoptimisedOptions`, so that a debugger steps through the Program as written. `disabledPasses` names passes to skip.
The command line refuses an unknown name, since a misspelt pass that stayed on would look like a pass that does not
work.

`coverage` asks for instrumentation, and only `essence test --coverage` sets it. It is opt-in because it is the
one pass that makes a Program do more work. It still runs with the phase off, since turning optimisation off does
not ask to stop measuring, and `--without-optimisation instrument-coverage` still turns it off. `essence test
--mutate` refuses to have it turned off, because it reads the counters to learn which tests reach which site.
The prelude is built `withoutCoverage`, so the standard library is never instrumented into a bundle.

`optimiserOptionsKey` spells a set of options for the caches that must not answer for other options, such as the
prelude cache. It names the passes sorted, and it spells coverage as whether instrumentation will run. That
holds on both sides of `enabled`, since `--no-optimise --coverage` emits other bytes than `--no-optimise`.

### Erasing refinements

`optimise` first runs `eraseRefinements`, which is not a pass. A Program has no run-time notion of a checked
refinement, so erasing them is what makes it emittable at all. There is no name to turn it off under. The rewriter
refuses a refinement outright. Every pipeline that emits goes through `optimise`, which is why the erasure lives here.

With the phase off, `optimise` skips `declaredNamespaces` and hands `instrument-coverage` an empty answer, since
that pass does not read it.
