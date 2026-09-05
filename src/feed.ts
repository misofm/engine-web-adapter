import {
  attachEngineFeed as attachSdkFeed,
  prepareEngineFeed as prepareSdkFeed,
  PcmFeedError,
} from "@misofm/engine/browser";
import type { EngineFeed } from "@misofm/engine/browser";
import { EngineWebAdapterError } from "./errors.js";

export type { EngineFeed, FeedNode as AudioWorkletNodeLike } from "@misofm/engine/browser";

export async function prepareEngineFeed(
  context: { readonly audioWorklet: { addModule(url: string): Promise<void> } },
  moduleUrl?: string | URL,
): Promise<void> {
  try { await prepareSdkFeed(context, moduleUrl); }
  catch (error) { throw translated(error); }
}

export function attachEngineFeed(options: Parameters<typeof attachSdkFeed<BaseAudioContext>>[0]): EngineFeed {
  let feed: EngineFeed;
  try { feed = attachSdkFeed(options); }
  catch (error) { throw translated(error); }
  return {
    rings: feed.rings,
    get state() { return feed.state; },
    async ready(settings) {
      try { await feed.ready(settings); }
      catch (error) { throw translated(error); }
    },
    async prepareSeek(settings) {
      try { await feed.prepareSeek(settings); }
      catch (error) { throw translated(error); }
    },
    close: () => feed.close(),
  };
}

function translated(error: unknown): unknown {
  if (!(error instanceof PcmFeedError)) return error;
  const code = error.operation === "moduleLoad" ? "capability.audio_worklet"
    : error.operation === "closed" ? "session.closed"
    : error.operation.startsWith("prepare") ? "session.seek" : "session.open";
  return new EngineWebAdapterError(code, error.message, { operation: error.operation, result: error.result }, error);
}
