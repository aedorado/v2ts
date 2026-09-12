import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { sanitizeFilename } from './utils.js';

/**
 * Helper to build yt-dlp arguments for metadata or downloading.
 * Supports automatic cookie detection and fallback for CI / GitHub Actions.
 * @param {boolean} useCookies 
 * @param {string[]} extraArgs 
 * @returns {string[]}
 */
function buildYtDlpArgs(useCookies = true, extraArgs = []) {
  const baseArgs = [];

  // Check if explicit cookies file path is provided via environment or file
  const envCookies = process.env.YTDLP_COOKIES_FILE || 'cookies.txt';
  if (fs.existsSync(envCookies)) {
    baseArgs.push('--cookies', envCookies);
  } else if (useCookies && !process.env.CI) {
    // Only attempt Chrome browser cookies if NOT running in CI (GitHub Actions)
    baseArgs.push('--cookies-from-browser', 'chrome');
  }

  // Reliable player client args for YouTube
  baseArgs.push('--extractor-args', 'youtube:player_client=mweb,android');

  return [...baseArgs, ...extraArgs];
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

    let cmd = spawnSync('yt-dlp', buildYtDlpArgs(true, queryArgs), { encoding: 'utf-8' });

    // Fallback if browser cookies fail in CI
    if (cmd.status !== 0 || !cmd.stdout) {
      cmd = spawnSync('yt-dlp', buildYtDlpArgs(false, queryArgs), { encoding: 'utf-8' });
    }

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
 * Fetches video metadata (upload date & title) using yt-dlp with fallback.
 * @param {string} youtubeUrl 
 * @returns {{ uploadDate: string, rawTitle: string, cleanTitle: string, folderName: string }}
 */
export function fetchVideoMetadata(youtubeUrl) {
  let uploadDate = '';
  let rawTitle = 'youtube_audio';

  let metaCmd = spawnSync('yt-dlp', buildYtDlpArgs(true, [
    '--print', '%(upload_date>%Y_%m_%d)s',
    '--print', '%(title)s',
    youtubeUrl
  ]), { encoding: 'utf-8' });

  if (metaCmd.status !== 0 || !metaCmd.stdout) {
    metaCmd = spawnSync('yt-dlp', buildYtDlpArgs(false, [
      '--print', '%(upload_date>%Y_%m_%d)s',
      '--print', '%(title)s',
      youtubeUrl
    ]), { encoding: 'utf-8' });
  }

  if (metaCmd.stdout) {
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
 * Downloads audio as MP3 using yt-dlp with automatic fallback.
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

  let dlResult = spawnSync('yt-dlp', buildYtDlpArgs(true, downloadParams), { stdio: 'inherit' });

  if (dlResult.status !== 0) {
    console.log('⚠️ First download attempt failed. Retrying without browser cookies...');
    dlResult = spawnSync('yt-dlp', buildYtDlpArgs(false, downloadParams), { stdio: 'inherit' });
  }

  if (dlResult.status !== 0) {
    throw new Error(`Failed to download audio with yt-dlp for URL: ${youtubeUrl}`);
  }
}
