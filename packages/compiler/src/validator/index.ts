// NOTE: The Validator checks a typed Program for the mistakes the Enricher's
// Types cannot rule out. This barrel is the phase's name; `./validate` is the
// phase itself.
export { acceptsAllAtRuntime, overlapsAtRuntime, validate } from "./validate"
