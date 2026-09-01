import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OpenAIInferenceClient } from "./inference";
import type { OpenAIInferenceConfig } from "./inference";

const capturedBodies: Record<string, unknown>[] = [];
const tagSchema = z.object({ tags: z.array(z.string()) });

vi.mock("openai", () => {
  const OpenAIMock = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn(async (body: Record<string, unknown>) => {
          capturedBodies.push(body);
          return {
            choices: [{ message: { content: "{}" } }],
            usage: { total_tokens: 1 },
          };
        }),
      },
    },
    audio: {
      transcriptions: {
        create: vi.fn(async (body: Record<string, unknown>) => {
          capturedBodies.push(body);
          return { text: "transcribed text" };
        }),
      },
    },
  }));

  return {
    default: OpenAIMock,
    toFile: vi.fn(async (buffer: Buffer, name: string, opts?: object) => ({
      buffer,
      name,
      ...opts,
    })),
  };
});

vi.mock("openai/helpers/zod", () => ({
  zodResponseFormat: (schema: unknown, name: string) => ({
    type: "json_schema",
    json_schema: { name, schema },
  }),
}));

function makeConfig(
  outputSchema: OpenAIInferenceConfig["outputSchema"],
  speechModel?: string,
): OpenAIInferenceConfig {
  return {
    apiKey: "test-key",
    textModel: "test-text-model",
    imageModel: "test-image-model",
    speechModel,
    contextLength: 2048,
    maxOutputTokens: 1024,
    useMaxCompletionTokens: false,
    outputSchema,
  };
}

describe("OpenAIInferenceClient response_format", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
  });

  it("omits response_format for schema-less text inference in json mode", async () => {
    const client = new OpenAIInferenceClient(makeConfig("json"));

    await client.inferFromText("summarize this text", { schema: null });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].response_format).toBeUndefined();
  });

  it("keeps json_object for schema-backed text inference in json mode", async () => {
    const client = new OpenAIInferenceClient(makeConfig("json"));

    await client.inferFromText("infer tags as json", { schema: tagSchema });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].response_format).toEqual({ type: "json_object" });
  });

  it("omits response_format for schema-less image inference in json mode", async () => {
    const client = new OpenAIInferenceClient(makeConfig("json"));

    await client.inferFromImage("describe this image", "image/png", "BASE64", {
      schema: null,
    });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].response_format).toBeUndefined();
  });

  it("keeps structured response_format for schema-backed text inference in structured mode", async () => {
    const client = new OpenAIInferenceClient(makeConfig("structured"));

    await client.inferFromText("infer tags", { schema: tagSchema });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "schema" },
    });
  });
});

describe("OpenAIInferenceClient inferFromAudio", () => {
  beforeEach(() => {
    capturedBodies.length = 0;
  });

  it("sends the configured speech model and the audio file to the transcription endpoint", async () => {
    const client = new OpenAIInferenceClient(
      makeConfig("json", "test-speech-model"),
    );

    const result = await client.inferFromAudio({
      contentType: "audio/mpeg",
      buffer: Buffer.from("AUDIO_BYTES"),
    });

    expect(result.response).toBe("transcribed text");
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].model).toBe("test-speech-model");
    expect(capturedBodies[0].file).toMatchObject({
      name: "audio.mp3",
      type: "audio/mpeg",
    });
  });

  it("derives the file extension from the audio content type", async () => {
    const client = new OpenAIInferenceClient(
      makeConfig("json", "test-speech-model"),
    );

    await client.inferFromAudio({
      contentType: "audio/x-m4a",
      buffer: Buffer.from("AUDIO_BYTES"),
    });

    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0].file).toMatchObject({
      name: "audio.m4a",
      type: "audio/x-m4a",
    });
  });

  it("throws when the speech model is not configured", async () => {
    const client = new OpenAIInferenceClient(makeConfig("json"));

    await expect(
      client.inferFromAudio({
        contentType: "audio/mpeg",
        buffer: Buffer.from("AUDIO_BYTES"),
      }),
    ).rejects.toThrow(/INFERENCE_SPEECH_MODEL/);
    expect(capturedBodies).toHaveLength(0);
  });
});
