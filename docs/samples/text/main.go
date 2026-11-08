package main

import "fmt"

type Format struct {
	ID         string
	Name       string
	Extensions []string
}

func main() {
	formats := []Format{
		{ID: "json", Name: "JSON", Extensions: []string{"json", "jsonc", "json5"}},
		{ID: "yaml", Name: "YAML", Extensions: []string{"yaml", "yml"}},
	}
	for _, format := range formats {
		fmt.Printf("%s: %v\n", format.Name, format.Extensions)
	}
}
