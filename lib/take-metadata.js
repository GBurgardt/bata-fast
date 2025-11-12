import fs from "fs";
import path from "path";

const METADATA_FILE = "bata.meta.json";
const DEFAULT_DATA = {
  notes: [],
  lastPlayedAt: null,
};

const getMetadataPath = (folderPath) =>
  path.join(folderPath, METADATA_FILE);

const normalizeNotes = (notes) =>
  Array.isArray(notes)
    ? notes
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];

const normalizeMetadata = (raw = {}) => ({
  notes: normalizeNotes(raw.notes),
  lastPlayedAt: raw.lastPlayedAt ?? null,
});

export const readTakeMetadata = (folderPath) => {
  const filePath = getMetadataPath(folderPath);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_DATA };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return normalizeMetadata(raw);
  } catch {
    return { ...DEFAULT_DATA };
  }
};

const writeTakeMetadata = (folderPath, data) => {
  const filePath = getMetadataPath(folderPath);
  const payload = {
    notes: normalizeNotes(data.notes),
    lastPlayedAt: data.lastPlayedAt ?? null,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
};

const updateTakeMetadata = (folderPath, updater) => {
  const current = readTakeMetadata(folderPath);
  const next = normalizeMetadata({
    ...current,
    ...(updater ? updater(current) : {}),
  });
  writeTakeMetadata(folderPath, next);
  return next;
};

export const appendTakeNotes = async (folderPath, notes = []) => {
  const normalized = normalizeNotes(notes);
  if (!normalized.length) return readTakeMetadata(folderPath);
  return updateTakeMetadata(folderPath, (current) => ({
    notes: Array.from(new Set([...current.notes, ...normalized])),
  }));
};

export const recordTakePlayback = async (folderPath) =>
  updateTakeMetadata(folderPath, () => ({
    lastPlayedAt: new Date().toISOString(),
  }));
