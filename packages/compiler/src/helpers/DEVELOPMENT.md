# Developing the compiler's helpers

The helpers are the answers several stages must give alike. The compiler's own map is
[packages/compiler/DEVELOPMENT.md](../../DEVELOPMENT.md).

## Partial Record defaults

A Record Parameter's default may write only some of its Type's members. `recordDefaultMembers` answers which
members a call may leave out, and `recordDefaultNesting` answers which members a call may reach into with a path
key. The Resolver, the Simplifier and hover all ask them, so the Type, the emission and the hover text agree.

Both read what the default writes, not the default's Type. The Resolver builds the Parameter's Type before the
Enricher types the default, and every call is checked against that Type. A Record Literal says in its own text
which members it supplies, so it may supply some of them. Any other Expression is held to the Parameter's Type,
so it supplies all of them. The callee makes the same split: it reads a literal default member by member, and
any other default whole.

`recordDefaultNesting` lists a member only where the default writes it as a Record Literal. The callee rebuilds
such a member from the Argument and the default, so `server.port = 1` keeps the default's `host`, where a whole
`server = …` replaces it. A default written any other way can not be taken apart without evaluating it, so a
path key into it is refused as `path-key-without-default`.

Only the top level of a default may be partial. A nested literal that leaves out a member of its declared Type is
a `default-type-mismatch` already, so the nesting leaves it out.

Both take the two fields they read, `nodeType` and `members`, rather than a Node type. The parsed, typed and
simplified Record Literals all carry them. `recordDefaultMembers` sorts its list, so two structurally equal
signatures carry equal lists.
