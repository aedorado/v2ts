import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { sanitizeFilename } from './utils.js';

// Player client strategies to bypass YouTube bot / sign-in detection in datacenter IPs (like CI/GitHub Actions)
const PLAYER_CLIENT_STRATEGIES = [
  'youtube:player_client=ios,web_creator',
  'youtube:player_client=android_vr,tv_embedded',
  'youtube:player_client=mweb,android',
  'youtube:player_client=web'
];

/**
 * Builds yt-dlp argument list for a given strategy and cookie configuration.
 * @param {string} playerClientStrategy 
 * @param {boolean} allowBrowserCookies 
 * @param {string[]} extraArgs 
 * @returns {string[]}
 */
function buildYtDlpArgs(playerClientStrategy, allowBrowserCookies = true, extraArgs = []) {
  const baseArgs = [];

  // Check if explicit cookies file exists
  const envCookies = process.env.YTDLP_COOKIES_FILE || 'cookies.txt';
  if (fs.existsSync(envCookies) && fs.statSync(envCookies).size > 10) {
    baseArgs.push('--cookies', envCookies);
  } else if (allowBrowserCookies && !process.env.CI) {
    // Only attempt Chrome browser cookies locally
    baseArgs.push('--cookies-from-browser', 'chrome');
  }

  // Set player client strategy & common stealth options
  baseArgs.push('--extractor-args', playerClientStrategy);
  baseArgs.push('--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1');

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

  // 1. First pass: try with browser cookies (if local) across strategies
  for (const strategy of PLAYER_CLIENT_STRATEGIES) {
    const args = buildYtDlpArgs(strategy, true, extraArgs);
    const result = spawnSync('yt-dlp', args, {
      encoding: 'utf-8',
      stdio: inheritStdio ? 'inherit' : 'pipe'
    });

    if (result.status === 0) {
      return result;
    }
    lastResult = result;
  }

  // 2. Second pass: try without browser cookies across strategies (CI fallback)
  for (const strategy of PLAYER_CLIENT_STRATEGIES) {
    const args = buildYtDlpArgs(strategy, false, extraArgs);
    const result = spawnSync('yt-dlp', args, {
      encoding: 'utf-8',
      stdio: inheritStdio ? 'inherit' : 'pipe'
    });

    if (result.status === 0) {
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
 * @param {number} [options.maxVideos=20] Max recent channel videos to check
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
    const maxVideos = options.maxVideos || 20;
    console.log(`📺 Target is a Channel/Playlist URL: ${target}`);
    console.log(`🔍 Querying recent videos uploaded in the last ${days} day(s)...`);

    const channelUrl = (target.includes('/playlist') || target.endsWith('/videos')) 
      ? target 
      : `${target.replace(/\/$/, '')}/videos`;
    
    const dateFilter = `now-${days}days`;

    const queryArgs = [
      '--flat-playlist',
      '--playlist-end', String(maxVideos),
      '--dateafter', dateFilter,
      '--print', '%(webpage_url)s',
      channelUrl
    ];

    const cmd = executeYtDlpWithFallback(queryArgs, { inheritStdio: false });

    if (cmd.stdout) {
      const urls = cmd.stdout
        .trim()
        .split('\n')
        .map(u => u.trim())
        .filter(u => u.startsWith('http'));

      const uniqueUrls = Array.from(new Set(urls));
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
