#!/usr/bin/env node
// patch-remote-pi-space-name: make remote-pi title each mobile tile with its
// herdr Space label.
//
// remote-pi names a room after the agent's mesh identity, and derives the room
// id from (cwd, name). Under herdr every Space shares one cwd, so identical
// labels collide and the broker disambiguates them with `#2`, `#3`, ..., which
// is what the phone then shows. Renaming a Space did nothing at all, because
// the name is only sent when the room is announced.
//
// This separates the two: identity stays whatever remote-pi already uses, while
// the announced name and the room id come from herdr. Duplicate labels stay
// duplicates ("~" three times, no suffix), and a rename re-announces the same
// room id, so the tile is renamed in place instead of a new one appearing.
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

if (index.includes(MARKER) && rooms.includes(MARKER)) {
	console.log(`already patched: ${DIST}`);
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
		`import { Box, Container, Image, Text } from "@earendil-works/pi-tui";
import * as ${MARKER} from "./${RUNTIME}";
// Renaming a herdr Space re-announces this room under its new name. The room
// id is unchanged, so the phone renames the existing tile rather than adding
// one; reconnect replays the room meta updated just below.
function __herdrRelabel(label) {
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
}`,
	],
	[
		`function _displayName(cwd) {
    if (_meshNode)`,
		`function _displayName(cwd) {
    const herdrLabel = ${MARKER}.label();
    if (herdrLabel)
        return herdrLabel;
    if (_meshNode)`,
	],
	[
		`    _myRoomId = roomId;
    _state = "started";`,
		`    _myRoomId = roomId;
    _state = "started";
    ${MARKER}.startPolling(__herdrRelabel);`,
	],
	[
		`function _goIdle(byeReason) {
    _rootLifecycleGeneration += 1;`,
		`function _goIdle(byeReason) {
    ${MARKER}.stopPolling();
    _rootLifecycleGeneration += 1;`,
	],
	[
		"            agentName: _meshNode?.name(),",
		`            agentName: ${MARKER}.label() || _meshNode?.name(),`,
	],
];

const ROOMS_EDITS = [
	[
		'import { createHash } from "node:crypto";',
		`import { createHash } from "node:crypto";
import * as ${MARKER} from "./${RUNTIME}";`,
	],
	[
		`export function roomIdFor(cwd, name) {
    if (!name || name === defaultAgentName(cwd))`,
		`export function roomIdFor(cwd, name) {
    // Keyed by workspace id under herdr: identical Space labels must not
    // collide, and a rename must keep the room it already has.
    const herdrRoom = ${MARKER}.roomId();
    if (herdrRoom)
        return herdrRoom;
    if (!name || name === defaultAgentName(cwd))`,
	],
];

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

const patchedIndex = applyAll(index, INDEX_EDITS, "index.js");
const patchedRooms = applyAll(rooms, ROOMS_EDITS, "rooms.js");

copyFileSync(INDEX, `${INDEX}.bak-space-name`);
copyFileSync(ROOMS, `${ROOMS}.bak-space-name`);
cpSync(join(HERE, RUNTIME), join(DIST, RUNTIME));
writeFileSync(INDEX, patchedIndex);
writeFileSync(ROOMS, patchedRooms);

console.log(`patched: ${DIST}`);
console.log("Restart each pi session (a /reload keeps the old module cache).");
