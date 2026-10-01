# Developing the client

What the package does for a host is the [README](./README.md), and what the boundary costs is
[BENCH.md](./BENCH.md). This page is the map for changing the package itself. Paths are relative to
`packages/client/src` unless they name another package.

## Input types

`Input<T>` in `input.ts` is what a caller may pass where a Module declared `T`. What comes back is `T` itself.
The two differ only at an Integer. It always comes out as a `bigint`, so a call's Type does not depend on the size of
its answer. Going in, the interpreter takes a safe `number` as readily as a `bigint`. A declaration that said `bigint`
for a Parameter would make every caller write `BigInt(i)` for nothing.

`Input<T>` is a mapped Type rather than a second declaration of every alias, so a Parameter reads `Input<Rectangle>`
and hovers to the shape. It walks down a List, through both slots of a Dictionary and into a Record's members. A
naked `T` distributes over the arms of a Union. It stops where marshalling stops:

- A Rational is a class and crosses as itself.
- A Function is not widened. Its declaration already prints each Parameter and its answer in the direction that
  value crosses.
- A `Map` is matched before the object case. The mapped Type would otherwise walk its Methods and widen no key.
- A `Promise` is matched for the same reason, since the mapped Type would walk `then`, `catch` and `finally`. The
  declaration that printed it already spells what it holds.
