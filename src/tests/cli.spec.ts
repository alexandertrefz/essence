import { describe, expect, it } from "bun:test"

import { parseArguments, UsageError } from "../cli/args"
import { commands, findCommand, globalOptions } from "../cli/commands"
import { colorChoiceFor } from "../cli/context"
import { renderCommandHelp, renderOverview, wrap } from "../cli/help"
import {
	defaultOutputFor,
	looksLikeGlob,
	resolveInputFiles,
	resolveOutputFiles,
} from "../cli/inputs"
import { toJSONReport } from "../cli/json"
import type { CompileOutcome } from "../cli/pipeline"
import { defaultWorkerCount, shouldUseWorkers } from "../cli/pool"
import {
	countDiagnostics,
	formatBytes,
	formatDuration,
	pluralise,
} from "../cli/report"
import { isInteractive, truncate } from "../cli/terminal"
import {
	createPalette,
	createTheme,
	stripAnsi,
	supportsColor,
	supportsUnicode,
	visibleLength,
} from "../cli/theme"
import { closestMatch } from "../helpers/index"

const buildCommand = findCommand("build") as NonNullable<
	ReturnType<typeof findCommand>
>

function outcome(overrides: Partial<CompileOutcome> = {}): CompileOutcome {
	return {
		inputFileName: "Source.es",
		outputFileName: "Source.js",
		ok: true,
		sourceText: "",
		diagnostics: [],
		timings: [{ name: "parse", duration: 1.5 }],
		duration: 12.25,
		bytes: 2048,
		gzipBytes: 512,
		failedStage: null,
		stack: null,
		...overrides,
	}
}

describe("CLI", () => {
	describe("parseArguments", () => {
		it("defaults to the build Command", () => {
			let invocation = parseArguments(["HelloWorld.es"])

			expect(invocation.command.name).toBe("build")
			expect(invocation.commandWasExplicit).toBe(false)
			expect(invocation.files).toEqual(["HelloWorld.es"])
		})

		it("recognises an explicit Command", () => {
			let invocation = parseArguments(["check", "HelloWorld.es"])

			expect(invocation.command.name).toBe("check")
			expect(invocation.commandWasExplicit).toBe(true)
			expect(invocation.files).toEqual(["HelloWorld.es"])
		})

		it("resolves Command aliases", () => {
			expect(parseArguments(["b", "a.es"]).command.name).toBe("build")
			expect(parseArguments(["w", "a.es"]).command.name).toBe("watch")
		})

		it("reads short and long Options", () => {
			let invocation = parseArguments([
				"build",
				"-o",
				"out.js",
				"--minify",
				"a.es",
			])

			expect(invocation.options.out).toBe("out.js")
			expect(invocation.options.minify).toBe(true)
			expect(invocation.files).toEqual(["a.es"])
		})

		// NOTE: A path is never mistaken for a mistyped Command, however
		// closely it happens to resemble one.
		it("treats a file name as a file rather than an unknown Command", () => {
			let invocation = parseArguments(["build.es"])

			expect(invocation.command.name).toBe("build")
			expect(invocation.files).toEqual(["build.es"])
		})

		it("suggests a Command for a near miss", () => {
			try {
				parseArguments(["buld", "a.es"])
				expect.unreachable()
			} catch (error) {
				expect(error).toBeInstanceOf(UsageError)
				expect((error as UsageError).suggestion).toContain("esc build")
			}
		})

		it("reports an unknown Option against the Command it was given to", () => {
			try {
				parseArguments(["build", "--nonsense", "a.es"])
				expect.unreachable()
			} catch (error) {
				expect(error).toBeInstanceOf(UsageError)
				expect((error as UsageError).command?.name).toBe("build")
				expect((error as UsageError).message).toContain("--nonsense")
			}
		})

		it("suggests a near-miss Option", () => {
			try {
				parseArguments(["build", "--minfy", "a.es"])
				expect.unreachable()
			} catch (error) {
				expect((error as UsageError).suggestion).toContain("--minify")
			}
		})

		it("hands arguments after -- to the program", () => {
			let invocation = parseArguments([
				"run",
				"a.es",
				"--",
				"--port",
				"8080",
			])

			expect(invocation.files).toEqual(["a.es"])
			expect(invocation.programArguments).toEqual(["--port", "8080"])
		})

		it("refuses program arguments for Commands that run nothing", () => {
			expect(() => parseArguments(["build", "a.es", "--", "x"])).toThrow(
				UsageError,
			)
		})

		it("rejects a --jobs value that is not a positive whole number", () => {
			expect(() => parseArguments(["build", "-j", "0", "a.es"])).toThrow(
				UsageError,
			)
			expect(() =>
				parseArguments(["build", "-j", "two", "a.es"]),
			).toThrow(UsageError)
			expect(
				parseArguments(["build", "-j", "4", "a.es"]).options.jobs,
			).toBe(4)
		})

		it("accepts --help without any file", () => {
			expect(parseArguments(["--help"]).options.help).toBe(true)
			expect(parseArguments(["build", "--help"]).options.help).toBe(true)
		})
	})

	describe("closestMatch", () => {
		it("finds a plausible correction", () => {
			expect(closestMatch("buld", ["build", "check"])).toBe("build")
		})

		it("offers nothing when there is no near match", () => {
			expect(closestMatch("xyzzy", ["build", "check"])).toBe(null)
		})
	})

	describe("Command table", () => {
		// NOTE: Help is generated from the Command table, so an Option that is
		// added without documentation would silently produce an empty entry.
		it("documents every Option", () => {
			for (let command of commands) {
				for (let option of [...command.options, ...globalOptions]) {
					expect(option.summary.length).toBeGreaterThan(0)
				}
			}
		})

		it("gives every Command a usage line and a description", () => {
			for (let command of commands) {
				expect(command.usage.length).toBeGreaterThan(0)
				expect(command.description.length).toBeGreaterThan(0)
			}
		})

		it("keeps Command names and aliases unique", () => {
			let seen = new Set<string>()

			for (let command of commands) {
				for (let name of [command.name, ...command.aliases]) {
					expect(seen.has(name)).toBe(false)
					seen.add(name)
				}
			}
		})

		it("parses every documented example", () => {
			for (let command of commands) {
				for (let example of command.examples) {
					let argv = example.command.split(" ").slice(1)

					expect(() => parseArguments(argv)).not.toThrow()
				}
			}
		})
	})

	describe("help", () => {
		let context = {
			palette: createPalette(createTheme(false, true)),
			width: 80,
			version: "1.2.3",
		}

		it("lists every Command in the overview", () => {
			let overview = renderOverview(context)

			for (let command of commands) {
				expect(overview).toContain(command.name)
			}
		})

		it("shows the version in the overview", () => {
			expect(renderOverview(context)).toContain("1.2.3")
		})

		it("documents every Option of a Command", () => {
			let rendered = renderCommandHelp(buildCommand, context)

			for (let option of buildCommand.options) {
				expect(rendered).toContain(`--${option.name}`)
			}
		})

		it("never leaves trailing whitespace on a line", () => {
			for (let line of renderOverview(context).split("\n")) {
				expect(line).toBe(line.trimEnd())
			}

			for (let command of commands) {
				for (let line of renderCommandHelp(command, context).split(
					"\n",
				)) {
					expect(line).toBe(line.trimEnd())
				}
			}
		})

		it("stays inside the given measure", () => {
			for (let line of renderOverview({ ...context, width: 80 }).split(
				"\n",
			)) {
				expect(visibleLength(line)).toBeLessThanOrEqual(88)
			}
		})
	})

	describe("wrap", () => {
		it("breaks text at the given width", () => {
			let lines = wrap("one two three four five six", 11)

			for (let line of lines) {
				expect(line.length).toBeLessThanOrEqual(11)
			}

			expect(lines.join(" ")).toBe("one two three four five six")
		})

		it("returns nothing for empty text", () => {
			expect(wrap("", 20)).toEqual([])
		})
	})

	describe("inputs", () => {
		it("names the output after the input", () => {
			expect(defaultOutputFor("src/App.es")).toBe("src/App.js")
			expect(defaultOutputFor("App.es")).toBe("App.js")
		})

		it("recognises glob patterns", () => {
			expect(looksLikeGlob("src/*.es")).toBe(true)
			expect(looksLikeGlob("src/App.es")).toBe(false)
		})

		it("requires at least one file", async () => {
			await expect(resolveInputFiles([], buildCommand)).rejects.toThrow(
				UsageError,
			)
		})

		it("fails when a pattern matches nothing", async () => {
			await expect(
				resolveInputFiles(["testFiles/*.nothing"], buildCommand),
			).rejects.toThrow(UsageError)
		})

		it("expands a glob", async () => {
			let files = await resolveInputFiles(
				["testFiles/*.es"],
				buildCommand,
			)

			expect(files.length).toBeGreaterThan(1)
			expect(files).toContain("testFiles/HelloWorld.es")
		})

		it("treats --out as a file for a single input", async () => {
			let outputs = await resolveOutputFiles(
				["a.es"],
				"build/app.js",
				buildCommand,
			)

			expect(outputs.get("a.es")).toBe("build/app.js")
		})

		it("treats --out as a directory for several inputs", async () => {
			let outputs = await resolveOutputFiles(
				["src/a.es", "src/b.es"],
				"dist",
				buildCommand,
			)

			expect(outputs.get("src/a.es")).toBe("dist/a.js")
			expect(outputs.get("src/b.es")).toBe("dist/b.js")
		})

		it("treats a trailing separator as a directory", async () => {
			let outputs = await resolveOutputFiles(
				["a.es"],
				"dist/",
				buildCommand,
			)

			expect(outputs.get("a.es")).toBe("dist/a.js")
		})

		// NOTE: Flattening several directories into one output directory can
		// make two sources collide; that has to be an error rather than a
		// silent overwrite.
		it("refuses inputs that would overwrite each other", async () => {
			await expect(
				resolveOutputFiles(
					["one/App.es", "two/App.es"],
					"dist/",
					buildCommand,
				),
			).rejects.toThrow(UsageError)
		})

		it("defaults to writing beside each source", async () => {
			let outputs = await resolveOutputFiles(
				["src/a.es", "other/b.es"],
				undefined,
				buildCommand,
			)

			expect(outputs.get("src/a.es")).toBe("src/a.js")
			expect(outputs.get("other/b.es")).toBe("other/b.js")
		})
	})

	describe("worker dispatch", () => {
		it("stays on the main thread for one small file", () => {
			expect(
				shouldUseWorkers({
					fileCount: 1,
					totalBytes: 400,
					watch: false,
					jobs: undefined,
				}),
			).toBe(false)
		})

		it("uses workers for several files", () => {
			expect(
				shouldUseWorkers({
					fileCount: 4,
					totalBytes: 400,
					watch: false,
					jobs: undefined,
				}),
			).toBe(true)
		})

		// NOTE: A large single file is the case the workers exist for — the
		// Enricher blocks for long enough that the main thread could not draw.
		it("uses a worker for one large file", () => {
			expect(
				shouldUseWorkers({
					fileCount: 1,
					totalBytes: 200_000,
					watch: false,
					jobs: undefined,
				}),
			).toBe(true)
		})

		it("keeps warm workers for a watch session", () => {
			expect(
				shouldUseWorkers({
					fileCount: 1,
					totalBytes: 10,
					watch: true,
					jobs: undefined,
				}),
			).toBe(true)
		})

		it("honours --jobs 1", () => {
			expect(
				shouldUseWorkers({
					fileCount: 40,
					totalBytes: 900_000,
					watch: true,
					jobs: 1,
				}),
			).toBe(false)
		})

		it("never asks for more workers than there are files", () => {
			expect(defaultWorkerCount(1)).toBe(1)
			expect(defaultWorkerCount(2)).toBeLessThanOrEqual(2)
			expect(defaultWorkerCount(1000)).toBeLessThanOrEqual(8)
		})
	})

	describe("formatting", () => {
		it("scales byte counts", () => {
			expect(formatBytes(512)).toBe("512 B")
			expect(formatBytes(2048)).toBe("2.0 kB")
			expect(formatBytes(1_500_000)).toBe("1.50 MB")
		})

		it("keeps durations readable at every scale", () => {
			expect(formatDuration(0.25)).toBe("0.25 ms")
			expect(formatDuration(2.5)).toBe("2.5 ms")
			expect(formatDuration(61.4)).toBe("61 ms")
			expect(formatDuration(1300)).toBe("1.30 s")
		})

		it("pluralises counts", () => {
			expect(pluralise(1, "error")).toBe("1 error")
			expect(pluralise(2, "error")).toBe("2 errors")
		})

		it("counts Diagnostics by severity", () => {
			let counts = countDiagnostics([
				{ severity: "error", message: "a", position: null },
				{ severity: "warning", message: "b", position: null },
				{ severity: "error", message: "c", position: null },
			])

			expect(counts).toEqual({ errors: 2, warnings: 1 })
		})
	})

	describe("colour support", () => {
		let tty = { isTTY: true } as NodeJS.WriteStream
		let pipe = { isTTY: false } as NodeJS.WriteStream

		it("follows the terminal by default", () => {
			expect(supportsColor("auto", tty, {})).toBe(true)
			expect(supportsColor("auto", pipe, {})).toBe(false)
		})

		it("honours NO_COLOR", () => {
			expect(supportsColor("auto", tty, { NO_COLOR: "1" })).toBe(false)
		})

		it("honours FORCE_COLOR", () => {
			expect(supportsColor("auto", pipe, { FORCE_COLOR: "1" })).toBe(true)
			expect(supportsColor("auto", pipe, { FORCE_COLOR: "0" })).toBe(
				false,
			)
		})

		it("treats a dumb terminal as colourless", () => {
			expect(supportsColor("auto", tty, { TERM: "dumb" })).toBe(false)
		})

		// NOTE: An explicit flag is the user's decision and outranks both the
		// environment and the terminal.
		it("lets the flags override everything", () => {
			expect(supportsColor("always", pipe, { NO_COLOR: "1" })).toBe(true)
			expect(supportsColor("never", tty, { FORCE_COLOR: "1" })).toBe(
				false,
			)
		})

		it("maps flags to a choice", () => {
			expect(colorChoiceFor({ color: false, noColor: false })).toBe(
				"auto",
			)
			expect(colorChoiceFor({ color: true, noColor: false })).toBe(
				"always",
			)
			expect(colorChoiceFor({ color: true, noColor: true })).toBe("never")
		})

		it("emits nothing when colour is off", () => {
			let palette = createPalette(createTheme(false, true))

			expect(palette.error("boom")).toBe("boom")
		})

		it("emits escapes when colour is on", () => {
			let palette = createPalette(createTheme(true, true))

			expect(stripAnsi(palette.error("boom"))).toBe("boom")
			expect(palette.error("boom")).not.toBe("boom")
		})

		it("falls back to ASCII symbols without Unicode", () => {
			expect(createTheme(false, false).symbols.success).toBe("+")
			expect(createTheme(false, true).symbols.success).toBe("✔")
		})

		it("reads the locale for Unicode support", () => {
			expect(supportsUnicode({ LANG: "en_US.UTF-8" }, "darwin")).toBe(
				true,
			)
			expect(supportsUnicode({ LANG: "C" }, "darwin")).toBe(false)
		})
	})

	describe("terminal", () => {
		it("treats CI as non-interactive", () => {
			let tty = { isTTY: true } as NodeJS.WriteStream

			expect(isInteractive(tty, {})).toBe(true)
			expect(isInteractive(tty, { CI: "true" })).toBe(false)
		})

		it("leaves short lines alone", () => {
			expect(truncate("hello", 20)).toBe("hello")
		})

		it("truncates by visible width, ignoring escapes", () => {
			let palette = createPalette(createTheme(true, true))
			let truncated = truncate(palette.error("abcdefghij"), 5)

			expect(visibleLength(truncated)).toBeLessThanOrEqual(5)
		})

		// NOTE: A terminal with no known width reports zero columns. Taking
		// that literally would truncate every line down to an ellipsis.
		it("does not truncate when the width is unknown", () => {
			expect(truncate("hello", 0)).toBe("hello")
		})
	})

	describe("JSON report", () => {
		it("flattens Diagnostics to plain positions", () => {
			let report = toJSONReport(
				[
					outcome({
						ok: false,
						diagnostics: [
							{
								severity: "error",
								message: "Broken.",
								code: "unknown-name",
								position: {
									start: { line: 3, column: 5 },
									end: { line: 3, column: 9 },
								},
							},
						],
					}),
				],
				{ command: "check", version: "1.2.3", duration: 20 },
			)

			expect(report.ok).toBe(false)
			expect(report.errors).toBe(1)
			expect(report.warnings).toBe(0)
			expect(report.files[0].diagnostics[0]).toEqual({
				file: "Source.es",
				severity: "error",
				message: "Broken.",
				code: "unknown-name",
				line: 3,
				column: 5,
				endLine: 3,
				endColumn: 9,
			})
		})

		it("reports a Diagnostic without a Position as having none", () => {
			let report = toJSONReport(
				[
					outcome({
						ok: false,
						diagnostics: [
							{
								severity: "error",
								message: "No idea.",
								position: null,
							},
						],
					}),
				],
				{ command: "build", version: "1.2.3", duration: 1 },
			)

			expect(report.files[0].diagnostics[0].line).toBe(null)
			expect(report.files[0].diagnostics[0].code).toBe(null)
		})

		it("keeps stage timings", () => {
			let report = toJSONReport([outcome()], {
				command: "build",
				version: "1.2.3",
				duration: 20,
			})

			expect(report.files[0].stages).toEqual({ parse: 1.5 })
			expect(report.files[0].bytes).toBe(2048)
			expect(report.ok).toBe(true)
		})
	})
})
