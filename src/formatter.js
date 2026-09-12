import fs from 'fs';
import path from 'path';

/**
 * Reformats raw extracted text, handling line-by-line word breaks if present.
 * @param {string} rawText 
 * @returns {string}
 */
export function formatTranscriptText(rawText) {
  if (!rawText) return '';
  const trimmed = rawText.trim();
  const lines = trimmed.split('\n');

  // Auto-reformat if words are separated line-by-line (e.g., > 500 lines for single words)
  if (lines.length > 500) {
    const formattedBlocks = [];
    let currentSpeaker = '';
    let currentWords = [];

    for (let line of lines) {
      const lineStr = line.trim();
      if (!lineStr) continue;

      if (lineStr.startsWith('SPEAKER ')) {
        if (currentWords.length > 0) {
          formattedBlocks.push(`${currentSpeaker}\n${currentWords.join(' ')}`);
          currentWords = [];
        }
        currentSpeaker = lineStr;
      } else {
        currentWords.push(lineStr);
      }
    }

    if (currentWords.length > 0) {
      formattedBlocks.push(`${currentSpeaker}\n${currentWords.join(' ')}`);
    }

    if (formattedBlocks.length > 0) {
      return formattedBlocks.join('\n\n');
    }
  }

  return trimmed;
}

/**
 * Saves plain text and JSON transcript artifacts to the target video folder.
 * @param {Object} params
 * @param {string} params.videoFolder
 * @param {string} params.folderName
 * @param {string} params.rawTitle
 * @param {string} params.youtubeUrl
 * @param {string} params.lang
 * @param {string} params.extractedText
 * @param {Object|null} params.rawApiResponse
 * @returns {{ txtPath: string, jsonPath: string, formattedText: string }}
 */
export function saveTranscriptOutputs({ videoFolder, folderName, rawTitle, youtubeUrl, lang, extractedText, rawApiResponse }) {
  const formattedText = formatTranscriptText(extractedText);
  if (!formattedText) {
    throw new Error('Transcription finished but could not read text from page.');
  }

  const txtPath = path.join(videoFolder, `${folderName}.txt`);
  const jsonPath = path.join(videoFolder, `${folderName}.json`);

  // Write Plain Text transcript
  fs.writeFileSync(txtPath, formattedText, 'utf-8');

  // Write JSON metadata structure
  const jsonOutput = {
    title: rawTitle,
    sourceUrl: youtubeUrl,
    language: lang,
    date: new Date().toISOString(),
    transcript: formattedText,
    rawApiResponse: rawApiResponse || null
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), 'utf-8');

  return { txtPath, jsonPath, formattedText };
}
