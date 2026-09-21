import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button } from "./ui";

/** Where students should be sent. Set VITE_PUBLIC_URL when the QR must point at a real domain. */
const publicUrl = import.meta.env.VITE_PUBLIC_URL || window.location.origin;

export function JoinBanner({
  studentCode,
  title,
  taCode,
  onClose,
  onPresent,
}: {
  studentCode: string;
  title?: string;
  taCode?: string;
  onClose?: () => void;
  /** Host only: opens the read-only board in a window to drag onto the projector. */
  onPresent?: () => void;
}) {
  const joinUrl = `${publicUrl.replace(/\/$/, "")}/join/${studentCode}`;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState<"code" | "ta" | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Hidden by default: this header is on a projector, and the TA code is the only thing gating TA powers.
  const [showTaCode, setShowTaCode] = useState(false);

  useEffect(() => {
    if (!canvas.current) return;
    QRCode.toCanvas(canvas.current, joinUrl, {
      width: 320,
      margin: 1,
      color: { dark: "#101720", light: "#ffffff" },
      errorCorrectionLevel: "M",
    }).catch(() => {
      /* the code below the QR is always readable, so a failed render is not fatal */
    });
  }, [joinUrl]);

  async function copy(value: string, which: "code" | "ta") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      /* clipboard blocked: the value is on screen anyway */
    }
  }

  return (
    <header className="bg-ink text-paper">
      <div className="mx-auto max-w-[1600px] px-5 sm:px-8 py-6 sm:py-8 flex flex-wrap items-center gap-x-10 gap-y-6">
        <div className="min-w-0">
          {title && (
            <h1 className="text-[clamp(1.75rem,4vw,3rem)] font-black tracking-tight leading-tight mb-1">
              {title}
            </h1>
          )}
          <p className="text-paper/60 text-base sm:text-lg font-medium">
            Join at <span className="text-paper/90">{joinUrl.replace(/^https?:\/\//, "")}</span>
          </p>
          <p className="num font-black leading-[0.85] tracking-[0.02em] text-[clamp(4rem,13vw,9rem)]">
            {studentCode}
          </p>
          <button type="button"
            onClick={() => copy(studentCode, "code")}
            className="mt-2 text-paper/70 hover:text-paper underline underline-offset-4 text-sm font-semibold"
          >
            {copied === "code" ? "Copied" : "Copy room code"}
          </button>
        </div>

        <div className="rounded-2xl bg-paper p-3 shrink-0">
          <canvas
            ref={canvas}
            aria-label={`QR code linking to ${joinUrl}`}
            role="img"
            className="block h-[clamp(9rem,20vw,15rem)] w-[clamp(9rem,20vw,15rem)]"
          />
        </div>

        {taCode && (
          <div className="ml-auto flex flex-col gap-3 min-w-[13rem]">
            <div className="rounded-xl border border-paper/20 px-4 py-3">
              <p className="text-paper/60 text-sm font-semibold">TA code</p>
              <p className="num text-3xl font-bold tracking-[0.15em]">
                {showTaCode ? taCode : "\u2022".repeat(taCode.length)}
              </p>
              <button type="button"
                onClick={() => setShowTaCode((v) => !v)}
                aria-pressed={showTaCode}
                className="mt-1 block text-paper/70 hover:text-paper underline underline-offset-4 text-sm font-semibold"
              >
                {showTaCode ? "Hide TA code" : "Show TA code"}
              </button>
              <button type="button"
                onClick={() => copy(taCode, "ta")}
                className="mt-1 block text-paper/70 hover:text-paper underline underline-offset-4 text-sm font-semibold"
              >
                {copied === "ta" ? "Copied" : "Copy TA code"}
              </button>
            </div>
            {onPresent && (
              <Button variant="secondary" onClick={onPresent}>
                Open projector view
              </Button>
            )}
            {onClose && (
              <Button variant="danger" onClick={() => setConfirming(true)}>
                Close room
              </Button>
            )}
          </div>
        )}
      </div>

      {confirming && onClose && (
        <ConfirmClose onCancel={() => setConfirming(false)} onConfirm={onClose} />
      )}
    </header>
  );
}

function ConfirmClose({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="close-room-title"
      className="fixed inset-0 z-50 grid place-items-center bg-ink/70 px-5"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-paper text-ink p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="close-room-title" className="text-2xl font-bold">
          Close this room?
        </h2>
        <p className="mt-2 text-muted">
          Everyone waiting is disconnected and the room is deleted. Nothing can be recovered.
        </p>
        <div className="mt-6 flex gap-3 justify-end">
          <Button variant="secondary" onClick={onCancel} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Close room
          </Button>
        </div>
      </div>
    </div>
  );
}
