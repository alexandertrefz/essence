import { settingEdits } from "@essence-lang/compiler/configuration"
import type { common } from "@essence-lang/interfaces"

import { overlaps } from "./geometry"
import type { CodeActionEntry } from "./index"

// The one request a project file answers. The Server refuses every other
// request over `essence.json`, but its Diagnostics name fixes, which the
// compiler's reader computes through `settingEdits`.
export function projectFileActions(
	sourceText: string,
	filePath: string,
	range: common.Position,
): Array<CodeActionEntry> {
	return settingEdits(sourceText, filePath)
		.filter((edit) => overlaps(edit.position, range))
		.map((edit) => ({
			// Double quotes, as the setting is written in the file.
			title:
				edit.code === "unknown-setting"
					? `Change to "${edit.setting}"`
					: `Move it to "${edit.setting}"`,
			kind: "quickfix" as const,
			diagnosticCode: edit.code,
			diagnosticPosition: edit.position,
			// Each is its Diagnostic's one answer: a near miss is renamed, and
			// a moved key has one destination, unless that is already written.
			isPreferred: true,
			edits: [{ range: edit.range, newText: edit.newText }],
		}))
}
