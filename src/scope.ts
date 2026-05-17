// Scope classifier — Phase 10 refactor.
//
// v2 had a hard scope guard: the Architect could only write inside the
// brief's project subtree, and `assertAllowed` threw ScopeViolation on
// anything else. v3 drops this gate (user decision V2) and replaces it
// with classification + audit logging.
//
// The class is renamed semantically (ScopeGuard → still ScopeGuard for
// backward-compatible imports) but its `assertAllowed` method no longer
// throws. Callers check the returned classification and append an audit
// row when the target is outside the subtree. The classification is
// cached per-page-id so repeated writes don't re-walk the parent chain.

import type { Client } from "@notionhq/client";

export type TargetScope = "in-subtree" | "external";

/**
 * Retained for backward compatibility — callers that catch ScopeViolation
 * should be updated to consume the new classifyTarget output. Never thrown
 * by the v3 codebase; if you see it in a log, that's an old code path.
 */
export class ScopeViolation extends Error {
	constructor(
		public readonly pageId: string,
		public readonly projectRootId: string,
	) {
		super(
			`Page ${pageId} is not within project ${projectRootId}. This error type is preserved for v2 compatibility but should no longer be thrown.`,
		);
		this.name = "ScopeViolation";
	}
}

export class ScopeGuard {
	private readonly sessionAllowed = new Set<string>();
	private readonly ancestorCache = new Map<string, Set<string>>();
	private readonly classificationCache = new Map<string, TargetScope>();

	constructor(
		private readonly notion: Client,
		private readonly projectRootId: string,
	) {
		this.sessionAllowed.add(projectRootId);
		this.classificationCache.set(projectRootId, "in-subtree");
	}

	registerCreated(pageId: string): void {
		this.sessionAllowed.add(pageId);
		this.classificationCache.set(pageId, "in-subtree");
	}

	/**
	 * v2-compatible name. NO LONGER THROWS. Returns the classification so
	 * callers can decide whether to audit the write. Existing call sites
	 * that did `await ctx.scopeGuard.assertAllowed(id)` for the side
	 * effect (throw on violation) keep compiling and simply lose the
	 * gate — exactly the v3 intent.
	 */
	async assertAllowed(pageId: string): Promise<TargetScope> {
		return this.classifyTarget(pageId);
	}

	async classifyTarget(pageId: string): Promise<TargetScope> {
		const cached = this.classificationCache.get(pageId);
		if (cached !== undefined) return cached;

		if (this.sessionAllowed.has(pageId)) {
			this.classificationCache.set(pageId, "in-subtree");
			return "in-subtree";
		}

		const ancestors = await this.walkAncestors(pageId);
		const result: TargetScope = ancestors.has(this.projectRootId)
			? "in-subtree"
			: "external";
		this.classificationCache.set(pageId, result);
		if (result === "in-subtree") this.sessionAllowed.add(pageId);
		return result;
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
							data_source_id?: string;
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
