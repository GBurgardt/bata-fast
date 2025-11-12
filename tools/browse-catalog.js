import fs from "fs";
import path from "path";
import enquirer from "enquirer";

import { PROCESSED_DIR } from "../lib/paths.js";
import {
  formatRelativeTime,
  formatTime,
  tidyTitle,
  voice,
} from "../lib/ui.js";
import { collectDrumStems } from "../lib/catalog.js";
import { getAudioDuration, playAudioFile } from "../lib/audio.js";

const { Select } = enquirer;

export const browseCatalog = async () => {
  if (!fs.existsSync(PROCESSED_DIR)) {
    voice.say("no processed takes yet. find one first.");
    return;
  }

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

const loadTakes = async () => {
  const entries = fs
    .readdirSync(PROCESSED_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory());

  const takes = await Promise.all(
    entries.map(async (dirent) => {
      const folderPath = path.join(PROCESSED_DIR, dirent.name);
      const stats = fs.statSync(folderPath);
      const drumFiles = collectDrumStems(folderPath);
      const combinedPath = path.join(folderPath, "combined_drums.wav");
      const hasCombined = fs.existsSync(combinedPath);
      const primaryFile = hasCombined
        ? combinedPath
        : drumFiles[0] ?? null;
      const durationSeconds = primaryFile
        ? await getAudioDuration(primaryFile)
        : null;
      return {
        id: dirent.name,
        title: tidyTitle(dirent.name.replace(/_/g, " ")),
        folderPath,
        updatedAt: stats.mtime,
        drumFiles,
        combinedPath: hasCombined ? combinedPath : null,
        primaryFile,
        durationSeconds,
      };
    })
  );

  return takes
    .filter((take) => take.primaryFile || take.drumFiles.length)
    .sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    );
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
  const stemsLabel =
    take.drumFiles.length === 1
      ? "1 stem"
      : `${take.drumFiles.length} stems`;
  return `🥁 ${take.title} · ${durationLabel} · ${stemsLabel} · ${age}`;
};

const playSelectedTake = async (take) => {
  if (!take.primaryFile) {
    voice.warn("no drum take ready for that selection.");
    return;
  }
  await playAudioFile(take.primaryFile);
};
