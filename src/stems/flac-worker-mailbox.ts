import { FLAC_DECODE_OUTPUT_CREDITS } from "./flac-worker-protocol.js";

export type FlacWorkerInput = { readonly bytes: Uint8Array; readonly totalFlacBytes: number } | null;

/** One-job Worker mailbox whose cancellation wakes every bounded wait. */
export class FlacWorkerMailbox {
  readonly cancellation: Promise<void>;
  #resolveCancellation!: () => void;
  #cancellationReason: unknown;
  #cancelled = false;
  #inputs: FlacWorkerInput[] = [];
  #inputWake: ((input: FlacWorkerInput) => void) | undefined;
  #outputCredits = FLAC_DECODE_OUTPUT_CREDITS;
  #creditWake: (() => void) | undefined;

  constructor() {
    this.cancellation = new Promise<void>((resolve) => { this.#resolveCancellation = resolve; });
  }

  get cancelled(): boolean { return this.#cancelled; }
  get cancellationReason(): unknown { return this.#cancellationReason; }

  giveInput(input: FlacWorkerInput): void {
    if (this.#cancelled) return;
    const wake = this.#inputWake;
    this.#inputWake = undefined;
    if (wake !== undefined) wake(input);
    else this.#inputs.push(input);
  }

  nextInput(): Promise<FlacWorkerInput> {
    const input = this.#inputs.shift();
    if (input !== undefined) return Promise.resolve(input);
    return new Promise((resolve) => { this.#inputWake = resolve; });
  }

  giveOutputCredit(): void {
    if (this.#cancelled) return;
    this.#outputCredits += 1;
    const wake = this.#creditWake;
    this.#creditWake = undefined;
    wake?.();
  }

  async takeOutputCredit(): Promise<void> {
    while (!this.#cancelled && this.#outputCredits === 0) {
      await new Promise<void>((resolve) => { this.#creditWake = resolve; });
    }
    if (!this.#cancelled) this.#outputCredits -= 1;
  }

  cancel(reason: unknown): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#cancellationReason = reason;
    this.#resolveCancellation();
    const inputWake = this.#inputWake;
    this.#inputWake = undefined;
    inputWake?.(null);
    const creditWake = this.#creditWake;
    this.#creditWake = undefined;
    creditWake?.();
    this.#inputs = [];
  }
}
