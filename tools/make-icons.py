"""生成应用图标：assets/icon.ico（多尺寸）+ icon.png（512）+ icon-256.png（256）+ tray.png（32）。

风格对齐 macOS 的「启动台」（Launchpad）图标：浅色圆角方块里放 3×3 的彩色小方块（不是笑脸，
笑脸是 Finder）。
"""
from PIL import Image, ImageDraw, ImageFilter
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
os.makedirs(ASSETS, exist_ok=True)

SIZE = 1024


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def squircle_mask(size, radius_ratio=0.235):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255)
    return mask


# 3×3 彩色小方块：左上→右下的彩虹顺序，接近 macOS 启动台那颗图标的配色观感
GRID_COLORS = [
    "#FF6B6B", "#FFB03A", "#FFD93B",
    "#4CD964", "#34C7DE", "#3E8BFF",
    "#8E7CFF", "#C86BFF", "#FF6FCF",
]


def hex_rgba(h, a=255):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def make_icon(size=SIZE):
    mask = squircle_mask(size)

    # 1) 底：近白到浅灰的竖直渐变（苹果那颗是浅灰白玻璃，不是蓝色）
    top = (255, 255, 255)
    bottom = (233, 236, 241)
    grad = Image.new("RGBA", (1, size))
    for y in range(size):
        grad.putpixel((0, y), lerp(top, bottom, y / (size - 1)) + (255,))
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    base.paste(grad.resize((size, size)), (0, 0), mask)

    # 2) 左上角一层很淡的高光，让方块有玻璃感
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dg = ImageDraw.Draw(glow)
    for i in range(24, 0, -1):
        t = i / 24.0
        r = int(size * (0.28 + 0.52 * t))
        cx, cy = int(size * 0.22), int(size * 0.16)
        alpha = int(26 * (1.0 - t) ** 1.2)
        if alpha <= 0:
            continue
        dg.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, alpha))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.03))
    base = Image.alpha_composite(base, Image.composite(glow, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask))

    # 3) 3×3 彩色小方块
    cell = size * 0.190
    gap = size * 0.049
    total = cell * 3 + gap * 2
    left = (size - total) / 2.0
    top0 = left
    radius = cell * 0.24

    # 先画一层柔和投影（整体偏移一点点），再叠彩色块
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ds = ImageDraw.Draw(shadow)
    for row in range(3):
        for col in range(3):
            x = left + col * (cell + gap)
            y = top0 + row * (cell + gap)
            ds.rounded_rectangle(
                [x, y + size * 0.012, x + cell, y + cell + size * 0.012],
                radius=radius,
                fill=(0, 0, 0, 46),
            )
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.012))
    base = Image.alpha_composite(base, Image.composite(shadow, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask))

    tiles = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dt = ImageDraw.Draw(tiles)
    for idx, color in enumerate(GRID_COLORS):
        row, col = divmod(idx, 3)
        x = left + col * (cell + gap)
        y = top0 + row * (cell + gap)
        dt.rounded_rectangle([x, y, x + cell, y + cell], radius=radius, fill=hex_rgba(color))
    base = Image.alpha_composite(base, tiles)

    # 4) 外圈一层极淡的描边，避免纯白边在浅色桌面上“糊掉”
    edge = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    de = ImageDraw.Draw(edge)
    de.rounded_rectangle(
        [1, 1, size - 2, size - 2],
        radius=int(size * 0.234),
        outline=(0, 0, 0, 26),
        width=max(1, int(size * 0.004)),
    )
    base = Image.alpha_composite(base, Image.composite(edge, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask))
    return base


base = make_icon(SIZE)
base.resize((512, 512), Image.LANCZOS).save(os.path.join(ASSETS, "icon.png"))
base.resize((256, 256), Image.LANCZOS).save(os.path.join(ASSETS, "icon-256.png"))
base.resize((32, 32), Image.LANCZOS).save(os.path.join(ASSETS, "tray.png"))

sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
base.save(os.path.join(ASSETS, "icon.ico"), sizes=sizes)
print("icons written:", sorted(os.listdir(ASSETS)))
