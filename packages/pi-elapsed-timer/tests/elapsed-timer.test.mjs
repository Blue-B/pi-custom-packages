import assert from "node:assert/strict";
import test from "node:test";
import elapsedTimer from "../extensions/elapsed-timer/index.ts";

function setup(t, hasUI = true) {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const handlers = new Map();
	const working = [];
	const statuses = [];
	const ctx = {
		hasUI,
		ui: {
			setWorkingMessage: (text) => working.push(text),
			setStatus: (key, text) => statuses.push({ key, text }),
			theme: { fg: (_color, text) => text },
		},
	};
	elapsedTimer({ on: (event, handler) => handlers.set(event, handler) });
	return { working, statuses, emit: (event) => handlers.get(event)({}, ctx) };
}

test("updates seconds and minutes, then leaves the total in the footer", (t) => {
	const { working, statuses, emit } = setup(t);
	emit("agent_start");
	assert.equal(working.at(-1), "0초 동안 작업 중입니다");
	t.mock.timers.tick(59_000);
	assert.equal(working.at(-1), "59초 동안 작업 중입니다");
	t.mock.timers.tick(1_000);
	assert.equal(working.at(-1), "1분 0초 동안 작업 중입니다");
	t.mock.timers.tick(33_500);
	assert.equal(working.at(-1), "1분 33초 동안 작업 중입니다");
	emit("agent_end");
	assert.equal(working.at(-1), undefined);
	assert.deepEqual(statuses, [{ key: "elapsed", text: "✓ 1분 33초" }]);
	const count = working.length;
	t.mock.timers.tick(10_000);
	assert.equal(working.length, count);
});

test("starts the next run at zero and replaces the previous total", (t) => {
	const { working, statuses, emit } = setup(t);
	emit("agent_start");
	t.mock.timers.tick(4_500);
	emit("agent_end");
	assert.equal(statuses.at(-1).text, "✓ 4초");
	t.mock.timers.tick(20_000);
	emit("agent_start");
	assert.equal(working.at(-1), "0초 동안 작업 중입니다");
	t.mock.timers.tick(2_000);
	emit("agent_end");
	assert.equal(statuses.at(-1).text, "✓ 2초");
});

test("a repeated start stops the old interval", (t) => {
	const { working, emit } = setup(t);
	emit("agent_start");
	t.mock.timers.tick(500);
	emit("agent_start");
	const count = working.length;
	t.mock.timers.tick(1_000);
	assert.equal(working.length, count + 1);
	assert.equal(working.at(-1), "1초 동안 작업 중입니다");
	emit("agent_end");
});

test("a subsecond run restores the working message without replacing the footer", (t) => {
	const { working, statuses, emit } = setup(t);
	emit("agent_start");
	t.mock.timers.tick(5_000);
	emit("agent_end");
	emit("agent_start");
	t.mock.timers.tick(999);
	emit("agent_end");
	assert.equal(working.at(-1), undefined);
	assert.deepEqual(statuses, [{ key: "elapsed", text: "✓ 5초" }]);
});

test("shutdown stops the interval and can run twice", (t) => {
	const { working, emit } = setup(t);
	emit("agent_start");
	t.mock.timers.tick(2_000);
	emit("session_shutdown");
	emit("session_shutdown");
	const count = working.length;
	t.mock.timers.tick(10_000);
	assert.equal(working.length, count);
});

test("runs without UI do not write working messages or footer statuses", (t) => {
	const { working, statuses, emit } = setup(t, false);
	emit("agent_start");
	t.mock.timers.tick(10_000);
	emit("agent_end");
	emit("session_shutdown");
	assert.deepEqual(working, []);
	assert.deepEqual(statuses, []);
});
