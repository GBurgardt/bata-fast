import enquirer from "enquirer";

import {
  formatRelativeTime,
  formatTime,
  voice,
} from "../lib/ui.js";
import { loadTakes } from "../lib/takes.js";
import { playAudioFile } from "../lib/audio.js";
import {
  appendTakeNotes,
  recordTakePlayback,
} from "../lib/take-metadata.js";
import { parseMatchInput } from "../lib/note-utils.js";
import { logStage, logDebug } from "../lib/debug.js";

const { Select, Input } = enquirer;

export const browseCatalog = async (options = {}) => {
  logStage("CATALOG", "open", options.matchesOnly ? "matches-only" : "full");
  let takes = await loadViewTakes(options);
  if (!takes.length) {
    voice.say(
      options.matchesOnly
        ? "no matches logged yet. add one after your next jam."
        : "no processed takes yet. find one first."
    );
    return;
  }

  let keepBrowsing = true;
  while (keepBrowsing) {
    const selected = await promptTakeSelection(
      takes,
      options.matchesOnly
        ? `choose a matched take (${takes.length})`
        : `choose a take (${takes.length})`
    );
    if (!selected) {
      keepBrowsing = false;
      continue;
    }
    logStage(
      "CATALOG",
      "take-selected",
      `${selected.title} (${selected.id})`
    );

    const action = await promptTakeAction(selected);
    logStage("CATALOG", "action", action);
    switch (action) {
      case "play":
        await playSelectedTake(selected);
        break;
      case "note":
        await addMatchNote(selected);
        break;
      case "back":
      default:
        break;
    }

    takes = await loadViewTakes(options);
    logStage("CATALOG", "list-refreshed", takes.length);
    if (!takes.length) {
      voice.say(
        options.matchesOnly
          ? "no matches logged yet. add one after your next jam."
          : "no processed takes yet. find one first."
      );
      keepBrowsing = false;
    }
  }
};

const loadViewTakes = async (options) => {
  let takes = await loadTakes();
  logStage("CATALOG", "load-takes", takes.length);
  if (options.matchesOnly) {
    takes = takes
      .filter((take) => take.notes?.length)
      .sort((a, b) => {
        const aTime = a.lastNotedAt
          ? a.lastNotedAt.getTime()
          : 0;
        const bTime = b.lastNotedAt
          ? b.lastNotedAt.getTime()
          : 0;
        if (aTime === bTime) {
          return b.updatedAt.getTime() - a.updatedAt.getTime();
        }
        return bTime - aTime;
      });
    logStage("CATALOG", "filtered-matches", takes.length);
  }
  return takes;
};

const promptTakeSelection = async (takes, message) => {
  const selectPrompt = new Select({
    message,
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
      logStage("CATALOG", "take-selection-value", value);
      if (value === "__back") return null;
      const choice = this.find(value);
      const resolved =
        choice?.take ?? takes.find((candidate) => candidate.id === value);
      logStage(
        "CATALOG",
        "take-selection-result",
        resolved ? `${resolved.title} (${resolved.id})` : "not-found"
      );
      return resolved ?? null;
    },
  });

  return selectPrompt.run();
};

const promptTakeAction = async (take) => {
  const actionPrompt = new Select({
    message: `what now? (${take.title})`,
    choices: [
      {
        name: "play",
        message: "play it",
        disabled: !take.primaryFile,
      },
      {
        name: "note",
        message: "add a match note",
      },
      {
        name: "back",
        message: "back",
      },
    ],
  });
  const answer = await actionPrompt.run();
  logStage("CATALOG", "action-choice", answer);
  return answer;
};

const formatTakeChoice = (take) => {
  const durationLabel = take.durationSeconds
    ? formatTime(take.durationSeconds)
    : "??:??";
  const age = formatRelativeTime(take.updatedAt);
  let line = `${take.title} · ${durationLabel} · ${age}`;
  if (take.notes?.length) {
    const notedSuffix = take.lastNotedAt
      ? ` · noted ${formatRelativeTime(take.lastNotedAt)}`
      : "";
    line += `\n   matches: ${take.notes.join(" · ")}${notedSuffix}`;
  } else if (take.lastPlayedAt) {
    line += `\n   last played ${formatRelativeTime(take.lastPlayedAt)}`;
  }
  return line;
};

const playSelectedTake = async (take) => {
  if (!take.primaryFile) {
    voice.warn("no drum take ready for that selection.");
    return;
  }
  logStage("CATALOG", "play-start", take.primaryFile);
  await playAudioFile(take.primaryFile);
  try {
    await recordTakePlayback(take.folderPath);
  } catch {
    // ignore metadata errors to keep playback flowing
  } finally {
    logStage("CATALOG", "play-finish", take.primaryFile);
  }
};

const addMatchNote = async (take) => {
  const matches = await promptMatchNotes();
  if (!matches.length) {
    voice.hint("skipped, nothing saved.");
    return;
  }
  logStage("CATALOG", "add-note", { take: take.id, matches });
  await appendTakeNotes(take.folderPath, matches);
  voice.success("saved it inside the catalog.");
};

const promptMatchNotes = async () => {
  const inputPrompt = new Input({
    message: "what does it match? (comma or / separates many)",
  });
  const value = await inputPrompt.run();
  const parsed = parseMatchInput(value);
  logDebug("match-input", value, parsed);
  return parsed;
};
