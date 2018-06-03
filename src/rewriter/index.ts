import { common } from "../interfaces"
import rewriteToJS from "./js"

type RewriterMode = "js"

export async function rewrite(program: common.typedSimple.Program, mode: RewriterMode): Promise<string> {
	if (mode === "js") {
		return rewriteToJS(program)
	} else {
		throw new Error("Unknown Rewrite-Mode")
	}
}
