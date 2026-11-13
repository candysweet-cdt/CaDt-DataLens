# 运行中出现 stdin 输入条：发几行，最后点 EOF 才会正常结束
import sys
print('等待输入：在面板 stdin 框里打字并回车，结束点 EOF', flush=True)
for n, line in enumerate(sys.stdin, 1):
    print(f'  收到 {n}: {line.rstrip()}', flush=True)
print('EOF，输入结束')
