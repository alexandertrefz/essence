import { essenceBun } from "@essence-lang/client/bun-plugin"
import { plugin } from "bun"

// NOTE: One registration for the process. `root` pins the project directory
// whatever the working directory is; `declarations` writes `Pricing.d.es.ts`
// beside the source, which is what the editor and `tsc` read the import's
// Types from.
plugin(essenceBun({ root: import.meta.dirname, declarations: true }))
