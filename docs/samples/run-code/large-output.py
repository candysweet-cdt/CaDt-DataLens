# 约 10 MB 输出，验证 8 MB 截断提示且界面不卡。
# 会跑几秒，跑之前确认愿意等；只跑普通场景不要选这个。
import sys
line = 'x' * 200 + '\n'
for _ in range(50000):
    sys.stdout.write(line)
print('（如果看到这行，说明没有被截断）')
