module candysweet.example/datalens-samples

go 1.22

require (
	github.com/pkg/errors v0.9.1
	golang.org/x/text v0.14.0
)

require github.com/google/uuid v1.6.0 // indirect

replace golang.org/x/text => golang.org/x/text v0.13.0

exclude github.com/pkg/errors v0.8.1
