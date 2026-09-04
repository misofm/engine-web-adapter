import { FLAC_DECODE_OUTPUT_CREDITS } from "./flac-worker-protocol.js";

/** Bounded transferable-output credits for one admitted decoder Worker. */
export class FlacOutputCredits {
  #available = FLAC_DECODE_OUTPUT_CREDITS;
  #wake: (() => void) | undefined;
  #cancelled = false;

  get cancelled(): boolean { return this.#cancelled; }

  give(): void {
    if (this.#cancelled) return;
    this.#available += 1;
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  async take(): Promise<boolean> {
    while (!this.#cancelled && this.#available === 0) {
      await new Promise<void>((resolve) => { this.#wake = resolve; });
    }
    if (this.#cancelled) return false;
    this.#available -= 1;
    return true;
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}
