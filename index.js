#!/usr/bin/env node

import "dotenv/config";
import enquirer from "enquirer";
import chalk from "chalk";

import { voice } from "./lib/ui.js";
import { debugMode, logStage } from "./lib/debug.js";
import { findDrumsFlow } from "./tools/find-drums.js";
import { browseCatalog } from "./tools/browse-catalog.js";
import { rememberTake } from "./tools/remember-take.js";

const { Select } = enquirer;

const mainMenuPrompt = () =>
  new Select({
    message: "what do you want to do?",
    choices: [
      { name: "find", message: "find new drums" },
      { name: "catalog", message: "browse my catalog" },
      { name: "remember", message: "remember this take" },
      { name: "exit", message: "exit" },
    ],
  });

const runMenu = async () => {
  let keepRunning = true;
  while (keepRunning) {
    const selection = await mainMenuPrompt().run();
    switch (selection) {
      case "find":
        await findDrumsFlow();
        break;
      case "catalog":
        await browseCatalog();
        break;
      case "remember":
        await rememberTake();
        break;
      case "exit":
      default:
        keepRunning = false;
        break;
    }
  }

  voice.hint("see you soon.");
};

const bootstrap = async () => {
  if (debugMode) {
    console.log(chalk.yellowBright("[MODO DEBUG ACTIVADO]"));
  }
  logStage("MAIN", "boot", { debugMode });
  if (process.argv.includes("--remember")) {
    await rememberTake();
    return;
  }
  await runMenu();
};

bootstrap().catch((err) => {
  if (debugMode) {
    console.error(err);
  } else {
    voice.error(err.message || "something went wrong.");
    voice.hint("run again with --debug for the full trace.");
  }
  process.exit(1);
});
