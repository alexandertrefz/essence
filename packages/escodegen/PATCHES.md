# escodegen, vendored

This is third-party code. It is not ours to rewrite, and it is deliberately
kept as close to what upstream published as it can be.

## Provenance

| | |
|---|---|
| Upstream | [estools/escodegen](https://github.com/estools/escodegen) |
| Base | `899cfdf5dc99de324fb6f1087aa9bab4d4bc2f00` — the `Version 2.1.0` commit |
| Vendored from | `alexandertrefz/escodegen@b4cb6d12aa3eb4082d001e0900ec30379ee79a63` |
| Divergence | one commit, twelve lines |
| License | BSD-2-Clause, unmodified in `LICENSE.BSD` |

Only what upstream's own `files` field ships is here — `escodegen.js`,
`README.md`, `LICENSE.BSD` and a manifest. The `bin/`, `test/`, `benchmark/`
and `tools/` directories, the gulpfile and a devDependency tree of gulp 4,
mocha and chai are not: the compiler calls exactly one function, `generate`,
from exactly one place, and a git dependency was installing seventeen
megabytes to provide it.

`esprima` is dropped along with them. It is upstream's test dependency and
`escodegen.js` never requires it.

## The patch

Upstream's code generator has no case for `PropertyDefinition` — the ESTree
node for a class field — and throws on an unhandled node type. The rewriter
emits them: every Essence Namespace becomes a class, and each of its
Properties becomes a field, in `rewriteNamespaceDefinitionStatement`
([`rewriter/index.ts`](../compiler/src/rewriter/index.ts)). So this is
load-bearing rather than a nicety.

Applied at `escodegen.js`, immediately above `Property`, inside the
`CodeGenerator.prototype.Expression` table:

```js
PropertyDefinition: function (expr, precedence, flags) {
    var result;
    if (expr['static']) {
      result = ['static' + space];
    } else {
      result = [];
    }
    result.push(this.generateAssignment(expr.key, expr.value, '=', precedence, flags));
    result.push(this.semicolon(flags));
    return result;
  },
```

## Re-vendoring

Take upstream's `escodegen.js` at whatever release you are moving to, apply
the block above, and update the table. Nothing else here is ours. Run
`bun test rewriter codeGeneration bundleSize` afterwards — those three cover
the generator's whole output surface, including the class fields this patch
exists for.

## Why not upstream the patch, or drop the fork

Upstreaming would be better and is worth trying; escodegen has been dormant
since 2021, so it is not worth waiting on.

Dropping the fork means replacing escodegen. [`astring`](https://github.com/davidbonnet/astring)
handles `PropertyDefinition` natively, is maintained, and is ESM rather than
this UMD bundle. That is a behaviour change across every emitted byte, with
real snapshot risk in `rewriter` and `codeGeneration`, so it wants to be its
own piece of work rather than a side effect of vendoring.
