#!/usr/bin/env node

import { google } from "googleapis";
import inquirer from "inquirer";
import dotenv from "dotenv";
import { exec } from "child_process"; // Usaremos exec para llamar a yt-dlp directamente para mejor control
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk"; // Para mejorar la salida en consola

// Configuración inicial
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

// Asegurarse de que el directorio de descargas exista
if (!fs.existsSync(DOWNLOADS_DIR)) {
  console.log(
    chalk.yellow(`Creando directorio de descargas en: ${DOWNLOADS_DIR}`)
  );
  fs.mkdirSync(DOWNLOADS_DIR);
}

// Validar API Key
if (!process.env.YOUTUBE_API_KEY) {
  console.error(
    chalk.red(
      "Error: La variable de entorno YOUTUBE_API_KEY no está configurada."
    )
  );
  console.log(
    chalk.yellow(
      "Asegúrate de tener un archivo .env con YOUTUBE_API_KEY=TU_CLAVE"
    )
  );
  process.exit(1);
}

// Inicializar cliente de YouTube
const youtube = google.youtube({
  version: "v3",
  auth: process.env.YOUTUBE_API_KEY,
});

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
 * @returns {Promise<void>}
 */
async function downloadVideoAudio(videoId, title) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  // Nombre de archivo seguro: reemplazar caracteres inválidos
  const safeTitle = title.replace(/[<>:"/\\|?*]/g, "_").substring(0, 100); // Limitar longitud
  const outputPath = path.join(DOWNLOADS_DIR, `${safeTitle}.mp3`);

  console.log(chalk.blue(`\nIniciando descarga de audio para: "${title}"`));
  console.log(chalk.dim(`URL: ${videoUrl}`));
  console.log(chalk.dim(`Guardando en: ${outputPath}`));

  // Comando yt-dlp simplificado para extraer audio en mp3
  // Asegúrate de que 'yt-dlp' esté en tu PATH o proporciona la ruta completa
  const command = `yt-dlp -x --audio-format mp3 --output "${outputPath}" --no-check-certificates --no-warnings --force-ipv4 "${videoUrl}"`;

  console.log(chalk.dim(`Ejecutando comando: ${command}\n`));

  return new Promise((resolve, reject) => {
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
        !data.includes("[ExtractAudio]")
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
        resolve();
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
        reject(new Error(`yt-dlp falló con código ${code}`));
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
      reject(err);
    });
  });
}

/**
 * Función principal del CLI.
 */
async function main() {
  console.log(
    chalk.bold.cyan("--- CLI de Búsqueda y Descarga de YouTube (Audio) ---")
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

  if (videos.length === 0) {
    console.log(chalk.magenta("\nTerminando ejecución."));
    return; // Salir si no hay resultados o hubo error
  }

  // 3. Mostrar resultados y permitir selección
  const { selectedVideoId } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedVideoId",
      message: "Selecciona un video para descargar el audio:",
      choices: videos.map((video, index) => ({
        name: `${index + 1}. ${video.title}`, // Mostrar título
        value: video.videoId, // El valor será el ID del video
      })),
    },
  ]);

  // 4. Obtener el título del video seleccionado (para el nombre de archivo)
  const selectedVideo = videos.find((v) => v.videoId === selectedVideoId);
  if (!selectedVideo) {
    console.error(
      chalk.red("Error: No se pudo encontrar el video seleccionado.")
    );
    return;
  }

  // 5. Descargar el audio del video seleccionado
  try {
    await downloadVideoAudio(selectedVideo.videoId, selectedVideo.title);
  } catch (error) {
    // El error ya se muestra dentro de downloadVideoAudio
    console.log(
      chalk.magenta("\nTerminando ejecución debido a error en la descarga.")
    );
  }
  console.log(chalk.magenta("\n¡Proceso finalizado!"));
}

// Ejecutar la función principal
main();
