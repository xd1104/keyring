# -*- coding: utf-8 -*-
"""
鑰匙圈後台・桌面 App 啟動器（Windows 11）

用 pythonw.exe 跑，所以不會有黑色的命令列視窗。做三件事：

  1. 伺服器還沒起來就把 server.js 開起來（隱藏視窗）。
  2. 自己開一個視窗（pywebview，底層是 Windows 11 內建的 WebView2）。
     視窗是這個行程的，所以工作列顯示的是鑰匙圖示，關閉時機也拿得準。
  3. 關掉視窗＝離開 App：把伺服器一起收掉（**只收自己開的那個**）。

作法沿用 trade-log 的 tools/shioaji/panel_app.pyw ——那支已經把雷踩完了，
不要重新發明。兩個刻意的差異：

  ・**伺服器是 Node 不是 Python**（`node server.js`）。keyring 的 server.js 是
    零執行期依賴的純 node 內建，這件事沒有變；這個 .venv 只給「開視窗」用。
  ・**沒有看門狗**。早盤儀表板需要它，是因為永豐 SDK 斷線時會把整個行程帶走；
    keyring 的 server 沒有任何外部 SDK，沒有那個故障模式。少一個會自己重開
    行程的東西，就少一種說不清楚的狀態。真的遇到會掛再加。

【為什麼不用 Edge 的 --app】視窗擁有者會是 Edge ⇒ 工作列一律顯示 Edge 的圖示
（安裝成 PWA 也一樣），而且關窗時機測不準。詳見 open_window() 的說明。
"""
import os
import subprocess
import sys
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "server.js")
PROFILE = os.path.join(os.environ.get("LOCALAPPDATA", HERE), "KeyringApp")
LOG = os.path.join(HERE, "keyring-app.log")
ICON = os.path.join(HERE, "keyring.ico")
URL = "http://127.0.0.1:4620/"
BOOT_TIMEOUT = 20          # 秒。純本機讀檔，起得很快；20 秒還沒好就是真的有問題

NO_WINDOW = 0x08000000     # CREATE_NO_WINDOW
NEW_GROUP = 0x00000200     # CREATE_NEW_PROCESS_GROUP


def log(msg):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass


def alive():
    """伺服器起來了沒。用 /api/state 而不是首頁——首頁是靜態檔，還沒備妥也回得了。"""
    try:
        with urllib.request.urlopen(URL + "api/state", timeout=2):
            return True
    except Exception:
        return False


def node_exe():
    """找 node。PATH 上有就用 PATH 的；沒有再找幾個常見的安裝位置。"""
    from shutil import which
    n = which("node")
    if n:
        return n
    for p in (r"C:\Program Files\nodejs\node.exe",
              r"C:\Program Files (x86)\nodejs\node.exe",
              os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Programs\nodejs\node.exe")):
        if os.path.exists(p):
            return p
    return None


def open_window():
    """
    自己開一個視窗，不要交給 Edge。

    【為什麼不用 Edge 的 --app】那個視窗的擁有者是 Edge，Windows 就把它算在 Edge 頭上：
    工作列顯示的是 Edge 的圖示（trade-log 2026-08-28 確認過，安裝成 PWA 也一樣），
    而且沒辦法可靠地知道「視窗被關掉了」。
    改用 pywebview（底層是 Windows 11 內建的 WebView2）：視窗是我們這個行程的，
    圖示、工作列、關閉時機全都拿得回來。
    """
    import ctypes
    import webview

    # 工作列要認得這是「鑰匙圈」而不是 python.exe，一定要在開視窗之前設
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Benson.Keyring")
    except Exception:
        pass

    webview.create_window("🔑 鑰匙圈", URL, width=1180, height=900, min_size=(900, 640))
    kw = {"private_mode": False, "storage_path": PROFILE}
    if os.path.exists(ICON):
        kw["icon"] = ICON
    try:
        webview.start(**kw)          # 視窗關掉才會回來
    except TypeError:
        # 舊版 pywebview 沒有 icon / storage_path，掉回最陽春的用法
        webview.start()


def main():
    log("=== 啟動 ===")
    proc = None
    owns_server = False

    if not alive():
        node = node_exe()
        if not node:
            log("找不到 node，無法啟動 server.js")
            return 1
        owns_server = True
        proc = subprocess.Popen([node, SERVER], cwd=HERE,
                                creationflags=NO_WINDOW | NEW_GROUP,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + BOOT_TIMEOUT
        while time.time() < deadline and not alive():
            if proc.poll() is not None:
                log(f"server.js 自己結束了（離開碼 {proc.returncode}）")
                break
            time.sleep(0.3)
        if not alive():
            log("等不到伺服器起來，還是把視窗開出來讓他看得到錯誤")
    else:
        log("伺服器本來就在跑（例如工具面板開的），只開視窗")

    open_window()

    # 關窗＝離開 App。只收自己開的伺服器：本來就在跑的不要動。
    if owns_server and proc is not None:
        log("視窗關閉，收掉伺服器")
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    log("=== 結束 ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
