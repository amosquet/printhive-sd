import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MAX_FILE_SIZE, MAX_BATCH_SIZE, canContinue, validateFiles, formatMiB } from "../src/scripts/file-validation.js";
import { PROFILES, MATERIALS, defaultPartSettings, resolvePartSettings, partScale, partSupportAngle } from "../src/scripts/print-settings.ts";

const queuePage = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const myPrintsPage = await readFile(new URL("../dist/my-prints/index.html", import.meta.url), "utf8");
const submitPage = await readFile(new URL("../dist/submit/index.html", import.meta.url), "utf8");

test("the queue home matches the final design S0 (hero, live queue, printers)", () => {
	assert.match(queuePage, /HIVE/);
	assert.match(queuePage, /3d printing/);
	assert.match(queuePage, /href="\/submit"/);
	assert.match(queuePage, /Submit a print/);
	assert.match(queuePage, /Available printers/);
	assert.match(queuePage, /id="queue-main"/);
	assert.doesNotMatch(queuePage, /id="my-print"/, "the MY PRINT panel lives on /my-prints, not the queue home");
	assert.match(queuePage, /Updates every 15 seconds\./);
	assert.match(queuePage, /Bambu H2D Pro/);
	assert.match(queuePage, /Prusa Core ONE\+/);
	assert.match(queuePage, />Printing</);
	assert.match(queuePage, />Queued</);
});

test("the my-prints page shows only your own prints plus the S5–S7 inspector", () => {
	assert.match(myPrintsPage, /id="queue-banner"/);
	assert.match(myPrintsPage, /id="queue-main"/);
	assert.match(myPrintsPage, /id="my-print"/);
	assert.match(myPrintsPage, /No print yet/);
	assert.match(myPrintsPage, />My prints</);
	assert.doesNotMatch(myPrintsPage, /Bracket v2/, "the public queue stays on /, not on /my-prints");
	assert.match(myPrintsPage, /href="\/submit"/);
	assert.match(myPrintsPage, /href="\/my-prints"[^>]*>My prints</, "nav links to My prints");
});

test("the intake requires a title and accepts multiple STL or OBJ files", () => {
	assert.match(submitPage, /id="part-title"[^>]*required/);
	assert.match(submitPage, /accept="\.stl,\.obj"[^>]*multiple/);
});

test("the intake offers exactly the three FR-05 profiles and default settings", () => {
	assert.match(submitPage, /id="setting-profile"/);
	for (const profile of ["draft", "standard", "high_strength"]) {
		assert.match(submitPage, new RegExp(`value="${profile}"`));
	}
	assert.match(submitPage, /Draft — /);
	assert.match(submitPage, /Standard — /);
	assert.match(submitPage, /High Strength — /);
	assert.match(submitPage, /id="setting-material"/);
	assert.match(submitPage, /id="setting-color"/);
	assert.match(submitPage, /id="setting-supports"/);
	assert.match(submitPage, /id="setting-scale"/);
	assert.match(submitPage, /<input id="email"[^>]*type="email"/);
	assert.match(submitPage, /<input id="email"[^>]*pattern="[^"]*purdue[^"]*edu"/, "email input keeps the purdue.edu pattern");
});

test("the intake has a review step and a sliced preview panel", () => {
	assert.match(submitPage, /id="step-details"/);
	assert.match(submitPage, /id="step-review"/);
	assert.match(submitPage, /id="review-content"/);
	assert.match(submitPage, /id="confirm-button"/);
	assert.match(submitPage, /id="preview-viewport"/);
	assert.match(submitPage, /id="tab-model"/);
	assert.match(submitPage, /id="tab-layers"/);
	assert.match(submitPage, /id="layer-slider"/);
	assert.match(submitPage, /id="printer-fit"/);
	assert.match(submitPage, /Printer build volumes/);
});

test("valid STL and OBJ files can reach the review state", () => {
	const files = [{ name: "part.stl", size: MAX_FILE_SIZE }, { name: "support.OBJ", size: 1024 }];
	assert.deepEqual(validateFiles(files), { ok: true, error: "" });
	assert.equal(canContinue("Phone stand", files), true);
	assert.equal(canContinue("   ", files), false);
});

test("unsupported, oversized, empty and over-batch files produce separate errors", () => {
	const unsupported = validateFiles([{ name: "toolpath.gcode", size: 100 }]);
	const oversized = validateFiles([{ name: "large.stl", size: MAX_FILE_SIZE + 1 }]);
	const empty = validateFiles([{ name: "empty.stl", size: 0 }]);
	const tooMany = validateFiles(Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({ name: `p${i}.stl`, size: 10 })));
	assert.equal(unsupported.ok, false);
	assert.match(unsupported.error, /unsupported format/);
	assert.equal(oversized.ok, false);
	assert.match(oversized.error, /larger than 50 MB/);
	assert.equal(empty.ok, false);
	assert.match(empty.error, /empty/);
	assert.equal(tooMany.ok, false);
	assert.match(tooMany.error, new RegExp(`up to ${MAX_BATCH_SIZE} model files`));
});

test("file sizes are formatted in MiB", () => {
	assert.equal(formatMiB(1024 ** 2), "1.00 MiB");
	assert.equal(formatMiB(0), "0.00 MiB");
});

test("the FR-05 profiles pin layer height, walls and infill like the backend presets", () => {
	assert.deepEqual(
		PROFILES.map((p) => [p.id, p.layerHeight, p.walls, p.infill]),
		[["draft", 0.3, 2, 10], ["standard", 0.2, 3, 15], ["high_strength", 0.2, 5, 40]],
	);
	const global = defaultPartSettings(MATERIALS);
	assert.equal(global.profile, "standard");
	const resolved = resolvePartSettings(global, { copies: 2, mirror: true, overrides: { profile: "draft", color: "red" } }, MATERIALS);
	assert.equal(resolved.profile, "draft");
	assert.equal(resolved.color, "red");
	assert.equal(resolved.copies, 2);
	assert.equal(resolved.mirror, true);
	assert.equal(partScale(resolved), 1);
	assert.equal(partScale({ ...global, units: "m" }), 1000);
	assert.equal(partScale({ ...global, scalePercent: "150" }), 1.5);
	assert.equal(partScale({ ...global, scalePercent: "0" }), null);
	assert.equal(partSupportAngle({ ...global, supportAngle: "" }), undefined);
	assert.equal(partSupportAngle({ ...global, supportAngle: "45" }), 45);
	assert.equal(partSupportAngle({ ...global, supportAngle: "91" }), null);
});
