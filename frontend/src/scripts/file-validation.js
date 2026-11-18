export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const SUPPORTED_EXTENSIONS = new Set(["stl", "obj"]);

export function validateFiles(files) {
	if (!files.length) return { ok: false, error: "Choose at least one STL or OBJ file." };

	const unsupported = files.find((file) => {
		const extension = file.name.split(".").pop()?.toLowerCase();
		return !extension || !SUPPORTED_EXTENSIONS.has(extension);
	});
	if (unsupported) return { ok: false, error: `${unsupported.name} has an unsupported format. Choose STL or OBJ files.` };

	const oversized = files.find((file) => file.size > MAX_FILE_SIZE);
	if (oversized) return { ok: false, error: `${oversized.name} is larger than 50 MB. Choose a smaller model.` };

	return { ok: true, error: "" };
}

export function canContinue(title, files) {
	return title.trim().length > 0 && validateFiles(files).ok;
}
