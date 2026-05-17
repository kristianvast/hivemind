import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Octokit } from "@octokit/rest";
import parseGithubUrl from "parse-github-url";
import { simpleGit, type CommitResult, type SimpleGit } from "simple-git";

import { getConfig } from "./config.js";

let octokitSingleton: Octokit | undefined;

function octokit(): Octokit {
	octokitSingleton ??= new Octokit({ auth: getConfig().GITHUB_PAT });
	return octokitSingleton;
}

function tokenizedUrl(owner: string, repo: string): string {
	return `https://x-access-token:${encodeURIComponent(getConfig().GITHUB_PAT)}@github.com/${owner}/${repo}.git`;
}

async function initRepoWorkdir(name: string, files: Record<string, string>): Promise<{ workdir: string; git: SimpleGit }> {
	const workdir = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
	for (const [relativePath, contents] of Object.entries(files)) {
		const fullPath = path.join(workdir, relativePath);
		await mkdir(path.dirname(fullPath), { recursive: true });
		await writeFile(fullPath, contents, { encoding: "utf8" });
	}
	const git = simpleGit(workdir);
	await git.init();
	await git.addConfig("user.email", "anvil-bot@hivemind.local");
	await git.addConfig("user.name", "Anvil Bot");
	await git.add(".");
	return { workdir, git };
}

function commitSha(result: CommitResult): string {
	return result.commit;
}

export async function scaffoldNewRepo(opts: {
	name: string;
	org: string | null;
	files: Record<string, string>;
	commitMessage: string;
}): Promise<{ repoUrl: string; commitSha: string; defaultBranch: string }> {
	const client = octokit();
	const repo = opts.org
		? await client.rest.repos.createInOrg({ org: opts.org, name: opts.name, private: true })
		: await client.rest.repos.createForAuthenticatedUser({ name: opts.name, private: true });
	const owner = repo.data.owner.login;
	const defaultBranch = repo.data.default_branch || "main";
	const { git } = await initRepoWorkdir(opts.name, opts.files);
	await git.branch(["-M", defaultBranch]);
	const commit = await git.commit(opts.commitMessage);
	await git.addRemote("origin", tokenizedUrl(owner, opts.name));
	await git.push("origin", defaultBranch, { "--set-upstream": null });
	return { repoUrl: repo.data.html_url, commitSha: commitSha(commit), defaultBranch };
}

export async function cloneRepoForBranch(opts: {
	repoUrl: string;
	branchName: string;
}): Promise<{ workdir: string; baseBranch: string }> {
	const { owner, repo } = parseRepoUrl(opts.repoUrl);
	const client = octokit();
	const response = await client.rest.repos.get({ owner, repo });
	const baseBranch = response.data.default_branch;
	const workdir = await mkdtemp(path.join(os.tmpdir(), `${repo}-`));
	await simpleGit().clone(tokenizedUrl(owner, repo), workdir, ["--depth", "1"]);
	const git = simpleGit(workdir);
	await git.addConfig("user.email", "anvil-bot@hivemind.local");
	await git.addConfig("user.name", "Anvil Bot");
	await git.checkoutBranch(opts.branchName, `origin/${baseBranch}`);
	return { workdir, baseBranch };
}

export class NothingToCommitError extends Error {
	readonly code = "NOTHING_TO_COMMIT";

	constructor() {
		super("Nothing to commit");
	}
}

export async function commitAndPushBranch(opts: {
	workdir: string;
	branch: string;
	commitMessage: string;
}): Promise<{ commitSha: string }> {
	const git = simpleGit(opts.workdir);
	await git.add(".");
	const status = await git.status();
	if (status.files.length === 0) throw new NothingToCommitError();
	const commit = await git.commit(opts.commitMessage);
	await git.push("origin", opts.branch, { "--set-upstream": null });
	return { commitSha: commitSha(commit) };
}

export async function openPullRequest(opts: {
	owner: string;
	repo: string;
	branch: string;
	baseBranch: string;
	title: string;
	body: string;
}): Promise<{ prUrl: string; prNumber: number }> {
	try {
		const response = await octokit().rest.pulls.create({
			owner: opts.owner,
			repo: opts.repo,
			head: opts.branch,
			base: opts.baseBranch,
			title: opts.title,
			body: opts.body,
		});
		return { prUrl: response.data.html_url, prNumber: response.data.number };
	} catch (error) {
		if (isRequestError(error)) {
			throw new Error(`GitHub PR failed (${error.status}): ${error.message}`);
		}
		throw error;
	}
}

function isRequestError(error: unknown): error is { status: number; message: string } {
	return (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		"message" in error &&
		typeof error.status === "number" &&
		typeof error.message === "string"
	);
}

export function parseRepoUrl(url: string): { owner: string; repo: string } {
	const parsed = parseGithubUrl(url);
	if (!parsed?.owner || !parsed.name) throw new Error(`Invalid GitHub repository URL: ${url}`);
	return { owner: parsed.owner, repo: parsed.name };
}
