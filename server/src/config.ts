/** Tunables. Everything that governs room lifetime and presence lives here. */

const num = (v: string | undefined, fallback: number) => (v ? Number(v) : fallback);

export const config = {
  port: num(process.env.PORT, 3001),
  /** Comma-separated origins allowed to connect. "*" in dev. */
  corsOrigin: process.env.CORS_ORIGIN ?? "*",

  /**
   * Presence is shown, never enforced. A lab session runs for hours: TAs work on their own
   * things between students and students put their phone away after taking a number.
   * Being offline is normal, so nobody is ever removed for it - a student leaves the queue
   * when they say so or when a TA removes them, and a TA stays on the board until
   * the room closes.
   */

  /**
   * How long a finished or removed student's result stays readable on their own phone
   * before the record is dropped.
   */
  resultLingerMs: num(process.env.RESULT_LINGER_MS, 10 * 60_000),

  /** A room with nobody connected and nobody queued is deleted after this long. */
  emptyRoomTtlMs: num(process.env.EMPTY_ROOM_TTL_MS, 2 * 60 * 60_000),
  /** Hard ceiling on room lifetime, connected or not. */
  maxRoomLifetimeMs: num(process.env.MAX_ROOM_LIFETIME_MS, 12 * 60 * 60_000),
  sweepIntervalMs: num(process.env.SWEEP_INTERVAL_MS, 60_000),

  /** Per-socket rate limit: actions allowed per window. */
  rateLimit: { max: num(process.env.RATE_LIMIT_MAX, 40), windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 10_000) },

  maxNameLength: 32,
  maxTitleLength: 60,
  maxRoomsPerServer: num(process.env.MAX_ROOMS, 500),
};
