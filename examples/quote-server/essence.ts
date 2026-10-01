import { essenceBun } from "@essence-lang/client/bun-plugin"
import { plugin } from "bun"

// One registration for the process. `root` pins the project directory, and
// `declarations` writes `Pricing.d.es.ts`, which the editor and `tsc` read.
plugin(essenceBun({ root: import.meta.dirname, declarations: true }))
