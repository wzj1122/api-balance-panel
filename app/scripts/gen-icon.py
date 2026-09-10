#!/usr/bin/env python3
"""生成 API 余额面板的应用图标（纯标准库，无 Pillow 依赖）。

输出到 resources/：
  - icon.png   256x256（托盘 + Linux/mac 通用）
  - icon.ico   内嵌 256/48/32/16 四档 PNG 的 ICO（Windows 安装包 + exe）
  - tray.png   32x32（Windows 托盘图标，可选）

设计：深色圆角方块 + 蓝紫渐变背景 + 三根白色「柱状图」立柱，寓意"余额/用量监控"。
"""
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'resources')


def _clamp01(v):
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def _length(x, y):
    return (x * x + y * y) ** 0.5


def rounded_rect_sdf(px, py, cx, cy, hw, hh, r):
    """点到圆角矩形的有符号距离（负=内部）。坐标归一化 [0,1]，y 向下。"""
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ox = qx if qx > 0 else 0.0
    oy = qy if qy > 0 else 0.0
    outside = _length(ox, oy)
    inside = min(max(qx, qy), 0.0)
    return outside + inside - r


def coverage(sdf, aa=0.0016):
    """把 SDF 转成覆盖率（抗锯齿）。"""
    return _clamp01(0.5 - sdf / aa)


def render(size):
    """渲染 size x size 的 RGBA 图（bytearray，RGBA 顺序）。"""
    n = size
    # 归一化坐标采样（在 [0,1] 内，含少量出血用于下采样 AA）
    inv = 1.0 / (n - 1)
    # 背景圆角方块
    bg_cx = bg_cy = 0.5
    bg_r = 0.20
    bg_hw = 0.5 - 0.02
    bg_hh = 0.5 - 0.02
    # 三根柱
    bars = [
        dict(cx=0.30, top=0.52),  # 高 0.22
        dict(cx=0.50, top=0.40),  # 高 0.34
        dict(cx=0.70, top=0.28),  # 高 0.46
    ]
    bar_bottom = 0.74
    bar_hw = 0.075
    bar_r = 0.03

    # 渐变端点（蓝紫）
    top = (86, 143, 255)      # #568FFF
    bottom = (92, 62, 210)    # #5C3ED2

    buf = bytearray(n * n * 4)
    for j in range(n):
        py = j * inv
        for i in range(n):
            px = i * inv
            a = coverage(rounded_rect_sdf(px, py, bg_cx, bg_cy, bg_hw, bg_hh, bg_r))
            if a <= 0.0:
                continue
            # 背景渐变（带一点垂直方向）
            t = _clamp01((py - 0.10) / 0.80)
            cr = int(top[0] + (bottom[0] - top[0]) * t)
            cg = int(top[1] + (bottom[1] - top[1]) * t)
            cb = int(top[2] + (bottom[2] - top[2]) * t)
            # 白柱覆盖
            ba = 0.0
            for b in bars:
                hh = (bar_bottom - b['top']) / 2.0
                cy = bar_bottom - hh
                ba = max(ba, coverage(rounded_rect_sdf(px, py, b['cx'], cy, bar_hw, hh, bar_r)))
            # 白柱与背景混合
            cr = int(cr + (255 - cr) * ba)
            cg = int(cg + (255 - cg) * ba)
            cb = int(cb + (255 - cb) * ba)
            idx = (j * n + i) * 4
            buf[idx] = cr
            buf[idx + 1] = cg
            buf[idx + 2] = cb
            buf[idx + 3] = int(255 * a)
    return buf


def write_png(buf, size, path):
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    # 每行前置 filter byte 0
    stride = size * 4
    raw = bytearray()
    for j in range(size):
        raw.append(0)
        raw += buf[j * stride:(j + 1) * stride]

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', ihdr)
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def write_ico(entries, path):
    """entries: list of (size, png_bytes)。把 PNG 直接内嵌进 ICO（Vista+ 支持）。"""
    count = len(entries)
    header = struct.pack('<HHH', 0, 1, count)
    dirent = bytearray()
    blob = bytearray()
    offset = 6 + 16 * count
    for size, png in entries:
        w = size if size < 256 else 0
        h = size if size < 256 else 0
        dirent += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(png), offset)
        blob += png
        offset += len(png)
    with open(path, 'wb') as f:
        f.write(header + bytes(dirent) + bytes(blob))


def downscale(src, src_size, dst_size):
    """简单 2x2 盒式下采样（用于 512→256 等整倍缩小）。"""
    factor = src_size // dst_size
    out = bytearray(dst_size * dst_size * 4)
    for j in range(dst_size):
        for i in range(dst_size):
            r = g = b = a = 0
            cnt = factor * factor
            for dj in range(factor):
                sy = j * factor + dj
                for di in range(factor):
                    sx = i * factor + di
                    idx = (sy * src_size + sx) * 4
                    r += src[idx]
                    g += src[idx + 1]
                    b += src[idx + 2]
                    a += src[idx + 3]
            o = (j * dst_size + i) * 4
            out[o] = r // cnt
            out[o + 1] = g // cnt
            out[o + 2] = b // cnt
            out[o + 3] = a // cnt
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    # 512 高清渲染 → 盒式下采样到各档
    big = render(512)
    sizes = [256, 48, 32, 16]
    bufs = {}
    for s in sizes:
        bufs[s] = downscale(big, 512, s)

    png_paths = {}
    for s in sizes:
        p = os.path.join(OUT, f'icon-{s}.png')
        write_png(bufs[s], s, p)
        png_paths[s] = p

    # 主图标文件
    write_png(bufs[256], 256, os.path.join(OUT, 'icon.png'))
    write_png(bufs[32], 32, os.path.join(OUT, 'tray.png'))

    # ICO：256 + 48 + 32 + 16
    ico_entries = []
    for s in sizes:
        with open(png_paths[s], 'rb') as f:
            ico_entries.append((s, f.read()))
    write_ico(ico_entries, os.path.join(OUT, 'icon.ico'))

    # 清理中间文件
    for s in sizes:
        os.remove(png_paths[s])

    print('图标已生成：')
    for name in ('icon.png', 'icon.ico', 'tray.png'):
        p = os.path.join(OUT, name)
        print(f'  {p}  ({os.path.getsize(p)} bytes)')


if __name__ == '__main__':
    main()
