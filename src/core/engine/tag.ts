import { search } from "fast-fuzzy";
import type { EventEnvelope } from "../schema/event.ts";
import { TAG_VOCAB, type Tag } from "./tag-vocab.ts";

const FUZZY_THRESHOLD = 0.82;
const MIN_TOKEN_LENGTH = 3;

function eventId(event: EventEnvelope): string {
  return `${event.kind}:${event.repo}:${event.ts}`;
}

function extractText(event: EventEnvelope): string {
  const parts: string[] = [event.repo];
  const p = event.payload;
  for (const field of ["message", "title", "body", "description", "name"]) {
    if (typeof p[field] === "string") parts.push(p[field] as string);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Assign capability tags to each event using fuzzy token matching against TAG_VOCAB.
 * Returns a map from event identity string to matched tags.
 */
export function tagEvents(events: EventEnvelope[]): Map<string, Tag[]> {
  const vocabList = [...TAG_VOCAB];
  const result = new Map<string, Tag[]>();

  for (const event of events) {
    const text = extractText(event);
    const tokens = text.split(/[\s\-_/.,;:()[\]{}]+/).filter((t) => t.length >= MIN_TOKEN_LENGTH);
    const matched = new Set<Tag>();

    for (const token of tokens) {
      const hits = search(token, vocabList, { threshold: FUZZY_THRESHOLD });
      for (const hit of hits) matched.add(hit as Tag);
    }

    result.set(eventId(event), [...matched]);
  }

  return result;
}
