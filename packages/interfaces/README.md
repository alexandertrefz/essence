# @essence/interfaces

The types every stage of the
[Essence](https://github.com/alexandertrefz/essence) compiler agrees on:
tokens, the parsed AST, the enriched (typed) AST, the typed simple AST the
back end consumes, and the shapes they share — positions, cursors, and the
common node forms.

The package is almost entirely type declarations. It exists so that the
compiler's stages, the Language Server, the Debug Adapter and any external
tool can talk about the same program shapes without depending on the compiler
itself.

| Subpath | |
| --- | --- |
| `@essence/interfaces` | everything, namespaced by stage |
| `@essence/interfaces/common` | the shared node and position types |
| `@essence/interfaces/lexer` | token types |
| `@essence/interfaces/parser` | parsed AST node types |
| `@essence/interfaces/enricher` | typed AST node and Type types |
