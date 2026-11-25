import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getCachedLlm, setCachedLlm } from "./cache.js";
import { resolveTaskModel, type CliModelOverrides } from "./models.js";
import type { CampaignProfile } from "../core/profile.js";
import type {
  LLMCallOptions,
  LLMProvider,
  LLMTask,
  MistralModelInfo,
  TokenUsage,
  TranscriptSegment,
  TranscriptionProvider,
} from "./provider.js";

const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

export interface MistralClientOptions {
  apiKey?: string;
  minIntervalMs?: number;
  maxAttempts?: number;
  fetchFn?: typeof fetch;
  cacheDir?: string;
  profile?: CampaignProfile;
  cliOverrides?: CliModelOverrides;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerVal: string | null): number | null {
  if (!headerVal) return null;
  const sec = Number(headerVal);
  if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
  const dateMs = Date.parse(headerVal);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

export class MistralClient implements LLMProvider, TranscriptionProvider {
  private readonly apiKey: string;
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly fetchFn: typeof fetch;
  private readonly cacheDir?: string;
  private readonly profile?: CampaignProfile;
  private readonly cliOverrides?: CliModelOverrides;

  private queue: Promise<void> = Promise.resolve();
  private lastCallAt = 0;
  private usage: Record<string, TokenUsage> = {};

  constructor(opts: MistralClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.MISTRAL_API_KEY ?? "";
    const envInterval = Number(process.env.MISTRAL_MIN_INTERVAL_MS);
    this.minIntervalMs =
      opts.minIntervalMs ??
      (Number.isFinite(envInterval) && envInterval >= 0 ? envInterval : 1100);
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.cacheDir = opts.cacheDir;
    this.profile = opts.profile;
    this.cliOverrides = opts.cliOverrides;
  }

  private resolveModel(task: LLMTask, explicit?: string): string {
    if (explicit) return explicit;
    return resolveTaskModel(task, {
      cliOverrides: this.cliOverrides,
      profile: this.profile,
    });
  }

  private recordUsage(
    task: string,
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
  ): void {
    if (!this.usage[task]) {
      this.usage[task] = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        calls: 0,
      };
    }
    this.usage[task].calls += 1;
    this.usage[task].promptTokens += usage?.prompt_tokens ?? 0;
    this.usage[task].completionTokens += usage?.completion_tokens ?? 0;
    this.usage[task].totalTokens += usage?.total_tokens ?? 0;
  }

  getUsage(): Record<string, TokenUsage> {
    return structuredClone(this.usage);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const elapsed = Date.now() - this.lastCallAt;
      if (this.lastCallAt > 0 && elapsed < this.minIntervalMs) {
        await sleep(this.minIntervalMs - elapsed);
      }
      try {
        return await fn();
      } finally {
        this.lastCallAt = Date.now();
      }
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    if (!this.apiKey) {
      throw new Error("MISTRAL_API_KEY is not set. Add it to .env or your environment.");
    }

    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const res = await this.enqueue(async () => {
        return this.fetchFn(url, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(init.headers ?? {}),
          },
        });
      });

      if (res.ok) {
        const remReq = res.headers.get("x-ratelimit-remaining-req-minute");
        if (remReq === "0") {
          // Next call would hit 429 on 2-RPM free tier; push lastCallAt forward
          this.lastCallAt = Date.now() + 30_000;
        }
        return res;
      }

      const status = res.status;
      const bodyText = await res.text().catch(() => "");
      lastErr = new Error(
        `Mistral API error ${status}: ${bodyText.slice(0, 300)}`,
      );

      if ((status === 429 || status >= 500) && attempt < this.maxAttempts) {
        const retryAfter = parseRetryAfterMs(res.headers.get("retry-after"));
        const baseBackoff =
          status === 429
            ? Math.min(62_000, 15_000 * attempt)
            : Math.min(30_000, 1000 * Math.pow(2, attempt - 1));
        const jitter = Math.floor(Math.random() * 500);
        const delay = retryAfter !== null ? Math.max(retryAfter, 250) : baseBackoff + jitter;
        await sleep(delay);
        continue;
      }

      throw lastErr;
    }

    throw lastErr;
  }

  private async chatCompletion(
    task: LLMTask,
    model: string,
    messages: Array<{ role: string; content: unknown }>,
    opts: { temperature?: number; maxTokens?: number; jsonMode?: boolean },
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? (task === "plan" ? 0.7 : 0.2),
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.jsonMode) body.response_format = { type: "json_object" };

    const res = await this.fetchWithRetry(`${MISTRAL_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    this.recordUsage(task, data.usage);
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Mistral chat completion returned empty content");
    }
    return content;
  }

  async json<T>(
    task: LLMTask,
    prompt: string,
    schema: z.ZodType<T>,
    opts: LLMCallOptions = {},
  ): Promise<T> {
    const model = this.resolveModel(task, opts.model);
    if (!opts.noCache) {
      const cached = getCachedLlm<T>(model, task, prompt, this.cacheDir);
      if (cached !== null) {
        const check = schema.safeParse(cached);
        if (check.success) return check.data;
      }
    }

    const messages: Array<{ role: string; content: unknown }> = [
      {
        role: "system",
        content:
          "You are a precise assistant. Always respond with valid JSON matching the requested schema.",
      },
      { role: "user", content: prompt },
    ];

    const raw = await this.chatCompletion(task, model, messages, {
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      jsonMode: true,
    });

    const tryParse = (text: string): { ok: true; data: T } | { ok: false; err: string } => {
      try {
        const cleaned = text
          .trim()
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/\s*```$/i, "");
        const parsedJson = JSON.parse(cleaned);
        const res = schema.safeParse(parsedJson);
        if (res.success) return { ok: true, data: res.data };
        return {
          ok: false,
          err: res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        };
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) };
      }
    };

    const first = tryParse(raw);
    if (first.ok) {
      if (!opts.noCache) {
        setCachedLlm(model, task, prompt, first.data, this.cacheDir);
      }
      return first.data;
    }

    // One auto-repair retry
    const repairPrompt = `Your previous JSON response failed validation: ${first.err}\n\nPrevious output:\n${raw}\n\nReturn ONLY valid corrected JSON matching the schema.`;
    const repairedRaw = await this.chatCompletion(
      task,
      model,
      [
        ...messages,
        { role: "assistant", content: raw },
        { role: "user", content: repairPrompt },
      ],
      {
        temperature: 0.1,
        maxTokens: opts.maxTokens,
        jsonMode: true,
      },
    );

    const second = tryParse(repairedRaw);
    if (second.ok) {
      if (!opts.noCache) {
        setCachedLlm(model, task, prompt, second.data, this.cacheDir);
      }
      return second.data;
    }

    throw new Error(`LLM JSON validation failed after repair: ${second.err}`);
  }

  async vision(
    task: LLMTask,
    prompt: string,
    imageDataUrls: string[],
    opts: LLMCallOptions = {},
  ): Promise<string> {
    const model = this.resolveModel(task, opts.model);
    const cachePrompt = `${prompt}\n[images:${imageDataUrls.length}:${imageDataUrls.map((u) => u.slice(-24)).join(",")}]`;
    if (!opts.noCache) {
      const cached = getCachedLlm<string>(model, task, cachePrompt, this.cacheDir);
      if (typeof cached === "string") return cached;
    }

    const contentParts: Array<Record<string, unknown>> = [
      { type: "text", text: prompt },
      ...imageDataUrls.map((url) => ({
        type: "image_url",
        image_url: { url },
      })),
    ];

    const raw = await this.chatCompletion(
      task,
      model,
      [{ role: "user", content: contentParts }],
      {
        temperature: opts.temperature ?? 0.2,
        maxTokens: opts.maxTokens ?? 300,
        jsonMode: false,
      },
    );

    if (!opts.noCache) {
      setCachedLlm(model, task, cachePrompt, raw, this.cacheDir);
    }
    return raw;
  }

  async transcribe(
    audioPath: string,
    opts: { model?: string } = {},
  ): Promise<TranscriptSegment[]> {
    const model = this.resolveModel("transcribe", opts.model);
    const audioBuf = fs.readFileSync(audioPath);
    const form = new FormData();
    form.append("model", model);
    form.append("timestamp_granularities", "segment");
    // Note: never pass `language` together with `timestamp_granularities` per Mistral API docs.
    form.append(
      "file",
      new Blob([audioBuf], { type: "audio/mpeg" }),
      path.basename(audioPath),
    );

    const res = await this.fetchWithRetry(
      `${MISTRAL_BASE_URL}/audio/transcriptions`,
      {
        method: "POST",
        body: form,
      },
    );

    const data = (await res.json()) as {
      text?: string;
      segments?: Array<{ start?: number; end?: number; text?: string }>;
    };

    if (Array.isArray(data.segments) && data.segments.length > 0) {
      return data.segments.map((s) => ({
        start: Number(s.start ?? 0),
        end: Number(s.end ?? 0),
        text: String(s.text ?? "").trim(),
      }));
    }

    if (data.text) {
      return [{ start: 0, end: 0, text: data.text.trim() }];
    }
    return [];
  }

  async listModels(): Promise<MistralModelInfo[]> {
    const res = await this.fetchWithRetry(`${MISTRAL_BASE_URL}/models`, {
      method: "GET",
    });
    const data = (await res.json()) as { data?: MistralModelInfo[] };
    return data.data ?? [];
  }

  async testChatModel(modelId: string): Promise<boolean> {
    await this.chatCompletion(
      "plan",
      modelId,
      [{ role: "user", content: 'Reply with {"ok":true}' }],
      { temperature: 0, maxTokens: 16, jsonMode: true },
    );
    return true;
  }
}

