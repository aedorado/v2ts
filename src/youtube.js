import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { sanitizeFilename } from './utils.js';

// Reliable player client strategies for YouTube metadata and audio downloading
const PLAYER_CLIENT_STRATEGIES = [
  'youtube:player_client=mweb,android',
  'youtube:player_client=android,web',
  'youtube:player_client=ios,web_creator',
  'youtube:player_client=android_vr,tv_embedded'
];

/**
 * Calculates a cutoff date string 'YYYY_MM_DD' for N days ago.
 * @param {number} days 
 * @returns {string}
 */
export function getCutoffDateString(days = 1) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}_${month}_${day}`;
}

/**
 * Builds yt-dlp argument list for a given strategy and cookie configuration.
 * @param {string} playerClientStrategy 
 * @param {boolean} allowBrowserCookies 
 * @param {string[]} extraArgs 
 * @returns {string[]}
 */
function buildYtDlpArgs(playerClientStrategy, allowBrowserCookies = true, extraArgs = []) {
  const baseArgs = [];

  const envCookies = process.env.YTDLP_COOKIES_FILE || 'cookies.txt';
  if (fs.existsSync(envCookies) && fs.statSync(envCookies).size > 10) {
    baseArgs.push('--cookies', envCookies);
  } else if (allowBrowserCookies && !process.env.CI) {
    baseArgs.push('--cookies-from-browser', 'chrome');
  }

  baseArgs.push('--extractor-args', playerClientStrategy);

  return [...baseArgs, ...extraArgs];
}

/**
 * Executes a yt-dlp command trying multiple player client strategies until one succeeds.
 * @param {string[]} extraArgs 
 * @param {Object} options
 * @param {boolean} [options.inheritStdio=false]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function executeYtDlpWithFallback(extraArgs, options = {}) {
  const inheritStdio = options.inheritStdio || false;
  let lastResult = null;

  for (const strategy of PLAYER_CLIENT_STRATEGIES) {
    const args = buildYtDlpArgs(strategy, true, extraArgs);
    const result = spawnSync('yt-dlp', args, {
      encoding: 'utf-8',
      stdio: inheritStdio ? 'inherit' : 'pipe'
    });

    if (result && result.status === 0 && result.stdout && result.stdout.trim()) {
      return result;
    }
    lastResult = result;
  }

  for (const strategy of PLAYER_CLIENT_STRATEGIES) {
    const args = buildYtDlpArgs(strategy, false, extraArgs);
    const result = spawnSync('yt-dlp', args, {
      encoding: 'utf-8',
      stdio: inheritStdio ? 'inherit' : 'pipe'
    });

    if (result && result.status === 0 && result.stdout && result.stdout.trim()) {
      return result;
    }
    lastResult = result;
  }

  return lastResult;
}

/**
 * Resolves a target input (single video URL, file path, or channel/playlist URL)
 * into a list of individual YouTube video URLs to process.
 * If a channel URL is provided, filters videos uploaded in the last N days.
 * 
 * @param {string} target 
 * @param {Object} options
 * @param {number} [options.days=1] Lookback timeframe in days for channel uploads
 * @param {number} [options.maxCheck=10] Max recent channel videos to inspect
 * @returns {string[]} Array of video URLs
 */
export function resolveTargetUrls(target, options = {}) {
  // 1. Check if target is an existing batch text file
  const resolvedPath = path.resolve(target);
  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
    console.log(`📄 Reading URLs from batch file: ${target}`);
    const lines = fs.readFileSync(resolvedPath, 'utf-8').split('\n');
    return lines
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  }

  // 2. Check if target is a Channel, User, or Playlist URL
  const isChannelOrPlaylist = target.includes('/@') || 
    target.includes('/channel/') || 
    target.includes('/c/') || 
    target.includes('/user/') || 
    target.includes('/playlist');

  if (isChannelOrPlaylist) {
    const days = options.days || 1;
    const maxCheck = options.maxCheck || 10;
    const cutoffDateStr = getCutoffDateString(days);
    console.log(`📺 Target is a Channel/Playlist URL: ${target}`);
    console.log(`🔍 Checking channel videos uploaded on or after ${cutoffDateStr} (last ${days} day(s))...`);

    const channelUrl = (target.includes('/playlist') || target.endsWith('/videos')) 
      ? target 
      : `${target.replace(/\/$/, '')}/videos`;
    
    // Single-call query returning upload_date, webpage_url, title for top recent videos
    const queryArgs = [
      '--playlist-end', String(maxCheck),
      '--print', '%(upload_date>%Y_%m_%d)s\t%(webpage_url)s\t%(title)s',
      channelUrl
    ];

    const cmd = executeYtDlpWithFallback(queryArgs, { inheritStdio: false });

    if (cmd && cmd.stdout) {
      const lines = cmd.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const matchingUrls = [];

      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length < 2) continue;

        const videoDateStr = parts[0];
        const videoUrl = parts[1];
        const title = parts[2] || videoUrl;

        if (/^\d{4}_\d{2}_\d{2}$/.test(videoDateStr)) {
          if (videoDateStr >= cutoffDateStr) {
            console.log(`  └─ Found recent video: ${title} (${videoDateStr})`);
            matchingUrls.push(videoUrl);
          } else {
            console.log(`  └─ Reached older video: ${title} (${videoDateStr}). Stopping channel scan.`);
            break;
          }
        } else if (videoUrl.startsWith('http')) {
          console.log(`  └─ Including video: ${title}`);
          matchingUrls.push(videoUrl);
        }
      }

      const uniqueUrls = Array.from(new Set(matchingUrls));
      console.log(`Found ${uniqueUrls.length} video(s) uploaded in the last ${days} day(s).\n`);
      return uniqueUrls;
    }

    console.log(`⚠️ No videos found for channel in the last ${days} day(s).\n`);
    return [];
  }

  // 3. Single video URL
  return [target];
}

/**
 * Fetches video metadata (upload date & title) using yt-dlp with fallback strategies.
 * @param {string} youtubeUrl 
 * @returns {{ uploadDate: string, rawTitle: string, cleanTitle: string, folderName: string }}
 */
export function fetchVideoMetadata(youtubeUrl) {
  let uploadDate = '';
  let rawTitle = 'youtube_audio';

  const metaCmd = executeYtDlpWithFallback([
    '--print', '%(upload_date>%Y_%m_%d)s',
    '--print', '%(title)s',
    youtubeUrl
  ], { inheritStdio: false });

  if (metaCmd && metaCmd.stdout) {
    const lines = metaCmd.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      uploadDate = lines[0];
      rawTitle = lines.slice(1).join(' ');
    } else if (lines.length === 1) {
      rawTitle = lines[0];
    }
  }

  const cleanTitle = sanitizeFilename(rawTitle) || 'transcript_output';
  const prefix = (uploadDate && /^\d{4}_\d{2}_\d{2}$/.test(uploadDate)) ? `${uploadDate}_` : '';
  const folderName = `${prefix}${cleanTitle}`;

  return { uploadDate, rawTitle, cleanTitle, folderName };
}

/**
 * Downloads audio as MP3 using yt-dlp with client strategy fallback.
 * @param {string} youtubeUrl 
 * @param {string} audioPath 
 */
export function downloadAudio(youtubeUrl, audioPath) {
  if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000) {
    console.log(`✅ Audio already downloaded at: ${audioPath} (Skipping yt-dlp)`);
    return;
  }

  console.log(`Downloading audio to: ${audioPath}`);

  const downloadParams = [
    '-f', 'ba[ext=m4a]/ba/worst[acodec!=none]',
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '-o', audioPath,
    youtubeUrl
  ];

  const dlResult = executeYtDlpWithFallback(downloadParams, { inheritStdio: true });

  if (!dlResult || dlResult.status !== 0) {
    throw new Error(`Failed to download audio with yt-dlp for URL: ${youtubeUrl}`);
  }
}
