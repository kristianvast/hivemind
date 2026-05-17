export class BudgetExceeded extends Error {
	constructor(
		public readonly used: number,
		public readonly limit: number,
	) {
		super(`Token budget exceeded: used ${used} > limit ${limit}`);
		this.name = "BudgetExceeded";
	}
}

export class TokenBudget {
	private used = 0;

	constructor(public readonly limit: number) {}

	record(inTokens: number, outTokens: number): void {
		this.used += inTokens + outTokens;
	}

	assertWithin(): void {
		if (this.used > this.limit) throw new BudgetExceeded(this.used, this.limit);
	}

	get usage(): number {
		return this.used;
	}
}
