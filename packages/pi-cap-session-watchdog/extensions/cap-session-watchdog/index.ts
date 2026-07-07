import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import {
	readdirSync,
	statSync,
	existsSync,
	readlinkSync,
	appendFileSync,
	mkdirSync,
	unlinkSync,
	writeFileSync,
	readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * cap-session-watchdog
 *
 * On-disk session GC for the "screenshot bloat -> infinite compaction / 70MB+
 * session" failure mode. The live image hooks only protect the OUTBOUND wire
 * (cap-context-images drops stale images, normalize-images downscales the rest);
 * neither rewrites the .jsonl, so a long-lived browser session still grows to
 * tens of MB on disk and re-compacts forever from inflated usage metadata.
 *
 * This extension closes that gap. On session_start it sweeps the sessions root
 * at most ONCE per DEBOUNCE window across ALL processes (lockfile + stamp; the
 * old per-process sweep piled up 6-deep under sesh and thrashed the WSL 9p I/O,
 * making every TUI keystroke lag), skips drvfs/9p (/mnt/*) sessions entirely,
 * and for every oversized LOCAL session that is provably IDLE runs the
 * battle-tested cap-session-images.mjs (backup -> temp -> validate -> atomic
 * rename, keeps last N images full, fixes stale usage metadata).
 *
 * SAFETY — never touches an active session:
 *   1. skips any .jsonl currently held open by ANY process (scan /proc/<pid>/fd)
 *   2. skips any .jsonl modified within RECENT_MS (the current/other live window)
 *   3. capping itself is atomic + backed up by the underlying script
 *   4. runs fire-and-forget after a short delay so startup is never blocked
 *   5. never throws; all failures are logged to a file, not to context
 *
 * Env:
 *   PI_SESSION_CAP_OFF=1            disable entirely
 *   PI_SESSION_CAP_THRESHOLD_MB    size floor to scan for stale image blocks (default 5)
 *   PI_SESSION_CAP_KEEP            images kept full per session (default 1)
 *   PI_SESSION_CAP_MAX_FILES       max sessions scanned/capped per sweep (default 50)
 *   PI_SESSION_CAP_BACKUP_DAYS     prune .bak-precap-* older than N days (default 14)
 *   PI_SESSION_CAP_DEBOUNCE_HOURS  min hours between sweeps across all procs (default 6)
 *   PI_SESSION_CAP_INCLUDE_DRVFS=1 also sweep /mnt/* (drvfs/9p) sessions (slow; off by default)
 */

const HOME = homedir();
const SESSIONS_ROOT = join(HOME, ".pi", "agent", "sessions");
// Bundled scripts ship at <package root>/scripts; fall back to the classic
// ~/.pi/agent/scripts location for standalone-extension installs.
const PKG_SCRIPTS_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"scripts",
);
const resolveScript = (name: string): string => {
	const bundled = join(PKG_SCRIPTS_DIR, name);
	if (existsSync(bundled)) return bundled;
	return join(HOME, ".pi", "agent", "scripts", name);
};
const CAP_SCRIPT = resolveScript("cap-session-images.mjs");
// Live-context-size trim: catches the capped-low-usage / silently-grown
// live-context trap that the disk-size + image passes are blind to.
const LIVESIZE_SCRIPT = resolveScript("cap-session-livesize.mjs");
// Protect actively-running sessions: skip anything touched within this window.
const LIVESIZE_MIN_MTIME_SEC = Number(process.env.PI_LIVESIZE_MIN_MTIME) || 600;
const LOG_DIR = join(HOME, ".pi", "agent", "logs");
const LOG_FILE = join(LOG_DIR, "cap-session-watchdog.log");

const DISABLED = process.env.PI_SESSION_CAP_OFF === "1";
const THRESHOLD =
	(Number(process.env.PI_SESSION_CAP_THRESHOLD_MB) || 5) * 1024 * 1024;
const KEEP = Number(process.env.PI_SESSION_CAP_KEEP) || 1;
const MAX_FILES = Number(process.env.PI_SESSION_CAP_MAX_FILES) || 50;
const RECENT_MS = 120_000; // a file touched this recently is treated as active
const BACKUP_DAYS = Number(process.env.PI_SESSION_CAP_BACKUP_DAYS) || 14;
const PER_FILE_TIMEOUT_MS = 180_000;
// Skip drvfs/9p sessions (/mnt/c, /mnt/d ...). Reading MB-scale .jsonl off the
// Windows filesystem in WSL costs tens of seconds each and starves the TUI's
// keystroke rendering. Local (~/.pi) sessions only, unless explicitly opted in.
const INCLUDE_DRVFS = process.env.PI_SESSION_CAP_INCLUDE_DRVFS === "1";
// Cross-process throttle: at most one sweep per DEBOUNCE window across ALL sesh
// sessions, and never two at once (lockfile). Without this, every session_start
// kicked off its own full sweep and they piled up 6-deep.
const DEBOUNCE_MS =
	(Number(process.env.PI_SESSION_CAP_DEBOUNCE_HOURS) || 6) * 3_600_000;
const STALE_LOCK_MS = 2 * 3_600_000;
const SWEEP_LOCK = join(SESSIONS_ROOT, ".cap-sweep.lock");
const SWEEP_STAMP = join(SESSIONS_ROOT, ".cap-sweep.last");

let ranThisProcess = false;

function log(line: string): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* logging must never break a session */
	}
}

/** Every session .jsonl currently held open by any live process. */
function openSessionFiles(): Set<string> {
	const open = new Set<string>();
	let pids: string[];
	try {
		pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
	} catch {
		return open; // not Linux/proc -> fail safe (sweep will still skip by mtime)
	}
	for (const pid of pids) {
		let fds: string[];
		try {
			fds = readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue; // process gone or not ours
		}
		for (const fd of fds) {
			try {
				const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
				if (target.endsWith(".jsonl") && target.includes("/sessions/")) {
					open.add(target);
				}
			} catch {
				/* fd vanished */
			}
		}
	}
	return open;
}

/** Oversized session files that look idle (old mtime). */
function findOversizedIdle(): { path: string; size: number }[] {
	const out: { path: string; size: number }[] = [];
	let dirs: string[];
	try {
		dirs = readdirSync(SESSIONS_ROOT);
	} catch {
		return out;
	}
	const now = Date.now();
	for (const d of dirs) {
		if (!INCLUDE_DRVFS && d.startsWith("--mnt-")) continue; // slow drvfs/9p
		const dirPath = join(SESSIONS_ROOT, d);
		try {
			if (!statSync(dirPath).isDirectory()) continue;
		} catch {
			continue;
		}
		let files: string[];
		try {
			files = readdirSync(dirPath);
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			const p = join(dirPath, f);
			let fst;
			try {
				fst = statSync(p);
			} catch {
				continue;
			}
			if (fst.size < THRESHOLD) continue;
			if (now - fst.mtimeMs < RECENT_MS) continue; // active window
			out.push({ path: p, size: fst.size });
		}
	}
	out.sort((a, b) => b.size - a.size);
	return out;
}

function capOne(path: string): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[CAP_SCRIPT, "--keep", String(KEEP), path],
			{ timeout: PER_FILE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
			(err, stdout) => {
				if (err) resolve(`FAIL ${path}: ${err.message}`);
				else
					resolve(`OK ${path}: ${(stdout || "").trim().replace(/\s+/g, " ")}`);
			},
		);
	});
}

/**
 * Second pass: trim sessions whose REAL live context (last compaction summary
 * + kept messages) has grown past the model-window ceiling, regardless of disk
 * size. Idle-only (PI_LIVESIZE_MIN_MTIME guards active sessions); the script is
 * backup + validate + atomic and a no-op on healthy sessions.
 */
function livesizeSweep(): Promise<string> {
	return new Promise((resolve) => {
		if (!existsSync(LIVESIZE_SCRIPT)) {
			resolve(`livesize script missing: ${LIVESIZE_SCRIPT}`);
			return;
		}
		execFile(
			process.execPath,
			[LIVESIZE_SCRIPT, "--all", "--apply"],
			{
				timeout: PER_FILE_TIMEOUT_MS * 4,
				maxBuffer: 4 * 1024 * 1024,
				env: {
					...process.env,
					PI_LIVESIZE_MIN_MTIME: String(LIVESIZE_MIN_MTIME_SEC),
				},
			},
			(err, stdout) => {
				if (err) resolve(`livesize FAIL: ${err.message}`);
				else resolve(`livesize: ${(stdout || "").trim().replace(/\s+/g, " ")}`);
			},
		);
	});
}

/** Remove stale .bak-precap-* backups so capped 70MB sessions don't pile up. */
function pruneBackups(): void {
	const cutoff = Date.now() - BACKUP_DAYS * 86_400_000;
	let dirs: string[];
	try {
		dirs = readdirSync(SESSIONS_ROOT);
	} catch {
		return;
	}
	for (const d of dirs) {
		if (!INCLUDE_DRVFS && d.startsWith("--mnt-")) continue; // slow drvfs/9p
		const dirPath = join(SESSIONS_ROOT, d);
		let files: string[];
		try {
			if (!statSync(dirPath).isDirectory()) continue;
			files = readdirSync(dirPath);
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.includes(".bak-precap-")) continue;
			const p = join(dirPath, f);
			try {
				if (statSync(p).mtimeMs < cutoff) {
					unlinkSync(p);
					log(`pruned backup ${p}`);
				}
			} catch {
				/* ignore */
			}
		}
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Reason to skip this sweep (debounced, or a live sweep holds the lock), else null. */
function shouldSkipSweep(): string | null {
	try {
		const age = Date.now() - statSync(SWEEP_STAMP).mtimeMs;
		if (age < DEBOUNCE_MS)
			return `debounced (last sweep ${(age / 3_600_000).toFixed(1)}h ago)`;
	} catch {
		/* no stamp yet -> allowed */
	}
	try {
		const { pid, start } = JSON.parse(readFileSync(SWEEP_LOCK, "utf8"));
		if (
			Date.now() - Number(start || 0) < STALE_LOCK_MS &&
			isPidAlive(Number(pid))
		)
			return `another sweep holds lock (pid ${pid})`;
	} catch {
		/* no/invalid/stale lock -> allowed */
	}
	return null;
}

/** Public entry: throttle across processes, then run the body under a lock. */
async function sweep(notify?: (m: string) => void): Promise<void> {
	if (!existsSync(CAP_SCRIPT)) {
		log(`cap script missing: ${CAP_SCRIPT}`);
		return;
	}
	const skip = shouldSkipSweep();
	if (skip) {
		log(`sweep skip: ${skip}`);
		return;
	}
	try {
		writeFileSync(
			SWEEP_LOCK,
			JSON.stringify({ pid: process.pid, start: Date.now() }),
		);
	} catch {
		/* best-effort lock; a rare double sweep is harmless now */
	}
	try {
		await runSweepBody(notify);
	} finally {
		try {
			writeFileSync(SWEEP_STAMP, new Date().toISOString());
		} catch {
			/* ignore */
		}
		try {
			unlinkSync(SWEEP_LOCK);
		} catch {
			/* ignore */
		}
	}
}

async function runSweepBody(notify?: (m: string) => void): Promise<void> {
	if (!existsSync(CAP_SCRIPT)) {
		log(`cap script missing: ${CAP_SCRIPT}`);
		return;
	}
	pruneBackups();
	const open = openSessionFiles();
	const candidates = findOversizedIdle()
		.filter((c) => !open.has(c.path))
		.slice(0, MAX_FILES);
	let freed = 0;
	let done = 0;
	if (candidates.length > 0) {
		log(`sweep start: ${candidates.length} oversized idle session(s)`);
		for (const c of candidates) {
			const before = c.size;
			const res = await capOne(c.path);
			log(res);
			if (res.startsWith("OK")) {
				try {
					freed += before - statSync(c.path).size;
					done++;
				} catch {
					/* ignore */
				}
			}
		}
	}
	// Live-context-size pass (always runs; independent of disk-size candidates above).
	try {
		const ls = await livesizeSweep();
		log(ls);
	} catch (e) {
		log(`livesize error: ${(e as Error)?.message ?? String(e)}`);
	}
	if (done > 0) {
		const msg = `cap-session-watchdog: shrank ${done} idle session(s), freed ~${(
			freed / 1048576
		).toFixed(0)}MB`;
		log(msg);
		if (notify) {
			try {
				notify(msg);
			} catch {
				/* ignore */
			}
		}
	}
}

export default function (pi: ExtensionAPI) {
	if (DISABLED) return;
	pi.on("session_start", async (_event, ctx) => {
		if (ranThisProcess) return;
		ranThisProcess = true;
		// was: ctx.ui.notify(m) — 채팅창 밀림 원인. setStatus로 대체 (상태바만 갱신, 채팅 안 밂)
		const notify =
			ctx?.hasUI && ctx.ui.setStatus
				? (m: string) => {
						try {
							ctx.ui.setStatus("cap-session", m);
						} catch {
							/* ignore */
						}
					}
				: undefined;
		// fire-and-forget: never block session startup on disk GC
		setTimeout(() => {
			sweep(notify).catch((e) =>
				log(`sweep error: ${e?.message ?? String(e)}`),
			);
		}, 2000);
	});
}
