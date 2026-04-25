#!/usr/bin/env node
/* eslint-disable no-console */
// UI iteration screenshot harness.
//
// Assumes `just dev` is already running (FastAPI on :8000, Vite on :5173).
// Captures the load-bearing visual states into `client/screenshots/` so
// the design pass has something concrete to look at instead of guessing.
//
// Usage:
//   just shots
//   # or:
//   node client/scripts/screenshots.mjs

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = join(__dirname, "..", "screenshots");
const APP_URL = process.env.BWBK_APP_URL ?? "http://localhost:5173/";
const API_URL = process.env.BWBK_API_URL ?? "http://127.0.0.1:8000";

// Single viewport keeps the shots comparable run-to-run. 1440x900 is
// roughly a 14" laptop and matches what the user is likely staring at.
const VIEWPORT = { width: 1440, height: 900 };

async function api(path, init = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function ensureNoProject() {
  try {
    await api("/api/projects/close", { method: "POST" });
  } catch {
    /* nothing open */
  }
}

async function seedSampleProject(projectPath) {
  await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ path: projectPath, title: "Drafts" }),
  });

  // A small tree so the "loaded" shot isn't just an empty buffer:
  //   root
  //   └─ opening (main)
  //      ├─ branch_a (main)
  //      └─ branch_b (hidden sibling)
  const now = Math.floor(Date.now() / 1000);
  const opening = "Once the lighthouse went dark, the cove went quiet. ";
  const branchA =
    "By morning the boats had moved on, but Mira stayed at the rail, watching the pilings disappear under the tide.";
  const branchB =
    "She would find the keeper later, sitting in the kitchen as if the whole night had never happened.";
  const batch = {
    creates: [
      {
        id: "n_open",
        parent_id: "root",
        text: opening,
        name: "Cold open",
        source: "user_written",
        hidden: false,
        is_main_path: true,
        created_at: now,
        prior_context_hash: "0".repeat(16),
      },
      {
        id: "n_a",
        parent_id: "n_open",
        text: branchA,
        name: null,
        source: "generated",
        hidden: false,
        is_main_path: true,
        created_at: now + 1,
        prior_context_hash: "0".repeat(16),
      },
      {
        id: "n_b",
        parent_id: "n_open",
        text: branchB,
        name: null,
        source: "generated",
        hidden: true,
        is_main_path: false,
        created_at: now + 2,
        prior_context_hash: "0".repeat(16),
      },
    ],
    main_path: ["root", "n_open", "n_a"],
  };
  await api("/api/nodes/batch", { method: "POST", body: JSON.stringify(batch) });
}

async function snap(page, name) {
  const file = join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  → ${file}`);
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("  page error:", err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      console.error(`  console.${msg.type()}:`, msg.text());
    }
  });

  const tmpProject = join(tmpdir(), `bwbk-shots-${Date.now()}.bwbk`);

  try {
    // 1. Welcome / empty state.
    await ensureNoProject();
    console.log("welcome");
    await page.goto(APP_URL, { waitUntil: "networkidle" });
    await snap(page, "01-welcome");

    // 2. Project loaded with a small sample tree.
    await ensureNoProject();
    await seedSampleProject(tmpProject);
    console.log("project loaded");
    await page.goto(APP_URL, { waitUntil: "networkidle" });
    // Buffer has time to paint after concatPathText runs; small wait avoids
    // catching the layout mid-hydration.
    await page.waitForSelector(".bw-buffer");
    await page.waitForTimeout(200);
    await snap(page, "02-project");

    // 3. Model modal.
    console.log("model modal");
    const modelButton = page.locator(".bw-status .bw-link-button").first();
    await modelButton.click();
    await page.waitForSelector(".bw-modal");
    await page.waitForTimeout(150);
    await snap(page, "03-model-modal");
    await page.locator('.bw-modal button:has-text("Close")').click();
    await page.waitForSelector(".bw-modal", { state: "detached" });

    // 4. Sampler drawer.
    console.log("sampler drawer");
    await page.locator('button:has-text("Samplers")').first().click();
    await page.waitForSelector(".bw-drawer-backdrop");
    await page.waitForTimeout(250);
    await snap(page, "04-sampler-drawer");
    await page
      .locator('.bw-drawer-backdrop button[aria-label="Close sampler drawer"]')
      .click();
    await page.waitForSelector(".bw-drawer-backdrop", { state: "detached" });

    // 5. Branch picker mid-stream. Mock backend streams a few hundred ms,
    //    so we kick off Generate and snap while text is still arriving.
    console.log("branch picker (streaming)");
    const generateBtn = page.locator(".bw-actionbar button.bw-button-primary");
    await generateBtn.waitFor({ state: "visible" });
    // Wait for the model probe to complete so Generate is enabled.
    await page.waitForFunction(() => {
      const btn = document.querySelector(".bw-actionbar button.bw-button-primary");
      return btn && !btn.disabled;
    });
    await generateBtn.click();
    await page.waitForSelector(".bw-picker");
    // Wait until at least one branch has visible text but the stream is
    // still in flight, so the shot captures the live state, not the
    // "ready" post-stream state.
    await page.waitForFunction(() => {
      const cards = document.querySelectorAll(".bw-branch-card .bw-branch-text");
      for (const c of cards) {
        const t = (c.textContent ?? "").trim();
        if (t.length > 20 && !t.startsWith("Waiting")) return true;
      }
      return false;
    });
    await snap(page, "05-branch-picker-streaming");

    // 6. Branch picker after stream completes (ready to pick).
    await page.waitForSelector('.bw-picker-head .bw-kicker:has-text("BRANCHES")');
    await page.waitForFunction(
      () =>
        document.querySelector(".bw-picker-head [class*='ink-muted']")?.textContent ===
        "ready",
      null,
      { timeout: 15000 },
    );
    await snap(page, "06-branch-picker-ready");
  } finally {
    await context.close();
    await browser.close();
    await ensureNoProject();
    await rm(tmpProject, { force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
