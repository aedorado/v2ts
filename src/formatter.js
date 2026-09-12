import fs from 'fs';
import path from 'path';

/**
 * Formats transcript text with clear speaker distinction and paragraph breaks.
 * Uses word-level speaker IDs from rawApiResponse.words if available.
 * 
 * @param {string} rawText 
 * @param {Object|null} rawApiResponse 
 * @returns {string}
 */
export function formatTranscriptText(rawText, rawApiResponse = null) {
  // 1. Reconstruct directly from word-level diarization API payload if available
  if (rawApiResponse && Array.isArray(rawApiResponse.words) && rawApiResponse.words.length > 0) {
    const words = rawApiResponse.words;
    const speakerBlocks = [];
    let currentSpeaker = null;
    let currentBlockWords = [];

    for (const w of words) {
      if (!w || (!w.text && !w.word)) continue;
      const wordText = (w.text || w.word).trim();
      if (!wordText) continue;

      const rawSpeaker = w.speaker_id || w.speaker || w.speaker_label;
      let speaker = 'SPEAKER 0';
      if (rawSpeaker !== undefined && rawSpeaker !== null) {
        const num = String(rawSpeaker).replace(/^speaker_?/i, '');
        speaker = `SPEAKER ${num}`;
      }

      if (currentSpeaker === null) {
        currentSpeaker = speaker;
      }

      if (speaker !== currentSpeaker) {
        if (currentBlockWords.length > 0) {
          speakerBlocks.push(`${currentSpeaker}:\n${currentBlockWords.join(' ')}`);
          currentBlockWords = [];
        }
        currentSpeaker = speaker;
      }

      currentBlockWords.push(wordText);
    }

    if (currentBlockWords.length > 0) {
      speakerBlocks.push(`${currentSpeaker}:\n${currentBlockWords.join(' ')}`);
    }

    if (speakerBlocks.length > 0) {
      return speakerBlocks.join('\n\n');
    }
  }

  // 2. Format raw text containing embedded SPEAKER labels or single-word line streams
  if (!rawText) return '';
  const trimmed = rawText.trim();
  const lines = trimmed.split('\n');

  if (trimmed.toUpperCase().includes('SPEAKER') || lines.length > 300) {
    const formattedBlocks = [];
    let currentSpeaker = '';
    let currentWords = [];

    for (let line of lines) {
      const lineStr = line.trim();
      if (!lineStr) continue;

      // Check if line is a speaker header (e.g. SPEAKER 0, SPEAKER 1:, Speaker 2)
      if (/^(SPEAKER|Speaker)\s*([0-9A-Za-z_-]+):?/i.test(lineStr)) {
        if (currentWords.length > 0) {
          const header = currentSpeaker ? `${currentSpeaker}:` : '';
          formattedBlocks.push(header ? `${header}\n${currentWords.join(' ')}` : currentWords.join(' '));
          currentWords = [];
        }
        const numMatch = lineStr.match(/[0-9A-Za-z_-]+/g);
        const speakerNum = numMatch && numMatch.length > 1 ? numMatch[1] : '0';
        currentSpeaker = `SPEAKER ${speakerNum}`;
      } else {
        currentWords.push(lineStr);
      }
    }

    if (currentWords.length > 0) {
      const header = currentSpeaker ? `${currentSpeaker}:` : '';
      formattedBlocks.push(header ? `${header}\n${currentWords.join(' ')}` : currentWords.join(' '));
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
  const formattedText = formatTranscriptText(extractedText, rawApiResponse);
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
