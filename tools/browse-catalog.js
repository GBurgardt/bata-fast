import fs from "fs";
import path from "path";
import enquirer from "enquirer";

import { PROCESSED_DIR, ROOT_DIR } from "../lib/paths.js";
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
    keepBrowsing = await handleTake(selected);
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
    message: `browse your catalog (${takes.length} takes)`,
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

const handleTake = async (take) => {
  const actionPrompt = new Select({
    message: `what now? (${take.title})`,
    choices: [
      {
        name: take.combinedPath ? "play blended take" : "play drums",
        value: "play-primary",
        disabled: !take.primaryFile,
      },
      {
        name: "choose a stem",
        value: "choose-stem",
        disabled: take.drumFiles.length === 0,
      },
      {
        name: "show location",
        value: "location",
      },
      {
        name: "back",
        value: "back",
      },
      {
        name: "exit catalog",
        value: "exit",
      },
    ],
  });

  const action = await actionPrompt.run();

  switch (action) {
    case "play-primary":
      if (take.primaryFile) {
        await playAudioFile(take.primaryFile);
      }
      return true;
    case "choose-stem":
      await promptStemSelection(take);
      return true;
    case "location":
      showLocations(take);
      return true;
    case "back":
      return true;
    case "exit":
    default:
      return false;
  }
};

const promptStemSelection = async (take) => {
  const stems = [
    ...(take.combinedPath
      ? [
          {
            label: "blended take",
            file: take.combinedPath,
          },
        ]
      : []),
    ...take.drumFiles.map((file) => ({
      label: path.basename(file),
      file,
    })),
  ];

  if (!stems.length) {
    voice.warn("no stems available for this take.");
    return;
  }

  const selectPrompt = new Select({
    message: "choose a stem",
    choices: [
      ...stems.map((stem) => ({
        name: stem.label,
        value: stem.file,
      })),
      { name: "← back", value: "__back" },
    ],
  });

  const selection = await selectPrompt.run();
  if (selection === "__back") {
    return;
  }

  await playAudioFile(selection);
};

const showLocations = (take) => {
  const folder = path.relative(ROOT_DIR, take.folderPath);
  voice.say(`folder: ${folder}`);
  if (take.combinedPath) {
    voice.hint(
      `blended take: ${path.relative(ROOT_DIR, take.combinedPath)}`
    );
  }
  if (take.drumFiles.length) {
    voice.hint(
      `stems: ${take.drumFiles
        .map((file) => path.relative(ROOT_DIR, file))
        .join(", ")}`
    );
  }
};
