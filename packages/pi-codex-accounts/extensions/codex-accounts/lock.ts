import fs from "node:fs/promises";

const STALE_MS = 5_000;
const MAX_ATTEMPTS = 100;

/** Cross-process mutex via atomic mkdir. Stale locks (crashed holder) are reclaimed after STALE_MS. */
export async function withFileLock<T>(
	target: string,
	fn: () => Promise<T>,
): Promise<T> {
	const lockPath = `${target}.lock`;
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.mkdir(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const stat = await fs.stat(lockPath).catch(() => undefined);
			if (stat && Date.now() - stat.mtimeMs > STALE_MS) {
				await fs.rm(lockPath, { recursive: true, force: true });
				continue;
			}
			if (attempt >= MAX_ATTEMPTS)
				throw new Error(`lock timeout: ${lockPath}`);
			await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
		}
	}
	try {
		return await fn();
	} finally {
		await fs.rm(lockPath, { recursive: true, force: true });
	}
}
