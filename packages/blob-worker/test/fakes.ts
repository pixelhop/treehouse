import type { ExecutionContextLike, R2BucketLike, R2ObjectBodyLike } from "../src/env";

/**
 * An in-memory R2 bucket. Bodies arrive in uneven pieces, the way a network
 * delivers them, and every read and cancellation is recorded.
 */
export class FakeBucket implements R2BucketLike {
  objects = new Map<string, Uint8Array>();
  reads: { key: string; offset: number; length: number }[] = [];
  cancelled = 0;

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { size: object.byteLength } : null;
  }

  async get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<R2ObjectBodyLike | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? object.byteLength - offset;
    this.reads.push({ key, offset, length });
    const bytes = object.subarray(offset, offset + length);
    let at = 0;
    const sizes = [1000, 17, 4096, 333];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (at >= bytes.byteLength) {
          controller.close();
          return;
        }
        const n = sizes[i++ % sizes.length]!;
        controller.enqueue(bytes.slice(at, at + n));
        at += n;
      },
      cancel: () => {
        this.cancelled++;
      },
    });
    return { size: object.byteLength, body };
  }
}

/** Collects `waitUntil` work so a test can wait for it to finish. */
export class FakeContext implements ExecutionContextLike {
  #pending: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.#pending.push(promise);
  }
  async settle(): Promise<void> {
    await Promise.all(this.#pending);
  }
}