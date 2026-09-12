import assert from 'assert';
import { sanitizeFilename, parseCliArgs } from '../src/utils.js';
import { formatTranscriptText } from '../src/formatter.js';
import { resolveTargetUrls } from '../src/youtube.js';

console.log('🧪 Running unit tests for v2ts modules...\n');

// Test 1: sanitizeFilename
{
  const rawTitle = 'The Delightful Flow of Sri Radha\'s Pastimes (25th August 2020) | #Spiritual';
  const sanitized = sanitizeFilename(rawTitle);
  assert.strictEqual(sanitized.includes('|'), false, 'Pipe character should be stripped');
  assert.strictEqual(sanitized.includes('#'), false, 'Hash character should be stripped');
  console.log('✅ Pass: sanitizeFilename cleans title properly');
}

// Test 2: Devanagari script preservation in sanitizeFilename
{
  const devanagariTitle = 'श्री राधा जी के मधुर प्रसंग 2024!';
  const sanitized = sanitizeFilename(devanagariTitle);
  assert.ok(sanitized.includes('श्री'), 'Devanagari text preserved');
  console.log('✅ Pass: sanitizeFilename preserves Hindi / Devanagari characters');
}

// Test 3: parseCliArgs
{
  const parsed1 = parseCliArgs(['-l', 'hi', '-d', '3', '-o', './my_transcripts', 'https://www.youtube.com/@BDDSwamiMedia']);
  assert.strictEqual(parsed1.lang, 'hindi');
  assert.strictEqual(parsed1.days, 3);
  assert.strictEqual(parsed1.outDir, './my_transcripts');
  assert.strictEqual(parsed1.target, 'https://www.youtube.com/@BDDSwamiMedia');
  assert.strictEqual(parsed1.showHelp, false);

  const parsed2 = parseCliArgs(['--help']);
  assert.strictEqual(parsed2.showHelp, true);
  console.log('✅ Pass: parseCliArgs correctly handles CLI flags including --days');
}

// Test 4: formatTranscriptText with word-level speaker API payload
{
  const mockApiData = {
    words: [
      { text: 'Hare', speaker_id: 'speaker_0' },
      { text: 'Krishna', speaker_id: 'speaker_0' },
      { text: 'Thank', speaker_id: 'speaker_1' },
      { text: 'you', speaker_id: 'speaker_1' }
    ]
  };

  const formatted = formatTranscriptText('', mockApiData);
  assert.ok(formatted.includes('SPEAKER 0:\nHare Krishna'), 'Contains SPEAKER 0 block');
  assert.ok(formatted.includes('SPEAKER 1:\nThank you'), 'Contains SPEAKER 1 block');
  console.log('✅ Pass: formatTranscriptText formats word-level speaker IDs into distinct speaker blocks');
}

// Test 5: formatTranscriptText with embedded SPEAKER text
{
  const rawText = 'SPEAKER 0\nHare Krishna\nSPEAKER 1\nThank you';
  const formatted = formatTranscriptText(rawText);
  assert.ok(formatted.includes('SPEAKER 0:\nHare Krishna'), 'Reformats embedded speaker tags');
  console.log('✅ Pass: formatTranscriptText reformats embedded speaker tags into clean paragraphs');
}

// Test 6: resolveTargetUrls for single video
{
  const urls = resolveTargetUrls('https://www.youtube.com/watch?v=VIDEO_ID');
  assert.strictEqual(urls.length, 1);
  assert.strictEqual(urls[0], 'https://www.youtube.com/watch?v=VIDEO_ID');
  console.log('✅ Pass: resolveTargetUrls resolves single video URL');
}

console.log('\n🎉 All unit tests passed successfully!');
