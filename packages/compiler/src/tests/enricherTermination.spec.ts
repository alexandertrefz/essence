import { describe, expect, it } from "bun:test"
import path from "node:path"

import type { common } from "@essence-lang/interfaces"

// Type matching must return when a Namespace's Type Parameter and a caller's
// share a name, since a Type Parameter's identity is its name. Without
// protection, matching binds `Item := List<Item>` and chases it forever.
//
// Each job runs in a child process under a wall clock, because a spin cannot be
// caught in the process that started it. The budget is far beyond the work's
// cost: it catches unboundedness, not slowness.
//
// The `source` jobs are Programs, which the alpha-renaming in
// `bindNamespaceTarget` answers. The `match` jobs hand the matcher Parameters
// that were never renamed, so only the occurs check in `isOpenBindable` answers
// them. Each kind fails if its own protection breaks.
//
// Some Programs are errors under the per-Method bound rules. Termination must
// not depend on whether a Program compiles, so they stay listed either way.
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

				// A killed child and one that threw both exit non-zero, so the
				// expectation includes the output to say which happened.
				expect(`${exitCode} ${output} ${errors}`).toBe("0 returned ")
			},
			TERMINATION_BUDGET_MS + 30_000,
		)
	}
})
