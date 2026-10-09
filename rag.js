import { answerQuestion, generateEmbedding } from './gemini.js';
import { searchSimilarFiles } from './database.js';

// Documents below this cosine score are considered unrelated to the query.
const SCORE_THRESHOLD = 0.2;
const MAX_SOURCES = 3;

/**
 * Retrieve the documents that best match a user turn.
 *
 * The written question and any attached media often point at the same thing
 * (showing a machine while asking about its manual), so both signals are
 * searched and merged. Searching only by text silently missed the attachment:
 * with a permissive threshold the text almost always "matched" something, so a
 * text-only fallback for the media rarely ran.
 *
 * @param {string} question The user's written question, may be empty.
 * @param {Array<object>} mediaParts Gemini parts from attached files.
 * @returns {Promise<Array<object>>} Up to MAX_SOURCES documents with scores.
 */
export async function retrieveContext(question, mediaParts = []) {
  const queries = [];

  if (question && question.trim()) {
    queries.push({ origin: 'texto', text: question.trim() });
  }

  if (mediaParts.length > 0) {
    try {
      const description = await answerQuestion(
        'Describe en detalle el contenido de este archivo. Genera palabras clave específicas.',
        [],
        mediaParts,
        { describeOnly: true }
      );
      if (description && description.trim()) {
        // The description includes any narration in the clip, so codes like
        // "E03" or a model number spoken out loud end up in the search terms.
        queries.push({ origin: 'archivo adjunto', text: description.trim() });
      }
    } catch (err) {
      console.log('[RAG] Could not describe the attachment:', err.message);
    }
  }

  if (queries.length === 0) return [];

  const byId = new Map();
  for (const query of queries) {
    const embedding = await generateEmbedding(query.text);
    const matches = await searchSimilarFiles(embedding, MAX_SOURCES);
    for (const match of matches) {
      if (match.score < SCORE_THRESHOLD) continue;

      const existing = byId.get(match.id);
      if (!existing) {
        byId.set(match.id, { ...match, matchedBy: [query.origin] });
      } else {
        existing.matchedBy.push(query.origin);
        // Keep the strongest score any query gave this document
        if (match.score > existing.score) {
          existing.score = match.score;
          existing.summary = match.summary;
          existing.name = match.name;
          existing.mimeType = match.mimeType;
        }
      }
    }
  }

  const sources = [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SOURCES);

  console.log(
    `[RAG] Queries: ${queries.map((q) => q.origin).join(' + ')} | ` +
    `matched: ${sources.length} doc(s)` +
    (sources.length ? ` -> ${sources.map((s) => `${s.name} (${(s.score * 100).toFixed(0)}%${s.matchedBy.length > 1 ? ', ambas' : ''})`).join(', ')}` : '')
  );

  return sources;
}