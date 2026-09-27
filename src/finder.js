#!/usr/bin/osascript -l JavaScript
// Icon & Font Finder for Alfred: Iconify icons, svgl logos and Google Fonts, without dependencies.
// Usage: osascript -l JavaScript finder.js <command> [args…]
//   icon|logo|font <query>        Script Filters (Alfred JSON on stdout)
//   action <svg|jsx|datauri|png> <id>   Run Script actions (exact text on stdout)
//   worker                        background: download SVGs and render previews, then prune the cache
//   refresh <fonts|svgl|collections>    background: refresh a cached list
ObjC.import("Foundation");
ObjC.import("AppKit");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}
const FM = $.NSFileManager.defaultManager;
// Look up keys that come from users or APIs ("constructor", "__proto__" …) without hitting Object.prototype
// Display strings from APIs: no control characters or bidi overrides (they can reorder what Alfred shows)
const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, " ").replace(/\s+/g, " ").trim();
const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

// ---------- configuration ----------

const trimSlash = (s) => s.replace(/\/+$/, "");
// Test mode never reaches the real services: a base URL the tests don't override points at a closed local port
const TESTING = env("IF_TEST", "") === "1";
const real = (url) => (TESTING ? "http://127.0.0.1:9/test-mode" : url);
const ICONIFY = trimSlash(env("IF_ICONIFY_API", real("https://api.iconify.design")));
const SVGL = trimSlash(env("IF_SVGL_API", real("https://api.svgl.app")));
// svgl files are only downloaded from svgl itself (the list could point anywhere)
const SVGL_ORIGIN = (/^https?:\/\/[^/]+/.exec(SVGL) || [""])[0];
const svglFileUrl = (u) => typeof u === "string" && !/[\s"\\]/.test(u) && (u.startsWith("https://svgl.app/") || (!!SVGL_ORIGIN && u.startsWith(SVGL_ORIGIN + "/")));
const FONTS_META = env("IF_FONTS_META", real("https://fonts.google.com/metadata/fonts"));
const UA = "alfred-icon-finder/1.0 (+https://github.com/x-o-r-r-o/alfred-icon-finder)";

const DAY = 86400;
const TTL = { search: DAY, collections: 7 * DAY, svgl: DAY, fonts: 7 * DAY, fail: 3600, stale: 30 * DAY };
const MAX_RERUNS = 30;
const MAX_SEARCHES = 1000;
const RERUN_DELAY = 0.4;
const RENDER_HANG = 20; // seconds

function cfg() {
  const num = (v, d) => (/^\d+$/.test(String(v).trim()) ? parseInt(v, 10) : d);
  return {
    sets: parseSetList(env("icon_sets", "")),
    setsOnly: env("icon_sets_only", "0") === "1",
    limit: Math.min(Math.max(num(env("icon_limit", "64"), 64), 32), 200),
    previewColor: env("preview_color", "auto"),
    svgSize: env("svg_size", "keep"),
    pngSize: Math.min(Math.max(num(env("png_size", "512"), 512), 16), 4096),
    pngColor: hexColor(env("png_color", "#000000")) || "#000000",
    pngFolder: env("png_folder", "downloads").trim(),
    showRecent: env("show_recent", "1").trim() !== "0",
    cacheLimitMB: Math.max(num(env("cache_limit_mb", "100"), 100), 1),
    copyColor: hexColor(env("copy_color", "")),
    nameFormat: env("name_format", "iconify").trim(),
  };
}

function parseSetList(s) {
  return String(s)
    .toLowerCase()
    .split(/[\s,;]+/)
    .map((x) => x.replace(/^@/, "").replace(/^set:/, ""))
    .filter((x) => PREFIX_RE.test(x));
}

function hexColor(s) {
  const m = /^\s*#?([0-9a-f]{3}|[0-9a-f]{6})\s*$/i.exec(String(s || ""));
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.replace(/./g, "$&$&");
  return "#" + h;
}

// ---------- files ----------

function cacheDir() {
  // pruning deletes files under this folder: never accept "", "/" or a relative path
  let dir = trimSlash(env("alfred_workflow_cache", ""));
  if (!/^\/[^/]/.test(dir) || /(^|\/)\.\.?(\/|$)/.test(dir)) dir = `${trimSlash($.NSTemporaryDirectory().js)}/alfred-icon-finder`;
  mkdirp(dir);
  return dir;
}
// Recently copied icons live in the workflow's data folder (kept when the cache is cleared); same path rules
function dataDir() {
  const dir = trimSlash(env("alfred_workflow_data", ""));
  if (!/^\/[^/]/.test(dir) || /(^|\/)\.\.?(\/|$)/.test(dir)) return cacheDir();
  mkdirp(dir);
  return dir;
}
function mkdirp(dir) {
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
}
function dirname(p) {
  return p.replace(/\/[^/]*$/, "") || "/";
}
function exists(p) {
  return FM.fileExistsAtPath(p);
}
function readText(p) {
  if (!exists(p)) return null;
  let s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, $());
  if (s.isNil()) s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSISOLatin1StringEncoding, $());
  return s.isNil() ? null : s.js;
}
function writeText(p, text) {
  mkdirp(dirname(p));
  return $(text).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, $());
}
function readJSON(p) {
  const t = readText(p);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch (e) {
    return null;
  }
}
function remove(p) {
  FM.removeItemAtPathError(p, $());
}
// rename(2) replaces the target atomically: a Script Filter reading it never sees it missing or half written
ObjC.bindFunction("rename", ["int", ["char *", "char *"]]);
ObjC.bindFunction("kill", ["int", ["int", "int"]]);
function move(from, to) {
  mkdirp(dirname(to));
  return $.rename(from, to) === 0;
}
const PID = $.NSProcessInfo.processInfo.processIdentifier;
function attrs(p) {
  const a = FM.attributesOfItemAtPathError(p, $());
  return a.isNil() ? null : a;
}
// Seconds since the file was modified, or null when it doesn't exist
function fileAge(p) {
  const a = attrs(p);
  if (!a) return null;
  return -a.fileModificationDate.timeIntervalSinceNow;
}
function touch(p) {
  if (!exists(p)) writeText(p, "");
  else FM.setAttributesOfItemAtPathError($({ NSFileModificationDate: $.NSDate.date }), p, $());
}
function listFiles(dir) {
  const arr = FM.subpathsOfDirectoryAtPathError(dir, $());
  if (arr.isNil()) return [];
  const out = [];
  for (let i = 0; i < arr.count; i++) out.push(arr.objectAtIndex(i).js);
  return out;
}

// FNV-1a, 2 × 32 bit: a short, stable key for cache file names
function hash(s) {
  const one = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return one(2166136261) + one(84696351);
}

// ---------- processes and network ----------

// Run a command with argv (never through a shell string); returns { status, out, err }
function exec(path, args, input) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  const outP = $.NSPipe.pipe, errP = $.NSPipe.pipe, inP = $.NSPipe.pipe;
  task.standardOutput = outP;
  task.standardError = errP;
  task.standardInput = input === undefined ? $.NSFileHandle.fileHandleWithNullDevice : inP;
  if (!task.launchAndReturnError($())) return { status: -1, out: "", err: "launch failed" };
  if (input !== undefined) {
    inP.fileHandleForWriting.writeData($(input).dataUsingEncoding($.NSUTF8StringEncoding));
    inP.fileHandleForWriting.closeFile;
  }
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  const err = errP.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  const str = (d) => {
    const s = $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding);
    return s.isNil() ? "" : s.js;
  };
  return { status: task.terminationStatus, out: str(out), err: str(err) };
}

// GET a URL into a file. Returns the HTTP status (0 when the network is unreachable).
const CURL_OPTS = ["-sS", "-L", "--max-redirs", "5", "--proto", "=https,http", "--proto-redir", "=https,http", "--compressed",
  "--connect-timeout", "5", "-A", UA];

function download(url, outPath, timeout, maxBytes) {
  const part = `${outPath}.${$.NSProcessInfo.processInfo.processIdentifier}.part`;
  mkdirp(dirname(outPath));
  const r = exec("/usr/bin/curl", [...CURL_OPTS, "--max-filesize", String(maxBytes || 20e6), "--max-time", String(timeout || 8),
    "-o", part, "-w", "%{http_code}", "--", url]);
  const status = parseInt(r.out, 10) || 0;
  if (status === 200 && exists(part)) move(part, outPath);
  else remove(part);
  return status;
}

// GET JSON. Returns { status, data } or { status, error }
function getJSON(url, timeout) {
  const tmp = `${cacheDir()}/tmp/${hash(url)}-${$.NSProcessInfo.processInfo.processIdentifier}.json`;
  const status = download(url, tmp, timeout);
  if (status !== 200) return { status, error: httpError(status, serviceFor(url)) };
  let text = readText(tmp) || "";
  remove(tmp);
  text = text.replace(/^\)\]\}'\s*/, ""); // Google's XSSI guard
  try {
    return { status, data: JSON.parse(text) };
  } catch (e) {
    return { status, error: "Unexpected response from the server" };
  }
}

const SERVICE_NAMES = new Map([["iconify", "Iconify"], ["svgl", "svgl"], ["fonts", "Google Fonts"]]);
function httpError(status, service) {
  const who = SERVICE_NAMES.get(service) || "The server";
  if (status === 0) return "No internet connection";
  if (status === 429) return `${who} is limiting requests: try again in a minute`;
  if (status === 403) return `${who} blocked the request: a VPN or network filter can cause this, try again later (HTTP 403)`;
  if (status === 404) return "Not found (HTTP 404)";
  if (status >= 500) return `${who} is having problems (HTTP ${status})`;
  return `${who} returned an error (HTTP ${status})`;
}

function serviceFor(url) {
  return url.startsWith(ICONIFY) ? "iconify" : url.startsWith(SVGL) ? "svgl" : "fonts";
}

// A cache file written by this or an older version, or damaged: data of the wrong shape counts as missing.
// The shape is looked up by the transform that produced it.
function readCache(path, transform) {
  const d = readJSON(path);
  const shape = transform && CACHE_SHAPES.get(transform);
  return d !== null && (!shape || shape(d)) ? d : null;
}

// Fresh cache → cached data; otherwise fetch, and fall back to stale data when that fails.
// While a service is backing off (rate limited or unreachable), the network isn't tried at all.
function cachedJSON(url, path, ttl, timeout, transform) {
  const age = fileAge(path);
  if (age !== null && age < ttl) {
    const d = readCache(path, transform);
    if (d) return { data: d };
  }
  const service = serviceFor(url);
  // one process fetches a URL at a time; the others (parallel keystrokes, reruns) wait for its result
  // Alfred terminates the previous Script Filter on each keystroke (queuemode 2): a lock whose owner is gone is stale
  const lock = `${path}.fetching`;
  if (!acquireOwnedLock(lock, timeout + 10)) {
    const until = Date.now() + (timeout + 2) * 1000;
    while (exists(lock) && Date.now() < until) {
      $.NSThread.sleepForTimeInterval(0.1);
      if (!lockOwnerAlive(lock) && acquireOwnedLock(lock, timeout + 10)) return fetchLocked(url, path, ttl, timeout, transform, lock);
    }
    const fresh = fileAge(path);
    const d = fresh !== null && fresh < Math.max(ttl, timeout + 5) ? readCache(path, transform) : null;
    if (d) return { data: d };
    const stale = readCache(path, transform);
    const busy = { error: "Still loading: try again in a moment", status: -2, throttled: true };
    return stale ? Object.assign(busy, { data: stale, stale: true }) : busy;
  }
  return fetchLocked(url, path, ttl, timeout, transform, lock);
}

// cachedJSON with its lock held: fetch, store, release
function fetchLocked(url, path, ttl, timeout, transform, lock) {
  const service = serviceFor(url);
  let r;
  try {
    // another process may have fetched it while this one waited for the lock
    const again = fileAge(path);
    const done = again !== null && again < ttl ? readCache(path, transform) : null;
    if (done) return { data: done };
    const wait = backoff(service);
    if (wait) r = { status: Math.max(wait, 0), error: httpError(Math.max(wait, 0), service) };
    else if (!allowRequest(service)) r = { status: -2, error: "Too many requests: slowing down for a few seconds", throttled: true };
    else {
      r = getJSON(url, timeout);
      noteFailure(service, r.status);
    }
    if (r.data !== undefined) {
      let d;
      try {
        d = transform ? transform(r.data) : r.data;
      } catch (e) {
        d = null;
      }
      if (d) {
        writeText(path, JSON.stringify(d)); // before the lock is released, so waiting processes find it
        return { data: d };
      }
      r.error = "Unexpected response from the server";
    }
  } finally {
    remove(lock);
  }
  const stale = readCache(path, transform);
  const out = { error: r.error, status: r.status, throttled: !!r.throttled };
  return stale ? Object.assign(out, { data: stale, stale: true }) : out;
}

// Requests per service across every process (each keystroke is a separate process): at most `max` in `window`
// seconds, counted with one empty file per request in the cache. Iconify publishes no limit; svgl allows
// 5 requests per 10 seconds per IP and then locks the IP out for 3 minutes.
const REQUEST_LIMITS = { iconify: [15, 10], svgl: [3, 10], fonts: [3, 60] };
function allowRequest(service) {
  if (env("IF_UNTHROTTLED", "") === "1") return true; // tests that make many requests on purpose
  const [max, window] = REQUEST_LIMITS[service] || [10, 10];
  const dir = `${cacheDir()}/requests/${service}`;
  mkdirp(dir);
  const now = Date.now();
  let recent = 0;
  for (const f of listFiles(dir)) {
    const t = parseInt(f, 10);
    if (!(t > now - window * 1000) || t > now + 60000) remove(`${dir}/${f}`);
    else recent++;
  }
  if (recent >= max) return false;
  writeText(`${dir}/${now}-${$.NSProcessInfo.processInfo.processIdentifier}`, "");
  return true;
}

// Lists that change slowly (fonts, logos): use any cached copy at once and refresh in the background.
function backgroundList(kind, url, path, ttl, timeout, transform) {
  const age = fileAge(path);
  const cached = age === null ? null : readCache(path, transform);
  if (cached) {
    if (age > ttl) spawn(["refresh", kind]);
    return { data: cached };
  }
  return cachedJSON(url, path, ttl, timeout, transform);
}

// Atomic lock: mkdir fails when the folder already exists. A lock older than `expiry` seconds is stale
// (its holder was killed), so the expiry must be longer than the holder's hard timeout.
function mkdirOnce(path) {
  return !!FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, false, $(), $());
}
// A lock that records its owner's pid (a file inside the lock folder), so a killed owner is noticed at once
function acquireOwnedLock(path, expiry) {
  if (!acquireLock(path, expiry)) {
    if (lockOwnerAlive(path)) return false;
    remove(path);
    if (!mkdirOnce(path)) return false;
  }
  writeText(`${path}/${PID}.pid`, "");
  return true;
}
function lockOwnerAlive(path) {
  const pids = listFiles(path).map((f) => /^(\d+)\.pid$/.exec(f)).filter(Boolean);
  if (!pids.length) {
    const age = fileAge(path);
    return age !== null && age < 2; // just created: the owner is writing its pid
  }
  return pids.some((m) => $.kill(parseInt(m[1], 10), 0) === 0);
}
function acquireLock(path, expiry) {
  mkdirp(dirname(path));
  if (mkdirOnce(path)) return true;
  const age = fileAge(path);
  if (age === null || age < expiry) return false;
  remove(path);
  return mkdirOnce(path);
}

// Background jobs: at most one of each kind (the lock), killed after a hard timeout by a watchdog shell.
// NSTask starts each child in its own process group, so Alfred ending the Script Filter doesn't end the job.
// The detached watchdog takes the lock itself (mkdir), so a Script Filter that Alfred kills while spawning
// never leaves a lock without a job behind; the watchdog releases it when the job is killed or crashes.
const HARD_TIMEOUT = { worker: 150, refresh: 60 };
const LOCK_EXPIRY = { worker: 180, refresh: 90 };
const WATCHDOG = 'lock=$1; limit=$2; shift 2; mkdir "$lock" 2>/dev/null || exit 0; "$@" & w=$!; n=0; ' +
  'while kill -0 "$w" 2>/dev/null; do if [ "$n" -ge "$limit" ]; then kill -9 "$w"; break; fi; sleep 1; n=$((n+1)); done; ' +
  'wait "$w" || rmdir "$lock" 2>/dev/null';

function lockPath(args) {
  return `${cacheDir()}/${args[0] === "worker" ? "worker" : "refresh-" + args[1]}.lock`;
}

function spawn(args) {
  const kind = args[0] === "worker" ? "worker" : "refresh";
  const lock = lockPath(args);
  // a job is running: don't start a process that would only find the lock taken
  const age = fileAge(lock);
  if (age !== null && age < LOCK_EXPIRY[kind]) return false;
  if (env("IF_SYNC", "") === "1") {
    if (!acquireLock(lock, LOCK_EXPIRY[kind])) return false;
    // tests: run in-process so results are deterministic
    if (kind === "worker") worker();
    else {
      refresh(args[1]);
      remove(lock);
    }
    return true;
  }
  const script = env("IF_SCRIPT", `${FM.currentDirectoryPath.js}/finder.js`);
  const limit = parseInt(env("IF_HARD_TIMEOUT", ""), 10) || HARD_TIMEOUT[kind]; // tests shorten it
  if (age !== null) remove(lock); // stale: its job was killed without releasing it
  const r = exec("/bin/bash", ["-c", `(${WATCHDOG}) </dev/null >/dev/null 2>&1 &`, "bash", lock, String(limit),
    "/usr/bin/osascript", "-l", "JavaScript", script, ...args]);
  return r.status === 0;
}

function refresh(kind) {
  const d = cacheDir();
  if (kind === "fonts") cachedJSON(FONTS_META, `${d}/fonts.json`, 0, 30, slimFonts);
  if (kind === "svgl") cachedJSON(SVGL, `${d}/svgl.json`, 0, 20, validateSvgl);
  if (kind === "collections") cachedJSON(`${ICONIFY}/collections`, `${d}/collections.json`, 0, 15, validateCollections);
}

// ---------- theme ----------

function darkTheme() {
  const bg = env("alfred_theme_background", "");
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(bg);
  if (m) return 0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3] < 128;
  const style = $.NSUserDefaults.standardUserDefaults.stringForKey("AppleInterfaceStyle");
  return !style.isNil() && style.js === "Dark";
}

function previewColor(c) {
  const v = c.previewColor;
  if (v === "black") return "#000000";
  if (v === "white") return "#ffffff";
  if (v === "grey" || v === "gray") return "#8e8e93";
  return hexColor(v) || (darkTheme() ? "#e5e7eb" : "#374151");
}

// ---------- SVG helpers (pure) ----------

// Parse the attributes of a start tag body, respecting quotes.
function parseAttrs(s) {
  const out = [];
  const re = /([^\s=\/>"']+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const val = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : null;
    out.push({ name: m[1], value: val, quote: m[3] !== undefined ? '"' : m[4] !== undefined ? "'" : "" });
  }
  return out;
}

// Find the end of a tag starting at i ("<"), skipping ">" inside quotes.
function tagEnd(s, i) {
  let q = null;
  for (let j = i + 1; j < s.length; j++) {
    const ch = s[j];
    if (q) {
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ">") return j;
  }
  return -1;
}

function stripProlog(svg) {
  return String(svg)
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>\[]*(\[[\s\S]*?\])?\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

const SVG_MAX_BYTES = 2e6;

// Remove what an icon never needs and what could run code or reach the network when the SVG is pasted into a
// page or previewed: scripts, foreignObject (HTML), event handlers, external or javascript: links, CSS
// @import and external url(). Internal references (#id) and embedded raster images stay.
function sanitizeSvg(svg) {
  // no DOCTYPE: its entities could fetch files (SYSTEM) or expand exponentially
  let s = String(svg).replace(/<!DOCTYPE[^>\[]*(\[[\s\S]*?\])?\s*>/gi, "");
  for (const tag of ["script", "foreignObject", "iframe", "embed", "object"]) {
    s = s.replace(new RegExp(`<(?:svg:)?${tag}\\b[^>]*?/>`, "gi"), "")
      .replace(new RegExp(`<((?:svg:)?${tag})\\b[\\s\\S]*?</\\1\\s*>`, "gi"), "")
      .replace(new RegExp(`<(?:svg:)?${tag}\\b[\\s\\S]*$`, "i"), ""); // unclosed: drop the rest
  }
  const safeRef = (v) => /^\s*#/.test(v) || /^\s*data:image\/(png|jpe?g|gif|webp)[;,]/i.test(v);
  let out = "", i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    if (/^<[A-Za-z]/.test(s.slice(lt, lt + 2))) {
      const end = tagEnd(s, lt);
      if (end < 0) {
        out += s.slice(lt);
        break;
      }
      const tag = s.slice(lt, end + 1).replace(/(\s)([^\s=\/>"']+)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g, (m, sp, name, eq, raw) => {
        const val = raw === undefined ? "" : raw.replace(/^["']|["']$/g, "");
        if (/^on/i.test(name)) return "";
        if (/^(xlink:)?href$|^src$/i.test(name) && !safeRef(decodeXml(val))) return "";
        if (/javascript:/i.test(decodeXml(val).replace(/[\s\u0000-\u001f]/g, ""))) return "";
        return m;
      });
      out += tag;
      i = end + 1;
    } else {
      out += "<";
      i = lt + 1;
    }
  }
  // entities declared in a (removed) DOCTYPE are undefined now; CSS in <style> and style="": no @import, no external url()
  return out.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)[\w.:-]+;/gi, "").replace(/@import[^;<]*;?/gi, "").replace(/url\((?!\s*(?:['"]|&quot;|&apos;)?\s*(?:#|data:image\/(?:png|jpe?g|gif|webp)[;,]))[^)]*\)/gi, "none");
}

function decodeXml(v) {
  return String(v).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      const n = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">" }[k];
  });
}

// A complete SVG document: a root element that is closed (catches truncated downloads and HTML error pages)
function isSvg(text) {
  if (typeof text !== "string") return false;
  const s = stripProlog(text);
  const root = svgRoot(s);
  return !!root && root.start === 0 && (root.selfClosing || /<\/svg\s*>\s*$/i.test(s));
}

// The root <svg …> start tag: { start, end, attrs, selfClosing }
function svgRoot(svg) {
  const m = /<svg[\s>\/]/i.exec(svg);
  if (!m) return null;
  const end = tagEnd(svg, m.index);
  if (end < 0) return null;
  let body = svg.slice(m.index + 4, end);
  const selfClosing = /\/\s*$/.test(body);
  if (selfClosing) body = body.replace(/\/\s*$/, "");
  return { start: m.index, end: end + 1, attrs: parseAttrs(body), selfClosing };
}

function getAttr(root, name) {
  const a = root.attrs.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return a ? a.value : null;
}

function attrString(attrs) {
  return attrs
    .map((a) => (a.value === null ? a.name : `${a.name}=${a.quote === "'" || (a.value.includes('"') && !a.value.includes("'")) ? `'${a.value}'` : `"${a.value.replace(/"/g, "&quot;")}"`}`))
    .join(" ");
}

function replaceRoot(svg, root, attrs) {
  return `${svg.slice(0, root.start)}<svg ${attrString(attrs)}${root.selfClosing ? "/" : ""}>${svg.slice(root.end)}`;
}

function lengthPx(v) {
  if (v === null || v === undefined) return null;
  const m = /^\s*([\d.]+(?:e[-+]?\d+)?)\s*(px|pt)?\s*$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]) * (m[2] && m[2].toLowerCase() === "pt" ? 4 / 3 : 1);
  return n > 0 && isFinite(n) ? n : null;
}

// The drawing box: from viewBox, or from numeric width/height. null when unknown.
function svgBox(svg) {
  const root = svgRoot(svg);
  if (!root) return null;
  const vb = getAttr(root, "viewBox");
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every(isFinite) && p[2] > 0 && p[3] > 0) return { x: p[0], y: p[1], w: p[2], h: p[3], viewBox: true };
  }
  const w = lengthPx(getAttr(root, "width")), h = lengthPx(getAttr(root, "height"));
  if (w && h) return { x: 0, y: 0, w, h, viewBox: false };
  return null;
}

const round = (n) => String(Math.round(n * 100) / 100);

// Set explicit width/height (null removes them), adding a viewBox first so the drawing scales.
function sizeSvg(svg, width, height) {
  const root = svgRoot(svg);
  if (!root) return svg;
  const box = svgBox(svg);
  let attrs = root.attrs.filter((a) => !/^(width|height)$/i.test(a.name));
  if (box && !box.viewBox) attrs.push({ name: "viewBox", value: `0 0 ${round(box.w)} ${round(box.h)}`, quote: '"' });
  if (width !== null) {
    // keep xmlns first for readability
    const i = attrs.findIndex((a) => a.name === "xmlns");
    attrs.splice(i + 1, 0, { name: "width", value: round(width), quote: '"' }, { name: "height", value: round(height), quote: '"' });
  }
  return replaceRoot(svg, root, attrs);
}

function aspect(svg) {
  const b = svgBox(svg);
  return b ? b.w / b.h : 1;
}

// The SVG as copied, following the "SVG size" setting: keep, a pixel height (e.g. 24), or none.
function outputSvg(svg, mode) {
  const s = sanitizeSvg(stripProlog(svg));
  if (!svgRoot(s) || !svgBox(s)) return s; // no viewBox or size: setting one would crop the drawing
  if (mode === "none") return sizeSvg(s, null, null);
  const px = parseInt(mode, 10);
  if (px > 0) {
    const a = aspect(s);
    return sizeSvg(s, px * a, px);
  }
  return s;
}

// Replace currentColor (fill, stroke, style, CSS) with a concrete colour for rendering.
function colorize(svg, color) {
  let s = svg.replace(/currentColor/gi, color);
  const root = svgRoot(s);
  // monochrome icons that rely on the default black fill (no fill or stroke anywhere)
  if (root && !/\b(fill|stroke)\s*[=:]/i.test(s) && !/<style/i.test(s)) {
    s = replaceRoot(s, root, root.attrs.concat([{ name: "fill", value: color, quote: '"' }]));
  }
  return s;
}

// AppKit's SVG renderer (CoreSVG) draws 4- and 8-digit hex colours (#RGBA, #RRGGBBAA) as black, and reads an
// integer rgba() alpha of 1 as 1/255: rewrite both as rgba() with a decimal alpha.
const COLOR_PROPS = "fill|stroke|stop-color|flood-color|lighting-color|color";
function rgbaHex(hex) {
  let h = hex.toLowerCase();
  if (h.length === 4) h = h.replace(/./g, "$&$&");
  const v = [0, 2, 4, 6].map((i) => parseInt(h.substr(i, 2), 16));
  return `rgba(${v[0]},${v[1]},${v[2]},${(v[3] / 255).toFixed(3)})`;
}
function normalizeHexAlpha(svg) {
  return svg
    .replace(new RegExp(`\\b(${COLOR_PROPS})(\\s*=\\s*)(["'])\\s*#([0-9a-f]{4}|[0-9a-f]{8})\\s*\\3`, "gi"), (_, n, eq, q, h) => `${n}${eq}${q}${rgbaHex(h)}${q}`)
    .replace(new RegExp(`\\b(${COLOR_PROPS})(\\s*:\\s*)#([0-9a-f]{4}|[0-9a-f]{8})\\b`, "gi"), (_, n, c, h) => `${n}${c}${rgbaHex(h)}`)
    .replace(/(rgba\(\s*[\d.%]+\s*,\s*[\d.%]+\s*,\s*[\d.%]+\s*,\s*)1\s*\)/gi, "$11.0)");
}

// The SVG prepared for rasterising into a box of maxW × maxH pixels: { svg, w, h }
function renderableSvg(svg, maxW, maxH, color) {
  let s = normalizeHexAlpha(sanitizeSvg(stripProlog(svg)));
  if (color) s = colorize(s, color);
  const a = aspect(s);
  let w = maxW, h = maxW / a;
  if (h > maxH) {
    h = maxH;
    w = maxH * a;
  }
  return { svg: svgBox(s) ? sizeSvg(s, w, h) : s, w, h };
}

// ---------- SVG → JSX ----------

const JSX_SPECIAL = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", crossorigin: "crossOrigin",
  "xlink:href": "xlinkHref", "xlink:title": "xlinkTitle", "xlink:role": "xlinkRole", "xlink:arcrole": "xlinkArcrole",
  "xlink:show": "xlinkShow", "xlink:actuate": "xlinkActuate", "xlink:type": "xlinkType",
  "xml:space": "xmlSpace", "xml:lang": "xmlLang", "xml:base": "xmlBase", "xmlns:xlink": "xmlnsXlink",
};

function camel(s) {
  return s.replace(/[-:]([a-z0-9])/gi, (_, c) => c.toUpperCase());
}

// JSX attribute name, or null to drop it (editor namespaces, event handlers)
function jsxAttrName(n) {
  const lower = n.toLowerCase();
  if (own(JSX_SPECIAL, lower)) return JSX_SPECIAL[lower];
  if (/^on/i.test(n)) return null;
  if (/^(data|aria)-/i.test(n)) return lower;
  if (n.includes(":")) return null; // sodipodi:*, inkscape:*, xmlns:foo …
  return camel(n);
}

// Split CSS declarations on ";" outside quotes and parentheses (data: URLs contain ";")
function cssDeclarations(css) {
  const out = [];
  let depth = 0, q = null, cur = "";
  for (const ch of css) {
    if (q) {
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((d) => d.trim()).filter(Boolean);
}

function styleObject(css) {
  const parts = [];
  for (const d of cssDeclarations(css)) {
    const i = d.indexOf(":");
    if (i < 1) continue;
    const prop = d.slice(0, i).trim(), value = d.slice(i + 1).trim();
    let key;
    if (prop.startsWith("--")) key = JSON.stringify(prop);
    else {
      key = prop.toLowerCase().replace(/^-ms-/, "ms-").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) key = JSON.stringify(key);
    }
    parts.push(`${key}: ${JSON.stringify(value)}`);
  }
  return `{{ ${parts.join(", ")} }}`;
}

function jsxText(t) {
  return t.replace(/[{}]/g, (c) => `{'${c}'}`).replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
}

function componentName(name) {
  const base = String(name)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  if (!base) return "Icon";
  return /^[0-9]/.test(base) ? "Icon" + base : base;
}

function svgToJsx(svg, name) {
  const s = stripProlog(svg);
  let out = "", i = 0, skip = 0, rootDone = false;
  while (i < s.length) {
    if (s.startsWith("<![CDATA[", i)) {
      const end = s.indexOf("]]>", i);
      const text = s.slice(i + 9, end < 0 ? s.length : end);
      if (!skip) out += "{`" + text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`}";
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    if (s[i] === "<") {
      const end = tagEnd(s, i);
      if (end < 0) break;
      const raw = s.slice(i + 1, end);
      i = end + 1;
      if (raw[0] === "!" || raw[0] === "?") continue;
      if (raw[0] === "/") {
        const tag = raw.slice(1).trim();
        if (skip) {
          skip--;
          continue;
        }
        out += `</${tag.replace(/^svg:/i, "")}>`;
        continue;
      }
      const selfClosing = /\/\s*$/.test(raw);
      const body = selfClosing ? raw.replace(/\/\s*$/, "") : raw;
      const tag = /^[^\s\/>]+/.exec(body)[0];
      if (skip || (tag.includes(":") && !/^svg:/i.test(tag)) || /^script$/i.test(tag)) {
        if (!selfClosing) skip++;
        continue;
      }
      const attrs = [];
      for (const a of parseAttrs(body.slice(tag.length))) {
        const n = jsxAttrName(a.name);
        if (!n) continue;
        if (a.value === null) attrs.push(n);
        // JS expressions don't decode XML entities (&quot; &amp;): decode them first
        else if (n === "style") attrs.push(`style=${styleObject(decodeXml(a.value))}`);
        else if (a.value.includes('"')) attrs.push(`${n}={${JSON.stringify(decodeXml(a.value))}}`);
        else attrs.push(`${n}="${a.value}"`);
      }
      const isRoot = !rootDone && /^svg$/i.test(tag);
      if (isRoot) {
        rootDone = true;
        attrs.push("{...props}");
      }
      out += `<${tag.replace(/^svg:/i, "")}${attrs.length ? " " + attrs.join(" ") : ""}${selfClosing ? " />" : ">"}`;
      if (!selfClosing && /^style$/i.test(tag)) {
        // CSS: emit as a template literal so braces survive
        const close = s.toLowerCase().indexOf("</style", i);
        const css = s.slice(i, close < 0 ? s.length : close);
        if (!/^\s*<!\[CDATA\[/.test(css)) {
          out += "{`" + css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`}";
          i = close < 0 ? s.length : close;
        }
      }
      continue;
    }
    const next = s.indexOf("<", i);
    const text = s.slice(i, next < 0 ? s.length : next);
    i = next < 0 ? s.length : next;
    if (!skip) out += jsxText(text);
  }
  const comp = componentName(name);
  return `export default function ${comp}(props) {\n  return (\n    ${out.trim()}\n  );\n}\n`;
}

// ---------- data URI ----------

function svgDataUri(svg) {
  let s = stripProlog(svg).replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
  if (!s.includes("'")) s = s.replace(/"/g, "'");
  s = s.replace(/[%#<>"{}|\\^`\[\]]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  s = s.replace(/[^\x20-\x7E]/gu, (c) => encodeURIComponent(c));
  return "data:image/svg+xml," + s;
}

// ---------- rasterising ----------

// Render SVG text to a square PNG of `size` px. tile: null, "light" or "dark" (a rounded background).
// fit: the PNG takes the SVG's proportions instead (longest side = size, no padding), for saved PNGs.
function rasterize(svgText, outPath, size, opts = {}) {
  const pad = opts.fit ? 0 : opts.tile ? size * 0.14 : opts.pad === undefined ? size * 0.04 : opts.pad;
  const r = renderableSvg(svgText, size - 2 * pad, size - 2 * pad, opts.color);
  let W = size, H = size;
  if (opts.fit) {
    W = Math.max(1, Math.round(r.w));
    H = Math.max(1, Math.round(r.h));
  }
  let img = env("IF_FORCE_QLMANAGE", "") === "1" ? null : svgImage(r.svg), quicklook = false;
  if (!img) {
    img = quicklookImage(r.svg, Math.round(size - 2 * pad));
    quicklook = true;
  }
  if (!img) return false;
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, W, H, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  if (rep.isNil()) return false;
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  if (opts.tile) {
    const bg = opts.tile === "dark" ? [0.11, 0.11, 0.12] : [0.96, 0.96, 0.97];
    $.NSColor.colorWithSRGBRedGreenBlueAlpha(bg[0], bg[1], bg[2], 1).setFill;
    const inset = size * 0.03;
    $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(inset, inset, size - 2 * inset, size - 2 * inset), size * 0.18, size * 0.18).fill;
  }
  let from = $.NSZeroRect;
  if (quicklook) {
    // the thumbnail is square, with the drawing aspect-fitted and centred: cut out the drawing's own box
    const iw = img.size.width, ih = img.size.height, a = r.w / r.h;
    const sw = a >= iw / ih ? iw : ih * a, sh = a >= iw / ih ? iw / a : ih;
    from = $.NSMakeRect((iw - sw) / 2, (ih - sh) / 2, sw, sh);
  }
  $.NSGraphicsContext.currentContext.imageInterpolation = $.NSImageInterpolationHigh;
  img.drawInRectFromRectOperationFraction($.NSMakeRect((W - r.w) / 2, (H - r.h) / 2, r.w, r.h), from, $.NSCompositingOperationSourceOver, 1);
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (png.isNil()) return false;
  mkdirp(dirname(outPath));
  return png.writeToFileAtomically(outPath, true);
}

// SVG text → NSImage with AppKit's SVG renderer (CoreSVG). NSImage reads SVG data directly on recent macOS
// (confirmed on 14+); the private _NSSVGImageRep behind it exists since macOS 10.15 (SDWebImageSVGCoder relies on
// it), so it is tried directly before the Quick Look fallback. IF_FORCE_SVGREP=1 (tests) skips NSImage.
function svgImage(svg) {
  const data = $(svg).dataUsingEncoding($.NSUTF8StringEncoding);
  if (env("IF_FORCE_SVGREP", "") !== "1") {
    const img = $.NSImage.alloc.initWithData(data);
    if (!img.isNil() && img.representations.count > 0) return img;
  }
  const cls = $.NSClassFromString("_NSSVGImageRep");
  if (cls.isNil() || !cls.instancesRespondToSelector("initWithData:")) return null;
  const rep = cls.alloc.initWithData(data);
  if (rep.isNil() || !(rep.size.width > 0) || !(rep.size.height > 0)) return null;
  const img = $.NSImage.alloc.initWithSize(rep.size);
  img.addRepresentation(rep);
  return img;
}

// Last resort when AppKit can't read SVG: Quick Look's thumbnailer. It renders into an opaque white page, so the
// SVG is rendered twice, on white and on black, and the transparency is recovered from the difference
// (alpha = 1 − (white − black), colour = black / alpha). Quick Look lays the SVG out like a web page: a fixed
// width/height would draw it small in a corner, so only the viewBox is kept.
function quicklookImage(svg, size) {
  const dir = `${cacheDir()}/tmp/ql-${hash(svg)}-${$.NSProcessInfo.processInfo.processIdentifier}`;
  mkdirp(dir);
  try {
    let s = svgBox(svg) ? sizeSvg(svg, null, null) : svg;
    const root = svgRoot(s);
    if (!root || root.selfClosing) return null;
    const black = `${s.slice(0, root.end)}<rect x="-100000" y="-100000" width="200000" height="200000" fill="#000" style="fill:#000;stroke:none;opacity:1"/>${s.slice(root.end)}`;
    writeText(`${dir}/w.svg`, s);
    writeText(`${dir}/b.svg`, black);
    exec("/usr/bin/qlmanage", ["-t", "-s", String(Math.max(16, size)), "-o", dir, `${dir}/w.svg`, `${dir}/b.svg`]);
    if (!exists(`${dir}/w.svg.png`) || !exists(`${dir}/b.svg.png`)) return null;
    return matte(`${dir}/w.svg.png`, `${dir}/b.svg.png`);
  } finally {
    remove(dir);
  }
}

// Difference matting with Core Image, without colour management (the maths needs the raw values)
function matte(onWhitePath, onBlackPath) {
  ObjC.import("CoreImage");
  const noCS = $({ [$.kCIImageColorSpace.js]: $.NSNull.null });
  const load = (p) => $.CIImage.imageWithContentsOfURLOptions($.NSURL.fileURLWithPath(p), noCS);
  const white = load(onWhitePath), black = load(onBlackPath);
  if (white.isNil() || black.isNil()) return null;
  const filter = (name, params) => {
    const f = $.CIFilter.filterWithName(name);
    if (f.isNil()) throw new Error(`Core Image filter ${name} is missing`);
    for (const k of Object.keys(params)) f.setValueForKey(params[k], k);
    return f.outputImage;
  };
  const v = (x, y, z, w) => $.CIVector.vectorWithXYZW(x, y, z, w);
  const zero = v(0, 0, 0, 0);
  const diff = filter("CISubtractBlendMode", { inputImage: black, inputBackgroundImage: white }); // 1 − alpha
  const alphaGrey = filter("CIColorMatrix", { inputImage: diff, inputRVector: v(0, -1, 0, 0), inputGVector: v(0, -1, 0, 0),
    inputBVector: v(0, -1, 0, 0), inputAVector: zero, inputBiasVector: v(1, 1, 1, 1) });
  const mask = filter("CIColorMatrix", { inputImage: diff, inputRVector: zero, inputGVector: zero, inputBVector: zero,
    inputAVector: v(0, -1, 0, 0), inputBiasVector: v(0, 0, 0, 1) });
  const colour = filter("CIDivideBlendMode", { inputImage: alphaGrey, inputBackgroundImage: black });
  const out = filter("CIBlendWithAlphaMask", { inputImage: colour, inputBackgroundImage: $.CIImage.emptyImage, inputMaskImage: mask });
  const ctx = $.CIContext.contextWithOptions($({ [$.kCIContextWorkingColorSpace.js]: $.NSNull.null, [$.kCIContextOutputColorSpace.js]: $.NSNull.null }));
  const cg = ctx.createCGImageFromRect(out, white.extent);
  if (!cg) return null;
  const rep = $.NSBitmapImageRep.alloc.initWithCGImage(cg);
  if (rep.isNil()) return null;
  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(rep.pixelsWide, rep.pixelsHigh));
  img.addRepresentation(rep);
  return img;
}

// ---------- previews: queue, worker, pruning ----------

const PREFIX_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

// Parse an item id: "iconify:<prefix>:<name>" or "svgl:<https url>"
function resolveId(id) {
  const d = cacheDir();
  let m = /^iconify:([a-z0-9-]+):([a-z0-9_-]+)$/.exec(id);
  if (m && PREFIX_RE.test(m[1]) && NAME_RE.test(m[2])) {
    return { kind: "iconify", prefix: m[1], name: m[2], full: `${m[1]}:${m[2]}`, url: iconifyJsonUrl(m[1], [m[2]]),
      svg: `${d}/svg/iconify/${m[1]}/${m[2]}.svg`, key: `iconify/${m[1]}/${m[2]}` };
  }
  m = /^svgl:(https?:\/\/[^\s"\\]+)$/.exec(id);
  if (m && svglFileUrl(m[1])) {
    const url = m[1];
    let base = url.split(/[?#]/)[0].split("/").pop() || "";
    try {
      base = decodeURIComponent(base);
    } catch (e) {
      base = ""; // malformed %-escape: fall back to a hashed name
    }
    base = base.replace(/\.svg$/i, "");
    const file = /^[A-Za-z0-9][\w.-]{0,80}$/.test(base) ? `${base}-${hash(url).slice(0, 6)}` : hash(url);
    return { kind: "svgl", name: base || "logo", full: base || "logo", url, svg: `${d}/svg/svgl/${file}.svg`, key: `svgl/${file}` };
  }
  return null;
}

function previewPath(ref, color, tile) {
  const variant = tile ? `tile-${tile}` : `c${color.slice(1)}`;
  return `${cacheDir()}/png/${variant}/${ref.key}.png`;
}

// Returns the preview path when rendered; otherwise queues the item and returns null.
function previewOrQueue(ref, color, tile, queue) {
  const png = previewPath(ref, color, tile);
  if (exists(png)) return png;
  // the marker before the failure: the worker writes the failure before it removes the marker
  const markAge = fileAge(`${png}.rendering`);
  if (markAge !== null && markAge >= RENDER_HANG) return "failed";
  const failAge = fileAge(`${png}.fail`);
  if (failAge !== null && failAge < TTL.fail) return "failed";
  if (!exists(ref.svg) && backoff(ref.kind)) return "limited";
  queue.push({ url: ref.url, svg: ref.svg, png, color: tile ? (tile === "dark" ? "#ffffff" : "#000000") : color, tile: tile || null,
    iconify: ref.kind === "iconify" ? { prefix: ref.prefix, name: ref.name } : null });
  return null;
}

// Identical queues (the Script Filter reruns while previews render) share one job file.
function enqueue(queue) {
  if (!queue.length) return;
  const text = JSON.stringify(queue);
  writeText(`${cacheDir()}/jobs/${hash(text)}.json`, text);
  spawn(["worker"]);
}

const JOB_MAX_AGE = 120; // a query typed minutes ago no longer matters
const ROUND_MAX = 400; // previews per round, so a round stays well inside the hard timeout

// Pending job files, newest first; old ones are deleted.
function pendingJobs(d) {
  const out = [];
  for (const f of listFiles(`${d}/jobs`)) {
    if (!f.endsWith(".json") || f.includes("/")) continue;
    const p = `${d}/jobs/${f}`;
    const age = fileAge(p);
    if (age === null) continue;
    if (age > JOB_MAX_AGE) remove(p);
    else out.push({ p, age });
  }
  return out.sort((a, b) => a.age - b.age);
}

// Download (in parallel with curl) and render every queued preview, newest request first.
// The caller holds worker.lock; it is released at the end (and taken back if a job arrived meanwhile).
function worker() {
  const d = cacheDir();
  const lock = `${d}/worker.lock`;
  const started = Date.now();
  const budget = (HARD_TIMEOUT.worker - 30) * 1000;
  for (;;) {
    try {
      while (Date.now() - started < budget) {
        touch(lock);
        const jobs = pendingJobs(d);
        if (!jobs.length) break;
        // every pending job in one round (one parallel download), newest first, each preview once
        const seen = Object.create(null);
        const items = [];
        for (const j of jobs) {
          const list = readJSON(j.p);
          remove(j.p);
          for (const it of Array.isArray(list) ? list : []) {
            if (!it || typeof it.png !== "string" || typeof it.svg !== "string" || !it.png.startsWith(d + "/png/") || seen[it.png]) continue;
            seen[it.png] = true;
            items.push(it);
          }
        }
        processJob(items.slice(0, ROUND_MAX), started + budget);
      }
      const pruned = fileAge(`${d}/pruned`);
      if (pruned === null || pruned > 3600) {
        touch(`${d}/pruned`);
        prune();
      }
    } finally {
      remove(lock); // also when rendering throws, so the next keystroke can start a worker
    }
    // a job queued after the last look found the lock still held and didn't start a worker: take it back
    if (Date.now() - started < budget && pendingJobs(d).length && mkdirOnce(lock)) continue;
    return;
  }
}

// Back off from a service after HTTP 429 (3 minutes: svgl locks an IP out for that long), HTTP 403 (1 minute:
// svgl sits behind a Cloudflare challenge that some networks and VPNs trigger) or a network failure (30 seconds),
// instead of marking previews broken, rerunning the Script Filter, or waiting for DNS timeouts on every keystroke.
// Returns false, or the status that caused it (429, 403, or -1 for offline).
function backoff(service) {
  const d = cacheDir();
  const limited = fileAge(`${d}/ratelimited-${service}`);
  if (limited !== null && limited < 180) return 429;
  const blocked = fileAge(`${d}/blocked-${service}`);
  if (blocked !== null && blocked < 60) return 403;
  const offline = fileAge(`${d}/offline-${service}`);
  if (offline !== null && offline < 30) return -1;
  return false;
}
function noteFailure(service, status) {
  const marker = { 429: "ratelimited", 403: "blocked", 0: "offline" }[status];
  if (marker) touch(`${cacheDir()}/${marker}-${service}`);
}
function serviceOf(item) {
  return item.iconify ? "iconify" : "svgl";
}

// deadline: stop rendering then (the Quick Look fallback is slower); the Script Filter's rerun queues the rest again
function processJob(items, deadline) {
  const d = cacheDir();
  const seen = Object.create(null);
  const missing = items.filter((it) => !exists(it.svg) && it.svg.startsWith(d + "/svg/") && (seen[it.svg] ? false : (seen[it.svg] = true)));
  const fetchable = missing.filter((it) => !backoff(serviceOf(it)));
  if (fetchable.length) fetchSvgs(fetchable);
  for (const it of items) {
    if (deadline && Date.now() > deadline) break;
    if (exists(it.png)) continue;
    const fail = `${it.png}.fail`;
    const failAge = fileAge(fail);
    if (failAge !== null && failAge < TTL.fail) continue;
    const svg = readText(it.svg);
    if (svg === null && backoff(serviceOf(it))) continue; // try again later instead of marking it broken
    // An SVG that hangs or crashes the renderer (and gets the worker killed) leaves its marker behind: after
    // RENDER_HANG seconds it counts as broken instead of being retried on every keystroke.
    const mark = `${it.png}.rendering`;
    const markAge = fileAge(mark);
    if (markAge !== null) {
      if (markAge >= RENDER_HANG) {
        touch(fail);
        remove(mark);
      }
      continue;
    }
    touch(mark);
    const ok = isSvg(svg) && rasterize(svg, it.png, 128, { color: it.color, tile: it.tile });
    if (!ok) touch(fail);
    remove(mark);
  }
}

// Iconify: one JSON request per icon set (the per-icon .svg endpoint is rate limited); svgl: one request per file.
function fetchSvgs(items) {
  const d = cacheDir();
  const transfers = [];
  const bySet = new Map();
  for (const it of items) {
    if (it.iconify) {
      if (!bySet.has(it.iconify.prefix)) bySet.set(it.iconify.prefix, []);
      bySet.get(it.iconify.prefix).push(it);
    }
    else if (/^https?:\/\//.test(it.url)) transfers.push({ url: it.url, out: it.svg, svg: true });
  }
  for (const [prefix, list] of bySet) {
    for (const names of iconChunks(prefix, list.map((it) => it.iconify.name))) {
      const chunk = list.filter((it) => names.indexOf(it.iconify.name) >= 0);
      transfers.push({ url: iconifyJsonUrl(prefix, names), out: `${d}/tmp/${prefix}-${hash(names.join(","))}.json`, prefix, items: chunk });
    }
  }
  const status = parallelDownload(transfers);
  transfers.forEach((t, i) => {
    noteFailure(t.prefix ? "iconify" : "svgl", status[i]);
    if (!t.prefix) return;
    const data = status[i] === 200 ? readJSON(t.out) : null;
    remove(t.out);
    if (!data) return;
    for (const it of t.items) {
      const svg = iconSvg(data, it.iconify.name);
      if (svg) writeText(it.svg, sanitizeSvg(svg));
    }
  });
}

// Iconify asks for icon-data URLs under 500 characters (longer ones fail with HTTP 403/414 on some sets),
// with the names sorted so that the same request is cacheable.
const ICONIFY_URL_MAX = 480;
function iconChunks(prefix, names) {
  const sorted = [...new Set(names)].sort();
  const chunks = [];
  let cur = [];
  for (const n of sorted) {
    if (cur.length && iconifyJsonUrl(prefix, cur.concat([n])).length > ICONIFY_URL_MAX) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function iconifyJsonUrl(prefix, names) {
  return `${ICONIFY}/${prefix}.json?icons=${names.map(encodeURIComponent).join(",")}`;
}

// curl --parallel with a config file: one process, many transfers (HTTP/2 multiplexed).
// Returns the HTTP status of each transfer (0 = failed); only 200 responses are kept.
function parallelDownload(list) {
  const d = cacheDir();
  const quote = (s) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const lines = [];
  const index = []; // config order → list index
  list.forEach((x, i) => {
    if (/[\r\n]/.test(x.url + x.out)) return;
    mkdirp(dirname(x.out));
    index.push(i);
    lines.push(`url = ${quote(x.url)}`, `output = ${quote(x.out + ".part")}`);
  });
  const status = list.map(() => 0);
  if (!lines.length) return status;
  const conf = `${d}/tmp/curl-${$.NSProcessInfo.processInfo.processIdentifier}.conf`;
  writeText(conf, lines.join("\n") + "\n");
  const r = exec("/usr/bin/curl", [...CURL_OPTS, "--parallel", "--parallel-immediate", "--parallel-max", "8", "--max-time", "20",
    "--max-filesize", String(SVG_MAX_BYTES), "-w", "%{urlnum} %{http_code}\\n", "-K", conf]);
  remove(conf);
  for (const line of r.out.split("\n")) {
    const m = /^(\d+) (\d+)$/.exec(line.trim());
    if (m && index[+m[1]] !== undefined) status[index[+m[1]]] = +m[2];
  }
  list.forEach((x, i) => {
    const part = x.out + ".part";
    if (status[i] !== 200) return remove(part);
    const t = readText(part);
    if (t !== null && x.svg && isSvg(t)) {
      writeText(x.out, sanitizeSvg(t));
      remove(part);
    } else if (t !== null && !x.svg) move(part, x.out);
    else {
      status[i] = -1;
      remove(part);
    }
  });
  return status;
}

// Build an SVG from Iconify icon data (as the API's .svg endpoint does): aliases, rotate and flips included.
function iconSvg(data, name) {
  if (!data || typeof data !== "object") return null;
  const resolve = (n, depth) => {
    if (depth > 8) return null;
    if (data.icons && data.icons[n] && typeof data.icons[n].body === "string") return Object.assign({}, data.icons[n]);
    const a = data.aliases && data.aliases[n];
    if (!a || typeof a.parent !== "string") return null;
    const p = resolve(a.parent, depth + 1);
    if (!p) return null;
    const r = Object.assign({}, p, a);
    r.rotate = (p.rotate || 0) + (a.rotate || 0);
    r.hFlip = !!p.hFlip !== !!a.hFlip;
    r.vFlip = !!p.vFlip !== !!a.vFlip;
    r.body = p.body;
    delete r.parent;
    return r;
  };
  const icon = resolve(name, 0);
  if (!icon) return null;
  const num = (k, d) => (typeof icon[k] === "number" ? icon[k] : typeof data[k] === "number" ? data[k] : d);
  const box = { left: num("left", 0), top: num("top", 0), width: num("width", 16), height: num("height", 16) };
  let body = icon.body;
  const t = [];
  let rotation = icon.rotate || 0;
  if (icon.hFlip) {
    if (icon.vFlip) rotation += 2;
    else {
      t.push(`translate(${box.width + box.left} ${0 - box.top})`, "scale(-1 1)");
      box.top = box.left = 0;
    }
  } else if (icon.vFlip) {
    t.push(`translate(${0 - box.left} ${box.height + box.top})`, "scale(1 -1)");
    box.top = box.left = 0;
  }
  rotation = ((rotation % 4) + 4) % 4;
  if (rotation === 1) {
    const v = box.height / 2 + box.top;
    t.unshift(`rotate(90 ${v} ${v})`);
  } else if (rotation === 2) t.unshift(`rotate(180 ${box.width / 2 + box.left} ${box.height / 2 + box.top})`);
  else if (rotation === 3) {
    const v = box.width / 2 + box.left;
    t.unshift(`rotate(-90 ${v} ${v})`);
  }
  if (rotation % 2 === 1) {
    [box.left, box.top] = [box.top, box.left];
    [box.width, box.height] = [box.height, box.width];
  }
  if (t.length) body = `<g transform="${t.join(" ")}">${body}</g>`;
  const w = box.width === box.height ? "1em" : `${Math.ceil((box.width / box.height) * 100) / 100}em`;
  const xlink = /xlink:/.test(body) ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : "";
  return `<svg xmlns="http://www.w3.org/2000/svg"${xlink} width="${w}" height="1em" viewBox="${box.left} ${box.top} ${box.width} ${box.height}">${body}</svg>`;
}

// Keep previews and SVGs under the configured size: delete the oldest files first, down to 80 %.
function prune(limitMB) {
  const d = cacheDir();
  const limit = (limitMB || cfg().cacheLimitMB) * 1024 * 1024;
  const files = [];
  let total = 0;
  for (const dir of ["png", "svg"]) {
    for (const rel of listFiles(`${d}/${dir}`)) {
      const p = `${d}/${dir}/${rel}`;
      const a = attrs(p);
      if (!a || a.fileType.js !== "NSFileTypeRegular") continue; // symlinks are never followed or deleted
      if (/\.(fail|rendering)$/.test(rel)) {
        if (-a.fileModificationDate.timeIntervalSinceNow > TTL.fail) remove(p); // expired markers
        continue;
      }
      const size = Number(a.fileSize) || 0; // JXA bridges unsigned long long as a string
      files.push({ p, size, t: a.fileModificationDate.timeIntervalSince1970 });
      total += size;
    }
  }
  if (total > limit) {
    files.sort((a, b) => a.t - b.t);
    for (const f of files) {
      if (total <= limit * 0.8) break;
      remove(f.p);
      total -= f.size;
    }
  }
  // old search results (at most MAX_SEARCHES, none older than a month) and leftovers
  for (const dir of ["search", "tmp", "jobs"]) {
    const list = listFiles(`${d}/${dir}`).map((rel) => ({ p: `${d}/${dir}/${rel}`, age: fileAge(`${d}/${dir}/${rel}`) }))
      .filter((f) => f.age !== null).sort((a, b) => a.age - b.age);
    const max = dir === "search" ? TTL.stale : 3600;
    list.forEach((f, i) => {
      if (f.age > max || (dir === "search" && i >= MAX_SEARCHES)) remove(f.p);
    });
  }
  return total;
}

// ---------- Alfred output ----------

function info(title, subtitle, icon = "info", extra = {}) {
  return Object.assign({ title, subtitle: subtitle || "", valid: false, icon: { path: `icons/${icon}.png` } }, extra);
}

function output(items, extra = {}) {
  return JSON.stringify(Object.assign({ skipknowledge: true, items }, extra));
}

function offlineNotice(error, what) {
  return info(error === "No internet connection" ? "Offline: showing saved results" : `${error}: showing saved results`,
    `${what} will update when the connection is back`, "offline");
}

// Script Filter rerun while previews render (capped, and reset for every new query)
// (a throttled or still-loading request is retried after a second, within the same cap)
function rerunFields(query, pending, throttled) {
  if (!pending && !throttled) return {};
  const same = env("if_rerun_query", null) === query;
  const n = same ? parseInt(env("if_reruns", "0"), 10) || 0 : 0;
  if (n >= MAX_RERUNS) return {};
  return { rerun: throttled ? 1 : RERUN_DELAY, variables: { if_rerun_query: query, if_reruns: String(n + 1) } };
}

function folderLabel(c) {
  return c.pngFolder === "desktop" ? "Desktop" : "Downloads";
}
function pngSubtitle(c) {
  return c.pngFolder === "clipboard" ? `Copy a ${c.pngSize} px PNG image` : `Save a ${c.pngSize} px PNG to ${folderLabel(c)}`;
}

// A row for anything backed by an SVG (icons and logos)
function svgRow(o, c) {
  const cached = exists(o.ref.svg);
  const ql = cached ? o.ref.svg : o.web;
  const icon = o.preview && o.preview !== "failed" && o.preview !== "limited" ? { path: o.preview } : { path: `icons/${o.preview === "failed" ? "broken" : o.pending}.png` };
  return {
    title: o.title,
    subtitle: o.subtitle,
    arg: o.id,
    icon,
    quicklookurl: ql,
    action: cached ? { file: o.ref.svg } : { text: o.name }, // Universal Actions on the SVG file
    text: { copy: o.copyName || o.name, largetype: o.copyName || o.name },
    mods: {
      cmd: { arg: o.id, valid: true, subtitle: "Paste the SVG into the frontmost app" },
      alt: { arg: o.id, valid: true, subtitle: `Copy as a JSX component <${componentName(o.name)} />` },
      ctrl: { arg: o.copyName || o.name, valid: true, subtitle: `Copy the name: ${o.copyName || o.name}` },
      shift: { arg: o.id, valid: true, subtitle: pngSubtitle(c) },
      fn: { arg: o.id, valid: true, subtitle: "Copy as a data URI" },
      "cmd+alt": { arg: o.web, valid: true, subtitle: `Open on ${o.site}` },
      "cmd+shift": { arg: o.url, valid: true, subtitle: "Copy the SVG’s URL" },
    },
  };
}

// The public URL of the SVG (⌘⇧↩), for <img src> or CSS. Iconify's API applies the copy colour and SVG size itself.
function svgUrl(ref, c) {
  if (ref.kind !== "iconify") return ref.url;
  const q = [];
  if (c.copyColor) q.push(`color=${encodeURIComponent(c.copyColor)}`);
  if (/^\d+$/.test(c.svgSize)) q.push(`height=${c.svgSize}`);
  return `https://api.iconify.design/${ref.prefix}/${ref.name}.svg${q.length ? "?" + q.join("&") : ""}`;
}

// ---------- recently copied ----------

// Item ids (see resolveId), newest first, in the data folder. Written after every successful action.
const RECENT_MAX = 20;
function recentPath() {
  return `${dataDir()}/recent.json`;
}
function readRecent() {
  const d = readJSON(recentPath());
  return Array.isArray(d) ? d.filter((x) => typeof x === "string" && resolveId(x)) : [];
}
function addRecent(id) {
  if (!cfg().showRecent || !resolveId(id)) return;
  const list = [id].concat(readRecent().filter((x) => x !== id)).slice(0, RECENT_MAX);
  writeText(recentPath(), JSON.stringify(list));
}

// ---------- icons (Iconify) ----------

function collections(fetch) {
  const path = `${cacheDir()}/collections.json`;
  if (!fetch) return readCache(path, validateCollections) || {};
  const r = backgroundList("collections", `${ICONIFY}/collections`, path, TTL.collections, 15, validateCollections);
  return r.data || {};
}

function validateCollections(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("bad collections");
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (PREFIX_RE.test(k) && v && typeof v === "object") {
      out[k] = { name: clean(v.name || k) || k, total: v.total | 0, license: v.license && v.license.title ? clean(v.license.title) : "",
        category: v.category ? clean(v.category) : "", palette: !!v.palette, hidden: !!v.hidden };
    }
  }
  if (!Object.keys(out).length) throw new Error("no collections");
  return out;
}

// "arrow @lucide set:tabler,mdi @all" → { text, sets, all, partial }
function parseIconQuery(query) {
  const raw = String(query).replace(/[\u0000-\u001f]/g, " ");
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const sets = [], words = [];
  let all = false, partial = null;
  tokens.forEach((t, i) => {
    const m = /^(?:@|set:)(.*)$/i.exec(t);
    if (!m) return words.push(t);
    const names = m[1].toLowerCase().split(",").filter(Boolean);
    if (!names.length && i === tokens.length - 1 && !/\s$/.test(raw)) partial = "";
    for (const n of names) {
      if (n === "all") all = true;
      else if (PREFIX_RE.test(n)) sets.push(n);
    }
    if (names.length && i === tokens.length - 1 && !/\s$/.test(raw) && names[names.length - 1] !== "all") partial = names[names.length - 1];
  });
  const text = words.join(" ");
  const exact = /^([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:[-_][a-z0-9]+)*)$/.exec(text.toLowerCase());
  return { text, sets: [...new Set(sets)], all, partial, exact: exact && !sets.length ? { prefix: exact[1], name: exact[2] } : null };
}

function setSuggestions(q, c, query) {
  const coll = collections(true);
  const p = (q.partial || "").toLowerCase();
  const before = query.replace(/\S*$/, "");
  let entries = Object.entries(coll).filter(([k, v]) => !v.hidden);
  if (p) {
    entries = entries.filter(([k, v]) => k.startsWith(p) || v.name.toLowerCase().includes(p));
    entries.sort((a, b) => (b[0] === p) - (a[0] === p) || b[0].startsWith(p) - a[0].startsWith(p) || b[1].total - a[1].total);
  } else {
    const rank = (k) => (c.sets.indexOf(k) < 0 ? c.sets.length : c.sets.indexOf(k));
    entries.sort((a, b) => rank(a[0]) - rank(b[0]) || b[1].total - a[1].total);
  }
  const items = entries.slice(0, 30).map(([k, v]) =>
    info(`${v.name}  @${k}`, `${v.total.toLocaleString("en-US")} icons${v.category ? " · " + v.category : ""}${v.license ? " · " + v.license : ""} · ↩ Search this set`, "set", {
      valid: false, autocomplete: `${before}@${k} `,
    }));
  if (!Object.keys(coll).length) items.push(info("Couldn’t load the list of icon sets", "Check your internet connection, or type the set’s prefix, like @mdi", "offline"));
  else if (!items.length) items.push(info("No matching icon set", `Nothing matches “${clean(p)}”. Type @ to list every set`, "info"));
  const all = info("All icon sets  @all", "Search every set, ignoring the preferred sets", "set", { autocomplete: `${before}@all ` });
  if (!p || "all".startsWith(p)) items.push(all);
  return items;
}

// The icon name as copied with ⌃↩, following the "Copy names as" setting
function iconName(prefix, name, format) {
  if (format === "class") return `i-${prefix}-${name}`; // UnoCSS / Tailwind CSS (@iconify/tailwind) classes
  if (format === "component") return `<Icon icon="${prefix}:${name}" />`; // Iconify for React, Vue and Svelte
  if (format === "pascal") return componentName(`${prefix}:${name}`);
  return `${prefix}:${name}`;
}

function iconRow(prefix, name, coll, c, color, queue) {
  const ref = resolveId(`iconify:${prefix}:${name}`);
  if (!ref) return null;
  const set = own(coll, prefix) || {};
  const preview = previewOrQueue(ref, color, null, queue);
  return svgRow({
    id: `iconify:${prefix}:${name}`,
    name: `${prefix}:${name}`,
    copyName: iconName(prefix, name, c.nameFormat),
    title: name,
    subtitle: [set.name || prefix, `${prefix}:${name}`, set.license].filter(Boolean).join(" · "),
    ref, preview, pending: "pending", url: svgUrl(ref, c),
    web: `https://icon-sets.iconify.design/${prefix}/${name}/`,
    site: "icon-sets.iconify.design",
  }, c);
}

// Offline fallback: icons whose SVG is already cached and whose name matches the words
function cachedIconSearch(q, prefixes, limit) {
  const words = q.text.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const rel of listFiles(`${cacheDir()}/svg/iconify`)) {
    const m = /^([^/]+)\/([^/]+)\.svg$/.exec(rel);
    if (!m) continue;
    if (prefixes.length && prefixes.indexOf(m[1]) < 0) continue;
    const full = `${m[1]}:${m[2]}`;
    if (words.every((w) => full.includes(w))) out.push(full);
    if (out.length >= limit) break;
  }
  return out;
}

function iconItems(query) {
  const c = cfg();
  const q = parseIconQuery(query);
  const color = previewColor(c);
  const queue = [];
  // "@luc": still typing a set name (an exact set name followed by more text searches)
  if (q.partial !== null) {
    const coll = q.partial === "" || !q.text ? null : collections(true);
    if (!coll || (Object.keys(coll).length && !own(coll, q.partial))) return { items: setSuggestions(q, c, query) };
  }
  if (!q.text) {
    const scope = q.sets.length ? q.sets.map((s) => "@" + s).join(" ") : q.all || !c.setsOnly || !c.sets.length ? "every set" : c.sets.map((s) => "@" + s).join(" ");
    const items = [
      info("Search icons", `Type a name to search ${scope}: 200,000+ open source icons from Iconify`, "search"),
      info("Filter by icon set", "Type @ and a set name, like “@lucide arrow” or “set:mdi home”", "set", { autocomplete: `${query.trim() ? query.trim() + " " : ""}@` }),
    ];
    // recently copied icons (in the chosen sets), so the ones you use often are one keystroke away
    if (c.showRecent) {
      const coll = collections(false);
      for (const id of readRecent()) {
        const ref = resolveId(id);
        if (ref.kind !== "iconify" || (q.sets.length && q.sets.indexOf(ref.prefix) < 0)) continue;
        const row = iconRow(ref.prefix, ref.name, coll, c, color, queue);
        if (row) items.push(Object.assign(row, { subtitle: `Recently copied · ${row.subtitle}` }));
      }
    }
    enqueue(queue);
    return { items, extra: rerunFields(query, queue.length) };
  }
  const coll = collections(false);
  // "mdi:home" jumps to that icon, unless "mdi" isn't an icon set ("c:drive" is searched instead)
  const known = q.exact ? collections(true) : {};
  if (q.exact && (!Object.keys(known).length || own(known, q.exact.prefix))) {
    const row = iconRow(q.exact.prefix, q.exact.name, coll, c, color, queue);
    enqueue(queue);
    return { items: [row], extra: rerunFields(query, queue.length) };
  }
  const prefixes = q.sets.length ? q.sets : c.setsOnly && !q.all ? c.sets : [];
  const params = [`query=${encodeURIComponent(q.text)}`, `limit=${c.limit}`];
  if (prefixes.length) params.push(`prefixes=${prefixes.map(encodeURIComponent).join(",")}`);
  const url = `${ICONIFY}/search?${params.join("&")}`;
  const r = cachedJSON(url, `${cacheDir()}/search/${hash(url.slice(ICONIFY.length))}.json`, TTL.search, 8, validateSearch);
  const items = [];
  let names;
  if (r.data) {
    names = r.data.icons;
    Object.assign(coll, r.data.collections || {});
  } else {
    names = cachedIconSearch(q, prefixes, c.limit);
  }
  if (!q.sets.length && c.sets.length) {
    // preferred sets first, keeping Iconify's order otherwise
    const rank = (n) => {
      const i = c.sets.indexOf(n.split(":")[0]);
      return i < 0 ? c.sets.length : i;
    };
    names = names.map((n, i) => [n, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
  }
  for (const full of names) {
    const [prefix, name] = full.split(":");
    const row = iconRow(prefix, name, coll, c, color, queue);
    if (row) items.push(row);
  }
  if (r.throttled && !items.length) {
    items.push(info("Searching…", r.error, "pending"));
  } else if (r.error) {
    if (!items.length) {
      items.push(info(r.error === "No internet connection" ? "Can’t reach Iconify" : "Couldn’t search Iconify", r.error === "No internet connection" ? "Check your internet connection" : r.error, r.error === "No internet connection" ? "offline" : "error"));
    } else if (!r.throttled) items.push(offlineNotice(r.error, "Icon results"));
  } else if (!items.length) {
    const where = prefixes.length ? ` in ${prefixes.map((p) => (own(coll, p) ? coll[p].name : "@" + p)).join(", ")}` : "";
    items.push(info("No icons found", `Nothing matches “${clean(q.text)}”${where}. Try another word${prefixes.length ? " or @all" : ""}`, "info"));
  }
  enqueue(queue);
  return { items, extra: rerunFields(query, queue.length, r.throttled) };
}

function validateSearch(d) {
  if (!d || !Array.isArray(d.icons)) throw new Error("bad search");
  const icons = d.icons.filter((n) => typeof n === "string" && /^[a-z0-9-]+:[a-z0-9_-]+$/.test(n));
  const coll = Object.create(null);
  for (const [k, v] of Object.entries(d.collections || {})) {
    if (PREFIX_RE.test(k) && v) coll[k] = { name: clean(v.name || k) || k, total: v.total | 0, license: v.license && v.license.title ? clean(v.license.title) : "" };
  }
  return { icons, collections: coll, total: d.total | 0 };
}

// ---------- logos (svgl + Simple Icons) ----------

function validateSvgl(d) {
  if (!Array.isArray(d)) throw new Error("bad svgl");
  const variants = (v) => {
    if (typeof v === "string") return svglFileUrl(v) ? { default: v } : null;
    if (v && typeof v === "object") {
      const o = {};
      if (svglFileUrl(v.light)) o.light = v.light;
      if (svglFileUrl(v.dark)) o.dark = v.dark;
      return Object.keys(o).length ? o : null;
    }
    return null;
  };
  const out = [];
  for (const x of d) {
    if (!x || typeof x.title !== "string" || !clean(x.title)) continue;
    const route = variants(x.route);
    if (!route) continue;
    out.push({ title: clean(x.title), category: [].concat(x.category || []).map(clean).filter(Boolean), route, wordmark: variants(x.wordmark),
      url: typeof x.url === "string" ? x.url : "", brandUrl: typeof x.brandUrl === "string" ? x.brandUrl : "" });
  }
  if (!out.length) throw new Error("empty svgl");
  return out;
}

function fold(s) {
  return String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// 0 = exact, 1 = prefix, 2 = word prefix, 3 = substring, 4 = other field; null = no match
function matchScore(name, words, extra) {
  const n = fold(name);
  const q = words.join(" ");
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  const tokens = n.split(/[^a-z0-9]+/);
  if (words.every((w) => tokens.some((t) => t.startsWith(w)))) return 2;
  if (words.every((w) => n.includes(w))) return 3;
  if (extra && words.every((w) => fold(extra).includes(w))) return 4;
  return null;
}

// Every file of an svgl entry, the variant that suits the Alfred theme first: [{ url, label, tile }]
function logoVariants(x, dark) {
  const out = [];
  for (const [key, label] of [["route", ""], ["wordmark", "Wordmark"]]) {
    const v = x[key];
    if (!v) continue;
    if (v.default) out.push({ url: v.default, label, tile: null });
    const order = dark ? ["dark", "light"] : ["light", "dark"];
    for (const t of order) if (v[t]) out.push({ url: v[t], label: [label, t === "light" ? "Light" : "Dark"].filter(Boolean).join(" "), tile: t });
  }
  return out;
}

function logoRow(x, v, c, queue) {
  const ref = resolveId(`svgl:${v.url}`);
  if (!ref) return null;
  const slug = fold(x.title).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "logo";
  const variant = v.label.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
  return svgRow({
    id: `svgl:${v.url}`,
    name: variant ? `${slug}-${variant}` : slug,
    title: v.label ? `${x.title} · ${v.label}` : x.title,
    subtitle: [x.category.join(", "), "svgl", v.tile ? `for ${v.tile} backgrounds` : ""].filter(Boolean).join(" · "),
    ref, preview: previewOrQueue(ref, previewColor(c), v.tile, queue), pending: "logo", url: ref.url,
    web: `https://svgl.app/?search=${encodeURIComponent(x.title)}`,
    site: "svgl.app",
  }, c);
}

function logoItems(query) {
  const c = cfg();
  const queue = [];
  const words = fold(query).replace(/[\u0000-\u001f]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    const items = [info("Search logos", "Type a brand name: 600+ SVG logos from svgl, plus Simple Icons", "logo")];
    if (c.showRecent) {
      const list = readCache(`${cacheDir()}/svgl.json`, validateSvgl) || [];
      const coll = collections(false);
      for (const id of readRecent()) {
        const ref = resolveId(id);
        let row = null;
        if (ref.kind === "iconify" && (ref.prefix === "simple-icons" || ref.prefix === "logos")) row = iconRow(ref.prefix, ref.name, coll, c, previewColor(c), queue);
        else if (ref.kind === "svgl") {
          // the logo's name and variant come from the cached svgl list
          for (const x of list) {
            const v = logoVariants(x, false).find((y) => y.url === ref.url);
            if (v) {
              row = logoRow(x, v, c, queue);
              break;
            }
          }
        }
        if (row) items.push(Object.assign(row, { subtitle: `Recently copied · ${row.subtitle}` }));
      }
    }
    enqueue(queue);
    return { items, extra: rerunFields(query, queue.length) };
  }
  const r = backgroundList("svgl", SVGL, `${cacheDir()}/svgl.json`, TTL.svgl, 20, validateSvgl);
  const list = r.data || [];
  const scored = [];
  list.forEach((x, i) => {
    const s = matchScore(x.title, words, x.category.join(" "));
    if (s !== null) scored.push([s, i, x]);
  });
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const items = [];
  const dark = darkTheme();
  for (const [, , x] of scored.slice(0, 25)) {
    for (const v of logoVariants(x, dark)) {
      const row = logoRow(x, v, c, queue);
      if (row) items.push(row);
    }
  }
  // Simple Icons and Iconify's colour logos when svgl has little
  let si = { data: null };
  if (scored.length < 5) {
    const url = `${ICONIFY}/search?query=${encodeURIComponent(words.join(" "))}&limit=32&prefixes=simple-icons,logos`;
    si = cachedJSON(url, `${cacheDir()}/search/${hash(url.slice(ICONIFY.length))}.json`, TTL.search, 8, validateSearch);
    const coll = Object.assign(collections(false), (si.data && si.data.collections) || {});
    for (const full of (si.data ? si.data.icons : []).slice(0, 20)) {
      const [prefix, name] = full.split(":");
      const row = iconRow(prefix, name, coll, c, previewColor(c), queue);
      if (row) items.push(row);
    }
  }
  const error = r.error || si.error;
  const offline = error === "No internet connection";
  const throttled = !!(r.throttled || si.throttled);
  if (!items.length && throttled) items.push(info("Searching…", error, "pending"));
  else if (!items.length) {
    if (error) items.push(info(offline ? `Can’t reach ${r.error === "No internet connection" ? "svgl" : "Iconify"}` : "Couldn’t load logos", offline ? "Check your internet connection" : error, offline ? "offline" : "error"));
    else items.push(info("No logos found", `Nothing matches “${clean(query)}” in svgl or Simple Icons`, "info"));
  } else {
    for (const [res, name] of [[r, "svgl"], [si, "Simple Icons"]]) {
      if (!res.error || res.throttled) continue;
      if (res.stale) items.push(offlineNotice(res.error, `${name} results`));
      else items.push(info(`Couldn’t load ${name}`, res.error, res.error === "No internet connection" ? "offline" : "error"));
    }
  }
  enqueue(queue);
  return { items, extra: rerunFields(query, queue.length, throttled) };
}

// ---------- fonts (Google Fonts) ----------

function slimFonts(meta) {
  const list = meta && meta.familyMetadataList;
  if (!Array.isArray(list) || !list.length) throw new Error("bad fonts metadata");
  return {
    v: 1,
    fonts: list
      .filter((f) => f && typeof f.family === "string")
      .map((f) => ({
        n: f.family,
        c: String(f.category || ""),
        w: Object.keys(f.fonts || {}).filter((k) => /^\d+i?$/.test(k)),
        a: (f.axes || []).filter((a) => a && /^[A-Za-z]{4}$/.test(a.tag)).map((a) => [a.tag, +a.min, +a.max]),
        p: typeof f.popularity === "number" ? f.popularity : 1e6,
        d: (f.designers || []).slice(0, 2).map(clean),
        s: (f.subsets || []).filter((s) => s !== "menu").map(String),
      })),
  };
}

const FONT_CATEGORIES = {
  serif: "Serif", sans: "Sans Serif", "sans-serif": "Sans Serif", sansserif: "Sans Serif", mono: "Monospace",
  monospace: "Monospace", code: "Monospace", display: "Display", handwriting: "Handwriting", hand: "Handwriting", script: "Handwriting",
};

function parseFontQuery(query) {
  let q = String(query).replace(/[\u0000-\u001f]/g, " ").trim();
  let category = null;
  const m = /^([a-z-]+):\s*(.*)$/i.exec(q);
  if (m && own(FONT_CATEGORIES, m[1].toLowerCase())) {
    category = FONT_CATEGORIES[m[1].toLowerCase()];
    q = m[2];
  } else if (own(FONT_CATEGORIES, q.toLowerCase())) {
    // a category word alone lists that category, then fonts named after it ("display" → Playfair Display)
    return { category: FONT_CATEGORIES[q.toLowerCase()], words: [], also: fold(q) };
  }
  return { category, words: fold(q).split(/\s+/).filter(Boolean) };
}

// CSS2 API "family=" value: Inter:ital,wght@0,100..900;1,100..900
function css2Family(f) {
  const fam = encodeURIComponent(f.n).replace(/%20/g, "+");
  const up = f.w.filter((k) => !k.endsWith("i")).map(Number).sort((a, b) => a - b);
  const it = f.w.filter((k) => k.endsWith("i")).map((k) => Number(k.slice(0, -1))).sort((a, b) => a - b);
  const axis = f.a.find((a) => a[0] === "wght");
  const range = axis && axis[2] > axis[1] ? `${axis[1]}..${axis[2]}` : null;
  if (!up.length && !it.length && !range) return fam;
  if (!it.length) {
    if (range) return `${fam}:wght@${range}`;
    if (up.length === 1 && up[0] === 400) return fam;
    return `${fam}:wght@${up.join(";")}`;
  }
  const tuples = [];
  if (range) {
    if (up.length) tuples.push(`0,${range}`);
    tuples.push(`1,${range}`);
  } else {
    for (const w of up) tuples.push(`0,${w}`);
    for (const w of it) tuples.push(`1,${w}`);
  }
  if (!range && up.every((w) => w === 400) && it.every((w) => w === 400)) return `${fam}:ital@${up.length ? "0;1" : "1"}`;
  return `${fam}:ital,wght@${tuples.join(";")}`;
}

function cssHref(f) {
  return `https://fonts.googleapis.com/css2?family=${css2Family(f)}&display=swap`;
}

function genericFamily(category) {
  return { Serif: "serif", Monospace: "monospace", Handwriting: "cursive" }[category] || "sans-serif";
}

function nextFontSnippet(f) {
  let id = f.n.replace(/[^A-Za-z0-9]+/g, "_");
  if (/^[0-9]/.test(id)) id = "_" + id;
  const words = f.n.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let v = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join("") || "font";
  if (/^[0-9]/.test(v)) v = "font" + v;
  const subset = f.s.indexOf("latin") >= 0 ? "latin" : f.s[0];
  const opts = [];
  const axis = f.a.find((a) => a[0] === "wght");
  if (!axis) opts.push(`weight: [${[...new Set(f.w.map((k) => k.replace(/i$/, "")))].sort((a, b) => a - b).map((w) => `"${w}"`).join(", ")}]`);
  if (f.w.some((k) => k.endsWith("i"))) opts.push(`style: [${f.w.some((k) => !k.endsWith("i")) ? '"normal", ' : ""}"italic"]`);
  if (subset) opts.push(`subsets: ["${subset}"]`);
  opts.push(`display: "swap"`);
  return `import { ${id} } from "next/font/google";\n\nconst ${v} = ${id}({ ${opts.join(", ")} });\n`;
}

function fontIcon(category) {
  return { Serif: "font-serif", Monospace: "font-mono", Display: "font-display", Handwriting: "font-hand" }[category] || "font";
}

function fontItems(query) {
  const q = parseFontQuery(query);
  const r = backgroundList("fonts", FONTS_META, `${cacheDir()}/fonts.json`, TTL.fonts, 30, slimFonts);
  if (!r.data && r.throttled) return { items: [info("Loading Google Fonts…", "The font list downloads once, then works offline", "pending")], extra: rerunFields(query, 0, true) };
  if (!r.data) {
    const off = r.error === "No internet connection";
    return { items: [info(off ? "Can’t reach Google Fonts" : "Couldn’t load Google Fonts", off ? "Check your internet connection" : r.error, off ? "offline" : "error")] };
  }
  const fonts = r.data.fonts || [];
  const popRank = new Map();
  fonts.slice().sort((a, b) => a.p - b.p).forEach((f, i) => popRank.set(f.n, i + 1));
  let list = fonts.filter((f) => !q.category || f.c === q.category);
  let scored;
  if (q.words.length) {
    scored = [];
    for (const f of list) {
      const s = matchScore(f.n, q.words, f.d.join(" "));
      if (s !== null) scored.push([s, f]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].p - b[1].p);
    list = scored.map((x) => x[1]);
  } else list = list.slice().sort((a, b) => a.p - b.p);
  if (q.also) {
    const named = fonts.filter((f) => f.c !== q.category && matchScore(f.n, [q.also], "") !== null).sort((a, b) => a.p - b.p);
    list = list.concat(named);
  }
  const items = list.slice(0, 50).map((f) => {
    const href = cssHref(f);
    const link = `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="${href}" rel="stylesheet">`;
    const imp = `@import url('${href}');`;
    const family = `font-family: "${f.n}", ${genericFamily(f.c)};`;
    const weights = new Set(f.w.map((k) => k.replace(/i$/, ""))).size;
    const italics = f.w.some((k) => k.endsWith("i"));
    const axis = f.a.find((a) => a[0] === "wght");
    const style = axis && axis[2] > axis[1] ? `variable ${axis[1]}–${axis[2]}` : `${weights} weight${weights === 1 ? "" : "s"}`;
    const specimen = `https://fonts.google.com/specimen/${encodeURIComponent(f.n).replace(/%20/g, "+")}`;
    return {
      title: clean(f.n),
      subtitle: [clean(f.c), style + (italics ? " + italics" : ""), `#${popRank.get(f.n)} most popular`, f.d.length ? `by ${f.d.join(", ")}` : ""].filter(Boolean).join(" · "),
      arg: specimen,
      icon: { path: `icons/${fontIcon(f.c)}.png` },
      quicklookurl: specimen,
      text: { copy: f.n, largetype: link },
      mods: {
        cmd: { arg: link, valid: true, subtitle: "Copy the <link> embed code" },
        alt: { arg: imp, valid: true, subtitle: "Copy the CSS @import" },
        ctrl: { arg: family, valid: true, subtitle: `Copy ${family}` },
        shift: { arg: nextFontSnippet(f), valid: true, subtitle: "Copy the Next.js next/font import" },
        fn: { arg: href, valid: true, subtitle: "Copy the stylesheet URL" },
      },
    };
  });
  if (!items.length) {
    items.push(info("No fonts found", `Nothing matches “${clean(query)}”${q.category ? " in " + q.category : ""}. Categories: serif: sans: mono: display: handwriting:`, "info"));
  }
  if (r.stale && r.error && !r.throttled) items.push(offlineNotice(r.error, "The font list"));
  return { items };
}

// What each transform writes to the cache (see readCache)
const isObj = (d) => !!d && typeof d === "object" && !Array.isArray(d);
const isStrings = (a) => Array.isArray(a) && a.every((x) => typeof x === "string");
const CACHE_SHAPES = new Map([
  [validateCollections, (d) => isObj(d) && Object.values(d).every((v) => isObj(v) && typeof v.name === "string" && typeof v.total === "number")],
  [validateSearch, (d) => isObj(d) && isStrings(d.icons) && d.icons.every((n) => /^[a-z0-9-]+:[a-z0-9_-]+$/.test(n)) && isObj(d.collections)
    && Object.values(d.collections).every((v) => isObj(v) && typeof v.name === "string")],
  [validateSvgl, (d) => Array.isArray(d) && d.every((x) => isObj(x) && typeof x.title === "string" && isStrings(x.category) && isObj(x.route)
    && (x.wordmark === null || isObj(x.wordmark)))],
  [slimFonts, (d) => isObj(d) && d.v === 1 && Array.isArray(d.fonts) && d.fonts.every((f) => isObj(f) && typeof f.n === "string"
    && typeof f.c === "string" && isStrings(f.w) && Array.isArray(f.a) && f.a.every(Array.isArray) && typeof f.p === "number" && isStrings(f.d) && isStrings(f.s))],
]);

// ---------- actions ----------

function notify(message) {
  if (TESTING) {
    $.NSFileHandle.fileHandleWithStandardError.writeData($(`notify: ${message}\n`).dataUsingEncoding($.NSUTF8StringEncoding));
    return;
  }
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  app.displayNotification(message, { withTitle: "Icon & Font Finder" });
}

function loadSvg(ref) {
  let svg = readText(ref.svg);
  if (!isSvg(svg)) {
    let status;
    if (ref.kind === "iconify") {
      const r = getJSON(ref.url, 10);
      status = r.status;
      noteFailure("iconify", status);
      const built = r.data ? iconSvg(r.data, ref.name) : null;
      if (r.data && !built) return { error: `${ref.full} doesn’t exist` };
      if (built) writeText(ref.svg, sanitizeSvg(built));
    } else {
      status = download(ref.url, ref.svg, 10, SVG_MAX_BYTES);
      noteFailure("svgl", status);
    }
    svg = status === 200 ? readText(ref.svg) : null;
    if (svg === null) return { error: httpError(status, ref.kind === "iconify" ? "iconify" : "svgl") };
    if (!isSvg(svg)) {
      remove(ref.svg);
      return { error: "The download is not an SVG" };
    }
    if (ref.kind === "svgl") writeText(ref.svg, (svg = sanitizeSvg(svg)));
  }
  return { svg: sanitizeSvg(svg) };
}

// Put a PNG on the clipboard as PNG and TIFF (some apps only read TIFF images). Tests use a private pasteboard.
function copyImage(png) {
  const pb = TESTING ? $.NSPasteboard.pasteboardWithName(env("IF_PASTEBOARD", "io.github.x-o-r-r-o.icon-finder.test")) : $.NSPasteboard.generalPasteboard;
  const rep = $.NSBitmapImageRep.imageRepWithData(png);
  if (rep.isNil()) return false;
  pb.clearContents;
  const okPng = pb.setDataForType(png, $.NSPasteboardTypePNG);
  const tiff = rep.TIFFRepresentation;
  if (!tiff.isNil()) pb.setDataForType(tiff, $.NSPasteboardTypeTIFF);
  return !!okPng;
}

function uniquePath(dir, base, ext) {
  let p = `${dir}/${base}.${ext}`;
  for (let i = 2; exists(p) && i < 1000; i++) p = `${dir}/${base}-${i}.${ext}`;
  return p;
}

function action(mode, id) {
  const c = cfg();
  if (["svg", "jsx", "datauri", "png"].indexOf(mode) < 0) {
    notify(`Unknown action ${mode}`);
    return "";
  }
  const ref = resolveId(id);
  if (!ref) {
    notify("Unknown item");
    return "";
  }
  const r = loadSvg(ref);
  if (r.error) {
    notify(`Couldn’t get ${ref.full}: ${r.error}`);
    return "";
  }
  // "Colour of copied icons": currentColor (and the default black of plain monochrome icons) becomes that colour.
  // A data URI in a CSS background can't inherit currentColor, so this is how those get a colour.
  let svg = outputSvg(r.svg, c.svgSize);
  if (c.copyColor && mode !== "png") svg = colorize(svg, c.copyColor);
  addRecent(id);
  switch (mode) {
    case "svg": return svg;
    case "jsx": return svgToJsx(svg, ref.full);
    case "datauri": return svgDataUri(svg);
    case "png": {
      if (c.pngFolder === "clipboard") {
        const tmp = `${cacheDir()}/tmp/clip-${$.NSProcessInfo.processInfo.processIdentifier}.png`;
        const ok = rasterize(r.svg, tmp, c.pngSize, { color: c.pngColor, fit: true });
        const data = ok ? $.NSData.dataWithContentsOfFile(tmp) : $();
        remove(tmp);
        if (!ok || data.isNil() || !copyImage(data)) {
          notify(`Couldn’t render ${ref.full}`);
          return "";
        }
        return `Copied a ${c.pngSize} px PNG of ${ref.full}`;
      }
      const dir = env("IF_PNG_DIR", TESTING ? `${cacheDir()}/out` : `${$.NSHomeDirectory().js}/${folderLabel(c)}`);
      mkdirp(dir);
      const base = ref.full.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "icon";
      const out = uniquePath(dir, `${base}-${c.pngSize}`, "png");
      if (!rasterize(r.svg, out, c.pngSize, { color: c.pngColor, fit: true })) {
        notify(`Couldn’t render ${ref.full}`);
        return "";
      }
      if (!TESTING) $.NSWorkspace.sharedWorkspace.activateFileViewerSelectingURLs($([$.NSURL.fileURLWithPath(out)]));
      return `Saved ${out.split("/").pop()} to ${dir.split("/").pop()}`;
    }
  }
  return "";
}

// ---------- test hooks (pure functions, only with IF_TEST=1) ----------

const TESTABLE = { sanitizeSvg, decodeXml, iconChunks, allowRequest, svgToJsx, normalizeHexAlpha, isSvg, svgDataUri, outputSvg, renderableSvg, colorize, svgBox, parseIconQuery, parseFontQuery, css2Family,
  nextFontSnippet, slimFonts, iconSvg, validateSvgl, validateSearch, componentName, styleObject, matchScore, resolveId, hash, prune,
  rasterize: (svg, out, size, opts) => rasterize(svg, out, size, opts) };

function writeOut(s) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(s).dataUsingEncoding($.NSUTF8StringEncoding));
}

function run(argv) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "icon":
      case "logo":
      case "font": {
        const query = rest.join(" ");
        const r = { icon: iconItems, logo: logoItems, font: fontItems }[cmd](query);
        writeOut(output(r.items, r.extra || {}));
        return;
      }
      case "action":
        writeOut(action(rest[0], rest.slice(1).join(" ")));
        return;
      case "worker":
        worker();
        return;
      case "refresh":
        try {
          refresh(rest[0]);
        } finally {
          remove(lockPath(["refresh", rest[0]]));
        }
        return;
      case "test":
        if (!TESTING || !own(TESTABLE, rest[0])) throw new Error("test hooks are disabled");
        writeOut(JSON.stringify({ result: TESTABLE[rest[0]](...JSON.parse(rest[1] || "[]")) }));
        return;
    }
    throw new Error(`Unknown command ${cmd}`);
  } catch (e) {
    if (cmd === "action") {
      notify(`Error: ${e.message}`);
      return;
    }
    writeOut(output([info("Something went wrong", String(e.message || e), "error")]));
  }
}
