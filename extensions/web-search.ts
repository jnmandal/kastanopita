/**
 * Web Search & Fetch Extension for Pi
 *
 * Registers two tools:
 *   - `web_search`: Search the web via DuckDuckGo (no API key required)
 *   - `web_fetch`:  Fetch a URL and extract clean text content from HTML
 *
 * No API key required — DuckDuckGo HTML is the search engine.
 *
 * In-session caching prevents duplicate fetches within a session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type FetchResult = {
  text: string;
  status: "ok" | "empty" | "non-html";
  truncated: boolean;
  originalLength: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// In-session fetch cache
// ─────────────────────────────────────────────────────────────────────────────

const fetchCache = new Map<string, FetchResult>();

// ─────────────────────────────────────────────────────────────────────────────
// HTML utilities
// ─────────────────────────────────────────────────────────────────────────────

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&rsquo;/g, "’")
    .replace(/&lsquo;/g, "‘")
    .replace(/&ldquo;/g, "“")
    .replace(/&rdquo;/g, "”")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&copy;/g, "©")
    .replace(/&reg;/g, "®")
    .replace(/&trade;/g, "™")
    .replace(/&deg;/g, "°")
    .replace(/&plusmn;/g, "±")
    .replace(/&times;/g, "×")
    .replace(/&divide;/g, "÷")
    .replace(/&rarr;/g, "→")
    .replace(/&larr;/g, "←")
    .replace(/&middot;/g, "·")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Decode a DuckDuckGo HTML redirect URL to the real target.
 * DDG uses //duckduckgo.com/l/?uddg=<encoded_url>&rut=...
 */
function extractDuckDuckGoUrl(href: string): string {
  try {
    const fullHref = href.startsWith("//") ? "https:" + href : href;
    const url = new URL(fullHref, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) {
      return decodeURIComponent(uddg);
    }
    return url.toString();
  } catch {
    return href;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Search engines
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search DuckDuckGo's HTML endpoint. No API key required.
 */
async function duckDuckGoSearch(
  query: string,
  maxResults: number,
  timeoutMs: number,
): Promise<SearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`DuckDuckGo returned HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const results: SearchResult[] = [];

    // Split by result blocks
    const blocks = html.split('<div class="links_main links_deep result__body">');

    for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
      const block = blocks[i];

      // Extract title
      const titleMatch = block.match(
        /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
      );
      if (!titleMatch) continue;

      const title = stripHtmlTags(titleMatch[2]);
      if (!title) continue;

      // Decode the real URL from DuckDuckGo redirect
      let realUrl = extractDuckDuckGoUrl(titleMatch[1]);
      if (!realUrl.startsWith("http://") && !realUrl.startsWith("https://")) {
        realUrl = "https://" + realUrl;
      }

      // Extract snippet
      const snippetMatch = block.match(
        /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i,
      );
      const snippet = snippetMatch
        ? stripHtmlTags(snippetMatch[1]).replace(/\.\.\.$/, "").trim()
        : "";

      results.push({ title, url: realUrl, snippet });
    }

    return results;
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Web content fetch
// ─────────────────────────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  let u = url.trim();
  if (!u.startsWith("http://") && !u.startsWith("https://")) {
    u = "https://" + u;
  }
  // Remove trailing slash for cache key consistency
  return u.replace(/\/$/, "");
}

async function fetchWebContent(
  rawUrl: string,
  maxChars: number,
  timeoutMs: number,
): Promise<FetchResult> {
  const url = normalizeUrl(rawUrl);
  const cacheKey = url + "|" + maxChars;

  // Check cache
  const cached = fetchCache.get(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";

    // Non-HTML content — return raw text
    if (!contentType.includes("html") && !contentType.includes("xml")) {
      const text = await response.text();
      const result: FetchResult = {
        text: text.slice(0, maxChars),
        status: "non-html",
        truncated: text.length > maxChars,
        originalLength: text.length,
      };
      fetchCache.set(cacheKey, result);
      return result;
    }

    const html = await response.text();

    // Try extracting article content first (blog posts, news articles)
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    let text = articleMatch ? stripHtmlTags(articleMatch[1]).trim() : "";

    // Fall back to main content
    if (text.length < 200) {
      const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
      if (mainMatch) {
        const mainText = stripHtmlTags(mainMatch[1]).trim();
        if (mainText.length > text.length) text = mainText;
      }
    }

    // Fall back to full body
    if (text.length < 200) {
      text = stripHtmlTags(html);
    }

    let truncated = false;
    const originalLength = text.length;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }

    const result: FetchResult = {
      text,
      status: text.length > 0 ? "ok" : "empty",
      truncated,
      originalLength,
    };

    fetchCache.set(cacheKey, result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Result formatting
// ─────────────────────────────────────────────────────────────────────────────

function formatSearchResults(
  query: string,
  results: SearchResult[],
  engine: string,
): string {
  const lines = [
    `Web search results for: "${query}" — ${results.length} found via ${engine}`,
    "",
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`  ${i + 1}. ${r.title}`);
    if (r.url) lines.push(`     ${r.url}`);
    if (r.snippet) lines.push(`     ${r.snippet}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension registration
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── web_search ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for information. Returns a list of results with titles, URLs, and snippets. " +
      "Use this to find current information, documentation, or references about any topic. " +
      "Uses DuckDuckGo — no API key required.",
    promptGuidelines: [
      "Use web_search when you need information not in your training data or need to verify current facts.",
      "After searching, use web_fetch to read a specific result if you need its full content.",
      "Keep queries specific for better results. Include key terms.",
    ],

    parameters: Type.Object({
      query: Type.String({ description: "The search query to look up" }),
      max_results: Type.Optional(
        Type.Number({
          description: "Maximum number of results to return (default: 5, max: 10)",
          minimum: 1,
          maximum: 10,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds (default: 15000)",
          minimum: 1000,
          maximum: 60000,
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const query = params.query;
      const maxResults = Math.min(params.max_results ?? 5, 10);
      const timeoutMs = params.timeout ?? 15_000;

      let results: SearchResult[];
      const engine = "DuckDuckGo";

      try {
        results = await duckDuckGoSearch(query, maxResults, timeoutMs);
      } catch (error: unknown) {
        const isTimeout =
          error instanceof Error && error.name === "AbortError";
        const msg = isTimeout
          ? `Search timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
        return {
          content: [{ type: "text", text: `Search error: ${msg}` }],
          details: { query, engine: "error", error: msg },
        };
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No results found for "${query}". Try rephrasing or broadening your query.`,
            },
          ],
          details: { query, engine, results, count: 0 },
        };
      }

      const text = formatSearchResults(query, results, engine);

      return {
        content: [{ type: "text", text }],
        details: { query, engine, results, count: results.length },
      };
    },

    renderCall(args, theme) {
      const q = args.query || "...";
      const max = args.max_results ? ` (max ${args.max_results})` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("🔍 web_search ")) +
          theme.fg("accent", `"${q}"`) +
          theme.fg("muted", max),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const textBlock = result.content.find((c) => c.type === "text");
      if (!textBlock || textBlock.type !== "text") return new Text("", 0, 0);

      if (!expanded) {
        const firstLine = textBlock.text.split("\n")[0];
        return new Text(theme.fg("toolOutput", firstLine), 0, 0);
      }

      const lines = textBlock.text
        .split("\n")
        .map((line) => {
          if (/^\d+\./.test(line)) return theme.fg("success", line);
          if (line.startsWith("     http")) return theme.fg("accent", line);
          if (line.trim() === "" || line.startsWith("Web search")) return line;
          return theme.fg("muted", line);
        })
        .join("\n");

      return new Text("\n" + lines, 0, 0);
    },
  });

  // ── web_fetch ───────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page URL and extract its text content. " +
      "Useful for reading the full content of a search result or any web page. " +
      "Returns clean text with HTML stripped. JavaScript-rendered pages may not fetch well. " +
      "Results are cached within a session to avoid duplicate fetches.",
    promptGuidelines: [
      "Use web_fetch after web_search to read a specific page in full.",
      "The returned text has HTML stripped; some JavaScript-rendered pages may not fetch well.",
      "For very long pages, use max_chars to control the output size.",
    ],

    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      max_chars: Type.Optional(
        Type.Number({
          description: "Maximum characters to return (default: 5000, max: 50000)",
          minimum: 500,
          maximum: 50000,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in milliseconds (default: 30000)",
          minimum: 1000,
          maximum: 120000,
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const url = params.url;
      const maxChars = Math.min(params.max_chars ?? 5000, 50000);
      const timeoutMs = params.timeout ?? 30_000;

      try {
        const { text, status, truncated, originalLength } = await fetchWebContent(
          url,
          maxChars,
          timeoutMs,
        );

        if (status === "empty") {
          return {
            content: [
              {
                type: "text",
                text: `Fetched ${url} but found no text content. The page may be rendered entirely with JavaScript or is empty.`,
              },
            ],
            details: { url, status: "empty", charCount: 0 },
          };
        }

        let output = text;
        const headerParts = [`📄 ${url}`];
        if (status === "non-html") headerParts.push("(non-HTML content)");
        if (truncated)
          headerParts.push(`(${maxChars} of ${originalLength} chars returned)`);
        else headerParts.push(`(${text.length} chars)`);

        output = headerParts.join(" ") + "\n\n" + text;

        return {
          content: [{ type: "text", text: output }],
          details: { url, charCount: text.length, truncated, status },
        };
      } catch (error: unknown) {
        const isTimeout = error instanceof Error && error.name === "AbortError";
        const msg = isTimeout
          ? `Request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error);
        return {
          content: [{ type: "text", text: `Fetch error for ${url}: ${msg}` }],
          details: { url, error: msg, status: "error" },
        };
      }
    },

    renderCall(args, theme) {
      const u = args.url || "...";
      const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
      const max = args.max_chars ? ` (${args.max_chars} chars)` : "";
      return new Text(
        theme.fg("toolTitle", theme.bold("📄 web_fetch ")) +
          theme.fg("accent", display) +
          theme.fg("muted", max),
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const textBlock = result.content.find((c) => c.type === "text");
      if (!textBlock || textBlock.type !== "text") return new Text("", 0, 0);

      const details = result.details as
        | { url?: string; charCount?: number; truncated?: boolean; error?: string; status?: string }
        | undefined;

      // Error case
      if (details?.error || details?.status === "error") {
        return new Text(
          theme.fg("error", `⚠ ${details.error ?? "fetch failed"}`),
          0,
          0,
        );
      }

      // Empty case
      if (details?.status === "empty") {
        return new Text(
          theme.fg("muted", `⚠ ${details.url ?? "url"} — no text content found`),
          0,
          0,
        );
      }

      if (!expanded) {
        const count = details?.charCount;
        const url = details?.url ?? "unknown";
        const trunc = details?.truncated ? " (truncated)" : "";
        return new Text(
          theme.fg("toolOutput", `→ ${url} (${count ?? "?"} chars${trunc})`),
          0,
          0,
        );
      }

      const lines = textBlock.text
        .split("\n")
        .map((line) => {
          if (line.startsWith("📄")) return theme.fg("toolTitle", line);
          return theme.fg("toolOutput", line);
        })
        .join("\n");
      return new Text("\n" + lines, 0, 0);
    },
  });
}
