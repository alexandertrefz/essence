# Site check

A command that asks several addresses for their pages at once and reports what
each one answered. [`check.ts`](check.ts) is Bun: it reads the addresses off the
command line, prints a line each, and picks an exit code. Everything else — the
requests, the deadline, the bound on how many run together, the reading of a
page's title and the count at the end — is Essence, in [`survey/`](survey/), and
reaches the command through an ordinary import:

```ts
import { type Outcome, surveyed } from "./survey/Survey.es"
```

```sh
cd examples/site-check
bun check.ts https://essencelang.org https://example.com
```

```
200 Essence	https://essencelang.org
200 Example Domain	https://example.com
2 of 2 answered
```

The Bun plugin registered in [`essence.ts`](essence.ts) (preloaded by
[`bunfig.toml`](bunfig.toml)) compiles the module graph behind that import and
serves it as marshalled JavaScript.

## What it shows

- **Work is a value.** [`Http.get`](https://essencelang.org/docs/library/http#get)
  answers a `Future`, a description of a request that has not been made. Asking
  twenty addresses is therefore an ordinary `map` over twenty addresses, and
  what comes out is a `List<Future<Report>>` — twenty descriptions, none of them
  running.

  ```
  constant work    = urls::map((url) { <- checked(url, asking ask, within limit) })
  constant reports = complete work::all(atMost bound)
  ```

- **One word sets the concurrency.**
  [`all(atMost:)`](https://essencelang.org/docs/library/future#all) folds that
  list into a single description that keeps `bound` requests in flight and
  starts the next as one finishes. `all()` would start all twenty at once and
  `inSequence()` one at a time; the answer is the same list, in the addresses'
  order, either way.

- **A body that waits says so in its return type.** `collected` writes
  `complete`, so it is a *completing body*: it declares `-> Future<Survey>` and
  hands its caller a description. There is no `async` and no `await`. The
  summing under the `complete` reads the list of reports the way any other
  function would.

- **A deadline is a method, not a member of the request.**
  [`within(milliseconds:)`](https://essencelang.org/docs/library/future#within)
  wraps any work at all and answers an `Optional`, so a run that took too long
  is `#Empty` rather than a failure — and the request it started is stopped.
  Nothing in `Request` says anything about time.

- **A status is not a failure.** A host that answers 404 answered, so `#Answered`
  carries it. The `#Failure` side of `Http`'s `Result` is the three ways a
  request produces no answer at all, and this survey turns one into
  `#Unreachable` with the reason.

- **The doubles are `Async.deferred`.** [`Survey.es`](survey/Survey.es) ends in a
  `tests { … }` section whose four doubles are functions from an address to
  work — the same shape `Http.get` has — built with
  [`Async.deferred`](https://essencelang.org/docs/library/future#deferred) and
  [`Async.sleep`](https://essencelang.org/docs/library/future#sleep). The whole
  survey runs against them: a page with a title, a 404, a refused connection and
  a host that dawdles past its deadline, with no host anywhere and nothing to
  wait for.

  ```
  $ essence test survey
  ```

- **Work crosses as a promise.** `surveyed` answers a `Future<Survey>` in
  Essence and a `Promise<Survey>` in TypeScript, and calling it is what puts the
  requests in flight. That is the only position work crosses at: a future inside
  a record or a list is refused in both directions. `check.ts` therefore has one
  `await` in it, and every concurrent thing about the program is on the other
  side of it.

- **Typed on both sides.** The plugin writes `survey/Survey.d.es.ts` beside the
  source, and `tsc` reads the import from it:

  ```ts
  export type Outcome =
  	| { $case: "Outcome#Answered"; status: bigint; title: string | undefined }
  	| { $case: "Outcome#Unreachable"; reason: string }
  	| { $case: "Outcome#TooSlow" }
  export declare function surveyed(p0: Array<string>, atMost: bigint | number): Promise<Survey>
  ```

  An `Optional<String>` is `string | undefined`, so a page with no title needs no
  second spelling; `switch (outcome.$case)` is exhaustive because the choice is.

## The files

| File | What it is |
| --- | --- |
| [`survey/Survey.es`](survey/Survey.es) | The survey: the `Outcome` choice, the reports, the bound, and the one closure that reaches a host. Its `tests { … }` section drives all of it off `Async.deferred`. |
| [`survey/Page.es`](survey/Page.es) | The whole of the HTML reading: two cuts at the `title` tags. |
| [`check.ts`](check.ts) | The command: addresses in, a line each out, and an exit code. |
| [`site-check.spec.ts`](site-check.spec.ts) | Runs the survey's own tests, starts a host on a free port, and runs the command against it end to end. |

[`site-check.spec.ts`](site-check.spec.ts) reaches no network: it serves three
pages of its own on a free port, and the one address that answers nothing is the
discard port on loopback.
