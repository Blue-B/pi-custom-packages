/**
 * Auto-continue after transient stream failures.
 *
 * pi already retries a dropped stream (settings.retry), but when that budget is
 * exhausted the turn dies and the user has to type "continue" by hand. This
 * queues that same continuation automatically.
 *
 * Hooked on agent_settled, not agent_end: agent_end also fires between pi's own
 * retry attempts, so continuing there would race the built-in retry budget.
 *
 * Loop guard: consecutive auto-continues are capped, and any turn that does not
 * end in a transient error resets the counter.
 *
 * Env: PI_AUTO_CONTINUE_MAX (default 3), PI_AUTO_CONTINUE_PROMPT (override the
 * continuation message), PI_AUTO_CONTINUE_DEBUG=1 to log to /tmp/pi-auto-continue.log.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_CONSECUTIVE = Number(process.env.PI_AUTO_CONTINUE_MAX ?? 3);

/** Transient transport failures only. Auth/quota/overflow errors must not loop. */
const TRANSIENT =
	/stream ended|stream disconnected|terminated|overloaded|rate.?limit|timeout|timed out|ECONNRESET|socket hang up|network.?error|\b(429|500|502|503|504)\b/i;

const CONTINUE_PROMPT =
	process.env.PI_AUTO_CONTINUE_PROMPT ??
	"The previous response was cut off by a transient transport error (stream drop). Do not redo finished work; continue from where it stopped.";

export default function (pi: ExtensionAPI) {
	let consecutive = 0;

	const dbg = (m: string) => {
		if (process.env.PI_AUTO_CONTINUE_DEBUG)
			appendFileSync("/tmp/pi-auto-continue.log", `${m}\n`);
	};

	pi.on("agent_settled", (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		let last: any;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e: any = entries[i];
			if (e.type === "message" && e.message?.role === "assistant") {
				last = e.message;
				break;
			}
		}
		dbg(`settled stop=${last?.stopReason} err=${last?.errorMessage ?? ""}`);

		if (!last || last.stopReason !== "error") {
			consecutive = 0;
			return;
		}
		if (!TRANSIENT.test(last.errorMessage ?? "")) return;

		if (consecutive >= MAX_CONSECUTIVE) {
			consecutive = 0;
			ctx.ui?.notify(
				`auto-continue: ${MAX_CONSECUTIVE} consecutive failures, stopping auto-resume`,
				"error",
			);
			return;
		}
		consecutive++;
		ctx.ui?.notify(
			`auto-continue: stream dropped, resuming ${consecutive}/${MAX_CONSECUTIVE}`,
			"info",
		);
		pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
	});
}
