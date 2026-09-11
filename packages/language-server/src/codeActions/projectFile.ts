import { settingEdits } from "@essence-lang/compiler/configuration"
import type { common } from "@essence-lang/interfaces"

import { overlaps } from "./geometry"
import type { CodeActionEntry } from "./index"

// NOTE: The one request a project file answers. `essence.json` reaches this
// Server because the extension's document selector names it — that is what puts
// a mistake in it in the Problems panel — and every request over it is refused,
// because a project file is not a source and nothing that answers about a
// Program can say anything true about one.
//
// A Diagnostic with a Quick Fix and no lightbulb is a squiggle that names its
// own answer and will not apply it, so this door is open and the others stay
// shut. What is offered is computed by the Compiler's own reader: which settings
// exist, which have moved, and how a JSONC document is edited are all things the
// format's reader knows and this file deliberately does not.
export function projectFileActions(
	sourceText: string,
	filePath: string,
	range: common.Position,
): Array<CodeActionEntry> {
	return settingEdits(sourceText, filePath)
		.filter((edit) => overlaps(edit.position, range))
		.map((edit) => ({
			// NOTE: The setting is named in double quotes, which is how it is
			// written in the file the action is offered on.
			title:
				edit.code === "unknown-setting"
					? `Change to "${edit.setting}"`
					: `Move it to "${edit.setting}"`,
			kind: "quickfix" as const,
			diagnosticCode: edit.code,
			diagnosticPosition: edit.position,
			// NOTE: Both are the one right answer their Diagnostic has. A near
			// miss is a rename and the value stays the author's; a key that has
			// moved has exactly one place it moved to, and the move is withheld
			// outright where that place is already written.
			isPreferred: true,
			edits: [{ range: edit.range, newText: edit.newText }],
		}))
}
