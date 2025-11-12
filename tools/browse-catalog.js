import enquirer from "enquirer";

import {
  formatRelativeTime,
  formatTime,
  voice,
} from "../lib/ui.js";
import { loadTakes } from "../lib/takes.js";
import { playAudioFile } from "../lib/audio.js";
import { recordTakePlayback } from "../lib/take-metadata.js";

const { Select } = enquirer;

export const browseCatalog = async () => {
  const takes = await loadTakes();
  if (!takes.length) {
    voice.say("no processed takes yet. find one first.");
    return;
  }

  let keepBrowsing = true;
  while (keepBrowsing) {
    const selected = await promptTakeSelection(takes);
    if (!selected) {
      keepBrowsing = false;
      continue;
    }
    await playSelectedTake(selected);
  }
};

const promptTakeSelection = async (takes) => {
  const selectPrompt = new Select({
    message: `choose a take to play (${takes.length})`,
    choices: [
      ...takes.map((take) => ({
        name: formatTakeChoice(take),
        value: take.id,
        take,
      })),
      {
        name: "← back",
        value: "__back",
      },
    ],
    result(value) {
      if (value === "__back") return null;
      const choice = this.find(value);
      return choice?.take ?? takes.find((t) => t.id === value);
    },
  });

  return selectPrompt.run();
};

const formatTakeChoice = (take) => {
  const durationLabel = take.durationSeconds
    ? formatTime(take.durationSeconds)
    : "??:??";
  const age = formatRelativeTime(take.updatedAt);
  const summary = `${take.title} · ${durationLabel} · ${age}`;
  let details = "";
  if (take.notes?.length) {
    details = `matches: ${take.notes.join(" · ")}`;
  } else if (take.lastPlayedAt) {
    details = `last played ${formatRelativeTime(take.lastPlayedAt)}`;
  }
  return details ? `${summary}\n   ${details}` : summary;
};

const playSelectedTake = async (take) => {
  if (!take.primaryFile) {
    voice.warn("no drum take ready for that selection.");
    return;
  }
  await playAudioFile(take.primaryFile);
  try {
    await recordTakePlayback(take.folderPath);
  } catch {
    // ignore metadata errors to keep playback flowing
  }
};
