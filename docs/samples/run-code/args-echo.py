# 在「运行参数」框里填：--name "hello world" 42
# 然后按 F5（或在参数框里直接回车），观察参数如何被拆分
import sys
print('收到', len(sys.argv) - 1, '个参数：')
for i, value in enumerate(sys.argv[1:], 1):
    print(f'  argv[{i}] = {value!r}')
