import type { LogLevel } from "./types.js";

const levels: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

function currentLevel(): LogLevel {
	const raw = process.env.LOG_LEVEL;
	if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
	return "info";
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
	if (levels[level] < levels[currentLevel()]) return;
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		msg,
		...(fields ?? {}),
	});
	process.stderr.write(`${line}\n`);
}

export const log = {
	debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
	info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
	warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
	error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
