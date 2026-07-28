# @essence-lang/formatter

`esfmt` — the source formatter for the
[Essence](https://github.com/alexandertrefz/essence) programming language.

## Command line

```sh
esfmt File.es                # format in place
esfmt --check 'src/*.es'     # exit non-zero if anything would change
cat File.es | esfmt --stdin  # read stdin, write the result to stdout
```

`essence format` runs the same formatter from the main CLI. Style is not
configurable: tabs, a width of 80, and the rules the standard library itself
is written in.

## API

```ts
import { format } from "@essence-lang/formatter"

let result = format(sourceText, { documentPath: "File.es" })

result.text // the formatted source
result.changed // whether it differs from the input
result.refusal // null, or why the formatter would not touch the file
```

A refusal is the safety gate speaking: the formatter re-parses its own output
and compares comment anchors, and if reprinting would change what the file
*means*, it declines and says so rather than writing.
