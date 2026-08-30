import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const waitFor = (promise, ms = 2_000) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
	]);

test("uses Herdr socket events without polling", async () => {
	const dir = await mkdtemp(join(tmpdir(), "herdr-space-"));
	const socketPath = join(dir, "herdr.sock");
	const countPath = join(dir, "calls");
	const herdr = join(dir, "herdr");
	await writeFile(
		herdr,
		`#!/bin/sh\necho call >> '${countPath}'\nprintf '%s\\n' '{"id":"test","result":{"type":"workspace_info","workspace":{"workspace_id":"w12","label":"old"}}}'\n`,
	);
	await chmod(herdr, 0o755);

	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w12";
	process.env.HERDR_PANE_ID = "w12:p2";
	process.env.HERDR_SOCKET_PATH = socketPath;
	process.env.HERDR_BIN_PATH = herdr;

	let client;
	let request;
	const server = createServer((connection) => {
		client = connection;
		connection.setEncoding("utf8");
		connection.once("data", (chunk) => {
			request = JSON.parse(chunk.trim());
			connection.write('{"id":"remote-pi:w12:p2","result":{"type":"subscription_started"}}\n');
			connection.write(
				'{"event":"workspace_renamed","data":{"type":"workspace_renamed","workspace_id":"w12","label":"stale"}}\n',
			);
			setTimeout(
				() =>
					connection.write(
						'{"event":"workspace_renamed","data":{"type":"workspace_renamed","workspace_id":"w12","label":"old"}}\n',
					),
				100,
			);
			setTimeout(
				() =>
					connection.write(
						'{"event":"workspace_renamed","data":{"type":"workspace_renamed","workspace_id":"w12","label":"new"}}\n',
					),
				500,
			);
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});

	const runtime = await import(`./herdr-space.js?test=${Date.now()}`);
	let renamed;
	let gone;
	const renamedPromise = new Promise((resolve) => (renamed = resolve));
	const gonePromise = new Promise((resolve) => (gone = resolve));
	runtime.startWatching(renamed, gone);

	assert.equal(await waitFor(renamedPromise), "new · w12:p2");
	assert.equal(runtime.meshName(), "new-w12-p2");
	assert.deepEqual(request.params.subscriptions, [
		{ type: "workspace.renamed" },
		{ type: "workspace.closed" },
		{ type: "pane.closed" },
	]);
	assert.equal((await readFile(countPath, "utf8")).trim().split("\n").length, 1);

	client.write(
		'{"event":"pane_closed","data":{"type":"pane_closed","workspace_id":"w12","pane_id":"w12:p2"}}\n',
	);
	await waitFor(gonePromise);
	runtime.stopWatching();
	await new Promise((resolve) => server.close(resolve));
	await rm(dir, { recursive: true, force: true });
});
