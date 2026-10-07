# Developing the lexer

The reasoning behind `index.ts`. The parser's `TokenStream` drives the `Lexer` and reports what it collects; that
half is in the parser's own DEVELOPMENT.md.

## Which quote is missing

A String Literal may span lines, and its line breaks are part of it. In this file the String opened on line 1 closes
at the quote in front of `Ada`. The input ends inside the String that quote opens:

```
constant greeting = "Hello
constant name = "Ada"
```

One `"` is missing under either reading. Under the first, it belongs at the end of line 1 and the second line is a
Statement. Under the second, the author wrote a String holding a line of their own source and left `Ada` bare. Then
they opened a String they never closed. The first is what people write.

`swallowedTheLinesBelow` names the String that spanned lines as the culprit when it closed on the line where the
unclosed String opens. The Lexer keeps only the String that closed directly before the current one, so a one-line
String written between the two clears the claim. The two quotes have to share a line, so an unclosed String further
down the file is reported about itself. The answer rides on `UnterminatedStringError.swallower`.

`reportUnterminatedString` in the parser's `TokenStream` builds the `unclosed-string` report:

- Without a swallower, the report stands at the end of the input, where the String runs out, clamped to just after
  the last visible character. The opening quote is a secondary Label. A Help adds the missing quote at the end of the
  opening line, where the Quick Fix writes it. A quote written where the report stands would close a String holding
  every line below it.
- With one, the report stands on the opening quote of the String that spans lines, since the missing quote belongs
  on that line. The quote it closed on and the end of the input are secondary Labels, so the reading that was not
  chosen stays on the page. A Help adds the missing quote at the end of the String's first line. The other reading,
  a quote at the end of the input, is a Note rather than a second Help: that edit reaches no Program, because the
  quotes in the lines it swallows close the String early again.

Two forgotten quotes can leave the count even, so nothing is unterminated at all. In this file the quote before
`two` closes the String opened on line 1, and the quote before `three` opens one that line 3 closes:

```
constant a = "one
constant b = "two
constant c = "three"
```

What is left is the name `two`, read as a Statement of its own. `refuseNameBehindSwallowedLines` in the parser
reports it as `unclosed-string` about the String that spans lines. Its shape is narrow: a name that opens a
Statement right after a String spanning lines, on the line of its closing quote. Two Expressions never stand side by
side, so nothing else has that shape.

In every shape above the opening quote is the first Label standing on a `"`. `closeStringAction` in the language
server reads the String's start off that Label and writes the missing quote at the end of its line.

A String whose `{` opened a hole holding a backslash, such as JSON with escaped quotes, is reported as a hole
problem instead. Adding a quote there leaves the same refusal standing, so the Quick Fix withholds itself too.
`holeHoldsAnEscape` answers the question for both.

### A quote inside a hole

In `"a } b { c"` the `{` opens a hole, and the quote after `c` opens a String inside it. That String runs to the end
of the input. A quote added at the end of the line opens one more String in the same hole, so the report would come
back unchanged. `"Hello, {name"` has the same shape, with the hole's `}` forgotten instead.

`openHoles` records the `{` of each hole being read and the quote of the first String inside it that runs past its
own line. An unterminated String whose own opening quote stands in a hole carries that record as
`UnterminatedStringError.hole`, or its own quote where no String before it ran on. That quote is the one to label. A
String that closes on its own line, as the `", "` in `"{names::join(with ", ")"` does, is an Argument the hole
holds. The quote after it was meant to close the outer String, opened one of its own instead, and ran on.

`reportQuoteInHole` in the parser's `TokenStream` answers it ahead of every other shape. Only the reader knows which
of two edits was meant, so it offers both: `\{` for a brace that stands for itself, or a `}` in front of that first
quote for a hole that holds an Expression. The report labels the `{` and the quote, and `unclosedHoleActions` in the
language server reads the two Labels back as two Quick Fixes, neither preferred.

## Unicode escapes

`\u{1F600}` names one Unicode scalar value in one to six hexadecimal digits. `readUnicodeEscape` reads it by hand
rather than through `stringEscapes`, because its spelling runs past two characters and each part can be wrong on its
own. The braces can be missing, empty, hold a character that is not a hexadecimal digit, or hold too many digits.
The number can be above U+10FFFF, or a surrogate.

### Recovery

A refused escape contributes no character to the String. It named none. Keeping the digits as text would put `1B`
into a value whose author wrote an escape. A replacement character would put in one that nothing asked for.

Where the scan stops is the whole recovery. Looking for the closing brace, it stops at the characters that end the
literal's reading. Those are the closing quote, a backslash, a line break and the `{` that opens a hole. It does not
consume them. So an unclosed escape takes nothing with it: the quote still closes the String, and the `{` still
opens its hole. `refuseEscape` reports the escape as far as it was read and resumes there.

### Reports and Helps

A `LexingError` for a `\u{…}` carries its whole report in `report`, because each Help spells the reader's own digits
back. Which mistake it was is known only where the escape was read. Every malformed escape shares the Note
`unicodeEscapeRule`. A surrogate gets `surrogateRule` instead, since its digits are a well-formed escape and the
number is the mistake. A String holds characters, not the UTF-16 units they are stored in.

The Helps that rewrite the escape begin with a fixed phrase and quote the new spelling. `unicodeEscapeActions` in
the language server's `literalFixes.ts` reads that spelling back out of the Help, so the phrase is the contract
between the two. `pairedCharacterHelp` writes the surrogate pair's Help in one place for that reason.

- `\u{U+1B}` writes a code point as it is named rather than spelled. `namedCodePointHelps` offers the digits alone.
- Seven digits or more are leading zeros in every case a reader meant, such as `\u{000001B}`. `trimmedDigitHelps`
  drops them where what is left names a character, and offers nothing otherwise.
- A code point spelled by `bracedEscape` is upper case, as Unicode names one and as the runtime's quoted printer
  writes it. A Help that only re-brackets the reader's own digits keeps their case.

### Decimal digits

`\u{128512}` is a code point read off a chart in decimal and written into an escape that reads hexadecimal. Every
decimal digit is a hexadecimal digit too, so nothing looks wrong, and the number is simply too large.
`decimalReadingHelps` offers the decimal reading on a condition written into the sentence: "where the character
numbered 128512 was meant". It does so only for digits that are all decimal. Only the reader knows which base they
meant, so no Quick Fix applies this Help.

The Help is withheld up to `firstPlaneAboveTheTop`, U+11FFFF. The smallest escape this refusal sees is `\u{110000}`,
the top missed by one, written by someone who knows where it is. An escape in the first plane past the last real one
reads as someone counting planes, not copying a decimal.

`decimalReadingHelps` still checks the decimal reading with `isScalarValue`, though no six-digit input can fail it.
Every six-digit decimal reading lies past the surrogates and below U+10FFFF. The check keeps a Help from ever
spelling an escape the next run refuses, should the digit limit change.

### Unbraced escapes

`\u001B` and `\u1B` are the JavaScript and JSON habit, which writes the digits without braces. `readUnbracedEscape`
answers with the Essence spelling of the character the reader wrote, so it has to choose the digits carefully.
JavaScript's `\u` takes exactly four, so `\uABCD1` is `\uABCD` followed by `1` there. Four digits are taken where
four or more are written, and all of them where fewer are. Where a `}` stands right after one to six digits, only
the `{` was lost, and the whole of `\u1B}` is rewritten.

A surrogate pair, `\uD83D\uDE00`, is how JavaScript writes an astral character. Neither half names a character, so
neither has a rewrite of its own. `lowSurrogateBehind` finds the second half after the first, in either spelling, so
`\uD83D\u{DE00}` counts too. The whole pair is refused under one Diagnostic, the reading resumes past both halves,
and the Help rewrites the whole span as one escape. A braced high surrogate followed by its low half is refused the
same way. The unbraced form of a low half takes exactly four digits; the braced form takes one to six and its
closing brace.

## Number Literals

A Number Literal is digits and nothing else. Essence has no hexadecimal, binary or exponent form, so `0xFF`, `0b101`
and `1e5` are all wrong. `lexNumber` reads the letters into the Literal anyway and reports one `invalid-number`.
Stopping at the first letter would leave `FF` behind as an Identifier Statement, which the author did not write and
could not act on. The Token keeps only its leading digits, so later stages see a well-formed Number.

The `.` of a decimal is a Token of its own. The Parser joins `0`, `.` and `75` into one Rational Literal where the
three are written flush, as it joins `3`, `/` and `4`.

A Number ends at a character another language writes an operator with, the members of `foreignPunctuation`. `1+2` is
two Numbers and a habit, not one malformed Number, and `total = 1;` is a Number with a `;` after it. Neither
character ends a word for the Lexer, so each lexes as the start of an Identifier. The Parser answers it where it
stands, because it knows whether it is reading an operator or a Statement terminator.
