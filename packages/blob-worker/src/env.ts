// The slice of the Workers runtime this Worker uses, typed by hand rather than
// pulling in the whole of @cloudflare/workers-types. The tests implement the
// same interfaces with an in-memory bucket.

/** The parts of an R2 object read this Worker relies on. */
export interface R2ObjectLike {
  /** Size of the whole stored object, whatever range was read. */
  size: number;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream<Uint8Array>;
}

export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<R2ObjectBodyLike | null>;
}

export interface Env {
  BLOBS: R2BucketLike;
  BLOB_WORKER_TOKEN_KEY?: string;
  BLOB_WORKER_TOKEN_KEY_RETIRED?: string;
  USAGE_REPORT_URL?: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}