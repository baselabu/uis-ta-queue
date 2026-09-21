import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { JoinStudentResult, QueueType, StudentState } from "@shared/types";
import { call, message, resetSocket, socket } from "../lib/socket";
import { useReattach } from "../lib/useReattach";
import { lastName, studentSession } from "../lib/session";
import { Button, ErrorNote, Field, Screen } from "../components/ui";

const QUEUE_LABEL: Record<QueueType, string> = { approval: "Approval", help: "Help" };

export default function JoinStudent() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<"loading" | "form" | "queued" | "closed">("loading");
  const [me, setMe] = useState<StudentState | null>(null);
  const [name, setName] = useState(lastName.get());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [closedReason, setClosedReason] = useState("");
  const [title, setTitle] = useState("");

  // Runs again on every reconnect, so reopening the phone shows the live ticket.
  useReattach(async () => {
    // Binds nothing, so it is safe whether we go on to resume a ticket or take a new one.
    try {
      const info = await call<{ title: string }>("room:info", { studentCode: code });
      setTitle(info.title);
    } catch {
      /* a bad code is reported properly when they try to join */
    }

    const saved = studentSession.get(code);
    if (!saved) return setPhase("form");
    try {
      await call<JoinStudentResult>("student:resume", { studentCode: code, studentId: saved.studentId });
      setPhase("queued");
    } catch {
      studentSession.clear();
      setPhase("form");
    }
  });

  useEffect(() => {
    const onMe = (state: StudentState) => setMe(state);
    const onClosed = ({ reason }: { reason: string }) => {
      studentSession.clear();
      setClosedReason(reason);
      setPhase("closed");
    };
    socket.on("student:state", onMe);
    socket.on("room:closed", onClosed);
    return () => {
      socket.off("student:state", onMe);
      socket.off("room:closed", onClosed);
    };
  }, []);

  async function join(queue: QueueType) {
    setBusy(true);
    setError("");
    try {
      const result = await call<JoinStudentResult>("student:join", { studentCode: code, name, queue });
      lastName.set(name.trim());
      studentSession.set({ studentCode: code, studentId: result.studentId });
      setPhase("queued");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    try {
      await call("student:leave");
    } catch {
      /* already gone: fall through to the form either way */
    }
    studentSession.clear();
    setMe(null);
    setPhase("form");
    await resetSocket();
  }

  if (phase === "loading") {
    return (
      <Screen>
        <div className="flex-1 grid place-items-center text-muted">Connecting…</div>
      </Screen>
    );
  }

  if (phase === "closed") {
    return (
      <Screen>
        <div className="flex-1 grid place-items-center px-5 text-center">
          <div>
            <h1 className="text-5xl font-black tracking-tight">Room closed</h1>
            <p className="mt-3 text-lg text-muted">{closedReason}</p>
            <Button className="mt-8" onClick={() => navigate("/")}>
              Back to start
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  if (phase === "queued") {
    return me ? (
      <Ticket me={me} title={title} onLeave={leave} />
    ) : (
      <Screen>
        <div className="flex-1 grid place-items-center text-muted">Getting your number…</div>
      </Screen>
    );
  }

  return (
    <Screen>
      <div className="flex-1 flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-md">
          {title ? (
            <>
              <h1 className="text-3xl font-black tracking-tight">{title}</h1>
              <p className="num text-lg font-bold text-muted tracking-[0.2em]">{code}</p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-muted">Room</p>
              <p className="num text-4xl font-black tracking-[0.2em]">{code}</p>
            </>
          )}

          <div className="mt-8 rounded-2xl bg-paper border border-line p-6 sm:p-8 flex flex-col gap-6">
            <Field
              label="Your name"
              name="student-name"
              value={name}
              autoComplete="name"
              maxLength={32}
              placeholder="Example: Omar"
              onChange={(e) => setName(e.target.value)}
            />

            <div>
              <p className="text-sm font-semibold text-muted mb-3">What do you need?</p>
              <div className="grid gap-3">
                <button type="button"
                  disabled={busy || !name.trim()}
                  onClick={() => join("approval")}
                  className="rounded-xl bg-approval text-paper px-6 py-6 text-left transition-colors
                    hover:brightness-110 disabled:bg-muted"
                >
                  <span className="block text-2xl font-bold">Assignment approval</span>
                  <span className="block text-approval-soft">A TA checks your finished work.</span>
                </button>
                <button type="button"
                  disabled={busy || !name.trim()}
                  onClick={() => join("help")}
                  className="rounded-xl bg-help text-paper px-6 py-6 text-left transition-colors
                    hover:brightness-110 disabled:bg-muted"
                >
                  <span className="block text-2xl font-bold">I need help</span>
                  <span className="block text-help-soft">A TA sits with you and works it through.</span>
                </button>
              </div>
            </div>

            {error && <ErrorNote>{error}</ErrorNote>}
          </div>

          <Link to="/" className="mt-6 inline-block text-sm text-muted underline underline-offset-4">
            Use a different room
          </Link>
        </div>
      </div>
    </Screen>
  );
}

function Ticket({ me, title, onLeave }: { me: StudentState; title: string; onLeave: () => void }) {
  const accent = me.queue === "approval" ? "bg-approval" : "bg-help";

  if (me.status === "removed") {
    return (
      <Screen>
        <div className="flex-1 grid place-items-center px-5 text-center">
          <div>
            <p className="num text-2xl font-bold text-muted">#{me.ticket}</p>
            <h1 className="mt-2 text-5xl sm:text-6xl font-black tracking-tight">Your turn passed</h1>
            <p className="mt-3 text-lg text-muted max-w-sm mx-auto">
              A TA called your number and nobody came. Take a new number whenever you are ready.
            </p>
            <Button className="mt-8" onClick={onLeave}>
              Take a new number
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  if (me.status === "completed") {
    return (
      <Screen>
        <div className="flex-1 grid place-items-center px-5 text-center">
          <div>
            <p className="num text-2xl font-bold text-muted">#{me.ticket}</p>
            <h1 className="mt-2 text-5xl sm:text-6xl font-black tracking-tight">
              {me.queue === "approval" ? "Approved" : "All done"}
            </h1>
            <p className="mt-3 text-lg text-muted">
              {me.queue === "approval"
                ? "Your assignment has been approved."
                : "Your help session is finished."}
            </p>
            <Button variant="secondary" className="mt-8" onClick={onLeave}>
              Join another queue
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  if (me.status === "assigned") {
    return (
      <Screen>
        <div className={`flex-1 grid place-items-center px-5 text-center ${accent} text-paper`}>
          <div>
            <p className="num text-3xl font-bold opacity-80">#{me.ticket}</p>
            <h1 className="mt-3 text-[clamp(2.5rem,10vw,5rem)] leading-[0.95] font-black tracking-tight">
              {me.taName} is ready for you
            </h1>
            <p className="mt-4 text-xl opacity-90">Go to your TA now.</p>
          </div>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <div className="flex-1 flex flex-col">
        <div className={`${accent} text-paper px-6 py-4`}>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-lg font-bold">{QUEUE_LABEL[me.queue]}</span>
            <span className="text-lg font-medium opacity-90 truncate">{me.name}</span>
          </div>
          {title && <p className="text-base opacity-80 truncate">{title}</p>}
        </div>

        <div className="flex-1 grid place-items-center px-6 py-10 text-center">
          <div>
            <p className="text-sm font-semibold text-muted">Your number</p>
            <p className="num text-[clamp(6rem,32vw,14rem)] leading-[0.8] font-black tracking-[-0.05em]">
              {me.ticket}
            </p>
            <p className="mt-8 text-2xl font-bold">
              {me.ahead === 0
                ? "You are next in line."
                : me.ahead === 1
                  ? "1 student is ahead of you."
                  : `${me.ahead} students are ahead of you.`}
            </p>
            <p className="mt-2 text-lg text-muted max-w-sm mx-auto">
              You can close this page and keep working. A TA will call your name out loud.
            </p>
          </div>
        </div>

        <div className="px-6 pb-8 text-center">
          <Button variant="quiet" onClick={onLeave}>
            Leave the queue
          </Button>
        </div>
      </div>
    </Screen>
  );
}
