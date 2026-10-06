import type { common, enricher } from "@essence-lang/interfaces"

import { collectDiagnostics } from "../diagnostics/index"
import { collectReachedNames, solveConformance } from "./resolvers"
import { childScope } from "./scope"
import { type ForeignChoice, importedChoiceTypes } from "./spelling"

// Whether a culprit conforms once each Choice its spelling names is imported,
// asked of a Scope that binds them as the imports would. `Light | Integer`
// derives no equality even then, where `List<Light>` does. Where no link
// answers, the import is taken to bring the derive. The names the question
// reaches are kept from the unused-import check, since the file reaches none.
export function derivesWithImports(
	culprit: common.Type,
	protocolName: string,
	foreigns: Array<ForeignChoice>,
	scope: enricher.Scope,
	position: common.Position,
): boolean {
	let types = importedChoiceTypes(foreigns, scope)

	return (
		types === null ||
		collectReachedNames(() =>
			collectDiagnostics(() =>
				solveConformance(
					culprit,
					protocolName,
					childScope(scope, { types }),
					position,
				),
			),
		).result.result.ok
	)
}
