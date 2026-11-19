export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const MAX_BATCH_SIZE = 10;
export const SUPPORTED_EXTENSIONS = new Set(["stl", "obj"]);

export function validateFiles(files) {
	if (!files.length) return { ok: false, error: "Choose at least one STL or OBJ file." };

	const unsupported = files.find((file) => {
		const extension = file.name.split(".").pop()?.toLowerCase();
		return !extension || !SUPPORTED_EXTENSIONS.has(extension);
	});
	if (unsupported) return { ok: false, error: `${unsupported.name} has an unsupported format. Choose STL or OBJ files.` };

	const oversized = files.find((file) => file.size > MAX_FILE_SIZE || file.size === 0);
	if (oversized) {
		return oversized.size === 0
			? { ok: false, error: `${oversized.name} is empty. Choose a non-empty STL or OBJ file.` }
			: { ok: false, error: `${oversized.name} is larger than 50 MB. Choose a smaller model.` };
	}

	if (files.length > MAX_BATCH_SIZE) {
		return { ok: false, error: `You can submit up to ${MAX_BATCH_SIZE} model files in a single batch.` };
	}

	return { ok: true, error: "" };
}

export function canContinue(title, files) {
	return title.trim().length > 0 && validateFiles(files).ok;
}

export function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

export function formatMiB(bytes) {
	return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}
