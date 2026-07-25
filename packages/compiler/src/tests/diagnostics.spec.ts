import { describe, expect, it } from "bun:test"

import {
	collectDiagnostics,
	containsErrors,
	report,
	placelessDiagnostic,
	primary,
	reportError,
	reportWarning,
} from "../diagnostics/index"
import type { common } from "../interfaces/index"

const position: common.Position = {
	start: { line: 1, column: 1 },
	end: { line: 1, column: 10 },
}

const otherPosition: common.Position = {
	start: { line: 2, column: 1 },
	end: { line: 2, column: 10 },
}

describe("Diagnostics", () => {
	it("should collect reported Diagnostics", () => {
		let { diagnostics } = collectDiagnostics(() => {
			reportError("Some Error.", position, {
				code: "internal-error",
				labels: [primary(position, "here")],
			})
			reportWarning("Some Warning.", otherPosition, {
				code: "internal-error",
				labels: [primary(otherPosition, "here")],
			})
		})

		expect(diagnostics).toEqual([
			{
				severity: "error",
				message: "Some Error.",
				position,
				code: "internal-error",
				labels: [primary(position, "here")],
				notes: [],
				helps: [],
			},
			{
				severity: "warning",
				message: "Some Warning.",
				position: otherPosition,
				code: "internal-error",
				labels: [primary(otherPosition, "here")],
				notes: [],
				helps: [],
			},
		])
	})

	it("should return the result of the collected work", () => {
		let { result } = collectDiagnostics(() => 42)

		expect(result).toBe(42)
	})

	it("should deduplicate identical Diagnostics", () => {
		let { diagnostics } = collectDiagnostics(() => {
			reportError("Some Error.", position, {
				code: "internal-error",
				labels: [primary(position, "here")],
			})
			reportError("Some Error.", position, {
				code: "internal-error",
				labels: [primary(position, "here")],
			})
		})

		expect(diagnostics).toHaveLength(1)
	})

	it("should not deduplicate Diagnostics with differing positions", () => {
		let { diagnostics } = collectDiagnostics(() => {
			reportError("Some Error.", position, {
				code: "internal-error",
				labels: [primary(position, "here")],
			})
			reportError("Some Error.", otherPosition, {
				code: "internal-error",
				labels: [primary(otherPosition, "here")],
			})
		})

		expect(diagnostics).toHaveLength(2)
	})

	it("should not deduplicate Diagnostics with differing severities", () => {
		let { diagnostics } = collectDiagnostics(() => {
			reportError("Some Message.", position, {
				code: "internal-error",
				labels: [primary(position, "here")],
			})
			reportWarning("Some Message.", position, {
				code: "internal-error",
				labels: [primary(position, "here")],
			})
		})

		expect(diagnostics).toHaveLength(2)
	})

	it("should not leak Diagnostics of nested collections", () => {
		let innerDiagnostics: Array<common.Diagnostic> = []

		let { diagnostics } = collectDiagnostics(() => {
			reportError("Outer Error.", position, {
				code: "internal-error",
				labels: [primary(position, "here")],
			})

			innerDiagnostics = collectDiagnostics(() => {
				reportError("Inner Error.", otherPosition, {
					code: "internal-error",
					labels: [primary(otherPosition, "here")],
				})
			}).diagnostics
		})

		expect(innerDiagnostics).toHaveLength(1)
		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].message).toBe("Outer Error.")
	})

	it("should allow committing Diagnostics of nested collections", () => {
		let { diagnostics } = collectDiagnostics(() => {
			let inner = collectDiagnostics(() => {
				reportError("Inner Error.", position, {
					code: "internal-error",
					labels: [primary(position, "here")],
				})
			})

			for (let diagnostic of inner.diagnostics) {
				report(diagnostic)
			}
		})

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].message).toBe("Inner Error.")
	})

	it("should restore the outer collection when the work throws", () => {
		let { diagnostics } = collectDiagnostics(() => {
			try {
				collectDiagnostics(() => {
					throw new Error("Boom")
				})
			} catch {}

			reportError("Outer Error.", position, {
				code: "internal-error",
				labels: [primary(position, "here")],
			})
		})

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].message).toBe("Outer Error.")
	})

	describe("containsErrors", () => {
		it("should detect errors", () => {
			expect(
				containsErrors([
					placelessDiagnostic("warning", "", "internal-error"),
					placelessDiagnostic("error", "", "internal-error"),
				]),
			).toBe(true)
		})

		it("should not report warnings as errors", () => {
			expect(
				containsErrors([
					placelessDiagnostic("warning", "", "internal-error"),
				]),
			).toBe(false)
			expect(containsErrors([])).toBe(false)
		})
	})
})
