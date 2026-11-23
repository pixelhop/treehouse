/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const POSTHOG_CLI_TIMEOUT_MS = 120_000;

export interface PosthogSourceMapCredentials {
  token: string;
  projectId: string;
}

interface UploadOptions extends PosthogSourceMapCredentials {
  dir: string;
  host: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  run?: typeof execFileSync;
  warn?: (...args: unknown[]) => void;
}

export function posthogSourceMapCredentials(
  env: NodeJS.ProcessEnv,
): PosthogSourceMapCredentials | undefined {
  const token = env.POSTHOG_CLI_TOKEN;
  const projectId = env.POSTHOG_PROJECT_ID;
  return token && projectId ? { token, projectId } : undefined;
}

export function removeSourceMaps(dir: string): void {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) removeSourceMaps(path);
    else if (entry.isFile() && entry.name.endsWith(".map")) rmSync(path, { force: true });
  }
}

export function uploadPosthogSourceMaps({
  token,
  projectId,
  dir,
  host,
  cwd = process.cwd(),
  env = process.env,
  run = execFileSync,
  warn = console.warn,
}: UploadOptions): void {
  const cliEnv = {
    ...env,
    POSTHOG_CLI_HOST: host,
    POSTHOG_CLI_PROJECT_ID: projectId,
    POSTHOG_CLI_API_KEY: token,
  };
  const runCli = (args: string[]) =>
    run("posthog-cli", args, {
      env: cliEnv,
      stdio: "inherit",
      cwd,
      timeout: POSTHOG_CLI_TIMEOUT_MS,
      // execFileSync waits for the child to exit after a timeout. SIGKILL keeps
      // a wedged CLI that ignores graceful termination from hanging the build.
      killSignal: "SIGKILL",
    });

  try {
    runCli(["sourcemap", "inject", "--directory", dir, "--ignore", "**/node_modules/**"]);
    runCli(["sourcemap", "upload", "--directory", dir, "--delete-after"]);
  } catch (error) {
    warn("[posthog] source map upload failed; continuing build:", error);
  } finally {
    // A failed upload must never turn generated source maps into public assets.
    // Let cleanup failures abort the build rather than deploy source accidentally.
    removeSourceMaps(dir);
  }
}