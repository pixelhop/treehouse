#!/usr/bin/env node
// Generate on-brand Treehouse illustrations through OpenRouter.
//
// Reads the prompt system in ../src/prompts and renders one or more recipes,
// saving PNGs + a manifest into a gitignored review folder. Image models on
// OpenRouter return images inline on the chat-completions endpoint
// (modalities: ["image","text"]); we pull message.images[].image_url.url.
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-... node scripts/generate-illustrations.mjs [options]
//
// Options:
//   --recipe <id|all>   Recipe id (e.g. mascot-pose) or "all". Default: all
//   --variant <id>      Only this variant within the recipe (e.g. focused)
//   --model <id>        OpenRouter model. Default: google/gemini-2.5-flash-image
//                       Try also: google/gemini-3-pro-image-preview, openai/gpt-image-1
//   --n <count>         Images per job. Default: 1
//   --out <dir>         Output dir. Default: ./.illustration-tests/<timestamp>
//   --list              Print the composed prompts and exit (no API calls)
//
// The key can also live in packages/design/.env as OPENROUTER_API_KEY=...

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recipes, expandRecipe, allJobs } from "../src/prompts/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");

// ---- args -----------------------------------------------------------------
function parseArgs(argv) {
  const out = {
    recipe: "all",
    model: "google/gemini-2.5-flash-image",
    n: 1,
    out: null,
    list: false,
    variant: null,
    ref: null, // path to a reference image (image-to-image)
    prompt: null, // custom prompt, bypasses recipes
    id: "custom", // output filename stem when --prompt is used
    aspect: null, // aspect ratio for custom prompts (e.g. 16:9)
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--recipe") out.recipe = argv[++i];
    else if (a === "--variant") out.variant = argv[++i];
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--n") out.n = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--ref") out.ref = argv[++i];
    else if (a === "--prompt") out.prompt = argv[++i];
    else if (a === "--id") out.id = argv[++i];
    else if (a === "--aspect") out.aspect = argv[++i];
  }
  return out;
}

// Read an image file into a base64 data URL for image-to-image requests.
async function loadRefDataUrl(path) {
  const bytes = await readFile(resolve(path));
  const ext = (path.split(".").pop() || "png").toLowerCase();
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

// ---- tiny .env loader (no deps) -------------------------------------------
async function loadEnv() {
  const envPath = join(pkgRoot, ".env");
  if (!existsSync(envPath)) return;
  const text = await readFile(envPath, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

// ---- which jobs to run ----------------------------------------------------
function selectJobs(args) {
  // A custom prompt bypasses the recipe system entirely.
  if (args.prompt)
    return [
      {
        id: args.id,
        label: "custom",
        aspect: args.aspect ?? undefined,
        preset: "custom",
        prompt: args.prompt,
      },
    ];
  let jobs;
  if (args.recipe === "all") jobs = allJobs();
  else {
    const r = recipes.find((x) => x.id === args.recipe);
    if (!r) {
      console.error(
        `Unknown recipe "${args.recipe}". Options: ${recipes.map((x) => x.id).join(", ")}, all`,
      );
      process.exit(1);
    }
    jobs = expandRecipe(r);
  }
  if (args.variant) jobs = jobs.filter((j) => j.id.endsWith(`-${args.variant}`));
  return jobs;
}

// ---- one OpenRouter image request -----------------------------------------
async function generate(apiKey, model, prompt, aspect, refDataUrl) {
  // With a reference image, send a multimodal content array (image-to-image).
  const content = refDataUrl
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: refDataUrl } },
      ]
    : prompt;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://treehouse.dev",
      "X-Title": "Treehouse illustration generator",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
      image_config: aspect ? { aspect_ratio: aspect } : undefined,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  const url = msg?.images?.[0]?.image_url?.url;
  if (!url) throw new Error(`No image in response: ${JSON.stringify(data).slice(0, 400)}`);
  // data URL: data:image/png;base64,xxxx
  // Buffer.from("", "base64") succeeds, so a data URL of an unexpected shape
  // would otherwise be written out as a 0-byte PNG and recorded as ok.
  const b64 = url.split(",")[1];
  if (!b64) throw new Error(`Unexpected image URL format: ${url.slice(0, 80)}`);
  return Buffer.from(b64, "base64");
}

// ---- main -----------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jobs = selectJobs(args);

  if (args.list) {
    for (const j of jobs) {
      console.log(`\n### ${j.id}  [${j.preset}, ${j.aspect}]\n${j.prompt}`);
    }
    console.log(`\n${jobs.length} job(s).`);
    return;
  }

  await loadEnv();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing OPENROUTER_API_KEY. Set it in the environment or in packages/design/.env\n" +
        "  echo 'OPENROUTER_API_KEY=sk-or-...' >> packages/design/.env",
    );
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = args.out ? resolve(args.out) : join(pkgRoot, ".illustration-tests", stamp);
  await mkdir(outDir, { recursive: true });

  const refDataUrl = args.ref ? await loadRefDataUrl(args.ref) : null;

  const manifest = { model: args.model, createdAt: stamp, ref: args.ref ?? null, results: [] };
  console.log(
    `Generating ${jobs.length * args.n} image(s) with ${args.model}` +
      `${args.ref ? ` (ref: ${args.ref})` : ""} → ${outDir}\n`,
  );

  for (const job of jobs) {
    for (let i = 0; i < args.n; i++) {
      const suffix = args.n > 1 ? `-${i + 1}` : "";
      const file = `${job.id}${suffix}.png`;
      process.stdout.write(`  ${file} … `);
      try {
        const bytes = await generate(apiKey, args.model, job.prompt, job.aspect, refDataUrl);
        await writeFile(join(outDir, file), bytes);
        manifest.results.push({
          id: job.id,
          file,
          preset: job.preset,
          aspect: job.aspect,
          prompt: job.prompt,
          ok: true,
        });
        console.log(`ok (${Math.round(bytes.length / 1024)} KB)`);
      } catch (err) {
        manifest.results.push({ id: job.id, file, ok: false, error: String(err.message ?? err) });
        console.log(`FAILED — ${err.message ?? err}`);
      }
    }
  }

  await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const okCount = manifest.results.filter((r) => r.ok).length;
  console.log(
    `\nDone: ${okCount}/${manifest.results.length} succeeded. Manifest: ${join(outDir, "manifest.json")}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});