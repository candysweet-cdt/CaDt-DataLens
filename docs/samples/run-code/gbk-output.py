# 中文 Windows 上 gcc / pip / cmd 默认吐 GBK 字节。
# 这里精确写出 GBK，验证运行通道「先 UTF-8、再 GB18030」的自动转码。
import sys
sys.stdout.buffer.write('这是 GBK 编码的中文输出，应正常显示而不是乱码\n'.encode('gbk'))
sys.stdout.flush()
