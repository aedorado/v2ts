import fs from 'fs';
import path from 'path';
import { formatTranscriptText } from '../src/formatter.js';

const transcriptsDir = path.resolve('transcripts');

if (!fs.existsSync(transcriptsDir)) {
  console.log('No transcripts directory found.');
  process.exit(0);
}

console.log('🔍 Scanning transcripts directory for files to reformat...\n');

const entries = fs.readdirSync(transcriptsDir, { withFileTypes: true });

for (const entry of entries) {
  if (entry.isDirectory()) {
    const folderPath = path.join(transcriptsDir, entry.name);
    const files = fs.readdirSync(folderPath);
    
    const jsonFile = files.find(f => f.endsWith('.json'));
    const txtFile = files.find(f => f.endsWith('.txt'));

    if (jsonFile && txtFile) {
      const jsonPath = path.join(folderPath, jsonFile);
      const txtPath = path.join(folderPath, txtFile);

      try {
        const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const rawApiData = jsonContent.rawApiResponse;
        const currentText = jsonContent.transcript || fs.readFileSync(txtPath, 'utf-8');

        const reformatted = formatTranscriptText(currentText, rawApiData);

        if (reformatted && reformatted !== currentText) {
          fs.writeFileSync(txtPath, reformatted, 'utf-8');
          jsonContent.transcript = reformatted;
          fs.writeFileSync(jsonPath, JSON.stringify(jsonContent, null, 2), 'utf-8');
          console.log(`✅ Reformatted speaker blocks for: ${entry.name}`);
        } else {
          console.log(`ℹ️ Already cleanly formatted: ${entry.name}`);
        }
      } catch (e) {
        console.error(`❌ Error reformatting ${entry.name}:`, e.message);
      }
    }
  }
}

console.log('\n🎉 Reformatting complete!');
