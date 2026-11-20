/*
 * Decisions that are visible in the code an agent changed, found by rules
 * (no model). Each one is something the owner would likely want to know about
 * but that an agent usually does without asking.
 */

export interface CodeDecision {
	rule: string;
	category: string;
	title: string;
	statement: string;
	evidence: string;
}

interface EditInput {
	filePath: string;
	tool: string;
	before: string | null;
	after: string;
}

/** Lines present after the edit but not before, and the reverse. */
export function changedLines(before: string | null, after: string) {
	const count = (text: string) => {
		const map = new Map<string, number>();

		for (const line of text.split("\n"))
			map.set(line, (map.get(line) ?? 0) + 1);
		return map;
	};

	const diff = (from: Map<string, number>, to: Map<string, number>) => {
		const lines: string[] = [];

		for (const [line, n] of to)
			for (let i = from.get(line) ?? 0; i < n; i += 1)
				if (line.trim()) lines.push(line);
		return lines;
	};

	const old = count(before ?? "");
	const next = count(after);

	return {
		added: diff(old, next),
		removed: before === null ? [] : diff(next, old),
	};
}

const isTest = (path: string) =>
	/(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|test_[^/]+\.py$/i.test(
		path,
	);

const show = (sign: string, lines: string[]) =>
	lines
		.slice(0, 12)
		.map((line) => `${sign} ${line.trimEnd()}`)
		.join("\n");

const base = (path: string) => path.split("/").at(-1) ?? path;

export function detectCodeDecisions(edit: EditInput): CodeDecision[] {
	const { added, removed } = changedLines(edit.before, edit.after);
	const path = edit.filePath;
	const found: CodeDecision[] = [];

	// 1. New dependencies.
	if (/(^|\/)package\.json$/.test(path)) {
		const names = (lines: string[]) =>
			lines
				.map(
					(line) =>
						/^\s*"(@?[\w./-]+)"\s*:\s*"[\^~>=<*\d]/.exec(line)?.[1],
				)
				.filter(
					(name): name is string =>
						Boolean(name) &&
						!["version", "node", "npm", "pnpm"].includes(name!),
				);

		const gone = new Set(names(removed));
		const fresh = names(added).filter((name) => !gone.has(name));

		if (fresh.length)
			found.push({
				rule: "dependency",
				category: "Dependency",
				title: `Added ${fresh.length === 1 ? "dependency" : "dependencies"} ${fresh.slice(0, 4).join(", ")}`,
				statement: `The project now depends on ${fresh.join(", ")}.`,
				evidence: show(
					"+",
					added.filter((line) =>
						fresh.some((name) => line.includes(`"${name}"`)),
					),
				),
			});
	} else if (
		/(^|\/)(requirements[^/]*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile)$/.test(
			path,
		) &&
		added.length
	)
		found.push({
			rule: "dependency",
			category: "Dependency",
			title: `Changed dependencies in ${base(path)}`,
			statement: `Dependencies in ${path} changed.`,
			evidence: show("+", added),
		});

	// 2. Tests switched off or removed.
	const skips = added.filter((line) =>
		/\b(it|test|describe)\.(skip|todo)\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.(skip|xfail)|@unittest\.skip|\bt\.Skip\(|#\[ignore\]/.test(
			line,
		),
	);

	if (skips.length)
		found.push({
			rule: "test-skipped",
			category: "Tests",
			title: `Skipped ${skips.length === 1 ? "a test" : skips.length + " tests"} in ${base(path)}`,
			statement: `${skips.length === 1 ? "A test was" : "Tests were"} marked to be skipped, so ${skips.length === 1 ? "it no longer runs" : "they no longer run"}.`,
			evidence: show("+", skips),
		});

	if (isTest(path)) {
		const cases = (lines: string[]) =>
			lines.filter((line) =>
				/\b(it|test)(\.\w+)?\s*\(\s*["'`]|\bdef test_\w+|\bfunc Test\w+/.test(
					line,
				),
			);

		const lost = cases(removed).length - cases(added).length;

		if (lost > 0)
			found.push({
				rule: "test-removed",
				category: "Tests",
				title: `Removed ${lost === 1 ? "a test" : lost + " tests"} from ${base(path)}`,
				statement: `${lost} test ${lost === 1 ? "case was" : "cases were"} removed and not replaced.`,
				evidence: show("-", cases(removed)),
			});
	}

	// 3. Checks turned off.
	const off = added.filter((line) =>
		/eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|#\s*noqa|#\s*type:\s*ignore|--no-verify|nolint|rubocop:disable|\/\/\s*nosec/.test(
			line,
		),
	);

	if (off.length)
		found.push({
			rule: "check-disabled",
			category: "Checks",
			title: `Turned off a check in ${base(path)}`,
			statement:
				"A lint, type or safety check was switched off for this code instead of fixing what it flagged.",
			evidence: show("+", off),
		});

	// 4. Database schema.
	if (
		/(^|\/)(migrations?|drizzle|prisma\/migrations|alembic\/versions)\//i.test(
			path,
		) &&
		(edit.tool === "Write" || added.length)
	) {
		const destructive = added.filter((line) =>
			/\bDROP\s+(TABLE|COLUMN|INDEX)|\bTRUNCATE\b|\bDELETE\s+FROM\b/i.test(
				line,
			),
		);

		found.push({
			rule: "migration",
			category: "Database",
			title: destructive.length
				? `Migration removes data or schema in ${base(path)}`
				: `Changed the database schema in ${base(path)}`,
			statement: destructive.length
				? "A database migration drops or deletes something. This is hard to undo once it runs."
				: "A database migration was added or changed.",
			evidence: show(
				"+",
				destructive.length
					? destructive
					: added.filter((line) =>
							/\b(CREATE|ALTER|DROP|ADD)\b/i.test(line),
						),
			),
		});
	}

	// 5. CI and deploy.
	if (
		/(^|\/)\.github\/workflows\/|(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|\.gitlab-ci\.yml|vercel\.json|fly\.toml|wrangler\.(toml|jsonc?))$/.test(
			path,
		) &&
		(added.length || removed.length)
	)
		found.push({
			rule: "pipeline",
			category: "CI and deploy",
			title: `Changed build or deploy setup in ${base(path)}`,
			statement: `How the project is built, tested or deployed changed in ${path}.`,
			evidence: [
				show("-", removed.slice(0, 6)),
				show("+", added.slice(0, 6)),
			]
				.filter(Boolean)
				.join("\n"),
		});

	return found;
}
