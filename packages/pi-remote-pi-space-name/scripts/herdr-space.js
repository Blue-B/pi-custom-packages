// Copied into remote-pi's dist/ by patch-remote-pi-space-name.mjs.
//
// A room belongs to one Herdr pane, not merely its Space: panes in one Space
// need separate mobile tiles, while a Space rename keeps every pane's room.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";

const QUERY_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const RECONNECT_MS = 1_000;
// Herdr replays recent events when a subscription starts. A quiet gap marks
// the boundary between that backlog and live events.
const SUBSCRIPTION_SETTLE_MS = 250;

function herdrBin() {
	return process.env.HERDR_BIN_PATH || "herdr";
}

/** This pane's workspace id, or undefined outside Herdr. */
export function workspaceId() {
	const id = process.env.HERDR_WORKSPACE_ID?.trim();
	return process.env.HERDR_ENV === "1" && id ? id : undefined;
}

/** This pane's stable public Herdr id, or undefined outside Herdr. */
export function paneId() {
	const id = process.env.HERDR_PANE_ID?.trim();
	return process.env.HERDR_ENV === "1" && id ? id : undefined;
}

/** Pulls the label out of `herdr workspace get` output. */
function parseLabel(raw, id) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const workspace =
		parsed?.result?.type === "workspace_info" ? parsed.result.workspace : undefined;
	if (!workspace || workspace.workspace_id !== id) return undefined;
	return typeof workspace.label === "string" ? workspace.label : undefined;
}

// undefined = not read yet, "" = unavailable (don't retry synchronously)
let cachedLabel;

/** Current Space label, or "" outside Herdr / when Herdr cannot answer. */
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
			cachedLabel = "";
		}
	}
	return cachedLabel;
}

/** Display label for one pane, such as `api · w12:p2`. */
export function displayName() {
	const space = label();
	const pane = paneId();
	return space && pane ? `${space} · ${pane}` : space;
}

/** Mesh-safe identity matching the extension's initial `agent_name`. */
export function meshName() {
	const space = label();
	const workspace = workspaceId();
	const fullPane = paneId();
	const pane = fullPane?.slice(fullPane.lastIndexOf(":") + 1);
	return space && workspace && pane
		? `${space}-${workspace}-${pane}`
				.trim()
				.replace(/[/:@#\s]+/g, "-")
				.replace(/-{2,}/g, "-")
				.replace(/^-+|-+$/g, "")
		: "";
}

/** Room id keyed by pane id, so sibling panes cannot collide. */
export function roomId() {
	const id = paneId();
	if (!id) return undefined;
	return createHash("sha256")
		.update(`herdr-pane\0${id}`)
		.digest("base64url")
		.slice(0, 12);
}

let stopped = true;
let socket;
let reconnectTimer;
let settleTimer;

function scheduleReconnect(connect) {
	if (stopped || reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined;
		connect();
	}, RECONNECT_MS);
	reconnectTimer.unref?.();
}

/**
 * Watches Herdr's socket events without polling or child processes. Renames are
 * delivered immediately; a closed pane or Space takes its remote-pi room idle.
 */
export function startWatching(onChange, onGone) {
	const space = workspaceId();
	const pane = paneId();
	const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
	if (!space || !pane || !socketPath || !stopped) return;
	stopped = false;
	label();

	const connect = () => {
		if (stopped) return;
		let buffer = "";
		let ready = false;
		let pendingLabel = cachedLabel;
		const current = createConnection(socketPath);
		socket = current;
		current.setEncoding("utf8");
		current.on("connect", () => {
			current.write(`${JSON.stringify({
				id: `remote-pi:${pane}`,
				method: "events.subscribe",
				params: {
					subscriptions: [
						{ type: "workspace.renamed" },
						{ type: "workspace.closed" },
						{ type: "pane.closed" },
					],
				},
			})}\n`);
		});
		const settle = () => {
			if (settleTimer) clearTimeout(settleTimer);
			settleTimer = setTimeout(() => {
				settleTimer = undefined;
				ready = true;
				if (!stopped && pendingLabel && pendingLabel !== cachedLabel) {
					cachedLabel = pendingLabel;
					void onChange(displayName());
				}
			}, SUBSCRIPTION_SETTLE_MS);
			settleTimer.unref?.();
		};
		current.on("data", (chunk) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				const event = message?.event;
				const data = message?.data;
				if (message?.result?.type === "subscription_started" || (!ready && event)) {
					settle();
				}
				if (event === "workspace_renamed" && data?.workspace_id === space) {
					if (typeof data.label !== "string") continue;
					if (!ready) {
						pendingLabel = data.label;
					} else if (data.label !== cachedLabel) {
						cachedLabel = data.label;
						void onChange(displayName());
					}
				} else if (
					(event === "workspace_closed" && data?.workspace_id === space) ||
					(event === "pane_closed" && data?.pane_id === pane)
				) {
					stopWatching();
					onGone?.();
				}
			}
		});
		current.on("error", () => {});
		current.on("close", () => {
			if (socket === current) socket = undefined;
			if (settleTimer) clearTimeout(settleTimer);
			settleTimer = undefined;
			scheduleReconnect(connect);
		});
		current.unref?.();
	};

	connect();
}

export function stopWatching() {
	stopped = true;
	if (reconnectTimer) clearTimeout(reconnectTimer);
	if (settleTimer) clearTimeout(settleTimer);
	reconnectTimer = undefined;
	settleTimer = undefined;
	const current = socket;
	socket = undefined;
	current?.destroy();
}
