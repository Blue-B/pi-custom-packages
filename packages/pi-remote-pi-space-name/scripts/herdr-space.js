// Copied into remote-pi's dist/ by patch-remote-pi-space-name.mjs.
//
// Reads the current herdr Space label for this pane and derives a room id from
// the workspace id instead of the label. Keeping the room id off the label is
// what lets several Spaces share the name "~" without colliding, and what lets
// a rename keep its existing conversation.
//
// Outside herdr every export is inert: `label()` returns "" and `roomId()`
// returns undefined, so remote-pi falls through to its own behaviour.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const QUERY_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/** How often the label is re-read. A rename shows up in the app within this. */
export const POLL_MS = 5_000;

function herdrBin() {
	return process.env.HERDR_BIN_PATH || "herdr";
}

/** This pane's workspace id, or undefined when not running under herdr. */
export function workspaceId() {
	const id = process.env.HERDR_WORKSPACE_ID?.trim();
	return process.env.HERDR_ENV === "1" && id ? id : undefined;
}

/** Pulls the label out of `herdr workspace get` output; undefined if it doesn't match. */
function parseLabel(raw, id) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined; // not herdr's JSON envelope
	}
	const workspace =
		parsed?.result?.type === "workspace_info" ? parsed.result.workspace : undefined;
	if (!workspace || workspace.workspace_id !== id) return undefined;
	return typeof workspace.label === "string" ? workspace.label : undefined;
}

// undefined = not read yet, "" = unavailable (don't retry synchronously)
let cachedLabel;

/**
 * Current Space label, or "" outside herdr / when herdr can't answer.
 *
 * Synchronous because remote-pi asks for the session name from a sync path.
 * The blocking read happens once per process; the poll below keeps it fresh.
 */
export function label() {
	const id = workspaceId();
	if (!id) return "";
	if (cachedLabel === undefined) {
		try {
			const raw = execFileSync(herdrBin(), ["workspace", "get", id], {
				encoding: "utf8",
				timeout: QUERY_TIMEOUT_MS,
				maxBuffer: MAX_OUTPUT_BYTES,
			});
			cachedLabel = parseLabel(raw, id) ?? "";
		} catch {
			cachedLabel = ""; // herdr missing or socket busy
		}
	}
	return cachedLabel;
}

/** Room id keyed by workspace id, so it survives renames and duplicate labels. */
export function roomId() {
	const id = workspaceId();
	if (!id) return undefined;
	return createHash("sha256")
		.update(`herdr-workspace\0${id}`)
		.digest("base64url")
		.slice(0, 12);
}

let stopped = true;
let timer;

/**
 * Calls `onChange(label)` whenever the Space is renamed.
 *
 * A recursive timeout rather than setInterval, so a slow herdr never stacks up
 * overlapping queries.
 */
export function startPolling(onChange) {
	const id = workspaceId();
	if (!id || !stopped) return;
	stopped = false;
	label(); // seed the cache so the first change is a real change

	const schedule = () => {
		if (stopped) return;
		timer = setTimeout(() => void poll(), POLL_MS);
		timer.unref?.();
	};

	const poll = async () => {
		if (stopped) return;
		try {
			const { stdout } = await execFileAsync(herdrBin(), ["workspace", "get", id], {
				encoding: "utf8",
				timeout: QUERY_TIMEOUT_MS,
				maxBuffer: MAX_OUTPUT_BYTES,
			});
			const next = parseLabel(stdout, id);
			if (next && next !== cachedLabel) {
				cachedLabel = next;
				onChange(next);
			}
		} catch {
			// Transient herdr failure: keep the last known label and try again.
		}
		schedule();
	};

	schedule();
}

export function stopPolling() {
	stopped = true;
	if (timer) clearTimeout(timer);
	timer = undefined;
}
