#!/usr/bin/env node
// patch-remote-pi-space-name: title each mobile tile from its Herdr pane.
//
// remote-pi names a room after the agent's mesh identity, and derives the room
// id from (cwd, name). Herdr panes often share one cwd, so labels alone collide.
// A pane id is stable and unique within a running Herdr session.
//
// This uses `Space · wN:pN` for the announced name and the pane id for the room
// id. Herdr socket events update a renamed Space immediately without polling,
// while sibling panes remain separate and closed panes go idle.
//
// Idempotent: re-run after `pi update` or a remote-pi reinstall. A no-op if
// already patched. Outside herdr the injected code is inert.
//
// Usage:
//   node patch-remote-pi-space-name.mjs [path/to/remote-pi/dist] [--check]
import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "__herdrSpace";
const PATCH_VERSION = "__herdrSpace:event-v1";
const RUNTIME = "herdr-space.js";
const HERE = dirname(fileURLToPath(import.meta.url));

function resolveDist() {
	const fromArgv = process.argv.slice(2).find((a) => !a.startsWith("--"));
	if (fromArgv) return fromArgv;
	const candidates = [
		process.env.REMOTE_PI_DIST,
		join(process.env.HOME ?? "", ".pi/agent/npm/node_modules/remote-pi/dist"),
		// node lives at <prefix>/bin/node; globals at <prefix>/lib/node_modules.
		join(dirname(dirname(process.execPath)), "lib/node_modules/remote-pi/dist"),
	].filter(Boolean);
	return candidates.find((p) => existsSync(join(p, "index.js"))) ?? candidates[0];
}

const DIST = resolveDist();
const CHECK_ONLY = process.argv.includes("--check");
const INDEX = join(DIST, "index.js");
const ROOMS = join(DIST, "rooms.js");

for (const f of [INDEX, ROOMS]) {
	if (!existsSync(f)) {
		console.error(`anchor not found: missing ${f}`);
		console.error("Pass the remote-pi dist directory explicitly, or set REMOTE_PI_DIST.");
		process.exit(1);
	}
}

const index = readFileSync(INDEX, "utf8");
const rooms = readFileSync(ROOMS, "utf8");

const HANDLERS = `import * as ${MARKER} from "./${RUNTIME}";
// ${PATCH_VERSION}
// Herdr events rename both the mesh identity and the existing pane room.
async function __herdrRelabel() {
    const label = ${MARKER}.displayName();
    if (!label)
        return;
    const meshName = ${MARKER}.meshName();
    if (_meshNode && meshName && _meshNode.name() !== meshName) {
        try {
            await _meshNode.rename(meshName);
        }
        catch { /* relay name still updates even if the local mesh is unavailable */ }
    }
    if (_myRoomMeta)
        _myRoomMeta = { ..._myRoomMeta, name: label, display_name: label };
    try {
        _relay?.close();
    }
    catch { /* already closed, the reconnect path re-announces anyway */ }
    try {
        _refreshFooter();
    }
    catch { /* no TUI attached */ }
}
function __herdrPaneClosed() {
    _goIdle("herdr_pane_closed");
}`;

const LEGACY_HANDLERS = `import * as ${MARKER} from "./${RUNTIME}";
// Renaming a Herdr Space re-announces this pane under its new name. The room
// id stays tied to the pane, so a rename updates the existing tile.
function __herdrRelabel() {
    const label = ${MARKER}.displayName();
    if (!label)
        return;
    if (_myRoomMeta)
        _myRoomMeta = { ..._myRoomMeta, name: label, display_name: label };
    try {
        _relay?.close();
    }
    catch { /* already closed, the reconnect path re-announces anyway */ }
    try {
        _refreshFooter();
    }
    catch { /* no TUI attached */ }
}
function __herdrPaneClosed() {
    _goIdle("herdr_pane_closed");
}`;

function applyAll(source, edits, file) {
	let out = source;
	for (const [from, to] of edits) {
		const hits = out.split(from).length - 1;
		if (hits !== 1) {
			console.error(`anchor not found: ${hits} matches in ${file} for:\n${from}`);
			console.error("remote-pi's compiled output changed. This patch needs updating.");
			process.exit(1);
		}
		out = out.replace(from, to);
	}
	return out;
}

if (index.includes(PATCH_VERSION) && rooms.includes(MARKER)) {
	if (!CHECK_ONLY) cpSync(join(HERE, RUNTIME), join(DIST, RUNTIME));
	console.log(`already patched: ${DIST}`);
	process.exit(0);
}

if (index.includes(MARKER) && rooms.includes(MARKER)) {
	if (CHECK_ONLY) {
		console.log(`outdated patch: ${DIST}`);
		process.exit(1);
	}
	const upgraded = applyAll(
		index,
		[
			[LEGACY_HANDLERS, HANDLERS],
			[`${MARKER}.startPolling(__herdrRelabel, __herdrPaneClosed);`, `${MARKER}.startWatching(__herdrRelabel, __herdrPaneClosed);`],
			[`${MARKER}.stopPolling();`, `${MARKER}.stopWatching();`],
		],
		"index.js",
	);
	cpSync(join(HERE, RUNTIME), join(DIST, RUNTIME));
	writeFileSync(INDEX, upgraded);
	console.log(`upgraded patch: ${DIST}`);
	console.log("Restart each pi session once to load the event-driven integration.");
	process.exit(0);
}

if (CHECK_ONLY) {
	console.log(`not patched: ${DIST}`);
	process.exit(1);
}

// [anchor, replacement] pairs. Every `from` must appear exactly once, so a
// remote-pi release that moves one of these fails loudly instead of silently
// half-patching.
const INDEX_EDITS = [
	[
		'import { Box, Container, Image, Text } from "@earendil-works/pi-tui";',
		`import { Box, Container, Image, Text } from "@earendil-works/pi-tui";\n${HANDLERS}`,
	],
	[
		`function _displayName(cwd) {
    if (_meshNode)`,
		`function _displayName(cwd) {
    const herdrLabel = ${MARKER}.displayName();
    if (herdrLabel)
        return herdrLabel;
    if (_meshNode)`,
	],
	[
		`    _myRoomId = roomId;
    _state = "started";`,
		`    _myRoomId = roomId;
    _state = "started";
    ${MARKER}.startWatching(__herdrRelabel, __herdrPaneClosed);`,
	],
	[
		`function _goIdle(byeReason) {
    _rootLifecycleGeneration += 1;`,
		`function _goIdle(byeReason) {
    ${MARKER}.stopWatching();
    _rootLifecycleGeneration += 1;`,
	],
	[
		"            agentName: _meshNode?.name(),",
		`            agentName: ${MARKER}.displayName() || _meshNode?.name(),`,
	],
];

const ROOMS_EDITS = [
	[
		'import { createHash } from "node:crypto";',
		`import { createHash } from "node:crypto";\nimport * as ${MARKER} from "./${RUNTIME}";`,
	],
	[
		`export function roomIdFor(cwd, name) {
    if (!name || name === defaultAgentName(cwd))`,
		`export function roomIdFor(cwd, name) {
    // Keyed by Herdr pane id: sibling panes get separate rooms, and a Space
    // rename leaves the existing pane room unchanged.
    const herdrRoom = ${MARKER}.roomId();
    if (herdrRoom)
        return herdrRoom;
    if (!name || name === defaultAgentName(cwd))`,
	],
];

const patchedIndex = applyAll(index, INDEX_EDITS, "index.js");
const patchedRooms = applyAll(rooms, ROOMS_EDITS, "rooms.js");

copyFileSync(INDEX, `${INDEX}.bak-space-name`);
copyFileSync(ROOMS, `${ROOMS}.bak-space-name`);
cpSync(join(HERE, RUNTIME), join(DIST, RUNTIME));
writeFileSync(INDEX, patchedIndex);
writeFileSync(ROOMS, patchedRooms);

console.log(`patched: ${DIST}`);
console.log("Restart each pi session once to load the event-driven integration.");
