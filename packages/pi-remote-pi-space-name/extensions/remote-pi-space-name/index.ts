// Gives each herdr pane its own remote-pi mesh identity.
//
// Every pane in a herdr session can share one working directory, and therefore
// `<cwd>/.pi/remote-pi/config.json`. The broker keys agents by (cwd, name), so
// the Space label alone collides for panes in the same Space.
//
// Herdr hands each pane a HERDR_WORKSPACE_ID and HERDR_PANE_ID. This injects a
// `Space · pN` identity through REMOTE_PI_DIRECT_CONFIG,
// remote-pi's documented escape hatch for supplying the whole local config as
// inline JSON (it takes precedence over the file). remote-pi itself is not
// modified by this file.
//
// Must run at module evaluation: remote-pi reads its local config inside the
// session_start handler, so filling the env before that point works no matter
// which extension loads first. Any failure falls back to remote-pi's default.
//
// The mobile app's per-Space title is a separate concern handled by this
// package's patch script. See the README.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface WorkspaceInfoResponse {
	result?: {
		type?: string;
		workspace?: { workspace_id?: string; label?: string };
	};
}

/** Reads the current label of `workspaceId`, or undefined when herdr can't answer. */
function readLabel(workspaceId: string): string | undefined {
	const raw = execFileSync(
		process.env.HERDR_BIN_PATH || "herdr",
		["workspace", "get", workspaceId],
		{ encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024 },
	);
	let parsed: WorkspaceInfoResponse;
	try {
		parsed = JSON.parse(raw) as WorkspaceInfoResponse;
	} catch {
		return undefined; // herdr answered with something that isn't its JSON envelope
	}
	const workspace =
		parsed.result?.type === "workspace_info" ? parsed.result.workspace : undefined;
	if (workspace?.workspace_id !== workspaceId) return undefined;
	return typeof workspace.label === "string" ? workspace.label : undefined;
}

/** Mirrors remote-pi's own segment sanitizer: `/ : @ #` and runs of whitespace collapse to `-`. */
function toAgentName(label: string): string {
	return label
		.trim()
		.replace(/[/:@#\s]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** The on-disk config, so injecting a name never drops `auto_start_relay`. */
function existingConfig(cwd: string): Record<string, unknown> {
	try {
		const raw = readFileSync(join(cwd, ".pi", "remote-pi", "config.json"), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {}; // no per-cwd config yet, so remote-pi's defaults apply
	}
}

const workspaceId =
	process.env.HERDR_ENV === "1" ? process.env.HERDR_WORKSPACE_ID?.trim() : undefined;
const paneId =
	process.env.HERDR_ENV === "1" ? process.env.HERDR_PANE_ID?.trim() : undefined;

function paneSuffix(id: string): string {
	return id.slice(id.lastIndexOf(":") + 1);
}

if (workspaceId && paneId && !process.env.REMOTE_PI_DIRECT_CONFIG) {
	try {
		const label = readLabel(workspaceId);
		const agentName = label ? toAgentName(`${label}-${workspaceId}-${paneSuffix(paneId)}`) : "";
		// `broadcast` and `broker` are reserved mesh addresses.
		if (agentName && agentName !== "broadcast" && agentName !== "broker") {
			process.env.REMOTE_PI_DIRECT_CONFIG = JSON.stringify({
				...existingConfig(process.cwd()),
				agent_name: agentName,
			});
		}
	} catch {
		// herdr CLI missing or its socket is busy, so keep remote-pi's default name.
	}
}

export default function (_pi: unknown): void {
	// Nothing to do at runtime; the injection above already happened.
}
