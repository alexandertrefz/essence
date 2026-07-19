# Ariadne (TypeScript port)

A TypeScript port of [ariadne](https://codeberg.org/zesterer/ariadne), a
fancy compiler diagnostics & error reporting crate for Rust by Joshua
Barretto, licensed under MIT. The renderer is a statement-by-statement port
of upstream `src/report/write.rs` and is verified against the upstream
snapshot test suite (see `report.spec.ts`).

```
Error: can't compare apples with oranges
   ╭─┤ <unknown>:1:1 │
   │
 1 │ apple == orange;
   │ ──┬──    ───┬──
   │   ╰─────────│──── This is an apple
   │             │
   │             ╰──── This is an orange
───╯
```

## Usage

```ts
import { Config, Label, Report } from "./ariadne"

let report = new Report({
	kind: "error",
	span: { start: 0, end: 0 },
	message: "can't compare apples with oranges",
	labels: [
		new Label({ start: 0, end: 5 }, { message: "This is an apple" }),
		new Label({ start: 9, end: 15 }, { message: "This is an orange" }),
	],
	helps: ["have you tried peeling the orange?"],
})

console.log(report.render("apple == orange;"))
```

`Report.render` accepts a plain string, a `Source`, or — for reports whose
labels point into multiple sources — a `Cache` (see `sources()`). Labels can
be colored individually (`ColorGenerator` produces distinct colors), ordered,
prioritised, and span multiple lines; see `LabelOptions` and `ConfigOptions`
for everything that can be tuned.

## Differences from upstream

- Span offsets are counted in Unicode code points (`indexType: "char"`, the
  default) or UTF-16 code units (`indexType: "utf16"`), the JavaScript-native
  analog of upstream's byte spans.
- The `Report`/`Label`/`Config` builders are replaced with options objects.
- The unstable named-styles feature (`Styleable`/`Config::styles`) and the
  `concolor`/stream-detection integration are not ported. Terminal color
  support detection is the caller's responsibility (`color: false` disables
  styling, `stripAnsi: true` additionally strips codes embedded in messages).
- Character display widths use a compact approximation of the Unicode
  East-Asian-width tables rather than the full `unicode-width` data.

## Package extraction

This directory is deliberately self-contained (no imports from the rest of
the compiler, no external dependencies, no runtime-specific APIs) so it can
be extracted into a standalone package by moving the folder and adding a
`package.json`.
