import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import type { Ack, RoomState, StudentState } from "@shared/types.js";
import { RoomManager } from "./roomManager.js";
import { registerHandlers, type TAQueueServer } from "./socket.js";

/**
 * The end-to-end scenario from the brief, driven over real sockets against a real server.
 * Every assertion here is something a person would check by hand in two browsers.
 */

let httpServer: HttpServer;
let ioServer: TAQueueServer;
let url = "";
const clients: Client[] = [];

/** A connected socket that keeps the latest state the server pushed to it. */
interface Client {
  socket: Socket;
  room: RoomState | null;
  me: StudentState | null;
  closed: string | null;
  kicked: string | null;
  states: number;
}

function open(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = connect(url, { transports: ["websocket"], forceNew: true });
    const client: Client = { socket, room: null, me: null, closed: null, kicked: null, states: 0 };
    socket.on("room:state", (state: RoomState) => {
      client.room = state;
      client.states++;
    });
    socket.on("student:state", (state: StudentState) => (client.me = state));
    socket.on("room:closed", ({ reason }: { reason: string }) => (client.closed = reason));
    socket.on("ta:removed", ({ reason }: { reason: string }) => (client.kicked = reason));
    socket.on("connect", () => {
      clients.push(client);
      resolve(client);
    });
    socket.on("connect_error", reject);
  });
}

function send<T>(client: Client, event: string, payload: unknown = {}): Promise<Ack<T>> {
  return new Promise((resolve) => client.socket.emit(event, payload, resolve));
}

/** Ack helper for the happy path: fails the test with the server's own message. */
async function ok<T>(client: Client, event: string, payload: unknown = {}): Promise<T> {
  const res = await send<T>(client, event, payload);
  assert.equal(res.ok, true, `${event} failed: ${res.ok ? "" : res.error}`);
  return (res as { ok: true; data: T }).data;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`Timed out waiting for ${what}`);
}

before(async () => {
  httpServer = createServer();
  ioServer = new Server(httpServer, { cors: { origin: true } });
  registerHandlers(ioServer, new RoomManager());
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  for (const c of clients) c.socket.disconnect();
  await ioServer.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("a full lab session", () => {
  test("runs from room creation through to closing", async () => {
    // 1-6. The host creates a room and gets both codes.
    const host = await open();
    const created = await ok<{ studentCode: string; taCode: string; taId: string }>(host, "room:create", {
      taName: "Sara",
    });
    assert.match(created.studentCode, /^\d{6}$/);
    assert.match(created.taCode, /^\d{6}$/);
    assert.notEqual(created.studentCode, created.taCode);

    const code = created.studentCode;
    await waitFor(() => host.room !== null, "the host's first room state");
    assert.equal(host.room?.studentCode, code);

    // 7-15. Four students join; the ticket counter is shared by both queues.
    const alice = await open();
    const bob = await open();
    const charlie = await open();
    const david = await open();

    type Joined = { ticket: number; studentId: string };
    const a = await ok<Joined>(alice, "student:join", { studentCode: code, name: "Alice", queue: "approval" });
    const b = await ok<Joined>(bob, "student:join", { studentCode: code, name: "Bob", queue: "approval" });
    const c = await ok<Joined>(charlie, "student:join", { studentCode: code, name: "Charlie", queue: "help" });
    const d = await ok<Joined>(david, "student:join", { studentCode: code, name: "David", queue: "help" });

    assert.deepEqual([a.ticket, b.ticket, c.ticket, d.ticket], [1, 2, 3, 4]);

    await waitFor(() => (host.room?.approval.length ?? 0) === 2 && (host.room?.help.length ?? 0) === 2, "four students on the board");
    assert.deepEqual(host.room?.approval.map((s) => s.ticket), [1, 2]);
    assert.deepEqual(host.room?.help.map((s) => s.ticket), [3, 4]);

    // Students see their own position and nothing else.
    await waitFor(() => bob.me?.ticket === 2, "Bob's ticket");
    assert.equal(bob.me?.ahead, 1);
    assert.equal(bob.me?.status, "waiting");

    // 16-17. A second TA joins with the TA code.
    const ta2 = await open();
    await ok(ta2, "ta:join", { studentCode: code, taCode: created.taCode, name: "Jonas" });
    await waitFor(() => (host.room?.tas.length ?? 0) === 2, "both TAs on the board");
    assert.deepEqual(host.room?.tas.map((t) => t.name), ["Sara", "Jonas"]);

    // 18-21. The host takes Alice; every client sees it.
    const aliceId = host.room?.approval[0]?.id;
    assert.ok(aliceId);
    await ok(host, "ta:take", { studentId: aliceId });

    await waitFor(() => host.room?.approval.length === 1, "Alice leaving the waiting queue");
    await waitFor(() => ta2.room?.tas[0]?.current?.name === "Alice", "the second TA seeing the same state");
    assert.deepEqual(ta2.room?.tas[0]?.current, {
      id: aliceId,
      name: "Alice",
      ticket: 1,
      queue: "approval",
    });
    await waitFor(() => alice.me?.status === "assigned", "Alice's screen changing");
    assert.equal(alice.me?.taName, "Sara");

    // 22-24. Completing Alice counts an approval and frees the TA.
    await ok(host, "ta:complete");
    await waitFor(() => host.room?.approvedCount === 1, "the approved counter");
    assert.equal(host.room?.helpedCount, 0);
    assert.equal(host.room?.tas[0]?.current, null);
    await waitFor(() => alice.me?.status === "completed", "Alice's completion screen");

    // 25-28. The second TA handles a help request.
    const charlieId = ta2.room?.help[0]?.id;
    assert.ok(charlieId);
    await ok(ta2, "ta:take", { studentId: charlieId });
    await waitFor(() => ta2.room?.tas[1]?.current?.name === "Charlie", "Jonas taking Charlie");
    assert.equal(ta2.room?.tas[1]?.current?.queue, "help");

    await ok(ta2, "ta:complete");
    await waitFor(() => host.room?.helpedCount === 1, "the helped counter");
    assert.equal(host.room?.approvedCount, 1);

    // 29-30. Two TAs grab the same student at the same moment: exactly one wins.
    const bobId = host.room?.approval[0]?.id;
    assert.ok(bobId);
    const results = await Promise.all([
      send(host, "ta:take", { studentId: bobId }),
      send(ta2, "ta:take", { studentId: bobId }),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one TA may take a student");
    const loser = results.find((r) => !r.ok);
    assert.match(loser && !loser.ok ? loser.error : "", /already taken/);

    // 31. A student refreshing their browser keeps their number.
    david.socket.disconnect();
    const davidAgain = await open();
    const back = await ok<Joined>(davidAgain, "student:resume", { studentCode: code, studentId: d.studentId });
    assert.equal(back.ticket, 4);
    await waitFor(() => davidAgain.me?.ticket === 4, "David's ticket surviving a refresh");
    assert.equal(davidAgain.me?.status, "waiting");

    // 32-34. The host closes the room; everyone is told and the code stops working.
    await ok(host, "room:close");
    await waitFor(() => ta2.closed !== null && bob.closed !== null, "everyone hearing the room closed");
    assert.match(ta2.closed ?? "", /host closed/i);

    const rejoin = await send(await open(), "student:join", { studentCode: code, name: "Late", queue: "help" });
    assert.equal(rejoin.ok, false);
    assert.match(rejoin.ok ? "" : rejoin.error, /No room with that code/);
  });
});

describe("permissions", () => {
  let code = "";
  let taCode = "";
  let host: Client;

  before(async () => {
    host = await open();
    const created = await ok<{ studentCode: string; taCode: string }>(host, "room:create", { taName: "Sara" });
    code = created.studentCode;
    taCode = created.taCode;
  });

  test("a wrong TA code is refused", async () => {
    const res = await send(await open(), "ta:join", { studentCode: code, taCode: "000000", name: "Mallory" });
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /TA code is not right/);
  });

  test("an unknown room code is refused", async () => {
    const res = await send(await open(), "student:join", { studentCode: "999999", name: "Nobody", queue: "help" });
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /No room with that code/);
  });

  test("students cannot take, complete or close", async () => {
    const student = await open();
    await ok(student, "student:join", { studentCode: code, name: "Omar", queue: "help" });
    await waitFor(() => student.room !== null, "the student's room state");

    const victim = student.room?.help[0]?.id ?? "x";
    for (const [event, payload] of [
      ["ta:take", { studentId: victim }],
      ["ta:complete", {}],
      ["room:close", {}],
    ] as const) {
      const res = await send(student, event, payload);
      assert.equal(res.ok, false, `${event} must be refused for students`);
    }
  });

  test("the state a student receives never contains the TA code", async () => {
    const student = await open();
    await ok(student, "student:join", { studentCode: code, name: "Maria", queue: "approval" });
    await waitFor(() => student.room !== null, "the student's room state");

    assert.equal(JSON.stringify(student.room).includes(taCode), false);
    assert.equal(JSON.stringify(student.me).includes(taCode), false);
  });

  test("only the host may close the room", async () => {
    const ta = await open();
    await ok(ta, "ta:join", { studentCode: code, taCode, name: "Jonas" });

    const res = await send(ta, "room:close");
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /Only the host/);
  });

  test("a TA who joins is not handed the TA code back", async () => {
    const ta = await open();
    const joined = await ok<{ taCode?: string }>(ta, "ta:join", { studentCode: code, taCode, name: "Maria" });
    assert.equal(joined.taCode, undefined);
  });

  test("one socket cannot hold two places in the room", async () => {
    const student = await open();
    await ok(student, "student:join", { studentCode: code, name: "Twice", queue: "help" });

    const res = await send(student, "student:join", { studentCode: code, name: "Twice again", queue: "approval" });
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /already in a room/);
  });

  test("leaving the queue frees the number without reusing it", async () => {
    const student = await open();
    const joined = await ok<{ ticket: number }>(student, "student:join", { studentCode: code, name: "Gone", queue: "approval" });
    await ok(student, "student:leave");

    await waitFor(
      () => !host.room?.approval.some((s) => s.ticket === joined.ticket),
      "the leaving student disappearing from the board",
    );
    const next = await ok<{ ticket: number }>(await open(), "student:join", { studentCode: code, name: "Next", queue: "approval" });
    assert.equal(next.ticket, joined.ticket + 1);
  });
});

describe("reconnecting", () => {
  test("the host reloads the dashboard and still sees the TA code", async () => {
    const first = await open();
    const created = await ok<{ studentCode: string; taCode: string; taId: string }>(first, "room:create", {
      taName: "Sara",
    });
    first.socket.disconnect();

    const again = await open();
    const resumed = await ok<{ isHost: boolean; taCode?: string; name: string }>(again, "ta:resume", {
      studentCode: created.studentCode,
      taId: created.taId,
    });

    assert.equal(resumed.isHost, true);
    assert.equal(resumed.name, "Sara");
    assert.equal(resumed.taCode, created.taCode);
  });

  test("a TA who goes quiet keeps their student until another TA hands them back", async () => {
    const host = await open();
    const created = await ok<{ studentCode: string; taCode: string }>(host, "room:create", { taName: "Sara" });

    const ta = await open();
    const joined = await ok<{ taId: string }>(ta, "ta:join", {
      studentCode: created.studentCode,
      taCode: created.taCode,
      name: "Jonas",
    });

    const student = await open();
    await ok(student, "student:join", { studentCode: created.studentCode, name: "Omar", queue: "help" });
    await waitFor(() => (host.room?.help.length ?? 0) === 1, "Omar joining the help queue");

    const omarId = host.room?.help[0]?.id;
    assert.ok(omarId);
    await ok(ta, "ta:take", { studentId: omarId });
    await waitFor(() => host.room?.help.length === 0, "Omar being taken");

    // Jonas shuts his laptop. He must not lose his place or his student.
    ta.socket.disconnect();
    await waitFor(() => host.room?.tas.some((t) => t.name === "Jonas" && !t.connected) === true, "Jonas showing as away");
    assert.equal(host.room?.tas.length, 2, "an away TA stays on the board");
    assert.equal(host.room?.tas.find((t) => t.name === "Jonas")?.current?.name, "Omar");
    assert.equal(host.room?.help.length, 0, "the student is not yanked away automatically");

    // Sara can hand Omar back, and his original number puts him at the front.
    await ok(host, "ta:requeue", { studentId: omarId });
    await waitFor(() => host.room?.help.length === 1, "Omar returning to the queue");
    assert.equal(host.room?.help[0]?.ticket, 1, "the original ticket number is kept");
    assert.equal(host.room?.tas.find((t) => t.name === "Jonas")?.current, null);

    // Jonas comes back to exactly the seat he left.
    const back = await open();
    const resumed = await ok<{ name: string; taCode?: string }>(back, "ta:resume", {
      studentCode: created.studentCode,
      taId: joined.taId,
    });
    assert.equal(resumed.name, "Jonas");
    assert.equal(resumed.taCode, undefined, "a plain TA is never handed the TA code");
    await waitFor(() => host.room?.tas.some((t) => t.name === "Jonas" && t.connected) === true, "Jonas back online");
    assert.equal(host.room?.tas.length, 2, "resuming does not create a second TA");
  });

  test("a refreshed phone shows the live ticket instead of the join form", async () => {
    const host = await open();
    const created = await ok<{ studentCode: string }>(host, "room:create", {
      taName: "Sara",
      title: "DAT120 oving 3",
    });

    const phone = await open();
    const joined = await ok<{ studentId: string; ticket: number }>(phone, "student:join", {
      studentCode: created.studentCode,
      name: "Omar",
      queue: "approval",
    });
    await waitFor(() => (host.room?.approval.length ?? 0) === 1, "Omar on the board");

    // The phone is locked for a while, then the page is reopened: a brand new socket.
    phone.socket.disconnect();
    await new Promise((r) => setTimeout(r, 300));

    const reopened = await open();
    const info = await ok<{ title: string }>(reopened, "room:info", { studentCode: created.studentCode });
    assert.equal(info.title, "DAT120 oving 3", "the join page can name the room before joining");

    const back = await ok<{ ticket: number }>(reopened, "student:resume", {
      studentCode: created.studentCode,
      studentId: joined.studentId,
    });
    assert.equal(back.ticket, joined.ticket, "same number, no rejoin");
    await waitFor(() => reopened.me?.ticket === joined.ticket, "the live ticket arriving");
    assert.equal(host.room?.approval.length, 1, "and still exactly one entry on the board");

    // Even if their storage was wiped and they type their name again, no second entry.
    const wiped = await open();
    const again = await send(wiped, "student:join", {
      studentCode: created.studentCode,
      name: "Omar",
      queue: "approval",
    });
    assert.equal(again.ok, false);
    assert.match(again.ok ? "" : again.error, /already in the queue as number 1/);
    assert.equal(host.room?.approval.length, 1, "the board still shows one Omar");
  });

  test("a stray second tab cannot make a working TA look away", async () => {
    const host = await open();
    const created = await ok<{ studentCode: string; taCode: string; taId: string }>(host, "room:create", {
      taName: "Sara",
    });

    const ta2 = await open();
    await ok(ta2, "ta:join", { studentCode: created.studentCode, taCode: created.taCode, name: "Jonas" });

    const stu = await open();
    const omar = await ok<{ studentId: string }>(stu, "student:join", {
      studentCode: created.studentCode,
      name: "Omar",
      queue: "help",
    });
    await ok(host, "ta:take", { studentId: omar.studentId });
    await waitFor(() => ta2.room?.tas[0]?.current?.name === "Omar", "Sara taking Omar");

    // A second tab in Sara's browser shares her stored session and resumes as her, then closes.
    const strayTab = await open();
    await ok(strayTab, "ta:resume", { studentCode: created.studentCode, taId: created.taId });
    strayTab.socket.disconnect();
    await new Promise((r) => setTimeout(r, 400));

    const sara = ta2.room?.tas.find((t) => t.name === "Sara");
    assert.equal(sara?.connected, true, "Sara's own tab is still open");
    assert.equal(sara?.current?.name, "Omar", "and she still has her student");
  });

  test("a student who closes their phone keeps their number, and Remove clears them", async () => {
    const host = await open();
    const created = await ok<{ studentCode: string }>(host, "room:create", { taName: "Sara" });

    const student = await open();
    const joined = await ok<{ studentId: string; ticket: number }>(student, "student:join", {
      studentCode: created.studentCode,
      name: "Omar",
      queue: "approval",
    });
    await waitFor(() => (host.room?.approval.length ?? 0) === 1, "Omar on the board");

    // Phone locked, tab closed. Nothing should expire.
    student.socket.disconnect();
    await waitFor(() => host.room?.approval[0]?.connected === false, "Omar showing as offline");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(host.room?.approval.length, 1, "an offline student keeps their place");
    assert.equal(host.room?.approval[0]?.ticket, joined.ticket);

    // Called, did not come.
    await ok(host, "ta:take", { studentId: joined.studentId });
    await ok(host, "ta:remove", { studentId: joined.studentId });
    await waitFor(() => host.room?.tas[0]?.current === null, "the TA being free again");
    assert.equal(host.room?.approval.length, 0);
    assert.deepEqual([host.room?.approvedCount, host.room?.helpedCount], [0, 0], "removing counts as nothing");

    // Reopening the phone tells them what happened rather than showing a dead number.
    const again = await open();
    await ok(again, "student:resume", { studentCode: created.studentCode, studentId: joined.studentId });
    await waitFor(() => again.me?.status === "removed", "the student learning their turn passed");
  });

  test("the host removes a TA, who is told and can no longer act", async () => {
    const host = await open();
    const created = await ok<{ studentCode: string; taCode: string }>(host, "room:create", { taName: "Sara" });

    const ta2 = await open();
    await ok(ta2, "ta:join", { studentCode: created.studentCode, taCode: created.taCode, name: "Jonas" });
    await waitFor(() => (host.room?.tas.length ?? 0) === 2, "both TAs on the board");

    const stu = await open();
    const omar = await ok<{ studentId: string; ticket: number }>(stu, "student:join", {
      studentCode: created.studentCode,
      name: "Omar",
      queue: "help",
    });
    await ok(ta2, "ta:take", { studentId: omar.studentId });
    await waitFor(() => host.room?.help.length === 0, "Jonas taking Omar");

    const jonasId = host.room?.tas.find((t) => t.name === "Jonas")?.id;
    assert.ok(jonasId);

    // A plain TA may not do this.
    const refused = await send(ta2, "ta:kick", { taId: jonasId });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /Only the host/);

    await ok(host, "ta:kick", { taId: jonasId });
    await waitFor(() => host.room?.tas.length === 1, "Jonas leaving the board");
    await waitFor(() => host.room?.help.length === 1, "Omar going back to the queue");
    assert.equal(host.room?.help[0]?.ticket, omar.ticket, "keeping his number");
    await waitFor(() => ta2.kicked !== null, "Jonas being told");

    const after = await send(ta2, "ta:take", { studentId: omar.studentId });
    assert.equal(after.ok, false, "a removed TA can no longer act");
  });

  test("any TA can clear a spam entry straight out of the queue", async () => {
    const host = await open();
    const created = await ok<{ studentCode: string; taCode: string }>(host, "room:create", { taName: "Sara" });
    const ta2 = await open();
    await ok(ta2, "ta:join", { studentCode: created.studentCode, taCode: created.taCode, name: "Jonas" });

    const spam = await open();
    const entry = await ok<{ studentId: string }>(spam, "student:join", {
      studentCode: created.studentCode,
      name: "something rude",
      queue: "approval",
    });
    await waitFor(() => (ta2.room?.approval.length ?? 0) === 1, "the entry showing up");

    // Not the host, and without taking them first.
    await ok(ta2, "ta:remove", { studentId: entry.studentId });
    await waitFor(() => ta2.room?.approval.length === 0, "the entry being cleared");
    assert.equal(ta2.room?.tas.find((t) => t.name === "Jonas")?.current, null, "nobody was held");
    assert.deepEqual([ta2.room?.approvedCount, ta2.room?.helpedCount], [0, 0]);
  });

  test("students cannot remove or hand somebody back", async () => {
    const host = await open();
    const created = await ok<{ studentCode: string }>(host, "room:create", { taName: "Sara" });

    const student = await open();
    const joined = await ok<{ studentId: string }>(student, "student:join", {
      studentCode: created.studentCode,
      name: "Omar",
      queue: "help",
    });

    for (const event of ["ta:remove", "ta:requeue"] as const) {
      const res = await send(student, event, { studentId: joined.studentId });
      assert.equal(res.ok, false, `${event} must be refused for students`);
    }
  });
});
