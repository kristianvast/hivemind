import { getConfig } from "./config.js";
import * as e2b from "./e2b-runtime.js";
import * as lima from "./lima-runtime.js";

export type VmHandle = e2b.VmHandle | lima.VmHandle;

interface SpawnVmOpts {
	template?: string;
	timeoutMs?: number;
	envs?: Record<string, string>;
	metadata?: Record<string, string>;
}

interface ExecOpts {
	cwd?: string;
	envs?: Record<string, string>;
	timeoutMs?: number;
}

interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface BackgroundOpts {
	cwd?: string;
	envs?: Record<string, string>;
	onStdout?: (s: string) => void;
	onStderr?: (s: string) => void;
}

export async function spawnVm(opts: SpawnVmOpts): Promise<VmHandle> {
	if (getConfig().SANDBOX_DRIVER === "e2b") return e2b.spawnVm(opts);
	return lima.spawnVm(opts);
}

export async function execInVm(
	vm: VmHandle,
	cmd: string,
	opts?: ExecOpts,
): Promise<ExecResult> {
	if (vm.kind === "e2b") return e2b.execInVm(vm, cmd, opts);
	return lima.execInVm(vm, cmd, opts);
}

export async function writeFile(vm: VmHandle, filePath: string, data: string): Promise<void> {
	if (vm.kind === "e2b") return e2b.writeFile(vm, filePath, data);
	return lima.writeFile(vm, filePath, data);
}

export async function readFile(vm: VmHandle, filePath: string): Promise<string> {
	if (vm.kind === "e2b") return e2b.readFile(vm, filePath);
	return lima.readFile(vm, filePath);
}

export async function startBackgroundProcess(
	vm: VmHandle,
	cmd: string,
	opts?: BackgroundOpts,
): Promise<{ pid: number; kill: () => Promise<void> }> {
	if (vm.kind === "e2b") return e2b.startBackgroundProcess(vm, cmd, opts);
	return lima.startBackgroundProcess(vm, cmd, opts);
}

export function getPublicUrl(
	vm: VmHandle,
	port: number,
	scheme: "https" | "wss" = "https",
): string {
	if (vm.kind === "e2b") return e2b.getPublicUrl(vm, port, scheme);
	return lima.getPublicUrl(vm, port, scheme);
}

export async function teardownVm(vm: VmHandle): Promise<void> {
	if (vm.kind === "e2b") return e2b.teardownVm(vm);
	return lima.teardownVm(vm);
}

export async function listAnvilSandboxes(
	metadata?: Record<string, string>,
): Promise<Array<{ sandboxId: string; metadata: Record<string, string> }>> {
	if (getConfig().SANDBOX_DRIVER === "e2b") return e2b.listAnvilSandboxes(metadata);
	return lima.listAnvilSandboxes(metadata);
}

export async function killSandboxById(sandboxId: string): Promise<boolean> {
	if (getConfig().SANDBOX_DRIVER === "e2b") return e2b.killSandboxById(sandboxId);
	return lima.killSandboxById(sandboxId);
}

export async function ensureLocalToolchain(): Promise<void> {
	if (getConfig().SANDBOX_DRIVER !== "lima") return;
	const status = await lima.ensureLimaInstalled();
	if (!status.installed) {
		throw new Error(status.hint ?? "lima is not installed");
	}
	await lima.bootstrapAnvilVm();
}
