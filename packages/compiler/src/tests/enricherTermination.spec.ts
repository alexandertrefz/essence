import { describe, expect, it } from "bun:test"
import path from "node:path"

import type { common } from "@essence-lang/interfaces"

// NOTE: THE guard that type matching comes back. Every job below is one where a
// Namespace's Type Parameter and a caller's are spelled the SAME, which is the
// shape a Type Parameter's identity — its name, and nothing else — can not tell
// apart on its own. Before `bindNamespaceTarget` alpha-renamed a Namespace's
// Generics and `isOpenBindable` grew its occurs check, such a Program bound
// `Item := List<Item>` off the first member of a Record target and then chased
// that name through itself: 363 million `matchGenericUse` turns in 25 seconds,
// flat memory, and no answer ever. `esc` had to be killed.
//
// NOTE: Run in a CHILD process, one per job, under a wall clock. A spin can not
// be caught in the process that started it — `bun test` would inherit it and
// report nothing at all, which is exactly what a guard against spinning must not
// do. The timeout is far above what the work costs (well under a second either
// way) so that a loaded machine can not turn it red; what it catches is
// unboundedness, not slowness.
//
// NOTE: TWO KINDS of job, because the two protections sit at different depths
// and a guard that can only see one of them is half a guard. The `source` jobs
// are the Programs a reader writes, and they are answered by the alpha-renaming:
// break that and they spin. The `match` jobs reach past it, handing the matcher
// a context whose Parameters were never renamed — the collision the renaming
// normally prevents, put there on purpose — so they are answered by the occurs
// check alone: break THAT and they spin. Each was confirmed to time out with
// its own protection reverted and the other left in place.
//
// NOTE: The Programs are the FAMILY, not the one report. Several are errors
// under the per-Method bound rules and are expected to stay errors — that is the
// point. Whether a Program compiles is decided elsewhere; termination is not
// allowed to depend on it, and a Program that stops being an error must still be
// listed here.
const TERMINATION_BUDGET_MS = 60_000

const RUNNER = path.join(import.meta.dir, "enricherTerminationRunner.ts")

const generic = (name: string): common.Type => ({
	type: "GenericUse",
	name,
})

const list = (itemType: common.Type): common.Type => ({
	type: "List",
	itemType,
})

const record = (members: Record<string, common.Type>): common.Type => ({
	type: "Record",
	members,
})

type Job =
	| { kind: "source"; source: string }
	| {
			kind: "match"
			pattern: common.Type
			subject: common.Type
			bindable: Array<string>
	  }

const jobs: Array<{ name: string; job: Job }> = [
	{
		name: "a Method bounding the Namespace's Parameter, reached through a caller spelling it alike",
		job: {
			kind: "source",
			source: `implementation {
	function distinct<infer Item is Equatable>(_ items: List<Item>) -> Integer {
		<- items::removeDuplicates()::length()
	}

	namespace Pairing<infer Item> for { left: Item, right: Item } {
		differing<Item is Equatable>() -> Integer {
			<- distinct([@.left, @.right])
		}
	}

	function viaNamespaceMethod<infer Item is Equatable>(
		_ pair: { left: List<Item>, right: List<Item> },
	) -> Integer {
		<- pair::differing()
	}

	Terminal.inspect(viaNamespaceMethod({ left = ["a"], right = ["b"] }))
}
`,
		},
	},
	{
		name: "the same Method with no bound at all, which stays an error",
		job: {
			kind: "source",
			source: `implementation {
	namespace Pairing<infer Item> for { left: Item, right: Item } {
		differing<Item>() -> Integer {
			<- 1
		}
	}

	function via<infer Item>(_ pair: { left: List<Item>, right: List<Item> }) -> Integer {
		<- pair::differing()
	}

	Terminal.inspect(via({ left = ["a"], right = ["b"] }))
}
`,
		},
	},
	{
		name: "a plain Method, where only the receiver carries the collision",
		job: {
			kind: "source",
			source: `implementation {
	namespace Pairing<infer Item> for { left: Item, right: Item } {
		swapped() -> { left: Item, right: Item } {
			<- { left = @.right, right = @.left }
		}
	}

	function via<infer Item>(
		_ pair: { left: List<Item>, right: List<Item> },
	) -> { left: List<Item>, right: List<Item> } {
		<- pair::swapped()
	}

	Terminal.inspect(via({ left = ["a"], right = ["b"] }).left)
}
`,
		},
	},
	{
		name: "a Namespace whose target nests its Parameter under the caller's own",
		job: {
			kind: "source",
			source: `implementation {
	namespace Nested<infer Item> for { held: List<Item>, spare: List<Item> } {
		count() -> Integer {
			<- @.held::length()
		}
	}

	function via<infer Item>(
		_ boxed: { held: List<List<Item>>, spare: List<List<Item>> },
	) -> Integer {
		<- boxed::count()
	}

	Terminal.inspect(via({ held = [["a"]], spare = [["b"]] }))
}
`,
		},
	},
	{
		name: "a conditional conformance whose 'where' Parameter is spelled like the caller's",
		job: {
			kind: "source",
			source: `implementation {
	protocol Sized {
		size() -> Integer
	}

	namespace Holder<infer Item> for { one: Item, two: Item } is Sized where Item is Sized {
		size() -> Integer {
			<- @.one::size()
		}
	}

	function via<infer Item is Sized>(_ pair: { one: List<Item>, two: List<Item> }) -> Integer {
		<- pair::size()
	}

	Terminal.inspect(via({ one = [], two = [] }))
}
`,
		},
	},
	{
		name: "a bindable Parameter met twice, the second time against a Type holding itself",
		job: {
			kind: "match",
			pattern: record({ left: generic("Item"), right: generic("Item") }),
			subject: record({
				left: list(generic("Item")),
				right: list(generic("Item")),
			}),
			bindable: ["Item"],
		},
	},
	{
		name: "the same collision one level deeper, under a List",
		job: {
			kind: "match",
			pattern: record({
				left: list(generic("Item")),
				right: list(generic("Item")),
			}),
			subject: record({
				left: list(list(generic("Item"))),
				right: list(list(generic("Item"))),
			}),
			bindable: ["Item"],
		},
	},
	{
		name: "two Parameters binding through one another",
		job: {
			kind: "match",
			pattern: record({
				left: generic("Key"),
				right: generic("Value"),
				both: record({ key: generic("Key"), value: generic("Value") }),
			}),
			subject: record({
				left: list(generic("Value")),
				right: list(generic("Key")),
				both: record({
					key: list(generic("Value")),
					value: list(generic("Key")),
				}),
			}),
			bindable: ["Key", "Value"],
		},
	},
]

describe("Type matching terminates under a Type Parameter name collision", () => {
	for (let { name, job } of jobs) {
		it(
			`returns for ${name}`,
			async () => {
				let child = Bun.spawn(["bun", RUNNER], {
					stdin: new TextEncoder().encode(JSON.stringify(job)),
					stdout: "pipe",
					stderr: "pipe",
				})

				let timer = setTimeout(
					() => child.kill("SIGKILL"),
					TERMINATION_BUDGET_MS,
				)
				let exitCode = await child.exited

				clearTimeout(timer)

				let output = await new Response(child.stdout).text()
				let errors = await new Response(child.stderr).text()

				// NOTE: The word, not merely a zero exit — a child killed by the
				// wall clock above exits non-zero, and so does one that threw.
				// The three are told apart here so a failure says which happened.
				expect(`${exitCode} ${output} ${errors}`).toBe("0 returned ")
			},
			TERMINATION_BUDGET_MS + 30_000,
		)
	}
})
