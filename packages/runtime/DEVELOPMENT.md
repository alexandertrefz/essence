# Developing the runtime

The runtime holds the native halves of the standard library. [README.md](README.md) covers what the package is and
how a Program reaches it. This file explains how its parts fit together.

## Namespace modules

The Rewriter imports one runtime module for each builtin Namespace in `runtimeNamespaceNames`, under the Namespace's
own name. A native call then reads `<Namespace>.<method>`. So every such Namespace has a module of that name here,
even when the module holds nothing.

A module is empty when every Method of its Namespace is written in Essence. Those Methods are emitted beside the
Program as `$es_<Namespace>_<member>` consts. The empty module stays so that the import resolves.

### Refined Namespaces

A refinement erases before anything runs, and its proof is spent while compiling. So a Namespace over a refined
Type, such as `NonEmptyDictionary` or `NonNegativeInteger`, receives the same value its base Namespace does. Most of
its entries are the base Namespace's own Functions, re-exported under this Namespace's names. One Function under two
names can not drift apart, and what the proof buys is said in the Types alone.

An entry is written out only where the proof changes the operation. Where the base entry answers an Optional, the
refined entry answers the value itself: `NonEmptyDictionary.firstEntry` and `NonNegativeInteger.squareRoot` are two.
Such an entry reads its answer off the base entry where it can, so the two compute the same thing. It casts the
Optional to its `#Value` Case, which states a proof TypeScript can not see.

No entry here can be an Essence body that hands on to the base Method. On a proven receiver `@::length()` names this
Namespace's own `length`, so such a body calls itself and the Validator refuses it as `infinite-recursion`.

## Builtin Choices

A builtin Choice's values carry Case tags such as `"Side#Start"`, exactly as a user-declared Choice's do, and a
native reads the tag. `is`, `isNot` and `toString` are derived from the Choice, and the standard library declares the
conformances beside the Methods that take one. A native that reads a Choice lives in the module of the Namespace
that declares the Method: `trim` reads a `Side` and lives in `String.ts`.

A payload-free Case has one shared instance, as `Ordering`'s Cases do. Case equality goes by tag, so sharing only
saves an allocation. An Essence body builds its Cases through `createCase` in `type.ts`, so some shared instances are
never read and exist for symmetry. A Case with a payload, such as `Result#Failure`, is built per value.

A native `toString` renders a Case with a payload as its name without the `#` sigil, then the payload in
parentheses. A String payload is quoted: `Failure("gone")`. An Essence body renders a payload through a String
hole, and a hole renders a String bare, so `Result` and `HttpFailure` render natively.
