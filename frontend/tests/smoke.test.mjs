import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");

test("the print intake exposes supported model formats and size limit", () => {
	assert.match(page, /accept="\.stl,\.obj"/);
	assert.match(page, /up to 50 MB/);
	assert.match(page, /larger than 50 MB/);
});

test("the print intake offers only the planned profiles", () => {
	const options = [...page.matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
		.map(([, value, label]) => [value, label]);
	assert.deepEqual(options, [
		["", "Select a profile"],
		["draft", "Draft"],
		["standard", "Standard"],
		["high-strength", "High Strength"],
	]);
});

test("the page makes its disconnected upload state explicit", () => {
	assert.match(page, /Upload service not connected/);
	assert.match(page, /No files uploaded/);
});