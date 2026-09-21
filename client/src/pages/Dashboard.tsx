import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { JoinTAResult, RoomState } from "@shared/types";
import { call, message, resetSocket, socket } from "../lib/socket";
import { useReattach } from "../lib/useReattach";
import { lastName, taSession } from "../lib/session";
import { Button, ErrorNote, Field, Screen } from "../components/ui";
import { JoinBanner } from "../components/JoinBanner";
import { QueuePanel } from "../components/QueuePanel";
import { TAPanel } from "../components/TAPanel";

type Phase = "loading" | "join" | "ready" | "closed" | "kicked";

export default function Dashboard() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("loading");
  const [me, setMe] = useState<JoinTAResult | null>(null);
  const [state, setState] = useState<RoomState | null>(null);
  const [closedReason, setClosedReason] = useState("");
  const [notice, setNotice] = useState("");

  const flash = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((current) => (current === text ? "" : current)), 4000);
  }, []);

  // Runs again on every reconnect, so a sleeping laptop wakes straight back into the board.
  useReattach(async () => {
    const saved = taSession.get(code);
    if (!saved) return setPhase("join");
    try {
      const result = await call<JoinTAResult>("ta:resume", { studentCode: code, taId: saved.taId });
      setMe(result);
      setPhase("ready");
    } catch {
      taSession.clear();
      setPhase("join");
    }
  });

  useEffect(() => {
    const onState = (next: RoomState) => setState(next);
    const onClosed = ({ reason }: { reason: string }) => {
      taSession.clear();
      setClosedReason(reason);
      setPhase("closed");
    };
    const onKicked = ({ reason }: { reason: string }) => {
      taSession.clear();
      setClosedReason(reason);
      setPhase("kicked");
    };
    socket.on("room:state", onState);
    socket.on("room:closed", onClosed);
    socket.on("ta:removed", onKicked);
    return () => {
      socket.off("room:state", onState);
      socket.off("room:closed", onClosed);
      socket.off("ta:removed", onKicked);
    };
  }, []);

  const take = async (studentId: string) => {
    try {
      await call("ta:take", { studentId });
    } catch (err) {
      flash(message(err));
    }
  };

  const complete = async () => {
    try {
      await call("ta:complete");
    } catch (err) {
      flash(message(err));
    }
  };

  const removeStudent = async (studentId: string) => {
    try {
      await call("ta:remove", { studentId });
    } catch (err) {
      flash(message(err));
    }
  };

  const requeue = async (studentId: string) => {
    try {
      await call("ta:requeue", { studentId });
    } catch (err) {
      flash(message(err));
    }
  };

  const kick = async (taId: string) => {
    try {
      await call("ta:kick", { taId });
    } catch (err) {
      flash(message(err));
    }
  };

  const closeRoom = async () => {
    try {
      await call("room:close");
    } catch (err) {
      flash(message(err));
    }
  };

  if (phase === "loading") {
    return (
      <Screen>
        <div className="flex-1 grid place-items-center text-muted">Connecting…</div>
      </Screen>
    );
  }

  if (phase === "closed" || phase === "kicked") {
    return (
      <Screen>
        <div className="flex-1 grid place-items-center px-5 text-center">
          <div>
            <h1 className="text-5xl font-black tracking-tight">
              {phase === "kicked" ? "Removed from the room" : "Room closed"}
            </h1>
            <p className="mt-3 text-lg text-muted">{closedReason}</p>
            <Button className="mt-8" onClick={() => navigate("/")}>
              Back to start
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  if (phase === "join" || !me) {
    return (
      <TAJoinForm
        code={code}
        onJoined={(result) => {
          setMe(result);
          setPhase("ready");
        }}
      />
    );
  }

  const mine = state?.tas.find((t) => t.id === me.taId) ?? null;
  const canTake = mine !== null && mine.current === null;

  return (
    <Screen>
      <JoinBanner
        studentCode={code}
        title={state?.title}
        taCode={me.taCode}
        onClose={me.isHost ? closeRoom : undefined}
        onPresent={me.isHost ? () => openProjector(code) : undefined}
      />

      <div className="flex-1 mx-auto w-full max-w-[1600px] px-5 sm:px-8 py-6 sm:py-8 flex flex-col gap-6">
        {notice && <ErrorNote>{notice}</ErrorNote>}

        <Counters approved={state?.approvedCount ?? 0} helped={state?.helpedCount ?? 0} />

        <TAPanel
          tas={state?.tas ?? []}
          myTaId={me.taId}
          onComplete={complete}
          onRemove={removeStudent}
          onRequeue={requeue}
          isHost={me.isHost}
          onKick={kick}
        />

        {!canTake && mine?.current && (
          <p className="text-muted text-lg">
            Finish with #{mine.current.ticket} {mine.current.name} before taking the next student.
          </p>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <QueuePanel
            queue="approval"
            title="Approval"
            students={state?.approval ?? []}
            canTake={canTake}
            onTake={take}
            onRemove={removeStudent}
          />
          <QueuePanel
            queue="help"
            title="Help"
            students={state?.help ?? []}
            canTake={canTake}
            onTake={take}
            onRemove={removeStudent}
          />
        </div>
      </div>
    </Screen>
  );
}

/**
 * The projector shows a read-only board, so the host can drag this window to the second
 * display and keep picking students on the laptop screen. Named, so a second click
 * refocuses the same window instead of opening another.
 */
function openProjector(code: string) {
  window.open(`/present/${code}`, `ta-queue-projector-${code}`, "width=1280,height=800");
}

function Counters({ approved, helped }: { approved: number; helped: number }) {
  return (
    <section className="grid grid-cols-2 gap-6 rounded-2xl bg-paper border border-line px-6 py-4">
      <div className="flex items-baseline gap-3">
        <p className="num text-4xl font-black tracking-tight leading-none">{approved}</p>
        <p className="text-base font-bold text-approval">Approved</p>
      </div>
      <div className="flex items-baseline gap-3">
        <p className="num text-4xl font-black tracking-tight leading-none">{helped}</p>
        <p className="text-base font-bold text-help">Helped</p>
      </div>
    </section>
  );
}

function TAJoinForm({ code, onJoined }: { code: string; onJoined: (r: JoinTAResult) => void }) {
  const [name, setName] = useState(lastName.get());
  const [taCode, setTaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await resetSocket();
      const result = await call<JoinTAResult>("ta:join", { studentCode: code, taCode, name });
      lastName.set(name.trim());
      taSession.set({ studentCode: code, taId: result.taId, name: result.name, isHost: result.isHost });
      onJoined(result);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <Screen>
      <div className="flex-1 flex items-center justify-center px-5 py-10">
        <form onSubmit={submit} className="w-full max-w-md flex flex-col gap-5">
          <div>
            <p className="text-sm font-semibold text-muted">Room</p>
            <p className="num text-4xl font-black tracking-[0.2em]">{code}</p>
          </div>

          <div className="rounded-2xl bg-paper border border-line p-6 sm:p-8 flex flex-col gap-5">
            <Field
              label="Your name"
              name="ta-name"
              value={name}
              autoComplete="name"
              maxLength={32}
              placeholder="Example: Sara"
              onChange={(e) => setName(e.target.value)}
            />
            <Field
              label="TA code"
              name="ta-code"
              value={taCode.replace(/\D/g, "").slice(0, 6)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="Example: 915284"
              hint="Ask the host for this. It is not shown to students."
              className="num text-2xl tracking-[0.3em] font-bold
                placeholder:text-base placeholder:tracking-normal placeholder:font-medium"
              onChange={(e) => setTaCode(e.target.value)}
            />
            <Button type="submit" size="lg" disabled={busy || !name.trim() || taCode.length < 6}>
              {busy ? "Joining…" : "Join as a TA"}
            </Button>
            {error && <ErrorNote>{error}</ErrorNote>}
          </div>

          <Link to="/" className="text-sm text-muted underline underline-offset-4">
            Back to start
          </Link>
        </form>
      </div>
    </Screen>
  );
}
