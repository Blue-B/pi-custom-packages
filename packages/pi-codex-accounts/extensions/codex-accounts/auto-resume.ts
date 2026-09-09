import fs from "node:fs/promises";
import { withFileLock } from "./lock.ts";

type Lease = { owner: string; expiresAt: number };

async function readLease(path: string): Promise<Lease | undefined> {
	try {
		return JSON.parse(await fs.readFile(path, "utf8")) as Lease;
	} catch {
		return undefined;
	}
}

export async function claimAutoResume(
	path: string,
	owner: string,
	ttlMs: number,
	now = Date.now(),
): Promise<boolean> {
	return withFileLock(path, async () => {
		const lease = await readLease(path);
		if (lease && lease.owner !== owner && lease.expiresAt > now) return false;
		await fs.writeFile(path, JSON.stringify({ owner, expiresAt: now + ttlMs }));
		return true;
	});
}

export async function releaseAutoResume(
	path: string,
	owner: string,
): Promise<void> {
	await withFileLock(path, async () => {
		if ((await readLease(path))?.owner === owner)
			await fs.rm(path, { force: true });
	});
}
