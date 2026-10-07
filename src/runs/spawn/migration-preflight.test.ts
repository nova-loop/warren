import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn, SpawnResult } from "../../projects/clone.ts";
import { MigrationPreflightError } from "../errors.ts";
import {
	findCollisions,
	healMigrationJournalCollisions,
	type MigrationHealInput,
	snapshotFileName,
} from "./migration-preflight.ts";

/**
 * warren-1f03: dispatch-time drizzle migration preflight. Detection compares
 * the branch's journal entries against fresh main's; a branch migration whose
 * index/tag also exists on main with different content is a collision, healed
 * prompt-free (delete colliding artifacts, re-run `bun run db:generate`,
 * commit on the host clone branch).
 */

const SQLITE_DIR = "src/db/migrations";
const SQLITE_JOURNAL = `${SQLITE_DIR}/meta/_journal.json`;

interface SpawnCall {
	readonly cmd: readonly string[];
	readonly cwd: string;
}

function makeSpawn(
	mainJournal: unknown | null,
	journals: readonly string[] = [SQLITE_JOURNAL],
): { spawn: SpawnFn; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const spawn: SpawnFn = async (cmd, opts): Promise<SpawnResult> => {
		calls.push({ cmd, cwd: opts.cwd });
		const joined = cmd.join(" ");
		if (joined.includes("ls-files")) {
			return { stdout: `${journals.join("\n")}\n`, stderr: "", exitCode: 0 };
		}
		if (joined.includes("show") && joined.includes(SQLITE_JOURNAL)) {
			if (mainJournal === null) {
				return { stdout: "", stderr: "does not exist", exitCode: 128 };
			}
			return { stdout: JSON.stringify(mainJournal), stderr: "", exitCode: 0 };
		}
		if (joined.includes("show")) {
			return { stdout: "-- sql from main\n", stderr: "", exitCode: 0 };
		}
		if (joined.includes("rev-parse")) {
			return { stdout: "deadbeef".repeat(5), stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	return { spawn, calls };
}

function journal(entries: { idx: number; tag: string }[]): unknown {
	return {
		version: "7",
		dialect: "sqlite",
		entries: entries.map((e) => ({ ...e, version: "6", when: 1, breakpoints: true })),
	};
}

async function seedBranchTree(
	root: string,
	entries: { idx: number; tag: string }[],
): Promise<void> {
	await mkdir(join(root, SQLITE_DIR, "meta"), { recursive: true });
	await writeFile(join(root, SQLITE_JOURNAL), JSON.stringify(journal(entries)));
	for (const entry of entries) {
		await writeFile(join(root, SQLITE_DIR, `${entry.tag}.sql`), `-- ${entry.tag}\n`);
		// drizzle-kit's real layout: snapshots are named by idx, not tag.
		await writeFile(
			join(root, SQLITE_DIR, "meta", snapshotFileName(entry.idx)),
			JSON.stringify({ tag: entry.tag }),
		);
	}
}

describe("findCollisions (warren-1f03)", () => {
	test("flags a branch entry whose idx exists on main with a different tag", () => {
		const found = findCollisions(
			SQLITE_DIR,
			[{ idx: 46, tag: "0046_branch" }],
			[{ idx: 46, tag: "0046_main" }],
		);
		expect(found).toEqual([
			{ migrationsDir: SQLITE_DIR, idx: 46, branchTag: "0046_branch", mainTag: "0046_main" },
		]);
	});

	test("passes a branch entry at a slot past main's tip", () => {
		const found = findCollisions(
			SQLITE_DIR,
			[{ idx: 47, tag: "0047_branch" }],
			[{ idx: 46, tag: "0046_main" }],
		);
		expect(found).toEqual([]);
	});
});

describe("healMigrationJournalCollisions (warren-1f03)", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "warren-1f03-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function input(spawn: SpawnFn): MigrationHealInput {
		return {
			spawn,
			projectPath: root,
			defaultBranch: "main",
			baseRef: "burrow/run_xxx",
			env: {},
		};
	}

	test("no migrations on the branch is a no-op (no generate, no commit)", async () => {
		// The branch tracks no drizzle journal at all.
		const { spawn, calls } = makeSpawn(null, []);

		const outcome = await healMigrationJournalCollisions(input(spawn));

		expect(outcome).toEqual({ collisions: [], commitSha: null });
		expect(calls.some((c) => c.cmd.join(" ").includes("db:generate"))).toBe(false);
		expect(calls.some((c) => c.cmd.join(" ").includes("commit"))).toBe(false);
	});

	test("a branch migration at a free slot past main's tip is a no-op", async () => {
		await seedBranchTree(root, [
			{ idx: 45, tag: "0045_main" },
			{ idx: 46, tag: "0046_branch" },
		]);
		const { spawn, calls } = makeSpawn(journal([{ idx: 45, tag: "0045_main" }]));

		const outcome = await healMigrationJournalCollisions(input(spawn));

		expect(outcome).toEqual({ collisions: [], commitSha: null });
		expect(calls.some((c) => c.cmd.join(" ").includes("db:generate"))).toBe(false);
		// The branch's migration artifacts survive untouched.
		expect(await Bun.file(join(root, SQLITE_DIR, "0046_branch.sql")).exists()).toBe(true);
	});

	test("a colliding slot is healed: artifacts deleted, journal re-synced, regenerated, committed", async () => {
		await seedBranchTree(root, [
			{ idx: 45, tag: "0045_main" },
			{ idx: 46, tag: "0046_branch" },
		]);
		const { spawn, calls } = makeSpawn(
			journal([
				{ idx: 45, tag: "0045_main" },
				{ idx: 46, tag: "0046_main" },
			]),
		);

		const outcome = await healMigrationJournalCollisions(input(spawn));

		expect(outcome.collisions).toEqual([
			{ migrationsDir: SQLITE_DIR, idx: 46, branchTag: "0046_branch", mainTag: "0046_main" },
		]);
		expect(outcome.commitSha).toBe("deadbeef".repeat(5));
		// Colliding artifacts are gone.
		expect(await Bun.file(join(root, SQLITE_DIR, "0046_branch.sql")).exists()).toBe(false);
		// The branch's slot-46 snapshot is replaced by main's, restored via git show.
		expect(await readFile(join(root, SQLITE_DIR, "meta", "0046_snapshot.json"), "utf8")).toBe(
			"-- sql from main\n",
		);
		expect(
			calls.some(
				(c) => c.cmd.join(" ") === `git show origin/main:${SQLITE_DIR}/meta/0046_snapshot.json`,
			),
		).toBe(true);
		// The journal is re-synced to main's entries.
		const healed = JSON.parse(await readFile(join(root, SQLITE_JOURNAL), "utf8")) as {
			entries: { idx: number; tag: string }[];
		};
		expect(healed.entries.map((e) => e.tag)).toEqual(["0045_main", "0046_main"]);
		// Regeneration ran before the heal commit.
		const joined = calls.map((c) => c.cmd.join(" "));
		const generateAt = joined.findIndex((c) => c.includes("db:generate"));
		const commitAt = joined.findIndex((c) => c.includes("commit"));
		expect(generateAt).toBeGreaterThanOrEqual(0);
		expect(commitAt).toBeGreaterThan(generateAt);
		// The commit is authored by the canonical warren bot identity.
		const commitCmd = calls[commitAt]?.cmd.join(" ") ?? "";
		expect(commitCmd).toContain("user.name=warren");
		expect(commitCmd).toContain("user.email=bot@warren.invalid");
	});

	test("a failed regeneration aborts with a clear error and no commit", async () => {
		await seedBranchTree(root, [
			{ idx: 45, tag: "0045_main" },
			{ idx: 46, tag: "0046_branch" },
		]);
		const { spawn, calls } = makeSpawn(
			journal([
				{ idx: 45, tag: "0045_main" },
				{ idx: 46, tag: "0046_main" },
			]),
		);
		const failing: SpawnFn = async (cmd, opts) => {
			if (cmd.join(" ").includes("db:generate")) {
				return { stdout: "", stderr: "drizzle-kit exploded", exitCode: 1 };
			}
			return spawn(cmd, opts);
		};

		const err = await healMigrationJournalCollisions(input(failing)).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(MigrationPreflightError);
		expect((err as MigrationPreflightError).message).toMatch(/drizzle-kit exploded/);
		expect(calls.some((c) => c.cmd.join(" ").includes("commit"))).toBe(false);
	});

	test("#1301: main-side files are restored by drizzle's idx-named snapshot path", async () => {
		// The branch was cut at slot 44 and added its own 0045; main landed 0045 and 0046.
		await seedBranchTree(root, [
			{ idx: 44, tag: "0044_base" },
			{ idx: 45, tag: "0045_branch" },
		]);
		const mainEntries = [
			{ idx: 44, tag: "0044_base" },
			{ idx: 45, tag: "0045_main" },
			{ idx: 46, tag: "0046_main" },
		];
		// A git that, like the real one, only knows the paths main actually tracks.
		const onMain = new Set(
			mainEntries.flatMap((e) => [
				`${SQLITE_DIR}/${e.tag}.sql`,
				`${SQLITE_DIR}/meta/${snapshotFileName(e.idx)}`,
			]),
		);
		const { spawn: base, calls } = makeSpawn(journal(mainEntries));
		const strict: SpawnFn = async (cmd, opts) => {
			const joined = cmd.join(" ");
			const showPath = joined.match(/^git show origin\/main:(.+)$/)?.[1];
			if (showPath !== undefined && showPath !== SQLITE_JOURNAL && !onMain.has(showPath)) {
				calls.push({ cmd, cwd: opts.cwd });
				return { stdout: "", stderr: `fatal: path '${showPath}' does not exist`, exitCode: 128 };
			}
			return base(cmd, opts);
		};

		const outcome = await healMigrationJournalCollisions(input(strict));

		expect(outcome.collisions.map((c) => c.branchTag)).toEqual(["0045_branch"]);
		expect(outcome.commitSha).toBe("deadbeef".repeat(5));
		for (const name of ["0045_main.sql", "0046_main.sql"]) {
			expect(await Bun.file(join(root, SQLITE_DIR, name)).exists()).toBe(true);
		}
		for (const name of ["0045_snapshot.json", "0046_snapshot.json"]) {
			expect(await readFile(join(root, SQLITE_DIR, "meta", name), "utf8")).toBe(
				"-- sql from main\n",
			);
		}
		// The branch's own artifacts for the colliding slot are gone.
		expect(await Bun.file(join(root, SQLITE_DIR, "0045_branch.sql")).exists()).toBe(false);
		// The shared base slot was already present and is left untouched.
		expect(await readFile(join(root, SQLITE_DIR, "meta", "0044_snapshot.json"), "utf8")).toBe(
			JSON.stringify({ tag: "0044_base" }),
		);
	});
});
