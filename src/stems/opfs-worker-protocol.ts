/**
 * Wire contract for the OPFS write Worker.
 *
 * `FileSystemFileHandle.createSyncAccessHandle()` is the only OPFS write API
 * every target engine ships (Chrome 102+, Firefox 111+, Safari 15.2+), and its
 * handle is synchronous, so it may only be created off the main thread. Writes
 * therefore cross a Worker boundary; reads stay on the calling thread.
 */
export type OpfsWorkerRequest =
  | {
      readonly type: "write-open";
      readonly requestId: number;
      readonly writerId: number;
      readonly folderName: string;
      readonly name: string;
    }
  | { readonly type: "write"; readonly requestId: number; readonly writerId: number; readonly chunk: Uint8Array }
  | { readonly type: "write-close"; readonly requestId: number; readonly writerId: number }
  | { readonly type: "write-abort"; readonly requestId: number; readonly writerId: number };

export type OpfsWorkerResponse =
  /**
   * `createSyncAccessHandle()` is `[Exposed=DedicatedWorker]`, so no
   * main-thread probe can see it. The Worker reports it on handshake and the
   * store refuses at `open()`, before any resolver or network work.
   */
  | { readonly type: "worker-ready"; readonly writeSupport: boolean }
  | { readonly type: "opfs-ok"; readonly requestId: number }
  | {
      readonly type: "opfs-error";
      readonly requestId: number;
      readonly error: {
        readonly name: string;
        readonly message: string;
        readonly code?: string;
        readonly details?: Readonly<Record<string, unknown>>;
      };
    };

export interface OpfsWorkerLike {
  postMessage(message: OpfsWorkerRequest): void;
  terminate(): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: (event: any) => void): void;
}

export const OPFS_WRITE_METHOD = "FileSystemFileHandle.createSyncAccessHandle" as const;
export const OPFS_WRITE_REMEDY =
  "Origin-private file writes need FileSystemFileHandle.createSyncAccessHandle(): Safari 15.2+, Chrome 102+, or Firefox 111+.";
