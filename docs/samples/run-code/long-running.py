# 长驻任务：按 Shift+F5（或面板「停止」）应在 1 秒内结束且无残留进程
import time
n = 0
while True:
    n += 1
    print(f'tick {n}', flush=True)
    time.sleep(1)
