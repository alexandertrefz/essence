# Records

A Record is a value with named members and no identity of its own. Two Records
with the same members are the same Type, whatever they were declared as, and a
Record is never modified: every "change" is a new Record built from an old one.

This page is about how a Record is WRITTEN — the four spellings that keep the
writing short without making it guess — and about the one place a member is
read rather than written.

## Writing a Record

A Record Literal writes every member it has:

```essence
type Point = { x: Integer, y: Integer }

constant origin: Point = { x = 0, y = 0 }
```

### The shorthand

A member written as a bare NAME is that name's value under that name — `{ x }`
is `{ x = x }`:

```essence
constant x = 3
constant y = 4

constant point: Point = { x, y }
```

The two spellings may stand side by side (`{ x, y = 2 }`), and the Formatter
keeps whichever was written: it never collapses `a = a` into `a`, and never
expands `a` into `a = a`. The Language Server offers both rewrites as Quick
Fixes instead, so the choice stays the author's.

The shorthand is a feature of a Record LITERAL's member list, and it reaches
wherever a literal does: a plain literal, a typed one (`Point ~> { x, y }`), a
Case payload (`#Rectangle({ width, height })`), a literal standing as a member's
value, a literal standing as an update's whole right-hand side, and a braced
descend (below).

It does NOT reach an update's key list. `{ base with other }` merges the VALUE
`other`, and it has always meant that; admitting a bare name into the key list
would silently take it to "set the member `other`". So `{ base with port }` is
refused — with a message that names both legal spellings, `{ base with port =
port }` and `{ base with { port, host } }`. That last one is the shorthand
merge: an update takes either a key list or one Expression, and a literal is an
Expression.

## Updating a Record

`{ original with … }` answers a new Record with some members set:

```essence
constant moved = { origin with x = 3 }
```

The right-hand side is either a KEY LIST or one Expression. An Expression is
merged whole, projected to the members its Type names:

```essence
constant shifted = { origin with somePartial }
```

### Reaching into a member

A key may be a PATH:

```essence
type Tls = { enabled: Boolean, authority: String }
type Server = { host: String, port: Integer, tls: Tls }
type Config = { name: String, server: Server }

constant moved = { config with server.port = 8080 }
constant secured = { config with server.tls.enabled = true }
```

A path key IS a nested update, and the Compiler writes the nesting out:
`{ config with server.port = 8080 }` is
`{ config with server = { config.server with port = 8080 } }`. Keys that share a
first step build ONE level, so `server.port` and `server.tls.enabled` written
side by side both reach through a single `config.server`.

That is the whole rule, and it is what makes the two spellings safe to read
apart: **`server = { … }` always REPLACES, and `server.port = …` always
MERGES.** A nested literal is never quietly merged into the member beneath it —
under such a merge, adding a member to a Type would turn an old full replacement
into a merge that keeps the old value, with no Diagnostic anywhere, and a
Program would change meaning because a Type it does not name grew a member.

Each step but the last must name a Record, since it is the value the step after
it updates. A step that names something else is refused, and so is a path key in
a Record Literal standing on its own, which writes its members from nothing and
so has no value under the key to reach into. The other two Literals that DO have
a value under them are an Argument and a Case payload merged into a default —
see “Reaching into a default”.

The value being updated has to be one that can be NAMED — `@`, a name, or a
chain of member reads over one of those — because the compiled form reads it
once for every level the path reaches through. Bind a computed value to a
Constant first.

### The braced descend

A path that sets several members one level down may be written once:

```essence
constant listening = { config with server.{ port = 8443, host = "api" } }
```

A descend holds a full member list, so it takes paths, further descends, and the
Record shorthand:

```essence
constant port = 4433

constant borrowed = { config with server.{ tls.{ enabled = true }, port } }
```

The shorthand is allowed here and refused after a `with` for the same reason
both times: a bare name after `with` could be the whole value being merged, and
inside a descend there is no such reading to lose.

A key that sets a whole member and a path that reaches into it can not both
stand — `{ config with server = s, server.port = 1 }` writes `server` twice —
and a descend with nothing in it is refused, since it says to leave the member
exactly as it was.

## Defaults

### A Record Parameter's default

A Parameter's default may be a PARTIAL of its Type. The members the default
supplies are the members a caller may leave out:

```essence
type Options = { host: String, retries: Integer, timeout: Integer }

§§ Answers a description of the connection.
§§
§§ @param _ — the address to connect to.
§§ @param using — how to connect.
§§ @returns — the description.
function connect(
	_ url: String,
	using options: Options = { retries = 3, timeout = 30 },
) -> String {
	<- "{url} {options.host} {options.retries} {options.timeout}"
}

constant description = connect("example.com", using { host = "db" })
```

At entry the callee reads `{ default with argument }`, member by member. The
merge is shallow, like `with`.

A default that supplies EVERY member keeps today's meaning as well: the whole
Argument may be left out, and an Argument that IS written may still be partial.
A partial default leaves the Argument required — there are members only the
caller can supply — and an Argument that misses one of those is refused by name.

A default written as a literal is evaluated member by member, only for the
members the caller left out. Written as any other expression it is evaluated
once per call. A Function or Method taken as a VALUE drops its defaults, exactly
as it always has.

Optional members are not implicitly omittable: a default that means to fill one
in writes `timeout = #Empty`.

Hover, Signature Help and Completion all say which members a call may leave out,
and which of them a path key may reach into.

### A Case payload's default

A Case that carries a payload may default it, in the same slot:

```essence
choice Fetch {
	Get { url: String, headers: List<String> } = { headers = [] },
	Post { url: String, body: String, retries: Integer } = { retries = 0 },
}

constant request = #Get({ url = "/items" })
```

The default may be partial, and the members it fills in are the ones a
construction may leave out. A payload's INDIVIDUAL members take no defaults —
`Circle { radius: Integer = 1 }` does not parse; the default is one Record for
the payload as a whole, because Record construction is not a call.

Two restrictions. A payload default is turned into DATA at the declaration — a
Number, a String without holes, a Boolean, and the Lists, Records and Case
values built out of those — because a Case is constructed wherever its Choice is
in reach, including Modules with no import edge naming the Choice, and nothing
that had to be worked out THERE could travel with the Type. And a generic Choice
takes no default at all, since one can not bind a Choice's Type Parameters.

A value in the default may still be written as a NAME, so long as it names a
Constant of the Module the Choice is declared in:

```essence
constant standardHeaders: List<String> = []

choice Fetch {
	Get { url: String, headers: List<String> } = { headers = standardHeaders },
}
```

The Constant is read there, once, where the Choice is declared, and its value is
baked into the Case Type — so what travels is data either way, and the Module
constructing the Case never has to have heard of the Constant. Following one
Constant to the next is allowed; every leaf has to be written down. A Constant whose value is worked out is refused, and so are a
Variable, an imported Constant, and a Constant declared below the Choice — a
Constant does not hoist, and the default is read where it stands.

The DEFAULT itself is written out either way: which members it fills in is read
off the ones it writes, so `= standardHeaders` for the whole payload is not a
partial default but a mistake.

A Case with a payload is still constructed with one: `#Get({})` where the
default fills everything in. The bare `#Get` spelling stays what it has always
been — a Case that carries nothing at all.

### Reaching into a default

An Argument written for a defaulted Record Parameter, and a payload written for
a defaulting Case, are Literals merged into a value that is already there. So
they take PATH KEYS, and a braced descend, on exactly the terms a `with` does:

```essence
type Server = { host: String, port: Integer }
type Options = { retries: Integer, server: Server }

§§ Answers a description of the connection.
§§
§§ @param _ — the address to connect to.
§§ @param using — how to connect.
§§ @returns — the description.
function connect(
	_ url: String,
	using options: Options = {
		retries = 3,
		server = { host = "localhost", port = 8080 },
	},
) -> String {
	<- "{url} {options.server.host}:{options.server.port}"
}

constant local = connect("example.com", using { server.port = 1 })
```

`using { server.port = 1 }` reads exactly as `{ default with server.port = 1 }`
does: `port` comes from the call and `host` from the default. One rule for every
right-hand side of a merge — `server = { … }` REPLACES and `server.port = …`
MERGES, wherever the two are written.

A path may reach into a member the default writes as a Record LITERAL of its
own, as deep as that Literal is written out. A member the default fills in whole
— `server = fallback`, naming a value rather than writing it — is taken or left
whole, and a path into one is refused by name. That holds for a Case payload
default naming a Constant as well, whose value is in hand: what a path may reach
into is read off what the default WRITES, at both positions and for both
reasons. So is a path into a member the default does not fill in at all: there
would be nothing under it to merge with.

The Case payload reads the same way, filled in where the Case is constructed
rather than at a callee:

```essence
type Limits = { calls: Integer, burst: Integer }

choice Fetch {
	Get { url: String, limits: Limits } = { limits = { calls = 1, burst = 2 } },
}

constant polite = #Get({ url = "/items", limits.calls = 5 })
```

## Reading a member: paths as values

A `.member` chain written where a Function of ONE Parameter is expected stands
for that Function:

```essence
constant cheapest = products::sort(on .price)::firstItem()
constant names = products::map(.name)
```

`.price` is `(_ item: Product) { <- item.price }`, written out by the Compiler
against the Type the position expects. It reads members and nothing else: no
calls, and no steps through an `Optional`, a Union, a Choice or a `List`, all of
which are DECIDED before they are read, and deciding one is a Match rather than
a dot.

A path needs a Function Type to stand in for, and is refused where the position
names none — the rule a bare `#Case` lives by, for the same reason: a structural
language can not invent a Root Type out of a member name.

The standard library takes a key wherever a member is the thing being compared
or added up, under one label — `on`:

```essence
products::sort(on .price)
products::lowestItem(on .price)
products::highestItem(on .price, defaultingTo fallback)
products::sum(on .price)
products::average(on .price)
```

Write a path where the body is a pure read, and a Function literal where it is
anything else.
