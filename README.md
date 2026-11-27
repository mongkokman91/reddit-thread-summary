# Reddit Thread Summary

A Tampermonkey / Violentmonkey userscript that puts an AI **TL;DR of the discussion** at the top of a Reddit thread. It is meant to be read on a phone: one consensus paragraph, the themes people actually argued about, and the concrete advice buried in the comments.

It starts on its own when a thread opens. There is no button to press. Moving from one thread to another inside Reddit (the site does that without a full page load) starts a new summary, and opening a thread you have already summarized is instant for six hours.

The card is part of the page, like a stickied comment, not a floating box over the text. A small **AI TL;DR** label marks it so it is not mistaken for a moderator comment.

## What you get

The header uses the thread's real comment count:

**TL;DR of the discussion (86 comments)**

Someone's Pixel camera keeps blowing out night shots. **The consensus is that locking exposure on the dark part of the scene, not Night Sight, fixes it.** A few people still prefer a third-party camera app.

Here are the key themes from the thread:

- **Exposure lock:** `u/ada` said to tap the dark area and drag exposure down, and that **Night Sight** was making the streetlights bloom.
- **App alternative:** `u/linus` had cleaner frames from **Open Camera** with manual ISO.

**Actionable takeaways**

- **Lock exposure first:** tap the subject, hold, then slide exposure down (`u/ada`).
- **Skip the stock camera for neon:** `u/linus` shot at **ISO 200** in Open Camera.

A handful of replies wandered into a Samsung argument. Not useful for this fix.

**Actionable takeaways** is always included, with at least one bullet and at most five. On a joke or other light thread, that bullet can be the insight, the best joke, or the general vibe instead of a how-to. The list is not padded out to five.

Shorter threads (under 15 comments) stay short: the consensus paragraph, at most two theme bullets, and one or two takeaways. Names are taken from the thread. The model is told not to invent usernames, and any `u/` name that was not in the thread is dropped.

## Install on Lemur (OnePlus and other Android phones)

Lemur is a Chromium browser and can install Chrome extensions.

1. Open Lemur.
2. Open the extensions menu (the grid icon) and choose the Chrome Web Store. You can also open the store link directly.
3. Install one of these, then confirm the prompt:
   - [Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Violentmonkey](https://chromewebstore.google.com/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag)
4. In Lemur, open the install link:

   <https://raw.githubusercontent.com/mongkokman91/reddit-thread-summary/main/reddit-thread-summary.user.js>

5. The extension will ask to install **Reddit Thread Summary**. Confirm it.
6. Open any Reddit thread. The first time, paste a Gemini API key when asked.

The same install works in desktop Chrome, Edge, and other Chromium browsers with Tampermonkey or Violentmonkey. The script runs on thread pages (`/r/<sub>/comments/<id>`) at `www.reddit.com`, `old.reddit.com`, `new.reddit.com`, `sh.reddit.com`, and `m.reddit.com`.

## Gemini API key

The summary is generated with your own key. The script does not ship with one.

1. Open [Google AI Studio](https://aistudio.google.com/apikey) and sign in.
2. Create an API key. Google's free tier is enough for reading threads.
3. Paste it into the prompt the first time a thread loads, or use the menu command below.

The key is stored with `GM_setValue` in the userscript manager on your device. It is sent only to `generativelanguage.googleapis.com`, as the `x-goog-api-key` header.

`gemini-2.5-flash` is outdated and is not a preset. The default is **`gemini-3.8-flash`** (newest Flash, free tier, about 20 requests a day).

| Model | Plan | What to expect |
| --- | --- | --- |
| `gemini-3.8-flash` | Free | Default. Newest Flash. About 20 requests a day. |
| `gemini-3.5-flash-lite` | Free | Fastest. About 500 requests a day. Used automatically when 3.8 Flash is out of requests. |
| `gemini-4-hydrogen` | Free | Smarter. About 20 requests a day. |
| `gemini-4-neon` | Paid | Needs a paid Gemini API plan. |
| `gemini-4-carbon` | Paid | Needs a paid Gemini API plan. Strongest of the presets. |

Gemini 4 and 3.8 Flash think before they answer, and the high setting is slow on a phone. The script asks 3.8 Flash, Hydrogen, and Neon for thinking level **low**, and Carbon for **medium**. Flash-Lite stays on **minimal**, the fastest level it has.

If `gemini-3.8-flash` comes back rate-limited (HTTP 429 or `RESOURCE_EXHAUSTED`), that same summary is retried on `gemini-3.5-flash-lite` without changing your saved model. The card notes which model wrote it, for example `gemini-3.5-flash-lite · gemini-3.8-flash hit its daily limit`. For the rest of that browser tab, later threads skip straight to Flash-Lite. A manual refresh tries 3.8 Flash again. Other models that hit a quota, or that say they are not on the free tier, keep a one-tap **Use gemini-3.5-flash-lite** button, which does switch the saved model.

## Settings

Open the userscript menu from Lemur's extensions grid: Tampermonkey or Violentmonkey, then **Reddit Thread Summary**. The model you are using has a check mark.

- **Set Gemini API key** — replace or clear the key. Clearing the field and accepting deletes it.
- **Use gemini-3.8-flash (free, ~20/day)** — the default.
- **Use gemini-3.5-flash-lite (free, ~500/day)**
- **Use gemini-4-hydrogen (free, ~20/day)**
- **Use gemini-4-neon (paid)**
- **Use gemini-4-carbon (paid)**
- **Custom model id…** — paste any other model id. Type `default` to go back to `gemini-3.8-flash`.
- **Feed recaps** — on by default. Turn it off to stop the boxes under feed cards.
- **Set feed model** — defaults to `gemini-3.5-flash-lite`. Type `default` to reset.
- **Disable infinite scroll** — on by default. New Reddit shows **Load more posts** instead of loading the next page on its own. Old Reddit is unchanged.
- **Clear saved summaries** — forget the six-hour cache.
- **Refresh this summary** — fetch the thread and write a new TL;DR.

On the card itself:

- A small line under the title says which model produced the summary.
- **↻** refreshes the thread you are reading.
- **▾ / ▸** collapses or expands the card. That choice is remembered. The card starts expanded.
- If the key is missing or Gemini rejects it, **Set API key** is on the card.
- If a model is out of free requests or not on the free tier, the card says so. 3.8 Flash retries on Flash-Lite by itself. The other presets offer **Use gemini-3.5-flash-lite**.
- Other failures (network, Reddit blocking a logged-out NSFW post) show a short reason and **Try again**.

A saved summary shows how old it is (`saved 2h ago`). Refresh replaces it.

## Feed recaps

On home (For You and Following), r/popular, r/all, a subreddit listing, and search results, a short **AI recap** sits under each post card on new Reddit (including the phone layout) and old Reddit. It is 2–3 sentences about the comments plus one or two takeaway bullets, so you can skip opening the thread.

Recaps are not written for the whole page at once. A card is summarized only after it has stayed on screen for about a second; scrolling past cancels that. Posts with fewer than about 5 comments are skipped. Requests are queued, two JSON fetches at a time, and Gemini calls stay at about 10 per minute. A rate limit waits and retries with backoff.

Feed recaps use **`gemini-3.5-flash-lite`** (about 500 free requests a day), not `gemini-3.8-flash`, so scrolling does not spend the thread model's daily quota. Change that with **Set feed model**. **Feed recaps** in the menu turns them off; they start on.

Each box is labeled **AI recap**, follows the light or dark theme, and collapses when you tap the label. Taps on the box stay on the box and do not open the post.

A recap is saved per post for six hours. Opening that thread shows the saved recap in the TL;DR panel immediately, then replaces it with the full discussion summary. A full summary saved from a thread is reused as the feed recap, so that post is not sent to Gemini twice.

## Infinite scroll

**Disable infinite scroll** is on by default. On new Reddit (www, the phone layout, and the other shreddit hosts) the feed no longer loads the next page by itself. A **Load more posts** button at the bottom loads the next batch when you tap it. Old Reddit already has next and previous page links, and those are left as they are. Turn the menu item off to go back to Reddit's automatic loading.

## Updates

`@updateURL` and `@downloadURL` point at the raw script on `main`:

`https://raw.githubusercontent.com/mongkokman91/reddit-thread-summary/main/reddit-thread-summary.user.js`

Tampermonkey and Violentmonkey check that URL on their own schedule (Tampermonkey: the extension's settings, "Check for userscript updates"). **An update is installed only when `@version` in the file is higher than the installed version.** Editing the script on `main` without bumping `@version` does not roll out. The version in this repo is `1.1.0`.

## Privacy

For each uncached thread or feed post the script requests that post's `.json` (title, post body, link, and a trimmed set of high-score comments and replies) and sends that text to Google's Gemini API. Reddit cookies are included on the thread request so a post you can already see while logged in (NSFW, quarantined) can be summarized. The API key and cached summaries stay in the userscript manager's storage.

## Files

- `reddit-thread-summary.user.js` — the whole script. No build step.
