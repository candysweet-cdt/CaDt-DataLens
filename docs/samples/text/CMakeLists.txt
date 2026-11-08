# 一个简单的 CMake 示例
cmake_minimum_required(VERSION 3.20)
project(datalens-samples CXX)

set(CMAKE_CXX_STANDARD 17)

add_executable(datalens main.cpp)
target_include_directories(datalens PRIVATE include)
