# Publishing

Ten packages publish to npm under the `@essence-lang` scope, always together and
always at one version: `interfaces`, `escodegen` (the vendored fork),
`ariadne`, `stdlib`, `runtime`, `compiler`, `formatter`, `debug-adapter`,
`language-server` and `cli`. `fixtures` and the website stay private, and the
VS Code extension ships to the Marketplace instead, via `bun run package` in
its own directory.

## One-time setup

- The `essence-lang` organisation must exist on npm — <https://www.npmjs.com/org/create> —
  and the publishing account must be a member allowed to publish in it.
- `npm login` on the publishing machine.

## A release

1. Set the new version in every published package's
   `packages/*/package.json`. The versions move in lockstep, and the staging
   script reads them from the manifests — the manifests are the single source
   of truth, there is no version anywhere else. The one consumer to carry
   along: the VS Code extension pins `@essence-lang/language-server` and
   `@essence-lang/stdlib` by exact version in its `devDependencies`.
2. `bun install`, `bun test`, `bun run typecheck` — the tree the release is
   cut from is green.
3. `bun run publish:smoke` — stages everything and proves the *artifacts*:
   the staged packages are copied into a scratch npm workspace in the system
   tmpdir, installed with real npm, and driven with plain Node — every export
   imported, a program compiled, run and source-mapped, `esfmt` fed over
   stdin. A green suite proves the sources; only this proves what ships.
4. `bun run publish:packages --dry-run` — npm's own packing and manifest
   validation, without the registry. This is the step that catches what the
   smoke test structurally cannot: npm normalising or rejecting manifest
   fields (it once silently removed dot-slashed `bin` paths, which the smoke
   test never noticed because it invokes the bin files by path).
5. `bun run publish:packages` — re-stages and publishes in dependency order,
   so no package is ever visible before what it depends on. With two-factor
   auth npm may ask for an OTP per package.

## What staging is

The workspace never builds — every manifest points `main`/`exports` at
TypeScript sources and Bun runs them directly. Publishing therefore assembles
a second, compiled form of each package OUT of the tree, under
`build/publish/`, and never edits the tree itself:

- `tsconfig.publish.json` is the one tsc invocation that emits: one program
  over every published package (mirroring the dev tsconfig's one-program
  philosophy), JavaScript and declarations into `build/publish/compiled/`,
  with tests, tools and specs excluded.
- The emitted relative import specifiers are bundler-style (`./common/index`)
  and Node's ESM loader refuses them, so staging resolves each against the
  compiled tree and extends it (`.js`, or `/index.js` for a directory) — in
  the declarations too. A specifier that resolves to neither is a staging
  error, not a consumer's surprise.
- Each package is then assembled into `build/publish/packages/<name>`:
  `dist/`, the data that ships beside it (the standard library's `.es`
  sources; the runtime's TypeScript, which the bundler inlines from source so
  a published compiler emits byte-identical bundles), bin files derived from
  the real ones (Bun's shebang becomes Node's, `../src/x` becomes
  `../dist/x.js`), README, LICENSE, and a rewritten manifest: entries pointed
  at `dist/`, `workspace:*` pinned to the exact lockstep version, `private`
  dropped, `engines.node >= 22`, `publishConfig.access: "public"`.
- `escodegen` is the one prebuilt package — already JavaScript, copied
  verbatim with its own hand-written declarations and BSD license.

`bun run publish:stage` runs just the staging, `bun run publish:pack` also
packs tarballs into `build/publish/tarballs/` for inspection.
