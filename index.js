#!/usr/bin/env node

import { google } from "googleapis";
import inquirer from "inquirer";
import dotenv from "dotenv";
import { exec } from "child_process"; // Usaremos exec para llamar a yt-dlp directamente para mejor control
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk"; // Para mejorar la salida en consola
import Moises from "moises/sdk.js"; // <--- Importar SDK de Moises
import player from "play-sound"; // <--- Importar para reproducir audio

// Configuración inicial
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOWNLOADS_DIR = path.join(__dirname, "downloads");
const PROCESSED_DIR = path.join(DOWNLOADS_DIR, "processed_stems"); // Carpeta para resultados de Moises
const audioPlayer = player({}); // Inicializar play-sound una vez

// Asegurarse de que los directorios existan
if (!fs.existsSync(DOWNLOADS_DIR)) {
  console.log(
    chalk.yellow(`Creando directorio de descargas en: ${DOWNLOADS_DIR}`)
  );
  fs.mkdirSync(DOWNLOADS_DIR);
}
// No creamos PROCESSED_DIR aquí, moises.downloadJobResults lo hará si es necesario

// Validar API Keys
if (!process.env.YOUTUBE_API_KEY) {
  console.error(
    chalk.red(
      "Error: La variable de entorno YOUTUBE_API_KEY no está configurada."
    )
  );
  console.log(
    chalk.yellow(
      "Asegúrate de tener un archivo .env con YOUTUBE_API_KEY=TU_CLAVE_YOUTUBE"
    )
  );
  process.exit(1);
}
// ---> Validar API Key de Moises
if (!process.env.MOISES_API_KEY) {
  console.error(
    chalk.red(
      "Error: La variable de entorno MOISES_API_KEY no está configurada."
    )
  );
  console.log(
    chalk.yellow(
      "Asegúrate de tener un archivo .env con MOISES_API_KEY=TU_CLAVE_MOISES"
    )
  );
  process.exit(1);
}

// Inicializar clientes
const youtube = google.youtube({
  version: "v3",
  auth: process.env.YOUTUBE_API_KEY,
});
// ---> Inicializar cliente Moises
const moises = new Moises({ apiKey: process.env.MOISES_API_KEY });
const MOISES_WORKFLOW_DRUMS = "isolate_drums_bata"; // Workflow para extraer batería

// --- Funciones ---

/**
 * Busca videos en YouTube usando la API.
 * @param {string} query Término de búsqueda.
 * @param {number} maxResults Número máximo de resultados.
 * @returns {Promise<Array<{videoId: string, title: string}>>} Lista de videos encontrados.
 */
async function searchVideos(query, maxResults = 5) {
  console.log(chalk.blue(`\nBuscando videos para: "${query}"...`));
  try {
    const response = await youtube.search.list({
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

    if (items.length === 0) {
      console.log(chalk.yellow("No se encontraron videos para esa búsqueda."));
      return [];
    }

    // Filtrar resultados inválidos (sin videoId o title)
    return items.filter((item) => item.videoId && item.title);
  } catch (error) {
    console.error(chalk.red("\nError buscando videos en YouTube:"));
    if (error.response?.data?.error?.message) {
      console.error(chalk.red(`  ${error.response.data.error.message}`));
      if (error.response.data.error.message.includes("quotaExceeded")) {
        console.warn(
          chalk.yellow(
            "  Parece que has excedido la cuota de la API de YouTube."
          )
        );
      }
    } else {
      console.error(chalk.red(`  ${error.message}`));
    }
    return []; // Devuelve vacío en caso de error para no detener el flujo principal
  }
}

/**
 * Descarga el audio de un video de YouTube usando yt-dlp.
 * @param {string} videoId ID del video de YouTube.
 * @param {string} title Título del video para el nombre de archivo.
 * @returns {Promise<string | null>} Ruta al archivo descargado o null si falla.
 */
async function downloadVideoAudio(videoId, title) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  // Nombre de archivo seguro: reemplazar caracteres inválidos
  const safeTitle = title
    .replace(/[\u0000-\u001F\\/?*:|"<>]/g, "_")
    .substring(0, 100); // Limitar longitud y caracteres inválidos
  const outputPath = path.join(DOWNLOADS_DIR, `${safeTitle}.mp3`);

  console.log(chalk.blue(`\nIniciando descarga de audio para: "${title}"`));
  console.log(chalk.dim(`URL: ${videoUrl}`));
  console.log(chalk.dim(`Guardando en: ${outputPath}`));

  // Comando yt-dlp simplificado para extraer audio en mp3
  // Asegúrate de que 'yt-dlp' esté en tu PATH o proporciona la ruta completa
  const command = `yt-dlp -x --audio-format mp3 --output "${outputPath}" --no-check-certificates --no-warnings --force-ipv4 "${videoUrl}"`;

  console.log(chalk.dim(`Ejecutando comando: ${command}\n`));

  return new Promise((resolve) => {
    // Cambiado para resolver con outputPath o null
    const downloadProcess = exec(command);

    // Mostrar salida estándar (progreso de yt-dlp)
    downloadProcess.stdout?.on("data", (data) => {
      process.stdout.write(chalk.gray(data)); // Mostrar progreso en gris
    });

    // Mostrar errores
    downloadProcess.stderr?.on("data", (data) => {
      // Ignorar mensajes comunes que no son errores fatales
      if (
        !data.includes("Deleting original file") &&
        !data.includes("[ExtractAudio]") &&
        !data.includes("[download] Destination:") // Ignorar mensaje de destino
      ) {
        process.stderr.write(chalk.red(data));
      } else {
        process.stdout.write(chalk.gray(data)); // Mostrar mensajes informativos de stderr en gris
      }
    });

    downloadProcess.on("close", (code) => {
      if (code === 0) {
        console.log(
          chalk.green(
            `\n¡Descarga completada con éxito! Archivo guardado en ${outputPath}`
          )
        );
        resolve(outputPath); // <--- Resuelve con la ruta del archivo
      } else {
        console.error(
          chalk.red(`\nError durante la descarga (código de salida: ${code}).`)
        );
        console.error(
          chalk.red(
            "Asegúrate de tener yt-dlp instalado y accesible en tu PATH."
          )
        );
        console.error(
          chalk.red(
            "Puedes instalarlo con: pip install yt-dlp  o  brew install yt-dlp"
          )
        );
        resolve(null); // <--- Resuelve con null si falla
      }
    });

    downloadProcess.on("error", (err) => {
      console.error(
        chalk.red("\nError al ejecutar el comando de descarga:"),
        err
      );
      console.error(
        chalk.red("Asegúrate de tener yt-dlp instalado y accesible en tu PATH.")
      );
      resolve(null); // <--- Resuelve con null si falla
    });
  });
}

// --- Funciones de Music AI (Moises) ---

/**
 * Procesa un archivo de audio con Moises para extraer la batería.
 * @param {string} filePath Ruta al archivo de audio local.
 * @param {string} jobName Nombre para identificar el job en Moises.
 * @returns {Promise<void>}
 */
async function processAudioWithMoises(filePath, jobName) {
  console.log(
    chalk.cyan("\n--- Iniciando procesamiento con Music AI (Moises) ---")
  );

  try {
    // 1. Subir archivo a Moises
    console.log(chalk.blue(`Subiendo archivo: ${path.basename(filePath)}...`));
    const downloadUrl = await moises.uploadFile(filePath);
    console.log(chalk.green("Archivo subido con éxito."));
    console.log(chalk.dim(`URL temporal: ${downloadUrl}`));

    // 2. Crear el Job
    console.log(chalk.blue(`Creando job en Moises para extraer batería...`));
    console.log(chalk.dim(`Workflow: ${MOISES_WORKFLOW_DRUMS}`));
    const jobId = await moises.addJob(jobName, MOISES_WORKFLOW_DRUMS, {
      inputUrl: downloadUrl,
    });
    console.log(chalk.green(`Job creado con ID: ${jobId}`));

    // 3. Esperar a que el Job se complete
    console.log(
      chalk.blue(
        "Esperando a que Moises procese el audio (esto puede tardar)..."
      )
    );
    // Podríamos implementar un polling manual con getJob para mostrar progreso,
    // pero waitForJobCompletion es más simple por ahora.
    const job = await moises.waitForJobCompletion(jobId);

    // 4. Revisar resultado y descargar
    if (job.status === "SUCCEEDED") {
      console.log(
        chalk.green("¡Procesamiento de Moises completado con éxito!")
      );
      console.log(chalk.blue("Descargando resultados..."));

      // Crear un directorio específico para los resultados de este job
      const jobOutputDir = path.join(
        PROCESSED_DIR,
        jobName.replace(/[\u0000-\u001F\\/?*:|"<>]/g, "_")
      ); // Nombre de carpeta seguro
      if (!fs.existsSync(jobOutputDir)) {
        fs.mkdirSync(jobOutputDir, { recursive: true });
      }

      const resultPaths = await moises.downloadJobResults(job, jobOutputDir);
      console.log(chalk.green(`Resultados descargados en: ${jobOutputDir}`));

      // *** DEBUGGING: Loguear el valor y tipo de resultPaths ***
      console.log(chalk.yellow("[DEBUG] Valor de resultPaths:"), resultPaths);
      console.log(
        chalk.yellow("[DEBUG] Tipo de resultPaths:"),
        typeof resultPaths
      );

      // *** CORRECCIÓN: Comprobar si es un array antes de usar .join() ***
      if (Array.isArray(resultPaths)) {
        console.log(chalk.dim(`Archivos: ${resultPaths.join(", ")}`));
      } else if (resultPaths) {
        // Si no es array pero tiene valor, mostrarlo directamente
        console.log(chalk.dim(`Archivo: ${resultPaths}`));
      } else {
        // Si es undefined, null, o similar
        console.log(
          chalk.yellow(
            "No se pudo determinar la lista de archivos descargados."
          )
        );
      }

      // Leer workflow.result.json para encontrar los stems de batería
      const resultJsonPath = path.join(jobOutputDir, "workflow.result.json");
      let drumWavFiles = [];
      if (fs.existsSync(resultJsonPath)) {
        try {
          const resultJson = JSON.parse(
            fs.readFileSync(resultJsonPath, "utf-8")
          );
          // Asumir que todos los valores terminados en .wav son stems de batería relevantes
          drumWavFiles = Object.values(resultJson)
            .filter(
              (val) =>
                typeof val === "string" && val.toLowerCase().endsWith(".wav")
            )
            .map((relativePath) =>
              path.join(jobOutputDir, path.basename(relativePath))
            ); // Usar basename para asegurar que sea el archivo correcto en jobOutputDir
          console.log(
            chalk.yellow("[DEBUG] Archivos WAV encontrados en JSON:"),
            drumWavFiles
          );
        } catch (jsonError) {
          console.warn(
            chalk.yellow(
              `No se pudo leer o parsear ${resultJsonPath}: ${jsonError.message}`
            )
          );
        }
      } else {
        console.warn(
          chalk.yellow(
            `No se encontró ${resultJsonPath}. No se puede determinar qué archivos combinar.`
          )
        );
        // Fallback: buscar todos los .wav en el directorio si el JSON no está o falla
        try {
          drumWavFiles = fs
            .readdirSync(jobOutputDir)
            .filter(
              (file) =>
                file.toLowerCase().endsWith(".wav") &&
                file !== "combined_drums.wav"
            ) // Excluir el combinado si ya existe
            .map((file) => path.join(jobOutputDir, file));
          if (drumWavFiles.length > 0) {
            console.log(
              chalk.yellow(
                "[DEBUG] Archivos WAV encontrados por escaneo de directorio:"
              ),
              drumWavFiles
            );
          } else {
            console.log(
              chalk.yellow("No se encontraron archivos .wav en el directorio.")
            );
          }
        } catch (readDirError) {
          console.warn(
            chalk.yellow(
              `Error leyendo el directorio ${jobOutputDir}: ${readDirError.message}`
            )
          );
        }
      }

      // Preguntar al usuario si quiere escuchar
      if (drumWavFiles.length > 1) {
        const { shouldPlay } = await inquirer.prompt([
          {
            type: "confirm",
            name: "shouldPlay",
            message: `Se encontraron ${drumWavFiles.length} stems de batería. ¿Quieres combinarlos y escucharlos ahora? (Necesitas ffmpeg instalado y un reproductor de audio compatible)`,
            default: false,
          },
        ]);
        if (shouldPlay) {
          await combineAndPlayAudio(drumWavFiles, jobOutputDir);
        }
      } else if (drumWavFiles.length === 1) {
        const { shouldPlaySingle } = await inquirer.prompt([
          {
            type: "confirm",
            name: "shouldPlaySingle",
            message: `Se encontró 1 stem de batería (${path.basename(
              drumWavFiles[0]
            )}). ¿Quieres escucharlo ahora? (Necesitas un reproductor de audio compatible)`,
            default: false,
          },
        ]);
        if (shouldPlaySingle) {
          await playAudioFile(drumWavFiles[0]);
        }
      } else {
        console.log(
          chalk.yellow(
            "No se encontraron archivos de batería (.wav) para reproducir."
          )
        );
      }

      // (Opcional) Limpiar el job del servidor de Moises
      try {
        await moises.deleteJob(jobId);
        console.log(
          chalk.dim(`Job ${jobId} eliminado del servidor de Moises.`)
        );
      } catch (deleteError) {
        console.warn(
          chalk.yellow(
            `No se pudo eliminar el job ${jobId} de Moises: ${deleteError.message}`
          )
        );
      }
    } else {
      console.error(
        chalk.red(`El procesamiento de Moises falló con estado: ${job.status}`)
      );
      // Podríamos intentar obtener más detalles del error si la API los proporciona
    }
  } catch (error) {
    console.error(chalk.red("\nError durante el procesamiento con Moises:"));
    // Mostrar el error original si existe y tiene message, sino el objeto completo
    if (error && error.message) {
      // Evitar mostrar el error "resultPaths.join is not a function" ya que lo manejamos ahora
      if (!error.message.includes("resultPaths.join is not a function")) {
        console.error(chalk.red(`  ${error.message}`));
      }
    } else if (error) {
      console.error(chalk.red("  Ocurrió un error inesperado:"), error);
    } else {
      console.error(chalk.red("  Ocurrió un error inesperado."));
    }
    console.error(
      chalk.yellow("  Verifica tu API Key de Moises y la conexión a internet.")
    );
    console.error(
      chalk.yellow(`  Workflow utilizado: ${MOISES_WORKFLOW_DRUMS}`)
    );
    // No relanzamos el error para que el script principal pueda continuar si es posible
  }
  console.log(chalk.cyan("--- Fin del procesamiento con Music AI ---"));
}

// --- Nueva Función ---
/**
 * Combina archivos WAV usando ffmpeg y los reproduce.
 * @param {string[]} wavFiles - Lista de rutas absolutas a los archivos WAV a combinar.
 * @param {string} outputDir - Directorio donde guardar el archivo combinado.
 */
async function combineAndPlayAudio(wavFiles, outputDir) {
  const combinedFileName = "combined_drums.wav";
  const combinedOutputPath = path.join(outputDir, combinedFileName);

  // Asegurarse de que los archivos existen antes de intentar combinarlos
  const existingWavFiles = wavFiles.filter((file) => fs.existsSync(file));
  if (existingWavFiles.length === 0) {
    console.error(
      chalk.red(
        "No se encontraron los archivos WAV especificados para combinar."
      )
    );
    return;
  }
  if (existingWavFiles.length < wavFiles.length) {
    console.warn(
      chalk.yellow(
        "Advertencia: Algunos archivos WAV no se encontraron y no serán incluidos en la mezcla."
      )
    );
  }
  if (existingWavFiles.length < 2) {
    console.warn(
      chalk.yellow(
        "Se necesita al menos 2 archivos WAV para combinar. Reproduciendo el único archivo encontrado..."
      )
    );
    await playAudioFile(existingWavFiles[0]);
    return;
  }

  const inputArgs = existingWavFiles.map((file) => `-i "${file}"`).join(" ");
  const filterComplex = `amix=inputs=${existingWavFiles.length}:duration=longest`;
  // Usamos -y para sobrescribir el archivo combinado si ya existe
  const command = `ffmpeg ${inputArgs} -filter_complex "${filterComplex}" -y "${combinedOutputPath}"`;

  console.log(chalk.blue("\\nCombinando archivos de batería con ffmpeg..."));
  console.log(chalk.dim(`Comando: ${command}`));

  try {
    await new Promise((resolve, reject) => {
      const ffmpegProcess = exec(command, (error, stdout, stderr) => {
        // Mostrar stderr (ffmpeg a menudo lo usa para info/progreso)
        if (stderr) {
          process.stdout.write(chalk.gray(stderr));
        }
        // Mostrar stdout si hay algo
        if (stdout) {
          process.stdout.write(chalk.gray(stdout));
        }
        // Rechazar si hubo un error en la ejecución
        if (error) {
          // Intentar detectar si el error es que ffmpeg no se encontró
          if (
            error.message.includes("ENOENT") ||
            error.message.toLowerCase().includes("not found")
          ) {
            return reject(
              new Error(
                `Comando ffmpeg no encontrado. Asegúrate de que ffmpeg esté instalado y en tu PATH. (${error.message})`
              )
            );
          }
          return reject(
            new Error(
              `ffmpeg falló con código ${error.code}. (${error.message})`
            )
          );
        }
        resolve(); // Resolver si no hubo error
      });

      ffmpegProcess.on("error", (err) => {
        // Manejar errores al intentar iniciar el proceso
        // Este error suele ser 'spawn ENOENT', indicando que el comando no se encontró
        if (
          err.message.includes("ENOENT") ||
          err.message.toLowerCase().includes("not found")
        ) {
          reject(
            new Error(
              `Comando ffmpeg no encontrado. Asegúrate de que ffmpeg esté instalado y en tu PATH. (${err.message})`
            )
          );
        } else {
          reject(new Error(`Error ejecutando ffmpeg: ${err.message}`));
        }
      });
    });

    console.log(
      chalk.green(`\\n¡Archivos combinados con éxito en ${combinedOutputPath}!`)
    );

    // Si la combinación fue exitosa, reproducir
    await playAudioFile(combinedOutputPath);
  } catch (error) {
    console.error(chalk.red(`\\nError combinando los archivos de batería:`));
    console.error(chalk.red(`  ${error.message}`));
    // Ya se incluye el mensaje sobre instalar ffmpeg en el propio error
  }
}

// --- Nueva Función Auxiliar ---
/**
 * Reproduce un archivo de audio usando play-sound.
 * @param {string} audioFilePath - Ruta absoluta al archivo de audio.
 */
async function playAudioFile(audioFilePath) {
  if (!fs.existsSync(audioFilePath)) {
    console.error(
      chalk.red(
        `Error: El archivo de audio a reproducir no existe: ${audioFilePath}`
      )
    );
    return;
  }
  console.log(
    chalk.blue(`\nIntentando reproducir: ${path.basename(audioFilePath)}...`)
  );

  try {
    await new Promise((resolve, reject) => {
      audioPlayer.play(audioFilePath, (err) => {
        if (err) {
          // Intentar dar un mensaje más útil si no se encuentra el reproductor
          if (
            err.message &&
            (err.message.includes("Couldn't find a suitable audio player") ||
              err.message.toLowerCase().includes("no such file") ||
              err.code === "ENOENT")
          ) {
            reject(
              new Error(
                `No se encontró un reproductor de audio compatible (como afplay, mplayer, vlc, aplay) o el archivo/comando no existe. (${err.message})`
              )
            );
          } else {
            reject(err); // Otro error durante la reproducción
          }
        } else {
          console.log(chalk.green("Reproducción finalizada."));
          resolve();
        }
      });
    });
  } catch (playError) {
    console.error(chalk.red(`\nError reproduciendo el archivo de audio:`));
    console.error(chalk.red(`  ${playError.message}`));
    // El mensaje de error ya sugiere instalar un reproductor compatible
  }
}

/**
 * Función principal del CLI.
 */
async function main() {
  console.log(
    chalk.bold.cyan(
      "--- CLI de Búsqueda, Descarga y Procesamiento de Batería ---"
    )
  );

  // 1. Obtener término de búsqueda
  const { query } = await inquirer.prompt([
    {
      type: "input",
      name: "query",
      message: "Ingresa tu búsqueda en YouTube:",
      validate: (input) =>
        input.trim() !== "" || "Por favor, ingresa algo para buscar.",
    },
  ]);

  // 2. Buscar videos
  const videos = await searchVideos(query.trim());

  if (!videos || videos.length === 0) {
    console.log(
      chalk.magenta("\nNo se encontraron videos. Terminando ejecución.")
    );
    return; // Salir si no hay resultados o hubo error
  }

  // 3. Mostrar resultados y permitir selección
  const { selectedVideoId } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedVideoId",
      message:
        "Selecciona un video para descargar el audio y extraer la batería:",
      choices: videos.map((video, index) => ({
        name: `${index + 1}. ${video.title}`, // Mostrar título
        value: video.videoId, // El valor será el ID del video
      })),
    },
  ]);

  // 4. Obtener el título del video seleccionado
  const selectedVideo = videos.find((v) => v.videoId === selectedVideoId);
  if (!selectedVideo) {
    console.error(
      chalk.red("Error: No se pudo encontrar el video seleccionado.")
    );
    return;
  }

  // 5. Descargar el audio del video seleccionado
  const downloadedFilePath = await downloadVideoAudio(
    selectedVideo.videoId,
    selectedVideo.title
  );

  // 6. Si la descarga fue exitosa, procesar con Moises
  if (downloadedFilePath) {
    try {
      // Usar el título del video (sanitizado) como nombre del job
      const jobName = selectedVideo.title
        .replace(/[\u0000-\u001F\\/?*:|"<>]/g, "_")
        .substring(0, 100);
      await processAudioWithMoises(downloadedFilePath, jobName);
    } catch (moisesError) {
      // El error ya se maneja dentro de processAudioWithMoises
      console.log(
        chalk.magenta(
          "\nTerminando ejecución debido a error en el procesamiento de IA."
        )
      );
    }
  } else {
    console.log(
      chalk.magenta(
        "\nNo se pudo descargar el audio, omitiendo procesamiento de IA."
      )
    );
  }

  console.log(chalk.magenta("\n¡Proceso finalizado!"));
}

// Ejecutar la función principal
main();
