# -*- coding: utf-8 -*-
"""
產生桌面 App 的圖示 keyring.ico（純標準函式庫，沒有 Pillow 也能跑）。

圖案＝一把鑰匙：圓環的頭 ＋ 一根桿 ＋ 兩齒。顏色沿用解鎖公版的色票
（暖墨底 ＋ 暖白），所以工作列上跟解鎖畫面是同一個色溫。

作法照抄 trade-log 的 tools/shioaji/make_icon.py（那支已經在用，PNG／ICO 的
打包方式是驗證過的）：ICO 裡放 PNG（Vista 之後都支援），256／48／32／16
四個尺寸，工作列、開始功能表、Alt+Tab 各自會挑合適的那張。

⚠️ 16px 的時候只看得到「一個圈加一根棒子」，所以線條刻意畫粗、留白刻意大；
   在這個尺寸下追求細節等於什麼都看不到。
"""
import math
import pathlib
import struct
import zlib

BG = (0x1A, 0x15, 0x10, 255)      # 暖墨底（＝解鎖滿版層的顏色）
KEY = (0xF6, 0xEF, 0xE1, 255)     # 暖白（＝解鎖主鈕的顏色）
CLEAR = (0, 0, 0, 0)


def draw(n):
    """畫一張 n×n 的 RGBA 點陣圖。座標一律用比例算，換尺寸不會走鐘。"""
    px = [[CLEAR] * n for _ in range(n)]
    s = n / 256.0

    def disc(cx, cy, r, c):
        r2 = r * r
        for y in range(max(0, int(cy - r)), min(n, int(math.ceil(cy + r)) + 1)):
            for x in range(max(0, int(cx - r)), min(n, int(math.ceil(cx + r)) + 1)):
                if (x - cx + .5) ** 2 + (y - cy + .5) ** 2 <= r2:
                    px[y][x] = c

    def rect(x0, y0, x1, y1, c):
        for y in range(max(0, int(y0)), min(n, int(math.ceil(y1)))):
            for x in range(max(0, int(x0)), min(n, int(math.ceil(x1)))):
                px[y][x] = c

    # 圓角底（用一個大圓當底，小尺寸下比方角好認）
    disc(128 * s, 128 * s, 126 * s, BG)

    """
    ⚠️ 小尺寸不是「同一張圖縮小」，是**另一張圖**。
    第一版把 256 的設計等比縮到 16px，結果整個糊成一團暗色斑點（實際看過才發現）。
    16px 全圖只有 256 格像素，斜桿與兩齒各只剩一兩個像素寬，等於不存在。
    所以 32px 以下：鑰匙直立、放到最大、只留一齒、線條加粗。
    """
    small = n < 32

    if small:
        """
        直立的鑰匙：頭在上、桿朝下、左邊一齒。全部用水平／垂直線，
        因為這個尺寸只有正交線條不會被抗鋸齒吃掉。

        比例是**照 16px 那 16 格反推**的，不是從大圖縮下來：
          頭 直徑約 6px、洞 約 2px、桿 寬 2px、齒 寬 3px。
        第一版頭畫成直徑 8px、桿 2.5px，結果頭跟桿黏成一坨、洞變成一條縫。
        """
        disc(.50 * n, .32 * n, .20 * n, KEY)              # 頭（直徑 0.4n）
        disc(.50 * n, .32 * n, .085 * n, BG)              # 洞
        rect(.44 * n, .32 * n, .56 * n, .80 * n, KEY)     # 桿
        rect(.26 * n, .58 * n, .44 * n, .70 * n, KEY)     # 齒
        return px

    # 大尺寸：斜放的鑰匙，細節撐得住
    disc(96 * s, 96 * s, 46 * s, KEY)
    disc(96 * s, 96 * s, 21 * s, BG)
    for i in range(int(150 * s)):
        t = i / max(1, 150 * s)
        disc(96 * s + t * 92 * s, 96 * s + t * 92 * s, 13 * s, KEY)
    for (off, ln) in ((0.62, 34), (0.86, 26)):
        bx = 96 * s + off * 92 * s
        by = 96 * s + off * 92 * s
        for j in range(int(ln * s)):
            disc(bx - j * 0.7, by + j * 0.7, 11 * s, KEY)

    return px


def png(px):
    n = len(px)
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("4B", *px[y][x]) for x in range(n))
        for y in range(n))

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def main():
    sizes = [256, 48, 32, 16]
    imgs = [png(draw(s)) for s in sizes]
    off = 6 + 16 * len(sizes)
    head = struct.pack("<HHH", 0, 1, len(sizes))
    ent = b""
    for s, img in zip(sizes, imgs):
        ent += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(img), off)
        off += len(img)
    out = pathlib.Path(__file__).with_name("keyring.ico")
    out.write_bytes(head + ent + b"".join(imgs))
    print(f"寫好 {out.name}（{out.stat().st_size} bytes，{len(sizes)} 種尺寸）")


if __name__ == "__main__":
    main()
