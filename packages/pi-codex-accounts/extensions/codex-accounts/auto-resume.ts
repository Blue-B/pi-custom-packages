import fs from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { withFileLock } from "./lock.ts";

export function findResumeRequest(entries: readonly SessionEntry[]) {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string"
			? content
			: content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		// Older versions stored this generated instruction as a user request.
		// Its author cannot be recovered reliably; do not guess an earlier task.
		if (text === "계정 한도로 중단된 직전 요청을 반복하지 말고, 미완료 지점부터 이어서 완료하세요.") return;
		if (!text.trim() && (typeof content === "string" || !content.some((part) => part.type === "image"))) return;
		return { id: entry.id, text: text || "(텍스트 없이 첨부한 이미지: 원래 메시지의 첨부만 참조)" };
	}
}

export function resumeMessage(request: { id: string; text: string }) {
	return {
		customType: "codex-account-resume",
		display: true,
		details: { requestId: request.id },
		content: [
			"[계정 전환 후 자동 재개 안내: 새로운 사용자 요청이 아닙니다.]",
			`재개 대상 사용자 메시지 ID: ${JSON.stringify(request.id)}`,
			`원래 사용자 요청: ${JSON.stringify(request.text)}`,
			"위 요청만 현재 대화의 진행 상황에 맞춰 이어서 답하세요. 이미 끝낸 단계는 반복하지 마세요.",
			"목표나 작업 목록이 비어 있다고 과거 작업을 찾지 마세요. 기억 검색으로 새로운 재개 대상을 정하거나 과거 기록을 파일 변경 승인으로 해석하지 마세요. 기억은 위 요청을 수행하는 데 필요한 경우에만 참고하세요.",
			"인사에는 인사만 답하고, 질문에는 그 질문의 범위에서 답하세요. 원래 요청의 범위를 확인할 수 없으면 과거 작업을 추측하지 말고 사용자에게 확인하세요.",
		].join("\n"),
	};
}

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
