/**
 * Shared embedding + LLM gateway. Points the OpenAI SDK at the local Ollama server.
 * Extracted so the server, the query planner, and the headless connectors/migration
 * scripts all reuse ONE client and ONE getEmbedding — the enrich-then-commit discipline
 * (CLAUDE.md rule 4) depends on every writer producing embeddings the same way.
 */
import OpenAI from 'openai';
import { OLLAMA_BASE_URL, EMBEDDING_MODEL, VECTOR_DIMENSION, EMBED_TIMEOUT_MS } from './config.js';

// Ollama ignores the key, but the OpenAI SDK requires a non-empty string. The timeout
// bounds a hung gateway (the SDK default is 10 minutes).
export const ai = new OpenAI({ baseURL: OLLAMA_BASE_URL, apiKey: 'ollama', timeout: EMBED_TIMEOUT_MS });

// Returns a plain number[] embedding for the given text.
export async function getEmbedding(text) {
  const response = await ai.embeddings.create({ input: [text], model: EMBEDDING_MODEL });
  const embedding = response.data[0].embedding;
  // Fail loudly at the boundary if the model's output doesn't match the vec table dimension,
  // instead of surfacing later as a cryptic sqlite-vec bind/DDL error (data-model.md rule 2).
  if (embedding.length !== VECTOR_DIMENSION) {
    throw new Error(
      `Embedding length ${embedding.length} != VECTOR_DIMENSION ${VECTOR_DIMENSION} ` +
      `(model ${EMBEDDING_MODEL}); set VECTOR_DIMENSION to match the model and re-embed.`
    );
  }
  return embedding;
}

// Convenience: embedding as the Float32Array that sqlite-vec binds directly.
export async function embedToFloat32(text) {
  return new Float32Array(await getEmbedding(text));
}
