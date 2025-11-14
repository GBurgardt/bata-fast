import fs from "fs";
import path from "path";
import { PROCESSED_DIR } from "./paths.js";
import { collectDrumStems } from "./catalog.js";
import { getAudioDuration } from "./audio.js";
import { tidyTitle } from "./ui.js";
import { readTakeMetadata } from "./take-metadata.js";

export const loadTakes = async () => {
  if (!fs.existsSync(PROCESSED_DIR)) {
    return [];
  }

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
      const metadata = readTakeMetadata(folderPath);

      return {
        id: dirent.name,
        title: tidyTitle(dirent.name.replace(/_/g, " ")),
        folderPath,
        updatedAt: stats.mtime,
        drumFiles,
        combinedPath: hasCombined ? combinedPath : null,
        primaryFile,
        durationSeconds,
        notes: metadata.notes,
        lastPlayedAt: metadata.lastPlayedAt
          ? new Date(metadata.lastPlayedAt)
          : null,
        lastNotedAt: metadata.lastNotedAt
          ? new Date(metadata.lastNotedAt)
          : null,
      };
    })
  );

  return takes
    .filter((take) => take.primaryFile || take.drumFiles.length)
    .sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
    );
};
