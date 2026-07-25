# Change Log

## [0.1.0]

Adds the Essence Language Server, bundled into the extension — it runs on the
Node that ships with VS Code, so nothing needs to be installed.

- Diagnostics from the Parser, Enricher and Validator, with stable codes and
  unreachable Match cases greyed out rather than underlined.
- Go to definition, find references, document highlight and an outline.
- Renaming, covering argument labels, Methods and Record members, plus linked
  editing of a name's other occurrences as it is typed.
- Completion, including Record members, Methods after `::`, Namespaces after
  `::<`, argument labels and Record literal members.
- Signature help, Type hovers, semantic tokens, folding ranges, selection
  ranges and inlay hints.

Also corrects the grammar: `import`, `export` and `from` are ordinary
Identifiers in Essence and are no longer highlighted as keywords, and String
Literals have no escape sequences, so backslashes are no longer highlighted as
though they did.

## [0.0.6]

- Add support for the namespace keyword.

## [0.0.5]

- Add syntax support for comments.
- Improve and add more snippets.

## [0.0.4]

- Add snippets.
- Add keywords and improve rendering for `@`.
