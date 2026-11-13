# 验证退出码、stderr 标色，以及状态行的「发给 AI 分析」按钮
import sys
print('标准输出：准备以退出码 3 结束', flush=True)
print('标准错误：这是一条 stderr', file=sys.stderr, flush=True)
sys.exit(3)
