/**
 * Elapsed timer extension.
 *
 * While the agent loop runs, the working row above the editor shows how long
 * the current task has been running, e.g. "4분 33초 동안 작업 중입니다".
 * When the task ends, the footer keeps the total: "✓ 4분 33초".
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "elapsed";

function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

export default function (pi: ExtensionAPI) {
	let startedAt: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const stopTimer = () => {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	pi.on("agent_start", (_event, ctx) => {
		startedAt = Date.now();
		stopTimer();
		if (!ctx.hasUI) return;

		const tick = () => {
			if (startedAt === undefined) return;
			ctx.ui.setWorkingMessage(`${formatElapsed(Date.now() - startedAt)} 동안 작업 중입니다`);
		};
		tick();
		timer = setInterval(tick, 1000);
	});

	pi.on("agent_end", (_event, ctx) => {
		stopTimer();
		const elapsed = startedAt === undefined ? 0 : Date.now() - startedAt;
		startedAt = undefined;
		if (!ctx.hasUI) return;

		ctx.ui.setWorkingMessage();
		if (elapsed >= 1000) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `✓ ${formatElapsed(elapsed)}`));
		}
	});

	pi.on("session_shutdown", () => {
		stopTimer();
	});
}
