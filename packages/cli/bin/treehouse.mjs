#!/usr/bin/env node
// Launcher: register the tsx ESM loader so the TypeScript source runs directly
// (no build step for the dogfooding CLI), then run the entry.
import { register } from "tsx/esm/api";

register();
await import(new URL("../src/index.ts", import.meta.url).href);