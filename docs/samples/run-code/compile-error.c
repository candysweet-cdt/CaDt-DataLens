/* 故意漏一个分号：验证 gcc 报错的 path:line:col 可点击跳转、中文报错不乱码 */
#include <stdio.h>

int main(void) {
    int value = 1
    printf("%d\n", value);
    return 0;
}
