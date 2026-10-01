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

### Namespaces named after builtins

A Program can not declare a top-level Namespace named after a builtin, such as `Integer`: the enricher reports
`duplicate-variable`. A nested one is accepted, and it replaces the builtin for the rest of its block, in Method
resolution and in conformance solving. So a Namespace named after a builtin is always nested. The standard
library's own Namespaces reach the optimiser in the prelude's Programs, and they are always top-level. A tests
section is a Scope inside the Program, so whatever it declares is nested too.

`declaredNamespaces` answers both sets. A pass that reads a Namespace name as the standard library's checks
`nested` first. Lowering a Program's own `Integer` Method to a bigint operation would answer for code nobody
wrote. `pool-constants` reads `all`, since a declared Namespace is emitted as a class, and a class is not hoisted.

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

## The shared walk

`rewriteNodes` in `walk.ts` is the one walk every pass uses. A pass is written as the question it asks of one Node,
not as another copy of the tree's shape. A position the walk missed would be an optimisation that silently does not
happen, so every kind is handled by name. The Expression and intrinsic switches are exhaustive. The Statement switch
names each Statement kind before it falls through to the Expressions, so a new Statement kind in `typedSimple` fails
to compile there.

The walk is bottom-up. A Node's children, the Statements of its bodies included, are rewritten before the Node is
offered. A pass therefore reads the finished form of everything under a Node. A Match nested in a Handler is lowered
before the Match that holds it.

Nothing is mutated. A Node whose children changed is rebuilt, and a Node whose children did not is handed back as
itself. So a pass that rewrites one Node does not copy the Program around it. A hook that changes nothing answers with
what it was given. `mapArray` and `mapRecord` copy only once something has changed. `mapRecord` keeps the members in
their written order, which the runtime's Record equality and printer read off the emitted literal.

### Hooks

A pass may ask for any of the `expression`, `statement` and `body` hooks, and one walk offers them all.
`elide-final-match-test` reads a Match both as an Expression and as a lowered Statement, and two walks could
disagree about what they reached.

- A Statement position is wider than `StatementNode`. An Expression written for its effects stands in one, and
  it is offered to both hooks, the Expression hook first.
- `body` receives a whole run of Statements after each was walked. It is the only hook that can change how many
  there are, which `eliminate-dead-code` needs. Every body goes through `walkBody`.
- `parameterDefaults` makes the walk descend into a Parameter's `= expression` default. It is off unless asked for.
  Several passes answer an Expression by lifting work into Statements ahead of it, and a Parameter list has nowhere to
  put them. `fold-constants`, `pool-constants` and `eliminate-dead-code` ask for it.

### Positions

A lowered form is walked like what it came from. A lowered Match holds the same positions in the same order as the
Match Expression. An inlined loop is walked like the call it replaced, its callback bodies offered to both hooks. An
assertion is walked as the Handler it is. A conformance witness a Node carries is walked like the trailing Arguments
of a bounded call. Intrinsics are walked like any other Node, so a pass reads what an earlier pass produced.

Some positions are not values and are never offered. They are a `type`, a Match's `matcher`, a `MethodInvocation`'s
`base` and a `Lookup`'s `member`. A Parameter is a binding, not a value. `rewriteExpressionsIn` walks a single
Expression with the same switch. A pass asks there whether an Identifier refers to a binding. A sweep over
`Object.values` can not tell a member name from a binding.

A residual Type test is walked like any Expression, but no pass may answer it with a Node of another kind. It
stands in a JavaScript `if`, where an Essence Boolean object would always be true.

### The tests section

In a test compile, the tests section is walked by the same passes as the implementation, since
`eliminate-dead-code` has to see what a test reads. Its entries are not walked through `walkBody`, so no hook can
drop a test, or part a row's bindings from the row. Each test's own body is.
