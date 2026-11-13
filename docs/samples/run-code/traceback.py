# 验证 Python traceback 里的 File "...", line N 可以点击跳到源码
def inner():
    raise ValueError('这是一条用于验证跳转的异常')


def outer():
    inner()


outer()
