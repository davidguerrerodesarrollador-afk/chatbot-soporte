import { answerQuestion, generateEmbedding } from './gemini.js';
import { searchSimilarFiles } from './database.js';

// Documents below this cosine score are considered unrelated to the query.
// 0.2 was too permissive: almost anything scored above it, so the bot answered
// even when nothing in Drive matched. Configurable to tune against real
// queries from the knowledge base.
const SCORE_THRESHOLD = Number(process.env.RAG_SCORE_THRESHOLD) || 0.45;
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
      // Voice notes must be transcribed, not described. The old prompt asked
      // what was "visible", which an audio file cannot answer, so searches
      // built from voice messages used to miss the terms the user actually said.
      const isVoiceNote = mediaParts.every((p) =>
        p.inlineData?.mimeType?.startsWith('audio/') || p.fileData?.mimeType?.startsWith('audio/')
      );

      const instruction = isVoiceNote
        ? 'Transcribe el audio. Devuelve la consulta o lo que dijo la persona tal cual lo dijo, en español, sin parafrasear ni añadir comentarios. Si también describes otros audios adjuntos, sepáralos claramente.'
        : 'Describe en detalle el contenido de este archivo. Genera palabras clave específicas.';

      const description = await answerQuestion(
        instruction,
        [],
        mediaParts,
        { describeOnly: true }
      );
      if (description && description.trim()) {
        // For video the description includes any narration in the clip, so codes
        // like "E03" or a model number spoken out loud reach the search terms.
        queries.push({ origin: isVoiceNote ? 'nota de voz' : 'archivo adjunto', text: description.trim() });
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