import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { promisify } from "node:util";

const MAX_CHARS = 24_000;
const MAX_PAGES = 200;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const CACHE_VERSION = 2;
const CACHE_DIR = resolve(homedir(), ".pi/cache/pdf-reader");
const exec = promisify(execFile);
const NOTICE = "\n[Output truncated; request a narrower page range or a higher maxChars.]";

type Extracted = { version: number; pages: string[]; method: "pdftotext" };

function parsePages(spec: string | undefined): number[] | undefined {
  if (spec === undefined) return undefined;
  if (!spec.trim() || spec.length > 4_000) throw new Error("Use a page range such as 1-3,5 (up to 200 distinct pages).");
  const pages = new Set<number>();
  for (const part of spec.split(",")) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error("Invalid page range. Use forms such as 1-3,5.");
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= MAX_PAGES) {
      throw new Error("Page numbers must be safe positive integers; ranges must be ascending and at most 200 pages wide.");
    }
    for (let page = start; page <= end; page++) {
      pages.add(page);
      if (pages.size > MAX_PAGES) throw new Error("Select at most 200 distinct pages per request.");
    }
  }
  return [...pages].sort((a, b) => a - b);
}

// Bound reads before allocation; reject directories, devices, and named pipes.
async function readBounded(file: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const { stat } = await import("node:fs/promises");
  if (!(await stat(file)).isFile()) throw new Error(`Not a regular file: ${file}`);
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error(`File must be a regular file no larger than ${maxBytes} bytes: ${file}`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${file}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function validCache(value: unknown): value is Extracted {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Extracted>;
  return item.version === CACHE_VERSION && item.method === "pdftotext" &&
    Array.isArray(item.pages) && item.pages.length > 0 && item.pages.every((page) => typeof page === "string");
}

async function extractPdf(file: string, signal?: AbortSignal) {
  const data = await readBounded(file, MAX_FILE_BYTES, signal);
  if (!data.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("File does not contain a PDF header.");
  const digest = createHash("sha256").update(data).digest("hex");
  const cacheFile = resolve(CACHE_DIR, `v${CACHE_VERSION}-${digest}.json`);
  try {
    const cached: unknown = JSON.parse((await readBounded(cacheFile, MAX_TEXT_BYTES * 6, signal)).toString("utf8"));
    if (validCache(cached)) return { ...cached, cache: "hit" as const };
  } catch {
    signal?.throwIfAborted(); // Corrupt, missing, or inaccessible cache: extract again.
  }

  signal?.throwIfAborted();
  let stdout: string;
  try {
    // Feed the exact hashed bytes through stdin, avoiding file-change/cache races.
    const child = exec("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], {
      encoding: "utf8", maxBuffer: MAX_TEXT_BYTES, timeout: 60_000, signal, killSignal: "SIGKILL",
    });
    child.child.stdin?.on("error", () => { /* exec's rejection reports early process exit */ });
    child.child.stdin?.end(data);
    ({ stdout } = await child);
  } catch (error) {
    signal?.throwIfAborted();
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    if (failure.code === "ENOENT") throw new Error("PDF extraction requires Poppler's pdftotext. Install with `brew install poppler` (macOS) or `apt install poppler-utils` (Debian/Ubuntu).");
    if (failure.killed) throw new Error("PDF extraction exceeded its 60-second timeout.");
    throw new Error(`PDF extraction failed (the PDF may be encrypted or damaged): ${String(failure.message).slice(0, 1000)}`);
  }
  signal?.throwIfAborted();
  const pages = stdout.split("\f");
  // Poppler emits a terminator after the last page, not an extra blank page.
  // Remove exactly that sentinel; preserve real blank pages and their numbering.
  if (pages.length > 1 && pages[pages.length - 1].trim() === "") pages.pop();
  const extracted: Extracted = { version: CACHE_VERSION, pages: pages.map((page) => page.trim()), method: "pdftotext" };
  const temporary = `${cacheFile}.${randomUUID()}.tmp`;
  let cache: "miss" | "unavailable" = "miss";
  try {
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(extracted), { mode: 0o600, flag: "wx", signal });
    await rename(temporary, cacheFile); // Atomic publication for parallel tool calls.
  } catch {
    signal?.throwIfAborted();
    cache = "unavailable"; // Caching is optional; successful extraction must still work.
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  signal?.throwIfAborted();
  return { ...extracted, cache };
}

// Keep metadata and the truncation notice inside the advertised budget. Also
// respect Pi's 50KB / 2000-line output convention, including non-ASCII text.
function boundedOutput(text: string, maxChars: number) {
  function prefix(value: string, chars: number, bytes: number, lines: number) {
    let result = "";
    let size = 0;
    let lineCount = 1;
    for (const character of value) {
      const nextSize = size + Buffer.byteLength(character);
      const nextLines = lineCount + (character === "\n" ? 1 : 0);
      if (result.length + character.length > chars || nextSize > bytes || nextLines > lines) break;
      result += character;
      size = nextSize;
      lineCount = nextLines;
    }
    return result;
  }
  const head = prefix(text, maxChars, 50 * 1024, 2000);
  const truncated = head.length < text.length;
  return {
    text: truncated ? prefix(head, maxChars - NOTICE.length, 50 * 1024 - Buffer.byteLength(NOTICE), 1999) + NOTICE : head,
    truncated,
  };
}

function integerOption(value: number | undefined, fallback: number, min: number, max: number) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Expected an integer between ${min} and ${max}.`);
  return result;
}

function pdfPath(cwd: string, path: string) {
  if (!path.trim()) throw new Error("PDF path must not be empty.");
  return resolve(cwd, path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "read_pdf",
    label: "Read PDF",
    description: "Read cached, page-addressable text from a local PDF (requires Poppler/pdftotext). Use pages such as 1-3,8; at most 200 selected pages. For large documents, use search_pdf first. Output is bounded by maxChars, 50KB, and 2000 lines. Scanned PDFs need OCR. PDFs up to 100MiB are supported.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "PDF path, relative to the working directory or absolute; ~/ is supported" }),
      pages: Type.Optional(Type.String({ minLength: 1, maxLength: 4000, description: "Optional page range, e.g. 1-3,5" })),
      maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: MAX_CHARS, description: "Maximum returned characters including notices (default 12000)" })),
    }),
    async execute(_toolCallId, { path, pages, maxChars }, signal, _onUpdate, ctx) {
      const file = pdfPath(ctx.cwd, path);
      const selected = parsePages(pages);
      const limit = integerOption(maxChars, 12_000, 500, MAX_CHARS);
      const extracted = await extractPdf(file, signal);
      if (selected?.some((page) => page > extracted.pages.length)) throw new Error(`Page selection exceeds this PDF's ${extracted.pages.length} pages.`);
      const indices = selected ?? extracted.pages.map((_, index) => index + 1);
      const parts: string[] = [];
      let length = 0;
      for (const page of indices) {
        const block = `[Page ${page}]\n${extracted.pages[page - 1] || "[No extractable text on this page; it may be blank or require OCR.]"}`;
        // Only accumulate enough text to establish whether truncation is needed.
        parts.push(block.slice(0, limit + 1));
        length += parts[parts.length - 1].length + (parts.length > 1 ? 2 : 0);
        if (length > limit) break;
      }
      const output = boundedOutput(parts.join("\n\n"), limit);
      return { content: [{ type: "text", text: output.text }], details: { path: file, method: extracted.method, pageCount: extracted.pages.length, selectedPages: selected ?? "all", charactersReturned: output.text.length, truncated: output.truncated, cache: extracted.cache } };
    },
  });

  pi.registerTool({
    name: "search_pdf",
    label: "Search PDF",
    description: "Search a local PDF using case-insensitive whitespace-separated literal terms (OR matching, not exact phrases). Pages rank by total non-overlapping occurrences of distinct terms. Returns one snippet per matching page. Requires Poppler/pdftotext; scanned PDFs need OCR.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "PDF path, relative to the working directory or absolute; ~/ is supported" }),
      query: Type.String({ minLength: 1, maxLength: 1000, description: "Whitespace-separated literal terms; matches any term, case-insensitively" }),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum matching pages (default 6)" })),
      contextChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 1200, description: "Maximum snippet characters per matching page (default 500)" })),
    }),
    async execute(_toolCallId, { path, query, maxResults, contextChars }, signal, _onUpdate, ctx) {
      const file = pdfPath(ctx.cwd, path);
      if (!query.trim() || query.length > 1000) throw new Error("Query must contain searchable terms and be at most 1000 characters.");
      const terms = [...new Set(query.split(/\s+/).filter(Boolean).map((term) => term.toLowerCase()))];
      const count = integerOption(maxResults, 6, 1, 20);
      const radius = integerOption(contextChars, 500, 100, 1200);
      const extracted = await extractPdf(file, signal);
      const matches: { page: number; score: number; snippet: string }[] = [];
      let totalMatches = 0;
      for (let index = 0; index < extracted.pages.length; index++) {
        signal?.throwIfAborted();
        const text = extracted.pages[index].replace(/\s+/g, " ").trim();
        let score = 0;
        let first = Infinity;
        // Regex indices address the original string even when case folding changes
        // string length (e.g. dotted I). Escape terms to keep matching literal.
        for (const term of terms) {
          await yieldToEventLoop(undefined, { signal });
          const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
          for (const match of text.matchAll(pattern)) {
            score++;
            if (score % 8192 === 0) await yieldToEventLoop(undefined, { signal });
            first = Math.min(first, match.index);
          }
        }
        if (!score) continue;
        totalMatches++;
        const start = Math.max(0, Math.min(first - Math.floor(radius / 2), text.length - radius));
        matches.push({ page: index + 1, score, snippet: text.slice(start, start + radius) });
        matches.sort((a, b) => b.score - a.score || a.page - b.page);
        if (matches.length > count) matches.pop();
      }
      const output = boundedOutput(matches.map((match) => `[Page ${match.page}; score ${match.score}] ${match.snippet}`).join("\n\n") || "No matching text found. If this is a scanned PDF, OCR is needed.", MAX_CHARS);
      return { content: [{ type: "text", text: output.text }], details: { path: file, method: extracted.method, matches: matches.length, totalMatchingPages: totalMatches, pageCount: extracted.pages.length, truncated: output.truncated, cache: extracted.cache } };
    },
  });
}
