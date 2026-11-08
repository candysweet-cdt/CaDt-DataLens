#include <iostream>
#include <vector>

// 一个简单的 C++ 示例
int main() {
    std::vector<int> numbers = {4, 8, 15, 16, 23, 42};
    int total = 0;
    for (int n : numbers) {
        total += n;
    }
    std::cout << "total = " << total << std::endl;
    return 0;
}
