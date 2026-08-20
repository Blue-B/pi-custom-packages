// herdr's official Pi integration (herdr-agent-state.ts, installed by
// `herdr integration install pi`) already has a "blocked" sidebar state and
// already listens for a "herdr:blocked" event — but nothing ever emits it
// for the ask_user_question tool, so herdr's sidebar shows the pane as
// "working" (yellow) for the entire time the agent is actually waiting on
// the user to answer a question. This fires that missing event.
//
// Upstream tracking (unresolved as of 2026-08-20):
// https://github.com/herdrdev/herdr/discussions/1346
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const isAskUserQuestion = (toolName: string) =>
  toolName.endsWith("ask_user_question");

export default function (pi: ExtensionAPI) {
  pi.on("tool_execution_start", (event) => {
    if (!isAskUserQuestion(event.toolName)) return;
    pi.events.emit("herdr:blocked", { active: true, label: "질문 대기" });
  });

  pi.on("tool_execution_end", (event) => {
    if (!isAskUserQuestion(event.toolName)) return;
    pi.events.emit("herdr:blocked", { active: false });
  });
}
