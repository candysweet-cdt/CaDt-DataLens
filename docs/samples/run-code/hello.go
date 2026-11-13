package main

import (
    "fmt"
    "os"
)

func main() {
    fmt.Println("hello from Go (go run)")
    fmt.Println("args:", os.Args[1:])
}
