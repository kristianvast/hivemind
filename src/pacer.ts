export interface PacerConfig {
	rps: number;
	burst: number;
}

export class Pacer {
	private tokens: number;
	private lastRefill: number;
	private readonly rps: number;
	private readonly burst: number;

	constructor(config: PacerConfig) {
		this.rps = config.rps;
		this.burst = config.burst;
		this.tokens = config.burst;
		this.lastRefill = Date.now();
	}

	acquire(): Promise<void> {
		return new Promise((resolve) => {
			const attempt = (): void => {
				const now = Date.now();
				const elapsed = (now - this.lastRefill) / 1000;
				this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rps);
				this.lastRefill = now;

				if (this.tokens >= 1) {
					this.tokens -= 1;
					resolve();
				} else {
					const msUntilToken = ((1 - this.tokens) / this.rps) * 1000;
					setTimeout(attempt, Math.ceil(msUntilToken));
				}
			};
			attempt();
		});
	}
}
