import type { Server, Socket } from "socket.io";
import type { Ack, ClientToServer, ServerToClient } from "@shared/types.js";
import { config } from "./config.js";
import { RoomError, RoomManager, type Room } from "./roomManager.js";
import { roomState, studentState } from "./views.js";

export type TAQueueServer = Server<ClientToServer, ServerToClient>;
type TAQueueSocket = Socket<ClientToServer, ServerToClient>;

/** Who this socket is. Set by the server on join and never taken from the client afterwards. */
interface Session {
  roomId: string;
  role: "host" | "ta" | "student" | "watcher";
  taId?: string;
  studentId?: string;
}

const sessions = new WeakMap<TAQueueSocket, Session>();
const rateState = new WeakMap<TAQueueSocket, { count: number; resetAt: number }>();

function withinRateLimit(socket: TAQueueSocket): boolean {
  const now = Date.now();
  const s = rateState.get(socket);
  if (!s || now > s.resetAt) {
    rateState.set(socket, { count: 1, resetAt: now + config.rateLimit.windowMs });
    return true;
  }
  s.count++;
  return s.count <= config.rateLimit.max;
}

const ok = <T>(data: T): Ack<T> => ({ ok: true, data });
const fail = (error: string): Ack<never> => ({ ok: false, error });

export function registerHandlers(io: TAQueueServer, rooms: RoomManager): void {
  /** Push the public state to the room, plus a private state to each student. */
  const broadcast = (room: Room) => {
    io.to(room.id).emit("room:state", roomState(room));
    for (const student of room.students.values()) {
      const mine = studentState(room, student);
      for (const socketId of student.sockets) io.to(socketId).emit("student:state", mine);
    }
  };

  rooms.onChange = broadcast;
  rooms.onClose = (room, reason) => {
    io.to(room.id).emit("room:closed", { reason });
    io.in(room.id).socketsLeave(room.id);
  };

  /**
   * Wraps every handler: rate limit, run, answer, broadcast. Domain errors reach the user
   * as plain sentences; anything else is logged and reported generically.
   */
  const handle = <P, R>(
    socket: TAQueueSocket,
    event: string,
    run: (payload: P) => { result: R; room?: Room },
  ) => {
    return (payload: P, ack?: (r: Ack<R>) => void) => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (!withinRateLimit(socket)) return reply(fail("Slow down for a moment, then try again."));
      try {
        const { result, room } = run(payload ?? ({} as P));
        reply(ok(result));
        if (room) broadcast(room);
      } catch (err) {
        if (err instanceof RoomError) return reply(fail(err.message));
        console.error(`[${event}]`, err);
        reply(fail("Something went wrong. Try again."));
      }
    };
  };

  /** studentCode per socket, so a closed room is detected without holding a Room reference. */
  const sessionCode = new WeakMap<TAQueueSocket, string>();

  /** Resolve this socket's session and its still-live room, or throw a user-facing error. */
  const requireRoom = (socket: TAQueueSocket): { session: Session; room: Room } => {
    const session = sessions.get(socket);
    if (!session) throw new RoomError("You are not in a room.");
    let room: Room;
    try {
      room = rooms.getByStudentCode(sessionCode.get(socket) ?? "");
    } catch {
      throw new RoomError("This room has been closed.");
    }
    if (room.id !== session.roomId) throw new RoomError("This room has been closed.");
    return { session, room };
  };

  const requireStaff = (socket: TAQueueSocket) => {
    const { session, room } = requireRoom(socket);
    if (session.role !== "host" && session.role !== "ta") throw new RoomError("Only TAs can do that.");
    const ta = session.taId ? room.tas.get(session.taId) : undefined;
    if (!ta) throw new RoomError("Your TA session has ended. Join the room again.");
    return { session, room, ta };
  };

  const requireStudent = (socket: TAQueueSocket) => {
    const { session, room } = requireRoom(socket);
    if (session.role !== "student") throw new RoomError("That action is for students.");
    const student = session.studentId ? room.students.get(session.studentId) : undefined;
    if (!student) throw new RoomError("Your ticket has expired.");
    return { room, student };
  };

  const assertFree = (socket: TAQueueSocket) => {
    if (sessions.has(socket)) throw new RoomError("This tab is already in a room.");
  };

  const bind = (socket: TAQueueSocket, room: Room, session: Session) => {
    const previous = sessions.get(socket);
    if (previous && previous.roomId !== room.id) socket.leave(previous.roomId);
    sessions.set(socket, session);
    sessionCode.set(socket, room.studentCode);
    socket.join(room.id);
  };

  io.on("connection", (socket) => {
    socket.on(
      "room:create",
      handle(socket, "room:create", ({ taName, title }: { taName: string; title?: string }) => {
        assertFree(socket);
        const { room, host } = rooms.createRoom(taName, title);
        bind(socket, room, { roomId: room.id, role: "host", taId: host.id });
        rooms.attachTA(room, host, socket.id);
        return {
          result: { studentCode: room.studentCode, taCode: room.taCode, taId: host.id, isHost: true as const },
          room,
        };
      }),
    );

    socket.on(
      "ta:join",
      handle(socket, "ta:join", ({ studentCode, taCode, name }: { studentCode: string; taCode: string; name: string }) => {
        assertFree(socket);
        const room = rooms.getByStudentCode(studentCode);
        const ta = rooms.joinTA(room, taCode, name);
        bind(socket, room, { roomId: room.id, role: "ta", taId: ta.id });
        rooms.attachTA(room, ta, socket.id);
        return { result: { studentCode: room.studentCode, taId: ta.id, name: ta.name, isHost: false }, room };
      }),
    );

    socket.on(
      "ta:resume",
      handle(socket, "ta:resume", ({ studentCode, taId }: { studentCode: string; taId: string }) => {
                const room = rooms.getByStudentCode(studentCode);
        const ta = rooms.resumeTA(room, taId);
        bind(socket, room, { roomId: room.id, role: ta.isHost ? "host" : "ta", taId: ta.id });
        rooms.attachTA(room, ta, socket.id);
        return {
          result: {
            studentCode: room.studentCode,
            taId: ta.id,
            name: ta.name,
            isHost: ta.isHost,
            // The TA code is only ever sent to the host's own socket.
            ...(ta.isHost ? { taCode: room.taCode } : {}),
          },
          room,
        };
      }),
    );

    socket.on(
      "ta:take",
      handle(socket, "ta:take", ({ studentId }: { studentId: string }) => {
        const { room, ta } = requireStaff(socket);
        rooms.take(room, ta, studentId);
        return { result: null, room };
      }),
    );

    socket.on(
      "ta:complete",
      handle(socket, "ta:complete", () => {
        const { room, ta } = requireStaff(socket);
        rooms.complete(room, ta);
        return { result: null, room };
      }),
    );

    socket.on(
      "ta:remove",
      handle(socket, "ta:remove", ({ studentId }: { studentId: string }) => {
        const { room } = requireStaff(socket);
        rooms.removeStudent(room, studentId);
        return { result: null, room };
      }),
    );

    socket.on(
      "ta:requeue",
      handle(socket, "ta:requeue", ({ studentId }: { studentId: string }) => {
        const { room } = requireStaff(socket);
        rooms.requeue(room, studentId);
        return { result: null, room };
      }),
    );

    socket.on(
      "ta:kick",
      handle(socket, "ta:kick", ({ taId }: { taId: string }) => {
        const { session, room } = requireRoom(socket);
        if (session.role !== "host" || session.taId !== room.hostId) {
          throw new RoomError("Only the host can remove a TA.");
        }
        const kicked = rooms.kickTA(room, taId);
        for (const socketId of kicked.sockets) {
          io.to(socketId).emit("ta:removed", { reason: "The host removed you from this room." });
          io.in(socketId).socketsLeave(room.id);
        }
        return { result: null, room };
      }),
    );

    socket.on(
      "room:close",
      handle(socket, "room:close", () => {
        const { session, room } = requireRoom(socket);
        if (session.role !== "host" || session.taId !== room.hostId) {
          throw new RoomError("Only the host can close the room.");
        }
        rooms.closeRoom(room, "The host closed this room.");
        return { result: null };
      }),
    );

    socket.on(
      "room:info",
      handle(socket, "room:info", ({ studentCode }: { studentCode: string }) => {
        // Deliberately binds nothing: the join page asks this before anyone has joined.
        const room = rooms.getByStudentCode(studentCode);
        return { result: { studentCode: room.studentCode, title: room.title } };
      }),
    );

    socket.on(
      "room:watch",
      handle(socket, "room:watch", ({ studentCode }: { studentCode: string }) => {
                const room = rooms.getByStudentCode(studentCode);
        // No TA and no ticket: this socket only ever receives the public state.
        bind(socket, room, { roomId: room.id, role: "watcher" });
        return { result: roomState(room) };
      }),
    );

    socket.on(
      "student:join",
      handle(socket, "student:join", ({ studentCode, name, queue }: { studentCode: string; name: string; queue: "approval" | "help" }) => {
        assertFree(socket);
        const room = rooms.getByStudentCode(studentCode);
        const student = rooms.joinQueue(room, name, queue);
        bind(socket, room, { roomId: room.id, role: "student", studentId: student.id });
        rooms.attachStudent(room, student, socket.id);
        return { result: { studentId: student.id, ticket: student.ticket, queue: student.queue }, room };
      }),
    );

    socket.on(
      "student:resume",
      handle(socket, "student:resume", ({ studentCode, studentId }: { studentCode: string; studentId: string }) => {
                const room = rooms.getByStudentCode(studentCode);
        const student = rooms.resumeStudent(room, studentId);
        bind(socket, room, { roomId: room.id, role: "student", studentId: student.id });
        rooms.attachStudent(room, student, socket.id);
        return { result: { studentId: student.id, ticket: student.ticket, queue: student.queue }, room };
      }),
    );

    socket.on(
      "student:leave",
      handle(socket, "student:leave", () => {
        const { room, student } = requireStudent(socket);
        rooms.leaveQueue(room, student);
        sessions.delete(socket);
        socket.leave(room.id);
        return { result: null, room };
      }),
    );

    socket.on("disconnect", () => {
      const session = sessions.get(socket);
      if (!session) return;
      sessions.delete(socket);
      let room: Room;
      try {
        room = rooms.getByStudentCode(sessionCode.get(socket) ?? "");
      } catch {
        return; // room already gone
      }
      if (room.id !== session.roomId) return;
      if (session.role === "watcher") return;

      // Only this socket goes; any other tab of theirs keeps them present.
      if (session.role === "student") {
        const student = session.studentId ? room.students.get(session.studentId) : undefined;
        if (student) rooms.detachStudent(room, student, socket.id);
      } else {
        const ta = session.taId ? room.tas.get(session.taId) : undefined;
        if (ta) rooms.detachTA(room, ta, socket.id);
      }
      broadcast(room);
    });
  });
}
