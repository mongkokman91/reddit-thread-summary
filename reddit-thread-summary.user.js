// ==UserScript==
// @name         Reddit Thread Summary
// @namespace    https://github.com/mongkokman91/reddit-thread-summary
// @version      1.1.6
// @description  AI TL;DR at the top of a Reddit thread, plus a short AI recap under posts in feeds.
// @author       mongkokman91
// @license      MIT
// @homepageURL  https://github.com/mongkokman91/reddit-thread-summary
// @supportURL   https://github.com/mongkokman91/reddit-thread-summary/issues
// @updateURL    https://raw.githubusercontent.com/mongkokman91/reddit-thread-summary/main/reddit-thread-summary.user.js
// @downloadURL  https://raw.githubusercontent.com/mongkokman91/reddit-thread-summary/main/reddit-thread-summary.user.js
// @match        https://www.reddit.com/*
// @match        https://old.reddit.com/*
// @match        https://new.reddit.com/*
// @match        https://sh.reddit.com/*
// @match        https://m.reddit.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      www.reddit.com
// @connect      old.reddit.com
// @connect      new.reddit.com
// @connect      sh.reddit.com
// @connect      m.reddit.com
// @connect      reddit.com
// @connect      generativelanguage.googleapis.com
// ==/UserScript==

/*
 * Shows a stickied-comment style "TL;DR of the discussion" at the top of a
 * Reddit thread. It starts on page load and on in-app navigation. No button.
 *
 * Match is every page on the Reddit hosts, not only /comments/ URLs. New
 * Reddit is a single-page app: the script has to be alive on the feed so it
 * can notice a client-side jump into a thread. On a thread it writes the
 * TL;DR. On feeds it adds a short recap under each post card once that card
 * scrolls into view.
 *
 * Thread text comes from the public .json endpoint. The summary comes from
 * the reader's own Gemini API key, stored with GM_setValue.
 *
 * Bump @version when you change this file. Tampermonkey and Violentmonkey
 * will not install an update from @updateURL unless the version increases.
 */
(function () {
  'use strict';

  // Newest Flash on the free tier. About 20 requests a day. When it returns
  // 429, the same summary is retried on FALLBACK_MODEL (about 500 a day).
  var DEFAULT_MODEL = 'gemini-3.8-flash';
  var FALLBACK_MODEL = 'gemini-3.5-flash-lite';
  var SESSION_38 = 'rts.flash38Exhausted';
  var MODEL_PRESETS = [
    { id: 'gemini-3.8-flash', label: 'Use gemini-3.8-flash (free, ~20/day)' },
    { id: 'gemini-3.5-flash-lite', label: 'Use gemini-3.5-flash-lite (free, ~500/day)' },
    { id: 'gemini-4-hydrogen', label: 'Use gemini-4-hydrogen (free, ~20/day)' },
    { id: 'gemini-4-neon', label: 'Use gemini-4-neon (paid)' },
    { id: 'gemini-4-carbon', label: 'Use gemini-4-carbon (paid)' }
  ];
  var SMALL_THREAD_COMMENTS = 15;
  var CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  var CACHE_MAX = 40;
  var KEY_API = 'rts.apiKey';
  var KEY_MODEL = 'rts.model';
  var KEY_COLLAPSED = 'rts.collapsed';
  var KEY_INDEX = 'rts.cacheIndex';
  var KEY_FEED_ON = 'rts.feedOn';
  var KEY_FEED_MODEL = 'rts.feedModel';
  var KEY_FEED_INDEX = 'rts.feedIndex';
  var KEY_DIGEST_ON = 'rts.digestOn';
  var KEY_MULTI_DIGEST_ON = 'rts.multiDigestOn';
  var KEY_DIGEST_COLLAPSED = 'rts.digestCollapsed';
  var KEY_DIGEST_INDEX = 'rts.digestIndex';
  var KEY_NO_INFINITE = 'rts.noInfinite';
  var FEED_MIN_COMMENTS = 5;
  var MIN_DISCUSSION_COMMENTS = 2;
  var SUMMARY_TIMEOUT_MS = 180000;
  var REQUEST_TIMEOUT_MS = 30000;
  var OVERLOAD_RETRY_MS = 2000;
  var OVERLOAD_COOLDOWN_MS = 10 * 60 * 1000;
  var KEY_BUSY_UNTIL = 'rts.modelBusyUntil';
  var FEED_JSON_CONCURRENCY = 2;
  var FEED_GEMINI_GAP_MS = 6000;
  var FEED_DWELL_MS = 1000;
  var MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,80}$/;
  var HOSTS = {
    'www.reddit.com': true,
    'old.reddit.com': true,
    'new.reddit.com': true,
    'sh.reddit.com': true,
    'm.reddit.com': true
  };

  // How much of the thread we send. Roots are reserved first so a deep reply
  // chain under the top comment cannot push the other high-score comments out.
  var LIMITS = {
    selftextChars: 3000,
    commentChars: 480,
    totalChars: 12000,
    maxComments: 40,
    maxDepth: 4,
    rootComments: 12,
    repliesPerNode: 3
  };

  var SYSTEM_PROMPT = [
    'You write Reddit thread summaries in the style of r/ClaudeAI\'s mod-bot "TL;DR of the discussion" comments.',
    '',
    'Tone: casual and readable. Humor is fine. Never insult the poster or the commenters, never mock anyone, and never be cruel.',
    '',
    'Accuracy:',
    '- Use only the thread below. Do not invent facts, numbers, quotes, tools, or usernames.',
    '- Cite people only as `u/username` (backticks) and only when that exact name is in Allowed usernames. If you are unsure, name nobody.',
    '- Consensus is what the higher-scoring comments support, not a single low-score reply and not your own opinion. Scores are a signal. Do not recite them unless a number itself is the point.',
    '- Weight themes toward substance (advice, real disagreement, concrete recommendations, warnings) over jokes, memes, and chatter. A joke thread can still be summarized, briefly, as a joke thread.',
    '',
    'Output:',
    '- Markdown only. No code fence. No preamble. No HTML.',
    '- Do not write a "TL;DR of the discussion" header. The page adds that, with the real comment count.',
    '- Bold with **double asterisks**. Put cited usernames in inline code: `u/name`.',
    '- When you mention a URL, use a markdown link: [label](https://...).',
    '',
    'When smallThread is false (15 or more comments), use this shape:',
    '1. One paragraph. Start with a one-line intro of what the thread is about. Then **one bold sentence stating the overall consensus**. Then one more sentence of context. The bold consensus stays inside that paragraph, not as a bullet.',
    '2. A line on its own: Here are the key themes from the thread:',
    '3. Three to five bullets. Each starts with **Theme name:** then 1-3 sentences. Bold the specific things people mentioned. Cite the real `u/username` who said them.',
    '4. A required section AFTER the themes and BEFORE the closing paragraph. Never omit it, including on joke threads, news reactions, and other light threads. Heading line, exactly: **Actionable takeaways**',
    '   One to five bullets. At least one. Do not pad the list out to five.',
    '   Prefer a concrete tip, fix, setting, tool, product, link, step that worked, or warning, and credit a real `u/username` when one person is the source.',
    '   On a humorous or light thread, a takeaway can instead be the insight, the best joke, or the general vibe. A funny line is welcome. Do not invent practical advice that nobody gave.',
    '5. A short closing paragraph on other notable points and the long tail. If nothing else matters, one short sentence. Do not invent a long tail and do not repeat the consensus word for word.',
    '',
    'When smallThread is true (under 15 comments):',
    '- The consensus paragraph, then at most 2 theme bullets. No "Here are the key themes" line and no closing paragraph.',
    '- Then always the **Actionable takeaways** section, with 1 or 2 bullets. Never omit it. Same rules as above: concrete advice when the thread has it; otherwise the insight, the best joke, or the vibe.',
    '- If nobody has replied, the paragraph summarizes the post, and the takeaway is what a reader should walk away with from the post itself. Still do not invent agreement or usernames.',
  ].join('\n');

  var STYLES = [
    '#rts-panel {',
    '  --rts-bg: #f7f9fc;',
    '  --rts-fg: #1a1a1b;',
    '  --rts-muted: #5c6c74;',
    '  --rts-border: #d7dee7;',
    '  --rts-accent: #3d5afe;',
    '  --rts-chip: #e7ecf7;',
    '  --rts-danger: #9d1c1c;',
    '  --rts-link: #0b63ce;',
    '  display: block !important;',
    '  clear: both;',
    '  box-sizing: border-box;',
    '  width: auto;',
    '  max-width: 100%;',
    '  min-width: 0;',
    '  margin: 10px 8px 12px;',
    '  padding: 10px 12px 12px;',
    '  background: var(--rts-bg);',
    '  color: var(--rts-fg);',
    '  border: 1px solid var(--rts-border);',
    '  border-left: 4px solid var(--rts-accent);',
    '  border-radius: 12px;',
    '  font-family: inherit;',
    '  font-size: 15px;',
    '  line-height: 1.45;',
    '  overflow-wrap: anywhere;',
    '  word-break: break-word;',
    '  position: relative;',
    '  z-index: 0;',
    '}',
    '#rts-panel[data-theme="dark"] {',
    '  --rts-bg: #1a1d23;',
    '  --rts-fg: #e6e8ea;',
    '  --rts-muted: #9aa3ab;',
    '  --rts-border: #343a42;',
    '  --rts-accent: #9db0ff;',
    '  --rts-chip: #262b33;',
    '  --rts-danger: #ff9b93;',
    '  --rts-link: #8ecbff;',
    '}',
    '#rts-panel * { box-sizing: border-box; }',
    '#rts-panel .rts-top {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 8px;',
    '  flex-wrap: wrap;',
    '}',
    '#rts-panel .rts-badge {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  height: 22px;',
    '  padding: 0 8px;',
    '  border-radius: 999px;',
    '  background: var(--rts-chip);',
    '  color: var(--rts-accent);',
    '  font-size: 11px;',
    '  font-weight: 700;',
    '  letter-spacing: 0.04em;',
    '  text-transform: uppercase;',
    '  flex: 0 0 auto;',
    '}',
    '#rts-panel .rts-note {',
    '  flex: 1 1 120px;',
    '  color: var(--rts-muted);',
    '  font-size: 12px;',
    '  line-height: 1.3;',
    '}',
    '#rts-panel .rts-iconbtn {',
    '  appearance: none;',
    '  border: 0;',
    '  background: transparent;',
    '  color: var(--rts-fg);',
    '  width: 44px;',
    '  height: 44px;',
    '  margin: -6px 0;',
    '  border-radius: 10px;',
    '  font: inherit;',
    '  font-size: 18px;',
    '  line-height: 1;',
    '  flex: 0 0 auto;',
    '  cursor: pointer;',
    '}',
    '#rts-panel .rts-iconbtn:active { background: var(--rts-chip); }',
    '#rts-panel button:focus-visible {',
    '  outline: 2px solid var(--rts-accent);',
    '  outline-offset: 2px;',
    '}',
    '#rts-panel .rts-title {',
    '  margin: 2px 0 10px;',
    '  font-size: 17px !important;',
    '  line-height: 1.35 !important;',
    '  font-weight: 700 !important;',
    '  cursor: pointer;',
    '}',
    '#rts-panel[data-collapsed="true"] .rts-body { display: none !important; }',
    '#rts-panel .rts-hidden { display: none !important; }',
    '#rts-panel .rts-status { margin: 0 0 8px; color: var(--rts-muted); }',
    '#rts-panel .rts-bar {',
    '  height: 3px;',
    '  margin: 0 0 10px;',
    '  border-radius: 99px;',
    '  background: linear-gradient(90deg, transparent, var(--rts-accent), transparent);',
    '  background-size: 200% 100%;',
    '  animation: rts-slide 1.1s ease-in-out infinite;',
    '}',
    '@keyframes rts-slide {',
    '  0% { background-position: 100% 0; }',
    '  100% { background-position: -100% 0; }',
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    '  #rts-panel .rts-bar { animation: none; }',
    '}',
    '#rts-panel .rts-summary { user-select: text; -webkit-user-select: text; }',
    '#rts-panel .rts-summary p { margin: 0 0 12px; font-size: 15px; }',
    '#rts-panel .rts-kicker { font-weight: 600; margin-top: 4px; }',
    '#rts-panel .rts-summary h3 {',
    '  margin: 14px 0 8px;',
    '  font-size: 15px !important;',
    '  line-height: 1.3 !important;',
    '  font-weight: 700 !important;',
    '}',
    '#rts-panel .rts-summary ul { margin: 0 0 12px; padding-left: 1.15em; }',
    '#rts-panel .rts-summary li { margin: 0 0 8px; font-size: 15px; }',
    '#rts-panel .rts-summary li:last-child { margin-bottom: 0; }',
    '#rts-panel .rts-summary strong { font-weight: 700; }',
    '#rts-panel code {',
    '  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
    '  font-size: 0.92em;',
    '  background: var(--rts-chip);',
    '  padding: 0 4px;',
    '  border-radius: 4px;',
    '  overflow-wrap: anywhere;',
    '}',
    '#rts-panel a { color: var(--rts-link); text-underline-offset: 2px; }',
    '#rts-panel .rts-error { margin: 0 0 8px; color: var(--rts-danger); }',
    '#rts-panel .rts-action {',
    '  appearance: none;',
    '  background: transparent;',
    '  color: var(--rts-link);',
    '  border: 1px solid var(--rts-border);',
    '  border-radius: 999px;',
    '  padding: 8px 14px;',
    '  min-height: 44px;',
    '  font: inherit;',
    '  font-weight: 600;',
    '  cursor: pointer;',
    '}',
    '.rts-feed {',
    '  --rts-bg: #f7f9fc; --rts-fg: #1a1a1b; --rts-muted: #5c6c74;',
    '  --rts-border: #d7dee7; --rts-accent: #3d5afe; --rts-chip: #e7ecf7; --rts-link: #0b63ce;',
    '  display: block !important; clear: both; box-sizing: border-box;',
    '  width: auto; max-width: 100%; min-width: 0;',
    '  margin: 0 8px 12px; padding: 8px 10px;',
    '  background: var(--rts-bg); color: var(--rts-fg);',
    '  border: 1px solid var(--rts-border); border-left: 4px solid var(--rts-accent);',
    '  border-radius: 10px; font-family: inherit; font-size: 14px; line-height: 1.4;',
    '  overflow-wrap: anywhere; position: relative; z-index: 1;',
    '}',
    '.rts-feed[data-theme="dark"] {',
    '  --rts-bg: #1a1d23; --rts-fg: #e6e8ea; --rts-muted: #9aa3ab;',
    '  --rts-border: #343a42; --rts-accent: #9db0ff; --rts-chip: #262b33; --rts-link: #8ecbff;',
    '}',
    '.rts-feed * { box-sizing: border-box; }',
    '.rts-feed .rts-feed-toggle {',
    '  appearance: none; border: 0; background: transparent; color: inherit;',
    '  display: flex; align-items: center; gap: 8px; width: 100%;',
    '  min-height: 36px; padding: 0; font: inherit; font-weight: 700; cursor: pointer; text-align: left;',
    '}',
    '.rts-feed .rts-feed-label {',
    '  display: inline-flex; align-items: center; height: 20px; padding: 0 7px;',
    '  border-radius: 999px; background: var(--rts-chip); color: var(--rts-accent);',
    '  font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase;',
    '}',
    '.rts-feed .rts-feed-chev { margin-left: auto; font-size: 16px; }',
    '.rts-feed[data-collapsed="true"] .rts-feed-body { display: none !important; }',
    '.rts-feed .rts-feed-body { margin-top: 4px; }',
    '.rts-feed .rts-feed-body p { margin: 0 0 8px; font-size: 14px; }',
    '.rts-feed .rts-feed-body ul { margin: 0; padding-left: 1.1em; }',
    '.rts-feed .rts-feed-body li { margin: 0 0 4px; font-size: 14px; }',
    '.rts-feed .rts-feed-status, .rts-feed .rts-feed-error { margin: 0; color: var(--rts-muted); font-size: 13px; }',
    '.rts-feed .rts-feed-error { color: #9d1c1c; }',
    '.rts-feed[data-theme="dark"] .rts-feed-error { color: #ff9b93; }',
    '.rts-feed code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; background: var(--rts-chip); padding: 0 3px; border-radius: 4px; }',
    '.rts-feed a { color: var(--rts-link); }',
    '.rts-feed button:focus-visible { outline: 2px solid var(--rts-accent); outline-offset: 2px; }',
    'html.rts-no-infinite faceplate-partial[slot="load-after"],',
    'html.rts-no-infinite .rts-feed-sentinel { display: none !important; }',
    '.rts-load-more {',
    '  display: block; box-sizing: border-box; width: calc(100% - 16px); max-width: 100%;',
    '  margin: 12px 8px 24px; min-height: 44px; padding: 10px 16px;',
    '  border: 1px solid #d7dee7; border-radius: 999px; background: #f7f9fc; color: #1a1a1b;',
    '  font: inherit; font-size: 15px; font-weight: 700; cursor: pointer;',
    '}',
    '.rts-load-more:disabled { opacity: 0.7; cursor: default; }',
    'html.theme-dark .rts-load-more, html.dark .rts-load-more, html[theme="dark"] .rts-load-more,',
    'html[data-theme="dark"] .rts-load-more { background: #1a1d23; color: #e6e8ea; border-color: #343a42; }',
    '@media (prefers-color-scheme: dark) {',
    '  .rts-load-more { background: #1a1d23; color: #e6e8ea; border-color: #343a42; }',
    '}',
    '#rts-digest {',
    '  --rts-bg: #f7f9fc; --rts-fg: #1a1a1b; --rts-muted: #5c6c74;',
    '  --rts-border: #d7dee7; --rts-accent: #3d5afe; --rts-chip: #e7ecf7;',
    '  --rts-link: #0b63ce; --rts-danger: #9d1c1c;',
    '  display: block !important; clear: both; box-sizing: border-box;',
    '  width: auto; max-width: 100%; min-width: 0; margin: 8px 8px 12px; padding: 10px 12px 12px;',
    '  background: var(--rts-bg); color: var(--rts-fg);',
    '  border: 1px solid var(--rts-border); border-left: 4px solid var(--rts-accent);',
    '  border-radius: 12px; font-family: inherit; font-size: 15px; line-height: 1.45;',
    '  overflow-wrap: anywhere; position: relative; z-index: 1;',
    '}',
    '#rts-digest[data-theme="dark"] {',
    '  --rts-bg: #1a1d23; --rts-fg: #e6e8ea; --rts-muted: #9aa3ab;',
    '  --rts-border: #343a42; --rts-accent: #9db0ff; --rts-chip: #262b33;',
    '  --rts-link: #8ecbff; --rts-danger: #ff9b93;',
    '}',
    '#rts-digest * { box-sizing: border-box; }',
    '#rts-digest .rts-head {',
    '  display: flex !important; flex-wrap: nowrap !important; align-items: center; gap: 4px;',
    '}',
    '#rts-digest .rts-head-text { flex: 1 1 auto; min-width: 0; }',
    '#rts-digest .rts-badge {',
    '  display: inline-flex; align-items: center; height: 22px; padding: 0 8px;',
    '  border-radius: 999px; background: var(--rts-chip); color: var(--rts-accent);',
    '  font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;',
    '}',
    '#rts-digest .rts-note { display: block; margin: 4px 0 0; color: var(--rts-muted); font-size: 12px; }',
    '#rts-digest .rts-iconbtn {',
    '  appearance: none; border: 0; background: transparent; color: var(--rts-fg);',
    '  flex: 0 0 44px; width: 44px !important; max-width: 44px; height: 44px;',
    '  border-radius: 10px; font: inherit; font-size: 18px; line-height: 44px;',
    '  cursor: pointer; padding: 0;',
    '}',
    '#rts-digest .rts-title { margin: 2px 0 0; font-size: 17px !important; line-height: 1.35 !important; font-weight: 700 !important; cursor: pointer; }',
    '#rts-digest[data-collapsed="true"] .rts-body { display: none !important; }',
    '#rts-digest .rts-hidden { display: none !important; }',
    '#rts-digest .rts-status { margin: 0 0 8px; color: var(--rts-muted); }',
    '#rts-digest .rts-summary p { margin: 0 0 12px; font-size: 15px; }',
    '#rts-digest .rts-summary h3 { margin: 14px 0 8px; font-size: 15px !important; font-weight: 700 !important; }',
    '#rts-digest .rts-summary ul { margin: 0 0 12px; padding-left: 1.15em; }',
    '#rts-digest .rts-summary li { margin: 0 0 8px; font-size: 15px; }',
    '#rts-digest code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; background: var(--rts-chip); padding: 0 4px; border-radius: 4px; }',
    '#rts-digest a { color: var(--rts-link); }',
    '#rts-digest .rts-error { margin: 0 0 8px; color: var(--rts-danger); }'
  ].join('\n');

  var panelEl = null;
  var runToken = 0;
  var liveRequests = [];
  var syncTimer = 0;
  var booted = false;
  var watchUrl = '';
  var watchStart = 0;

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue !== 'function') return fallback;
      var value = GM_getValue(key, fallback);
      return value == null ? fallback : value;
    } catch (err) {
      return fallback;
    }
  }

  function gmSet(key, value) {
    if (typeof GM_setValue === 'function') GM_setValue(key, value);
  }

  function gmDelete(key) {
    if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
  }

  function getKey() {
    var value = gmGet(KEY_API, '');
    return typeof value === 'string' ? value.trim() : '';
  }

  function getModel() {
    var value = gmGet(KEY_MODEL, DEFAULT_MODEL);
    if (typeof value !== 'string') return DEFAULT_MODEL;
    value = value.trim();
    return MODEL_RE.test(value) ? value : DEFAULT_MODEL;
  }

  function collapsedPref() {
    return gmGet(KEY_COLLAPSED, false) === true;
  }

  function storageList(key) {
    var value = gmGet(key, []);
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (err) { value = []; }
    }
    return Array.isArray(value) ? value : [];
  }

  function cacheStorageKey(postId, model) {
    return 'rts.cache.' + model + '.' + postId;
  }

  function readCache(postId, model) {
    var key = cacheStorageKey(postId, model);
    var rec = gmGet(key, null);
    if (typeof rec === 'string') {
      try { rec = JSON.parse(rec); } catch (err) { rec = null; }
    }
    if (!rec || typeof rec !== 'object' || !rec.markdown || !rec.cachedAt) return null;
    if (Date.now() - rec.cachedAt > CACHE_TTL_MS) {
      gmDelete(key);
      return null;
    }
    return rec;
  }

  function writeCache(postId, model, rec) {
    var key = cacheStorageKey(postId, model);
    gmSet(key, rec);
    var list = storageList(KEY_INDEX).filter(function (item) {
      return item && item.key !== key;
    });
    list.push({ key: key, at: rec.cachedAt });
    var now = Date.now();
    var fresh = list.filter(function (item) {
      return item && now - item.at <= CACHE_TTL_MS;
    });
    fresh.sort(function (a, b) { return b.at - a.at; });
    var kept = fresh.slice(0, CACHE_MAX);
    var drop = fresh.slice(CACHE_MAX).concat(list.filter(function (item) {
      return item && now - item.at > CACHE_TTL_MS;
    }));
    drop.forEach(function (item) {
      if (item.key !== key) gmDelete(item.key);
    });
    gmSet(KEY_INDEX, kept);
  }

  function clearCache() {
    storageList(KEY_INDEX).forEach(function (item) {
      if (item && item.key) gmDelete(item.key);
    });
    storageList(KEY_FEED_INDEX).forEach(function (item) {
      if (item && item.key) gmDelete(item.key);
    });
    storageList(KEY_DIGEST_INDEX).forEach(function (item) {
      if (item && item.key) gmDelete(item.key);
    });
    gmSet(KEY_INDEX, []);
    gmSet(KEY_FEED_INDEX, []);
    gmSet(KEY_DIGEST_INDEX, []);
  }

  function feedEnabled() {
    var value = gmGet(KEY_FEED_ON, true);
    return value !== false && value !== 'false';
  }

  function getFeedModel() {
    var value = gmGet(KEY_FEED_MODEL, FALLBACK_MODEL);
    if (typeof value !== 'string') return FALLBACK_MODEL;
    value = value.trim();
    return MODEL_RE.test(value) ? value : FALLBACK_MODEL;
  }

  function feedCacheKey(postId) {
    return 'rts.feed.' + postId;
  }

  function readStored(key) {
    var rec = gmGet(key, null);
    if (typeof rec === 'string') {
      try { rec = JSON.parse(rec); } catch (err) { rec = null; }
    }
    return rec && typeof rec === 'object' ? rec : null;
  }

  function readFeedCache(postId) {
    var key = feedCacheKey(postId);
    var rec = readStored(key);
    if (!rec || !rec.cachedAt) return null;
    if (Date.now() - rec.cachedAt > CACHE_TTL_MS) {
      gmDelete(key);
      return null;
    }
    if (rec.skip) return rec;
    if (!rec.markdown) return null;
    return rec;
  }

  function writeFeedCache(postId, rec) {
    var key = feedCacheKey(postId);
    gmSet(key, rec);
    var list = storageList(KEY_FEED_INDEX).filter(function (item) {
      return item && item.key !== key;
    });
    list.push({ key: key, at: rec.cachedAt });
    var now = Date.now();
    var fresh = list.filter(function (item) {
      return item && now - item.at <= CACHE_TTL_MS;
    });
    fresh.sort(function (a, b) { return b.at - a.at; });
    var kept = fresh.slice(0, CACHE_MAX);
    fresh.slice(CACHE_MAX).concat(list.filter(function (item) {
      return item && now - item.at > CACHE_TTL_MS;
    })).forEach(function (item) {
      if (item.key !== key) gmDelete(item.key);
    });
    gmSet(KEY_FEED_INDEX, kept);
  }

  function threadIdFromUrl(href) {
    try {
      var url = new URL(href);
      if (!HOSTS[url.hostname]) return '';
      var match = url.pathname.match(/\/r\/[^/]+\/comments\/([a-z0-9]+)/i);
      return match ? match[1].toLowerCase() : '';
    } catch (err) {
      return '';
    }
  }

  function isThreadUrl(href) {
    return !!threadIdFromUrl(href);
  }

  function threadJsonUrls(href) {
    var id = threadIdFromUrl(href);
    if (!id) return [];
    var sub = 'all';
    var pageHost = '';
    try {
      var url = new URL(href);
      pageHost = url.hostname;
      var match = url.pathname.match(/\/r\/([^/]+)\/comments\//i);
      if (match) sub = match[1];
    } catch (err) { /* keep defaults */ }
    var path = '/r/' + encodeURIComponent(sub) + '/comments/' + encodeURIComponent(id) +
      '.json?raw_json=1&limit=100&depth=6&sort=top';
    var hosts = [];
    if (HOSTS[pageHost]) hosts.push(pageHost);
    ['www.reddit.com', 'old.reddit.com'].forEach(function (host) {
      if (hosts.indexOf(host) === -1) hosts.push(host);
    });
    return hosts.map(function (host) { return 'https://' + host + path; });
  }

  function decodeEntities(text) {
    return String(text || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function oneLine(text, max) {
    var value = decodeEntities(text).replace(/\s+/g, ' ').trim();
    if (value.length > max) value = value.slice(0, max - 1).trim() + '…';
    return value;
  }

  function cleanBlock(text, max) {
    var value = decodeEntities(text)
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (value.length > max) value = value.slice(0, max - 1).trim() + '…';
    return value;
  }

  function addAuthor(state, name) {
    if (!name || name === '[deleted]' || name === 'AutoModerator') return;
    var key = String(name).toLowerCase();
    if (state.seen[key]) return;
    state.seen[key] = true;
    state.authors.push(String(name));
  }

  function replyChildren(data) {
    if (!data || !data.replies || typeof data.replies !== 'object') return [];
    if (!data.replies.data || !Array.isArray(data.replies.data.children)) return [];
    return data.replies.data.children;
  }

  function selectableComments(children) {
    var rows = [];
    (children || []).forEach(function (child) {
      if (!child || child.kind !== 't1' || !child.data) return;
      var data = child.data;
      var body = oneLine(data.body || '', LIMITS.commentChars);
      if (!body || body === '[removed]' || body === '[deleted]') return;
      if (!data.author || data.author === '[deleted]' || data.author === 'AutoModerator') return;
      rows.push(data);
    });
    rows.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    return rows;
  }

  function postTypeOf(data) {
    if (data.poll_data) return 'poll';
    if (data.is_self) return 'text';
    if (data.is_gallery) return 'gallery';
    if (data.is_video || data.post_hint === 'hosted:video' || data.post_hint === 'rich:video') return 'video';
    if (data.post_hint === 'image') return 'image';
    return 'link';
  }

  function parseThread(payload) {
    if (!Array.isArray(payload) || !payload[0] || !payload[0].data ||
        !payload[0].data.children || !payload[0].data.children[0] ||
        payload[0].data.children[0].kind !== 't3' || !payload[0].data.children[0].data) {
      var shape = new Error('Reddit didn\'t return this thread.');
      shape.type = 'reddit';
      throw shape;
    }
    var post = payload[0].data.children[0].data;
    var state = { count: 0, chars: 0, authors: [], seen: Object.create(null) };
    addAuthor(state, post.author);

    var roots = selectableComments(payload[1] && payload[1].data ? payload[1].data.children : [])
      .slice(0, LIMITS.rootComments);
    var picked = [];
    roots.forEach(function (data) {
      if (state.count >= LIMITS.maxComments || state.chars >= LIMITS.totalChars) return;
      var body = oneLine(data.body || '', LIMITS.commentChars);
      if (!body) return;
      if (picked.length && state.chars + body.length > LIMITS.totalChars) return;
      state.count += 1;
      state.chars += body.length;
      addAuthor(state, data.author);
      picked.push({ data: data, body: body, replies: [] });
    });

    function fill(nodes, depth) {
      if (depth >= LIMITS.maxDepth || !nodes.length) return;
      var next = [];
      for (var i = 0; i < nodes.length; i++) {
        var kids = selectableComments(replyChildren(nodes[i].data)).slice(0, LIMITS.repliesPerNode);
        for (var j = 0; j < kids.length; j++) {
          if (state.count >= LIMITS.maxComments || state.chars >= LIMITS.totalChars) return;
          var body = oneLine(kids[j].body || '', LIMITS.commentChars);
          if (!body || state.chars + body.length > LIMITS.totalChars) continue;
          state.count += 1;
          state.chars += body.length;
          addAuthor(state, kids[j].author);
          var child = { data: kids[j], body: body, replies: [] };
          nodes[i].replies.push(child);
          next.push(child);
        }
      }
      fill(next, depth + 1);
    }
    fill(picked, 1);

    function flatten(nodes, depth, lines) {
      nodes.forEach(function (node) {
        var indent = new Array(depth + 1).join('  ');
        lines.push(indent + '(' + (node.data.score || 0) + ') u/' + node.data.author + ': ' + node.body);
        flatten(node.replies, depth + 1, lines);
      });
    }
    var lines = [];
    flatten(picked, 0, lines);

    var selftext = post.selftext || '';
    var crosspostData = Array.isArray(post.crosspost_parent_list) ? post.crosspost_parent_list[0] : null;
    var parentFullname = post.crosspost_parent || (crosspostData && crosspostData.name) || '';
    var parentId = String((crosspostData && crosspostData.id) || parentFullname || '').replace(/^t3_/i, '').toLowerCase();
    var crosspost = parentId ? {
      id: parentId,
      subreddit: (crosspostData && crosspostData.subreddit) || '',
      permalink: (crosspostData && crosspostData.permalink) || ''
    } : null;
    if (crosspostData) {
      selftext += '\n\nCrosspost from r/' + (crosspostData.subreddit || '') + ': ' +
        (crosspostData.title || '') + '\n' + (crosspostData.selftext || '');
    }
    var poll = '';
    if (post.poll_data && Array.isArray(post.poll_data.options)) {
      poll = post.poll_data.options.map(function (opt) {
        return (opt.text || '') + ' (' + (opt.vote_count || 0) + ' votes)';
      }).join('; ');
    }
    var reported = Number(post.num_comments);
    var commentCount = Math.max(
      Number.isFinite(reported) ? Math.max(0, Math.round(reported)) : 0,
      state.count
    );

    return {
      title: oneLine(post.title || '', 300) || '(untitled)',
      author: post.author || '[deleted]',
      subreddit: post.subreddit || '',
      score: post.score || 0,
      commentCount: commentCount,
      postType: postTypeOf(post),
      linkUrl: post.is_self ? '' : (post.url || ''),
      flair: post.link_flair_text ? oneLine(post.link_flair_text, 80) : '',
      poll: poll,
      selftext: cleanBlock(selftext, LIMITS.selftextChars),
      commentsText: lines.join('\n'),
      authors: state.authors,
      crosspost: crosspost,
      sourceNote: ''
    };
  }

  function discussionIsThin(thread) {
    return !thread || (thread.commentCount || 0) < MIN_DISCUSSION_COMMENTS;
  }

  function emptyDiscussionText(thread) {
    if (thread && thread.sourceNote) {
      return 'No comments to summarize yet. ' +
        thread.sourceNote.charAt(0).toUpperCase() + thread.sourceNote.slice(1) + '.';
    }
    return 'No comments to summarize yet.';
  }

  function crosspostJsonUrls(crosspost) {
    if (!crosspost) return [];
    if (crosspost.permalink) {
      var absolute = crosspost.permalink;
      if (absolute.indexOf('http') !== 0) {
        absolute = 'https://www.reddit.com' + (absolute.charAt(0) === '/' ? absolute : '/' + absolute);
      }
      var fromPermalink = threadJsonUrls(absolute);
      if (fromPermalink.length) return fromPermalink;
    }
    if (!crosspost.id) return [];
    var query = '.json?raw_json=1&limit=100&depth=6&sort=top';
    var id = encodeURIComponent(crosspost.id);
    return [
      'https://www.reddit.com/comments/' + id + query,
      'https://old.reddit.com/comments/' + id + query
    ];
  }

  function buildPrompt(thread) {
    var small = thread.commentCount < SMALL_THREAD_COMMENTS;
    var lines = [
      'smallThread: ' + (small ? 'true' : 'false'),
      'commentCount: ' + thread.commentCount,
      'subreddit: r/' + (thread.subreddit || ''),
      'title: ' + thread.title,
      'author: u/' + thread.author + ' (this is the OP)',
      'score: ' + thread.score,
      'postType: ' + thread.postType
    ];
    if (thread.sourceNote) lines.push('note: ' + thread.sourceNote);
    if (thread.linkUrl) lines.push('link: ' + thread.linkUrl);
    if (thread.flair) lines.push('flair: ' + thread.flair);
    if (thread.poll) lines.push('poll: ' + thread.poll);
    lines.push('', 'Post body:', thread.selftext || '(no body)', '');
    lines.push('Allowed usernames: ' + (thread.authors.length
      ? thread.authors.map(function (name) { return 'u/' + name; }).join(', ')
      : '(none)'));
    lines.push('', 'Comments, higher score first. Replies are indented. The number in parentheses is the score.',
      thread.commentsText || '(no comments)');
    return lines.join('\n');
  }

  // Gemini 4 and 3.8 Flash have no "minimal" thinking level. Low (or medium
  // on Carbon) keeps a phone summary from waiting on a high/xhigh think.
  // Flash-Lite defaults to minimal, which is the fastest setting it has.
  function thinkingConfigFor(model) {
    var name = String(model || '').toLowerCase();
    if (/gemini-2(\.|$)/.test(name) || name.indexOf('2.5') !== -1) {
      return { thinkingBudget: 0 };
    }
    if (name.indexOf('gemini-4-carbon') !== -1) return { thinkingLevel: 'medium' };
    if (name.indexOf('gemini-4') !== -1 || name.indexOf('gemini-3.8') !== -1) {
      return { thinkingLevel: 'low' };
    }
    return { thinkingLevel: 'minimal' };
  }

  function geminiRequestBody(thread, model, useSystem, useThinking, systemText, userOverride) {
    var system = systemText || SYSTEM_PROMPT;
    var userText = userOverride || buildPrompt(thread);
    if (!useSystem) userText = system + '\n\n----\n\n' + userText;
    var generationConfig = { maxOutputTokens: 8192 };
    if (useThinking) generationConfig.thinkingConfig = thinkingConfigFor(model);
    var body = {
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: generationConfig
    };
    if (useSystem) {
      body.systemInstruction = { parts: [{ text: system }] };
    }
    return body;
  }

  function clip(text, max) {
    var value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length <= max) return value;
    return value.slice(0, max - 1) + '…';
  }

  function isOverloaded(status, statusName, message) {
    if (status === 500 || status === 503) return true;
    if (String(statusName || '').toUpperCase() === 'UNAVAILABLE') return true;
    return /overloaded|high demand/i.test(message || '');
  }

  function isExhausted(status, statusName, message) {
    return status === 429 || statusName === 'RESOURCE_EXHAUSTED' ||
      /RESOURCE_EXHAUSTED|resource exhausted|quota exceeded|rate limit/i.test(message);
  }

  function isFreeTierBlock(message) {
    return /not available on (the )?free tier|unavailable on (the )?free tier|only available[\s\S]{0,80}paid|paid (api )?tier only|requires? (a )?paid/i.test(message);
  }

  function fallbackCopy(model, paidBlock) {
    if (model === 'gemini-4-hydrogen') {
      return 'gemini-4-hydrogen is out of free-tier requests (about 20 a day). Switch to gemini-3.5-flash-lite (about 500 a day), or wait until the quota resets.';
    }
    if (model === 'gemini-4-neon' || model === 'gemini-4-carbon') {
      if (paidBlock) {
        return model + ' is not on the free tier. It needs a paid Gemini API plan. Switch to gemini-3.5-flash-lite, or enable billing in Google AI Studio.';
      }
      return model + ' hit a rate limit. Switch to gemini-3.5-flash-lite (free, about 500 a day), or check the plan in Google AI Studio.';
    }
    if (paidBlock) {
      return model + ' is not available on the free tier. Switch to gemini-3.5-flash-lite (about 500 requests a day), or use a paid API plan.';
    }
    return model + ' is out of requests. Switch to gemini-3.5-flash-lite (free, about 500 a day), or wait and try again.';
  }

  function classifyGeminiError(status, bodyText, model) {
    var parsed = {};
    try { parsed = JSON.parse(bodyText || '{}'); } catch (err) { parsed = {}; }
    var error = parsed.error || {};
    var message = String(error.message || bodyText || '');
    var statusName = String(error.status || '');
    var used = model || '';
    if (isOverloaded(status, statusName, message)) {
      return {
        type: 'overloaded',
        overloaded: true,
        message: (used || 'Gemini') + ' is busy right now (' + clip(message, 140) + ').'
      };
    }
    var exhausted = isExhausted(status, statusName, message);
    var paidBlock = isFreeTierBlock(message);
    // 3.8 Flash is the default and only has about 20 free requests a day.
    // A 429 on that model is retried automatically on Flash-Lite.
    if (exhausted && used === DEFAULT_MODEL && !paidBlock) {
      return {
        type: 'quota',
        autoRetry: true,
        message: 'gemini-3.8-flash has used its free requests for today (about 20 a day).'
      };
    }
    if (paidBlock || exhausted) {
      if (used && used !== FALLBACK_MODEL) {
        return { type: 'fallback', message: fallbackCopy(used, paidBlock) };
      }
      return {
        type: 'quota',
        message: 'gemini-3.5-flash-lite has used today\'s free requests (about 500 a day). Wait for the quota to reset, then try again.'
      };
    }
    if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|invalid api key|permission denied/i.test(message)) {
      return {
        type: 'key',
        message: 'Gemini rejected this API key. Set a new one from aistudio.google.com/apikey.'
      };
    }
    if (status === 404 || (/model/i.test(message) && /not found|not supported|invalid/i.test(message))) {
      return {
        type: 'model',
        message: 'Gemini doesn\'t recognize this model. Change it in the userscript menu. The default fast model is ' + DEFAULT_MODEL + '.'
      };
    }
    if (status === 400 && /thinking/i.test(message)) {
      return { type: 'thinking', message: message };
    }
    if (status === 400 && /system/i.test(message)) {
      return { type: 'system', message: message };
    }
    return {
      type: 'gemini',
      message: 'Gemini returned an error' + (status ? ' (' + status + ')' : '') + '. ' + clip(message, 180)
    };
  }

  function extractGeminiText(data) {
    if (!data || typeof data !== 'object') {
      return { error: { type: 'empty', message: 'Gemini returned an empty summary.' } };
    }
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      return {
        error: {
          type: 'safety',
          message: 'Gemini\'s safety filter blocked this summary (' + data.promptFeedback.blockReason + ').'
        }
      };
    }
    var candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
    if (!candidate) return { error: { type: 'empty', message: 'Gemini returned no summary.' } };
    var parts = candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    var bits = [];
    parts.forEach(function (part) {
      if (part && part.text && !part.thought) bits.push(part.text);
    });
    var text = bits.join('\n').trim();
    if (!text) {
      var reason = candidate.finishReason ? ' (' + candidate.finishReason + ')' : '';
      return { error: { type: 'empty', message: 'Gemini returned an empty summary' + reason + '.' } };
    }
    return { text: text };
  }

  function stripModelChrome(markdown) {
    var text = String(markdown || '').replace(/\r\n/g, '\n').trim();
    if (text.indexOf('```') === 0) {
      text = text.replace(/^```[a-zA-Z]*\s*/i, '').replace(/\s*```$/, '').trim();
    }
    text = text.replace(/^(?:\*\*)?TL;DR of the discussion[^\n]*(?:\*\*)?\s*\n*/i, '');
    return text.trim();
  }

  function scrubUnknownUsers(markdown, authors) {
    var allowed = Object.create(null);
    (authors || []).forEach(function (name) {
      allowed[String(name).toLowerCase()] = true;
    });
    return String(markdown || '').replace(
      /(^|[\s([\*_])`?u\/([A-Za-z0-9_-]{3,30})`?/g,
      function (full, prefix, name) {
        if (allowed[name.toLowerCase()]) return full;
        return prefix + 'a commenter';
      }
    );
  }

  function isBulletLine(text) {
    return /^[\*\-]\s+/.test(text) || /^\d+\.\s+/.test(text);
  }

  // Small threads stay short, but the takeaways section is never removed.
  // Theme bullets cap at 2. Takeaway bullets cap at 2. Closing prose is dropped.
  function limitSmallThread(markdown) {
    var section = 'intro';
    var themeBullets = 0;
    var actionBullets = 0;
    var kept = [];
    String(markdown || '').split('\n').forEach(function (line) {
      var trimmed = line.trim();
      if (/^here are the key themes from the thread:?$/i.test(trimmed)) return;
      if (/^\*\*Actionable takeaways\*\*$/i.test(trimmed)) {
        section = 'actions';
        kept.push(line);
        return;
      }
      var bullet = isBulletLine(trimmed);
      if (bullet && section !== 'actions') {
        themeBullets += 1;
        if (themeBullets <= 2) kept.push(line);
        return;
      }
      if (bullet && section === 'actions') {
        actionBullets += 1;
        if (actionBullets <= 2) kept.push(line);
        return;
      }
      if (section === 'actions') return;
      kept.push(line);
    });
    return kept.join('\n');
  }

  function limitLargeThread(markdown) {
    var section = 'intro';
    var themeBullets = 0;
    var actionBullets = 0;
    var kept = [];
    String(markdown || '').split('\n').forEach(function (line) {
      var trimmed = line.trim();
      if (/^here are the key themes from the thread:?$/i.test(trimmed)) {
        section = 'themes';
        kept.push(line);
        return;
      }
      if (/^\*\*Actionable takeaways\*\*$/i.test(trimmed)) {
        section = 'actions';
        kept.push(line);
        return;
      }
      var bullet = isBulletLine(trimmed);
      if (bullet && section === 'intro') section = 'themes';
      if (bullet && section === 'themes') {
        themeBullets += 1;
        if (themeBullets > 5) return;
      } else if (bullet && section === 'actions') {
        actionBullets += 1;
        if (actionBullets > 5) return;
      } else if (section === 'actions' && trimmed && !bullet) {
        section = 'close';
      }
      kept.push(line);
    });
    return kept.join('\n');
  }

  function dropEmptyActionable(markdown) {
    var lines = String(markdown || '').split('\n');
    var kept = [];
    for (var i = 0; i < lines.length; i++) {
      if (/^\*\*Actionable takeaways\*\*$/i.test(lines[i].trim())) {
        var j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j += 1;
        if (!isBulletLine((lines[j] || '').trim())) continue;
      }
      kept.push(lines[i]);
    }
    return kept.join('\n');
  }

  function prepareSummary(raw, thread) {
    var markdown = scrubUnknownUsers(stripModelChrome(raw), thread.authors || []);
    if ((thread.commentCount || 0) < SMALL_THREAD_COMMENTS) markdown = limitSmallThread(markdown);
    else markdown = limitLargeThread(markdown);
    return dropEmptyActionable(markdown).trim();
  }

  function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function safeHref(url) {
    if (!/^https?:\/\//i.test(url)) return '';
    if (/["'<>\s]|&quot;|&lt;|&gt;|&#39;|javascript:/i.test(url)) return '';
    return url;
  }

  function renderInline(escaped) {
    var pieces = escaped.split(/(`[^`]+`)/g);
    return pieces.map(function (piece, index) {
      if (index % 2 === 1) return '<code>' + piece.slice(1, -1) + '</code>';
      var linked = piece.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (full, label, href) {
        var safe = safeHref(href);
        if (!safe) return full;
        return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
      });
      return linked.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    }).join('');
  }

  function renderMarkdown(markdown) {
    var html = '';
    var listOpen = false;
    var paragraph = [];

    function flushParagraph() {
      if (!paragraph.length) return;
      html += '<p>' + renderInline(escapeHtml(paragraph.join(' '))) + '</p>';
      paragraph = [];
    }
    function closeList() {
      if (!listOpen) return;
      html += '</ul>';
      listOpen = false;
    }

    String(markdown || '').replace(/\r\n/g, '\n').split('\n').forEach(function (raw) {
      var line = raw.trim();
      if (!line) {
        flushParagraph();
        closeList();
        return;
      }
      var bullet = line.match(/^(?:[\*\-]|\d+\.)\s+(.+)$/);
      if (bullet) {
        flushParagraph();
        if (!listOpen) {
          html += '<ul>';
          listOpen = true;
        }
        html += '<li>' + renderInline(escapeHtml(bullet[1])) + '</li>';
        return;
      }
      closeList();
      if (/^here are the key themes from the thread:?$/i.test(line)) {
        flushParagraph();
        html += '<p class="rts-kicker">' + renderInline(escapeHtml(line)) + '</p>';
        return;
      }
      var heading = line.match(/^\*\*([^*]+)\*\*:?$/);
      if (heading) {
        flushParagraph();
        html += '<h3>' + renderInline(escapeHtml(heading[1])) + '</h3>';
        return;
      }
      paragraph.push(line);
    });
    flushParagraph();
    closeList();
    return html;
  }

  function headerText(count) {
    if (typeof count !== 'number' || !isFinite(count) || count < 0) return 'TL;DR of the discussion';
    var rounded = Math.round(count);
    var label;
    try { label = rounded.toLocaleString('en-US'); } catch (err) { label = String(rounded); }
    return 'TL;DR of the discussion (' + label + (rounded === 1 ? ' comment)' : ' comments)');
  }

  function ageLabel(timestamp) {
    var minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
    if (minutes < 1) return 'saved just now';
    if (minutes < 60) return 'saved ' + minutes + 'm ago';
    var hours = Math.round(minutes / 60);
    if (hours < 36) return 'saved ' + hours + 'h ago';
    return 'saved ' + Math.round(hours / 24) + 'd ago';
  }

  function abortLive(includeFeed) {
    var pending = liveRequests;
    var keep = [];
    liveRequests = [];
    pending.forEach(function (handle) {
      if (!includeFeed && handle && handle.feed) {
        keep.push(handle);
        return;
      }
      try { if (handle && handle.abort) handle.abort(); } catch (err) { /* ignore */ }
    });
    liveRequests = keep.concat(liveRequests);
  }

  // Violentmonkey and Tampermonkey on Android often never call ontimeout or
  // onerror when a Gemini POST stalls, and abort() does not reject it either.
  // A deadline owned by this script settles the promise anyway.
  function gmRequest(details) {
    var limit = details.timeout || REQUEST_TIMEOUT_MS;
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        var missing = new Error('This script needs Tampermonkey or Violentmonkey.');
        missing.type = 'network';
        reject(missing);
        return;
      }
      var settled = false;
      var raw = null;
      function finish(ok, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) resolve(value);
        else reject(value);
      }
      function fail(type, message) {
        var err = new Error(message);
        err.type = type;
        err.gemini = !!details.gemini;
        if (details.gemini && (type === 'timeout' || type === 'network')) err.overloaded = true;
        finish(false, err);
      }
      var timer = setTimeout(function () {
        try { if (raw && raw.abort) raw.abort(); } catch (err) { /* ignore */ }
        fail('timeout', 'The request timed out. Try again.');
      }, limit);
      try {
        raw = GM_xmlhttpRequest({
          method: details.method,
          url: details.url,
          headers: details.headers,
          data: details.data,
          timeout: limit,
          anonymous: false,
          onload: function (res) { finish(true, res || {}); },
          onerror: function () { fail('network', 'Couldn\'t reach the network. Check your connection and try again.'); },
          ontimeout: function () { fail('timeout', 'The request timed out. Try again.'); },
          onabort: function () { fail('abort', 'aborted'); }
        });
      } catch (err) {
        fail('network', 'Couldn\'t start the request.');
        return;
      }
      if (raw && raw.abort) {
        liveRequests.push({
          feed: !!details.feed,
          abort: function () {
            try { raw.abort(); } catch (err) { /* ignore */ }
            fail('abort', 'aborted');
          }
        });
      }
    });
  }

  function redditTarget(kind, meta) {
    if (kind === 'digest' && meta && meta.feedName) return "your " + meta.feedName + " feed's post list";
    if (kind === 'digest') return "r/" + ((meta && meta.sub) || 'this subreddit') + "'s post list";
    if (kind === 'feed') return 'this post';
    return 'this thread';
  }

  function threadLooksGated() {
    try {
      if (typeof document === 'undefined' || !isThreadUrl(location.href)) return false;
      var post = document.querySelector('shreddit-post');
      if (post) {
        var flag = String(post.getAttribute('over18') || post.getAttribute('nsfw') || post.getAttribute('over-18') || '').toLowerCase();
        if (flag === 'true' || flag === '1') return true;
      }
      if (document.querySelector('.thing.link.over18, .thing.over18, .quarantine-interstitial')) return true;
    } catch (err) { /* not on a thread page */ }
    return false;
  }

  function redditHttpError(status, kind, meta) {
    kind = kind || 'thread';
    meta = meta || {};
    var target = redditTarget(kind, meta);
    var err = new Error("Couldn't load " + target + ".");
    err.type = 'reddit';
    err.status = status || 0;
    var gated = !!(meta.over18 || meta.over_18 || meta.quarantine);
    if (!gated && kind === 'thread') gated = threadLooksGated();
    if (status === 403) {
      err.message = "Couldn't load " + target + " (HTTP 403).";
      if (gated) {
        err.message += kind === 'thread'
          ? ' This post is marked NSFW or quarantined. Open it while logged in, then try again.'
          : ' This community is marked NSFW or quarantined.';
      }
    } else if (status === 404) {
      err.message = "Couldn't find " + target + ".";
    } else if (status === 429) {
      err.message = "Reddit is rate-limiting " + target + ". Wait a minute, then try again.";
    } else if (status) {
      err.message = "Couldn't load " + target + " (HTTP " + status + ").";
    }
    return err;
  }

  function looksLikeJson(text) {
    var trimmed = String(text || '').trim();
    return trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[';
  }

  function parseJsonBody(res, kind, meta) {
    var text = res && res.responseText ? res.responseText : '';
    if (!looksLikeJson(text)) {
      var page = redditHttpError((res && res.status) || 403, kind, meta);
      if (!res || !res.status || res.status === 200) page.message = "Reddit didn't return JSON for " + redditTarget(kind, meta) + ".";
      throw page;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      var bad = redditHttpError(res && res.status, kind, meta);
      bad.message = "Reddit returned something that wasn't JSON for " + redditTarget(kind, meta) + ".";
      throw bad;
    }
  }

  function pageOrigin() {
    try {
      if (typeof location !== 'undefined' && location.origin && HOSTS[location.hostname]) return location.origin;
    } catch (err) { /* fall through */ }
    return 'https://www.reddit.com';
  }

  function ensureRawJson(search) {
    if (!search) return '?raw_json=1';
    if (/[?&]raw_json=/.test(search)) return search;
    return search + '&raw_json=1';
  }

  function pathFromRedditUrl(absolute) {
    var url = new URL(absolute, 'https://www.reddit.com');
    return url.pathname + ensureRawJson(url.search);
  }

  function pageFetch(url) {
    return new Promise(function (resolve, reject) {
      if (typeof fetch !== 'function') {
        var missing = new Error("Couldn't reach Reddit from the page.");
        missing.type = 'network';
        missing.status = 0;
        reject(missing);
        return;
      }
      var settled = false;
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { if (controller) controller.abort(); } catch (err) { /* ignore */ }
        var timeout = new Error('The request timed out. Try again.');
        timeout.type = 'timeout';
        timeout.status = 0;
        reject(timeout);
      }, REQUEST_TIMEOUT_MS);
      var opts = { credentials: 'include', headers: { 'Accept': 'application/json' } };
      if (controller) opts.signal = controller.signal;
      fetch(url, opts).then(function (res) {
        return res.text().then(function (text) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: res.status, responseText: text });
        });
      }, function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        var failed = new Error("Couldn't reach Reddit from the page.");
        failed.type = 'network';
        failed.status = 0;
        reject(failed);
      });
    });
  }

  function blockedRedditResponse(res) {
    if (!res) return true;
    if (res.status === 401 || res.status === 403 || res.status === 429 || !res.status || res.status >= 500) return true;
    if (res.status === 200 && !looksLikeJson(res.responseText)) return true;
    return false;
  }

  // Page fetch sends the logged-in cookies. GM_xmlhttpRequest on Android often
  // does not, and Reddit answers 403. Same URL via GM, then old.reddit.com.
  async function fetchRedditJson(path, kind, meta) {
    var origin = pageOrigin();
    var same = origin + path;
    var attempts = [
      { via: 'page', url: same },
      { via: 'gm', url: same },
      { via: 'gm', url: 'https://old.reddit.com' + path }
    ];
    var seen = {};
    var last = null;
    for (var i = 0; i < attempts.length; i++) {
      var attempt = attempts[i];
      if (seen[attempt.via + attempt.url]) continue;
      seen[attempt.via + attempt.url] = true;
      try {
        var res;
        if (attempt.via === 'page') {
          var pageUrl = new URL(attempt.url);
          if (pageUrl.origin !== origin) continue;
          res = await pageFetch(attempt.url);
        } else {
          res = await gmRequest({
            method: 'GET',
            url: attempt.url,
            headers: { 'Accept': 'application/json' },
            timeout: REQUEST_TIMEOUT_MS,
            feed: kind !== 'thread'
          });
        }
        if (res.status === 200 && looksLikeJson(res.responseText)) return parseJsonBody(res, kind, meta);
        if (res.status === 404) {
          last = redditHttpError(404, kind, meta);
          break;
        }
        last = redditHttpError(res.status || 403, kind, meta);
        if (!blockedRedditResponse(res)) break;
      } catch (err) {
        last = err && err.type ? err : redditHttpError(0, kind, meta);
        if (last.status === 404) break;
      }
    }
    throw last || redditHttpError(0, kind, meta);
  }

  async function fetchThread(href, feed) {
    var urls = threadJsonUrls(href);
    if (!urls.length) throw redditHttpError(0, feed ? 'feed' : 'thread');
    var json = await fetchRedditJson(pathFromRedditUrl(urls[0]), feed ? 'feed' : 'thread');
    return parseThread(json);
  }

  // A crosspost with no discussion of its own still points at the original
  // thread. Summarize that thread, and say which subreddit it came from.
  async function useOriginalThread(thread, feed) {
    if (!thread || !thread.crosspost) return thread;
    var urls = crosspostJsonUrls(thread.crosspost);
    if (!urls.length) return thread;
    try {
      var parent = parseThread(await fetchRedditJson(pathFromRedditUrl(urls[0]), 'thread'));
      var sub = parent.subreddit || thread.crosspost.subreddit || '';
      thread.commentsText = parent.commentsText;
      thread.commentCount = parent.commentCount;
      if (parent.authors && parent.authors.length) thread.authors = parent.authors;
      if (!thread.selftext && parent.selftext) thread.selftext = parent.selftext;
      thread.sourceNote = sub ? 'from the original thread in r/' + sub : 'from the original thread';
    } catch (err) {
      if (thread.crosspost.subreddit) {
        thread.sourceNote = 'from the original thread in r/' + thread.crosspost.subreddit;
      }
    }
    return thread;
  }

  async function generateWithModel(thread, key, model, systemText, feed, userOverride) {
    var useThinking = true;
    var useSystem = true;
    for (var attempt = 0; attempt < 2; attempt++) {
      var res = await gmRequest({
        method: 'POST',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(model) + ':generateContent',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key
        },
        data: JSON.stringify(geminiRequestBody(thread, model, useSystem, useThinking, systemText, userOverride)),
          timeout: REQUEST_TIMEOUT_MS,
          feed: !!feed,
          gemini: true
      });
      if (res.status === 200) {
        var data;
        try { data = JSON.parse(res.responseText || '{}'); }
        catch (err) {
          var bad = new Error('Gemini returned a response that wasn\'t JSON.');
          bad.type = 'gemini';
          throw bad;
        }
        var extracted = extractGeminiText(data);
        if (extracted.error) {
          var empty = new Error(extracted.error.message);
          empty.type = extracted.error.type || 'gemini';
          throw empty;
        }
        return extracted.text;
      }
      var classified = classifyGeminiError(res.status, res.responseText || '', model);
      if (attempt === 0) {
        var body = res.responseText || '';
        var changed = false;
        if (useThinking && (classified.type === 'thinking' || /thinking/i.test(body))) {
          useThinking = false;
          changed = true;
        }
        if (useSystem && /system instruction|systemInstruction|unknown name "system/i.test(body)) {
          useSystem = false;
          changed = true;
        }
        if (changed) continue;
      }
      var failed = new Error(classified.message);
      failed.type = classified.type;
      failed.autoRetry = !!classified.autoRetry;
      failed.overloaded = !!classified.overloaded;
      throw failed;
    }
    var gaveUp = new Error('Gemini did not return a summary.');
    gaveUp.type = 'gemini';
    throw gaveUp;
  }

  function flash38Exhausted() {
    try { return sessionStorage.getItem(SESSION_38) === '1'; } catch (err) { return false; }
  }

  function markFlash38Exhausted() {
    try { sessionStorage.setItem(SESSION_38, '1'); } catch (err) { /* ignore */ }
  }

  function clearFlash38Exhausted() {
    try { sessionStorage.removeItem(SESSION_38); } catch (err) { /* ignore */ }
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function modelBusy() {
    var until = Number(gmGet(KEY_BUSY_UNTIL, 0));
    return isFinite(until) && until > Date.now();
  }

  function markModelBusy() {
    gmSet(KEY_BUSY_UNTIL, Date.now() + OVERLOAD_COOLDOWN_MS);
  }

  function clearModelBusy() {
    gmSet(KEY_BUSY_UNTIL, 0);
  }

  function isOverloadError(err) {
    return !!(err && (err.overloaded || (err.gemini && (err.type === 'timeout' || err.type === 'network'))));
  }

  // Retry a busy model once. A timeout or a second failure is final for this
  // model so the caller can switch to flash-lite without waiting on a hung socket.
  async function generateOnceOrRetryOverload(thread, key, model, systemText, feed, onStatus, userOverride) {
    try {
      return await generateWithModel(thread, key, model, systemText, feed, userOverride);
    } catch (err) {
      if (!isOverloadError(err)) throw err;
      if (model === DEFAULT_MODEL) markModelBusy();
      if (onStatus) onStatus(model + ' is busy. Retrying…');
      await delay(OVERLOAD_RETRY_MS);
      try {
        return await generateWithModel(thread, key, model, systemText, feed, userOverride);
      } catch (again) {
        if (again) again.overloaded = true;
        throw again || err;
      }
    }
  }

  // Returns { text, model, fallbackFrom, fallbackReason }. fallbackFrom is set
  // when a different model wrote the summary. The saved model is not changed.
  async function callGemini(thread, key, requested, onStatus, allowSessionFallback, systemText, feed, userOverride) {
    var model = requested;
    var skipped = '';
    var reason = '';
    var skipBecauseBusy = requested === DEFAULT_MODEL && modelBusy();
    var skipBecauseQuota = allowSessionFallback && requested === DEFAULT_MODEL && flash38Exhausted();
    if (skipBecauseBusy || skipBecauseQuota) {
      model = FALLBACK_MODEL;
      skipped = requested;
      reason = skipBecauseBusy ? 'overload' : 'quota';
      if (onStatus) {
        onStatus(skipBecauseBusy
          ? 'gemini-3.8-flash was busy. Using gemini-3.5-flash-lite…'
          : 'gemini-3.8-flash already hit its free-tier limit. Using gemini-3.5-flash-lite…');
      }
    }
    try {
      var text = await generateOnceOrRetryOverload(thread, key, model, systemText, feed, onStatus, userOverride);
      if (model === DEFAULT_MODEL) {
        clearFlash38Exhausted();
        clearModelBusy();
      }
      return { text: text, model: model, fallbackFrom: skipped, fallbackReason: reason };
    } catch (err) {
      var switchModel = model !== FALLBACK_MODEL && (isOverloadError(err) || (err && err.autoRetry));
      if (!switchModel) throw err;
      var why = err && err.autoRetry && !isOverloadError(err) ? 'quota' : 'overload';
      if (why === 'quota') markFlash38Exhausted();
      if (why === 'overload') markModelBusy();
      if (onStatus) {
        onStatus(why === 'overload'
          ? 'Retry failed. Trying gemini-3.5-flash-lite…'
          : 'gemini-3.8-flash is out of free requests. Trying gemini-3.5-flash-lite…');
      }
      try {
        var retry = await generateOnceOrRetryOverload(thread, key, FALLBACK_MODEL, systemText, feed, onStatus, userOverride);
        return { text: retry, model: FALLBACK_MODEL, fallbackFrom: model, fallbackReason: why };
      } catch (fallbackErr) {
        throw fallbackErr || err;
      }
    }
  }

  function elementPostId(el) {
    if (!el || !el.getAttribute) return '';
    var blobs = [
      el.getAttribute('id'),
      el.getAttribute('post-id'),
      el.getAttribute('data-fullname'),
      el.getAttribute('permalink'),
      el.getAttribute('content-href'),
      el.getAttribute('class')
    ];
    for (var i = 0; i < blobs.length; i++) {
      if (!blobs[i]) continue;
      var full = String(blobs[i]).match(/t3_([a-z0-9]+)/i);
      if (full) return full[1].toLowerCase();
      var path = String(blobs[i]).match(/\/comments\/([a-z0-9]+)/i);
      if (path) return path[1].toLowerCase();
    }
    return '';
  }

  // Where the card goes. New Reddit (shreddit) renders the post as a
  // shreddit-post custom element. Old Reddit, and the older m.reddit template,
  // use #siteTable plus .commentarea. The 2020-era React UI used
  // data-test-id="post-content". The card is inserted before the post so it
  // sits at the top of the thread column, in normal flow.
  function findAnchor(doc, postId, allowUnverified) {
    var posts = doc.querySelectorAll('shreddit-post');
    var blankPost = null;
    var conflicting = false;
    for (var i = 0; i < posts.length; i++) {
      var postIdOnEl = elementPostId(posts[i]);
      if (postIdOnEl && postIdOnEl === postId && posts[i].parentElement) {
        return { position: 'before', node: posts[i] };
      }
      if (postIdOnEl && postIdOnEl !== postId) conflicting = true;
      if (!postIdOnEl && !blankPost) blankPost = posts[i];
    }

    var siteTable = doc.querySelector('#siteTable');
    var commentArea = doc.querySelector('.commentarea');
    if (siteTable && commentArea && siteTable.parentElement) {
      var thing = siteTable.querySelector('.thing');
      var thingId = thing ? elementPostId(thing) : '';
      if (!thingId || thingId === postId) return { position: 'before', node: siteTable };
    }

    var react = doc.querySelector('[data-testid="post-container"], [data-test-id="post-content"], [data-testid="post-content"]');
    if (react) {
      var card = react.closest ? (react.closest('[data-testid="post-container"]') || react) : react;
      var reactId = elementPostId(card) || elementPostId(react);
      if (reactId === postId && card.parentElement) return { position: 'before', node: card };
      if (allowUnverified && !reactId && card.parentElement) {
        var reactCount = doc.querySelectorAll('[data-test-id="post-content"], [data-testid="post-content"]').length;
        if (reactCount <= 1) return { position: 'before', node: card };
      }
    }

    if (allowUnverified && !conflicting && blankPost && blankPost.parentElement && posts.length === 1) {
      return { position: 'before', node: blankPost };
    }
    return null;
  }

  function pageIsDark() {
    var root = document.documentElement;
    if (!root) return false;
    var attr = ((root.getAttribute('theme') || '') + ' ' + (root.getAttribute('data-theme') || '')).toLowerCase();
    if (attr.indexOf('dark') !== -1) return true;
    if (attr.indexOf('light') !== -1) return false;
    if (root.classList.contains('theme-dark') || root.classList.contains('dark')) return true;
    if (root.classList.contains('theme-light')) return false;
    var bg = '';
    try { bg = getComputedStyle(document.body || root).backgroundColor || ''; } catch (err) { bg = ''; }
    var match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!match || (match[4] !== undefined && parseFloat(match[4]) === 0)) {
      try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (err) { return false; }
    }
    var lum = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255;
    return lum < 0.45;
  }

  function applyTheme(panel) {
    var theme = 'light';
    try { theme = pageIsDark() ? 'dark' : 'light'; } catch (err) { theme = 'light'; }
    if (panel) panel.setAttribute('data-theme', theme);
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    var boxes = document.querySelectorAll('.rts-feed');
    for (var i = 0; i < boxes.length; i++) boxes[i].setAttribute('data-theme', theme);
    var digest = document.getElementById('rts-digest');
    if (digest) digest.setAttribute('data-theme', theme);
  }

  function syncGridColumn(panel, node) {
    if (!panel || !node || typeof getComputedStyle !== 'function') return;
    var column = '';
    try { column = getComputedStyle(node).gridColumn || ''; } catch (err) { column = ''; }
    if (column && column !== 'auto' && column !== 'auto / auto') panel.style.gridColumn = column;
    else panel.style.gridColumn = '';
  }

  function placePanel(panel, anchor) {
    if (!panel || !anchor || !anchor.node) return;
    if (anchor.position === 'before') {
      var parent = anchor.node.parentElement;
      if (!parent) return;
      if (panel.parentElement === parent && panel.nextElementSibling === anchor.node) {
        syncGridColumn(panel, anchor.node);
        return;
      }
      parent.insertBefore(panel, anchor.node);
      syncGridColumn(panel, anchor.node);
      return;
    }
    if (panel.parentElement === anchor.node && anchor.node.firstElementChild === panel) return;
    anchor.node.insertBefore(panel, anchor.node.firstChild);
  }

  function setCollapsed(panel, collapsed) {
    panel.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
    var button = panel.querySelector('.rts-collapse');
    if (!button) return;
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    button.textContent = collapsed ? '▸' : '▾';
    button.setAttribute('aria-label', collapsed ? 'Expand summary' : 'Collapse summary');
  }

  function show(el, visible) {
    if (!el) return;
    el.classList.toggle('rts-hidden', !visible);
  }

  function setNote(panel, text) {
    var note = panel.querySelector('.rts-note');
    if (note) note.textContent = text;
  }

  function buildPanel() {
    var panel = document.createElement('section');
    panel.id = 'rts-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'AI TL;DR of the discussion');

    var top = document.createElement('div');
    top.className = 'rts-top';

    var badge = document.createElement('span');
    badge.className = 'rts-badge';
    badge.textContent = 'AI TL;DR';

    var note = document.createElement('span');
    note.className = 'rts-note';
    note.textContent = 'Not a mod comment';

    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'rts-iconbtn rts-refresh';
    refresh.setAttribute('aria-label', 'Refresh summary');
    refresh.textContent = '↻';

    var collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'rts-iconbtn rts-collapse';
    collapse.setAttribute('aria-controls', 'rts-body');
    collapse.setAttribute('aria-expanded', 'true');
    collapse.setAttribute('aria-label', 'Collapse summary');
    collapse.textContent = '▾';

    top.appendChild(badge);
    top.appendChild(note);
    top.appendChild(refresh);
    top.appendChild(collapse);

    var title = document.createElement('h2');
    title.className = 'rts-title';
    title.textContent = 'TL;DR of the discussion';

    var body = document.createElement('div');
    body.className = 'rts-body';
    body.id = 'rts-body';

    var bar = document.createElement('div');
    bar.className = 'rts-bar rts-hidden';
    var status = document.createElement('p');
    status.className = 'rts-status rts-hidden';
    var summary = document.createElement('div');
    summary.className = 'rts-summary';
    var error = document.createElement('p');
    error.className = 'rts-error rts-hidden';
    error.setAttribute('role', 'alert');
    var action = document.createElement('button');
    action.type = 'button';
    action.className = 'rts-action rts-hidden';

    body.appendChild(bar);
    body.appendChild(status);
    body.appendChild(summary);
    body.appendChild(error);
    body.appendChild(action);

    panel.appendChild(top);
    panel.appendChild(title);
    panel.appendChild(body);

    function toggle() {
      var next = panel.getAttribute('data-collapsed') !== 'true';
      gmSet(KEY_COLLAPSED, next);
      setCollapsed(panel, next);
    }
    collapse.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
    title.addEventListener('click', toggle);
    refresh.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      var id = threadIdFromUrl(location.href);
      if (id) runSummary(id, { force: true });
    });
    return panel;
  }

  function getPanel() {
    if (panelEl && panelEl.ownerDocument === document) return panelEl;
    var existing = document.getElementById('rts-panel');
    panelEl = existing || buildPanel();
    return panelEl;
  }

  function removePanel() {
    if (!panelEl) return;
    if (!panelEl.parentElement && !panelEl.dataset.postId && !panelEl.dataset.state) return;
    runToken += 1;
    abortLive();
    panelEl.dataset.postId = '';
    panelEl.dataset.state = '';
    if (panelEl.parentElement) panelEl.remove();
  }

  function renderShell(panel, opts) {
    var title = panel.querySelector('.rts-title');
    var status = panel.querySelector('.rts-status');
    var summary = panel.querySelector('.rts-summary');
    var error = panel.querySelector('.rts-error');
    var action = panel.querySelector('.rts-action');
    var bar = panel.querySelector('.rts-bar');
    if (title) title.textContent = opts.title || 'TL;DR of the discussion';
    setNote(panel, opts.note || 'Not a mod comment');
    if (status) status.textContent = opts.status || '';
    show(status, !!opts.status);
    show(bar, !!opts.loading);
    if (summary) {
      if (opts.markdown) summary.innerHTML = renderMarkdown(opts.markdown);
      else if (!opts.keepSummary) summary.innerHTML = '';
    }
    if (error) error.textContent = opts.error || '';
    show(error, !!opts.error);
    if (action) {
      action.textContent = opts.actionLabel || '';
      action.onclick = opts.onAction || null;
    }
    show(action, !!opts.actionLabel);
    panel.setAttribute('aria-busy', opts.loading ? 'true' : 'false');
    if (opts.forceOpen) setCollapsed(panel, false);
    else setCollapsed(panel, collapsedPref());
  }

  function renderLoading(panel, message, count, keep) {
    var titleEl = panel.querySelector('.rts-title');
    var title = 'TL;DR of the discussion';
    if (typeof count === 'number') title = headerText(count);
    else if (keep && titleEl && titleEl.textContent) title = titleEl.textContent;
    renderShell(panel, {
      title: title,
      note: message,
      status: message,
      loading: true,
      keepSummary: !!keep
    });
  }

  function summaryNote(rec, fromCache) {
    var parts = ['Not a mod comment'];
    if (rec && rec.sourceNote) parts.push(rec.sourceNote);
    if (rec && rec.model) parts.push(rec.model);
    if (rec && rec.fallbackFrom) {
      parts.push(rec.fallbackReason === 'overload'
        ? rec.fallbackFrom + ' was busy'
        : rec.fallbackFrom + ' hit its daily limit');
    }
    if (fromCache && rec && rec.cachedAt) parts.push(ageLabel(rec.cachedAt));
    return parts.join(' · ');
  }

  function renderReady(panel, rec, fromCache) {
    renderShell(panel, {
      title: headerText(rec.commentCount),
      note: summaryNote(rec, fromCache),
      markdown: rec.markdown
    });
    panel.dataset.state = 'ready';
  }

  function renderProblem(panel, err) {
    var type = err && err.type ? err.type : 'network';
    var message = err && err.message ? err.message : 'Something went wrong while summarizing this thread.';
    if (type === 'abort') return;
    var actionLabel = '';
    var onAction = null;
    if (type === 'key' || type === 'missing-key') {
      actionLabel = 'Set API key';
      onAction = function () {
        if (askForKey()) {
          var id = threadIdFromUrl(location.href);
          if (id) runSummary(id, { force: true });
        }
      };
    } else if (type === 'fallback') {
      actionLabel = 'Use gemini-3.5-flash-lite';
      onAction = function () { useFlashLite(); };
    } else {
      actionLabel = 'Try again';
      onAction = function () {
        var id = threadIdFromUrl(location.href);
        if (id) runSummary(id, { force: true });
      };
    }
    renderShell(panel, {
      title: panel.querySelector('.rts-title') ? panel.querySelector('.rts-title').textContent : 'TL;DR of the discussion',
      note: 'Not a mod comment',
      error: message,
      actionLabel: actionLabel,
      onAction: onAction,
      forceOpen: true
    });
    panel.dataset.state = 'error';
  }

  function normalizeKey(value) {
    return String(value || '').trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '');
  }

  function askForKey() {
    var current = getKey();
    var entered = window.prompt(
      current
        ? 'A Gemini API key is already saved. Enter a replacement, or leave blank to keep the saved key.'
        : 'Paste your Gemini API key once. It stays in this browser profile. Get a key at aistudio.google.com/apikey.',
      ''
    );
    if (entered == null) return false;
    var next = normalizeKey(entered);
    if (!next) return !!current;
    try {
      gmSet(KEY_API, next);
      if (getKey() === next) return true;
    } catch (err) { /* report the failure without exposing the key */ }
    window.alert('Could not save the key. Check that your userscript manager allows script storage in this browser profile.');
    return false;
  }

  function forgetKey() {
    if (!getKey() || !window.confirm('Remove the saved Gemini API key from this browser profile?')) return false;
    try {
      gmDelete(KEY_API);
      if (!getKey()) return true;
    } catch (err) { /* report the failure without exposing the key */ }
    window.alert('Could not remove the saved key. Check your userscript manager settings.');
    return false;
  }

  function askForModel() {
    var current = getModel();
    var entered = window.prompt(
      'Custom Gemini model id. The menu has presets. Type default to reset to ' + DEFAULT_MODEL + '.',
      current
    );
    if (entered == null) return false;
    var next = String(entered || '').trim();
    if (!next || next.toLowerCase() === 'default') next = DEFAULT_MODEL;
    if (!MODEL_RE.test(next)) {
      window.alert('Model ids look like ' + DEFAULT_MODEL + '.');
      return false;
    }
    if (next === current) return false;
    gmSet(KEY_MODEL, next);
    return true;
  }

  async function runSummary(postId, opts) {
    opts = opts || {};
    var panel = getPanel();
    if (!opts.force && panel.dataset.postId === postId && panel.dataset.state) return;
    var my = ++runToken;
    abortLive();
    panel.dataset.postId = postId;
    panel.dataset.state = 'loading';
    applyTheme(panel);

    var model = getModel();
    var hadPreview = false;
    if (!opts.force) {
      var cached = readCache(postId, model);
      if (cached && my === runToken) {
        renderReady(panel, cached, true);
        return;
      }
    }
    var preview = readFeedCache(postId);
    if (preview && preview.markdown && !preview.skip && my === runToken) {
      hadPreview = true;
      renderReady(panel, {
        markdown: preview.markdown,
        commentCount: preview.commentCount,
        model: preview.model,
        cachedAt: preview.cachedAt,
        fallbackFrom: ''
      }, true);
      panel.dataset.postId = postId;
      panel.dataset.state = 'loading';
    }

    var key = getKey();
    if (!key) {
      if (my !== runToken) return;
      renderProblem(panel, {
        type: 'missing-key',
        message: 'Set your Gemini API key once for this browser profile.'
      });
      return;
    }

    renderLoading(panel, 'Reading the thread…', undefined, hadPreview);
    var alive = true;
    var summaryTimer = setTimeout(function () {
      if (!alive || my !== runToken) return;
      alive = false;
      abortLive(true);
      if (!panel.isConnected || panel.dataset.postId !== postId) return;
      if (panel.dataset.state === 'ready') return;
      renderProblem(panel, {
        type: 'timeout',
        message: 'The summary took too long. Try again.'
      });
    }, SUMMARY_TIMEOUT_MS);
    function stillRunning() {
      return alive && my === runToken && panel.dataset.state !== 'error' && panel.dataset.postId === postId;
    }
    try {
      var thread = await fetchThread(location.href);
      if (!stillRunning()) return;
      thread = await useOriginalThread(thread, false);
      if (!stillRunning()) return;
      if (discussionIsThin(thread)) {
        var emptyRec = {
          markdown: emptyDiscussionText(thread),
          commentCount: thread.commentCount || 0,
          cachedAt: Date.now(),
          model: '',
          fallbackFrom: '',
          sourceNote: thread.sourceNote || ''
        };
        writeCache(postId, model, emptyRec);
        if (!stillRunning()) return;
        renderReady(panel, emptyRec, false);
        return;
      }
      renderLoading(panel, 'Writing the TL;DR…', thread.commentCount, hadPreview);
      if (thread.sourceNote) setNote(panel, 'Not a mod comment · ' + thread.sourceNote);
      var generated = await callGemini(thread, key, model, function (message) {
        if (!stillRunning()) return;
        renderLoading(panel, message, thread.commentCount, true);
        if (thread.sourceNote) setNote(panel, 'Not a mod comment · ' + thread.sourceNote);
      }, !opts.force);
      if (!stillRunning()) return;
      var raw = generated.text;
      var markdown = prepareSummary(raw, thread);
      if (!markdown) {
        var empty = new Error('Gemini returned an empty summary.');
        empty.type = 'empty';
        throw empty;
      }
      var rec = {
        markdown: markdown,
        commentCount: thread.commentCount,
        cachedAt: Date.now(),
        model: generated.model,
        fallbackFrom: generated.fallbackFrom || '',
        fallbackReason: generated.fallbackReason || '',
        sourceNote: thread.sourceNote || ''
      };
      writeCache(postId, model, rec);
      var compact = compactForFeed(markdown);
      if (compact) {
        writeFeedCache(postId, {
          markdown: compact,
          commentCount: thread.commentCount,
          cachedAt: rec.cachedAt,
          model: generated.model,
          sourceNote: thread.sourceNote || ''
        });
      }
      if (!stillRunning()) return;
      renderReady(panel, rec, false);
    } catch (err) {
      if (!alive || my !== runToken || panel.dataset.state === 'error') return;
      if (err && err.type === 'abort') {
        renderProblem(panel, {
          type: 'timeout',
          message: 'The summary took too long. Try again.'
        });
        return;
      }
      renderProblem(panel, err);
    } finally {
      alive = false;
      clearTimeout(summaryTimer);
    }
  }

  function refreshCurrent() {
    var id = threadIdFromUrl(location.href);
    if (!id) return;
    var panel = getPanel();
    if (!panel.parentElement) sync();
    runSummary(id, { force: true });
  }

  var menuIds = [];
  var menusLocked = false;

  function addMenu(name, fn) {
    var id = GM_registerMenuCommand(name, fn);
    if (id != null) menuIds.push(id);
  }

  function useModel(next) {
    if (!MODEL_RE.test(next) || next === getModel()) return false;
    gmSet(KEY_MODEL, next);
    registerMenus();
    refreshCurrent();
    return true;
  }

  function useFlashLite() {
    clearFlash38Exhausted();
    if (getModel() === FALLBACK_MODEL) {
      refreshCurrent();
      return;
    }
    gmSet(KEY_MODEL, FALLBACK_MODEL);
    registerMenus();
    refreshCurrent();
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    if (typeof GM_unregisterMenuCommand === 'function' && menuIds.length) {
      menuIds.forEach(function (id) {
        try { GM_unregisterMenuCommand(id); } catch (err) { /* ignore */ }
      });
      menuIds = [];
    } else if (menusLocked) {
      return;
    }
    menusLocked = true;
    var current = getModel();
    addMenu('Set Gemini API key', function () {
      if (!askForKey()) return;
      refreshCurrent();
      syncDigest(true);
    });
    addMenu('Forget Gemini API key', function () {
      if (!forgetKey()) return;
      refreshCurrent();
      syncDigest(true);
    });
    MODEL_PRESETS.forEach(function (preset) {
      var mark = preset.id === current ? '✓ ' : '';
      addMenu(mark + preset.label, function () { useModel(preset.id); });
    });
    addMenu('Custom model id…', function () {
      if (!askForModel()) return;
      registerMenus();
      refreshCurrent();
    });
    addMenu((feedEnabled() ? '✓ ' : '') + 'Feed recaps', toggleFeedRecaps);
    addMenu((digestEnabled() ? '✓ ' : '') + 'Subreddit digest', toggleDigest);
    addMenu((multiDigestEnabled() ? '✓ ' : '') + 'Digest on custom feeds', toggleMultiDigest);
    addMenu((infiniteScrollDisabled() ? '✓ ' : '') + 'Disable infinite scroll', toggleInfiniteScroll);
    addMenu('Set feed model (' + getFeedModel() + ')', function () {
      if (!askForFeedModel()) return;
      registerMenus();
    });
    addMenu('Clear saved summaries', function () {
      clearCache();
      refreshCurrent();
    });
    addMenu('Refresh this summary', refreshCurrent);
  }

  var FEED_PROMPT = [
    'You write a compact recap of a Reddit comment thread for a phone feed.',
    'The reader will not open the thread.',
    'Return markdown only. No title line. No code fence.',
    'First, one paragraph of 2 or 3 sentences on what the comments are saying, including where people agree and disagree.',
    'Then 1 or 2 bullets. Each bullet is one short takeaway.',
    'Prefer a concrete tip, fix, setting, tool, or warning, and credit a real `u/username` from Allowed usernames.',
    'On a joke or light thread, a takeaway can be the insight, the best joke, or the vibe. Do not skip the bullets and do not pad them.',
    'Never invent usernames or facts. Casual tone. Humor is fine. Never insult anyone.',
    'Bold a few key phrases with **double asterisks**. Cite users as `u/name`.'
  ].join('\n');

  var feedQueue = [];
  var feedQueued = Object.create(null);
  var feedJsonActive = 0;
  var geminiNotBefore = 0;
  var geminiBackoffMs = 0;
  var feedObserver = null;
  var feedPumpTimer = 0;

  function firstSentences(text, maxSentences) {
    var parts = String(text || '').match(/[^.!?]+[.!?]+|[^.!?]+$/g);
    if (!parts || !parts.length) return String(text || '').trim();
    return parts.slice(0, maxSentences).join(' ').replace(/\s+/g, ' ').trim();
  }

  function compactForFeed(markdown) {
    var para = [];
    var bullets = [];
    var actionBullets = [];
    var inActions = false;
    String(markdown || '').replace(/\r\n/g, '\n').split('\n').forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      if (/^\*\*Actionable takeaways\*\*$/i.test(trimmed)) {
        inActions = true;
        return;
      }
      if (/^here are the key themes from the thread:?$/i.test(trimmed)) return;
      if (isBulletLine(trimmed)) {
        if (inActions) actionBullets.push(trimmed);
        else bullets.push(trimmed);
        return;
      }
      if (!bullets.length && !actionBullets.length && !inActions) para.push(trimmed);
    });
    var chosen = actionBullets.length ? actionBullets : bullets;
    var text = firstSentences(para.join(' '), 3);
    if (!text && !chosen.length) return '';
    var out = [];
    if (text) out.push(text);
    chosen.slice(0, 2).forEach(function (item) { out.push(item); });
    return out.join('\n');
  }

  function prepareFeedSummary(raw, authors) {
    return compactForFeed(scrubUnknownUsers(stripModelChrome(raw), authors || []));
  }

  function parseCommentCount(text) {
    var raw = String(text || '').trim();
    if (!raw) return null;
    if (/^comments?$/i.test(raw)) return 1;
    var source = raw.replace(/,/g, '');
    var match = source.match(/^([\d.]+)\s*([kKmM])?(?:\s+comments?)?$/);
    if (!match && /comment/i.test(source)) match = source.match(/([\d.]+)\s*([kKmM])?/);
    if (!match) return null;
    var num = parseFloat(match[1]);
    if (!isFinite(num)) return null;
    var unit = (match[2] || '').toLowerCase();
    if (unit === 'k') num *= 1000;
    if (unit === 'm') num *= 1000000;
    return Math.round(num);
  }

  function commentCountFromCard(el) {
    if (!el || !el.getAttribute) return null;
    var names = ['comment-count', 'commentcount', 'data-comment-count', 'data-comments-count'];
    for (var i = 0; i < names.length; i++) {
      var raw = el.getAttribute(names[i]);
      if (raw == null || raw === '') continue;
      var parsed = parseCommentCount(raw);
      if (parsed != null) return parsed;
    }
    var link = el.querySelector && el.querySelector('a.comments, a.search-comments');
    if (!link && el.shadowRoot && el.shadowRoot.querySelector) {
      link = el.shadowRoot.querySelector('a.comments, a[href*="/comments/"]');
    }
    if (!link) return null;
    return parseCommentCount(link.textContent || '');
  }

  function cardPostId(el) {
    var id = elementPostId(el);
    if (id) return id;
    if (!el || !el.querySelectorAll) return '';
    var links = el.querySelectorAll('a[href*="/comments/"]');
    for (var i = 0; i < links.length; i++) {
      var match = String(links[i].getAttribute('href') || '').match(/\/comments\/([a-z0-9]+)/i);
      if (match) return match[1].toLowerCase();
    }
    return '';
  }

  function cardPermalink(el) {
    var base = 'https://www.reddit.com/';
    try { if (typeof location !== 'undefined' && location.href) base = location.href; } catch (err) { /* keep base */ }
    var direct = el && el.getAttribute ? (el.getAttribute('permalink') || el.getAttribute('content-href') || '') : '';
    if (direct) {
      try { return new URL(direct, base).href; } catch (err) { /* fall through */ }
    }
    if (!el || !el.querySelector) return '';
    var link = el.querySelector('a.comments, a.search-comments, a.title, a.search-title, a[href*="/comments/"]');
    if (!link) return '';
    try { return new URL(link.getAttribute('href') || link.href || '', base).href; } catch (err) { return ''; }
  }

  function isPromotedCard(el) {
    if (!el) return false;
    if (el.classList && (el.classList.contains('promoted') || el.classList.contains('promotedlink'))) return true;
    if (el.getAttribute) {
      var promoted = el.getAttribute('promoted');
      if (promoted != null && promoted !== 'false') return true;
      if (el.getAttribute('is-ad') === 'true') return true;
    }
    if (el.closest && el.closest('shreddit-ad')) return true;
    return false;
  }

  function nextGeminiTime(now, notBefore, gap) {
    var at = Math.max(now, notBefore || 0);
    return { at: at, next: at + gap };
  }

  function readThreadSummaryForFeed(postId) {
    var best = null;
    storageList(KEY_INDEX).forEach(function (item) {
      if (!item || !item.key) return;
      if (item.key.slice(-(postId.length + 1)) !== '.' + postId) return;
      var rec = readStored(item.key);
      if (!rec || !rec.markdown || !rec.cachedAt) return;
      if (Date.now() - rec.cachedAt > CACHE_TTL_MS) return;
      if (!best || rec.cachedAt > best.cachedAt) best = rec;
    });
    if (!best) return null;
    var compact = compactForFeed(best.markdown);
    if (!compact) return null;
    return {
      markdown: compact,
      commentCount: best.commentCount,
      cachedAt: best.cachedAt,
      model: best.model
    };
  }

  function buildFeedBox(postId) {
    var box = document.createElement('aside');
    box.className = 'rts-feed';
    box.id = 'rts-feed-' + postId;
    box.dataset.postId = postId;
    box.setAttribute('data-collapsed', 'false');
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'rts-feed-toggle';
    toggle.setAttribute('aria-expanded', 'true');
    var label = document.createElement('span');
    label.className = 'rts-feed-label';
    label.textContent = 'AI recap';
    var chevron = document.createElement('span');
    chevron.className = 'rts-feed-chev';
    chevron.textContent = '▾';
    toggle.appendChild(label);
    toggle.appendChild(chevron);
    var body = document.createElement('div');
    body.className = 'rts-feed-body';
    box.appendChild(toggle);
    box.appendChild(body);
    // Bubble phase, so the collapse button still receives the tap. Stopping
    // here keeps the surrounding post card from opening.
    function keepTapOnRecap(event) {
      event.stopPropagation();
      var outer = box.closest && box.closest('a, shreddit-post, .thing');
      if (!outer || outer === box) return;
      var innerLink = event.target && event.target.closest && event.target.closest('a');
      if (innerLink && box.contains(innerLink)) return;
      event.preventDefault();
    }
    ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'auxclick'].forEach(function (type) {
      box.addEventListener(type, keepTapOnRecap, false);
    });
    toggle.addEventListener('click', function () {
      var collapsed = box.getAttribute('data-collapsed') === 'true';
      box.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
      chevron.textContent = collapsed ? '▾' : '▸';
      toggle.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
    });
    return box;
  }

  function placeFeedBox(card, box) {
    if (!card || !card.parentElement || !box) return;
    if (card.nextElementSibling !== box) card.parentElement.insertBefore(box, card.nextSibling);
    syncGridColumn(box, card);
  }

  function showFeedLoading(box) {
    var body = box.querySelector('.rts-feed-body');
    if (!body) return;
    body.textContent = '';
    var status = document.createElement('p');
    status.className = 'rts-feed-status';
    status.textContent = 'Reading comments…';
    body.appendChild(status);
  }

  function fillFeedBox(box, rec) {
    var body = box.querySelector('.rts-feed-body');
    if (!body) return;
    body.innerHTML = renderMarkdown(rec.markdown || '');
  }

  function showFeedError(box, message, onRetry, actionLabel) {
    if (!box || !box.querySelector) return;
    var body = box.querySelector('.rts-feed-body');
    if (!body) return;
    body.textContent = '';
    var status = document.createElement('p');
    status.className = 'rts-feed-error';
    status.textContent = message;
    body.appendChild(status);
    if (!onRetry) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'rts-load-more';
    button.textContent = actionLabel || 'Try again';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      onRetry();
    });
    body.appendChild(button);
  }

  function ensureItemBox(item) {
    if (item.box && item.box.isConnected) return item.box;
    if (!item.card || !item.card.isConnected || typeof document === 'undefined') return item.box || null;
    var box = document.getElementById('rts-feed-' + item.postId) || buildFeedBox(item.postId);
    placeFeedBox(item.card, box);
    applyTheme(box);
    item.box = box;
    return box;
  }

  function cancelDwell(card) {
    if (!card || !card.__rtsDwell) return;
    clearTimeout(card.__rtsDwell);
    card.__rtsDwell = 0;
  }

  function startDwell(card) {
    if (!card || card.__rtsDwell) return;
    if (card.setAttribute) card.setAttribute('data-rts-watching', '1');
    card.__rtsDwell = setTimeout(function () {
      card.__rtsDwell = 0;
      if (feedObserver) {
        try { feedObserver.unobserve(card); } catch (err) { /* already gone */ }
      }
      card.setAttribute('data-rts-watched', '1');
      onCardVisible(card);
    }, FEED_DWELL_MS);
  }

  function clearFeedUi() {
    feedQueue = [];
    feedQueued = Object.create(null);
    if (feedObserver) {
      feedObserver.disconnect();
      feedObserver = null;
    }
    if (typeof document === 'undefined') return;
    var boxes = document.querySelectorAll('.rts-feed');
    for (var i = 0; i < boxes.length; i++) boxes[i].remove();
    var watched = document.querySelectorAll('[data-rts-watched], [data-rts-watching]');
    for (var j = 0; j < watched.length; j++) {
      cancelDwell(watched[j]);
      watched[j].removeAttribute('data-rts-watched');
      watched[j].removeAttribute('data-rts-watching');
    }
  }

  function waitGeminiSlot() {
    var slot = nextGeminiTime(Date.now(), geminiNotBefore, FEED_GEMINI_GAP_MS);
    geminiNotBefore = slot.next;
    var delay = Math.max(0, slot.at - Date.now());
    return new Promise(function (resolve) { setTimeout(resolve, delay); });
  }

  function noteFeedRateLimit() {
    geminiBackoffMs = geminiBackoffMs ? Math.min(120000, geminiBackoffMs * 2) : 15000;
    geminiNotBefore = Math.max(geminiNotBefore, Date.now() + geminiBackoffMs);
  }

  function isRateLimitError(err) {
    if (!err) return false;
    if (err.status === 429 || err.autoRetry || err.type === 'quota' || err.type === 'fallback') return true;
    return /429|RESOURCE_EXHAUSTED|resource exhausted|rate limit/i.test(err.message || '');
  }

  function scheduleFeedPump(delay) {
    if (feedPumpTimer) return;
    feedPumpTimer = setTimeout(function () {
      feedPumpTimer = 0;
      pumpFeed();
    }, delay || 0);
  }

  async function processFeedItem(item) {
    try {
      if (!feedEnabled() || !item || !item.href) {
        if (item && item.box) showFeedError(item.box, 'Couldn\'t find this post.');
        if (item) delete feedQueued[item.postId];
        return;
      }
      var key = getKey();
      if (!key) {
        showFeedError(item.box, 'Set your Gemini API key once for this browser profile.', function () {
          if (!getKey() && !askForKey()) return;
          if (feedQueued[item.postId]) return;
          item.attempts = 0;
          item.quiet = false;
          feedQueued[item.postId] = true;
          feedQueue.push(item);
          pumpFeed();
        }, 'Set API key');
        delete feedQueued[item.postId];
        return;
      }
      var settled = false;
      var feedTimer = setTimeout(function () {
        if (settled) return;
        var lateBox = ensureItemBox(item);
        showFeedError(lateBox, 'The summary took too long. Try again.', function () {
          delete feedQueued[item.postId];
          item.attempts = 0;
          item.quiet = false;
          feedQueued[item.postId] = true;
          feedQueue.push(item);
          pumpFeed();
        });
      }, SUMMARY_TIMEOUT_MS);
      try {
      var thread = await fetchThread(item.href, true);
      if (!feedEnabled()) return;
      thread = await useOriginalThread(thread, true);
      if (!feedEnabled()) return;
      if (thread.commentCount < FEED_MIN_COMMENTS) {
        if (thread.crosspost || thread.sourceNote) {
          var note = discussionIsThin(thread)
            ? emptyDiscussionText(thread)
            : 'Not enough discussion to recap yet.';
          var noteBox = ensureItemBox(item);
          if (noteBox) fillFeedBox(noteBox, { markdown: note });
          writeFeedCache(item.postId, {
            markdown: note,
            commentCount: thread.commentCount,
            cachedAt: Date.now(),
            model: '',
            sourceNote: thread.sourceNote || ''
          });
        } else {
          writeFeedCache(item.postId, { skip: true, commentCount: thread.commentCount, cachedAt: Date.now() });
          if (item.box && item.box.parentElement) item.box.remove();
        }
        delete feedQueued[item.postId];
        return;
      }
      var busyBox = ensureItemBox(item);
      if (busyBox && !item.quiet) showFeedLoading(busyBox);
      else if (busyBox && !(busyBox.querySelector('.rts-feed-body') || {}).textContent) showFeedLoading(busyBox);
      await waitGeminiSlot();
      if (!feedEnabled()) return;
      var generated = await callGemini(thread, key, getFeedModel(), function () {}, false, FEED_PROMPT, true);
      geminiBackoffMs = 0;
      var markdown = prepareFeedSummary(generated.text, thread.authors);
      if (!markdown) throw new Error('Gemini returned an empty recap.');
      if (thread.sourceNote) markdown = thread.sourceNote.charAt(0).toUpperCase() + thread.sourceNote.slice(1) + '.\n\n' + markdown;
      var rec = {
        markdown: markdown,
        commentCount: thread.commentCount,
        cachedAt: Date.now(),
        model: generated.model,
        sourceNote: thread.sourceNote || '',
        fallbackFrom: generated.fallbackFrom || '',
        fallbackReason: generated.fallbackReason || ''
      };
      writeFeedCache(item.postId, rec);
      var doneBox = ensureItemBox(item);
      if (doneBox) fillFeedBox(doneBox, rec);
      delete feedQueued[item.postId];
      } finally {
        settled = true;
        clearTimeout(feedTimer);
      }
    } catch (err) {
      if (err && err.type === 'abort') {
        delete feedQueued[item.postId];
        return;
      }
      if (isRateLimitError(err) && item.attempts < 2) {
        noteFeedRateLimit();
        item.attempts += 1;
        feedQueue.unshift(item);
        scheduleFeedPump(geminiBackoffMs);
        return;
      }
      showFeedError(item.box, (err && err.message) ? err.message : 'Couldn\'t recap this post.');
      delete feedQueued[item.postId];
    }
  }

  function pumpFeed() {
    if (!feedEnabled()) return;
    while (feedJsonActive < FEED_JSON_CONCURRENCY && feedQueue.length) {
      var item = feedQueue.shift();
      feedJsonActive += 1;
      processFeedItem(item).then(function () {
        feedJsonActive -= 1;
        pumpFeed();
      }, function () {
        feedJsonActive -= 1;
        pumpFeed();
      });
    }
  }

  function onCardVisible(card) {
    if (!feedEnabled() || !card || typeof document === 'undefined') return;
    var id = cardPostId(card);
    if (!id || isPromotedCard(card)) return;
    var href = '';
    try { href = location.href; } catch (err) { href = ''; }
    if (threadIdFromUrl(href) === id) return;
    var known = commentCountFromCard(card);
    var quiet = known != null && known < FEED_MIN_COMMENTS;
    var cached = readFeedCache(id);
    if (cached && cached.skip) return;
    if (!cached || !cached.markdown) {
      var fromThread = readThreadSummaryForFeed(id);
      if (fromThread) cached = fromThread;
    }
    // A crosspost often shows 0 comments of its own. Fetch before deciding
    // to hide it, but don't put up a loading box until we know there's a discussion.
    if (quiet && !(cached && cached.markdown)) {
      if (feedQueued[id]) return;
      feedQueued[id] = true;
      feedQueue.push({
        postId: id,
        href: cardPermalink(card),
        box: null,
        card: card,
        attempts: 0,
        quiet: true
      });
      pumpFeed();
      return;
    }
    var box = document.getElementById('rts-feed-' + id) || buildFeedBox(id);
    placeFeedBox(card, box);
    applyTheme(box);
    if (cached && cached.markdown) {
      fillFeedBox(box, cached);
      return;
    }
    if (feedQueued[id]) return;
    showFeedLoading(box);
    feedQueued[id] = true;
    feedQueue.push({ postId: id, href: cardPermalink(card), box: box, attempts: 0 });
    pumpFeed();
  }

  function cardInView(el) {
    try {
      var rect = el.getBoundingClientRect();
      var height = window.innerHeight || 800;
      return rect.bottom > 0 && rect.top < height;
    } catch (err) {
      return false;
    }
  }

  function ensureFeedObserver() {
    if (feedObserver || typeof IntersectionObserver !== 'function') return feedObserver;
    feedObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!feedObserver) return;
        // Stay observed until the card has been on screen for a second.
        // Scrolling past cancels the timer and does not queue a recap.
        if (entry.isIntersecting) startDwell(entry.target);
        else cancelDwell(entry.target);
      });
    }, { root: null, rootMargin: '0px', threshold: 0 });
    return feedObserver;
  }

  function scanFeed() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    if (!feedEnabled()) {
      clearFeedUi();
      return;
    }
    var observer = ensureFeedObserver();
    var cards = document.querySelectorAll('shreddit-post, div.thing.link, div.search-result-link');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card.getAttribute('data-rts-watched') === '1') continue;
      if (isPromotedCard(card)) {
        card.setAttribute('data-rts-watched', '1');
        continue;
      }
      var id = cardPostId(card);
      if (!id) continue;
      var href = '';
      try { href = location.href; } catch (err) { href = ''; }
      if (threadIdFromUrl(href) === id) continue;
      if (observer) {
        if (card.getAttribute('data-rts-watching') !== '1') {
          card.setAttribute('data-rts-watching', '1');
          observer.observe(card);
        }
      } else if (cardInView(card)) {
        startDwell(card);
      } else {
        cancelDwell(card);
      }
    }
  }

  function isOldReddit() {
    try {
      return typeof location !== 'undefined' && location.hostname === 'old.reddit.com';
    } catch (err) {
      return false;
    }
  }

  function infiniteScrollDisabled() {
    var value = gmGet(KEY_NO_INFINITE, true);
    return value !== false && value !== 'false';
  }

  // New Reddit fetches the next page when faceplate-partial[slot="load-after"]
  // scrolls into view. Old Reddit uses next/prev links, which we leave alone.
  function isFeedSentinel(el) {
    if (!el || !el.getAttribute || String(el.tagName || '').toUpperCase() !== 'FACEPLATE-PARTIAL') return false;
    if (isOldReddit()) return false;
    var src = el.getAttribute('src') || '';
    if (/comment/i.test(src)) return false;
    if (el.closest && el.closest('shreddit-comment-tree, shreddit-comment')) return false;
    if ((el.getAttribute('slot') || '') === 'load-after') return true;
    return /\/svc\/shreddit\/(?:community-more-posts|feeds)\//i.test(src);
  }

  function installSentinelGuard() {
    if (typeof window === 'undefined' || window.__rtsIO || typeof window.IntersectionObserver !== 'function') return;
    var Native = window.IntersectionObserver;
    function Wrapped(callback, options) {
      return new Native(function (entries, observer) {
        if (!infiniteScrollDisabled() || isOldReddit()) {
          callback(entries, observer);
          return;
        }
        callback(entries.map(function (entry) {
          if (!isFeedSentinel(entry.target)) return entry;
          return {
            isIntersecting: false,
            intersectionRatio: 0,
            target: entry.target,
            time: entry.time,
            boundingClientRect: entry.boundingClientRect,
            intersectionRect: entry.intersectionRect,
            rootBounds: entry.rootBounds
          };
        }), observer);
      }, options);
    }
    Wrapped.prototype = Native.prototype;
    window.IntersectionObserver = Wrapped;
    window.__rtsIO = true;
  }

  function countFeedPosts() {
    if (typeof document === 'undefined') return 0;
    return document.querySelectorAll('shreddit-post').length;
  }

  function removeLoadMoreButtons() {
    if (typeof document === 'undefined') return;
    var buttons = document.querySelectorAll('.rts-load-more');
    for (var i = 0; i < buttons.length; i++) buttons[i].remove();
    var marked = document.querySelectorAll('.rts-feed-sentinel');
    for (var j = 0; j < marked.length; j++) marked[j].classList.remove('rts-feed-sentinel');
  }

  function loadMorePosts(sentinel, button) {
    if (!sentinel || !sentinel.isConnected) {
      button.disabled = true;
      button.textContent = 'No more posts';
      return;
    }
    button.disabled = true;
    button.textContent = 'Loading…';
    var before = countFeedPosts();
    try {
      if (typeof sentinel.loadContent === 'function') sentinel.loadContent();
      else sentinel.setAttribute('loading', 'eager');
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Load more posts';
      return;
    }
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      var grew = countFeedPosts() > before;
      var gone = !sentinel.isConnected;
      if (!grew && !gone && tries < 40) return;
      clearInterval(timer);
      applyInfiniteScroll();
      if (!button.isConnected) return;
      var stillThere = document.querySelector('faceplate-partial[slot="load-after"], .rts-feed-sentinel');
      if (!grew && !stillThere) {
        button.disabled = true;
        button.textContent = 'No more posts';
        return;
      }
      button.disabled = false;
      button.textContent = 'Load more posts';
    }, 200);
  }

  function ensureLoadMoreButton(sentinel) {
    var previous = sentinel.previousElementSibling;
    if (previous && previous.classList && previous.classList.contains('rts-load-more')) return previous;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'rts-load-more';
    button.textContent = 'Load more posts';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      loadMorePosts(sentinel, button);
    });
    if (sentinel.parentElement) sentinel.parentElement.insertBefore(button, sentinel);
    return button;
  }

  function applyInfiniteScroll() {
    if (typeof document === 'undefined' || !document.documentElement) return;
    var root = document.documentElement;
    if (isOldReddit() || !infiniteScrollDisabled()) {
      root.classList.remove('rts-no-infinite');
      removeLoadMoreButtons();
      return;
    }
    root.classList.add('rts-no-infinite');
    var partials = document.querySelectorAll('faceplate-partial');
    var live = [];
    for (var i = 0; i < partials.length; i++) {
      if (!isFeedSentinel(partials[i])) continue;
      partials[i].classList.add('rts-feed-sentinel');
      if ((partials[i].getAttribute('loading') || '') === 'lazy') {
        partials[i].setAttribute('loading', 'action');
      }
      live.push(partials[i]);
      ensureLoadMoreButton(partials[i]);
    }
    var buttons = document.querySelectorAll('.rts-load-more');
    for (var j = 0; j < buttons.length; j++) {
      var next = buttons[j].nextElementSibling;
      var attached = false;
      for (var k = 0; k < live.length; k++) {
        if (live[k] === next) attached = true;
      }
      if (!attached) buttons[j].remove();
    }
  }

  function toggleInfiniteScroll() {
    gmSet(KEY_NO_INFINITE, !infiniteScrollDisabled());
    registerMenus();
    applyInfiniteScroll();
  }

  function toggleFeedRecaps() {
    gmSet(KEY_FEED_ON, !feedEnabled());
    if (!feedEnabled()) clearFeedUi();
    registerMenus();
    if (feedEnabled()) queueSync();
  }

  function askForFeedModel() {
    var current = getFeedModel();
    var entered = window.prompt(
      'Model for feed recaps. Default is ' + FALLBACK_MODEL + ' so scrolling a feed does not use the gemini-3.8-flash daily quota. Type default to reset.',
      current
    );
    if (entered == null) return false;
    var next = String(entered || '').trim();
    if (!next || next.toLowerCase() === 'default') next = FALLBACK_MODEL;
    if (!MODEL_RE.test(next)) {
      window.alert('Model ids look like ' + FALLBACK_MODEL + '.');
      return false;
    }
    if (next === current) return false;
    gmSet(KEY_FEED_MODEL, next);
    return true;
  }

  var DIGEST_POSTS = 25;
  var DIGEST_COMMENT_POSTS = 6;
  var DIGEST_SORTS = { hot: true, new: true, top: true, rising: true, controversial: true, best: true };
  var DIGEST_WINDOWS = { hour: true, day: true, week: true, month: true, year: true, all: true };
  var AGGREGATE_SUBS = { popular: true, all: true, friends: true, mod: true, random: true, randnsfw: true };
  var DIGEST_PROMPT = [
    'You write a digest of a single subreddit feed for someone who has not opened the posts.',
    'Return markdown only. No code fence. No preamble.',
    '1. One paragraph of 2 or 3 sentences: what this subreddit is talking about in this listing. Bold the key topics.',
    '2. Then 3 to 5 bullets. Each starts with **Theme name:** and names the relevant posts as markdown links using the exact URLs given below. Group posts that belong together. Do not invent posts or links.',
    '3. Then a heading line exactly **Actionable takeaways** and 1 to 4 bullets. Always include this section. On a light or joke listing, a takeaway can be the vibe or the post most worth opening. Do not pad.',
    'If this is a custom feed or a combined list of communities, group themes across subreddits and tag each theme and each post with its subreddit, like r/ChatGPT.',
    'Never invent titles, scores, comment counts, or usernames. Casual and readable. Humor is fine. Never insult anyone.'
  ].join('\n');
  var digestToken = 0;

  function digestEnabled() {
    var value = gmGet(KEY_DIGEST_ON, true);
    return value !== false && value !== 'false';
  }

  function multiDigestEnabled() {
    var value = gmGet(KEY_MULTI_DIGEST_ON, true);
    return value !== false && value !== 'false';
  }

  function sortFromUrl(url, pathSort) {
    var sort = (pathSort || url.searchParams.get('sort') || 'best').toLowerCase();
    if (!DIGEST_SORTS[sort]) sort = 'best';
    var windowName = '';
    if (sort === 'top' || sort === 'controversial') {
      windowName = (url.searchParams.get('t') || 'day').toLowerCase();
      if (!DIGEST_WINDOWS[windowName]) windowName = 'day';
    }
    return { sort: sort, t: windowName };
  }

  function feedDisplayName(slug) {
    if (!slug) return 'custom';
    if (slug !== slug.toLowerCase()) return slug;
    if (slug.length <= 3) return slug.toUpperCase();
    return slug.charAt(0).toUpperCase() + slug.slice(1);
  }

  function subredditFeed(href) {
    try {
      var url = new URL(href);
      if (!HOSTS[url.hostname]) return null;
      if (/\/comments\//i.test(url.pathname)) return null;
      var multi = url.pathname.match(/^\/(?:user\/([^/]+)\/m|me\/m)\/([^/]+)(?:\/(hot|new|top|rising|controversial|best))?\/?$/i);
      if (multi) {
        var timing = sortFromUrl(url, multi[3]);
        var user = multi[1] || '';
        return {
          kind: user ? 'user-multi' : 'me-multi',
          user: user,
          name: multi[2],
          feedName: feedDisplayName(multi[2]),
          sub: multi[2],
          sort: timing.sort,
          t: timing.t
        };
      }
      var match = url.pathname.match(/^\/r\/([^/]+)(?:\/(hot|new|top|rising|controversial|best))?\/?$/i);
      if (!match) return null;
      var sub = match[1];
      if (AGGREGATE_SUBS[sub.toLowerCase()]) return null;
      var single = sortFromUrl(url, match[2]);
      if (sub.indexOf('+') !== -1) {
        var parts = sub.split('+').filter(Boolean);
        if (parts.length < 2) return null;
        return {
          kind: 'combined',
          parts: parts,
          feedName: parts.join(' + '),
          sub: sub,
          sort: single.sort,
          t: single.t
        };
      }
      return { kind: 'subreddit', sub: sub, sort: single.sort, t: single.t };
    } catch (err) {
      return null;
    }
  }

  function digestCacheKey(info) {
    var id = info.sub.toLowerCase();
    if (info.kind === 'user-multi') id = 'multi.' + info.user.toLowerCase() + '.' + info.name.toLowerCase();
    else if (info.kind === 'me-multi') id = 'multi.me.' + info.name.toLowerCase();
    else if (info.kind === 'combined') {
      id = 'multi.r.' + info.parts.map(function (part) { return part.toLowerCase(); }).join('+');
    }
    return 'rts.digest.' + id + '.' + info.sort + '.' + (info.t || '-');
  }

  function readDigestCache(key) {
    var rec = readStored(key);
    if (!rec || !rec.markdown || !rec.cachedAt) return null;
    if (Date.now() - rec.cachedAt > CACHE_TTL_MS) {
      gmDelete(key);
      return null;
    }
    return rec;
  }

  function writeDigestCache(key, rec) {
    gmSet(key, rec);
    var list = storageList(KEY_DIGEST_INDEX).filter(function (item) {
      return item && item.key !== key;
    });
    list.push({ key: key, at: rec.cachedAt });
    var now = Date.now();
    var fresh = list.filter(function (item) {
      return item && now - item.at <= CACHE_TTL_MS;
    });
    fresh.sort(function (a, b) { return b.at - a.at; });
    var kept = fresh.slice(0, CACHE_MAX);
    fresh.slice(CACHE_MAX).concat(list.filter(function (item) {
      return item && now - item.at > CACHE_TTL_MS;
    })).forEach(function (item) {
      if (item && item.key !== key) gmDelete(item.key);
    });
    gmSet(KEY_DIGEST_INDEX, kept);
  }

  function parseSubredditListing(payload) {
    var children = payload && payload.data && payload.data.children ? payload.data.children : [];
    var posts = [];
    children.forEach(function (child) {
      if (!child || child.kind !== 't3' || !child.data || child.data.promoted) return;
      var data = child.data;
      posts.push({
        id: String(data.id || '').replace(/^t3_/i, '').toLowerCase(),
        title: oneLine(data.title || '', 160),
        selftext: oneLine(data.selftext || '', 220),
        score: data.score || 0,
        comments: data.num_comments || 0,
        flair: data.link_flair_text ? oneLine(data.link_flair_text, 40) : '',
        permalink: data.permalink || '',
        subreddit: data.subreddit || ''
      });
    });
    return posts.slice(0, DIGEST_POSTS);
  }

  function digestSource(info, posts) {
    var sortName = info.usedSort || info.sort;
    var windowName = sortName === info.sort ? info.t : '';
    var lines = [
      info.feedName ? 'Custom feed: ' + info.feedName : 'Subreddit: r/' + info.sub,
      'Sort: ' + sortName + (windowName ? ' (' + windowName + ')' : ''),
      ''
    ];
    posts.forEach(function (post, index) {
      var url = post.permalink
        ? (post.permalink.indexOf('http') === 0 ? post.permalink : 'https://www.reddit.com' + post.permalink)
        : '';
      var where = post.subreddit ? 'r/' + post.subreddit + ': ' : '';
      lines.push((index + 1) + '. ' + where + post.title);
      if (url) lines.push('url: ' + url);
      lines.push('score ' + post.score + ', ' + post.comments + ' comments' + (post.flair ? ', flair ' + post.flair : ''));
      if (post.selftext) lines.push('body: ' + post.selftext);
      if (post.commentsText) lines.push('top comments: ' + post.commentsText);
      lines.push('');
    });
    var text = lines.join('\n');
    if (text.length > 14000) text = text.slice(0, 13999) + '…';
    return text;
  }

  function subredditFromCard(el) {
    if (!el || !el.getAttribute) return '';
    var name = el.getAttribute('subreddit-prefixed-name') || el.getAttribute('subreddit-name') || el.getAttribute('data-subreddit') || '';
    name = String(name).replace(/^\/?r\//i, '').trim();
    if (name) return name;
    var node = el.querySelector && el.querySelector('a.subreddit');
    if (!node) return '';
    return String(node.textContent || '').replace(/^\/?r\//i, '').trim();
  }

  function flairFromCard(el) {
    if (!el || !el.querySelector) return '';
    var node = el.querySelector('.linkflairlabel, .post-flair, [slot="post-flair"], shreddit-post-flair');
    return node ? oneLine(node.textContent || '', 40) : '';
  }

  function permalinkPath(href) {
    if (!href) return '';
    try {
      var url = new URL(href, 'https://www.reddit.com');
      return url.pathname;
    } catch (err) {
      return String(href);
    }
  }

  function scoreFromCard(el) {
    if (!el) return 0;
    var attr = el.getAttribute && (el.getAttribute('score') || el.getAttribute('data-score'));
    if (attr != null && attr !== '') {
      var parsed = parseFloat(String(attr).replace(/,/g, ''));
      if (isFinite(parsed)) return Math.round(parsed);
    }
    var node = el.querySelector && el.querySelector('.score.unvoted, .score');
    if (!node) return 0;
    var text = node.getAttribute && node.getAttribute('title') || node.textContent || '';
    var match = String(text).replace(/,/g, '').match(/-?\d+/);
    return match ? parseInt(match[0], 10) : 0;
  }

  function scrapeDigestPosts(doc) {
    if (!doc || !doc.querySelectorAll) return [];
    var nodes = doc.querySelectorAll('shreddit-post');
    if (!nodes.length) nodes = doc.querySelectorAll('#siteTable .thing.link, .linklisting .thing.link, .thing.link');
    var posts = [];
    for (var i = 0; i < nodes.length && posts.length < DIGEST_POSTS; i++) {
      var el = nodes[i];
      if (isPromotedCard(el)) continue;
      var title = el.getAttribute ? (el.getAttribute('post-title') || '') : '';
      if (!title && el.querySelector) {
        var titleLink = el.querySelector('a.title, a.search-title, [slot="title"]');
        title = titleLink ? titleLink.textContent || '' : '';
      }
      var permalink = el.getAttribute ? (el.getAttribute('permalink') || el.getAttribute('content-href') || '') : '';
      if (!permalink && el.querySelector) {
        var link = el.querySelector('a.comments, a.title');
        permalink = link ? (link.getAttribute('href') || '') : '';
      }
      if (!title && !permalink) continue;
      posts.push({
        id: cardPostId(el),
        title: oneLine(title, 160) || '(untitled)',
        selftext: '',
        score: scoreFromCard(el),
        comments: commentCountFromCard(el) || 0,
        flair: flairFromCard(el),
        subreddit: subredditFromCard(el),
        permalink: permalinkPath(permalink)
      });
    }
    return posts;
  }

  function listingPath(info) {
    var sort = info.sort || 'best';
    var query = '.json?raw_json=1&limit=' + DIGEST_POSTS;
    if (info.t) query += '&t=' + encodeURIComponent(info.t);
    if (info.kind === 'user-multi') {
      return '/user/' + encodeURIComponent(info.user) + '/m/' + encodeURIComponent(info.name) + '/' + sort + query;
    }
    if (info.kind === 'me-multi') {
      return '/me/m/' + encodeURIComponent(info.name) + '/' + sort + query;
    }
    if (info.kind === 'combined') return '/r/' + info.parts.join('+') + '/' + sort + query;
    return '/r/' + encodeURIComponent(info.sub) + '/' + sort + query;
  }

  async function loadDigestListing(info) {
    var payload = await fetchRedditJson(listingPath(info), 'digest', { sub: info.sub, feedName: info.feedName });
    return parseSubredditListing(payload);
  }

  async function fetchDigestPosts(info) {
    var posts = [];
    var fromDom = false;
    var usedSort = info.sort;
    var loadError = null;
    try {
      posts = await loadDigestListing(info);
    } catch (err) {
      loadError = err;
      if (info.sort === 'best') {
        try {
          posts = await loadDigestListing({
            kind: info.kind,
            user: info.user,
            name: info.name,
            parts: info.parts,
            feedName: info.feedName,
            sub: info.sub,
            sort: 'hot',
            t: ''
          });
          usedSort = 'hot';
          loadError = null;
        } catch (hotErr) {
          loadError = hotErr;
          posts = [];
        }
      }
    }
    if (!posts || !posts.length) {
      var scraped = scrapeDigestPosts(typeof document !== 'undefined' ? document : null);
      if (scraped.length) {
        posts = scraped;
        fromDom = true;
        usedSort = info.sort;
      }
    }
    if (!posts || !posts.length) {
        var failed = new Error("Couldn't load " + (info.feedName ? 'your ' + info.feedName + ' feed' : 'r/' + info.sub) + "'s post list" +
          (loadError && loadError.status ? ' (HTTP ' + loadError.status + ')' : '') + '.');
      failed.status = loadError && loadError.status;
      failed.type = 'reddit';
      throw failed;
    }
    info.usedSort = usedSort;
    if (fromDom) return posts;
    var ranked = posts.filter(function (post) {
      return post.comments >= 3 && post.permalink;
    }).sort(function (a, b) { return b.comments - a.comments; }).slice(0, DIGEST_COMMENT_POSTS);
    await mapPool(ranked, 2, async function (post) {
      try {
        var thread = await fetchThread('https://www.reddit.com' + post.permalink, true);
        post.commentsText = String(thread.commentsText || '').split('\n').filter(function (line) {
          return line && line.charAt(0) !== ' ';
        }).slice(0, 2).map(function (line) { return oneLine(line, 160); }).join(' | ');
      } catch (err) { /* a missing comment sample should not block the digest */ }
    });
    return posts;
  }

  async function mapPool(items, limit, fn) {
    var next = 0;
    var workers = [];
    function worker() {
      if (next >= items.length) return Promise.resolve();
      var index = next;
      next += 1;
      return Promise.resolve()
        .then(function () { return fn(items[index]); })
        .then(worker, worker);
    }
    for (var i = 0; i < limit && i < items.length; i++) workers.push(worker());
    await Promise.all(workers);
  }

  function findDigestAnchor(doc) {
    var feed = doc.querySelector('shreddit-feed');
    if (feed && feed.parentElement) return { position: 'before', node: feed };
    var header = doc.querySelector('shreddit-subreddit-header');
    if (header && header.parentElement) return { position: 'after', node: header };
    var site = doc.querySelector('#siteTable');
    if (site && site.parentElement) return { position: 'before', node: site };
    return null;
  }

  function placeDigestBox(box, anchor) {
    if (!box || !anchor || !anchor.node || !anchor.node.parentElement) return;
    if (anchor.position === 'before') {
      if (box.nextElementSibling === anchor.node) return;
      anchor.node.parentElement.insertBefore(box, anchor.node);
    } else {
      if (anchor.node.nextElementSibling === box) return;
      anchor.node.parentElement.insertBefore(box, anchor.node.nextSibling);
    }
    syncGridColumn(box, anchor.node);
  }

  function buildDigestBox() {
    var box = document.createElement('section');
    box.id = 'rts-digest';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Subreddit digest');
    var top = document.createElement('div');
    top.className = 'rts-head';
    var text = document.createElement('div');
    text.className = 'rts-head-text';
    var badge = document.createElement('span');
    badge.className = 'rts-badge';
    badge.textContent = 'Subreddit digest';
    var title = document.createElement('h2');
    title.className = 'rts-title';
    var note = document.createElement('span');
    note.className = 'rts-note';
    text.appendChild(badge);
    text.appendChild(title);
    text.appendChild(note);
    var refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'rts-iconbtn rts-digest-refresh';
    refresh.setAttribute('aria-label', 'Refresh digest');
    refresh.textContent = '↻';
    var collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'rts-iconbtn rts-digest-collapse';
    collapse.textContent = '▾';
    top.appendChild(text);
    top.appendChild(refresh);
    top.appendChild(collapse);
    var body = document.createElement('div');
    body.className = 'rts-body';
    var status = document.createElement('p');
    status.className = 'rts-status rts-hidden';
    var summary = document.createElement('div');
    summary.className = 'rts-summary';
    var error = document.createElement('p');
    error.className = 'rts-error rts-hidden';
    body.appendChild(status);
    body.appendChild(summary);
    body.appendChild(error);
    box.appendChild(top);
    box.appendChild(body);
    function keep(event) {
      event.stopPropagation();
      var outer = box.closest && box.closest('a');
      if (!outer) return;
      var inner = event.target && event.target.closest && event.target.closest('a');
      if (inner && box.contains(inner)) return;
      event.preventDefault();
    }
    ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend'].forEach(function (type) {
      box.addEventListener(type, keep, false);
    });
    function toggle() {
      var next = box.getAttribute('data-collapsed') !== 'true';
      gmSet(KEY_DIGEST_COLLAPSED, next);
      applyDigestCollapsed(box, next);
    }
    collapse.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
    title.addEventListener('click', toggle);
    refresh.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      var info = subredditFeed(location.href);
      if (info) runDigest(info, box, true);
    });
    applyDigestCollapsed(box, gmGet(KEY_DIGEST_COLLAPSED, false) === true);
    return box;
  }

  function applyDigestCollapsed(box, collapsed) {
    box.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
    var button = box.querySelector('.rts-digest-collapse');
    if (!button) return;
    button.textContent = collapsed ? '▸' : '▾';
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    button.setAttribute('aria-label', collapsed ? 'Expand digest' : 'Collapse digest');
  }

  function digestHeading(info) {
    var name = (info && info.sort) || 'best';
    var label = name.charAt(0).toUpperCase() + name.slice(1);
    if (info && info.t) label += ' · ' + info.t;
    if (info && info.feedName) return 'What your ' + info.feedName + ' feed is talking about (' + label + ')';
    return 'What r/' + (info && info.sub) + ' is talking about (' + label + ')';
  }

  function digestSortLabel(info) {
    return info.sort + (info.t ? ' · ' + info.t : '');
  }

  function showDigestStatus(box, message) {
    var status = box.querySelector('.rts-status');
    var summary = box.querySelector('.rts-summary');
    var error = box.querySelector('.rts-error');
    if (status) {
      status.textContent = message;
      status.classList.remove('rts-hidden');
    }
    if (error) {
      error.textContent = '';
      error.classList.add('rts-hidden');
    }
    if (summary) summary.innerHTML = '';
    box.dataset.state = 'loading';
  }

  function showDigest(box, rec) {
    var status = box.querySelector('.rts-status');
    var summary = box.querySelector('.rts-summary');
    var error = box.querySelector('.rts-error');
    var note = box.querySelector('.rts-note');
    if (status) status.classList.add('rts-hidden');
    if (error) error.classList.add('rts-hidden');
    if (summary) summary.innerHTML = renderMarkdown(rec.markdown || '');
    var title = box.querySelector('.rts-title');
    if (title && (rec.sub || rec.feedName)) title.textContent = digestHeading(rec);
    if (note) {
      var bits = [];
      if (rec.model) bits.push(rec.model);
      if (rec.fallbackFrom) bits.push(rec.fallbackReason === 'overload' ? rec.fallbackFrom + ' was busy' : rec.fallbackFrom + ' hit its daily limit');
      if (rec.cachedAt) bits.push(ageLabel(rec.cachedAt));
      note.textContent = bits.filter(Boolean).join(' · ');
    }
    box.dataset.state = 'ready';
  }

  function showDigestError(box, message, onSetup) {
    var status = box.querySelector('.rts-status');
    var error = box.querySelector('.rts-error');
    if (status) status.classList.add('rts-hidden');
    if (error) {
      error.textContent = message;
      error.classList.remove('rts-hidden');
      if (onSetup) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'rts-load-more';
        button.textContent = 'Set API key';
        button.addEventListener('click', onSetup);
        error.appendChild(document.createTextNode(' '));
        error.appendChild(button);
      }
    }
    box.dataset.state = 'error';
  }

  async function runDigest(info, box, force) {
    var my = ++digestToken;
    var keyName = digestCacheKey(info);
    box.dataset.key = keyName;
    var title = box.querySelector('.rts-title');
    if (title) title.textContent = digestHeading(info);
    if (!force) {
      var cached = readDigestCache(keyName);
      if (cached && my === digestToken) {
        if (!cached.sub) cached.sub = info.sub;
        if (!cached.sort) cached.sort = info.sort;
        showDigest(box, cached);
        return;
      }
    }
    showDigestStatus(box, 'Reading r/' + info.sub + '…');
    var alive = true;
    var timer = setTimeout(function () {
      if (!alive || box.dataset.key !== keyName) return;
      alive = false;
      showDigestError(box, 'The digest took too long. Try again.');
    }, SUMMARY_TIMEOUT_MS);
    try {
      var key = getKey();
      if (!key) {
        showDigestError(box, 'Set your Gemini API key once for this browser profile.', function () {
          if (getKey() || askForKey()) runDigest(info, box, true);
        });
        return;
      }
      var posts = await fetchDigestPosts(info);
      if (!alive || my !== digestToken) return;
      if (!posts.length) {
        showDigestError(box, 'This listing has no posts to digest.');
        return;
      }
      showDigestStatus(box, 'Writing the digest…');
      var generated = await callGemini({
        title: info.sub,
        author: '',
        subreddit: info.sub,
        score: 0,
        commentCount: 20,
        postType: 'text',
        selftext: '',
        commentsText: '',
        authors: [],
        sourceNote: ''
      }, key, getFeedModel(), function (message) {
        if (alive && my === digestToken) showDigestStatus(box, message);
      }, false, DIGEST_PROMPT, true, digestSource(info, posts));
      if (!alive || my !== digestToken) return;
      var markdown = stripModelChrome(generated.text || '');
      if (!markdown) throw new Error('Gemini returned an empty digest.');
      var rec = {
        markdown: markdown,
        cachedAt: Date.now(),
        model: generated.model,
        fallbackFrom: generated.fallbackFrom || '',
        fallbackReason: generated.fallbackReason || '',
        sort: info.usedSort || info.sort,
        t: info.usedSort && info.usedSort !== info.sort ? '' : (info.t || ''),
        sub: info.sub,
        feedName: info.feedName || ''
      };
      writeDigestCache(keyName, rec);
      if (!alive || my !== digestToken) return;
      showDigest(box, rec);
    } catch (err) {
      if (!alive || my !== digestToken) return;
      showDigestError(box, (err && err.message) ? err.message : 'Couldn\'t write the digest.');
    } finally {
      alive = false;
      clearTimeout(timer);
    }
  }

  function syncDigest(force) {
    if (typeof document === 'undefined') return;
    var info = subredditFeed(location.href);
    var existing = document.getElementById('rts-digest');
    var allowed = info && (info.feedName ? multiDigestEnabled() : digestEnabled());
    if (!allowed) {
      if (existing) existing.remove();
      return;
    }
    var anchor = findDigestAnchor(document);
    if (!anchor) return;
    var box = existing || buildDigestBox();
    placeDigestBox(box, anchor);
    applyTheme(box);
    var key = digestCacheKey(info);
    if (!force && box.dataset.key === key && box.dataset.state) return;
    runDigest(info, box, !!force);
  }

  function toggleDigest() {
    gmSet(KEY_DIGEST_ON, !digestEnabled());
    registerMenus();
    syncDigest(false);
  }

  function toggleMultiDigest() {
    gmSet(KEY_MULTI_DIGEST_ON, !multiDigestEnabled());
    registerMenus();
    syncDigest(false);
  }

  function sync() {
    var href = location.href;
    try { syncDigest(false); } catch (err) { /* keep the feed usable */ }
    if (!isThreadUrl(href)) {
      watchUrl = '';
      removePanel();
      scanFeed();
      applyInfiniteScroll();
      return;
    }
    if (href !== watchUrl) {
      watchUrl = href;
      watchStart = Date.now();
    }
    var postId = threadIdFromUrl(href);
    var anchor = findAnchor(document, postId, Date.now() - watchStart > 5000);
    if (!anchor) {
      scanFeed();
      applyInfiniteScroll();
      return;
    }
    var panel = getPanel();
    placePanel(panel, anchor);
    applyTheme(panel);
    var dupes = document.querySelectorAll('#rts-panel');
    for (var i = 0; i < dupes.length; i++) {
      if (dupes[i] !== panel) dupes[i].remove();
    }
    runSummary(postId, { force: false });
    scanFeed();
    applyInfiniteScroll();
  }

  function queueSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = 0;
      try { sync(); } catch (err) { /* keep the page usable */ }
    }, 50);
  }

  function patchHistory() {
    if (!window.history) return;
    ['pushState', 'replaceState'].forEach(function (name) {
      var original = history[name];
      if (typeof original !== 'function' || original.__rts) return;
      var wrapped = function () {
        var result = original.apply(this, arguments);
        queueSync();
        return result;
      };
      wrapped.__rts = true;
      try { history[name] = wrapped; } catch (err) { /* ignore */ }
    });
  }

  function addStyle(css) {
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(css);
      return;
    }
    var style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function boot() {
    if (booted) return;
    booted = true;
    addStyle(STYLES);
    registerMenus();
    patchHistory();
    window.addEventListener('popstate', queueSync);
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigatesuccess', queueSync);
    }
    var root = document.documentElement;
    if (root && typeof MutationObserver === 'function') {
      new MutationObserver(queueSync).observe(root, { childList: true, subtree: true });
      new MutationObserver(function () { applyTheme(panelEl); }).observe(root, {
        attributes: true,
        attributeFilter: ['class', 'theme', 'data-theme']
      });
    }
    try {
      var scheme = window.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function () { applyTheme(panelEl); };
      if (scheme.addEventListener) scheme.addEventListener('change', onScheme);
      else if (scheme.addListener) scheme.addListener(onScheme);
    } catch (err) { /* ignore */ }
    setInterval(queueSync, 2000);
    queueSync();
  }

  if (typeof globalThis !== 'undefined' && globalThis.__RTS_TEST__) {
    globalThis.__RTS__ = {
      getKey: getKey,
      askForKey: askForKey,
      forgetKey: forgetKey,
      DEFAULT_MODEL: DEFAULT_MODEL,
      FALLBACK_MODEL: FALLBACK_MODEL,
      MODEL_PRESETS: MODEL_PRESETS,
      summaryNote: summaryNote,
      SMALL_THREAD_COMMENTS: SMALL_THREAD_COMMENTS,
      CACHE_TTL_MS: CACHE_TTL_MS,
      SYSTEM_PROMPT: SYSTEM_PROMPT,
      isThreadUrl: isThreadUrl,
      threadIdFromUrl: threadIdFromUrl,
      threadJsonUrls: threadJsonUrls,
      parseThread: parseThread,
      buildPrompt: buildPrompt,
      prepareSummary: prepareSummary,
      renderMarkdown: renderMarkdown,
      scrubUnknownUsers: scrubUnknownUsers,
      headerText: headerText,
      classifyGeminiError: classifyGeminiError,
      extractGeminiText: extractGeminiText,
      thinkingConfigFor: thinkingConfigFor,
      findAnchor: findAnchor,
      elementPostId: elementPostId,
      readCache: readCache,
      writeCache: writeCache,
      clearCache: clearCache,
      sync: sync,
      runSummary: runSummary,
      callGemini: callGemini,
      getPanel: getPanel,
      compactForFeed: compactForFeed,
      prepareFeedSummary: prepareFeedSummary,
      commentCountFromCard: commentCountFromCard,
      cardPostId: cardPostId,
      cardPermalink: cardPermalink,
      nextGeminiTime: nextGeminiTime,
      readFeedCache: readFeedCache,
      writeFeedCache: writeFeedCache,
      FEED_MIN_COMMENTS: FEED_MIN_COMMENTS,
      FEED_GEMINI_GAP_MS: FEED_GEMINI_GAP_MS,
      FEED_DWELL_MS: FEED_DWELL_MS,
      SUMMARY_TIMEOUT_MS: SUMMARY_TIMEOUT_MS,
      OVERLOAD_RETRY_MS: OVERLOAD_RETRY_MS,
      REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
      gmRequest: gmRequest,
      modelBusy: modelBusy,
      markModelBusy: markModelBusy,
      discussionIsThin: discussionIsThin,
      emptyDiscussionText: emptyDiscussionText,
      crosspostJsonUrls: crosspostJsonUrls,
      isFeedSentinel: isFeedSentinel,
      isOldReddit: isOldReddit,
      infiniteScrollDisabled: infiniteScrollDisabled,
      fetchRedditJson: fetchRedditJson,
      redditHttpError: redditHttpError,
      scrapeDigestPosts: scrapeDigestPosts,
      subredditFeed: subredditFeed,
      listingPath: listingPath,
      digestCacheKey: digestCacheKey,
      digestHeading: digestHeading,
      parseSubredditListing: parseSubredditListing,
      getFeedModel: getFeedModel,
      feedEnabled: feedEnabled
    };
    return;
  }

  if (typeof document === 'undefined') return;
  if (window.top && window.top !== window.self) return;
  installSentinelGuard();
  boot();
})();
