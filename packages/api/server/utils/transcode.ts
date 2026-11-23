// Content transcoding for the MCP read_file/write_file tools. Text files use
// utf8 (the default); binary files (images, PDFs, …) use base64 so the bytes
// round-trip through the JSON string `content` field without corruption —
// matching the web UI's raw-bytes upload path so agents reach human parity for
// binary content.
export type Encoding = "utf8" | "base64";

/** Decode a tool's `content` string into bytes for the file service. */
export function decodeContent(content: string, encoding: Encoding = "utf8"): Uint8Array {
  return encoding === "base64"
    ? new Uint8Array(Buffer.from(content, "base64"))
    : new TextEncoder().encode(content);
}

/** Encode file-service bytes into a tool's `content` string. */
export function encodeContent(body: Uint8Array, encoding: Encoding = "utf8"): string {
  return encoding === "base64"
    ? Buffer.from(body).toString("base64")
    : new TextDecoder().decode(body);
}