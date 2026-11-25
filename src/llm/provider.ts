import { z } from "zod";

export type LLMTask = "plan" | "moments" | "draft" | "vision" | "transcribe";

export interface LLMCallOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  noCache?: boolean;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

export interface LLMProvider {
  json<T>(
    task: LLMTask,
    prompt: string,
    schema: z.ZodType<T>,
    opts?: LLMCallOptions,
  ): Promise<T>;

  vision(
    task: LLMTask,
    prompt: string,
    imageDataUrls: string[],
    opts?: LLMCallOptions,
  ): Promise<string>;

  getUsage(): Record<string, TokenUsage>;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionProvider {
  transcribe(
    audioPath: string,
    opts?: { model?: string },
  ): Promise<TranscriptSegment[]>;
}

export interface MistralModelInfo {
  id: string;
  object?: string;
  capabilities?: {
    completion_chat?: boolean;
    vision?: boolean;
    function_calling?: boolean;
    audio?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

