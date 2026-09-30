# Developing the lexer

The reasoning behind `index.ts`. The parser's `TokenStream` drives the `Lexer` and reports what it collects;
that half is in the parser's own DEVELOPMENT.md.

## Which quote is missing

A String Literal may span lines, and its line breaks are part of it. In this file the String opened on line 1
closes at the quote in front of `Ada`. The input ends inside the String that quote opens:

```
constant greeting = "Hello
constant name = "Ada"
```

One `"` is missing under either reading. Under the first, it belongs at the end of line 1 and the second line is
a Statement. Under the second, the author wrote a String holding a line of their own source and left `Ada` bare.
Then they opened a String they never closed. The first is what people write.

`swallowedTheLinesBelow` names the String that spanned lines as the culprit when it closed on the line where the
unclosed String opens. The Lexer keeps only the String that closed directly before the current one, so a one-line
String written between the two clears the claim. The two quotes have to share a line, so an unclosed String
further down the file is reported about itself. The answer rides on `UnterminatedStringError.swallower`.

`reportUnterminatedString` in the parser's `TokenStream` builds the `unclosed-string` report:

- Without a swallower, the report stands at the end of the input, where the String runs out, clamped to just after
  the last visible character. The opening quote is a secondary Label.
- With one, the report stands on the opening quote of the String that spans lines, since the missing quote belongs
  on that line. The quote it closed on and the end of the input are secondary Labels, so the reading that was not
  chosen stays on the page. A Help adds the missing quote at the end of the String's first line. The other
  reading, a quote at the end of the input, is a Note rather than a second Help: that edit reaches no Program,
  because the quotes in the lines it swallows close the String early again.

In both shapes the opening quote is the first Label standing on a `"`. `closeStringAction` in the language server
reads the String's start off that Label and writes the missing quote at the end of its line.

A String whose `{` opened a hole holding a backslash, such as JSON with escaped quotes, is reported as a hole
problem instead. Adding a quote there leaves the same refusal standing, so the Quick Fix withholds itself too.
`holeHoldsAnEscape` answers the question for both.
