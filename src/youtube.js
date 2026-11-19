import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { sanitizeFilename } from './utils.js';

// Reliable player client strategies for YouTube metadata and audio downloading
const PLAYER_CLIENT_STRATEGIES = [
  'default', // yt-dlp native auto-selection
  'youtube:player_client=tv_embedded,web',
  'youtube:player_client=ios,web_creator',
  'youtube:player_client=mweb,android',
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
 * @param {boolean} useCookieFile 
 * @returns {string[]}
 */
function buildYtDlpArgs(playerClientStrategy, allowBrowserCookies = true, extraArgs = [], useCookieFile = true) {
  const baseArgs = [];

  const envCookies = process.env.YTDLP_COOKIES_FILE || 'cookies.txt';
  if (useCookieFile && fs.existsSync(envCookies) && fs.statSync(envCookies).size > 10) {
    baseArgs.push('--cookies', envCookies);
  } else if (allowBrowserCookies && !process.env.CI) {
    baseArgs.push('--cookies-from-browser', 'chrome');
  }

  if (playerClientStrategy && playerClientStrategy !== 'default') {
    baseArgs.push('--extractor-args', playerClientStrategy);
  }

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

  const envCookies = process.env.YTDLP_COOKIES_FILE || 'cookies.txt';
  const hasCookiesFile = fs.existsSync(envCookies) && fs.statSync(envCookies).size > 10;
  const allowBrowser = !process.env.CI;

  // Pass 1: Try with cookie file (if present) or browser cookies (if local)
  for (const strategy of PLAYER_CLIENT_STRATEGIES) {
    const args = buildYtDlpArgs(strategy, true, extraArgs, true);
    const result = spawnSync('yt-dlp', args, {
      encoding: 'utf-8',
      stdio: inheritStdio ? 'inherit' : 'pipe'
    });

    const isSuccess = result && result.status === 0 && (inheritStdio || (result.stdout && result.stdout.trim()));
    if (isSuccess) {
      return result;
    }
    lastResult = result;
  }

  // Pass 2: Fallback without cookies (useful if cookie file has rotated/expired tokens or local browser cookie extraction failed)
  if (hasCookiesFile || allowBrowser) {
    for (const strategy of PLAYER_CLIENT_STRATEGIES) {
      const args = buildYtDlpArgs(strategy, false, extraArgs, false);
      const result = spawnSync('yt-dlp', args, {
        encoding: 'utf-8',
        stdio: inheritStdio ? 'inherit' : 'pipe'
      });

      const isSuccess = result && result.status === 0 && (inheritStdio || (result.stdout && result.stdout.trim()));
      if (isSuccess) {
        return result;
      }
      lastResult = result;
    }
  }

  return lastResult;
}

/**
 * Determines which channel tabs/URLs to scan.
 * Spiritual and educational channels frequently stream daily lectures under /streams (Live),
 * so unless a specific tab is specified, both /streams and /videos are scanned.
 * 
 * @param {string} target 
 * @returns {string[]} Array of URLs to inspect
 */
export function getChannelScanUrls(target) {
  const cleanTarget = target.trim().replace(/\/+$/, '');
  const isExplicitTab = cleanTarget.includes('/playlist') || 
    cleanTarget.endsWith('/videos') || 
    cleanTarget.endsWith('/streams') || 
    cleanTarget.endsWith('/live') || 
    cleanTarget.endsWith('/shorts');

  if (isExplicitTab) {
    return [cleanTarget];
  }

  return [
    `${cleanTarget}/streams`,
    `${cleanTarget}/videos`
  ];
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

    const channelsToScan = getChannelScanUrls(target);
    const allMatchingUrls = [];
    let anyQuerySucceeded = false;
    let lastErrorSnippet = null;

    for (const channelUrl of channelsToScan) {
      if (channelsToScan.length > 1) {
        const tabLabel = channelUrl.endsWith('/streams') ? 'Live Streams (/streams)' : 'Uploaded Videos (/videos)';
        console.log(`  🔎 Scanning ${tabLabel}...`);
      }

      // Fast flat-playlist query: extracts lightweight tab feed metadata without requesting individual video pages
      const queryArgs = [
        '--flat-playlist',
        '--extractor-args', 'youtubetab:approximate_date;youtubetab:skip=authcheck',
        '--playlist-end', String(maxCheck),
        '--print', '%(id)s\t%(title)s\t%(upload_date>%Y_%m_%d)s\t%(live_status)s',
        channelUrl
      ];

      const cmd = executeYtDlpWithFallback(queryArgs, { inheritStdio: false });

      if (cmd && cmd.stdout && cmd.stdout.trim()) {
        anyQuerySucceeded = true;
        const lines = cmd.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);

        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length < 2) continue;

          const videoId = parts[0];
          const title = parts[1] || videoId;
          const videoDateStr = parts[2] || '';
          const liveStatus = (parts[3] || '').toLowerCase();

          // Skip upcoming / scheduled live streams that have not finished airing
          if (liveStatus === 'is_upcoming') {
            console.log(`  └─ Skipping upcoming live stream: ${title}`);
            continue;
          }

          const videoUrl = videoId.startsWith('http') ? videoId : `https://www.youtube.com/watch?v=${videoId}`;

          if (/^\d{4}_\d{2}_\d{2}$/.test(videoDateStr)) {
            if (videoDateStr >= cutoffDateStr) {
              console.log(`  └─ Found recent video: ${title} (${videoDateStr})`);
              allMatchingUrls.push(videoUrl);
            } else {
              console.log(`  └─ Reached older video: ${title} (${videoDateStr}). Stopping this tab scan.`);
              break;
            }
          } else {
            // Include video if date is unavailable in flat-playlist
            console.log(`  └─ Found video: ${title}`);
            allMatchingUrls.push(videoUrl);
          }
        }
      } else {
        if (cmd && cmd.status === 0) {
          anyQuerySucceeded = true;
        } else if (cmd && cmd.stderr) {
          const errorLine = cmd.stderr.split('\n')
            .find(l => l.includes('ERROR:') || l.includes('Sign in') || l.includes('HTTP Error')) || cmd.stderr.trim().split('\n')[0];
          if (errorLine) {
            lastErrorSnippet = errorLine.trim();
          }
        }
      }
    }

    const uniqueUrls = Array.from(new Set(allMatchingUrls));

    if (uniqueUrls.length > 0) {
      console.log(`\n🎉 Found ${uniqueUrls.length} video(s) uploaded in the last ${days} day(s).\n`);
      return uniqueUrls;
    }

    if (anyQuerySucceeded) {
      console.log(`\n⚠️ No videos found for channel in the last ${days} day(s).\n`);
    } else {
      console.log(`\n⚠️ yt-dlp was unable to retrieve video listings from the channel.`);
      if (lastErrorSnippet) {
        console.log(`   Details: ${lastErrorSnippet}`);
      }
      console.log(`💡 Tip: Cloud runner IPs (e.g. GitHub Actions) are often challenged or blocked by YouTube.`);
      console.log(`   Export your YouTube cookies to cookies.txt or configure the YTDLP_COOKIES GitHub Secret.\n`);
    }

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
