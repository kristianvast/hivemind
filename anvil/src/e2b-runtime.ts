import { CommandExitError, Sandbox } from "e2b";

export interface VmHandle {
	kind: "e2b";
	sandbox: Sandbox;
	sandboxId: string;
}

interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function isCommandExitError(error: unknown): error is CommandExitError {
	return error instanceof CommandExitError;
}

export async function spawnVm(opts: {
	template?: string;
	timeoutMs?: number;
	envs?: Record<string, string>;
	metadata?: Record<string, string>;
}): Promise<VmHandle> {
	const sandbox = await Sandbox.create(opts.template ?? "base", {
		timeoutMs: opts.timeoutMs ?? 600_000,
		envs: opts.envs,
		metadata: opts.metadata,
	});
	return { kind: "e2b", sandbox, sandboxId: sandbox.sandboxId };
}

export async function execInVm(
	vm: VmHandle,
	cmd: string,
	opts?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number },
): Promise<ExecResult> {
	let stdout = "";
	let stderr = "";
	try {
		const result = await vm.sandbox.commands.run(cmd, {
			cwd: opts?.cwd,
			envs: opts?.envs,
			timeoutMs: opts?.timeoutMs,
			onStdout: (chunk) => {
				stdout += chunk;
			},
			onStderr: (chunk) => {
				stderr += chunk;
			},
		});
		return { exitCode: result.exitCode, stdout: result.stdout ?? stdout, stderr: result.stderr ?? stderr };
	} catch (error) {
		if (isCommandExitError(error)) {
			return { exitCode: error.exitCode, stdout: error.stdout || stdout, stderr: error.stderr || stderr };
		}
		throw error;
	}
}

export async function writeFile(vm: VmHandle, filePath: string, data: string): Promise<void> {
	await vm.sandbox.files.write(filePath, data);
}

export async function readFile(vm: VmHandle, filePath: string): Promise<string> {
	return await vm.sandbox.files.read(filePath);
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
	const handle = await vm.sandbox.commands.run(cmd, {
		background: true,
		cwd: opts?.cwd,
		envs: opts?.envs,
		timeoutMs: 24 * 60 * 60 * 1000,
		onStdout: opts?.onStdout,
		onStderr: opts?.onStderr,
	});
	return {
		pid: handle.pid,
		kill: async () => {
			await handle.kill();
		},
	};
}

export function getPublicUrl(vm: VmHandle, port: number, scheme: "https" | "wss" = "https"): string {
	return `${scheme}://${vm.sandbox.getHost(port)}`;
}

export async function teardownVm(vm: VmHandle): Promise<void> {
	await vm.sandbox.kill();
}

function metadataMatches(actual: Record<string, string>, expected: Record<string, string>): boolean {
	return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export async function listAnvilSandboxes(
	metadata?: Record<string, string>,
): Promise<Array<{ sandboxId: string; metadata: Record<string, string> }>> {
	const paginator = Sandbox.list({ query: { state: ["running"], metadata } });
	const sandboxes: Array<{ sandboxId: string; metadata: Record<string, string> }> = [];
	while (paginator.hasNext) {
		const items = await paginator.nextItems();
		for (const item of items) {
			const actualMetadata = item.metadata ?? {};
			if (metadata && !metadataMatches(actualMetadata, metadata)) continue;
			sandboxes.push({ sandboxId: item.sandboxId, metadata: actualMetadata });
		}
	}
	return sandboxes;
}

export async function killSandboxById(sandboxId: string): Promise<boolean> {
	return await Sandbox.kill(sandboxId);
}
