import fs from 'fs';
import path from 'path';

/**
 * Sanitizes a title string into a clean folder/file name.
 * Preserves alphanumeric, Devanagari script, spaces, hyphens, underscores.
 * @param {string} name 
 * @returns {string}
 */
export function sanitizeFilename(name) {
  if (!name) return 'transcript_output';
  return name.replace(/[^a-zA-Z0-9_\u0900-\u097F -]/g, '').trim().replace(/\s+/g, '_');
}

/**
 * Resolves the destination directory and creates it if missing.
 * @param {string} outDir 
 * @returns {string} Absolute path to output directory
 */
export function ensureOutputDir(outDir = 'transcripts') {
  const resolved = path.resolve(outDir);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

/**
 * Checks if a transcript already exists to avoid redundant processing.
 * @param {string} outputDir 
 * @param {string} folderName 
 * @param {string} cleanTitle 
 * @returns {boolean} True if transcript already exists and is non-empty
 */
export function checkExistingTranscript(outputDir, folderName, cleanTitle) {
  const videoFolder = path.join(outputDir, folderName);
  const txtPath = path.join(videoFolder, `${folderName}.txt`);

  // Check new folder path
  if (fs.existsSync(txtPath) && fs.statSync(txtPath).size > 100) {
    const content = fs.readFileSync(txtPath, 'utf-8');
    if (!content.includes('No transcript text extracted')) {
      return true;
    }
  }

  // Check legacy folder path (without date prefix)
  const oldFolder = path.join(outputDir, cleanTitle);
  const oldTxt = path.join(oldFolder, `${cleanTitle}.txt`);
  if (fs.existsSync(oldTxt) && fs.statSync(oldTxt).size > 100) {
    const oldContent = fs.readFileSync(oldTxt, 'utf-8');
    if (!oldContent.includes('No transcript text extracted')) {
      return true;
    }
  }

  return false;
}

/**
 * Reuses existing audio file from legacy folder if available.
 * @param {string} outputDir 
 * @param {string} videoFolder 
 * @param {string} folderName 
 * @param {string} cleanTitle 
 */
export function copyLegacyAudioIfExists(outputDir, videoFolder, folderName, cleanTitle) {
  const targetAudio = path.join(videoFolder, `${folderName}.mp3`);
  if (fs.existsSync(targetAudio) && fs.statSync(targetAudio).size > 1000) {
    return true;
  }

  const oldFolder = path.join(outputDir, cleanTitle);
  const oldAudio = path.join(oldFolder, `${cleanTitle}.mp3`);
  if (fs.existsSync(oldAudio) && fs.statSync(oldAudio).size > 1000) {
    fs.copyFileSync(oldAudio, targetAudio);
    console.log(`✅ Reused existing audio from legacy folder: ${oldAudio}`);
    return true;
  }

  return false;
}

/**
 * Parses raw command line arguments.
 * @param {string[]} args 
 * @returns {{ target: string|null, lang: string, outDir: string, days: number, showHelp: boolean }}
 */
export function parseCliArgs(args) {
  let target = null;
  let lang = 'english';
  let outDir = 'transcripts';
  let days = 1;
  let showHelp = false;

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp = true;
    return { target, lang, outDir, days, showHelp };
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--lang' || arg === '-l') {
      const val = args[i + 1]?.toLowerCase();
      lang = (val === 'hindi' || val === 'hi') ? 'hindi' : 'english';
      i++;
    } else if (arg === '--out' || arg === '-o') {
      outDir = args[i + 1] || 'transcripts';
      i++;
    } else if (arg === '--days' || arg === '-d') {
      const val = parseInt(args[i + 1], 10);
      if (!isNaN(val) && val > 0) {
        days = val;
      }
      i++;
    } else if (!arg.startsWith('-')) {
      target = arg;
    }
  }

  return { target, lang, outDir, days, showHelp };
}
