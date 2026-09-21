import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { QueueType, RoomState, StudentView, TAView } from "@shared/types";
import { call, socket } from "../lib/socket";
import { useReattach } from "../lib/useReattach";
import { JoinBanner } from "../components/JoinBanner";
import { Screen } from "../components/ui";

/**
 * The read-only board for the projector. Nobody can scroll a projected screen, so each
 * queue shows only the front of the line and counts the rest.
 */
const VISIBLE_PER_QUEUE = 8;

export default function Present() {
  const { code = "" } = useParams();
  const [state, setState] = useState<RoomState | null>(null);
  const [closed, setClosed] = useState("");
  const [error, setError] = useState("");

  // Re-subscribes on every reconnect: a projector runs untouched for hours.
  useReattach(async () => {
    try {
      setState(await call<RoomState>("room:watch", { studentCode: code }));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open this room.");
    }
  });

  useEffect(() => {
    const onState = (next: RoomState) => setState(next);
    const onClosed = ({ reason }: { reason: string }) => setClosed(reason);
    socket.on("room:state", onState);
    socket.on("room:closed", onClosed);
    return () => {
      socket.off("room:state", onState);
      socket.off("room:closed", onClosed);
    };
  }, []);

  if (error || closed) {
    return (
      <Screen>
        <div className="flex-1 grid place-items-center px-5 text-center">
          <div>
            <h1 className="text-6xl font-black tracking-tight">{closed ? "Room closed" : "Room not found"}</h1>
            <p className="mt-4 text-2xl text-muted">{closed || error}</p>
          </div>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <JoinBanner studentCode={code} title={state?.title} />

      <div className="flex-1 mx-auto w-full max-w-[1600px] px-5 sm:px-8 py-6 flex flex-col gap-6">
        <section className="grid grid-cols-2 gap-6 rounded-2xl bg-paper border border-line px-8 py-6">
          <Total label="Approved" value={state?.approvedCount ?? 0} tone="text-approval" />
          <Total label="Helped" value={state?.helpedCount ?? 0} tone="text-help" />
        </section>

        <TABoard tas={state?.tas ?? []} />

        <div className="grid gap-6 lg:grid-cols-2">
          <Board queue="approval" title="Approval" students={state?.approval ?? []} />
          <Board queue="help" title="Help" students={state?.help ?? []} />
        </div>
      </div>
    </Screen>
  );
}

function Total({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="flex items-baseline gap-4">
      <p className="num text-7xl font-black tracking-tight leading-none">{value}</p>
      <p className={`text-2xl font-bold ${tone}`}>{label}</p>
    </div>
  );
}

function TABoard({ tas }: { tas: TAView[] }) {
  return (
    <section className="rounded-2xl bg-paper border border-line overflow-hidden">
      <div className="flex items-baseline justify-between px-6 py-4 border-b border-line">
        <h2 className="text-3xl font-black tracking-tight">TAs</h2>
        <span className="num text-2xl font-bold text-muted">{tas.filter((t) => !t.current).length} free</span>
      </div>
      <ul className="grid gap-px bg-line sm:grid-cols-2 xl:grid-cols-3">
        {tas.map((ta) => (
          <li key={ta.id} className="bg-paper p-5">
            <p className="text-2xl font-bold truncate">{ta.name}</p>
            {ta.current ? (
              <p className="mt-1 flex items-baseline gap-3">
                <span
                  className={`num text-4xl font-black ${
                    ta.current.queue === "approval" ? "text-approval" : "text-help"
                  }`}
                >
                  #{ta.current.ticket}
                </span>
                <span className="text-xl font-semibold truncate">{ta.current.name}</span>
              </p>
            ) : (
              <p className="mt-1 flex items-center gap-2 text-xl font-bold text-free">
                <span className="inline-block h-3 w-3 rounded-full bg-free" aria-hidden="true" />
                Available
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const TONES: Record<QueueType, { rail: string; block: string; heading: string }> = {
  approval: { rail: "border-t-approval", block: "bg-approval text-paper", heading: "text-approval" },
  help: { rail: "border-t-help", block: "bg-help text-paper", heading: "text-help" },
};

function Board({ queue, title, students }: { queue: QueueType; title: string; students: StudentView[] }) {
  const tone = TONES[queue];
  const shown = students.slice(0, VISIBLE_PER_QUEUE);
  const rest = students.length - shown.length;

  return (
    <section className={`rounded-2xl bg-paper border border-line border-t-4 ${tone.rail} overflow-hidden`}>
      <div className="flex items-baseline justify-between px-6 py-4 border-b border-line">
        <h2 className={`text-4xl font-black tracking-tight ${tone.heading}`}>{title}</h2>
        <span className="num text-3xl font-bold text-muted">{students.length}</span>
      </div>

      {shown.length === 0 ? (
        <p className="px-6 py-12 text-center text-muted text-2xl">Nobody waiting.</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((student) => (
            <li key={student.id} className="flex items-stretch">
              <span
                className={`num ${tone.block} grid place-items-center min-w-[7rem]
                  px-4 py-5 text-5xl font-black tracking-[-0.03em]`}
              >
                {student.ticket}
              </span>
              <span className={`stub-edge ${tone.heading}`} />
              <span className="flex-1 flex items-center px-6 text-3xl font-semibold truncate">
                {student.name}
              </span>
            </li>
          ))}
        </ul>
      )}

      {rest > 0 && (
        <p className="px-6 py-4 border-t border-line text-2xl font-bold text-muted">
          +{rest} more waiting
        </p>
      )}
    </section>
  );
}
