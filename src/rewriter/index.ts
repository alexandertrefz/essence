import { common } from "../interfaces"
import rewriteToJS from "./js"

type RewriterMode = "js"

export const rewrite = (nodes: [common.typedSimple.Node], mode: RewriterMode): string => {
	if (mode === "js") {
		return rewriteToJS(nodes)
	} else {
		throw new Error("Unknown Rewrite-Mode")
	}
}
