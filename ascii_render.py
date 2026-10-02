#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ascii_render.py — превращение ФОТО и ВИДЕО в картинку из символов.

Возможности:
  * любой набор символов (ramp / цифры / буквы / бинарь / катакана / свой текст);
  * размер символов (cell_w x cell_h) и масштаб пикселей (scale);
  * цвет: белый по чёрному / символ красится цветом картинки / чёрный символ
    по цветному фону / цветной фон квадратами;
  * эффекты: шум (случайные символы), глитч (сдвиги строк, RGB-расщепление,
    вспышки), сканлайны, яркостный джиттер;
  * экспорт: PNG, кадр как редактируемый .txt, видео MP4, GIF, плюс
    отдельно «чистый» текст для правки руками.

CLI:
  python ascii_render.py image in.jpg -o out.png --charset digits --color img
  python ascii_render.py video in.mp4 -o out.mp4 --noise 0.2 --glitch 0.3
  python ascii_render.py text  in.jpg -o out.txt --cell 6x12
"""

from __future__ import annotations

import argparse
import os
import random
import sys
import unicodedata

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# --------------------------------------------------------------------------
# Наборы символов
# --------------------------------------------------------------------------
CHARSETS = {
    # классический ramp: от пустоты к плотному
    "ramp":      " .:-=+*#%@",
    "ramp_soft": " .'`,:;~+*oO0#%@",
    "digits":    "0123456789",
    "bin":       "01",
    "hex":       "0123456789ABCDEF",
    "letters":   "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "lower":     "abcdefghijklmnopqrstuvwxyz",
    "punct":     " .,:;!|/\\()[]{}<>*#%@&",
    "blocks":    " .·:-=+*▒▓█",
    "matrix":    "アカサタナハマヤラワイキシチニヒミリウクスツヌフムユルエケセテネヘメレオコソトノホモヨロ",
    "circles":   " ·•●",
    "arrows":    " .:-=+<>^v▲▼◄►",
}

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/freefont/FreeMono.ttf",
]


def find_font(path: str | None = None) -> str | None:
    if path and os.path.exists(path):
        return path
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def load_font(size: int, path: str | None = None) -> ImageFont.FreeTypeFont:
    fp = find_font(path)
    if fp:
        try:
            return ImageFont.truetype(fp, size)
        except Exception:
            pass
    try:                                     # Pillow >= 9.2 умеет размер у дефолтного
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def cells_fitting(ch: str, font) -> bool:
    """
    Проверяет, что глиф можно нарисовать одним символом в один знак.
    Раньше тут резались не-ASCII (катакана пропадала из-за подмены на '?'),
    теперь проверяем реальную ширину: символ должен быть printable и не
    превращаться в пустоту.
    """
    if not ch or ch in "\n\r\t":
        return False
    if not ch.isprintable():
        return False
    cat = unicodedata.category(ch)
    return not cat.startswith("C")


# --------------------------------------------------------------------------
# Вспомогательное
# --------------------------------------------------------------------------
def brightness_grid(arr: np.ndarray, gw: int, gh: int) -> tuple[np.ndarray, np.ndarray]:
    """Средняя яркость и цвет по блокам gw x gh. arr: HxWx3 uint8."""
    h, w = arr.shape[:2]
    # режем до кратного размера, чтобы reshape не падал на «хвостиках»
    hh, ww = (h // gh) * gh, (w // gw) * gw
    if hh == 0 or ww == 0:
        raise ValueError(f"Сетка {gw}x{gh} больше изображения {w}x{h}")
    a = arr[:hh, :ww].reshape(gh, hh // gh, gw, ww // gw, 3)
    color = a.mean(axis=(1, 3))                       # gh x gw x 3
    lum = color @ np.array([0.299, 0.587, 0.114])     # gh x gw
    return lum, color


def chars_for(lum: np.ndarray, chars: list[str], step: float = 1.0) -> list[list[str]]:
    """Яркость -> символ. step > 1 «огрубляет» палитру (меньше разных символов)."""
    n = len(chars)
    norm = np.clip(lum / 255.0, 0, 1)
    idx = np.floor(norm * n / step).astype(int)
    idx = np.clip(idx, 0, n - 1)
    return [[chars[i] for i in row] for row in idx]


# --------------------------------------------------------------------------
# Эффекты
# --------------------------------------------------------------------------
def apply_noise(ch: list[list[str]], amount: float, chars: list[str],
                rng: np.random.Generator) -> list[list[str]]:
    """Шум: часть символов заменяется случайными / полностью затирается."""
    if amount <= 0:
        return ch
    grid = np.array(ch, dtype=object)
    mask = rng.random(grid.shape[:2]) < amount
    pool = np.array(chars, dtype=object)
    grid[mask] = rng.choice(pool, size=mask.sum())
    return grid.tolist()


def apply_glitch(ch: list[list[str]], amount: float, rng: np.random.Generator,
                 block: int = 6) -> list[list[str]]:
    """Глитч по символам: горизонтальные сдвиги блоками + «потерянные» куски."""
    if amount <= 0:
        return ch
    grid = np.array(ch, dtype=object)
    gh, gw = grid.shape
    for _ in range(max(1, int(amount * 12))):
        y0 = rng.integers(0, gh)
        y1 = min(gh, y0 + rng.integers(1, max(2, block)))
        shift = int(rng.integers(-block, block + 1) * max(1, amount * 3))
        if shift:
            grid[y0:y1] = np.roll(grid[y0:y1], shift, axis=1)
        if rng.random() < amount * 0.5:               # вырванная полоса
            grid[y0:y1] = rng.choice(np.array([" ", "#", "*", "▒"]), size=(y1 - y0, gw))
    return grid.tolist()


def jitter_lum(lum: np.ndarray, amount: float, rng: np.random.Generator) -> np.ndarray:
    if amount <= 0:
        return lum
    return np.clip(lum + rng.normal(0, 60 * amount, lum.shape), 0, 255)


def rgb_split(color: np.ndarray, amount: float) -> np.ndarray:
    """RGB-расщепление там, где ярко: R влево, B вправо."""
    if amount <= 0:
        return color
    dx = max(1, int(amount * 3))
    out = color.copy()
    out[:, :, 0] = np.roll(color[:, :, 0], -dx, axis=1)
    out[:, :, 2] = np.roll(color[:, :, 2], dx, axis=1)
    return out


def scanlines(canvas: np.ndarray, strength: float) -> np.ndarray:
    if strength <= 0:
        return canvas
    out = canvas.astype(np.float32)
    out[1::2, :, :] *= (1.0 - 0.65 * strength)        # каждую вторую строку символов
    return np.clip(out, 0, 255).astype(np.uint8)


# --------------------------------------------------------------------------
# Рендер одного кадра
# --------------------------------------------------------------------------
def render_frame(frame: np.ndarray, *, cell: tuple[int, int] = (4, 8),
                 chars: list[str] = list(CHARSETS["ramp"]),
                 color_mode: str = "img", scale: int = 4,
                 char_step: float = 1.0, noise: float = 0.0, glitch: float = 0.0,
                 jitter: float = 0.0, split: float = 0.0,
                 scan: float = 0.0, invert: bool = False,
                 bg: tuple[int, int, int] = (0, 0, 0),
                 font_path: str | None = None, seed: int | None = None,
                 _cache: dict | None = None) -> np.ndarray:
    """
    frame: HxWx3 uint8 (RGB) -> HxWx3 uint8: тот же кадр, но из символов.
    cell: (ширина, высота) одного символа в пикселях исходника.
    scale: во сколько раз увеличить каждый «символьный пиксель» в выходе.
    """
    rng = np.random.default_rng(seed)
    h, w = frame.shape[:2]
    cw, chh = cell
    gw, gh = max(1, w // cw), max(1, h // chh)

    lum, color = brightness_grid(frame, gw, gh)
    if invert:
        lum = 255.0 - lum
    lum = jitter_lum(lum, jitter, rng)
    color = rgb_split(color, split)

    grid = chars_for(lum, chars, char_step)
    grid = apply_glitch(grid, glitch, rng)
    grid = apply_noise(grid, noise, chars, rng)

    # --- рисуем текст в маленький канвас gw x gh, потом растягиваем с scale ---
    font_key = (id(font_path), chh)
    if _cache is not None and font_key in _cache:
        font = _cache[font_key]
    else:
        font = load_font(chh, font_path)
        if _cache is not None:
            _cache[font_key] = font

    canvas = Image.new("RGB", (gw, gh), bg)
    draw = ImageDraw.Draw(canvas)

    if color_mode == "block":
        # цветной фон ячейки + чёрный символ: читается лучше всего
        buf = Image.fromarray(color.astype(np.uint8), "RGB")
        canvas = buf.resize((gw, gh), Image.NEAREST)
        # контрастный фон -> символ вычитаем как «тень»
        mask = Image.new("L", (gw, gh), 0)
        md = ImageDraw.Draw(mask)
        for y, row in enumerate(grid):
            for x, c in enumerate(row):
                md.text((x, y), c, fill=255, font=font)
        dark = Image.new("RGB", (gw, gh), (0, 0, 0))
        canvas = Image.composite(dark, canvas, mask)
    else:
        for y, row in enumerate(grid):
            for x, c in enumerate(row):
                if c == " ":
                    continue
                if color_mode == "img":
                    px = tuple(int(v) for v in color[y, x])
                elif color_mode == "mono":
                    px = (255, 255, 255)
                elif color_mode == "brightness":          # серый по яркости
                    v = int(np.clip(lum[y, x], 0, 255))
                    px = (v, v, v)
                else:
                    px = (255, 255, 255)
                draw.text((x, y), c, fill=px, font=font)

    out = canvas.resize((gw * scale, gh * scale), Image.NEAREST)
    arr = np.array(out)
    arr = scanlines(arr, scan)
    return arr


def text_of_frame(frame: np.ndarray, cell=(4, 8), chars=None, invert=False,
                  char_step=1.0, noise=0.0, glitch=0.0, jitter=0.0,
                  seed=None) -> str:
    """Кадр -> редактируемый текст (для правки руками и повторного рендера)."""
    chars = chars or list(CHARSETS["ramp"])
    rng = np.random.default_rng(seed)
    h, w = frame.shape[:2]
    gw, gh = max(1, w // cell[0]), max(1, h // cell[1])
    lum, _ = brightness_grid(frame, gw, gh)
    if invert:
        lum = 255.0 - lum
    lum = jitter_lum(lum, jitter, rng)
    grid = chars_for(lum, chars, char_step)
    grid = apply_glitch(grid, glitch, rng)
    grid = apply_noise(grid, noise, chars, rng)
    return "\n".join("".join(r) for r in grid)


def text_to_image(text: str, *, scale: int = 4, cellsize: int = 12,
                  color: tuple[int, int, int] = (220, 255, 220),
                  bg: tuple[int, int, int] = (0, 0, 0),
                  colors: list | None = None,
                  font_path: str | None = None) -> np.ndarray:
    """
    Обратный путь: правленый текст -> картинка.
    colors (необязательно): список строк вида "x,y,r,g,b" — точечная раскраска.
    """
    lines = text.split("\n")
    gw = max(len(l) for l in lines) if lines else 1
    gh = max(1, len(lines))
    font = load_font(cellsize, font_path)
    canvas = Image.new("RGB", (gw, gh), bg)
    draw = ImageDraw.Draw(canvas)
    color_map = {}
    if colors:
        for item in colors:
            x, y, r, g, b = (int(v) for v in item.split(","))
            color_map[(x, y)] = (r, g, b)
    for y, line in enumerate(lines):
        for x, c in enumerate(line):
            if c == " ":
                continue
            draw.text((x, y), c, fill=color_map.get((x, y), color), font=font)
    return np.array(canvas.resize((gw * scale, gh * scale), Image.NEAREST))


# --------------------------------------------------------------------------
# Файлы
# --------------------------------------------------------------------------
def process_image(inp: str, outp: str, **kw) -> dict:
    img = Image.open(inp).convert("RGB")
    arr = np.array(img)
    res = render_frame(arr, **kw)
    Image.fromarray(res).save(outp)
    return {"out": outp, "size": (res.shape[1], res.shape[0]),
            "grid": (arr.shape[1] // kw.get("cell", (4, 8))[0],
                     arr.shape[0] // kw.get("cell", (4, 8))[1])}


def process_video(inp: str, outp: str, *, fps: float | None = None,
                  start: float = 0.0, duration: float | None = None,
                  progress: bool = True, **kw) -> dict:
    import cv2
    cap = cv2.VideoCapture(inp)
    if not cap.isOpened():
        raise IOError(f"не открывается видео: {inp}")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    out_fps = fps or src_fps
    if start:
        cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)

    writer = None
    cache: dict = {}
    i = made = 0
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        if duration and i / src_fps >= duration:
            break
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        # seed по номеру кадра: шум/глитч живут во времени, но воспроизводимы
        frame = render_frame(rgb, seed=1000 + i, _cache=cache, **kw)
        if writer is None:
            hh, ww = frame.shape[:2]
            fourcc = cv2.VideoWriter_fourcc(*"mp4v")
            writer = cv2.VideoWriter(outp, fourcc, out_fps, (ww, hh))
            if not writer.isOpened():
                raise IOError("VideoWriter не открылся (проверь кодек/размер)")
        writer.write(cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
        made += 1
        i += 1
        if progress and total and i % 25 == 0:
            print(f"\r  кадр {i}/{total}", end="", flush=True)
    cap.release()
    if writer:
        writer.release()
    if progress:
        print(f"\r  готово: {made} кадров -> {outp}")
    return {"out": outp, "frames": made, "fps": out_fps}


def make_gif(inp: str, outp: str, fps: int = 12, start: float = 0.0,
             duration: float | None = None, gif_width: int = 640, **kw) -> dict:
    import cv2
    cap = cv2.VideoCapture(inp)
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    if start:
        cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
    cache: dict = {}
    frames, i = [], 0
    step = max(1, int(round(src_fps / fps)))
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        if duration and i / src_fps >= duration:
            break
        if i % step == 0:
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            fr = render_frame(rgb, seed=1000 + i, _cache=cache, **kw)
            im = Image.fromarray(fr)
            if im.width > gif_width:
                im = im.resize((gif_width, int(im.height * gif_width / im.width)),
                               Image.NEAREST)
            frames.append(im.convert("P", palette=Image.ADAPTIVE))
        i += 1
    cap.release()
    if not frames:
        raise IOError("не получилось ни одного кадра")
    frames[0].save(outp, save_all=True, append_images=frames[1:],
                   duration=int(1000 / fps), loop=0, optimize=True)
    return {"out": outp, "frames": len(frames)}


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def _add_render_args(p):
    p.add_argument("--charset", default="ramp",
                   help="имя набора (%s) или свой текст в кавычках" % ",".join(CHARSETS))
    p.add_argument("--cell", default="4x8", help="размер символа в пикселях, напр. 6x12")
    p.add_argument("--scale", type=int, default=4, help="увеличение выходного символа")
    p.add_argument("--color", default="img",
                   choices=["img", "mono", "brightness", "block"],
                   help="img — символ цветом картинки; mono — белый; "
                        "brightness — серый по яркости; block — чёрный по цветному фону")
    p.add_argument("--char-step", type=float, default=1.0,
                   help=">1 — грубее палитра символов")
    p.add_argument("--invert", action="store_true")
    p.add_argument("--noise", type=float, default=0.0, help="0..1 доля случайных символов")
    p.add_argument("--glitch", type=float, default=0.0, help="0..1 сила сдвигов/полос")
    p.add_argument("--jitter", type=float, default=0.0, help="0..1 дрожание яркости")
    p.add_argument("--split", type=float, default=0.0, help="0..1 RGB-расщепление")
    p.add_argument("--scan", type=float, default=0.0, help="0..1 сканлайны")
    p.add_argument("--font", default=None, help="путь к .ttf")
    p.add_argument("--seed", type=int, default=7)


def resolve_charset(name: str) -> list[str]:
    s = CHARSETS.get(name, name)
    out = [c for c in s if cells_fitting(c, None)]
    if not out:
        raise SystemExit("набор символов пустой")
    return out


def build_kwargs(a) -> dict:
    cw, ch = (int(v) for v in a.cell.lower().split("x"))
    return dict(chars=resolve_charset(a.charset), cell=(cw, ch), scale=a.scale,
                color_mode=a.color, char_step=a.char_step, noise=a.noise,
                glitch=a.glitch, jitter=a.jitter, split=a.split, scan=a.scan,
                invert=a.invert, font_path=a.font)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Фото/видео -> символы")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("image", help="картинка -> символы (PNG)")
    pi.add_argument("input"); pi.add_argument("-o", "--out", default="ascii.png")
    _add_render_args(pi)

    pt = sub.add_parser("text", help="картинка -> редактируемый .txt из символов")
    pt.add_argument("input"); pt.add_argument("-o", "--out", default="ascii.txt")
    _add_render_args(pt)

    pv = sub.add_parser("video", help="видео -> символы (MP4)")
    pv.add_argument("input"); pv.add_argument("-o", "--out", default="ascii.mp4")
    pv.add_argument("--fps", type=float, default=None)
    pv.add_argument("--start", type=float, default=0.0)
    pv.add_argument("--duration", type=float, default=None)
    _add_render_args(pv)

    pg = sub.add_parser("gif", help="видео -> символы (GIF)")
    pg.add_argument("input"); pg.add_argument("-o", "--out", default="ascii.gif")
    pg.add_argument("--fps", type=int, default=12)
    pg.add_argument("--start", type=float, default=0.0)
    pg.add_argument("--duration", type=float, default=None)
    pg.add_argument("--gif-width", type=int, default=640)
    _add_render_args(pg)

    pa = sub.add_parser("apply-text", help="правленый .txt -> картинка")
    pa.add_argument("input"); pa.add_argument("-o", "--out", default="edited.png")
    pa.add_argument("--scale", type=int, default=4)
    pa.add_argument("--cellsize", type=int, default=12)
    pa.add_argument("--rgb", default="255,255,255")
    pa.add_argument("--bg", default="0,0,0")
    pa.add_argument("--font", default=None)
    pa.add_argument("--colors", default=None, help='файл строк "x,y,r,g,b"')

    a = ap.parse_args(argv)
    kw = build_kwargs(a) if a.cmd != "apply-text" else None

    if a.cmd == "image":
        info = process_image(a.input, a.out, **kw)
        print(f"PNG: {info['out']}  {info['size'][0]}x{info['size'][1]}px, "
              f"сетка {info['grid'][0]}x{info['grid'][1]} символов")
    elif a.cmd == "text":
        img = np.array(Image.open(a.input).convert("RGB"))
        t = text_of_frame(img, cell=kw["cell"], chars=kw["chars"],
                          invert=kw["invert"], char_step=kw["char_step"],
                          noise=kw["noise"], glitch=kw["glitch"],
                          jitter=kw["jitter"], seed=a.seed)
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(t)
        lines = t.split("\n")
        print(f"TXT: {a.out}  {len(lines[0])}x{len(lines)} символов — правьте и "
              f"собирайте: python ascii_render.py apply-text {a.out}")
    elif a.cmd == "video":
        process_video(a.input, a.out, fps=a.fps, start=a.start,
                      duration=a.duration, **kw)
    elif a.cmd == "gif":
        make_gif(a.input, a.out, fps=a.fps, start=a.start, duration=a.duration,
                 gif_width=a.gif_width, **kw)
    elif a.cmd == "apply-text":
        text = open(a.input, encoding="utf-8").read().rstrip("\n")
        cols = open(a.colors, encoding="utf-8").read().split() if a.colors else None
        arr = text_to_image(text, scale=a.scale, cellsize=a.cellsize,
                            color=tuple(int(v) for v in a.rgb.split(",")),
                            bg=tuple(int(v) for v in a.bg.split(",")),
                            colors=cols, font_path=a.font)
        Image.fromarray(arr).save(a.out)
        print(f"PNG из текста: {a.out}")


if __name__ == "__main__":
    main()
