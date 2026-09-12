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

// Test 4: formatTranscriptText
{
  const singleWordLines = [];
  singleWordLines.push('SPEAKER 1');
  for (let i = 0; i < 600; i++) {
    singleWordLines.push(`word${i}`);
  }
  const raw = singleWordLines.join('\n');
  const formatted = formatTranscriptText(raw);
  assert.ok(formatted.startsWith('SPEAKER 1\nword0 word1'), 'Words joined into sentences');
  assert.strictEqual(formatted.split('\n').length, 2, 'Should condense hundreds of lines into speaker block');
  console.log('✅ Pass: formatTranscriptText reformats line-by-line single word output');
}

// Test 5: resolveTargetUrls for single video
{
  const urls = resolveTargetUrls('https://www.youtube.com/watch?v=VIDEO_ID');
  assert.strictEqual(urls.length, 1);
  assert.strictEqual(urls[0], 'https://www.youtube.com/watch?v=VIDEO_ID');
  console.log('✅ Pass: resolveTargetUrls resolves single video URL');
}

console.log('\n🎉 All unit tests passed successfully!');
