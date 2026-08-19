# Protocols

A Protocol says what a Type can do. A Namespace declares that its target Type
does it, and the Compiler holds the Namespace to it:

```essence
protocol Printable {
	§§ Answers the value as a String.
	§§
	§§ @returns — the String representation of the value.
	toString() -> String
}

type Weight = { grams: Integer }

namespace Weights for Weight is Printable {
	toString() -> String {
		<- "{@.grams} g"
	}
}
```

`Self` inside a Protocol stands for the conforming Type. A Protocol is not a
Type: it is nameable in a conformance clause (`is Printable`) and as a Type
Parameter's bound (`<infer Item is Printable>`), and nowhere else.

## Requirements and provided Methods

A Method written as a signature alone is a **requirement** — every conforming
Namespace owes it a body. A Method written with a **block** is **provided**: the
Protocol writes the body once, and every conformer answers it without writing
anything.

```essence
protocol Equatable {
	§§ Answers whether both values are equal.
	§§
	§§ @param _ — the value to compare with
	§§ @returns — `true` when the values are equal.
	is(_ other: Self) -> Boolean

	§§ Answers whether the values differ.
	§§
	§§ @param _ — the value to compare with
	§§ @returns — `true` when the values differ.
	isNot(_ other: Self) -> Boolean {
		if @::is(other) {
			<- false
		} else {
			<- true
		}
	}
}
```

That is the standard library's own `Equatable`, body included. The `if` reads
long where `<- @::is(other)::negate()` would say the same thing — reaching
`Boolean::negate` would need `Boolean` imported into the file the Protocols are
declared in, and `Boolean.es` imports that file back. Your own Protocols are
under no such constraint.

A conformer owes `is` and nothing else. `isNot` is a real Method of every
conforming Type all the same: it resolves at a call, Hover shows the Protocol's
`§§` above it, Completion lists it beside the written members, and Signature Help
answers for it.

### What a provided body may say

A provided Method's body is written on `@`, the conforming value. `@` is known
by the Protocol and by nothing else, so the body may call:

- the Protocol's own Methods, required or provided;
- the Methods of every Protocol this one extends;
- the Methods of whatever those calls answer with — `@::compare(to other)`
  answers an `Ordering`, and `Ordering`'s own Methods are reachable on it.

Anything else is a `method-not-on-protocol` error at the Protocol itself, rather
than at whichever conformer happened to be missing it. That is the point of the
restriction: a provided body is checked ONCE, and it is right for every Type that
will ever conform.

The body may also name the standard library — `Integer.parse(…)`, `Terminal` —
and nothing the Program declares: not a Constant, not a Variable, not a Function,
not a Namespace (`provided-method-out-of-reach`). A provided Method is emitted
once, in the band ABOVE every Program that reaches it, and everything the Program
declares is emitted below that. Give the Protocol a requirement the body calls on
`@`, and let each conforming Namespace reach the name.

`static` and `overload` Methods can not carry a body
(`unwritable-provided-method`). A static Method has no receiver for `@` to stand
for, and an `overload` entry's identity is a slot in a Method Type the Protocol
has no conformer to resolve against.

### The override rule: replace, whole name

A Namespace that WRITES a Method of a provided Method's name replaces it
entirely. There is no merging of entries and no way to call the provided body
from the replacement:

```essence
namespace Weights for Weight is Printable, is Equatable {
	is(_ other: Weight) -> Boolean {
		<- @.grams::is(other.grams)
	}

	§ Replaces the provided `isNot` outright.
	isNot(_ other: Weight) -> Boolean {
		<- @.grams::isNot(other.grams)
	}
}
```

The replacement is held to the provided signature by exactly the check a
requirement gets: it must contain an entry assignable to it, or the conformance
is refused with `nonconforming-namespace`. An `overload` block satisfies that as
long as one of its entries matches — the other entries are extra Methods of the
Namespace, not extra ways of answering the Protocol.

A Namespace that writes nothing of the name is never told it is missing
something: `nonconforming-namespace` lists requirements only.

A DERIVED Method replaces a provided one on the same terms, without anybody
writing it. Every `choice` derives its equality, so `Ordering#Less::isNot(#Equal)`
runs the derive rather than `Equatable`'s provided body — the derive is
fabricated for that receiver and takes the whole Choice, where a provided Method
takes `Self`, which a receiver narrowed to one Case binds to that Case alone.

### Naming the Protocol at the call

Two Protocols may provide a Method of the same name, and a Namespace may conform
to both. The call is then a tie — `ambiguous-namespace` — and the way out is the
Namespace specifier, with the Protocol's name in it:

```essence
Terminal.print(box::<Left>label())  § Left's provided body
Terminal.print(box::<Right>label()) § Right's
```

The same spelling reaches the standard library's:
`5::<Equatable>isNot(3)`. A REQUIREMENT is not reachable that way — it is written
by a Namespace, and that Namespace is what a specifier names.

### Where the override is honoured

An override answers every call written on a value of the Namespace's own target
Type. A call written on a Protocol-bounded Type Parameter dispatches through the
Protocol instead — the bound is all that is known there, so the provided body is
what runs:

```essence
function differ<infer Item is Equatable>(_ a: Item, _ b: Item) -> Boolean {
	§ Equatable's own `isNot`, whatever `Item` turns out to be.
	<- a::isNot(b)
}
```

**Write an override to say the same thing faster, never to say something
different.** Nothing checks that it does. `differ(weight, other)` and
`weight::isNot(other)` are the same question written twice, and an override that
disagrees answers them differently — with no Diagnostic, because the two calls
resolve in two places and each is right about its own.

It falls out of how a conformance is compiled: a witness names one Method per
requirement, and a provided Method's body is one const every conformer shares,
so there is nothing per-conformer for a witness to name. The standard library
writes overrides on exactly those terms — `Integer`'s four inequalities read its
own `compare` rather than the cross-kind table, and answer what `Orderable`'s
provided bodies answer.

This is NOT the rule Rust and Swift follow for a defaulted requirement. In both,
an override enters the witness and is what generic code calls; the default body
runs only where the conformer wrote none. Swift's statically dispatched member —
one declared in a protocol EXTENSION and not in the protocol — is the closer
cousin, and a provided Method is neither, since it is declared in the Protocol
and inherited by every conformer.

## Extension

A Protocol may extend one or more others, in the `is A, is B` list a Namespace
conformance uses:

```essence
protocol Orderable is Comparable {
	§§ Answers whether this value sorts before another.
	§§
	§§ @param _ — the value to compare with
	§§ @returns — `true` when this value sorts first.
	isLessThan(_ other: Self) -> Boolean {
		<- @::compare(to other)::is(Ordering#Less)
	}
}
```

Extension says two things at once:

- **Requirements are inherited.** Conforming to `Orderable` owes every
  requirement of `Comparable` too — `compare(to:)`, here — and a Namespace that
  leaves one out is refused naming that Method.
- **Conformance is granted.** A Namespace declaring only `is Orderable` satisfies
  an `is Comparable` bound and reaches Comparable's provided Methods. One
  conformance answers the whole chain; there is no second clause to write.

```essence
§ `sort` asks for `Comparable`; the bound below names only `Orderable`.
function lowestOf<infer Item is Orderable>(_ items: List<Item>) -> Optional<Item> {
	<- items::sort()::firstItem()
}
```

A descendant may re-provide a Method its ancestor provides. The descendant's
body is the one that answers, at a call and through a bound alike — the same
"replace, whole name" rule a Namespace's own Method follows.

Two clauses may reach one ancestor, and the WEAKEST grant wins: a Protocol some
clause grants outright does not carry another clause's `where`. Note that a
Method fulfilling a conditional clause carries that clause's bound, so it can
not also fulfil an unconditional one — writing the same condition on both
clauses is what a Namespace in that shape wants.

A `where` clause can not stand on an extension
(`where-on-protocol-extension`): a condition bounds one of the declaring
Namespace's Type Parameters, and a Protocol declares none.

A Protocol that extends itself, directly or through a chain, is a
`recursive-protocol` error. The Protocols in the cycle keep their own Methods, so
everything conforming to them still reports about itself.

## The three layers

The standard library's ordering Protocols are one chain, each layer adding what
the layer below can not decide for itself:

| Protocol | Requires | Provides |
|---|---|---|
| `Equatable` | `is(_:)` | `isNot(_:)` |
| `Comparable` | `compare(to:)` | — |
| `Orderable is Comparable` | — | `isLessThan(_:)`, `isLessThanOrEqualTo(_:)`, `isGreaterThan(_:)`, `isGreaterThanOrEqualTo(_:)`, `isBetween(_:and:)`, `clamp(between:and:)` |

`Comparable` asks for one Method and stays there, because one total order is all
`sort`, `lowest` and `greatest` need. `Orderable` is the layer that turns that
order into the questions a reader actually writes, and it asks for nothing of its
own: a Type that can `compare` can answer all six.

Which Types take which layer is a judgement about the Type, not about what is
convenient. `Integer`, `Rational`, `Algebraic` and `Number` are `Orderable` —
they sit on a number line, and `isBetween` and `clamp` mean what they say there.
`String` and `List` stay `Comparable`: they are sortable, and that is a different
claim.

Every one of the six takes `Self`, which is the RECEIVER's own Type — so they
answer within one kind, and a question across two names the covering `Number`
Type on the receiver:

```essence
constant pi: Number = Number.Pi

§ Now the bounds may be an Integer and a Rational.
Terminal.print(pi::isBetween(3, and 22/7))
```

`Integer` and `Rational` write four of the six themselves, and each says at its
own declaration why: the written Overload holds an entry for the other numeric
kind, and it reads its own `compare` rather than the cross-kind table, so a
Program that compares two Integers reaches nothing else.

## How it is compiled

A conformance is a **witness** — a record mapping each requirement to the Method
that answers it — passed as a hidden Argument wherever a bound has to be proven.
Nothing about a Protocol survives into the emitted JavaScript except its
witnesses.

A provided Method is emitted **once**, as a top-level const of its own, taking
the witness as its trailing Argument:

```js
const $es_Shape__describe = function (_self, Self__conformance) {
	return /* … */ Self__conformance.area(_self) /* … */;
};
```

Every conformer's call sites name that one const, and the calls inside its body
dispatch through the witness. A bundle spanning many Modules declares it in the
shared prelude Module, so it is one const for the whole graph. A provided Method
nothing reaches is not emitted at all, exactly as an unreferenced standard
library Method is not.

A provided Method is never part of the witness itself. One body answers for every
conformer, so there is nothing per-conformer for a witness to name — which is
also why an override is not visible through a bound.

The const is named `$es_<Protocol>__<member>`, with a DOUBLE separator. A
Namespace member's const joins with one, and no member name can begin with `_`,
so a Protocol named after a Namespace can never reach the Namespace's const.

One Protocol name and one Method name mean one const, so two Protocols of the
same name may not both provide a Method of the same name in one compilation
(`clashing-provided-method`) — declare the Protocol once and import it where it
is needed, or rename one of the two. Two same-named Protocols providing
DIFFERENT Methods name different consts and compile fine.
