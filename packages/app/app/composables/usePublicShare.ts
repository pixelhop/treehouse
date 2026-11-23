// Client for the UNAUTHENTICATED public-share endpoints. Credentialed so the
// token-bound unlock cookie flows on the cross-origin viewer → API calls.
import { useQuery } from "@tanstack/vue-query";

export interface ShareFile {
  path: string;
  size: number;
  contentType: string;
  version: number;
}
export interface ShareMeta {
  kind: "file" | "folder";
  name: string;
  /** Custom icon on the shared node itself, as shown in the workspace tree. */
  icon: string | null;
  /** Who this came from — the workspace's own name, icon and colour tile. */
  workspace: { id: string | null; name: string; icon: string | null; color: string | null };
  /** The workspace's default theme, so a share looks like where it came from. */
  theme: string | null;
  themeCss: string | null;
  hasPassword: boolean;
  pinnedVersion: number | null;
  /**
   * Whether a shared HTML page may run its own scripts. Set by the member who
   * minted the link — a visitor is never asked, because a stranger holding a URL
   * has no way to judge what is in the file.
   */
  allowScripts: boolean;
  unlocked: boolean;
  /** A file share's entry (null for folder shares, and while still locked). */
  file: ShareFile | null;
}
export interface ShareListing {
  path: string;
  entries: ShareFile[];
  icons: Record<string, string>;
  orders: Record<string, number>;
}

export function usePublicShare(token: Ref<string>) {
  const {
    public: { apiUrl },
  } = useRuntimeConfig();
  const base = apiUrl as string;
  const credentials = "include" as const;

  const metaQuery = useQuery({
    queryKey: computed(() => ["share-meta", token.value]),
    queryFn: () => $fetch<ShareMeta>(`${base}/api/share/${token.value}/meta`, { credentials }),
    retry: false,
  });

  function unlock(password: string) {
    return $fetch<{ ok: boolean }>(`${base}/api/share/${token.value}/unlock`, {
      method: "POST",
      credentials,
      body: { password },
    });
  }

  function fileUrl(subPath?: string): string {
    const q = subPath ? `?path=${encodeURIComponent(subPath)}` : "";
    return `${base}/api/share/${token.value}/file${q}`;
  }

  // Asks for an attachment even where the bytes would show inline, for the
  // same cross-origin reason as the workspace API's `fileUrl({ download })`.
  function downloadUrl(subPath?: string): string {
    const url = fileUrl(subPath);
    return `${url}${url.includes("?") ? "&" : "?"}download=1`;
  }

  function readFileText(subPath?: string) {
    return $fetch<string>(fileUrl(subPath), { credentials, responseType: "text" });
  }

  function listUrl(): string {
    return `${base}/api/share/${token.value}/list`;
  }

  return { metaQuery, unlock, fileUrl, downloadUrl, readFileText, listUrl };
}