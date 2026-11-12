"""Tiny ffmpeg+Pillow frame grid / crop tool (video-watch fallback: no ImageMagick)."""
import subprocess, os, sys, json, math, tempfile
from PIL import Image, ImageDraw, ImageFont

FF = r"C:\Users\Maxwell\AppData\Local\Programs\Python\Python312\Lib\site-packages\static_ffmpeg\bin\win32\ffmpeg.exe"
FP = r"C:\Users\Maxwell\AppData\Local\Programs\Python\Python312\Lib\site-packages\static_ffmpeg\bin\win32\ffprobe.exe"
FONT = r"C:\Windows\Fonts\msyh.ttc"


def probe(media):
    out = subprocess.run([FP, "-v", "error", "-show_streams", "-show_format",
                          "-print_format", "json", media], capture_output=True, text=True).stdout
    j = json.loads(out)
    v = [s for s in j["streams"] if s["codec_type"] == "video"][0]
    return {"w": int(v["width"]), "h": int(v["height"]), "dur": float(j["format"]["duration"]),
            "fps": eval(v["r_frame_rate"])}


def grab(media, t, out_png):
    subprocess.run([FF, "-v", "error", "-ss", f"{t:.3f}", "-i", media, "-frames:v", "1",
                    "-y", out_png], check=True)


def label(im, text, scale=1.0):
    d = ImageDraw.Draw(im)
    try:
        f = ImageFont.truetype(FONT, int(14 * scale))
    except Exception:
        f = ImageFont.load_default()
    d.rectangle([0, 0, 8 * len(text) + 8, int(18 * scale)], fill=(0, 0, 0))
    d.text((4, 1), text, fill=(0, 255, 0), font=f)
    return im


def grid(media, outdir, t0=0.0, t1=None, cols=5, rows=5, scale=1.0, cell_w=756 // 5 - 2):
    info = probe(media)
    t1 = info["dur"] if t1 is None else t1
    n = cols * rows
    os.makedirs(outdir, exist_ok=True)
    tmp = tempfile.mkdtemp()
    tiles = []
    for i in range(n):
        t = t0 + (t1 - t0) * (i + 0.5) / n
        p = os.path.join(tmp, f"f{i:02d}.png")
        grab(media, t, p)
        im = Image.open(p).convert("RGB")
        ratio = cell_w / im.width
        im = im.resize((cell_w, max(1, int(im.height * ratio))), Image.BICUBIC)
        im = label(im, f"{t:.2f}s", scale)
        tiles.append(im)
    tw, th = tiles[0].size
    sheet = Image.new("RGB", (cols * (tw + 6) + 6, rows * (th + 6) + 6), (32, 32, 32))
    for i, im in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet.paste(im, (6 + c * (tw + 6), 6 + r * (th + 6)))
    outp = os.path.join(outdir, f"grid_{t0:.1f}_{t1:.1f}.png")
    sheet.save(outp)
    print(outp, sheet.size, info)
    return outp


def crop(media, t, out_png, box, zoom=2.0):
    tmp = tempfile.mktemp(suffix=".png")
    grab(media, t, tmp)
    im = Image.open(tmp).convert("RGB")
    x, y, w, h = box
    im = im.crop((x, y, x + w, y + h))
    im = im.resize((int(w * zoom), int(h * zoom)), Image.LANCZOS)
    im.save(out_png)
    print(out_png, im.size)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "probe":
        print(probe(sys.argv[2]))
    elif cmd == "grid":
        media, outdir = sys.argv[2], sys.argv[3]
        t0 = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
        t1 = float(sys.argv[5]) if len(sys.argv) > 5 else None
        cols = int(sys.argv[6]) if len(sys.argv) > 6 else 5
        grid(media, outdir, t0, t1, cols=cols, rows=cols)
    elif cmd == "crop":
        media, t, out_png = sys.argv[2], float(sys.argv[3]), sys.argv[4]
        x, y, w, h = [int(v) for v in sys.argv[5].split(",")]
        zoom = float(sys.argv[6]) if len(sys.argv) > 6 else 2.0
        crop(media, t, out_png, (x, y, w, h), zoom)
