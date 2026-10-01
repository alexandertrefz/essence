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

## Bare Cases

A unit Choice is one whose Cases have no payload, and its Cases cross as their bare names: a `Direction#Up` is the
string `"Up"`. This package calls such a Case a bare Case. It avoids "unit Case", which the compiler uses for any Case
without a payload. `Shape#Blank` is a unit Case without being bare, because `Shape` has Cases with payloads and
crosses as an object.

A String crosses as a string too, and one Choice's `#Up` is spelled like another's. Where a Union puts two such arms in
one position, the position has no unambiguous JavaScript spelling, and the boundary refuses it. Deciding would turn a
String `"Up"` handed in into a `Direction#Up` coming out, and the boundary must not lose data. Other Union arms are
tried in declaration order, and the first that admits a value takes it. That rule does not reach bare Cases.

The rule is per Case name, not per pair of Choices. `Direction | Vertical` is spellable while the two share no Case
name. A Choice with payloads crosses as a `$case` object, which no string is, so `Direction | Shape` is spellable too.
Two bare Cases of one name collide only when their tags differ. Two Modules may each declare a `choice Direction`, so
the display name is no identity, while one Case reached twice through a Union is no collision.

`bareCaseCollision` in `bare-cases.ts` is the one statement of the rule. The marshaller asks it whether a position can
cross at all, and `dts.ts` asks it whether a position can be printed. A second copy could start refusing what the
other still declares.

Only a Union is asked. A lone bare Case, or one inside an `Optional`, has its position to itself. A Record member or a
List item that holds two shapes is a Union of its own, asked where it is reached.

The arms compared are the ones a JavaScript value is decided between. A nested Union is flattened, since its arms stand
in the outer position unchanged. An `Optional` is flattened too, because it is spelled by absence and `undefined`
collides with nothing. It reaches a Descriptor in two shapes. `describeUnion` collapses a Union of exactly its two
Cases into an `optional` node. In a larger Union the two Cases stay apart, the `#Value` carrying a String collides with
`#Up`, and `#Empty` adds nothing.

## Rounding a Rational to a double

`toNumber` in `rational.ts` answers the nearest double, rounded once. When both parts are at most `2 ** 53`, a double
holds each exactly, and one hardware division rounds correctly, as IEEE 754 requires. Larger parts would each be
rounded on conversion, and dividing two roundings can misround the quotient by an ulp.

Past that fast path, `dividedMagnitude` still rounds exactly once:

- The quotient is taken to 64 bits, and a nonzero remainder sets its low bit. Any later rounding to 53 bits or fewer
  then reads this quotient as halfway exactly when the true quotient is halfway.
- Converting that quotient to a double is the one rounding. Scaling it back by a power of two is exact.
- A subnormal answer has fewer significant bits than the conversion keeps, so converting would round twice. When the
  exponent is under -1022, `roundedShift` rounds the quotient to a multiple of `2 ** -1074` in bigint arithmetic, half to
  even. The result converts exactly. A tie it sees is a true tie, since an inexact quotient has its low bit set.

`scaledByPowerOfTwo` multiplies in steps of at most `2 ** 1023`, the largest power of two a double holds. One
multiplication can underflow. For `1/2 ** 1020` the quotient `2 ** 64` scales back by `2 ** -1084`, which is `0` as a
double, while the answer is the normal `8.9e-308`. Stepping keeps every intermediate in range. The loop stops early at
`0` and at `Infinity`, which no further step changes.
