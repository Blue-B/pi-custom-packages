import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	claimAutoResume,
	findResumeRequest,
	releaseAutoResume,
	resumeMessage,
} from "../extensions/codex-accounts/auto-resume.ts";

test("only one session owns auto-resume until release or expiry", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-auto-resume-"));
	const lease = path.join(dir, "lease.json");

	assert.equal(await claimAutoResume(lease, "session-a", 1_000, 100), true);
	assert.equal(await claimAutoResume(lease, "session-b", 1_000, 200), false);
	assert.equal(await claimAutoResume(lease, "session-a", 1_000, 200), true);
	await releaseAutoResume(lease, "session-b");
	assert.equal(await claimAutoResume(lease, "session-b", 1_000, 300), false);
	await releaseAutoResume(lease, "session-a");
	assert.equal(await claimAutoResume(lease, "session-b", 1_000, 300), true);
	assert.equal(await claimAutoResume(lease, "session-c", 1_000, 1_301), true);

	await fs.rm(dir, { recursive: true, force: true });
});

function user(id: string, text: string) {
	return {
		type: "message" as const, id, parentId: null, timestamp: "2026-09-10T00:00:00Z",
		message: { role: "user" as const, content: text, timestamp: 0 },
	};
}

test("a greeting remains the resume target across repeated rotations", () => {
	const greeting = user("greeting", "안녕");
	const request = findResumeRequest([user("old-task", "Memnest 설치 수정"), greeting])!;
	assert.deepEqual(request, { id: "greeting", text: "안녕" });
	const notice = resumeMessage(request);
	assert.equal(notice.display, true);
	assert.equal(notice.details.requestId, "greeting");
	assert.match(notice.content, /원래 사용자 요청: "안녕"/);
	assert.match(notice.content, /새로운 사용자 요청이 아닙니다/);
	assert.match(notice.content, /인사에는 인사만/);
	assert.doesNotMatch(notice.content, /Memnest/);
	const entries = [greeting, { ...greeting, ...notice, type: "custom_message" as const, id: "retry" }];
	assert.deepEqual(findResumeRequest(entries), request);
	assert.deepEqual(resumeMessage(findResumeRequest(entries)!), notice);
	assert.equal(findResumeRequest([...entries, user("new", "오늘 날짜만 알려줘")])?.id, "new");
});

test("missing, blank, or legacy-generated requests never revive an older task", () => {
	const old = user("old", "예전 작업");
	assert.equal(findResumeRequest([]), undefined);
	assert.equal(findResumeRequest([old, user("blank", " ")]), undefined);
	assert.equal(findResumeRequest([old, user("legacy", "계정 한도로 중단된 직전 요청을 반복하지 말고, 미완료 지점부터 이어서 완료하세요.")]), undefined);
});

test("explicit task constraints are retained, not replaced by generic continuation", () => {
	const text = '현재 저장소의 A만 수정하세요. B는 건드리지 마세요.\n"지난 작업"은 실행하지 마세요.';
	const request = findResumeRequest([user("task", text)])!;
	assert.equal(request.text, text);
	assert.ok(resumeMessage(request).content.includes(JSON.stringify(text)));
	assert.match(resumeMessage(request).content, /이미 끝낸 단계는 반복하지/);
	assert.match(resumeMessage(request).content, /기억은 위 요청을 수행하는 데 필요한 경우에만/);
});

test("an image-only request does not fall back to an older text request", () => {
	const image = {
		...user("image", ""),
		message: { role: "user" as const, timestamp: 0, content: [{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }] },
	};
	const request = findResumeRequest([user("old", "예전 작업"), image])!;
	assert.equal(request.id, "image");
	assert.match(request.text, /첨부한 이미지/);
	assert.doesNotMatch(resumeMessage(request).content, /aW1hZ2U=|예전 작업/);
});
