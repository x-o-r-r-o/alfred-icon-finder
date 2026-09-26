#!/usr/bin/env python3
"""Tests for Icon & Font Finder.

Unit tests call the pure JXA functions through the `test` hook (IF_TEST=1); end-to-end tests run the Script
Filters and actions the way Alfred does, against a mock HTTP server that serves the saved API responses in
tests/fixtures (base URLs are overridden with IF_ICONIFY_API, IF_SVGL_API and IF_FONTS_META).
Set IF_LIVE=1 to also run a smoke test against the real APIs.
"""
import json, os, plistlib, re, shutil, struct, subprocess, sys, tempfile, threading, time, unittest, urllib.parse, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
FIX = os.path.join(ROOT, "tests", "fixtures")
LIGHT = "rgba(255,255,255,1.00)"
DARK = "rgba(30,30,30,0.95)"


def fixture(name, text=False):
    with open(os.path.join(FIX, name), "rb") as f:
        data = f.read()
    return data.decode() if text else data


# ---------- mock server ----------

class Mock:
    """Serves fixtures; `mode` injects failures, `hits` counts requests by path."""

    def __init__(self):
        self.hits, self.queries, self.mode = {}, [], {}
        handler = self.handler()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.icons = {}
        for f in os.listdir(FIX):
            m = re.fullmatch(r"iconify_icons_(.+)\.json", f)
            if m:
                self.icons[m.group(1)] = json.loads(fixture(f))
        svgl = json.loads(fixture("svgl_all.json", True).replace("https://svgl.app/library/", self.base + "/svgl/library/"))
        lib = self.base + "/svgl/library/"
        svgl += [{"id": 90001, "title": "Zzcurrent", "category": "Test", "route": {"light": lib + "zzcurrent_light.svg", "dark": lib + "zzcurrent_dark.svg"}},
                 {"id": 90002, "title": "Zztruncated", "category": "Test", "route": lib + "truncated.svg"}]
        self.svgl = json.dumps(svgl)

    def reset(self):
        self.hits.clear()
        self.queries.clear()
        self.mode.clear()

    def count(self, prefix):
        return sum(v for k, v in self.hits.items() if k.startswith(prefix))

    def handler(mock):
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, body, ctype="application/json"):
                body = body.encode() if isinstance(body, str) else body
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                u = urllib.parse.urlparse(self.path)
                q = dict(urllib.parse.parse_qsl(u.query, keep_blank_values=True))
                mock.hits[u.path] = mock.hits.get(u.path, 0) + 1
                mock.queries.append((u.path, q))
                forced = mock.mode.get(u.path.split("/")[1])
                if forced == "garbage":
                    return self.send(200, "<html>not json</html>", "text/html")
                if isinstance(forced, int):
                    return self.send(forced, "error", "text/plain")
                p = u.path
                if p == "/iconify/search":
                    return self.search(q)
                if p == "/iconify/collections":
                    return self.send(200, fixture("iconify_collections.json"))
                m = re.fullmatch(r"/iconify/([a-z0-9-]+)\.json", p)
                if m:
                    return self.icon_data(m.group(1), q.get("icons", "").split(","))
                if p == "/svgl":
                    return self.send(200, mock.svgl)
                m = re.fullmatch(r"/svgl/library/(.+)\.svg", p)
                if m:
                    f = os.path.join(FIX, "svg", f"svgl__{m.group(1)}.svg")
                    if os.path.exists(f):
                        return self.send(200, fixture(f"svg/svgl__{m.group(1)}.svg"), "image/svg+xml")
                    if m.group(1).startswith("notsvg"):
                        return self.send(200, "<html>oops</html>", "text/html")
                    if m.group(1).startswith("truncated"):
                        return self.send(200, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0', "image/svg+xml")
                    if m.group(1).startswith("zzcurrent"):
                        return self.send(200, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="currentColor"/></svg>', "image/svg+xml")
                    return self.send(200, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#e11"/></svg>', "image/svg+xml")
                if p == "/fonts":
                    body = fixture("google_fonts_metadata.json", True)
                    if mock.mode.get("xssi"):
                        body = ")]}'\n" + body
                    return self.send(200, body)
                self.send(404, "Not found", "text/plain")

            def search(self, q):
                query, prefixes = q.get("query", ""), q.get("prefixes", "")
                if not query:
                    return self.send(400, "Bad request", "text/plain")
                if query == "home" and not prefixes:
                    return self.send(200, fixture("iconify_search_home.json"))
                if query == "arrow" and prefixes == "lucide,tabler":
                    return self.send(200, fixture("iconify_search_arrow_lucide_tabler.json"))
                if query == "github" and prefixes == "simple-icons,logos":
                    return self.send(200, fixture("iconify_search_github_logos.json"))
                if query == "broken":
                    return self.send(200, json.dumps({"icons": ["mdi:missing-one", "mdi:home"], "total": 2, "collections": {}}))
                if query == "weird":
                    return self.send(200, json.dumps({"icons": ["mdi:home", "../etc:passwd", "bad", 5, "mdi:ok_name"], "total": 5}))
                icons = []
                if prefixes and query.startswith("demo"):
                    icons = [f"{p}:{query}-demo" for p in prefixes.split(",") if re.fullmatch(r"[a-z0-9-]+", query)]
                return self.send(200, json.dumps({"icons": icons, "total": len(icons), "limit": 64, "start": 0, "collections": {}}))

            def icon_data(self, prefix, names):
                src = mock.icons.get(prefix, {"prefix": prefix, "width": 24, "height": 24, "icons": {}, "aliases": {}})
                out = {"prefix": prefix, "icons": {}, "aliases": {}}
                for k in ("width", "height", "left", "top"):
                    if k in src:
                        out[k] = src[k]
                missing = []
                for n in names:
                    if n in src.get("icons", {}):
                        out["icons"][n] = src["icons"][n]
                    elif n in src.get("aliases", {}):
                        out["aliases"][n] = src["aliases"][n]
                        parent = src["aliases"][n]["parent"]
                        out["icons"][parent] = src["icons"][parent]
                    elif n.startswith("missing"):
                        missing.append(n)
                    else:
                        out["icons"][n] = {"body": '<path fill="currentColor" d="M2 2h20v20H2z"/>'}
                if missing:
                    out["not_found"] = missing
                self.send(200, json.dumps(out))

        return H


MOCK = Mock()
CLOSED = "http://127.0.0.1:9"  # nothing listens: behaves like being offline


# ---------- running the workflow ----------

class Env:
    def __init__(self):
        self.cache = tempfile.mkdtemp(prefix="icon-finder-test-")

    def vars(self, **extra):
        e = dict(os.environ)
        for k in list(e):
            if k.startswith(("IF_", "if_", "icon_", "png_", "svg_", "preview_", "cache_limit")):
                del e[k]
        e.update(alfred_workflow_cache=self.cache, IF_TEST="1", IF_SYNC="1", alfred_theme_background=LIGHT,
                 IF_ICONIFY_API=MOCK.base + "/iconify", IF_SVGL_API=MOCK.base + "/svgl", IF_FONTS_META=MOCK.base + "/fonts",
                 IF_PNG_DIR=os.path.join(self.cache, "out"))
        e.update({k: str(v) for k, v in extra.items()})
        return e

    def run(self, *argv, **extra):
        return subprocess.run(["osascript", "-l", "JavaScript", "./finder.js", *argv], cwd=SRC, env=self.vars(**extra),
                              capture_output=True, text=True, timeout=60)

    def sf(self, kind, query="", **extra):
        out = self.run(kind, query, **extra)
        assert out.returncode == 0, out.stderr
        data = json.loads(out.stdout)
        validate(data)
        return data

    def action(self, mode, ident, **extra):
        return self.run("action", mode, ident, **extra)

    def js(self, fn, *args, **extra):
        out = self.run("test", fn, json.dumps(list(args)), **extra)
        assert out.returncode == 0, out.stderr
        return json.loads(out.stdout)["result"]

    def files(self, sub, suffix=""):
        base = os.path.join(self.cache, sub)
        return sorted(os.path.relpath(os.path.join(d, f), base) for d, _, fs in os.walk(base) for f in fs if f.endswith(suffix))


def validate(data):
    assert isinstance(data.get("items"), list) and data["items"], data
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        if "icon" in it:
            p = it["icon"]["path"]
            assert os.path.exists(p if p.startswith("/") else os.path.join(SRC, p)), p
        if it.get("valid", True) is not False:
            assert "arg" in it, it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, m
    json.dumps(data)


def last_search():
    return [q for p, q in MOCK.queries if p == "/iconify/search"][-1]


def titles(data):
    return [i["title"] for i in data["items"]]


# ---------- PNG inspection ----------

def read_png(path):
    b = open(path, "rb").read()
    assert b[:8] == b"\x89PNG\r\n\x1a\n"
    i, idat, w, h = 8, b"", 0, 0
    while i < len(b):
        n, = struct.unpack(">I", b[i:i + 4])
        t, d = b[i + 4:i + 8], b[i + 8:i + 8 + n]
        i += 12 + n
        if t == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", d[:10])
            assert depth == 8 and ctype == 6, (depth, ctype)
        elif t == b"IDAT":
            idat += d
    raw, stride, rows, prev, p = zlib.decompress(idat), w * 4, [], bytearray(w * 4), 0
    for _ in range(h):
        f, line = raw[p], bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        for x in range(stride):
            a = line[x - 4] if x >= 4 else 0
            up, c = prev[x], (prev[x - 4] if x >= 4 else 0)
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + up) & 255
            elif f == 3:
                line[x] = (line[x] + (a + up) // 2) & 255
            elif f == 4:
                pp = a + up - c
                pa, pb, pc = abs(pp - a), abs(pp - up), abs(pp - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else up if pb <= pc else c)) & 255
        rows.append(bytes(line))
        prev = line
    return w, h, rows


def pixel(rows, x, y):
    return tuple(rows[y][x * 4:x * 4 + 4])


def ink_box(path, alpha=128):
    """Bounding box of opaque pixels and the average colour inside it."""
    w, h, rows = read_png(path)
    xs, ys, col = [], [], [0, 0, 0]
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixel(rows, x, y)
            if a >= alpha:
                xs.append(x)
                ys.append(y)
                col[0] += r; col[1] += g; col[2] += b
    if not xs:
        return None
    n = len(xs)
    return {"w": max(xs) - min(xs) + 1, "h": max(ys) - min(ys) + 1, "n": n, "rgb": tuple(round(c / n) for c in col), "size": (w, h)}


# ---------- unit tests (pure functions) ----------

E = Env()


class IconSvgTests(unittest.TestCase):
    """Building SVGs from Iconify JSON must match the API's own .svg output."""

    def test_matches_api_svg(self):
        cases = [("mdi", "home", "mdi__home"), ("lucide", "house", "lucide__house"), ("lucide", "home", "lucide__house"),
                 ("logos", "github-icon", "logos__github-icon"), ("tabler", "arrow-up", "tabler__arrow-up"),
                 ("simple-icons", "github", "simple-icons__github")]
        for prefix, name, svg in cases:
            data = json.loads(fixture(f"iconify_icons_{prefix}.json"))
            self.assertEqual(E.js("iconSvg", data, name), fixture(f"svg/{svg}.svg", True).strip(), f"{prefix}:{name}")

    def test_non_square_and_missing(self):
        data = json.loads(fixture("iconify_icons_fa6-solid.json"))
        svg = E.js("iconSvg", data, "arrow-right")
        self.assertIn('width="0.88em" height="1em" viewBox="0 0 448 512"', svg)
        self.assertIsNone(E.js("iconSvg", data, "nope"))
        self.assertIsNone(E.js("iconSvg", None, "x"))

    def test_transforms(self):
        base = {"width": 24, "height": 16, "icons": {"a": {"body": "<path/>"}},
                "aliases": {"h": {"parent": "a", "hFlip": True}, "v": {"parent": "a", "vFlip": True},
                            "r1": {"parent": "a", "rotate": 1}, "r2": {"parent": "a", "rotate": 2},
                            "hv": {"parent": "a", "hFlip": True, "vFlip": True}, "hh": {"parent": "h", "hFlip": True},
                            "loop1": {"parent": "loop2"}, "loop2": {"parent": "loop1"}, "wide": {"parent": "a", "width": 48}}}
        h = E.js("iconSvg", base, "h")
        self.assertIn('<g transform="translate(24 0) scale(-1 1)"><path/></g>', h)
        self.assertIn('<g transform="translate(0 16) scale(1 -1)">', E.js("iconSvg", base, "v"))
        r1 = E.js("iconSvg", base, "r1")
        self.assertIn('viewBox="0 0 16 24"', r1)  # width and height swap on quarter turns
        self.assertIn('rotate(90 8 8)', r1)
        self.assertIn('width="0.67em"', r1)
        self.assertIn('rotate(180 12 8)', E.js("iconSvg", base, "r2"))
        self.assertIn('rotate(180 12 8)', E.js("iconSvg", base, "hv"))  # both flips = half turn
        self.assertNotIn("transform", E.js("iconSvg", base, "hh"))  # flipping twice cancels out
        self.assertIsNone(E.js("iconSvg", base, "loop1"))
        self.assertIn('viewBox="0 0 48 16"', E.js("iconSvg", base, "wide"))
        self.assertIn('xmlns:xlink', E.js("iconSvg", {"icons": {"x": {"body": '<use xlink:href="#a"/>'}}}, "x"))


class JsxTests(unittest.TestCase):
    def jsx(self, svg, name="mdi:home"):
        return E.js("svgToJsx", svg, name)

    def test_attributes_camel_case(self):
        out = self.jsx('<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" '
                       'stroke-linecap="round" stroke-linejoin="round" stroke-width="2" fill-rule="evenodd" clip-rule="evenodd" '
                       'clip-path="url(#a)" stop-color="#fff" font-family="x" text-anchor="middle" class="c" data-x="1" aria-hidden="true">'
                       '<path d="M0 0"/></g></svg>')
        for a in ['strokeLinecap="round"', 'strokeLinejoin="round"', 'strokeWidth="2"', 'fillRule="evenodd"', 'clipRule="evenodd"',
                  'clipPath="url(#a)"', 'stopColor="#fff"', 'fontFamily="x"', 'textAnchor="middle"', 'className="c"', 'data-x="1"',
                  'aria-hidden="true"', 'viewBox="0 0 24 24"']:
            self.assertIn(a, out)
        self.assertNotRegex(out, r'\s(stroke|fill|clip|stop|font|text)-[a-z]+=')
        self.assertTrue(out.startswith("export default function MdiHome(props) {"))
        self.assertIn("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1em\" height=\"1em\" viewBox=\"0 0 24 24\" {...props}>", out)
        self.assertEqual(out.count("{...props}"), 1)
        self.assertIn('<path d="M0 0" />', out)

    def test_namespaces_style_and_junk(self):
        svg = ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<!-- made by hand -->\n'
               '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://x" '
               'xml:space="preserve" inkscape:version="1" onload="alert(1)" viewBox="0 0 10 10">'
               '<sodipodi:namedview id="n"><inkscape:grid/></sodipodi:namedview>'
               '<style>.a{fill:red}</style><script>alert(1)</script>'
               '<use xlink:href="#p" style="fill:red;stroke-width:2;-webkit-mask:url(data:image/png;base64,AA==);--brand:#fff"/>'
               '<text x="1">a {b} &lt; c</text><path title=\'say "hi"\' d="M0"/></svg>')
        out = self.jsx(svg, "svgl-logo")
        self.assertNotIn("<?xml", out)
        self.assertNotIn("DOCTYPE", out)
        self.assertNotIn("<!--", out)
        self.assertNotIn("inkscape", out)
        self.assertNotIn("sodipodi", out)
        self.assertNotIn("alert", out)
        self.assertNotIn("onload", out)
        self.assertIn('xmlnsXlink="http://www.w3.org/1999/xlink"', out)
        self.assertIn('xmlSpace="preserve"', out)
        self.assertIn('xlinkHref="#p"', out)
        self.assertIn('style={{ fill: "red", strokeWidth: "2", WebkitMask: "url(data:image/png;base64,AA==)", "--brand": "#fff" }}', out)
        self.assertIn("<style>{`.a{fill:red}`}</style>", out)
        self.assertIn("a {'{'}b{'}'} &lt; c", out)
        self.assertIn("title={\"say \\\"hi\\\"\"}", out)
        self.assertIn("function SvglLogo(props)", out)

    def test_svg_prefixed_tags(self):
        # audit 1: closing tags lost their "svg:" prefix only on the opening side
        out = self.jsx('<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><svg:path d="M0"></svg:path></svg:svg>')
        self.assertIn("<path d=\"M0\"></path></svg>", out)
        self.assertNotIn("svg:", out)

    def test_component_names(self):
        self.assertEqual(E.js("componentName", "mdi:home-outline"), "MdiHomeOutline")
        self.assertEqual(E.js("componentName", "123-go"), "Icon123Go")
        self.assertEqual(E.js("componentName", "——"), "Icon")


class SvgTests(unittest.TestCase):
    def test_output_sizes(self):
        svg = fixture("svg/logos__github-icon.svg", True)
        self.assertEqual(E.js("outputSvg", svg, "keep"), svg.strip())
        s24 = E.js("outputSvg", svg, "24")
        self.assertIn('width="24.58" height="24"', s24)  # keeps the 256:250 aspect ratio
        none = E.js("outputSvg", svg, "none")
        self.assertNotIn("width=", none.split(">")[0])
        self.assertIn('viewBox="0 0 256 250"', none)
        # width/height only: a viewBox is added so the drawing still scales
        wh = E.js("outputSvg", '<svg xmlns="http://www.w3.org/2000/svg" width="48px" height="24"><path/></svg>', "none")
        self.assertEqual(wh, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"><path/></svg>')
        # neither: left alone
        bare = '<svg xmlns="http://www.w3.org/2000/svg"><path/></svg>'
        self.assertEqual(E.js("outputSvg", bare, "24"), bare)
        self.assertEqual(E.js("outputSvg", "not an svg", "24"), "not an svg")

    def test_box(self):
        self.assertEqual(E.js("svgBox", '<svg viewBox="0,0,10,5"/>'), {"x": 0, "y": 0, "w": 10, "h": 5, "viewBox": True})
        self.assertEqual(E.js("svgBox", '<svg width="12pt" height="6pt"/>')["w"], 16)
        self.assertIsNone(E.js("svgBox", '<svg width="100%" height="1em"/>'))
        self.assertIsNone(E.js("svgBox", '<svg viewBox="0 0 0 10"/>'))
        # ">" inside an attribute doesn't end the tag
        self.assertEqual(E.js("svgBox", '<svg data-x="a>b" viewBox="0 0 3 4"/>')["h"], 4)

    def test_colorize(self):
        self.assertEqual(E.js("colorize", '<svg><path fill="currentColor" style="stroke:CURRENTCOLOR"/></svg>', "#123456"),
                         '<svg><path fill="#123456" style="stroke:#123456"/></svg>')
        self.assertEqual(E.js("colorize", '<svg viewBox="0 0 1 1"><path d="M0"/></svg>', "#abcdef"),
                         '<svg viewBox="0 0 1 1" fill="#abcdef"><path d="M0"/></svg>')
        styled = '<svg><style>.a{fill:red}</style><path class="a"/></svg>'
        self.assertEqual(E.js("colorize", styled, "#000000"), styled)

    def test_hex_alpha_colours(self):
        # regression: AppKit draws #RGBA / #RRGGBBAA as black, which made svgl's GitHub dark logo invisible
        out = E.js("normalizeHexAlpha", '<path fill="#ffff" stroke=\'#11223380\' style="stop-color:#0f08"/><use href="#beef"/><a fill="url(#abcd)"/>')
        self.assertEqual(out, '<path fill="rgba(255,255,255,1.000)" stroke=\'rgba(17,34,51,0.502)\' style="stop-color:rgba(0,255,0,0.533)"/><use href="#beef"/><a fill="url(#abcd)"/>')
        # regression: CoreSVG reads an integer alpha of 1 as 1/255
        self.assertEqual(E.js("normalizeHexAlpha", '<p style="fill: rgba(1, 2, 3, 1)" fill="rgba(0,0,0,0.5)"/>'), '<p style="fill: rgba(1, 2, 3, 1.0)" fill="rgba(0,0,0,0.5)"/>')

    def test_data_uri(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n  <path fill="#f00" d="M1 1h2"/>\n  <text>é ✓ 100%</text>\n</svg>'
        uri = E.js("svgDataUri", svg)
        self.assertTrue(uri.startswith("data:image/svg+xml,"))
        body = uri.split(",", 1)[1]
        self.assertNotRegex(body, r'[#<>"\s\u0080-￿%](?![0-9A-F]{2})'.replace(r"\s", "\n"))
        for bad in "#<>\"\n{}":
            self.assertNotIn(bad, body)
        decoded = urllib.parse.unquote(body)
        self.assertEqual(decoded, "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='#f00' d='M1 1h2'/><text>é ✓ 100%</text></svg>")
        # single quotes in the SVG: keep double quotes (encoded)
        self.assertIn("%22", E.js("svgDataUri", "<svg a=\"it's\"/>"))


class QueryTests(unittest.TestCase):
    def test_icon_query(self):
        q = E.js("parseIconQuery", "arrow @lucide set:tabler,MDI")
        self.assertEqual((q["text"], q["sets"], q["all"], q["partial"]), ("arrow", ["lucide", "tabler", "mdi"], False, "mdi"))
        self.assertEqual(E.js("parseIconQuery", "home @luc")["partial"], "luc")
        self.assertIsNone(E.js("parseIconQuery", "@lucide ")["partial"])
        self.assertEqual(E.js("parseIconQuery", "@")["partial"], "")
        self.assertTrue(E.js("parseIconQuery", "x @all")["all"])
        self.assertIsNone(E.js("parseIconQuery", "x @all")["partial"])  # "all" is complete, not a set being typed
        self.assertEqual(E.js("parseIconQuery", "mdi:home")["exact"], {"prefix": "mdi", "name": "home"})
        self.assertIsNone(E.js("parseIconQuery", "set:mdi")["exact"])
        self.assertEqual(E.js("parseIconQuery", "@../etc x")["sets"], [])
        self.assertEqual(E.js("parseIconQuery", "a\nb\t\u0000c")["text"], "a b c")

    def test_font_query(self):
        self.assertEqual(E.js("parseFontQuery", "serif:"), {"category": "Serif", "words": []})
        self.assertEqual(E.js("parseFontQuery", "mono"), {"category": "Monospace", "words": []})
        self.assertEqual(E.js("parseFontQuery", "Mono:Fira Code"), {"category": "Monospace", "words": ["fira", "code"]})
        self.assertEqual(E.js("parseFontQuery", "roboto mono"), {"category": None, "words": ["roboto", "mono"]})
        self.assertEqual(E.js("parseFontQuery", "Montsérrat"), {"category": None, "words": ["montserrat"]})
        self.assertEqual(E.js("parseFontQuery", "foo: bar")["category"], None)

    def test_match_score(self):
        self.assertEqual(E.js("matchScore", "GitHub", ["github"], ""), 0)
        self.assertEqual(E.js("matchScore", "GitHub Copilot", ["github"], ""), 1)
        self.assertEqual(E.js("matchScore", "Visual Studio Code", ["studio", "code"], ""), 2)
        self.assertEqual(E.js("matchScore", "Turborepo", ["repo"], ""), 3)
        self.assertEqual(E.js("matchScore", "Turborepo", ["vercel"], "Vercel"), 4)
        self.assertIsNone(E.js("matchScore", "Turborepo", ["zzz"], ""))

    def test_resolve_id(self):
        r = E.js("resolveId", "iconify:mdi:home")
        self.assertEqual(r["url"], MOCK.base + "/iconify/mdi.json?icons=home")
        self.assertTrue(r["svg"].startswith(E.cache + "/svg/iconify/mdi/"))
        for bad in ["iconify:../x:y", "iconify:mdi:../../x", "iconify:mdi:a/b", "svgl:javascript:alert(1)", "svgl:file:///etc/passwd", "x", ""]:
            self.assertIsNone(E.js("resolveId", bad), bad)
        s = E.js("resolveId", "svgl:https://svgl.app/library/github_light.svg")
        self.assertRegex(s["svg"], r"/svg/svgl/github_light-[0-9a-f]{6}\.svg$")
        odd = E.js("resolveId", "svgl:https://x.test/a/..%2F..%2Fevil.svg")
        self.assertRegex(odd["svg"], r"/svg/svgl/[0-9a-f]{16}\.svg$")


class FontParsingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.meta = json.loads(fixture("google_fonts_metadata.json"))
        cls.slim = {f["n"]: f for f in E.js("slimFonts", cls.meta)["fonts"]}

    def expected_family(self, f):
        """Independent implementation of the CSS2 API rules."""
        fam = urllib.parse.quote(f["n"]).replace("%20", "+")
        up = sorted(int(k) for k in f["w"] if not k.endswith("i"))
        it = sorted(int(k[:-1]) for k in f["w"] if k.endswith("i"))
        wght = [a for a in f["a"] if a[0] == "wght"]
        rng = f"{wght[0][1]:g}..{wght[0][2]:g}" if wght and wght[0][2] > wght[0][1] else None
        if not it:
            return f"{fam}:wght@{rng}" if rng else fam if up == [400] else f"{fam}:wght@{';'.join(map(str, up))}"
        if not rng and set(up) <= {400} and set(it) == {400}:
            return f"{fam}:ital@{'0;1' if up else '1'}"
        tup = ([f"0,{rng}"] if up else []) + [f"1,{rng}"] if rng else [f"0,{w}" for w in up] + [f"1,{w}" for w in it]
        return f"{fam}:ital,wght@{';'.join(tup)}"

    def test_slim(self):
        self.assertEqual(len(self.slim), len(self.meta["familyMetadataList"]))
        inter = self.slim["Inter"]
        self.assertEqual(inter["c"], "Sans Serif")
        self.assertIn(["wght", 100, 900], inter["a"])
        self.assertNotIn("menu", self.slim["ABeeZee"]["s"])

    def test_css2_every_fixture_font(self):
        for name, f in self.slim.items():
            self.assertEqual(E.js("css2Family", f), self.expected_family(f), name)

    def test_css2_known_answers(self):
        self.assertEqual(E.js("css2Family", self.slim["Inter"]), "Inter:ital,wght@0,100..900;1,100..900")
        self.assertEqual(E.js("css2Family", self.slim["ABeeZee"]), "ABeeZee:ital@0;1")
        self.assertEqual(E.js("css2Family", self.slim["Lobster"]), "Lobster")
        self.assertEqual(E.js("css2Family", self.slim["Space Mono"]), "Space+Mono:ital,wght@0,400;0,700;1,400;1,700")
        self.assertEqual(E.js("css2Family", self.slim["Noto Sans JP"]), "Noto+Sans+JP:wght@100..900")

    def test_next_font(self):
        s = E.js("nextFontSnippet", self.slim["Space Mono"])
        self.assertIn('import { Space_Mono } from "next/font/google";', s)
        self.assertIn('const spaceMono = Space_Mono({ weight: ["400", "700"], style: ["normal", "italic"], subsets: ["latin"], display: "swap" });', s)
        self.assertNotIn("weight:", E.js("nextFontSnippet", self.slim["Inter"]))
        self.assertIn("const sourceSerif4 = Source_Serif_4(", E.js("nextFontSnippet", self.slim["Source Serif 4"]))

    def test_css2_without_weights(self):
        # audit 1: a family with no listed styles produced "Family:wght@" (a 400 error)
        self.assertEqual(E.js("css2Family", {"n": "Odd Font", "w": [], "a": [], "s": []}), "Odd+Font")

    def test_bad_metadata(self):
        out = E.run("test", "slimFonts", json.dumps([{"nope": 1}]))
        self.assertIn("bad fonts metadata", out.stdout)

    def test_validate_svgl(self):
        d = E.js("validateSvgl", json.loads(fixture("svgl_all.json")))
        gh = next(x for x in d if x["title"] == "GitHub")
        self.assertEqual(set(gh["route"]), {"light", "dark"})
        self.assertEqual(set(gh["wordmark"]), {"light", "dark"})
        self.assertTrue(all(isinstance(x["category"], list) for x in d))
        junk = E.js("validateSvgl", [{"title": "A", "route": "javascript:x"}, {"title": "B", "route": "https://x/b.svg", "category": "Y"}])
        self.assertEqual([x["title"] for x in junk], ["B"])

    def test_validate_search(self):
        d = E.js("validateSearch", json.loads(fixture("iconify_search_home.json")))
        self.assertEqual(len(d["icons"]), 64)
        self.assertEqual(d["collections"]["mdi"]["license"], "Apache 2.0")
        d = E.js("validateSearch", {"icons": ["a:b", "../x:y", 3, "c:d_e"]})
        self.assertEqual(d["icons"], ["a:b", "c:d_e"])


# ---------- rasterising ----------

class RasterTests(unittest.TestCase):
    def raster(self, svg, size=128, **opts):
        out = os.path.join(E.cache, "r", f"{time.time_ns()}.png")
        self.assertTrue(E.js("rasterize", svg, out, size, opts, **opts.pop("env", {})))
        return out

    def test_icon_colour_and_size(self):
        p = self.raster(fixture("svg/mdi__home.svg", True), color="#ff0000")
        box = ink_box(p)
        self.assertEqual(box["size"], (128, 128))
        self.assertGreater(box["w"], 90)  # 1em icons are scaled up, not drawn at 16 px
        r, g, b = box["rgb"]
        self.assertGreater(r, 200)
        self.assertLess(g, 40)

    def test_stroke_icon_viewbox_only(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3z"/></g></svg>'
        box = ink_box(self.raster(svg, color="#00ff00"))
        self.assertGreater(box["w"], 90)
        self.assertGreater(box["rgb"][1], 200)

    def test_width_height_without_viewbox(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#00f"/></svg>'
        box = ink_box(self.raster(svg))
        self.assertGreater(box["w"], 110)

    def test_wide_logo_keeps_aspect(self):
        box = ink_box(self.raster(fixture("svg/svgl__github_wordmark_light.svg", True)))
        self.assertGreater(box["w"], 2.5 * box["h"])

    def test_tiles(self):
        p = self.raster(fixture("svg/svgl__github_dark.svg", True), tile="dark")
        w, h, rows = read_png(p)
        self.assertEqual(pixel(rows, 0, 0)[3], 0)  # rounded corner stays transparent
        bg = pixel(rows, 7, 64)
        self.assertLess(bg[0], 40)
        # regression: fill="#ffff" must be drawn white on the dark tile
        whites = sum(1 for y in range(h) for x in range(w) if pixel(rows, x, y)[0] > 200)
        self.assertGreater(whites, 500)

    def test_quicklook_fallback(self):
        out = os.path.join(E.cache, "r", "ql.png")
        ok = E.js("rasterize", fixture("svg/svgl__github_wordmark_light.svg", True), out, 128, {}, IF_FORCE_QLMANAGE="1")
        self.assertTrue(ok)
        box = ink_box(out)
        self.assertIsNotNone(box)
        self.assertGreater(box["w"], 100)



# ---------- Script Filters end to end ----------

class IconFilterTests(unittest.TestCase):
    def setUp(self):
        MOCK.reset()
        self.e = Env()

    def test_empty_query(self):
        d = self.e.sf("icon", "")
        self.assertEqual(titles(d), ["Search icons", "Filter by icon set"])
        self.assertEqual(d["items"][1]["autocomplete"], "@")
        self.assertEqual(MOCK.count("/iconify"), 0)

    def test_search_previews_and_rerun(self):
        d = self.e.sf("icon", "home")
        items = d["items"]
        self.assertEqual(len(items), 64)
        first = items[0]
        self.assertEqual(first["arg"], "iconify:material-symbols:home")
        self.assertEqual(first["subtitle"], "Material Symbols · material-symbols:home · Apache 2.0")
        self.assertEqual(first["icon"]["path"], "icons/pending.png")
        self.assertEqual(first["mods"]["ctrl"]["arg"], "material-symbols:home")
        self.assertEqual(first["mods"]["cmd+alt"]["arg"], "https://icon-sets.iconify.design/material-symbols/home/")
        self.assertEqual(d["rerun"], 0.4)
        self.assertEqual(d["variables"], {"if_rerun_query": "home", "if_reruns": "1"})
        # one JSON request per icon set, never the per-icon .svg endpoint (it is rate limited)
        prefixes = {i["arg"].split(":")[1] for i in items}
        self.assertEqual(MOCK.count("/iconify/search"), 1)
        self.assertEqual(sum(1 for p, _ in MOCK.queries if p.endswith(".json")), len(prefixes))
        self.assertFalse(any(p.endswith(".svg") for p, _ in MOCK.queries))
        d2 = self.e.sf("icon", "home", if_rerun_query="home", if_reruns="1")
        self.assertTrue(all(i["icon"]["path"].startswith(self.e.cache + "/png/") for i in d2["items"]))
        self.assertTrue(all(i["quicklookurl"].endswith(".svg") for i in d2["items"]))
        self.assertNotIn("rerun", d2)
        self.assertEqual(MOCK.count("/iconify/search"), 1)  # cached
        self.assertEqual(len(self.e.files("png", ".png")), 64)

    def test_rerun_cap_and_reset(self):
        MOCK.mode["iconify"] = 503  # previews can't load: keeps them pending
        self.e.sf("icon", "mdi:home")
        d = self.e.sf("icon", "mdi:home", if_rerun_query="mdi:home", if_reruns="30")
        self.assertNotIn("rerun", d)
        d = self.e.sf("icon", "mdi:homes", if_rerun_query="mdi:home", if_reruns="30")
        self.assertEqual(d["variables"]["if_reruns"], "1")

    def test_exact_name(self):
        d = self.e.sf("icon", "mdi:home")
        self.assertEqual(titles(d), ["home"])
        self.assertEqual(MOCK.count("/iconify/search"), 0)

    def test_set_filter_and_suggestions(self):
        d = self.e.sf("icon", "arrow @lucide @tabler")
        self.assertEqual(last_search()["prefixes"], "lucide,tabler")
        self.assertTrue(all(i["arg"].split(":")[1] in ("lucide", "tabler") for i in d["items"]))
        d = self.e.sf("icon", "arrow @luc")
        self.assertEqual(d["items"][0]["autocomplete"], "arrow @lucide ")
        self.assertIn("Lucide", d["items"][0]["title"])
        d = self.e.sf("icon", "@", icon_sets="tabler, mdi")
        self.assertEqual(d["items"][0]["autocomplete"], "@tabler ")  # preferred sets first
        self.assertEqual(d["items"][-1]["autocomplete"], "@all ")
        d = self.e.sf("icon", "@zzzz")
        self.assertEqual(titles(d)[0], "No matching icon set")
        d = self.e.sf("icon", "@lucide ")
        self.assertEqual(titles(d)[0], "Search icons")

    def test_preferred_sets(self):
        d = self.e.sf("icon", "home", icon_sets="tabler,lucide")
        self.assertEqual([i["arg"] for i in d["items"][:3]], ["iconify:tabler:home", "iconify:tabler:home-filled", "iconify:lucide-lab:home"][:2] + [d["items"][2]["arg"]])
        self.assertTrue(d["items"][0]["arg"].startswith("iconify:tabler:"))
        self.e.sf("icon", "home", icon_sets="tabler,lucide", icon_sets_only="1")
        self.assertEqual(last_search()["prefixes"], "tabler,lucide")
        d = self.e.sf("icon", "home @all", icon_sets="tabler,lucide", icon_sets_only="1")
        self.assertEqual(len(d["items"]), 64)  # every set (served from the cached search without prefixes)
        self.assertEqual(MOCK.count("/iconify/search"), 2)

    def test_unicode_and_injection(self):
        q = "家 ✓ \"quo'te\" $(touch /tmp/pwned) `x`"
        d = self.e.sf("icon", q)
        self.assertEqual(titles(d), ["No icons found"])
        self.assertEqual(last_search()["query"], q)
        self.assertFalse(os.path.exists("/tmp/pwned"))

    def test_api_errors(self):
        for code, text in [(429, "Rate limited"), (500, "HTTP 500"), ("garbage", "Unexpected response")]:
            e = Env()
            MOCK.mode["iconify"] = code
            d = e.sf("icon", "home")
            self.assertEqual(titles(d), ["Couldn’t search Iconify"])
            self.assertIn(text, d["items"][0]["subtitle"])
            MOCK.reset()

    def test_offline(self):
        d = self.e.sf("icon", "home", IF_ICONIFY_API=CLOSED)
        self.assertEqual(titles(d), ["You’re offline"])
        # previously searched: stale results plus a notice
        self.e.sf("icon", "home")
        for f in self.e.files("search"):
            p = os.path.join(self.e.cache, "search", f)
            os.utime(p, (time.time() - 3 * 86400,) * 2)
        d = self.e.sf("icon", "home", IF_ICONIFY_API=CLOSED)
        self.assertEqual(len(d["items"]), 65)
        self.assertEqual(d["items"][-1]["title"], "Offline: showing cached results")
        # never searched, but the SVGs are cached: match on names
        d = self.e.sf("icon", "home outline", IF_ICONIFY_API=CLOSED)
        self.assertIn("iconify:mdi:home-outline", [i.get("arg") for i in d["items"]])
        self.assertEqual(d["items"][-1]["title"], "Offline: showing cached results")

    def test_missing_and_invalid_icons(self):
        self.e.sf("icon", "broken")
        d = self.e.sf("icon", "broken")
        icons = {i["arg"]: i["icon"]["path"] for i in d["items"]}
        self.assertEqual(icons["iconify:mdi:missing-one"], "icons/broken.png")
        self.assertTrue(icons["iconify:mdi:home"].endswith(".png") and icons["iconify:mdi:home"].startswith("/"))
        self.assertNotIn("rerun", d)
        d = self.e.sf("icon", "weird")
        self.assertEqual([i["arg"] for i in d["items"]], ["iconify:mdi:home", "iconify:mdi:ok_name"])

    def test_rate_limited_previews(self):
        MOCK.mode["iconify"] = 429
        e = self.e
        e.sf("icon", "mdi:home")
        self.assertTrue(os.path.exists(os.path.join(e.cache, "ratelimited-iconify")))
        self.assertEqual(e.files("png", ".fail"), [])  # not marked broken: retried later
        MOCK.reset()
        d = e.sf("icon", "mdi:home")
        self.assertNotIn("rerun", d)  # paused while rate limited
        self.assertEqual(MOCK.count("/iconify/mdi.json"), 0)

    def test_background_worker(self):
        e = self.e
        d = e.sf("icon", "home", IF_SYNC="")
        self.assertEqual(d["items"][0]["icon"]["path"], "icons/pending.png")
        lock = os.path.join(e.cache, "worker.lock")
        deadline = time.time() + 30
        while (os.path.exists(lock) or len(e.files("png", ".png")) < 64) and time.time() < deadline:
            time.sleep(0.2)
        self.assertEqual(len(e.files("png", ".png")), 64)
        self.assertEqual(e.files("jobs"), [])

    def test_preview_colour_follows_theme(self):
        self.e.sf("icon", "mdi:home", alfred_theme_background=DARK)
        self.e.sf("icon", "mdi:home", preview_color="black")
        self.assertEqual(sorted({f.split("/")[0] for f in self.e.files("png", ".png")}), ["c000000", "ce5e7eb"])
        box = ink_box(os.path.join(self.e.cache, "png", "ce5e7eb", "iconify", "mdi", "home.png"))
        self.assertGreater(min(box["rgb"]), 200)


class Audit1Tests(unittest.TestCase):
    def setUp(self):
        MOCK.reset()
        self.e = Env()

    def test_truncated_svg_is_rejected(self):
        self.assertFalse(E.js("isSvg", '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0'))
        self.assertFalse(E.js("isSvg", "<html><svg></svg></html>"))
        self.assertTrue(E.js("isSvg", '<?xml version="1.0"?>\n<!-- x --><svg/>'))
        self.assertTrue(E.js("isSvg", fixture("svg/mdi__home.svg", True)))
        self.e.sf("logo", "zztruncated")
        d = self.e.sf("logo", "zztruncated")
        self.assertEqual(d["items"][0]["icon"]["path"], "icons/broken.png")
        out = self.e.action("svg", f"svgl:{MOCK.base}/svgl/library/truncated.svg")
        self.assertEqual(out.stdout, "")
        self.assertIn("not an SVG", out.stderr)

    def test_offline_previews_are_not_marked_broken(self):
        e = self.e
        e.sf("icon", "home")  # search cached, previews rendered
        shutil.rmtree(os.path.join(e.cache, "png"))
        shutil.rmtree(os.path.join(e.cache, "svg"))
        d = e.sf("icon", "home", IF_ICONIFY_API=CLOSED)
        self.assertEqual(d["items"][0]["icon"]["path"], "icons/pending.png")
        self.assertEqual(e.files("png", ".fail"), [])
        self.assertTrue(os.path.exists(os.path.join(e.cache, "offline-iconify")))
        d = e.sf("icon", "home", IF_ICONIFY_API=CLOSED)
        self.assertNotIn("rerun", d)  # backing off: no rerun loop while offline
        os.utime(os.path.join(e.cache, "offline-iconify"), (time.time() - 120,) * 2)
        d = e.sf("icon", "home")
        d = e.sf("icon", "home")
        self.assertTrue(d["items"][0]["icon"]["path"].startswith("/"))

    def test_logo_tiles_colour_current_color(self):
        self.e.sf("logo", "zzcurrent")
        d = self.e.sf("logo", "zzcurrent")
        paths = {i["title"]: i["icon"]["path"] for i in d["items"]}
        dark = ink_box(paths["Zzcurrent · Dark"], alpha=250)
        w, h, rows = read_png(paths["Zzcurrent · Dark"])
        self.assertEqual(pixel(rows, 64, 64)[:3], (255, 255, 255))  # currentColor drawn white on the dark tile
        w, h, rows = read_png(paths["Zzcurrent · Light"])
        self.assertEqual(pixel(rows, 64, 64)[:3], (0, 0, 0))

    def test_png_keeps_proportions(self):
        ident = f"svgl:{MOCK.base}/svgl/library/github_wordmark_light.svg"
        self.e.action("png", ident, png_size="512")
        w, h, _ = read_png(os.path.join(self.e.cache, "out", "github_wordmark_light-512.png"))
        self.assertEqual((w, h), (512, 139))

    def test_set_list_offline(self):
        d = self.e.sf("icon", "@", IF_ICONIFY_API=CLOSED)
        self.assertEqual(titles(d)[0], "Couldn’t load the list of icon sets")
        d = self.e.sf("icon", "arrow @lucide", IF_ICONIFY_API=CLOSED)
        self.assertEqual(titles(d), ["You’re offline"])  # searched, not stuck on set suggestions

    def test_prune_throttle_search_cap_and_old_jobs(self):
        e = self.e
        search = os.path.join(e.cache, "search")
        os.makedirs(search)
        for i in range(1005):
            p = os.path.join(search, f"{i:04}.json")
            open(p, "w").write("{}")
            os.utime(p, (time.time() - 5000 + i,) * 2)
        e.js("prune", 100)
        left = sorted(os.listdir(search))
        self.assertEqual(len(left), 1000)
        self.assertEqual(left[0], "0005.json")  # oldest removed
        # a job queued minutes ago is dropped
        jobs = os.path.join(e.cache, "jobs")
        os.makedirs(jobs)
        png = os.path.join(e.cache, "png", "c000000", "iconify", "mdi", "home.png")
        job = os.path.join(jobs, "1-old.json")
        json.dump([{"url": "", "svg": os.path.join(e.cache, "svg/iconify/mdi/home.svg"), "png": png, "color": "#000000", "tile": None,
                    "iconify": {"prefix": "mdi", "name": "home"}}], open(job, "w"))
        os.utime(job, (time.time() - 600,) * 2)
        e.run("worker")
        self.assertFalse(os.path.exists(png))
        self.assertFalse(os.path.exists(job))
        # prune runs at most hourly
        big = os.path.join(e.cache, "png", "x", "big.png")
        os.makedirs(os.path.dirname(big))
        open(big, "wb").write(b"\0" * 2_000_000)
        os.utime(big, (time.time() - 9999,) * 2)
        e.run("worker", cache_limit_mb="1")
        self.assertTrue(os.path.exists(big))  # the worker above already pruned this hour
        os.utime(os.path.join(e.cache, "pruned"), (time.time() - 4000,) * 2)
        e.run("worker", cache_limit_mb="1")
        self.assertFalse(os.path.exists(big))


class PruneTests(unittest.TestCase):
    def test_prune_oldest_first(self):
        e = Env()
        old = time.time() - 10 * 86400
        for i in range(6):
            p = os.path.join(e.cache, "png", "c000000", "iconify", "x", f"{i}.png")
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(b"\0" * 400_000)
            os.utime(p, (old + i * 100,) * 2)
        stale = os.path.join(e.cache, "search", "old.json")
        os.makedirs(os.path.dirname(stale))
        open(stale, "w").write("{}")
        os.utime(stale, (time.time() - 40 * 86400,) * 2)
        total = e.js("prune", 1)  # 1 MB limit, 2.4 MB of previews
        self.assertLessEqual(total, 0.8 * 1024 * 1024)
        self.assertEqual(e.files("png"), ["c000000/iconify/x/4.png", "c000000/iconify/x/5.png"])  # newest kept
        self.assertFalse(os.path.exists(stale))
        # regression: sizes are numbers (JXA returns fileSize as a string): nothing is deleted under the limit
        self.assertLess(e.js("prune", 100), 1024 * 1024)
        self.assertEqual(len(e.files("png")), 2)


class LogoFilterTests(unittest.TestCase):
    def setUp(self):
        MOCK.reset()
        self.e = Env()

    def test_github(self):
        d = self.e.sf("logo", "github")
        t = titles(d)
        self.assertEqual(t[:4], ["GitHub · Light", "GitHub · Dark", "GitHub · Wordmark Light", "GitHub · Wordmark Dark"])
        self.assertIn("github", t)  # Simple Icons follows when svgl has few matches
        gh = d["items"][0]
        self.assertEqual(gh["arg"], MOCK.base and f"svgl:{MOCK.base}/svgl/library/github_light.svg")
        self.assertEqual(gh["mods"]["ctrl"]["arg"], "github-light")
        self.assertEqual(gh["mods"]["cmd+alt"]["arg"], "https://svgl.app/?search=GitHub")
        self.assertIn("for light backgrounds", gh["subtitle"])
        dark = self.e.sf("logo", "github", alfred_theme_background=DARK)
        self.assertEqual(titles(dark)[0], "GitHub · Dark")
        d2 = self.e.sf("logo", "github")
        self.assertTrue(d2["items"][0]["icon"]["path"].startswith(self.e.cache + "/png/tile-light/svgl/"))
        self.assertEqual(MOCK.count("/svgl"), 1 + 4 + 2)  # the list once, then each GitHub/Copilot file once

    def test_many_matches_skip_simple_icons(self):
        d = self.e.sf("logo", "vercel")
        self.assertGreater(len(d["items"]), 5)
        self.assertEqual(MOCK.count("/iconify/search"), 0)

    def test_empty_and_none(self):
        self.assertEqual(titles(self.e.sf("logo", "")), ["Search logos"])
        self.assertEqual(titles(self.e.sf("logo", "zzqqxx")), ["No logos found"])
        self.assertEqual(titles(self.e.sf("logo", "\"'`$(x)\n家")), ["No logos found"])

    def test_offline_and_stale(self):
        d = self.e.sf("logo", "github", IF_SVGL_API=CLOSED, IF_ICONIFY_API=CLOSED)
        self.assertEqual(titles(d), ["You’re offline"])
        self.e.sf("logo", "vercel")
        path = os.path.join(self.e.cache, "svgl.json")
        os.utime(path, (time.time() - 2 * 86400,) * 2)
        MOCK.reset()
        d = self.e.sf("logo", "vercel")  # stale: served at once, refreshed in the background
        self.assertGreater(len(d["items"]), 5)
        self.assertEqual(MOCK.count("/svgl"), 1)
        self.assertLess(time.time() - os.path.getmtime(path), 60)
        # offline with a cache: still works
        d = self.e.sf("logo", "vercel", IF_SVGL_API=CLOSED)
        self.assertGreater(len(d["items"]), 5)

    def test_svgl_api_error(self):
        MOCK.mode["svgl"] = "garbage"
        d = self.e.sf("logo", "github")
        self.assertIn("github", titles(d))  # Simple Icons still answers
        self.assertEqual(d["items"][-1]["title"], "Couldn’t load svgl")  # audit 1: no "cached results" claim without a cache
        self.assertEqual(d["items"][-1]["subtitle"], "Unexpected response from the server")


class FontFilterTests(unittest.TestCase):
    def setUp(self):
        MOCK.reset()
        self.e = Env()

    def test_search_and_mods(self):
        d = self.e.sf("font", "inter")
        inter = d["items"][0]
        self.assertEqual(inter["title"], "Inter")
        self.assertEqual(inter["subtitle"], "Sans Serif · variable 100–900 + italics · #3 most popular · by Rasmus Andersson")
        self.assertEqual(inter["arg"], "https://fonts.google.com/specimen/Inter")
        href = "https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,100..900;1,100..900&display=swap"
        self.assertEqual(inter["mods"]["cmd"]["arg"], '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
                         '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
                         f'<link href="{href}" rel="stylesheet">')
        self.assertEqual(inter["mods"]["alt"]["arg"], f"@import url('{href}');")
        self.assertEqual(inter["mods"]["ctrl"]["arg"], 'font-family: "Inter", sans-serif;')
        self.assertEqual(inter["mods"]["fn"]["arg"], href)
        self.assertIn("next/font/google", inter["mods"]["shift"]["arg"])
        self.assertEqual(inter["icon"]["path"], "icons/font.png")

    def test_ranking_and_categories(self):
        self.assertEqual(titles(self.e.sf("font", "roboto"))[:3], ["Roboto", "Roboto Mono", "Roboto Flex"])
        serif = self.e.sf("font", "serif:")
        self.assertEqual(titles(serif)[:2], ["Playfair Display", "Merriweather"])
        self.assertTrue(all(i["icon"]["path"] == "icons/font-serif.png" for i in serif["items"]))
        mono = self.e.sf("font", "mono")
        self.assertEqual(titles(mono)[0], "Roboto Mono")
        self.assertIn('monospace;', mono["items"][0]["mods"]["ctrl"]["arg"])
        self.assertEqual(titles(self.e.sf("font", "mono:fira")), ["Fira Code"])
        self.assertEqual(titles(self.e.sf("font", ""))[:3], ["Roboto", "Open Sans", "Inter"])
        self.assertEqual(titles(self.e.sf("font", "Montsérrat"))[0], "Montserrat")
        self.assertEqual(self.e.sf("font", "hand:")["items"][0]["mods"]["ctrl"]["arg"], 'font-family: "Dancing Script", cursive;')

    def test_no_results_and_unicode(self):
        self.assertEqual(titles(self.e.sf("font", "zzzz")), ["No fonts found"])
        self.assertEqual(titles(self.e.sf("font", "serif:zzzz")), ["No fonts found"])
        self.assertEqual(titles(self.e.sf("font", "\"'`\n\\家")), ["No fonts found"])

    def test_cache_xssi_offline(self):
        MOCK.mode["xssi"] = True
        self.assertEqual(titles(self.e.sf("font", "lora"))[0], "Lora")
        self.e.sf("font", "lora")
        self.assertEqual(MOCK.count("/fonts"), 1)  # cached for a week
        path = os.path.join(self.e.cache, "fonts.json")
        self.assertLess(os.path.getsize(path), 20000)  # slimmed down
        d = self.e.sf("font", "lora", IF_FONTS_META=CLOSED)
        self.assertEqual(titles(d)[0], "Lora")
        e2 = Env()
        self.assertEqual(titles(e2.sf("font", "lora", IF_FONTS_META=CLOSED)), ["You’re offline"])
        MOCK.mode["fonts"] = 500
        self.assertEqual(titles(e2.sf("font", "lora")), ["Couldn’t load Google Fonts"])


class ActionTests(unittest.TestCase):
    def setUp(self):
        MOCK.reset()
        self.e = Env()

    def test_copy_svg_jsx_uri(self):
        out = self.e.action("svg", "iconify:mdi:home")
        self.assertEqual(out.stdout, fixture("svg/mdi__home.svg", True).strip())
        self.assertEqual(self.e.action("svg", "iconify:mdi:home").stdout, out.stdout)
        self.assertEqual(MOCK.count("/iconify/mdi.json"), 1)  # second copy comes from the cache
        self.assertIn('width="24" height="24"', self.e.action("svg", "iconify:mdi:home", svg_size="24").stdout)
        self.assertNotIn("width", self.e.action("svg", "iconify:mdi:home", svg_size="none").stdout)
        jsx = self.e.action("jsx", "iconify:lucide:house").stdout
        self.assertTrue(jsx.startswith("export default function LucideHouse(props) {"))
        self.assertIn('strokeLinecap="round"', jsx)
        uri = self.e.action("datauri", "iconify:mdi:home").stdout
        self.assertTrue(uri.startswith("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'"))

    def test_save_png(self):
        out = self.e.action("png", "iconify:mdi:home", png_size="256", png_color="#0000ff")
        self.assertEqual(out.stdout, "Saved mdi-home-256.png to out")
        p = os.path.join(self.e.cache, "out", "mdi-home-256.png")
        box = ink_box(p)
        self.assertEqual(box["size"], (256, 256))
        self.assertGreater(box["rgb"][2], 200)
        self.assertEqual(self.e.action("png", "iconify:mdi:home", png_size="256").stdout, "Saved mdi-home-256-2.png to out")
        self.assertIn("Saved", self.e.action("png", "iconify:mdi:home", png_color="not a colour").stdout)

    def test_logo_actions(self):
        ident = f"svgl:{MOCK.base}/svgl/library/github_wordmark_light.svg"
        self.assertEqual(self.e.action("svg", ident).stdout, fixture("svg/svgl__github_wordmark_light.svg", True).strip())
        self.assertIn("xmlSpace", self.e.action("jsx", ident).stdout)
        self.assertIn("function GithubWordmarkLight(props)", self.e.action("jsx", ident).stdout)
        self.assertTrue(self.e.action("png", ident).stdout.startswith("Saved github_wordmark_light-512.png"))

    def test_failures(self):
        out = self.e.action("svg", "iconify:mdi:home", IF_ICONIFY_API=CLOSED)
        self.assertEqual(out.stdout, "")
        self.assertIn("No internet connection", out.stderr)
        out = self.e.action("svg", "iconify:mdi:missing-x")
        self.assertEqual(out.stdout, "")
        self.assertIn("doesn’t exist", out.stderr)
        out = self.e.action("svg", f"svgl:{MOCK.base}/svgl/library/notsvg.svg")
        self.assertEqual(out.stdout, "")
        self.assertIn("not an SVG", out.stderr)
        self.assertEqual(self.e.action("svg", "iconify:../../etc:passwd").stdout, "")
        self.assertEqual(self.e.action("nonsense", "iconify:mdi:home").stdout, "")


# ---------- workflow ----------

class PlistTests(unittest.TestCase):
    def test_build_and_plist(self):
        subprocess.run([sys.executable, "tools/build.py"], cwd=ROOT, check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            p = plistlib.load(f)
        uids = {o["uid"]: o for o in p["objects"]}
        self.assertEqual(len(uids), len(p["objects"]))
        for src, conns in p["connections"].items():
            self.assertIn(src, uids)
            for c in conns:
                self.assertIn(c["destinationuid"], uids)
                if "sourceoutputuid" in c:
                    self.assertIn(c["sourceoutputuid"], [x["uid"] for x in uids[src]["config"]["conditions"]])
        for o in p["objects"]:
            kw = o["config"].get("keyword")
            if kw:
                self.assertRegex(kw, r"^\{var:keyword_\w+\}$")
        # every modifier the Script Filters offer is connected
        mods = {"cmd": 1048576, "alt": 524288, "ctrl": 262144, "shift": 131072, "fn": 8388608, "cmd+alt": 1572864}
        for o in p["objects"]:
            if o["type"].endswith("scriptfilter"):
                have = {c["modifiers"] for c in p["connections"][o["uid"]]}
                need = {0, 1048576, 524288, 262144, 131072, 8388608} | ({1572864} if "font" not in o["config"]["script"] else set())
                self.assertEqual(have, need, o["config"]["script"])
        self.assertTrue(p["readme"].startswith("## Usage"))
        self.assertNotIn("images/", p["readme"])
        out = subprocess.run(["sips", "-g", "pixelWidth", os.path.join(SRC, "icon.png")], capture_output=True, text=True).stdout
        self.assertGreaterEqual(int(out.split()[-1]), 256)
        for f in os.listdir(os.path.join(SRC, "icons")):
            self.assertTrue(f.endswith(".png"))

    def test_no_runtime_dependencies(self):
        js = open(os.path.join(SRC, "finder.js")).read()
        self.assertNotRegex(js, r"python|/usr/local|/opt/homebrew|node\b|ruby")
        self.assertNotIn("doShellScript", js)  # commands run with argv via NSTask, never a shell string


@unittest.skipUnless(os.environ.get("IF_LIVE") == "1", "set IF_LIVE=1 to test the real APIs")
class LiveSmokeTests(unittest.TestCase):
    def run_live(self, kind, query, cache):
        e = dict(os.environ, alfred_workflow_cache=cache, IF_SYNC="1", alfred_theme_background=LIGHT)
        for k in ("IF_ICONIFY_API", "IF_SVGL_API", "IF_FONTS_META"):
            e.pop(k, None)
        out = subprocess.run(["osascript", "-l", "JavaScript", "./finder.js", kind, query], cwd=SRC, env=e, capture_output=True, text=True, timeout=90)
        d = json.loads(out.stdout)
        validate(d)
        return d

    def test_live(self):
        cache = tempfile.mkdtemp(prefix="icon-finder-live-")
        self.run_live("icon", "arrow @lucide", cache)
        d = self.run_live("icon", "arrow @lucide", cache)
        self.assertTrue(d["items"][0]["icon"]["path"].startswith(cache))
        d = self.run_live("logo", "github", cache)
        self.assertTrue(any(t.startswith("GitHub") for t in titles(d)))
        d = self.run_live("font", "inter", cache)
        self.assertEqual(d["items"][0]["title"], "Inter")
        for item in self.run_live("font", "", cache)["items"][:10]:
            href = item["mods"]["fn"]["arg"]
            code = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-A", "Mozilla/5.0", href], capture_output=True, text=True).stdout
            self.assertEqual(code, "200", href)


if __name__ == "__main__":
    unittest.main(verbosity=1)
