# @essence/language-server

The Language Server for the
[Essence](https://github.com/alexandertrefz/essence) programming language,
speaking the Language Server Protocol over stdio.

Start it as `essence lsp` from
[`@essence/cli`](https://www.npmjs.com/package/@essence/cli), or through this
package's own `esls` launcher. Any LSP client can drive it; the
[Essence VS Code extension](https://github.com/alexandertrefz/essence/tree/master/packages/vscode-extension)
bundles it.

It serves diagnostics (with stable codes and Quick Fixes), completion,
signature help, hovers, go-to-definition, references, document highlight,
renaming, linked editing, call hierarchy, semantic tokens, inlay hints,
folding and selection ranges, an outline, and formatting via
[`@essence/formatter`](https://www.npmjs.com/package/@essence/formatter) — all
running on the same compiler stages `essence build` compiles with, so the
editor and the build can never disagree about a program.
