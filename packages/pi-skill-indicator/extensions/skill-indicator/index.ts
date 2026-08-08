/**
 * Skill indicator — 모델이 스킬 파일(SKILL.md)을 읽어 발동하면 TUI에 표시
 * - 발동 순간: 푸터 상태 + toast 알림
 * - 턴 종료 시: 푸터 상태 해제 (turn_end)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKILL_RE = /[\\/]([^\\/]+)[\\/]SKILL\.md$/i;

export default function (pi: ExtensionAPI) {
	let activeSkill: string | null = null;

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return;
		const input = event.input as { path?: string } | undefined;
		const path = input?.path ?? "";
		const m = path.match(SKILL_RE);
		if (!m) return;

		activeSkill = m[1];
		const theme = ctx.ui.theme;
		ctx.ui.setStatus(
			"skill-indicator",
			theme.fg("accent", `🛠️ ${activeSkill} 스킬 사용 중`),
		);
		ctx.ui.notify(`🛠️ 스킬 발동: ${activeSkill}`, "info");
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!activeSkill) return;
		activeSkill = null;
		ctx.ui.setStatus("skill-indicator", undefined);
	});
}
