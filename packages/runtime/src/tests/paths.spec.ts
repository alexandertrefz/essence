import { describe, expect, test } from "bun:test"
import * as path from "node:path"

import { RUNTIME_DIRECTORY, runtimeDirectoryFor } from "../index"

describe("runtime location", () => {
	test("the workspace runtime directory is the sources' own", () => {
		expect(RUNTIME_DIRECTORY).toBe(path.resolve(import.meta.dirname, ".."))
	})

	test("a compiled module answers with the sources beside it", () => {
		expect(runtimeDirectoryFor(path.resolve("/install/runtime/dist"))).toBe(
			path.resolve("/install/runtime/src"),
		)
	})

	test("any other location is taken as the sources themselves", () => {
		expect(runtimeDirectoryFor(path.resolve("/checkout/runtime/src"))).toBe(
			path.resolve("/checkout/runtime/src"),
		)
	})
})
