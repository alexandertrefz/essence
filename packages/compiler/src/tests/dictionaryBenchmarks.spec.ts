import { beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import type { DictionaryType } from "@essence-lang/runtime/Dictionary"
import type { AnyType } from "@essence-lang/runtime/type"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: A benchmark's time does not say which path its keys took, so the
// Dictionaries the key suites of `DictionaryBenchmarks.es` read are built here
// and their stores asked. A slot with no encoding is one only a walk finds.

type Held = DictionaryType<AnyType, AnyType>

async function dictionariesOf(
	names: Array<string>,
): Promise<Record<string, Held>> {
	let parsed = parseWithDiagnostics(
		readFileSync(fixturePath("DictionaryBenchmarks.es"), "utf8"),
	)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	let javaScript = rewrite(optimise(simplify(enriched.program)))
	let directory = mkdtempSync(join(tmpdir(), "essence-benchmark-keys-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, `${javaScript}\nexport { ${names.join(", ")} }\n`)

	try {
		return await import(file)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

describe("The key suites of the Dictionary benchmarks", () => {
	let held: Record<string, Held> = {}

	beforeAll(async () => {
		held = await dictionariesOf(["labelled", "taken", "sold", "counted"])
	})

	it("find a 'Scan-path keys' key only by walking the entries", () => {
		expect(held.labelled.length).toBe(1000)
		expect(held.labelled.store.unencoded).toBe(1000)
	})

	it("find a 'Record keys' key under its encoding", () => {
		expect(held.taken.length).toBe(1000)
		expect(held.taken.store.unencoded).toBe(0)
	})

	it("find a 'Choice keys' key under its encoding", () => {
		expect(held.sold.length).toBe(1000)
		expect(held.sold.store.unencoded).toBe(0)
		expect(held.counted.length).toBe(3)
		expect(held.counted.store.unencoded).toBe(0)
	})
})
