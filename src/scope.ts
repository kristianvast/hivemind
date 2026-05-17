import type { Client } from "@notionhq/client";

export class ScopeViolation extends Error {
	constructor(
		public readonly pageId: string,
		public readonly projectRootId: string,
	) {
		super(`Page ${pageId} is not within project ${projectRootId}`);
		this.name = "ScopeViolation";
	}
}

export class ScopeGuard {
	private readonly sessionAllowed = new Set<string>();
	private readonly ancestorCache = new Map<string, Set<string>>();

	constructor(
		private readonly notion: Client,
		private readonly projectRootId: string,
	) {
		this.sessionAllowed.add(projectRootId);
	}

	registerCreated(pageId: string): void {
		this.sessionAllowed.add(pageId);
	}

	async assertAllowed(pageId: string): Promise<void> {
		if (this.sessionAllowed.has(pageId)) return;

		const ancestors = await this.walkAncestors(pageId);
		if (ancestors.has(this.projectRootId)) {
			this.sessionAllowed.add(pageId);
			return;
		}

		throw new ScopeViolation(pageId, this.projectRootId);
	}

	private async walkAncestors(pageId: string): Promise<Set<string>> {
		const cached = this.ancestorCache.get(pageId);
		if (cached !== undefined) return cached;

		const ancestors = new Set<string>();
		let currentId: string | null = pageId;

		while (currentId !== null) {
			const id = currentId;
			currentId = null;

			const cachedAncestors = this.ancestorCache.get(id);
			if (cachedAncestors !== undefined) {
				for (const a of cachedAncestors) ancestors.add(a);
				break;
			}

			let parentId: string | null = null;

			try {
				const page = await this.notion.pages.retrieve({ page_id: id });
				const parent = (
					page as {
						parent: {
							type: string;
							page_id?: string;
							database_id?: string;
							block_id?: string;
						};
					}
				).parent;

				if (parent.type === "page_id" && parent.page_id) {
					parentId = parent.page_id;
				} else if (parent.type === "database_id" && parent.database_id) {
					ancestors.add(parent.database_id);
					const db = await this.notion.databases.retrieve({
						database_id: parent.database_id,
					});
					const dbParent = (db as { parent: { type: string; page_id?: string } })
						.parent;
					if (dbParent.type === "page_id" && dbParent.page_id) {
						currentId = dbParent.page_id;
						ancestors.add(currentId);
					}
					this.ancestorCache.set(id, new Set(ancestors));
					continue;
				} else if (parent.type === "block_id" && parent.block_id) {
					parentId = parent.block_id;
				}
			} catch {
				break;
			}

			if (parentId !== null) {
				ancestors.add(parentId);
				currentId = parentId;
			}
		}

		this.ancestorCache.set(pageId, ancestors);
		return ancestors;
	}
}
