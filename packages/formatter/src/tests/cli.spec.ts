import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE, run } from "../cli"

const MESSY = "implementation {\n    constant a = 1\n}\n"
const FORMATTED = "implementation {\n\tconstant a = 1\n}\n"
const BROKEN = "implementation {\n\tconstant = = =\n}\n"

// NOTE: `run` writes straight to the process's streams, so each invocation is
// wrapped to keep the test output clean and to let a test read what was said.
async function runCaptured(
	argv: Array<string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = ""
	let stderr = ""

	let stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
		(chunk) => {
			stdout += chunk

			return true
		},
	)
	let stderrSpy = spyOn(process.stderr, "write").mockImplementation(
		(chunk) => {
			stderr += chunk

			return true
		},
	)

	try {
		return { code: await run(argv), stdout, stderr }
	} finally {
		stdoutSpy.mockRestore()
		stderrSpy.mockRestore()
	}
}

describe("cli", () => {
	let directory: string

	beforeEach(async () => {
		directory = await mkdtemp(path.join(os.tmpdir(), "esfmt-"))
	})

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true })
	})

	let file = async (name: string, source: string): Promise<string> => {
		let filePath = path.join(directory, name)

		await mkdir(path.dirname(filePath), { recursive: true })
		await writeFile(filePath, source, "utf8")

		return filePath
	}

	describe("usage", () => {
		it("prints usage on --help and succeeds", async () => {
			let { code, stdout } = await runCaptured(["--help"])

			expect(code).toBe(EXIT_SUCCESS)
			expect(stdout).toContain("esfmt — the Essence source formatter.")
		})

		it("rejects an unknown option", async () => {
			let { code, stderr } = await runCaptured(["--frobnicate"])

			expect(code).toBe(EXIT_USAGE)
			expect(stderr).toContain("Unknown option '--frobnicate'.")
		})

		it("rejects a run with nothing to do", async () => {
			let { code } = await runCaptured([])

			expect(code).toBe(EXIT_USAGE)
		})

		it("rejects --stdin alongside file arguments", async () => {
			let { code } = await runCaptured(["--stdin", "File.es"])

			expect(code).toBe(EXIT_USAGE)
		})

		it("rejects --stdin-filepath without --stdin", async () => {
			let { code, stderr } = await runCaptured([
				"--stdin-filepath",
				"File.es",
			])

			expect(code).toBe(EXIT_USAGE)
			expect(stderr).toContain("--stdin")
		})

		it("rejects --stdin-filepath without a path", async () => {
			let { code, stderr } = await runCaptured(["--stdin-filepath"])

			expect(code).toBe(EXIT_USAGE)
			expect(stderr).toContain("'--stdin-filepath' needs a path.")
		})
	})

	describe("--version", () => {
		it("prints the package's own version", async () => {
			let packageJson = JSON.parse(
				await readFile(
					new URL("../../package.json", import.meta.url),
					"utf8",
				),
			) as { version: string }

			let { code, stdout } = await runCaptured(["--version"])

			expect(code).toBe(EXIT_SUCCESS)
			expect(stdout).toBe(packageJson.version + "\n")
		})
	})

	describe("formatting files", () => {
		it("fails when nothing matched", async () => {
			let { code, stderr } = await runCaptured([
				path.join(directory, "*.es"),
			])

			expect(code).toBe(EXIT_FAILURE)
			expect(stderr).toContain("No files matched.")
		})

		it("fails on an unreadable path", async () => {
			let { code, stderr } = await runCaptured([
				path.join(directory, "Missing.es"),
			])

			expect(code).toBe(EXIT_FAILURE)
			expect(stderr).toContain("could not be read.")
		})

		it("rewrites a messy file in place", async () => {
			let messy = await file("Messy.es", MESSY)
			let { code } = await runCaptured([messy])

			expect(code).toBe(EXIT_SUCCESS)
			expect(await readFile(messy, "utf8")).toBe(FORMATTED)
		})

		it("leaves an already formatted file alone", async () => {
			let formatted = await file("Formatted.es", FORMATTED)
			let { code, stdout } = await runCaptured([formatted])

			expect(code).toBe(EXIT_SUCCESS)
			expect(stdout).toContain("Formatted 0 of 1 file.")
			expect(await readFile(formatted, "utf8")).toBe(FORMATTED)
		})

		it("refuses a file with syntax errors and keeps its bytes", async () => {
			let broken = await file("Broken.es", BROKEN)
			let { code } = await runCaptured([broken])

			expect(code).toBe(EXIT_FAILURE)
			expect(await readFile(broken, "utf8")).toBe(BROKEN)
		})
	})

	describe("--check", () => {
		it("names an unformatted file without writing to it", async () => {
			let messy = await file("Messy.es", MESSY)
			let { code, stdout } = await runCaptured(["--check", messy])

			expect(code).toBe(EXIT_FAILURE)
			expect(stdout).toContain("Messy.es")
			expect(await readFile(messy, "utf8")).toBe(MESSY)
		})

		it("passes a formatted file", async () => {
			let formatted = await file("Formatted.es", FORMATTED)
			let { code } = await runCaptured(["--check", formatted])

			expect(code).toBe(EXIT_SUCCESS)
		})
	})

	describe("directories", () => {
		it("formats every .es file under a directory, and nothing else", async () => {
			let shallow = await file("Shallow.es", MESSY)
			let nested = await file(path.join("deep", "Nested.es"), MESSY)
			let other = await file("notes.txt", "not essence\n")

			let { code, stdout } = await runCaptured([directory])

			expect(code).toBe(EXIT_SUCCESS)
			expect(stdout).toContain("Formatted 2 of 2 files.")
			expect(await readFile(shallow, "utf8")).toBe(FORMATTED)
			expect(await readFile(nested, "utf8")).toBe(FORMATTED)
			expect(await readFile(other, "utf8")).toBe("not essence\n")
		})

		it("takes a named file as it is, whatever its extension", async () => {
			let odd = await file("Odd.essence", MESSY)
			let { code } = await runCaptured([odd])

			expect(code).toBe(EXIT_SUCCESS)
			expect(await readFile(odd, "utf8")).toBe(FORMATTED)
		})
	})
})
