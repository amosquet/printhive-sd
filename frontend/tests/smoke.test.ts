import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("frontend smoke tests", () => {
	test("index.astro landing page uses a layout with root html markup", () => {
		const indexPath = resolve(import.meta.dir, "../src/pages/index.astro");
		const layoutPath = resolve(import.meta.dir, "../src/layouts/BaseLayout.astro");
		expect(existsSync(indexPath)).toBe(true);
		expect(existsSync(layoutPath)).toBe(true);

		const indexContent = readFileSync(indexPath, "utf-8");
		const layoutContent = readFileSync(layoutPath, "utf-8");
		expect(indexContent).toContain('import BaseLayout from "../layouts/BaseLayout.astro"');
		expect(indexContent).toContain("<BaseLayout");
		expect(layoutContent).toContain("<html");
	});
});
