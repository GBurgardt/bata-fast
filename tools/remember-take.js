import enquirer from "enquirer";

import { voice, formatRelativeTime } from "../lib/ui.js";
import { loadTakes } from "../lib/takes.js";
import { appendTakeNotes } from "../lib/take-metadata.js";

const { Select, Input } = enquirer;

export const rememberTake = async () => {
  const takes = await loadTakes();
  if (!takes.length) {
    voice.say("no processed takes yet. find one first.");
    return;
  }

  const sorted = [...takes].sort((a, b) => {
    const aPlayed = a.lastPlayedAt
      ? a.lastPlayedAt.getTime()
      : 0;
    const bPlayed = b.lastPlayedAt
      ? b.lastPlayedAt.getTime()
      : 0;
    if (aPlayed === bPlayed) {
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    }
    return bPlayed - aPlayed;
  });

  const take = await promptTakeSelection(sorted);
  if (!take) {
    voice.hint("ok, nothing saved.");
    return;
  }

  const notes = await promptNotes();
  if (!notes.length) {
    voice.hint("skipped, no matches captured.");
    return;
  }

  await appendTakeNotes(take.folderPath, notes);
  voice.success("saved it. you'll see it inside your catalog.");
};

const promptTakeSelection = async (takes) => {
  const selectPrompt = new Select({
    message: "which drum are you remembering?",
    choices: [
      ...takes.map((take) => ({
        name: formatRememberChoice(take),
        value: take.id,
        take,
      })),
      { name: "← back", value: "__back" },
    ],
    result(value) {
      if (value === "__back") return null;
      const choice = this.find(value);
      return choice?.take ?? takes.find((t) => t.id === value) ?? null;
    },
  });

  return selectPrompt.run();
};

const formatRememberChoice = (take) => {
  const lastPlayedLabel = take.lastPlayedAt
    ? `last jam ${formatRelativeTime(take.lastPlayedAt)}`
    : `added ${formatRelativeTime(take.updatedAt)}`;
  return `🥁 ${take.title}\n   ↳ ${lastPlayedLabel}`;
};

const promptNotes = async () => {
  const inputPrompt = new Input({
    message: "what did this groove unlock? (comma separates many)",
  });
  const value = await inputPrompt.run();
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};
