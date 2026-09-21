import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { CreateRoomResult } from "@shared/types";
import { call, message, resetSocket } from "../lib/socket";
import { lastName, taSession } from "../lib/session";
import { Button, ErrorNote, Field, Screen } from "../components/ui";

type Mode = "choose" | "create" | "join";

export default function Landing() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("choose");
  const [name, setName] = useState(lastName.get());
  const [title, setTitle] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function createRoom(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await resetSocket();
      const room = await call<CreateRoomResult>("room:create", { taName: name, title });
      lastName.set(name.trim());
      taSession.set({ studentCode: room.studentCode, taId: room.taId, name: name.trim(), isHost: true });
      navigate(`/room/${room.studentCode}`);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  const digits = code.replace(/\D/g, "").slice(0, 6);

  const back = (
    <button
      type="button"
      onClick={() => {
        setMode("choose");
        setError("");
      }}
      className="text-sm font-semibold text-muted hover:text-ink underline underline-offset-4"
    >
      Back
    </button>
  );

  return (
    <Screen>
      <div className="flex-1 flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-xl">
          <header className="mb-8">
            <h1 className="text-[clamp(3rem,12vw,5.5rem)] leading-[0.85] font-black tracking-[-0.04em]">
              TA Queue
            </h1>
            <p className="mt-4 text-lg text-muted max-w-md">
              Organize assignment approvals and student help sessions.
            </p>
          </header>

          <div className="rounded-2xl bg-paper border border-line overflow-hidden">
            {mode === "choose" && (
              /* One ticket, torn in two: run a room above, join one below. */
              <>
                <Choice
                  title="Create room"
                  detail="Open a new queue and put the code on the screen."
                  onClick={() => setMode("create")}
                />
                <Perforation />
                <Choice
                  title="Join room"
                  detail="Take a number with the code your TA is showing."
                  onClick={() => setMode("join")}
                />
              </>
            )}

            {mode === "create" && (
              <form onSubmit={createRoom} className="p-6 sm:p-8 flex flex-col gap-4">
                <Field
                  label="Your name"
                  name="host-name"
                  value={name}
                  autoFocus
                  autoComplete="name"
                  maxLength={32}
                  placeholder="Example: Sara"
                  onChange={(e) => setName(e.target.value)}
                />
                <Field
                  label="What is this session for?"
                  name="room-title"
                  value={title}
                  maxLength={60}
                  autoComplete="off"
                  placeholder="Example: DAT120 oving 3"
                  hint="Shown to students so they know they are in the right room. Optional."
                  onChange={(e) => setTitle(e.target.value)}
                />
                <Button type="submit" size="lg" disabled={busy || !name.trim()}>
                  {busy ? "Creating room…" : "Create room"}
                </Button>
                {back}
              </form>
            )}

            {mode === "join" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  navigate(`/join/${digits}`);
                }}
                className="p-6 sm:p-8 flex flex-col gap-4"
              >
                <Field
                  label="Room code"
                  name="room-code"
                  value={digits}
                  autoFocus
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="Example: 482731"
                  className="num text-3xl tracking-[0.3em] font-bold
                    placeholder:text-base placeholder:tracking-normal placeholder:font-medium"
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button type="submit" size="lg" disabled={digits.length !== 6}>
                  Join the queue
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  disabled={digits.length !== 6}
                  onClick={() => navigate(`/room/${digits}`)}
                >
                  Join as a TA
                </Button>
                {back}
              </form>
            )}
          </div>

          {error && (
            <div className="mt-6">
              <ErrorNote>{error}</ErrorNote>
            </div>
          )}

          <p className="mt-8 text-sm text-muted">
            Rooms live in memory for as long as the session runs. Nothing is stored afterwards.
          </p>
        </div>
      </div>
    </Screen>
  );
}

function Choice({ title, detail, onClick }: { title: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-full text-left p-6 sm:p-8 transition-colors hover:bg-wash">
      <span className="block text-3xl sm:text-4xl font-black tracking-tight">{title}</span>
      <span className="block mt-1 text-muted">{detail}</span>
    </button>
  );
}

function Perforation() {
  return (
    <div className="relative h-0 border-t-2 border-dashed border-line">
      <span className="absolute -top-3 -left-3 block h-6 w-6 rounded-full bg-wash" />
      <span className="absolute -top-3 -right-3 block h-6 w-6 rounded-full bg-wash" />
    </div>
  );
}
