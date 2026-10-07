/**
 * Errors specific to the run-spawn / composition flow (docs/design/agent-composition.md).
 *
 * `RunSpawnError` covers anything that goes wrong between "we have an
 * agent + project" and "we have a dispatched burrow run" that isn't
 * already a `BurrowError` (server envelope), `BurrowUnreachableError`
 * (transport), `NotFoundError` (missing agent/project), or
 * `ValidationError` (caller passed bad input). Examples: malformed
 * cached agent JSON, broken `expertise_seed` line, filesystem write
 * failure while seeding the burrow workspace.
 */

import { WarrenError } from "../core/errors.ts";

export class RunSpawnError extends WarrenError {
	readonly code = "run_spawn_error";
}

/**
 * A git or regeneration step inside the dispatch-time migration preflight
 * (`src/runs/spawn/migration-preflight.ts`) failed. The branch's migration
 * state conflicts with main and could not be healed automatically; the
 * request itself is fine, so it maps to HTTP 409 at the server boundary.
 */
export class MigrationPreflightError extends WarrenError {
	readonly code = "migration_preflight_failed";

	constructor(message: string) {
		super(message, {
			recoveryHint:
				"the preflight could not check or heal the branch's drizzle migration journal against the " +
				"default branch; rebase the branch onto it and regenerate its migrations, then re-dispatch",
		});
		this.name = "MigrationPreflightError";
	}
}
