import fs from 'fs';

function cleanTranscript(rawText) {
  // Check if text has the one-word-per-line issue
  const lines = rawText.split('\n');
  const cleanedBlocks = [];
  let currentSpeaker = '';
  let currentWords = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('SPEAKER ')) {
      if (currentWords.length > 0) {
        cleanedBlocks.push(`${currentSpeaker}\n${currentWords.join(' ')}`);
        currentWords = [];
      }
      currentSpeaker = trimmed;
    } else {
      currentWords.push(trimmed);
    }
  }

  if (currentWords.length > 0) {
    cleanedBlocks.push(`${currentSpeaker}\n${currentWords.join(' ')}`);
  }

  return cleanedBlocks.join('\n\n');
}

const file = 'transcripts/13_JU_Mount/13_JU_Mount.txt';
const raw = fs.readFileSync(file, 'utf-8');
const cleaned = cleanTranscript(raw);
console.log('Original lines:', raw.split('\n').length);
console.log('Cleaned lines:', cleaned.split('\n').length);
console.log('\nPreview:\n', cleaned.slice(0, 500));
console.log('\nTail Preview:\n', cleaned.slice(-500));

fs.writeFileSync(file, cleaned, 'utf-8');
console.log('\nSuccessfully reformatted 13_JU_Mount.txt!');
