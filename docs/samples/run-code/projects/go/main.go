package main

import (
    "fmt"
    "os"
)

func main() {
    wd, _ := os.Getwd()
    fmt.Println("go 项目命令已执行")
    fmt.Println("cwd:", wd)
}
