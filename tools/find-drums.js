import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { google } from "googleapis";
import enquirer from "enquirer";
import Moises from "moises/sdk.js";

import {
  DOWNLOADS_DIR,
  PROCESSED_DIR,
  ROOT_DIR,
  ensureDirectory,
} from "../lib/paths.js";
import {
  createCalmProgress,
  createStatus,
  tidyTitle,
  voice,
  formatTime,
  wrapLine,
} from "../lib/ui.js";
import { combineDrumStems, playAudioFile } from "../lib/audio.js";
import { collectDrumStems } from "../lib/catalog.js";
import { logStage, logDebug, trimForLog } from "../lib/debug.js";

const { Input, Select, Confirm } = enquirer;

const MOISES_WORKFLOW_DRUMS = "isolate_drums_bata";

let youtubeClient = null;
let moisesClient = null;

const ensureClients = () => {
  if (!process.env.YOUTUBE_API_KEY) {
    voice.error("missing YOUTUBE_API_KEY in your .env file.");
    throw new Error("YOUTUBE_API_KEY missing");
  }
  if (!process.env.MOISES_API_KEY) {
    voice.error("missing MOISES_API_KEY in your .env file.");
    throw new Error("MOISES_API_KEY missing");
  }

  if (!youtubeClient) {
    youtubeClient = google.youtube({
      version: "v3",
      auth: process.env.YOUTUBE_API_KEY,
    });
  }

  if (!moisesClient) {
    moisesClient = new Moises({ apiKey: process.env.MOISES_API_KEY });
  }
};

const isoDurationToSeconds = (duration) => {
  if (!duration) return null;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
};

const formatVideoChoice = (video, index) => {
  const durationLabel =
    typeof video.durationSeconds === "number"
      ? formatTime(video.durationSeconds)
      : "??:??";
  return `${index + 1} • ${tidyTitle(video.title)} · ${durationLabel}`;
};

const promptSearchTerm = async () => {
  voice.say("bata · drum finder");
  voice.hint("type an artist, song, or mood");
  const inputPrompt = new Input({
    message: "what do you feel like hearing?",
    validate: (value) =>
      value.trim().length > 0 || "say something so i can search.",
  });
  const value = await inputPrompt.run();
  return value.trim();
};

const promptVideoSelection = async (videos) => {
  const selectPrompt = new Select({
    message: "pick the take that feels right",
    choices: videos.map((video, index) => ({
      name: formatVideoChoice(video, index),
      value: video.videoId,
      video,
    })),
    result(value) {
      const choice = this.find(value);
      return choice?.video ?? videos.find((v) => v.videoId === value);
    },
  });
  return selectPrompt.run();
};

const promptConfirm = async (message, initial = true) => {
  const confirmPrompt = new Confirm({
    message,
    initial,
  });
  return confirmPrompt.run();
};

const searchVideos = async (query, maxResults = 5) => {
  ensureClients();
  logStage("YOUTUBE", `searching "${query}" (max ${maxResults})`);
  try {
    const response = await youtubeClient.search.list({
      part: ["snippet"],
      q: query,
      type: "video",
      maxResults,
    });

    const items =
      response.data.items?.map((item) => ({
        videoId: item.id?.videoId,
        title: item.snippet?.title,
      })) || [];

    const validItems = items.filter((item) => item.videoId && item.title);
    if (validItems.length === 0) {
      return [];
    }

    const ids = validItems.map((item) => item.videoId).join(",");
    const durationsMap = new Map();
    if (ids.length > 0) {
      const durationResponse = await youtubeClient.videos.list({
        part: ["contentDetails"],
        id: ids,
      });
      durationResponse.data.items?.forEach((video) => {
        const seconds = isoDurationToSeconds(
          video.contentDetails?.duration || ""
        );
        durationsMap.set(video.id, seconds);
      });
    }

    return validItems.map((item) => ({
      ...item,
      durationSeconds: durationsMap.get(item.videoId) ?? null,
    }));
  } catch (error) {
    logStage(
      "YOUTUBE-ERROR",
      "details",
      trimForLog(
        error.response?.data?.error?.message || error.message || "unknown"
      )
    );
    throw new Error(
      error.response?.data?.error?.message ||
        error.message ||
        "youtube search failed"
    );
  }
};

const downloadVideoAudio = (videoId, title, callbacks = {}) => {
  const { onMessage, onProgress } = callbacks;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const safeTitle = tidyTitle(title)
    .replace(/[\u0000-\u001F\\/?*:|"<>]/g, "_")
    .substring(0, 100);
  const outputPath = path.join(DOWNLOADS_DIR, `${safeTitle}.mp3`);

  logStage("DOWNLOAD", `starting "${title}" (${videoId})`);
  logStage("DOWNLOAD", "videoUrl", videoUrl);
  logStage("DOWNLOAD", "output", outputPath);

  const command = `yt-dlp -x --audio-format mp3 --output "${outputPath}" --no-check-certificates --no-warnings --force-ipv4 "${videoUrl}"`;
  logDebug(`Running yt-dlp: ${command}`);

  const stdoutChunks = [];
  const stderrChunks = [];

  return new Promise((resolve, reject) => {
    const downloadProcess = exec(command);
    onMessage?.("pulling audio…");

    downloadProcess.stdout?.on("data", (data) => {
      const chunk = data.toString();
      stdoutChunks.push(chunk);
      const percentMatch = chunk.match(/(\d+(?:\.\d+)?)%/);
      if (percentMatch) {
        onProgress?.(parseFloat(percentMatch[1]));
      }
      logDebug(chunk);
    });

    downloadProcess.stderr?.on("data", (data) => {
      const stderrText = data.toString();
      stderrChunks.push(stderrText);
      logStage("DOWNLOAD-STDERR", "line", trimForLog(stderrText));
    });

    downloadProcess.on("close", (code) => {
      logStage("DOWNLOAD", `yt-dlp exited with ${code}`);
      logStage(
        "DOWNLOAD-TRACE",
        "stdout",
        trimForLog(stdoutChunks.join("").trim())
      );
      logStage(
        "DOWNLOAD-TRACE",
        "stderr",
        trimForLog(stderrChunks.join("").trim())
      );
      if (code === 0) {
        logStage("DOWNLOAD", "file", outputPath);
        resolve(outputPath);
      } else {
        reject(
          new Error(
            `yt-dlp exited with code ${code}. run with --debug for details.`
          )
        );
      }
    });

    downloadProcess.on("error", (err) => {
      logStage("DOWNLOAD", "spawn error", err.message);
      reject(
        new Error("couldn't start yt-dlp. is it installed and on your path?")
      );
    });
  });
};

const processAudioWithMoises = async (filePath, jobName, callbacks = {}) => {
  ensureClients();
  const { onPhase } = callbacks;
  const safeJobName = jobName
    .replace(/[\u0000-\u001F\\/?*:|"<>]/g, "_")
    .substring(0, 120);

  try {
    onPhase?.("sending to the studio…");
    logStage("MOISES", "uploading file", filePath);
    const downloadUrl = await moisesClient.uploadFile(filePath);
    logDebug(`Temporary URL: ${downloadUrl}`);

    onPhase?.("setting up the session…");
    logStage("MOISES", "creating job", safeJobName);
    const jobId = await moisesClient.addJob(
      safeJobName,
      MOISES_WORKFLOW_DRUMS,
      {
        inputUrl: downloadUrl,
      }
    );
    logStage("MOISES", "job", jobId);

    onPhase?.("ai is isolating drums…");
    const job = await moisesClient.waitForJobCompletion(jobId);
    logStage("MOISES", "job status", job.status);

    if (job.status !== "SUCCEEDED") {
      throw new Error(
        `moises job ended with status ${job.status.toLowerCase()}`
      );
    }

    onPhase?.("downloading stems…");
    const jobOutputDir = path.join(PROCESSED_DIR, safeJobName);
    ensureDirectory(jobOutputDir);
    await moisesClient.downloadJobResults(job, jobOutputDir);
    logStage("MOISES", "results saved", jobOutputDir);

    const drumWavFiles = collectDrumStems(jobOutputDir);
    logStage("MOISES", "drum stems", drumWavFiles);

    return { jobId, jobOutputDir, drumWavFiles };
  } catch (error) {
    logStage("MOISES-ERROR", "detail", trimForLog(error?.message || error));
    throw new Error(
      error?.message || "moises could not finish processing that take."
    );
  }
};

export const findDrumsFlow = async () => {
  ensureDirectory(DOWNLOADS_DIR);

  const query = await promptSearchTerm();
  const searchSpinner = createStatus("looking for it…");
  let videos = [];
  try {
    videos = await searchVideos(query);
    logStage("MAIN", "results", videos.length);
    if (videos.length === 0) {
      searchSpinner.error({
        text: wrapLine("couldn't find anything. try another idea."),
      });
      return;
    }
    searchSpinner.success({
      text: wrapLine(`found ${videos.length} takes.`),
    });
  } catch (error) {
    searchSpinner.error({
      text: wrapLine("youtube isn't answering right now."),
    });
    voice.error(error.message);
    return;
  }

  const selectedVideo = await promptVideoSelection(videos);
  if (!selectedVideo) {
    voice.error("couldn't find that take anymore.");
    return;
  }
  logStage(
    "MAIN",
    "selected video",
    trimForLog(`${selectedVideo.title} (${selectedVideo.videoId})`)
  );

  voice.say(`pulling “${tidyTitle(selectedVideo.title)}”…`);

  const downloadProgress = createCalmProgress();
  let downloadedFile;
  try {
    downloadedFile = await downloadVideoAudio(
      selectedVideo.videoId,
      selectedVideo.title,
      {
        onMessage: (text) => downloadProgress.set(text),
        onProgress: (percent) =>
          downloadProgress.set(`pulling audio… ${percent.toFixed(1)}%`),
      }
    );
    downloadProgress.clear();
    voice.success("audio is ready.");
  } catch (error) {
    downloadProgress.clear();
    voice.error(error.message);
    return;
  }
  logStage("MAIN", "downloaded path", downloadedFile);

  const studioSpinner = createStatus("sending to the studio…");
  let studioResult;
  try {
    studioResult = await processAudioWithMoises(
      downloadedFile,
      selectedVideo.title,
      {
        onPhase: (text) =>
          studioSpinner.update({
            text: wrapLine(text),
          }),
      }
    );
    studioSpinner.success({
      text: wrapLine("stems are ready."),
    });
  } catch (error) {
    studioSpinner.error({
      text: wrapLine("the studio couldn't finish that take."),
    });
    voice.error(error.message);
    return;
  }

  const { drumWavFiles, jobOutputDir } = studioResult;
  if (!drumWavFiles.length) {
    voice.warn("couldn't isolate clean drums from that take.");
    return;
  }

  const takeLabel = drumWavFiles.length === 1 ? "take" : "takes";
  voice.say(`${drumWavFiles.length} drum ${takeLabel} ready.`);

  let playbackPath = drumWavFiles[0];

  if (drumWavFiles.length > 1) {
    const shouldBlend = await promptConfirm("blend them into one take?", true);
    if (shouldBlend) {
      const blendSpinner = createStatus("blending the drums…");
      try {
        playbackPath = await combineDrumStems(drumWavFiles, jobOutputDir);
        blendSpinner.success({
          text: wrapLine("one clean drum take ready."),
        });
      } catch (error) {
        blendSpinner.error({
          text: wrapLine("couldn't blend them."),
        });
        voice.warn(error.message);
      }
    }
  }

  voice.hint("playing it now… ctrl+c to stop anytime.");
  await playAudioFile(playbackPath);

  const displayPath = path.relative(ROOT_DIR, playbackPath);
  voice.success(`ready. saved to ${displayPath}.`);
  voice.hint("stems live inside downloads/processed_stems if you need them later.");
};
