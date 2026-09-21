import type { RoomState, StudentState, StudentView, TAView } from "@shared/types.js";
import type { Room, Student } from "./roomManager.js";

const byTicket = (a: { ticket: number }, b: { ticket: number }) => a.ticket - b.ticket;

const toStudentView = (s: Student): StudentView => ({
  id: s.id,
  name: s.name,
  ticket: s.ticket,
  queue: s.queue,
  status: s.status,
  connected: s.sockets.size > 0,
});

/**
 * The state every socket in the room receives. Deliberately excludes `taCode` and every
 * internal id that is not needed to render, so a student client never holds staff secrets.
 */
export function roomState(room: Room): RoomState {
  const waiting = [...room.students.values()].filter((s) => s.status === "waiting").sort(byTicket);

  const tas: TAView[] = [...room.tas.values()].map((ta) => {
    const current = ta.currentStudentId ? room.students.get(ta.currentStudentId) : undefined;
    return {
      id: ta.id,
      name: ta.name,
      isHost: ta.isHost,
      connected: ta.sockets.size > 0,
      current: current
        ? { id: current.id, name: current.name, ticket: current.ticket, queue: current.queue }
        : null,
    };
  });
  // Host first, then arrival order, so the board does not reshuffle as TAs get busy.
  tas.sort((a, b) => Number(b.isHost) - Number(a.isHost));

  return {
    studentCode: room.studentCode,
    title: room.title,
    approval: waiting.filter((s) => s.queue === "approval").map(toStudentView),
    help: waiting.filter((s) => s.queue === "help").map(toStudentView),
    tas,
    approvedCount: room.approvedCount,
    helpedCount: room.helpedCount,
  };
}

/** The private view for one student: their ticket, their place in line, their TA. */
export function studentState(room: Room, student: Student): StudentState {
  const ahead = [...room.students.values()].filter(
    (s) => s.status === "waiting" && s.queue === student.queue && s.ticket < student.ticket,
  ).length;

  const ta = student.taId ? room.tas.get(student.taId) : undefined;

  return {
    id: student.id,
    name: student.name,
    ticket: student.ticket,
    queue: student.queue,
    status: student.status,
    ahead: student.status === "waiting" ? ahead : 0,
    taName: ta?.name ?? null,
  };
}
