import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MAX_FILE_SIZE, canContinue, validateFiles } from "../src/scripts/file-validation.js";

const queuePage = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const submitPage = await readFile(new URL("../dist/submit/index.html", import.meta.url), "utf8");

test("the public queue links to the print intake", () => {
	assert.match(queuePage, /Print queue/);
	assert.match(queuePage, /href="\/submit"[^>]*>Submit a print/);
});

test("the intake requires a title and supports multiple STL or OBJ files", () => {
	assert.match(submitPage, /id="part-title"[^>]*required/);
	assert.match(submitPage, /accept="\.stl,\.obj"[^>]*multiple/);
	assert.doesNotMatch(submitPage, /Print profile/);
});

test("valid STL and OBJ files can reach the handoff state", () => {
	const files = [{ name: "part.stl", size: MAX_FILE_SIZE }, { name: "support.OBJ", size: 1024 }];
	assert.deepEqual(validateFiles(files), { ok: true, error: "" });
	assert.equal(canContinue("Phone stand", files), true);
	assert.equal(canContinue("   ", files), false);
});

test("unsupported and oversized files produce separate errors", () => {
	const unsupported = validateFiles([{ name: "toolpath.gcode", size: 100 }]);
	const oversized = validateFiles([{ name: "large.stl", size: MAX_FILE_SIZE + 1 }]);
	assert.equal(unsupported.ok, false);
	assert.match(unsupported.error, /unsupported format/);
	assert.equal(oversized.ok, false);
	assert.match(oversized.error, /larger than 50 MB/);
});
