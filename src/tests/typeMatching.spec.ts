import { describe, expect, it } from "bun:test"

import { enrich } from "../enricher/index"
import { parse } from "../parser/index"
import { validate } from "../validator/index"

// NOTE: These are end-to-end, because each of these bugs only became visible
// once the Enricher had decided a Type and the Validator had judged it: the
// Type logic in `src/helpers` answered plausibly on its own and wrongly in
// concert.
function errorsFor(source: string) {
	let { program, diagnostics } = enrich(parse(source))

	return [...diagnostics, ...validate(program)].filter(
		(diagnostic) => diagnostic.severity === "error",
	)
}

describe("Type matching", () => {
	describe("Union building", () => {
		// NOTE: An empty List Literal is typed `List<Unknown>`, which is a
		// wildcard in BOTH directions — it accepts `List<Integer>` and is
		// accepted by it — so Union building saw the two subsume one another
		// and kept whichever came first. Written `[[], [1]]` the Literal
		// therefore inferred `List<List<Unknown>>`, a Type that fits EVERY
		// List Type, and the annotation below was accepted for a List of
		// Integers while the same Literal spelled `[[1], []]` was rejected.
		it("should not let an empty List Literal erase the Type beside it", () => {
			let errors = errorsFor(`implementation {
				constant broken: List<List<String>> = [[], [1]]
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("assignment-type-mismatch")
		})

		it("should reject the same Literal whichever order it is written in", () => {
			let errors = errorsFor(`implementation {
				constant reversed: List<List<String>> = [[1], []]
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("assignment-type-mismatch")
		})

		// NOTE: The placeholder losing the Union costs an empty List Literal
		// nothing — it still fits every List Type, in a Literal, an annotation
		// or an Argument.
		it("should keep an empty List Literal assignable everywhere", () => {
			expect(
				errorsFor(`implementation {
					constant nested: List<List<String>> = [[], ["a"]]
					constant integers: List<List<Integer>> = [[], [1]]
					constant empty: List<String> = []
					constant onlyEmpties: List<List<String>> = [[], []]
					__print(nested::length()::toString())
					__print(integers::length()::toString())
					__print(empty::length()::toString())
					__print(onlyEmpties::length()::toString())
				}`),
			).toEqual([])
		})
	})

	describe("Union member inference", () => {
		// NOTE: Matching the Argument against the first member binds
		// `T := String` off `left` and THEN fails on `right`. That binding is
		// worth no more than the member that made it, but it used to survive
		// the failure, so the second member — which matches on its own with
		// `T := Integer` — was checked against the leftover `T := String` and
		// wrongly rejected. Which of the two spellings compiled came down to
		// the order the Union was written in.
		it("should try each Union member from a clean set of bindings", () => {
			expect(
				errorsFor(`implementation {
					function pick <infer T>(_ value: { left: T, right: String } | { left: String, right: T }) -> Nothing {
						<- nothing
					}

					constant used = pick({ left = "hi", right = 5 })
				}`),
			).toEqual([])
		})

		it("should accept the same call with the members written the other way round", () => {
			expect(
				errorsFor(`implementation {
					function pick <infer T>(_ value: { left: String, right: T } | { left: T, right: String }) -> Nothing {
						<- nothing
					}

					constant used = pick({ left = "hi", right = 5 })
				}`),
			).toEqual([])
		})

		it("should still reject an Argument no member accepts", () => {
			let errors = errorsFor(`implementation {
				function pick <infer T>(_ value: { left: T, right: String } | { left: String, right: T }) -> Nothing {
					<- nothing
				}

				constant used = pick({ left = 1, right = 5 })
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("argument-type-mismatch")
		})
	})

	describe("Argument matching order", () => {
		// NOTE: An unannotated Function literal is typed FROM the Parameter it
		// is passed to. Matched while `T` was still open it echoed `T` itself
		// back, which pinned the Generic to its own name — from then on it was
		// opaque, `to 5` could no longer bind it, and this valid Program was
		// rejected with `argument-type-mismatch` while `result` was recorded
		// as a `T` that exists in no scope the caller can see.
		it("should infer a Generic from the Argument that follows a callback", () => {
			expect(
				errorsFor(`implementation {
					function apply <infer T>(transform fn: (_: T) -> T, to value: T) -> T {
						<- fn(value)
					}

					constant result: Integer = apply(transform (x) { <- x }, to 5)
					__print(result::toString())
				}`),
			).toEqual([])
		})

		// NOTE: The callback is resolved against the BOUND signature, so its
		// Parameter carries the Type the Argument named — which is what lets
		// the body call an Integer Method on it at all.
		it("should hand the callback the Type the other Argument bound", () => {
			expect(
				errorsFor(`implementation {
					function apply <infer T>(transform fn: (_: T) -> T, to value: T) -> T {
						<- fn(value)
					}

					constant result: Integer = apply(transform (x) { <- x::add(1) }, to 5)
					__print(result::toString())
				}`),
			).toEqual([])
		})

		// NOTE: Resolved against the bound `(_: Integer) -> Integer`, a body
		// answering with a String is a return-Type mismatch INSIDE the lambda
		// — the Diagnostic points at the answer that does not fit rather than
		// at the whole Argument.
		it("should still reject a callback that disagrees with the binding", () => {
			let errors = errorsFor(`implementation {
				function apply <infer T>(transform fn: (_: T) -> T, to value: T) -> T {
					<- fn(value)
				}

				constant result = apply(transform (x) { <- x::toString() }, to 5)
			}`)

			expect(errors).toHaveLength(1)
			expect(errors[0].code).toBe("return-type-mismatch")
		})

		// NOTE: A callback that is the ONLY source of a binding still binds it
		// — `map`'s transform names `Result` in its return Type and nowhere
		// else, and deferring it changes nothing about that.
		it("should still bind a Generic a callback alone can name", () => {
			expect(
				errorsFor(`implementation {
					constant lengths: List<Integer> = ["a", "bb"]::map((word) { <- word::length() })
					__print(lengths::length()::toString())
				}`),
			).toEqual([])
		})
	})
})
