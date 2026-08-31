// NOTE: The Simplifier lowers a typed Program to the smaller shape the Rewriter
// emits from. This barrel is the phase's name; `./simplify` is the phase itself.
export { simplify, type SimplifyOptions } from "./simplify"
