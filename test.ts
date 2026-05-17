import { execSync } from "node:child_process";

interface TestCase {
	name: string;
	cmd: string | (() => string);
	assert: (output: string) => { ok: true } | { ok: false; reason: string };
	skipIf?: () => string | null;
}

function extractJsonFromOutput(out: string): string {
	const match = out.match(/\{[\s\S]*\}/);
	return match ? match[0] : "{}";
}

const TESTS: TestCase[] = [
	{
		name: "notionWhoAmI",
		cmd: `ntn workers exec notionWhoAmI --local -d '{}'`,
		assert: (out) => {
			try {
				const parsed = JSON.parse(extractJsonFromOutput(out)) as unknown;
				if (typeof parsed !== "object" || parsed === null) {
					return { ok: false, reason: "output is not an object" };
				}
				const obj = parsed as Record<string, unknown>;
				if (typeof obj.id !== "string") {
					return { ok: false, reason: "missing id field or not a string" };
				}
				if (!("workspaceName" in obj)) {
					return { ok: false, reason: "missing workspaceName field" };
				}
				return { ok: true };
			} catch (e) {
				return { ok: false, reason: `parse failed: ${e instanceof Error ? e.message : String(e)}` };
			}
		},
	},
	{
		name: "pingClaude",
		cmd: `ntn workers exec pingClaude --local -d '{"prompt": "respond with exactly: hivemind"}'`,
		assert: (out) => {
			try {
				const parsed = JSON.parse(extractJsonFromOutput(out)) as unknown;
				if (typeof parsed !== "object" || parsed === null) {
					return { ok: false, reason: "output is not an object" };
				}
				const obj = parsed as Record<string, unknown>;
				if (typeof obj.text !== "string") {
					return { ok: false, reason: "missing text field or not a string" };
				}
				if (!obj.text.toLowerCase().includes("hivemind")) {
					return { ok: false, reason: `text does not contain "hivemind": ${obj.text.slice(0, 100)}` };
				}
				return { ok: true };
			} catch (e) {
				return { ok: false, reason: `parse failed: ${e instanceof Error ? e.message : String(e)}` };
			}
		},
	},
	{
		name: "classifyBrief — writing",
		cmd: `ntn workers exec classifyBrief --local -d '{"title": "Write a 500-word post about useEffect", "body": null}'`,
		assert: (out) => {
			try {
				const parsed = JSON.parse(extractJsonFromOutput(out)) as unknown;
				if (typeof parsed !== "object" || parsed === null) {
					return { ok: false, reason: "output is not an object" };
				}
				const obj = parsed as Record<string, unknown>;
				if (obj.category !== "writing") {
					return { ok: false, reason: `expected category "writing", got "${obj.category}"` };
				}
				return { ok: true };
			} catch (e) {
				return { ok: false, reason: `parse failed: ${e instanceof Error ? e.message : String(e)}` };
			}
		},
	},
	{
		name: "classifyBrief — quick",
		cmd: `ntn workers exec classifyBrief --local -d '{"title": "Fix a typo in README", "body": null}'`,
		assert: (out) => {
			try {
				const parsed = JSON.parse(extractJsonFromOutput(out)) as unknown;
				if (typeof parsed !== "object" || parsed === null) {
					return { ok: false, reason: "output is not an object" };
				}
				const obj = parsed as Record<string, unknown>;
				if (obj.category !== "quick") {
					return { ok: false, reason: `expected category "quick", got "${obj.category}"` };
				}
				return { ok: true };
			} catch (e) {
				return { ok: false, reason: `parse failed: ${e instanceof Error ? e.message : String(e)}` };
			}
		},
	},
	{
		name: "debugState",
		cmd: () => {
			const briefId = process.env.HIVEMIND_TEST_BRIEF_ID;
			return `ntn workers exec debugState --local -d '{"briefId": "${briefId}"}'`;
		},
		assert: (out) => {
			try {
				JSON.parse(extractJsonFromOutput(out));
				return { ok: true };
			} catch (e) {
				return { ok: false, reason: `output is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
			}
		},
		skipIf: () => {
			if (!process.env.HIVEMIND_TEST_BRIEF_ID) {
				return "HIVEMIND_TEST_BRIEF_ID not set";
			}
			return null;
		},
	},
];

async function main(): Promise<void> {
	let passed = 0;
	let failed = 0;

	for (const test of TESTS) {
		const skipReason = test.skipIf?.();
		if (skipReason) {
			console.log(`SKIP  ${test.name}: ${skipReason}`);
			continue;
		}

		process.stdout.write(`     ${test.name}: running... `);

		try {
			const cmd = typeof test.cmd === "function" ? test.cmd() : test.cmd;
			const out = execSync(cmd, {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			const result = test.assert(out);

			if (result.ok) {
				console.log(`PASS`);
				passed++;
			} else {
				const failResult = result as { ok: false; reason: string };
				console.log(`FAIL — ${failResult.reason}\n  output: ${out.slice(0, 400)}`);
				failed++;
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`FAIL — exec error: ${msg.slice(0, 200)}`);
			failed++;
		}
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(2);
});
