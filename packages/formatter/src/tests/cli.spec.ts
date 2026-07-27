import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE, run } from "../cli"
import { WIDTH } from "../index"

const MESSY = "implementation {\n    constant a = 1\n}\n"
const FORMATTED = "implementation {\n\tconstant a = 1\n}\n"
const BROKEN = "implementation {\n\tconstant = = =\n}\n"

// NOTE: `run` writes straight to the process's streams, so each invocation is
// wrapped to keep the test output clean and to let a test read what was said.
async function runCaptured(
	argv: Array<string>,
	options?: { programName?: string },
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
		return { code: await run(argv, options), stdout, stderr }
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
			expect(stderr).toContain("esfmt <files…>")
		})

		it("answers --help rather than rejecting what follows it", async () => {
			let { code, stdout } = await runCaptured(["--help", "--frobnicate"])

			expect(code).toBe(EXIT_SUCCESS)
			expect(stdout).toContain("esfmt — the Essence source formatter.")
		})

		it("rejects an unknown option written before --help", async () => {
			let { code, stderr } = await runCaptured(["--frobnicate", "--help"])

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

		it("takes everything past -- as a file", async () => {
			let messy = await file("Messy.es", MESSY)
			let { code } = await runCaptured(["--", messy])

			expect(code).toBe(EXIT_SUCCESS)
			expect(await readFile(messy, "utf8")).toBe(FORMATTED)
		})

		it("takes an option's spelling past -- as a file rather than an option", async () => {
			let { code, stderr } = await runCaptured(["--", "--check"])

			expect(code).toBe(EXIT_FAILURE)
			expect(stderr).toContain("could not be read.")
		})

		it("keeps reading options written before --", async () => {
			let messy = await file("Messy.es", MESSY)
			let { code } = await runCaptured(["--check", "--", messy])

			expect(code).toBe(EXIT_FAILURE)
			expect(await readFile(messy, "utf8")).toBe(MESSY)
		})
	})

	describe("program name", () => {
		it("names the tool esfmt when no name is given", async () => {
			let { stdout } = await runCaptured(["--help"])

			expect(stdout).toContain("esfmt — the Essence source formatter.")
			expect(stdout).toContain("print esfmt's version")
		})

		it("renders the name it was invoked as in the usage screen", async () => {
			let { code, stdout } = await runCaptured(["--help"], {
				programName: "essence format",
			})

			expect(code).toBe(EXIT_SUCCESS)
			expect(stdout).toContain(
				"essence format — the Essence source formatter.",
			)
			expect(stdout).toContain("essence format --check <files…>")
			expect(stdout).toContain("print essence format's version")
			expect(stdout).not.toContain("esfmt")
		})

		it("renders the name it was invoked as when an argument is refused", async () => {
			let { code, stderr } = await runCaptured(["--frobnicate"], {
				programName: "essence format",
			})

			expect(code).toBe(EXIT_USAGE)
			expect(stderr).toContain("Unknown option '--frobnicate'.")
			expect(stderr).toContain("essence format <files…>")
			expect(stderr).not.toContain("esfmt")
		})

		it("renders the name it was invoked as with nothing to do", async () => {
			let { code, stderr } = await runCaptured([], {
				programName: "essence format",
			})

			expect(code).toBe(EXIT_USAGE)
			expect(stderr).toContain(
				"essence format — the Essence source formatter.",
			)
			expect(stderr).not.toContain("esfmt")
		})

		it("lays every description out at one column, whatever the name", async () => {
			let { stdout } = await runCaptured(["--help"], {
				programName: "essence format",
			})

			let described = stdout
				.split("\n")
				.filter((line) => line.includes("format each file in place"))

			expect(described).toEqual([
				"  essence format <files…>    format each file in place",
			])
		})

		// NOTE: The screen's own last line promises that Essence is laid out to
		// fit WIDTH columns, so the screen has to fit it too — under every name
		// it can be invoked as, since the name is what moves the column.
		for (let programName of [undefined, "essence format"]) {
			it(`keeps the usage screen inside ${WIDTH} columns as ${programName ?? "esfmt"}`, async () => {
				let { stdout } = await runCaptured(
					["--help"],
					programName === undefined ? undefined : { programName },
				)

				let tooWide = stdout
					.split("\n")
					.filter((line) => [...line].length > WIDTH)

				expect(tooWide).toEqual([])
			})
		}
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
