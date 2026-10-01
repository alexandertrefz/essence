# Developing mutation testing

Coverage says a line ran; mutation says whether a bug there would be caught. `mutation/index.ts` lists the sites
where a simplified Program can be changed by one small lie, and builds the Program with one of them applied. The
CLI compiles each mutant and asks whether any test fails.

## Sites

`enumerateMutations` and `applyMutation` share one walk, `walkMutations`, so they can not disagree about which site an
id names. The walk runs over a simplified Program before the optimiser. So a site stands where the author wrote it,
and nothing the optimiser adds is mistaken for one. It walks the implementation alone, Parameter defaults included.
The tests section is skipped, so no id is spent inside it.

A site's id is its place in the walk, a running count fixed by the shape of the Program. `offer` gives every candidate
of a Node its own id, so three nudges of one literal are three sites. Enumeration records every candidate and takes
none. Application takes the one whose id matches, and throws when none does. A stale id is a bug, and compiling the
unmutated Program would report a mutant that was never there.

Only Nodes the source wrote are sites. The simplifier builds Nodes without a Position, and a report could not
point at one. `SITES_PER_LINE` caps the sites kept on one line, dropping the last in walk order. The cap is
applied after the ids are assigned, so it never renumbers a site.

The walk rebuilds only the spine above the Node it replaced, as an optimiser pass does. The Program handed in is
never changed, and `CONTEXTS` keeps one context per Program for the many walks a run makes.

## Operators

- `comparison` moves a bound or reverses an order, one step each way: `isLessThan` becomes `isLessThanOrEqualTo`
  or `isGreaterThan`. The negation is two steps and left out, since every test that checks anything kills it.
- `equality` swaps `is` and `isNot`.
- `arithmetic` swaps `add` and `subtract`, and turns `multiply` into `add`. `add` never becomes `multiply`,
  which agrees with the original wherever both operands are 2.
- `boolean` flips a Boolean literal.
- `integer` moves an Integer literal up by one, down by one, and to zero, dropping repeats and the literal itself.
- `case` swaps a constructed Case for the next Case of its Choice, wrapping around, that has the same member
  names. The payload is kept as written, so it has to fit. Only one sibling is offered. `readContext` orders a
  Choice the Module declares as its declaration does, wherever a construction stands. A Choice from elsewhere
  has only the Cases the Module constructs, in the order its walk first meets them.
- `branch` swaps the bodies of an `if`, which inverts the condition without inventing a Node. In a `define`, it
  swaps one arm's answer with the `otherwise` answer, one candidate per arm. Those candidates stand at the
  `define`'s own Position, since the cap would drop them on an arm's line, which its Condition already fills.

The swap tables are Maps, and `ownMethod` reads with `Object.hasOwn`, because a Method's name is user text. An
object would answer `toString` out of `Object.prototype`.

## Type-shaped mutants

A mutated Program is never enriched again, so nothing would catch a mutant that does not type-check. It would
crash wherever it ran and count as a kill no test earned. Every mutant is therefore type-shaped by construction,
and a site that can not be shown sound is not a site.

Narrowing is the first hazard. A condition can prove a refinement for the branch it opens, for the branch it declines,
or both: `separator::isEmpty()` proves `NonEmptyString` where it fails. Swapping the bodies, or asking a different
question in the condition, would run a body against a refinement nobody proved. `readContext` gathers into
`narrowed` every Node of a condition that narrows in either direction. It adds the Nodes of each `define` arm's
Condition that narrows its answer or the arms after it. Nothing in that set is mutated, an `if` with such a
condition keeps its bodies, and a `define` with such an arm keeps its answers.

Moving a `define` answer is otherwise sound. Where the context fixed the answer Type, every arm was read against
it. Where the arms decided it, the Type is the Union of exactly these values, and a swap only permutes them.

`swappableMember` checks a member swap. The emitted call must name a Function that exists and takes the Arguments the
call site already wrote:

- A Method a Protocol provided is reached through the Protocol's body. The swap needs the same standard library
  Protocol to provide the target, and an unmangled call. `Equatable` requires `is` and provides `isNot`, so a
  provided `isNot` has nowhere to go. `Comparable` provides all four comparisons.
- A Namespace the Module declares needs both names declared, both static or both not, with the same number of
  Parameters.
- A builtin Namespace needs the target to have the call's Overload slot, of the same Method kind, with the same
  number of Parameters. Labels need not agree, since the emitted call is positional.

A simplified Program can not see a Namespace imported from another Module, or a Protocol a Module declares. So swaps
onto them are refused.
