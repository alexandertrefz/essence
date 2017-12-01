import { common } from "../interfaces"
import rewriteToJS from "./js"

type RewriterMode = "js"

export async function rewrite(nodes: Array<common.typedSimple.Node>, mode: RewriterMode): Promise<string> {
	if (mode === "js") {
		return rewriteToJS(nodes)
	} else {
		throw new Error("Unknown Rewrite-Mode")
	}
}
