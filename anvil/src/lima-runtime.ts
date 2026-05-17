import { spawn } from "node:child_process";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { log } from "./log.js";

const LIMA_VM_NAME = "anvil";
const LIMA_TEMPLATE = "template://default";
const DEV_PORT_DEFAULT = 3000;

export interface VmHandle {
	kind: "lima";
	name: string;
	workdir: string;
	briefId: string;
}

interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export async function spawnVm(opts: {
	template?: string;
	timeoutMs?: number;
	envs?: Record<string, string>;
	metadata?: Record<string, string>;
}): Promise<VmHandle> {
	void opts.template;
	void opts.timeoutMs;
	await ensureLimactlInstalled();
	await ensureVmRunning();
	const briefId = opts.metadata?.briefId ?? `local-${Date.now()}`;
	const safe = briefId.replace(/[^a-zA-Z0-9_-]/g, "_");
	const workdir = `/tmp/anvil/${safe}`;
	const envPrefix = opts.envs ? buildEnvPrefix(opts.envs) : "";
	await runLimactl(["shell", LIMA_VM_NAME, "--", "bash", "-lc", `mkdir -p ${shellQuote(workdir)}`]);
	if (envPrefix.length > 0) {
		await runLimactl([
			"shell",
			LIMA_VM_NAME,
			"--",
			"bash",
			"-lc",
			`${envPrefix}true`,
		]);
	}
	return { kind: "lima", name: LIMA_VM_NAME, workdir, briefId };
}

export async function execInVm(
	vm: VmHandle,
	cmd: string,
	opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
): Promise<ExecResult> {
	const cwd = opts?.cwd ?? vm.workdir;
	const envPrefix = opts?.envs ? buildEnvPrefix(opts.envs) : "";
	const wrapped = `set -o pipefail; cd ${shellQuote(cwd)} && ${envPrefix}${cmd}`;
	return runLimactl(
		["shell", vm.name, "--", "bash", "-lc", wrapped],
		{ timeoutMs: opts?.timeoutMs },
	);
}

export async function writeFile(
	vm: VmHandle,
	filePath: string,
	data: string,
): Promise<void> {
	const parent = posixDirname(filePath);
	const mkdirResult = await runLimactl(
		["shell", vm.name, "--", "bash", "-lc", `mkdir -p ${shellQuote(parent)}`],
	);
	if (mkdirResult.exitCode !== 0) {
		throw new Error(`lima writeFile mkdir failed: ${mkdirResult.stderr || mkdirResult.stdout}`);
	}
	const writeResult = await runLimactlWithStdin(
		["shell", vm.name, "--", "bash", "-lc", `cat > ${shellQuote(filePath)}`],
		data,
	);
	if (writeResult.exitCode !== 0) {
		throw new Error(`lima writeFile failed: ${writeResult.stderr || writeResult.stdout}`);
	}
}

export async function readFile(vm: VmHandle, filePath: string): Promise<string> {
	const result = await runLimactl([
		"shell",
		vm.name,
		"--",
		"bash",
		"-lc",
		`cat ${shellQuote(filePath)}`,
	]);
	if (result.exitCode !== 0) {
		throw new Error(`lima readFile failed: ${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

export async function startBackgroundProcess(
	vm: VmHandle,
	cmd: string,
	opts?: {
		cwd?: string;
		envs?: Record<string, string>;
		onStdout?: (s: string) => void;
		onStderr?: (s: string) => void;
	},
): Promise<{ pid: number; kill: () => Promise<void> }> {
	const cwd = opts?.cwd ?? vm.workdir;
	const envPrefix = opts?.envs ? buildEnvPrefix(opts.envs) : "";
	const wrapped = `cd ${shellQuote(cwd)} && ${envPrefix}nohup ${cmd} > .anvil-bg.log 2>&1 & echo $!`;
	const result = await runLimactl(["shell", vm.name, "--", "bash", "-lc", wrapped]);
	if (result.exitCode !== 0) {
		throw new Error(`lima startBackgroundProcess failed: ${result.stderr || result.stdout}`);
	}
	const pid = Number.parseInt(result.stdout.trim(), 10);
	if (!Number.isFinite(pid)) {
		throw new Error(`lima startBackgroundProcess: could not parse pid from "${result.stdout}"`);
	}
	if (opts?.onStdout || opts?.onStderr) {
		log.warn("[lima] startBackgroundProcess streaming callbacks are not wired; consult .anvil-bg.log in the workdir");
	}
	return {
		pid,
		kill: async () => {
			await runLimactl([
				"shell",
				vm.name,
				"--",
				"bash",
				"-lc",
				`kill ${pid} 2>/dev/null || true`,
			]);
		},
	};
}

export function getPublicUrl(
	vm: VmHandle,
	port: number,
	scheme: "https" | "wss" = "https",
): string {
	void vm;
	const realScheme = scheme === "wss" ? "ws" : "http";
	return `${realScheme}://127.0.0.1:${port}`;
}

export async function teardownVm(vm: VmHandle): Promise<void> {
	const pidFile = `${vm.workdir}/.anvil-dev.pid`;
	const killCmd = `if [ -f ${shellQuote(pidFile)} ]; then kill $(cat ${shellQuote(pidFile)}) 2>/dev/null || true; fi`;
	const rmCmd = `rm -rf ${shellQuote(vm.workdir)}`;
	await runLimactl(["shell", vm.name, "--", "bash", "-lc", `${killCmd}; ${rmCmd}`]);
	await freeDevPort(vm, DEV_PORT_DEFAULT);
}

async function freeDevPort(vm: VmHandle, port: number): Promise<void> {
	const result = await runLimactl([
		"shell",
		vm.name,
		"--",
		"bash",
		"-lc",
		`fuser -k ${port}/tcp 2>/dev/null || true`,
	]);
	if (result.exitCode !== 0 && result.stderr.length > 0) {
		log.debug("[lima] freeDevPort warning", { port, stderr: result.stderr.trim() });
	}
}

export async function listAnvilSandboxes(
	metadata?: Record<string, string>,
): Promise<Array<{ sandboxId: string; metadata: Record<string, string> }>> {
	void metadata;
	const status = await getLimaStatus(LIMA_VM_NAME);
	if (status === "Running") {
		return [{ sandboxId: LIMA_VM_NAME, metadata: { purpose: "anvil", state: status } }];
	}
	if (status !== null) {
		return [{ sandboxId: LIMA_VM_NAME, metadata: { purpose: "anvil", state: status } }];
	}
	return [];
}

export async function killSandboxById(sandboxId: string): Promise<boolean> {
	if (sandboxId !== LIMA_VM_NAME) {
		log.warn("[lima] killSandboxById: unknown sandbox id, refusing", { sandboxId });
		return false;
	}
	const result = await runLimactl(["stop", "-f", LIMA_VM_NAME]);
	if (result.exitCode !== 0) {
		log.error("[lima] failed to stop VM", { stderr: result.stderr });
		return false;
	}
	return true;
}

export async function ensureLimaInstalled(): Promise<{
	installed: boolean;
	hint?: string;
}> {
	const ok = await isLimactlInstalled();
	if (ok) return { installed: true };
	return {
		installed: false,
		hint:
			"Lima is not installed. On macOS, run: brew install lima. " +
			"See https://lima-vm.io for other platforms.",
	};
}

export async function bootstrapAnvilVm(): Promise<void> {
	await ensureLimactlInstalled();
	const status = await getLimaStatus(LIMA_VM_NAME);
	if (status === "Running") {
		log.info("[lima] anvil VM already running");
		return;
	}
	if (status === null) {
		log.info("[lima] creating anvil VM (this can take 1-2 minutes the first time)");
		await runLimactlInteractive([
			"start",
			"--tty=false",
			`--name=${LIMA_VM_NAME}`,
			LIMA_TEMPLATE,
		]);
	} else {
		log.info("[lima] resuming anvil VM", { previous: status });
		await runLimactlInteractive(["start", LIMA_VM_NAME]);
	}
	await provisionVm();
}

async function ensureVmRunning(): Promise<void> {
	const status = await getLimaStatus(LIMA_VM_NAME);
	if (status === "Running") return;
	await bootstrapAnvilVm();
}

async function provisionVm(): Promise<void> {
	const probe = await runLimactl([
		"shell",
		LIMA_VM_NAME,
		"--",
		"bash",
		"-lc",
		"command -v node >/dev/null && command -v npm >/dev/null && command -v git >/dev/null && command -v curl >/dev/null && echo READY || echo MISSING",
	]);
	if (probe.stdout.trim().endsWith("READY")) {
		log.info("[lima] toolchain already provisioned");
		return;
	}
	log.info("[lima] installing toolchain (node, npm, git, curl) — one-time");
	const install = await runLimactl([
		"shell",
		LIMA_VM_NAME,
		"--",
		"bash",
		"-lc",
		[
			"set -e",
			"sudo apt-get update -y",
			"curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -",
			"sudo apt-get install -y nodejs git curl ca-certificates",
		].join(" && "),
	]);
	if (install.exitCode !== 0) {
		throw new Error(`lima provisionVm failed: ${install.stderr || install.stdout}`);
	}
}

async function ensureLimactlInstalled(): Promise<void> {
	const ok = await isLimactlInstalled();
	if (!ok) {
		throw new Error(
			"limactl not found in PATH. Install Lima first: brew install lima (macOS) " +
				"or see https://lima-vm.io. Then re-run.",
		);
	}
}

async function isLimactlInstalled(): Promise<boolean> {
	const result = await runProcess("which", ["limactl"], { stdin: undefined });
	return result.exitCode === 0;
}

async function getLimaStatus(name: string): Promise<string | null> {
	const result = await runLimactl(["list", name, "--format", "{{.Status}}"]);
	if (result.exitCode !== 0) {
		if (/no instance/i.test(result.stderr) || /not found/i.test(result.stderr)) return null;
		log.warn("[lima] limactl list error", { stderr: result.stderr.trim() });
		return null;
	}
	const status = result.stdout.trim();
	return status.length > 0 ? status : null;
}

function buildEnvPrefix(envs: Record<string, string>): string {
	return Object.entries(envs)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ")
		.concat(" ");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function posixDirname(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx <= 0 ? "/" : p.slice(0, idx);
}

async function runLimactl(args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
	return runProcess("limactl", args, { stdin: undefined, timeoutMs: opts?.timeoutMs });
}

async function runLimactlWithStdin(args: string[], stdin: string): Promise<ExecResult> {
	return runProcess("limactl", args, { stdin });
}

async function runLimactlInteractive(args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("limactl", args, { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`limactl ${args.join(" ")} exited ${code}`));
		});
	});
}

interface ProcessOptions {
	stdin?: string;
	timeoutMs?: number;
}

async function runProcess(
	command: string,
	args: string[],
	opts: ProcessOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let exited = false;
		const timer = opts.timeoutMs
			? setTimeout(() => {
					if (!exited) {
						child.kill("SIGKILL");
					}
				}, opts.timeoutMs)
			: undefined;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", (err) => {
			exited = true;
			if (timer) clearTimeout(timer);
			resolve({ exitCode: 127, stdout, stderr: `${stderr}${err.message}` });
		});
		child.once("exit", (code) => {
			exited = true;
			if (timer) clearTimeout(timer);
			resolve({ exitCode: code ?? 0, stdout, stderr });
		});
		if (opts.stdin !== undefined) {
			child.stdin.write(opts.stdin);
			child.stdin.end();
		} else {
			child.stdin.end();
		}
	});
}

void os;
void path;
void fsMkdir;
void fsWriteFile;
