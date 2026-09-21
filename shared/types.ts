/** Types shared by client and server. Type-only: erased at runtime, so no build step. */

export type Role = "host" | "ta" | "student" | "watcher";
export type QueueType = "approval" | "help";
export type StudentStatus = "waiting" | "assigned" | "completed" | "removed";

/** A queued student, as everyone in the room may see them. */
export interface StudentView {
  id: string;
  name: string;
  ticket: number;
  queue: QueueType;
  status: StudentStatus;
  connected: boolean;
}

/** A TA and who they are currently with. */
export interface TAView {
  id: string;
  name: string;
  isHost: boolean;
  connected: boolean;
  current: { id: string; name: string; ticket: number; queue: QueueType } | null;
}

/** Public room state. Broadcast to every socket in the room — never contains taCode. */
export interface RoomState {
  studentCode: string;
  /** What the session is for, e.g. "DAT120 oving 3". Empty when the host skipped it. */
  title: string;
  approval: StudentView[];
  help: StudentView[];
  tas: TAView[];
  approvedCount: number;
  helpedCount: number;
}

/** Private per-student view, sent only to that student's socket. */
export interface StudentState {
  id: string;
  name: string;
  ticket: number;
  queue: QueueType;
  status: StudentStatus;
  /** Waiting students only: how many in the same queue hold a lower ticket. */
  ahead: number;
  /** Set once a TA has taken them. */
  taName: string | null;
}

export interface CreateRoomResult {
  studentCode: string;
  taCode: string;
  taId: string;
  isHost: true;
}

export interface JoinTAResult {
  studentCode: string;
  taId: string;
  name: string;
  isHost: boolean;
  /** Host only. Regular TAs get their code from the host out-of-band. */
  taCode?: string;
}

export interface JoinStudentResult {
  studentId: string;
  ticket: number;
  queue: QueueType;
}

/** Every socket call answers with one of these. */
export type Ack<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ClientToServer {
  "room:create": (p: { taName: string; title?: string }, ack: (r: Ack<CreateRoomResult>) => void) => void;
  /** Public lookup with no membership: lets the join page name the room before you join. */
  "room:info": (p: { studentCode: string }, ack: (r: Ack<{ studentCode: string; title: string }>) => void) => void;
  "room:close": (p: Record<string, never>, ack: (r: Ack<null>) => void) => void;
  /** Read-only subscribe, used by the projector window. Answers with the current state. */
  "room:watch": (p: { studentCode: string }, ack: (r: Ack<RoomState>) => void) => void;
  "ta:join": (p: { studentCode: string; taCode: string; name: string }, ack: (r: Ack<JoinTAResult>) => void) => void;
  "ta:resume": (p: { studentCode: string; taId: string }, ack: (r: Ack<JoinTAResult>) => void) => void;
  "ta:take": (p: { studentId: string }, ack: (r: Ack<null>) => void) => void;
  "ta:complete": (p: Record<string, never>, ack: (r: Ack<null>) => void) => void;
  /** The called student never came: take them out without counting the session. */
  "ta:remove": (p: { studentId: string }, ack: (r: Ack<null>) => void) => void;
  /** Hand a taken student back to their queue, keeping their ticket number. */
  "ta:requeue": (p: { studentId: string }, ack: (r: Ack<null>) => void) => void;
  /** Host only: take another TA out of the room. */
  "ta:kick": (p: { taId: string }, ack: (r: Ack<null>) => void) => void;
  "student:join": (p: { studentCode: string; name: string; queue: QueueType }, ack: (r: Ack<JoinStudentResult>) => void) => void;
  "student:resume": (p: { studentCode: string; studentId: string }, ack: (r: Ack<JoinStudentResult>) => void) => void;
  "student:leave": (p: Record<string, never>, ack: (r: Ack<null>) => void) => void;
}

export interface ServerToClient {
  "room:state": (state: RoomState) => void;
  "student:state": (state: StudentState) => void;
  "room:closed": (p: { reason: string }) => void;
  /** Sent to one TA's own sockets when the host removes them. */
  "ta:removed": (p: { reason: string }) => void;
}
