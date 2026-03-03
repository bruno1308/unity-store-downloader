/**
 * Unity Asset Store Bulk Downloader
 *
 * Authenticates with kharma.unity3d.com via X-Unity-Session,
 * lists all purchased assets, downloads .unitypackage files.
 *
 * Usage:
 *   npx tsx src/index.ts [options]
 *
 * Options:
 *   --email <email>        Unity account email
 *   --password <pass>      Unity account password
 *   --output <dir>         Output directory (default: Asset Store-5.x folder)
 *   --dry-run              List purchased assets without downloading
 *   --limit <n>            Download at most N assets
 *   --skip-existing        Skip .unitypackage files that already exist on disk
 *   --concurrency <n>      Parallel downloads (default: 3)
 *   --supplement <file>    JSON file with extra asset IDs from browser scraper
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as readline from "node:readline";

// ── Types ────────────────────────────────────────────────────────────────

interface DownloadInfo {
  url: string;
  key: string;
  filename_safe_package_name: string;
  filename_safe_publisher_name: string;
  filename_safe_category_name: string;
  id: string;
  md5?: string;
}

interface PurchasedItem {
  id: string;
  name: string;
  publisher: string;
  category: string;
  slug: string;
  can_download: number;
}

interface SupplementItem {
  id: string | number;
  name?: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const KHARMA_BASE = "https://kharma.unity3d.com";
const DEFAULT_OUTPUT = path.join(os.homedir(), "AppData", "Roaming", "Unity", "Asset Store-5.x");
const SESSION_FILE = path.join(os.tmpdir(), "unity-kharma-session.json");

// ── CLI Parsing ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") { opts.dryRun = true; continue; }
    if (arg === "--skip-existing") { opts.skipExisting = true; continue; }
    if (arg.startsWith("--") && i + 1 < args.length) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      opts[key] = args[++i];
    }
  }
  return opts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Prompt ───────────────────────────────────────────────────────────────

async function prompt(question: string, hidden = false): Promise<string> {
  if (hidden) {
    process.stdout.write(question);
    return new Promise((resolve) => {
      let input = "";
      const stdin = process.stdin;
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      const onData = (ch: Buffer) => {
        const c = ch.toString();
        if (c === "\n" || c === "\r") {
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          stdin.pause();
          process.stdout.write("\n");
          resolve(input);
        } else if (c === "\u0003") {
          process.exit(0);
        } else if (c === "\u007f" || c === "\b") {
          if (input.length > 0) { input = input.slice(0, -1); process.stdout.write("\b \b"); }
        } else {
          input += c;
          process.stdout.write("*");
        }
      };
      stdin.on("data", onData);
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => { rl.question(question, (a) => { rl.close(); resolve(a); }); });
}

// ── Decrypt ──────────────────────────────────────────────────────────────

function decryptAsset(encrypted: Buffer, hexKey: string): Buffer {
  const keyBytes = Buffer.from(hexKey, "hex");
  const aesKey = keyBytes.subarray(0, 32);
  const iv = keyBytes.subarray(32, 48);
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// ── Supplement Loading ──────────────────────────────────────────────────

function loadSupplement(filePath: string): SupplementItem[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error(`Supplement file must contain a JSON array, got ${typeof data}`);
  }
  return data.map((item: any) => ({
    id: String(item.id),
    name: item.name || `Package ${item.id}`,
  }));
}

function mergeWithSupplement(
  kharmaItems: PurchasedItem[],
  supplement: SupplementItem[],
): PurchasedItem[] {
  const knownIds = new Set(kharmaItems.map((p) => p.id));
  const extras: PurchasedItem[] = [];

  for (const s of supplement) {
    if (!knownIds.has(s.id)) {
      extras.push({
        id: s.id,
        name: s.name || `Package ${s.id}`,
        publisher: "Unknown",
        category: "Unknown",
        slug: "",
        can_download: 1,
      });
    }
  }

  if (extras.length > 0) {
    console.log(`  Supplement: ${extras.length} additional IDs (${supplement.length} total, ${supplement.length - extras.length} duplicates)`);
  }

  return [...kharmaItems, ...extras];
}

// ── Kharma API Client ────────────────────────────────────────────────────

class KharmaClient {
  private token = "";

  /** Load saved session */
  loadSession(): boolean {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
        if (data.token && data.timestamp) {
          const age = Date.now() - data.timestamp;
          if (age < 12 * 60 * 60 * 1000) { // 12 hours
            this.token = data.token;
            console.log("  Loaded saved session (age: " + Math.floor(age / 60000) + "m)");
            return true;
          }
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  saveSession() {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ token: this.token, timestamp: Date.now() }));
  }

  /** Make authenticated request */
  private async request(urlPath: string): Promise<Response> {
    const url = urlPath.startsWith("http") ? urlPath : `${KHARMA_BASE}${urlPath}`;
    return fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-Unity-Session": this.token,
      },
    });
  }

  /** Authenticate */
  async login(email: string, password: string): Promise<boolean> {
    console.log("  Authenticating with kharma.unity3d.com...");
    const response = await fetch(`${KHARMA_BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `user=${encodeURIComponent(email)}&pass=${encodeURIComponent(password)}`,
    });

    if (response.status !== 200) {
      console.error(`  Login failed: HTTP ${response.status}`);
      return false;
    }

    this.token = (await response.text()).trim();
    if (!this.token || this.token.startsWith("<")) {
      console.error("  Login failed: unexpected response");
      return false;
    }

    console.log("  Login successful!");
    this.saveSession();
    return true;
  }

  /** Check session validity */
  async checkSession(): Promise<boolean> {
    const r = await this.request("/api/en-US/account/downloads.json?offset=0&limit=1");
    return r.status === 200;
  }

  /** List all purchased assets */
  async listPurchases(): Promise<PurchasedItem[]> {
    const r = await this.request("/api/en-US/account/downloads.json");
    if (!r.ok) throw new Error(`Failed to list purchases: ${r.status}`);

    const data = await r.json() as any;
    const items: PurchasedItem[] = [];

    for (const group of data.results || []) {
      for (const item of group.items || []) {
        items.push({
          id: item.id,
          name: item.name || item.packagename || "Unknown",
          publisher: item.publisher?.name || "Unknown",
          category: item.category?.name || item.kategory?.name || "Unknown",
          slug: item.slug || "",
          can_download: item.can_download ?? 1,
        });
      }
    }

    return items;
  }

  /** Get download info for a package */
  async getDownloadInfo(packageId: string): Promise<DownloadInfo | null> {
    const r = await this.request(`/api/en-US/content/download/${packageId}.json`);
    if (!r.ok) {
      const exType = r.headers.get("x-kharma-exceptiontype") || "";
      console.error(`    [${r.status}] Package ${packageId}${exType ? " (" + exType + ")" : ""}`);
      return null;
    }

    const data = await r.json() as any;
    const d = data.download || data;
    return {
      url: d.url,
      key: d.key,
      filename_safe_package_name: d.filename_safe_package_name || packageId,
      filename_safe_publisher_name: d.filename_safe_publisher_name || "Unknown",
      filename_safe_category_name: d.filename_safe_category_name || "Unknown",
      id: packageId,
      md5: d.md5,
    };
  }
}

// ── Download ─────────────────────────────────────────────────────────────

async function downloadAsset(
  info: DownloadInfo,
  outputDir: string,
  skipExisting: boolean,
): Promise<"downloaded" | "skipped" | "failed"> {
  const dir = path.join(outputDir, info.filename_safe_publisher_name, info.filename_safe_category_name);
  const filename = `${info.filename_safe_package_name}.unitypackage`;
  const filepath = path.join(dir, filename);

  if (skipExisting && fs.existsSync(filepath)) {
    return "skipped";
  }

  if (!info.url) {
    console.error(`    No download URL`);
    return "failed";
  }

  try {
    const response = await fetch(info.url);
    if (!response.ok) {
      console.error(`    HTTP ${response.status} downloading`);
      return "failed";
    }

    const contentLength = response.headers.get("content-length");
    const totalMB = contentLength ? (parseInt(contentLength) / 1024 / 1024).toFixed(1) : "?";

    const buffer = Buffer.from(await response.arrayBuffer());
    let data = buffer;

    // Decrypt if key provided
    if (info.key) {
      try {
        data = decryptAsset(buffer, info.key);
      } catch {
        // If decryption fails, the file might not be encrypted
        data = buffer;
      }
    }

    // Verify it looks like a valid file (gzip magic bytes or tar)
    // .unitypackage is tar.gz, magic bytes: 1f 8b
    if (data[0] !== 0x1f || data[1] !== 0x8b) {
      // Maybe not encrypted after all, try raw
      if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
        data = buffer;
      }
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, data);
    console.log(`    Saved: ${(data.length / 1024 / 1024).toFixed(1)} MB -> ${path.relative(outputDir, filepath)}`);
    return "downloaded";
  } catch (err) {
    console.error(`    Error: ${err}`);
    return "failed";
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const outputDir = (opts.output as string) || DEFAULT_OUTPUT;
  const dryRun = !!opts.dryRun;
  const skipExisting = !!opts.skipExisting;
  const limit = opts.limit ? parseInt(opts.limit as string, 10) : Infinity;
  const concurrency = opts.concurrency ? parseInt(opts.concurrency as string, 10) : 3;
  const supplementFile = opts.supplement as string | undefined;

  console.log("=== Unity Asset Store Downloader ===\n");
  console.log(`  Output:        ${outputDir}`);
  console.log(`  Dry run:       ${dryRun}`);
  console.log(`  Skip existing: ${skipExisting}`);
  if (limit < Infinity) console.log(`  Limit:         ${limit}`);
  if (supplementFile) console.log(`  Supplement:    ${supplementFile}`);

  // ── Authenticate ───────────────────────────────────────────────────
  console.log("\n=== Authentication ===");
  const client = new KharmaClient();
  let authenticated = false;

  if (client.loadSession()) {
    authenticated = await client.checkSession();
    if (authenticated) console.log("  Session is valid!");
    else console.log("  Session expired.");
  }

  if (!authenticated) {
    const email = (opts.email as string) || await prompt("  Email: ");
    const password = (opts.password as string) || await prompt("  Password: ", true);
    authenticated = await client.login(email, password);
    if (!authenticated) {
      console.error("\n  Authentication failed.");
      process.exit(1);
    }
  }

  // ── List purchases ─────────────────────────────────────────────────
  console.log("\n=== Fetching Purchases ===");
  let purchases = await client.listPurchases();
  console.log(`  Kharma API: ${purchases.length} packages`);

  // ── Merge supplement ───────────────────────────────────────────────
  if (supplementFile) {
    try {
      const supplement = loadSupplement(supplementFile);
      purchases = mergeWithSupplement(purchases, supplement);
    } catch (err) {
      console.error(`  Failed to load supplement: ${err}`);
      process.exit(1);
    }
  }

  console.log(`  Total: ${purchases.length} packages\n`);

  const toProcess = purchases.slice(0, Math.min(purchases.length, limit));

  if (dryRun) {
    console.log("=== Purchased Assets ===\n");
    for (const p of toProcess) {
      const dl = p.can_download ? "+" : "x";
      console.log(`  [${dl}] ${p.id.padStart(6)} | ${p.publisher.padEnd(25).slice(0, 25)} | ${p.name}`);
    }
    console.log(`\n  Total: ${purchases.length} packages`);
    console.log(`  Downloadable: ${purchases.filter((p) => p.can_download).length}`);
    return;
  }

  // ── Download ───────────────────────────────────────────────────────
  console.log(`=== Downloading ${toProcess.length} Packages ===\n`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const p = toProcess[i];
    const progress = `[${(i + 1).toString().padStart(3)}/${toProcess.length}]`;
    process.stdout.write(`  ${progress} ${p.name.slice(0, 50).padEnd(50)} `);

    if (!p.can_download) {
      console.log("(not downloadable)");
      skipped++;
      continue;
    }

    const info = await client.getDownloadInfo(p.id);
    if (!info) {
      failed++;
      continue;
    }

    const result = await downloadAsset(info, outputDir, skipExisting);
    if (result === "downloaded") downloaded++;
    else if (result === "skipped") { console.log("    (exists, skipped)"); skipped++; }
    else failed++;

    // Rate limit: 1 second between downloads
    if (i < toProcess.length - 1) await sleep(1000);
  }

  // ── Summary ────────────────────────────────────────────────────────
  console.log("\n=== Summary ===");
  console.log(`  Downloaded: ${downloaded}`);
  console.log(`  Skipped:    ${skipped}`);
  console.log(`  Failed:     ${failed}`);
  console.log(`  Output:     ${outputDir}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
