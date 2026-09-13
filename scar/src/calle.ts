/**
 * CALL-E adapter — REST (https://api.heycall-e.com).
 *
 * Deliberately dependency-free: Node 24's global fetch is enough, so the whole
 * project runs with no install. Swap to `@call-e/calle` if you prefer the SDK;
 * `runAndWait` mirrors `client.calls.createAndWait` on purpose.
 */

export const CALLE_BASE_URL = process.env.CALLE_BASE_URL ?? "https://api.heycall-e.com";

/** Documented cadence: settle ~60s after dispatch, then poll every 5-10s. */
const SETTLE_MS = 60_000;
const POLL_MS = 8_000;
const MAX_WAIT_MS = 8 * 60_000;

export type CallStatus = string;

export interface Recipient {
  phones: string[];
  region: string;
  locale: string;
}

export interface CreateCallInput {
  task: string;
  recipients: Recipient[];
  result_schema: Record<string, unknown>;
}

export interface CallRecord {
  call_id?: string;
  id?: string;
  status: CallStatus;
  task_completed?: boolean;
  structured_result?: Record<string, unknown> | null;
  transcript?: unknown;
  [k: string]: unknown;
}

export class CalleError extends Error {
  status: number | undefined;
  body: string | undefined;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "CalleError";
    this.status = status;
    this.body = body;
  }
}

function apiKey(): string {
  const key = process.env.CALLE_API_KEY;
  if (!key) {
    throw new CalleError(
      "CALLE_API_KEY is not set. Run the dry run instead (DRY_RUN=1), or export your key — see README."
    );
  }
  return key;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${CALLE_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new CalleError(`CALL-E ${init.method ?? "GET"} ${path} failed`, res.status, text.slice(0, 600));
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CalleError(`CALL-E returned non-JSON from ${path}`, res.status, text.slice(0, 300));
  }
}

export function createCall(input: CreateCallInput): Promise<CallRecord> {
  return request<CallRecord>("/v1/calls", { method: "POST", body: JSON.stringify(input) });
}

export function getCall(callId: string): Promise<CallRecord> {
  return request<CallRecord>(`/v1/calls/${encodeURIComponent(callId)}`);
}

export function getCallEvents(callId: string): Promise<unknown> {
  return request(`/v1/calls/${encodeURIComponent(callId)}/events`);
}

/** Terminal states end the poll loop. Anything unrecognised keeps polling until MAX_WAIT_MS. */
const TERMINAL = /^(completed|complete|finished|succeeded|success|failed|error|cancell?ed|no_answer|busy|expired)$/i;

export function isTerminal(status: CallStatus): boolean {
  return TERMINAL.test(String(status ?? ""));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WaitOptions {
  onTick?: (record: CallRecord, elapsedMs: number) => void;
  settleMs?: number;
  pollMs?: number;
  maxWaitMs?: number;
}

/**
 * Place one call and wait for a terminal state.
 *
 * SIDE EFFECT: this dials a real phone number and spends one call from the
 * account's balance. There is no undo. Nothing above this function should call
 * it without an explicit live-mode opt-in.
 */
export async function runAndWait(
  input: CreateCallInput,
  opts: WaitOptions = {}
): Promise<CallRecord> {
  const { onTick, settleMs = SETTLE_MS, pollMs = POLL_MS, maxWaitMs = MAX_WAIT_MS } = opts;

  const created = await createCall(input);
  const callId = created.call_id ?? created.id;
  if (!callId) {
    throw new CalleError("CALL-E did not return a call id", undefined, JSON.stringify(created).slice(0, 400));
  }

  const started = Date.now();
  if (isTerminal(created.status)) return created;

  await sleep(settleMs);

  while (Date.now() - started < maxWaitMs) {
    const record = await getCall(callId);
    onTick?.(record, Date.now() - started);
    if (isTerminal(record.status)) return record;
    await sleep(pollMs);
  }

  throw new CalleError(`Call ${callId} did not reach a terminal state within ${maxWaitMs / 1000}s`);
}
