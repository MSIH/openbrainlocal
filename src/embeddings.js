/**
 * Shared embedding + LLM gateway. Points the OpenAI SDK at the local Ollama server.
 * Extracted so the server, the query planner, and the headless connectors/migration
 * scripts all reuse ONE client and ONE getEmbedding — the enrich-then-commit discipline
 * (CLAUDE.md rule 4) depends on every writer producing embeddings the same way.
 */
import OpenAI from 'openai';
import { OLLAMA_BASE_URL, EMBEDDING_MODEL } from './config.js';

// Ollama ignores the key, but the OpenAI SDK requires a non-empty string.
export const ai = new OpenAI({ baseURL: OLLAMA_BASE_URL, apiKey: 'ollama' });

// Returns a plain number[] embedding for the given text.
export async function getEmbedding(text) {
  const response = await ai.embeddings.create({ input: [text], model: EMBEDDING_MODEL });
  return response.data[0].embedding;
}

// Convenience: embedding as the Float32Array that sqlite-vec binds directly.
export async function embedToFloat32(text) {
  return new Float32Array(await getEmbedding(text));
}
