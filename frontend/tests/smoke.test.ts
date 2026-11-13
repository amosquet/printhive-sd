import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("frontend smoke tests", () => {
	test("index.astro landing page exists and contains root html markup", () => {
		const indexPath = resolve(import.meta.dir, "../src/pages/index.astro");
		expect(existsSync(indexPath)).toBe(true);
		const content = readFileSync(indexPath, "utf-8");
		expect(content).toContain("<html");
	});
});
